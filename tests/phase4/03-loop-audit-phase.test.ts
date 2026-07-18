import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { createGit } from "../../src/git";
import type { InvokeResult } from "../../src/invoker";
import { loadPlan, type Plan } from "../../src/plan";
import { runLoop, type InvokeFn, type RunEvent } from "../../src/loop";

function sh(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function gitLog(repo: string): string[] {
  return Bun.spawnSync(["git", "log", "--format=%s"], { cwd: repo })
    .stdout.toString()
    .trim()
    .split("\n");
}

function makeFixture(prd = "# PRD: toy\n"): { repo: string; plan: Plan; planDir: string } {
  const repo = mkdtempSync(join(tmpdir(), "capataz-p4-audit-"));
  sh(repo, "init", "-b", "main");
  sh(repo, "config", "user.email", "test@capataz.local");
  sh(repo, "config", "user.name", "Capataz Test");
  const planDir = join(repo, ".scratch", "toy-feature");
  mkdirSync(join(planDir, "issues"), { recursive: true });
  writeFileSync(join(planDir, "PRD.md"), prd);
  writeFileSync(
    join(planDir, "issues", "01-base.md"),
    [
      "# 01 — base",
      "",
      "Status: ready-for-agent",
      "Depends-on: none",
      "Verification: test -f impl.txt",
      "",
      "Please create file impl.txt now.",
    ].join("\n"),
  );
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "initial");
  const loaded = loadPlan(planDir);
  if (loaded.kind !== "valid") throw new Error(loaded.problems.join("\n"));
  return { repo, plan: loaded.plan, planDir };
}

function auditConfig(overrides?: {
  budgets?: Partial<Config["budgets"]>;
  architect?: boolean;
  security_auditor?: boolean;
}): Config {
  return {
    backends: {
      "exec-b": { command: ["exec-bin"], env: {}, timeout_minutes: 1 },
      "arm-b": { command: ["arm-bin"], env: {}, timeout_minutes: 1 },
      "rev-b": { command: ["rev-bin"], env: {}, timeout_minutes: 1 },
      "arch-b": { command: ["arch-bin"], env: {}, timeout_minutes: 1 },
      "sec-b": { command: ["sec-bin"], env: {}, timeout_minutes: 1 },
    },
    roles: {
      executor: "exec-b",
      armorer: "arm-b",
      reviewer: "rev-b",
      ...(overrides?.architect === false ? {} : { architect: "arch-b" }),
      ...(overrides?.security_auditor === false ? {} : { security_auditor: "sec-b" }),
    },
    budgets: {
      max_attempts_per_issue: 4,
      attempts_l1: 2,
      attempts_l2: 2,
      attempts_l3: 2,
      max_escalations_per_run: 3,
      max_audit_issues: 5,
      verification_timeout_minutes: 1,
      ...overrides?.budgets,
    },
  } as Config;
}

const okResult = { kind: "ok", stdout: "done", stderr: "", durationMs: 5, exitCode: 0 } as const;
const APPROVE = "VERDICT: approve\nSUMMARY: reviewed and fine";

function findingBlock(title: string, verification: string, body: string): string {
  return [
    "```finding",
    `Title: ${title}`,
    `Verification: ${verification}`,
    "",
    body,
    "```",
  ].join("\n");
}

interface AuditorFake {
  stdout?: string;
  result?: InvokeResult;
  effect?: () => void;
}

/**
 * Role-aware fake: the armorer writes a fresh armed file, the executor creates
 * every `create file <name>` named in its prompt, the reviewer approves, and
 * the auditors return their configured output (with optional side effects).
 */
function fakeInvoke(
  repo: string,
  auditors: { architect?: AuditorFake; security_auditor?: AuditorFake },
): { invoke: InvokeFn; prompts: Record<string, string[]> } {
  const prompts: Record<string, string[]> = {
    "exec-bin": [],
    "arm-bin": [],
    "rev-bin": [],
    "arch-bin": [],
    "sec-bin": [],
  };
  let armed = 0;
  const invoke: InvokeFn = async (backend, prompt) => {
    const bin = backend.command[0]!;
    prompts[bin]!.push(prompt);
    switch (bin) {
      case "arm-bin":
        writeFileSync(join(repo, `armed-${++armed}.txt`), "red");
        return okResult;
      case "exec-bin":
        for (const m of prompt.matchAll(/create file ([\w.-]+\w)/g)) {
          writeFileSync(join(repo, m[1]!), "impl");
        }
        return okResult;
      case "rev-bin":
        return { ...okResult, stdout: APPROVE };
      case "arch-bin":
      case "sec-bin": {
        const fake = bin === "arch-bin" ? auditors.architect : auditors.security_auditor;
        fake?.effect?.();
        if (fake?.result) return fake.result;
        return { ...okResult, stdout: fake?.stdout ?? "" };
      }
      default:
        throw new Error(`unexpected backend ${bin}`);
    }
  };
  return { invoke, prompts };
}

function eventsOf(events: RunEvent[], type: string): any[] {
  return events.filter((e) => (e.type as string) === type) as any[];
}

function statusOfFile(planDir: string, file: string): string {
  return readFileSync(join(planDir, "issues", file), "utf8").match(/^Status: (.*)$/m)![1]!;
}

async function run(
  config: Config,
  fixture: { repo: string; plan: Plan },
  invoke: InvokeFn,
  noJudge = false,
): Promise<{ result: Awaited<ReturnType<typeof runLoop>>; events: RunEvent[] }> {
  const events: RunEvent[] = [];
  const result = await runLoop({
    config,
    plan: fixture.plan,
    git: createGit(fixture.repo),
    repoPath: fixture.repo,
    invokeFn: invoke,
    onEvent: (e: RunEvent) => events.push(e),
    noJudge,
  });
  return { result, events };
}

describe("audit phase: full pass", () => {
  test("both auditors run sequentially, audit-Issues dispatch through the loop, run ends done", async () => {
    const fixture = makeFixture();
    const { invoke, prompts } = fakeInvoke(fixture.repo, {
      architect: {
        stdout: findingBlock("Arch gap", "test -f arch-fix.txt", "Please create file arch-fix.txt now."),
      },
      security_auditor: {
        stdout: findingBlock("Sec hole", "test -f sec-fix.txt", "Please create file sec-fix.txt now."),
      },
    });
    const { result, events } = await run(auditConfig(), fixture, invoke);

    expect(result.kind).toBe("completed");
    expect(eventsOf(events, "audit-started")).toHaveLength(1);

    // Architect first, then Security Auditor
    const auditorResults = eventsOf(events, "auditor-result");
    expect(auditorResults.map((e) => e.role)).toEqual(["architect", "security_auditor"]);
    expect(auditorResults[0].backend).toBe("arch-b");

    // auditor prompts are the audit dispatch prompt
    expect(prompts["arch-bin"]![0]).toContain("read-only audit");
    expect(prompts["sec-bin"]![0]).toContain("read-only audit");

    const findings = eventsOf(events, "finding-emitted");
    expect(findings.map((e) => [e.auditor, e.title, e.dispatchable])).toEqual([
      ["architect", "Arch gap", true],
      ["security_auditor", "Sec hole", true],
    ]);

    const written = eventsOf(events, "audit-issue-written");
    expect(written.map((e) => [e.issue, e.auditor, e.status])).toEqual([
      [2, "architect", "ready-for-agent"],
      [3, "security_auditor", "ready-for-agent"],
    ]);

    // dispatched through the full existing loop: arming + review gates
    const doneIssues = eventsOf(events, "issue-done").map((e) => e.issue);
    expect(doneIssues).toEqual([1, 2, 3]);
    expect(statusOfFile(fixture.planDir, "02-arch-gap.md")).toBe("done");
    expect(statusOfFile(fixture.planDir, "03-sec-hole.md")).toBe("done");
    expect(existsSync(join(fixture.repo, "arch-fix.txt"))).toBe(true);
    expect(existsSync(join(fixture.repo, "sec-fix.txt"))).toBe(true);

    const log = gitLog(fixture.repo);
    expect(log).toContain("capataz: audit issues");
    expect(log).toContain("capataz: arming 02-arch-gap");
    expect(log).toContain("capataz: 02-arch-gap");
    expect(log).toContain("capataz: 03-sec-hole");

    // single pass: no second audit
    expect(eventsOf(events, "audit-started")).toHaveLength(1);
    const finished = events.at(-1);
    expect(finished?.type).toBe("run-finished");

    // events survive a JSONL round-trip
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });

  test("only one auditor role configured: the other is skipped individually", async () => {
    const fixture = makeFixture();
    const { invoke, prompts } = fakeInvoke(fixture.repo, {
      security_auditor: {
        stdout: findingBlock("Sec hole", "test -f sec-fix.txt", "Please create file sec-fix.txt now."),
      },
    });
    const { result, events } = await run(auditConfig({ architect: false }), fixture, invoke);

    expect(result.kind).toBe("completed");
    expect(eventsOf(events, "audit-started")).toHaveLength(1);
    expect(prompts["arch-bin"]).toHaveLength(0);
    expect(eventsOf(events, "auditor-result").map((e) => e.role)).toEqual(["security_auditor"]);
    expect(eventsOf(events, "issue-done").map((e) => e.issue)).toEqual([1, 2]);
  });
});

describe("audit phase: skip conditions", () => {
  test("escalated run never audits", async () => {
    const fixture = makeFixture();
    // executor never creates impl.txt: strip the marker from the issue body
    const invoke: InvokeFn = async (backend) => {
      const bin = backend.command[0]!;
      if (bin === "arm-bin") writeFileSync(join(fixture.repo, "armed.txt"), "red");
      if (bin === "arch-bin" || bin === "sec-bin") throw new Error("auditor must not run");
      return okResult;
    };
    const { result, events } = await run(auditConfig(), fixture, invoke);

    expect(result.kind).toBe("completed");
    expect(eventsOf(events, "issue-escalated")).toHaveLength(1);
    expect(eventsOf(events, "audit-started")).toHaveLength(0);
  });

  test("unjudged run never audits", async () => {
    const fixture = makeFixture();
    const { invoke, prompts } = fakeInvoke(fixture.repo, {});
    const { result, events } = await run(auditConfig(), fixture, invoke, true);

    expect(result.kind).toBe("completed");
    expect(eventsOf(events, "issue-done")).toHaveLength(1);
    expect(eventsOf(events, "audit-started")).toHaveLength(0);
    expect(prompts["arch-bin"]).toHaveLength(0);
    expect(prompts["sec-bin"]).toHaveLength(0);
  });

  test("no auditor role configured never audits", async () => {
    const fixture = makeFixture();
    const { invoke } = fakeInvoke(fixture.repo, {});
    const { result, events } = await run(
      auditConfig({ architect: false, security_auditor: false }),
      fixture,
      invoke,
    );

    expect(result.kind).toBe("completed");
    expect(eventsOf(events, "issue-done")).toHaveLength(1);
    expect(eventsOf(events, "audit-started")).toHaveLength(0);
  });
});

describe("audit phase: read-only guard", () => {
  test("an auditor that edits and commits is hard-reset, its Findings still dispatch", async () => {
    const fixture = makeFixture();
    const { repo } = fixture;
    const { invoke } = fakeInvoke(repo, {
      architect: {
        stdout: findingBlock("Arch gap", "test -f arch-fix.txt", "Please create file arch-fix.txt now."),
        effect: () => {
          writeFileSync(join(repo, "rogue.txt"), "edited");
          sh(repo, "add", "-A");
          sh(repo, "commit", "-m", "auditor: sneaky commit");
          writeFileSync(join(repo, "dirty.txt"), "leftover");
        },
      },
    });
    const { result, events } = await run(
      auditConfig({ security_auditor: false }),
      fixture,
      invoke,
    );

    expect(result.kind).toBe("completed");
    const rogue = eventsOf(events, "rogue-audit-edit");
    expect(rogue).toHaveLength(1);
    expect(rogue[0].role).toBe("architect");
    expect(rogue[0].from).not.toBe(rogue[0].to);

    expect(gitLog(repo)).not.toContain("auditor: sneaky commit");
    expect(existsSync(join(repo, "rogue.txt"))).toBe(false);
    expect(existsSync(join(repo, "dirty.txt"))).toBe(false);

    // the Finding was parsed from the output, not the tree: still dispatched
    expect(eventsOf(events, "issue-done").map((e) => e.issue)).toEqual([1, 2]);
    expect(statusOfFile(fixture.planDir, "02-arch-gap.md")).toBe("done");
  });
});

describe("audit phase: cap and needs-triage fallback", () => {
  test("findings beyond max_audit_issues or without Verification are needs-triage, never dispatched", async () => {
    const fixture = makeFixture();
    const { invoke } = fakeInvoke(fixture.repo, {
      architect: {
        stdout: [
          findingBlock("First", "test -f first.txt", "Please create file first.txt now."),
          findingBlock("Second", "test -f second.txt", "Please create file second.txt now."),
          findingBlock("Third", "", "No verification possible."),
        ].join("\n\n"),
      },
    });
    const { result, events } = await run(
      auditConfig({ security_auditor: false, budgets: { max_audit_issues: 1 } }),
      fixture,
      invoke,
    );

    expect(result.kind).toBe("completed");
    expect(eventsOf(events, "finding-emitted").map((e) => e.dispatchable)).toEqual([
      true,
      false,
      false,
    ]);
    expect(eventsOf(events, "audit-issue-written").map((e) => [e.issue, e.status])).toEqual([
      [2, "ready-for-agent"],
      [3, "needs-triage"],
      [4, "needs-triage"],
    ]);
    expect(eventsOf(events, "issue-done").map((e) => e.issue)).toEqual([1, 2]);
    expect(statusOfFile(fixture.planDir, "02-first.md")).toBe("done");
    expect(statusOfFile(fixture.planDir, "03-second.md")).toBe("needs-triage");
    expect(statusOfFile(fixture.planDir, "04-third.md")).toBe("needs-triage");
    expect(existsSync(join(fixture.repo, "second.txt"))).toBe(false);
  });
});

describe("audit phase: escalation budget applies to audit-Issues", () => {
  test("audit-Issues exhausting the ladder escalate and count against max_escalations_per_run", async () => {
    const fixture = makeFixture();
    const { invoke } = fakeInvoke(fixture.repo, {
      architect: {
        stdout: [
          findingBlock("Never one", "test -f never1.txt", "Unsolvable."),
          findingBlock("Never two", "test -f never2.txt", "Unsolvable."),
        ].join("\n\n"),
      },
    });
    const { result, events } = await run(
      auditConfig({ security_auditor: false, budgets: { max_escalations_per_run: 1 } }),
      fixture,
      invoke,
    );

    expect(result.kind).toBe("aborted");
    if (result.kind !== "aborted") throw new Error("unreachable");
    expect(result.reason).toBe("escalation-budget-exceeded");
    expect(result.escalations).toBe(2);
    expect(eventsOf(events, "issue-escalated").map((e) => e.issue)).toEqual([2, 3]);
    expect(statusOfFile(fixture.planDir, "02-never-one.md")).toBe("ready-for-human");
  });
});

describe("audit phase: best-effort auditors", () => {
  test("one auditor timing out does not prevent the other from running", async () => {
    const fixture = makeFixture();
    const { invoke } = fakeInvoke(fixture.repo, {
      architect: {
        result: { kind: "timeout", stdout: "partial", stderr: "", durationMs: 100 },
      },
      security_auditor: {
        stdout: findingBlock("Sec hole", "test -f sec-fix.txt", "Please create file sec-fix.txt now."),
      },
    });
    const { result, events } = await run(auditConfig(), fixture, invoke);

    expect(result.kind).toBe("completed");
    const auditorResults = eventsOf(events, "auditor-result");
    expect(auditorResults.map((e) => [e.role, e.kind])).toEqual([
      ["architect", "timeout"],
      ["security_auditor", "ok"],
    ]);
    expect(eventsOf(events, "issue-done").map((e) => e.issue)).toEqual([1, 2]);
    expect(statusOfFile(fixture.planDir, "02-sec-hole.md")).toBe("done");
  });
});

describe("audit phase: capped auditor input", () => {
  test("oversized PRD + diff emits audit-input-truncated per capped auditor", async () => {
    const fixture = makeFixture(`# PRD: toy\n\n${"x".repeat(30_000)}\n`);
    const { invoke, prompts } = fakeInvoke(fixture.repo, {
      architect: { stdout: "no findings" },
    });
    const { result, events } = await run(
      auditConfig({ security_auditor: false }),
      fixture,
      invoke,
    );

    expect(result.kind).toBe("completed");
    const truncations = eventsOf(events, "audit-input-truncated");
    expect(truncations).toHaveLength(1);
    expect(truncations[0].role).toBe("architect");
    // the diff was tail-capped but the PRD is embedded whole
    expect(prompts["arch-bin"]![0]).toContain("[...truncated...]");
    // no findings: nothing written, nothing dispatched
    expect(eventsOf(events, "audit-issue-written")).toHaveLength(0);
    expect(eventsOf(events, "issue-done").map((e) => e.issue)).toEqual([1]);
  });
});
