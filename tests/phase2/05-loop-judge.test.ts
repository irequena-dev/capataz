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

interface FixtureIssue {
  number: string;
  slug: string;
  dependsOn?: string;
  verification: string;
  arming?: string;
}

function makeFixture(issues: FixtureIssue[]): { repo: string; plan: Plan } {
  const repo = mkdtempSync(join(tmpdir(), "capataz-p2-loop-"));
  sh(repo, "init", "-b", "main");
  sh(repo, "config", "user.email", "test@capataz.local");
  sh(repo, "config", "user.name", "Capataz Test");
  const planDir = join(repo, ".scratch", "toy-feature");
  mkdirSync(join(planDir, "issues"), { recursive: true });
  writeFileSync(join(planDir, "PRD.md"), "# PRD: toy\n");
  for (const issue of issues) {
    const lines = [
      `# ${issue.number} — ${issue.slug}`,
      "",
      "Status: ready-for-agent",
      `Depends-on: ${issue.dependsOn ?? "none"}`,
      `Verification: ${issue.verification}`,
    ];
    if (issue.arming) lines.push(`Arming: ${issue.arming}`);
    lines.push("", `Create the artifact for ${issue.slug}.`);
    writeFileSync(join(planDir, "issues", `${issue.number}-${issue.slug}.md`), lines.join("\n"));
  }
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "initial");
  const loaded = loadPlan(planDir);
  if (loaded.kind !== "valid") throw new Error(loaded.problems.join("\n"));
  return { repo, plan: loaded.plan };
}

function judgedConfig(overrides?: {
  budgets?: Partial<Config["budgets"]>;
  suite_command?: string;
}): Config {
  return {
    backends: {
      "exec-b": { command: ["exec-bin"], env: {}, timeout_minutes: 1 },
      "arm-b": { command: ["arm-bin"], env: {}, timeout_minutes: 1 },
      "rev-b": { command: ["rev-bin"], env: {}, timeout_minutes: 1 },
    },
    roles: { executor: "exec-b", armorer: "arm-b", reviewer: "rev-b" },
    budgets: {
      max_attempts_per_issue: 4,
      attempts_l1: 4,
      attempts_l2: 2,
      attempts_l3: 2,
      max_escalations_per_run: 3,
      max_audit_issues: 5,
      verification_timeout_minutes: 1,
      ...overrides?.budgets,
    },
    suite_command: overrides?.suite_command,
  } as Config;
}

const okResult = { kind: "ok", stdout: "done", stderr: "", durationMs: 5, exitCode: 0 } as const;

const APPROVE = "VERDICT: approve\nSUMMARY: ";

/**
 * Role-aware fake: dispatches on backend command name.
 * - armorer/executor: side effects per issue number (parsed from `# Issue: <NN>`), per attempt
 * - reviewer: FIFO script of stdouts (default: approve everything)
 */
function fakeRoles(behaviors: {
  armorer?: Record<number, (attempt: number) => void>;
  executor?: Record<number, (attempt: number) => void>;
  reviewerScript?: (string | ((prompt: string) => string))[];
  reviewerDefault?: string;
}): {
  invoke: InvokeFn;
  prompts: { armorer: string[]; executor: string[]; reviewer: string[] };
} {
  const prompts = { armorer: [] as string[], executor: [] as string[], reviewer: [] as string[] };
  const attempts = { armorer: new Map<number, number>(), executor: new Map<number, number>() };
  const script = [...(behaviors.reviewerScript ?? [])];

  const invoke: InvokeFn = async (backend, prompt) => {
    const bin = backend.command[0];
    if (bin === "rev-bin") {
      prompts.reviewer.push(prompt);
      const next = script.shift();
      const stdout =
        typeof next === "function"
          ? next(prompt)
          : (next ?? behaviors.reviewerDefault ?? `${APPROVE}reviewed and fine`);
      return { ...okResult, stdout };
    }
    const role = bin === "arm-bin" ? "armorer" : "executor";
    prompts[role].push(prompt);
    const issue = Number(prompt.match(/# Issue: (\d+)/)?.[1]);
    const attempt = (attempts[role].get(issue) ?? 0) + 1;
    attempts[role].set(issue, attempt);
    behaviors[role]?.[issue]?.(attempt);
    return okResult;
  };
  return { invoke, prompts };
}

function statusOf(plan: Plan, n: number): string {
  const issue = plan.issues.get(n)!;
  const line = readFileSync(issue.path, "utf8").match(/^Status: (.*)$/m);
  return line![1]!;
}

function eventsOf(events: RunEvent[], type: string): any[] {
  return events.filter((e) => (e.type as string) === type) as any[];
}

describe("runLoop judged: happy path", () => {
  test("two commits per issue, verdicts recorded, summaries flow forward", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "one", verification: "test -f impl-1.txt" },
      { number: "02", slug: "two", dependsOn: "01", verification: "test -f impl-2.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      armorer: {
        1: () => writeFileSync(join(repo, "armed-1.txt"), "red test 1"),
        2: () => writeFileSync(join(repo, "armed-2.txt"), "red test 2"),
      },
      executor: {
        1: () => writeFileSync(join(repo, "impl-1.txt"), "1"),
        2: () => writeFileSync(join(repo, "impl-2.txt"), "2"),
      },
      reviewerScript: [`${APPROVE}one exists at impl-1.txt`, `${APPROVE}two exists at impl-2.txt`],
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.kind).toBe("completed");
    expect(result.outcomes.map((o) => o.kind)).toEqual(["done", "done"]);
    expect(statusOf(plan, 1)).toBe("done");
    expect(statusOf(plan, 2)).toBe("done");

    expect(gitLog(repo)).toEqual([
      "capataz: 02-two",
      "capataz: arming 02-two",
      "capataz: 01-one",
      "capataz: arming 01-one",
      "initial",
    ]);

    const started = eventsOf(events, "run-started")[0];
    expect(started.judged).toBe(true);

    const reviews = eventsOf(events, "review-result");
    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.verdict === "approve")).toBe(true);

    expect(eventsOf(events, "arming-committed")).toHaveLength(2);

    // issue 2's executor prompt carries issue 1's reviewer summary and its own armed files
    const secondPrompt = prompts.executor.find((p) => p.includes("# Issue: 02"));
    expect(secondPrompt).toContain("one exists at impl-1.txt");
    expect(secondPrompt).toContain("armed-2.txt");

    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo });
    expect(status.stdout.toString().trim()).toBe("");
  });
});

describe("runLoop judged: cheating is contained", () => {
  test("executor touching the Arming: violation, restore, feedback, recovery", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "cheat", verification: "test -f impl.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      armorer: { 1: () => writeFileSync(join(repo, "armed.txt"), "STRICT") },
      executor: {
        1: (attempt) => {
          writeFileSync(join(repo, "impl.txt"), "impl");
          if (attempt === 1) writeFileSync(join(repo, "armed.txt"), "weakened");
        },
      },
      reviewerScript: [`${APPROVE}impl.txt exists, arming intact`],
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");

    const violations = eventsOf(events, "arming-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].files).toEqual(["armed.txt"]);

    // the second executor attempt was told exactly what it violated
    expect(prompts.executor[1]).toContain("armed.txt");

    // the committed arming is the original, not the weakened one
    const committed = Bun.spawnSync(["git", "show", "HEAD:armed.txt"], { cwd: repo });
    expect(committed.stdout.toString()).toBe("STRICT");
  });
});

describe("runLoop judged: reviewer rejection feeds back", () => {
  test("reject consumes an attempt, REASON reaches the next prompt, then approve", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "picky", verification: "test -f impl.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      armorer: { 1: () => writeFileSync(join(repo, "armed.txt"), "red") },
      executor: {
        1: (attempt) => writeFileSync(join(repo, "impl.txt"), attempt === 1 ? "wrong" : "42"),
      },
      reviewerScript: [
        "VERDICT: reject\nREASON: impl.txt must contain 42",
        `${APPROVE}impl.txt holds 42`,
      ],
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(prompts.executor).toHaveLength(2);
    expect(prompts.executor[1]).toContain("impl.txt must contain 42");

    const reviews = eventsOf(events, "review-result");
    expect(reviews.map((r) => r.verdict)).toEqual(["reject", "approve"]);

    // the rejected provisional commit did not survive: exactly one implementation commit
    expect(gitLog(repo)).toEqual(["capataz: 01-picky", "capataz: arming 01-picky", "initial"]);
  });
});

describe("runLoop judged: red-on-arrival", () => {
  test("arming that never goes red escalates without dispatching the executor", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "already-done", verification: "true" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      armorer: { 1: () => writeFileSync(join(repo, "armed.txt"), "vacuous") },
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("escalated");
    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(prompts.executor).toHaveLength(0);
    expect(eventsOf(events, "arming-failed")).toHaveLength(1);
    expect(gitLog(repo)).toEqual(["initial"]);
  });
});

describe("runLoop judged: clean escalation of an armed issue", () => {
  test("arming commit dropped from the branch, patch preserved, independents continue", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "impossible", verification: "test -f never.txt" },
      { number: "02", slug: "fine", verification: "test -f impl-2.txt" },
    ]);
    const git = createGit(repo);
    const { invoke } = fakeRoles({
      armorer: {
        1: () => writeFileSync(join(repo, "armed-1.txt"), "red forever"),
        2: () => writeFileSync(join(repo, "armed-2.txt"), "red test 2"),
      },
      executor: {
        // issue 1's executor never satisfies verification
        2: () => writeFileSync(join(repo, "impl-2.txt"), "2"),
      },
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig({ budgets: { max_attempts_per_issue: 3, attempts_l1: 3 } }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    const outcome1 = result.outcomes.find((o) => o.issue === 1);
    expect(outcome1?.kind).toBe("escalated");
    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(statusOf(plan, 2)).toBe("done");

    // no trace of issue 1's arming on the branch
    const log = gitLog(repo);
    expect(log).not.toContain("capataz: arming 01-impossible");
    expect(log).toContain("capataz: arming 02-fine");
    expect(existsSync(join(repo, "armed-1.txt"))).toBe(false);

    // the arming survived as a patch event
    const patches = eventsOf(events, "arming-patch");
    expect(patches).toHaveLength(1);
    expect(patches[0].issue).toBe(1);
    expect(patches[0].patch).toContain("armed-1.txt");
    expect(patches[0].patch).toContain("+red forever");
  });
});

describe("runLoop judged: Arming: none", () => {
  test("skips the armorer, keeps verification and reviewer", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "docs", verification: "test -f README-x.md", arming: "none" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      executor: { 1: () => writeFileSync(join(repo, "README-x.md"), "docs") },
      reviewerScript: [`${APPROVE}README-x.md written`],
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(prompts.armorer).toHaveLength(0);
    expect(prompts.reviewer).toHaveLength(1);
    const skips = eventsOf(events, "arming-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toBe("none");
    expect(gitLog(repo)).toEqual(["capataz: 01-docs", "initial"]);
  });
});

describe("runLoop unjudged (--no-judge)", () => {
  test("reproduces phase-1 behaviour and is marked unjudged", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "one", verification: "test -f impl.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      executor: { 1: () => writeFileSync(join(repo, "impl.txt"), "1") },
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
      noJudge: true,
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(prompts.armorer).toHaveLength(0);
    expect(prompts.reviewer).toHaveLength(0);
    expect(gitLog(repo)).toEqual(["capataz: 01-one", "initial"]);
    expect(eventsOf(events, "run-started")[0].judged).toBe(false);
  });
});

describe("runLoop judged: suite gate", () => {
  test("a red suite_command blocks the commit even with the issue verification green", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "regressor", verification: "test -f impl.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeRoles({
      armorer: { 1: () => writeFileSync(join(repo, "armed.txt"), "red") },
      executor: {
        1: (attempt) => {
          writeFileSync(join(repo, "impl.txt"), "impl");
          if (attempt === 2) writeFileSync(join(repo, "suite-ok.txt"), "ok");
        },
      },
      reviewerScript: [`${APPROVE}impl.txt exists and the suite is green`],
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig({ suite_command: "test -f suite-ok.txt" }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    const suites = eventsOf(events, "suite-result");
    expect(suites.length).toBeGreaterThanOrEqual(2);
    expect(suites[0].exitCode).not.toBe(0);
    expect(suites.at(-1).exitCode).toBe(0);
    // the retry prompt tells the executor the full suite broke
    expect(prompts.executor[1]!.toLowerCase()).toContain("suite");
    // only one reviewer call: the reviewer is never consulted behind a red suite
    expect(prompts.reviewer).toHaveLength(1);
  });
});

describe("runLoop judged: reviewer is read-only", () => {
  test("reviewer edits are reverted and logged; the issue still lands", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "one", verification: "test -f impl.txt" },
    ]);
    const git = createGit(repo);
    const { invoke } = fakeRoles({
      armorer: { 1: () => writeFileSync(join(repo, "armed.txt"), "red") },
      executor: { 1: () => writeFileSync(join(repo, "impl.txt"), "1") },
      reviewerScript: [
        (_prompt) => {
          writeFileSync(join(repo, "reviewer-junk.txt"), "should not survive");
          return `${APPROVE}impl.txt exists`;
        },
      ],
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(existsSync(join(repo, "reviewer-junk.txt"))).toBe(false);
    expect(eventsOf(events, "reviewer-dirty-tree")).toHaveLength(1);

    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo });
    expect(status.stdout.toString().trim()).toBe("");
  });
});
