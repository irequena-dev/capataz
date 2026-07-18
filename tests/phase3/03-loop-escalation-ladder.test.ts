import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { createGit } from "../../src/git";
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

function makeFixture(slug: string, verification: string): { repo: string; plan: Plan } {
  const repo = mkdtempSync(join(tmpdir(), "capataz-p3-ladder-"));
  sh(repo, "init", "-b", "main");
  sh(repo, "config", "user.email", "test@capataz.local");
  sh(repo, "config", "user.name", "Capataz Test");
  const planDir = join(repo, ".scratch", "toy-feature");
  mkdirSync(join(planDir, "issues"), { recursive: true });
  writeFileSync(join(planDir, "PRD.md"), "# PRD: toy\n");
  writeFileSync(
    join(planDir, "issues", `01-${slug}.md`),
    [
      `# 01 — ${slug}`,
      "",
      "Status: ready-for-agent",
      "Depends-on: none",
      `Verification: ${verification}`,
      "",
      `Create the artifact for ${slug}.`,
    ].join("\n"),
  );
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "initial");
  const loaded = loadPlan(planDir);
  if (loaded.kind !== "valid") throw new Error(loaded.problems.join("\n"));
  return { repo, plan: loaded.plan };
}

function ladderConfig(overrides?: {
  budgets?: Partial<Config["budgets"]>;
  fixer_l2?: boolean;
  fixer_l3?: boolean;
}): Config {
  return {
    backends: {
      "exec-b": { command: ["exec-bin"], env: {}, timeout_minutes: 1 },
      "arm-b": { command: ["arm-bin"], env: {}, timeout_minutes: 1 },
      "rev-b": { command: ["rev-bin"], env: {}, timeout_minutes: 1 },
      "fix2-b": { command: ["fix2-bin"], env: {}, timeout_minutes: 1 },
      "fix3-b": { command: ["fix3-bin"], env: {}, timeout_minutes: 1 },
    },
    roles: {
      executor: "exec-b",
      armorer: "arm-b",
      reviewer: "rev-b",
      ...(overrides?.fixer_l2 === false ? {} : { fixer_l2: "fix2-b" }),
      ...(overrides?.fixer_l3 === false ? {} : { fixer_l3: "fix3-b" }),
    },
    budgets: {
      max_attempts_per_issue: 8,
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

type Role = "armorer" | "executor" | "fixer_l2" | "fixer_l3";

const BIN_TO_ROLE: Record<string, Role> = {
  "arm-bin": "armorer",
  "exec-bin": "executor",
  "fix2-bin": "fixer_l2",
  "fix3-bin": "fixer_l3",
};

/** Role-aware fake dispatching on backend command name; reviewer approves by default. */
function fakeRoles(behaviors: Partial<Record<Role, (attempt: number) => void>>): {
  invoke: InvokeFn;
  prompts: Record<Role | "reviewer", string[]>;
} {
  const prompts: Record<Role | "reviewer", string[]> = {
    armorer: [],
    executor: [],
    fixer_l2: [],
    fixer_l3: [],
    reviewer: [],
  };
  const attempts = new Map<Role, number>();
  const invoke: InvokeFn = async (backend, prompt) => {
    const bin = backend.command[0]!;
    if (bin === "rev-bin") {
      prompts.reviewer.push(prompt);
      return { ...okResult, stdout: APPROVE };
    }
    const role = BIN_TO_ROLE[bin]!;
    prompts[role].push(prompt);
    const attempt = (attempts.get(role) ?? 0) + 1;
    attempts.set(role, attempt);
    behaviors[role]?.(attempt);
    return okResult;
  };
  return { invoke, prompts };
}

function eventsOf(events: RunEvent[], type: string): any[] {
  return events.filter((e) => (e.type as string) === type) as any[];
}

function statusOf(plan: Plan, n: number): string {
  const issue = plan.issues.get(n)!;
  return readFileSync(issue.path, "utf8").match(/^Status: (.*)$/m)![1]!;
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
  } as any);
  return { result, events };
}

describe("escalation ladder: L2 rescue", () => {
  test("L1 never solves, L2 does: done, resolvedBy l2, tree and history inherited", async () => {
    const fixture = makeFixture("rescue", "test -f impl.txt");
    const { repo, plan } = fixture;
    let partialInTreeAtL2 = false;
    const { invoke, prompts } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "red"),
      executor: () => writeFileSync(join(repo, "partial.txt"), "half-done"),
      fixer_l2: () => {
        partialInTreeAtL2 = existsSync(join(repo, "partial.txt"));
        writeFileSync(join(repo, "impl.txt"), "fixed");
      },
    });
    // L1 budget: 1 arming attempt + 1 executor attempt
    const { result, events } = await run(ladderConfig(), fixture, invoke);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(statusOf(plan, 1)).toBe("done");

    const done = eventsOf(events, "issue-done");
    expect(done).toHaveLength(1);
    expect(done[0].resolvedBy).toBe("l2");

    const promotions = eventsOf(events, "rung-promoted");
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ issue: 1, from: "l1", to: "l2", attemptsUsed: 2 });

    // exactly one arming commit and one implementation commit
    expect(gitLog(repo)).toEqual(["capataz: 01-rescue", "capataz: arming 01-rescue", "initial"]);

    // L1's partial work was in the tree when L2 was invoked
    expect(partialInTreeAtL2).toBe(true);

    // the first L2 prompt has repair framing and carries L1's failure history
    expect(prompts.fixer_l2[0]).toContain("You are a Fixer");
    expect(prompts.fixer_l2[0]).toContain("Previous failed attempts");

    // fixer attempts show up as fixer_l2 backend results on the fixer backend
    const fixerResults = eventsOf(events, "backend-result").filter((e) => e.role === "fixer_l2");
    expect(fixerResults).toHaveLength(1);
    expect(fixerResults[0].backend).toBe("fix2-b");

    // attempt-started events carry the rung
    const rungs = eventsOf(events, "attempt-started").map((e) => e.rung);
    expect(rungs).toEqual(["l1", "l2"]);
  });
});

describe("escalation ladder: L3 rescue", () => {
  test("L1 and L2 fail, L3 solves: resolvedBy l3, two promotions", async () => {
    const fixture = makeFixture("deep", "test -f impl.txt");
    const { repo, plan } = fixture;
    const { invoke } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "red"),
      executor: () => writeFileSync(join(repo, "partial.txt"), "l1"),
      fixer_l2: () => writeFileSync(join(repo, "partial.txt"), "l2"),
      fixer_l3: () => writeFileSync(join(repo, "impl.txt"), "l3 fixed"),
    });
    const { result, events } = await run(
      ladderConfig({ budgets: { attempts_l2: 1 } }),
      fixture,
      invoke,
    );

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(statusOf(plan, 1)).toBe("done");
    expect(eventsOf(events, "issue-done")[0].resolvedBy).toBe("l3");

    const promotions = eventsOf(events, "rung-promoted");
    expect(promotions.map((p) => [p.from, p.to])).toEqual([
      ["l1", "l2"],
      ["l2", "l3"],
    ]);

    expect(gitLog(repo)).toEqual(["capataz: 01-deep", "capataz: arming 01-deep", "initial"]);
  });
});

describe("escalation ladder: unconfigured rungs are skipped", () => {
  test("no fixer_l2: L1 exhaustion promotes straight to l3", async () => {
    const fixture = makeFixture("skip2", "test -f impl.txt");
    const { repo } = fixture;
    const { invoke, prompts } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "red"),
      fixer_l3: () => writeFileSync(join(repo, "impl.txt"), "l3 fixed"),
    });
    const { result, events } = await run(ladderConfig({ fixer_l2: false }), fixture, invoke);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(eventsOf(events, "issue-done")[0].resolvedBy).toBe("l3");
    expect(prompts.fixer_l2).toHaveLength(0);

    const promotions = eventsOf(events, "rung-promoted");
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ from: "l1", to: "l3" });
  });

  test("no fixers at all: phase-2 behaviour, escalate straight to human", async () => {
    const fixture = makeFixture("nofix", "test -f impl.txt");
    const { repo, plan } = fixture;
    const { invoke, prompts } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "red"),
    });
    const { result, events } = await run(
      ladderConfig({ fixer_l2: false, fixer_l3: false }),
      fixture,
      invoke,
    );

    expect(result.outcomes[0]?.kind).toBe("escalated");
    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(eventsOf(events, "rung-promoted")).toHaveLength(0);
    expect(prompts.fixer_l2).toHaveLength(0);
    expect(prompts.fixer_l3).toHaveLength(0);
  });
});

describe("escalation ladder: global attempt cap", () => {
  test("max_attempts_per_issue reached mid-L2 escalates without invoking L3", async () => {
    const fixture = makeFixture("capped", "test -f impl.txt");
    const { repo, plan } = fixture;
    const { invoke, prompts } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "red"),
    });
    // arming(1) + executor(1) = L1 exhausted; L2 budget 5 but global cap 3 → one L2 attempt
    const { result, events } = await run(
      ladderConfig({ budgets: { max_attempts_per_issue: 3, attempts_l2: 5 } }),
      fixture,
      invoke,
    );

    expect(result.outcomes[0]?.kind).toBe("escalated");
    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(prompts.fixer_l2).toHaveLength(1);
    expect(prompts.fixer_l3).toHaveLength(0);
    expect(eventsOf(events, "rung-promoted")).toHaveLength(1);
  });
});

describe("escalation ladder: gates hold at every rung", () => {
  test("a fixer touching the Arming triggers the mechanical violation, then recovers", async () => {
    const fixture = makeFixture("fixcheat", "test -f impl.txt");
    const { repo } = fixture;
    const { invoke, prompts } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "STRICT"),
      fixer_l2: (attempt) => {
        writeFileSync(join(repo, "impl.txt"), "impl");
        if (attempt === 1) writeFileSync(join(repo, "armed.txt"), "weakened");
      },
    });
    const { result, events } = await run(ladderConfig(), fixture, invoke);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(eventsOf(events, "issue-done")[0].resolvedBy).toBe("l2");

    const violations = eventsOf(events, "arming-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].files).toEqual(["armed.txt"]);
    expect(prompts.fixer_l2[1]).toContain("armed.txt");

    const committed = Bun.spawnSync(["git", "show", "HEAD:armed.txt"], { cwd: repo });
    expect(committed.stdout.toString()).toBe("STRICT");
  });

  test("a fixer rogue commit is contained by the guard", async () => {
    const fixture = makeFixture("fixrogue", "test -f impl.txt");
    const { repo } = fixture;
    const { invoke } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "red"),
      fixer_l2: () => {
        writeFileSync(join(repo, "impl.txt"), "impl");
        sh(repo, "add", "-A");
        sh(repo, "commit", "-m", "fixer: sneaky commit");
      },
    });
    const { result, events } = await run(ladderConfig(), fixture, invoke);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(eventsOf(events, "rogue-commit")).toHaveLength(1);
    expect(gitLog(repo)).toEqual([
      "capataz: 01-fixrogue",
      "capataz: arming 01-fixrogue",
      "initial",
    ]);
    expect(gitLog(repo)).not.toContain("fixer: sneaky commit");
  });
});

describe("escalation ladder: arming failures bypass the ladder", () => {
  test("an arming failure never invokes any fixer backend", async () => {
    const fixture = makeFixture("greenarrival", "true");
    const { repo, plan } = fixture;
    const { invoke, prompts } = fakeRoles({
      armorer: () => writeFileSync(join(repo, "armed.txt"), "vacuous"),
    });
    const { result, events } = await run(ladderConfig(), fixture, invoke);

    expect(result.outcomes[0]?.kind).toBe("escalated");
    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(eventsOf(events, "arming-failed")).toHaveLength(1);
    expect(eventsOf(events, "rung-promoted")).toHaveLength(0);
    expect(prompts.executor).toHaveLength(0);
    expect(prompts.fixer_l2).toHaveLength(0);
    expect(prompts.fixer_l3).toHaveLength(0);
  });
});

describe("escalation ladder: --no-judge still climbs", () => {
  test("executor exhausts L1, fixer_l2 rescues without arming/reviewer gates", async () => {
    const fixture = makeFixture("nojudge", "test -f impl.txt");
    const { repo, plan } = fixture;
    const { invoke, prompts } = fakeRoles({
      fixer_l2: () => writeFileSync(join(repo, "impl.txt"), "fixed"),
    });
    const { result, events } = await run(
      ladderConfig({ budgets: { attempts_l1: 1 } }),
      fixture,
      invoke,
      true,
    );

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(statusOf(plan, 1)).toBe("done");
    expect(eventsOf(events, "issue-done")[0].resolvedBy).toBe("l2");
    expect(prompts.armorer).toHaveLength(0);
    expect(prompts.reviewer).toHaveLength(0);
    expect(eventsOf(events, "rung-promoted")).toHaveLength(1);
    expect(gitLog(repo)).toEqual(["capataz: 01-nojudge", "initial"]);
  });
});
