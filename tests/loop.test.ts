import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { createGit, type Git } from "../src/git";
import type { InvokeResult } from "../src/invoker";
import { loadPlan, type Plan } from "../src/plan";
import { runLoop, type InvokeFn, type RunEvent } from "../src/loop";
import { renderReport } from "../src/report";

function sh(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

interface FixtureIssue {
  number: string;
  slug: string;
  dependsOn?: string;
  verification: string;
}

function makeFixture(issues: FixtureIssue[]): { repo: string; plan: Plan } {
  const repo = mkdtempSync(join(tmpdir(), "capataz-loop-"));
  sh(repo, "init", "-b", "main");
  sh(repo, "config", "user.email", "test@capataz.local");
  sh(repo, "config", "user.name", "Capataz Test");
  const planDir = join(repo, ".scratch", "toy-feature");
  mkdirSync(join(planDir, "issues"), { recursive: true });
  writeFileSync(join(planDir, "PRD.md"), "# PRD: toy\n");
  for (const issue of issues) {
    writeFileSync(
      join(planDir, "issues", `${issue.number}-${issue.slug}.md`),
      [
        `# ${issue.number} — ${issue.slug}`,
        "",
        "Status: ready-for-agent",
        `Depends-on: ${issue.dependsOn ?? "none"}`,
        `Verification: ${issue.verification}`,
        "",
        `Create the artifact for ${issue.slug}.`,
      ].join("\n"),
    );
  }
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "initial");
  const loaded = loadPlan(planDir);
  if (loaded.kind !== "valid") throw new Error(loaded.problems.join("\n"));
  return { repo, plan: loaded.plan };
}

function config(budgets?: Partial<Config["budgets"]>): Config {
  return {
    backends: {
      fake: { command: ["unused"], env: {}, timeout_minutes: 1 },
    },
    roles: { executor: "fake", armorer: "fake", reviewer: "fake" },
    budgets: {
      max_attempts_per_issue: 2,
      attempts_l1: 2,
      attempts_l2: 2,
      attempts_l3: 2,
      max_escalations_per_run: 2,
      max_audit_issues: 5,
      verification_timeout_minutes: 1,
      ...budgets,
    },
  };
}

const okResult: InvokeResult = {
  kind: "ok",
  stdout: "done",
  stderr: "",
  durationMs: 5,
  exitCode: 0,
};

/** Fake Executor: per issue number, a side effect run on each attempt. */
function fakeInvoke(
  repo: string,
  behaviors: Record<number, (attempt: number) => void>,
): { invoke: InvokeFn; prompts: string[] } {
  const attempts = new Map<number, number>();
  const prompts: string[] = [];
  const invoke: InvokeFn = async (_backend, prompt) => {
    prompts.push(prompt);
    const match = prompt.match(/# Issue: (\d+)/);
    const issue = Number(match?.[1]);
    const attempt = (attempts.get(issue) ?? 0) + 1;
    attempts.set(issue, attempt);
    behaviors[issue]?.(attempt);
    return okResult;
  };
  return { invoke, prompts };
}

function statusOf(plan: Plan, n: number): string {
  const issue = plan.issues.get(n)!;
  const line = readFileSync(issue.path, "utf8").match(/^Status: (.*)$/m);
  return line![1]!;
}

describe("runLoop", () => {
  test("all-green run: one commit per issue, statuses done, events in order", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "one", verification: "test -f f1.txt" },
      { number: "02", slug: "two", dependsOn: "01", verification: "test -f f2.txt" },
      { number: "03", slug: "three", verification: "test -f f3.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeInvoke(repo, {
      1: () => writeFileSync(join(repo, "f1.txt"), "1"),
      2: () => writeFileSync(join(repo, "f2.txt"), "2"),
      3: () => writeFileSync(join(repo, "f3.txt"), "3"),
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: config(),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    expect(result.kind).toBe("completed");
    expect(result.escalations).toBe(0);
    expect(result.outcomes.map((o) => o.kind)).toEqual(["done", "done", "done"]);

    for (const n of [1, 2, 3]) expect(statusOf(plan, n)).toBe("done");

    const log = Bun.spawnSync(["git", "log", "--format=%s"], { cwd: repo });
    const subjects = log.stdout.toString().trim().split("\n");
    expect(subjects).toEqual([
      "capataz: 03-three",
      "capataz: 02-two",
      "capataz: 01-one",
      "initial",
    ]);

    // working tree ends clean: statuses committed with their issue
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo });
    expect(status.stdout.toString().trim()).toBe("");

    // later prompts carry the state summary of earlier done issues
    expect(prompts[1]).toContain("- 01 — one:");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run-started");
    expect(types.at(-1)).toBe("run-finished");
    expect(types).toContain("issue-started");
    expect(types).toContain("attempt-started");
    expect(types).toContain("backend-result");
    expect(types).toContain("verification-result");
    expect(types).toContain("issue-committed");
    expect(types).toContain("issue-done");
  });

  test("always-red issue: escalates after max attempts, reverts junk, skips dependent, independent survives", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "red", verification: "false" },
      { number: "02", slug: "dependent", dependsOn: "01", verification: "test -f f2.txt" },
      { number: "03", slug: "independent", verification: "test -f f3.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeInvoke(repo, {
      1: () => writeFileSync(join(repo, "junk.txt"), "junk from failed attempt"),
      3: () => writeFileSync(join(repo, "f3.txt"), "3"),
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: config({ max_attempts_per_issue: 2, max_escalations_per_run: 2 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    expect(result.kind).toBe("completed");
    expect(result.escalations).toBe(1);

    // issue 1 tried max_attempts times, then escalated
    const issue1Attempts = prompts.filter((p) => p.includes("# Issue: 01")).length;
    expect(issue1Attempts).toBe(2);
    // retry prompt carries the previous failure output
    expect(prompts.filter((p) => p.includes("# Issue: 01")).at(-1)).toContain(
      "Previous failed attempts",
    );

    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(statusOf(plan, 2)).toBe("ready-for-agent"); // skipped, untouched
    expect(statusOf(plan, 3)).toBe("done");

    // junk from the failed attempts was reverted
    expect(existsSync(join(repo, "junk.txt"))).toBe(false);
    // the independent issue still got its commit
    const log = Bun.spawnSync(["git", "log", "--format=%s"], { cwd: repo });
    expect(log.stdout.toString()).toContain("capataz: 03-independent");

    const outcome1 = result.outcomes.find((o) => o.issue === 1);
    expect(outcome1?.kind).toBe("escalated");
    const outcome2 = result.outcomes.find((o) => o.issue === 2);
    expect(outcome2?.kind).toBe("skipped");
    if (outcome2?.kind !== "skipped") throw new Error("unreachable");
    expect(outcome2.blockedBy).toEqual([1]);
    const outcome3 = result.outcomes.find((o) => o.issue === 3);
    expect(outcome3?.kind).toBe("done");

    expect(events.some((e) => e.type === "issue-escalated" && e.issue === 1)).toBe(true);
    expect(events.some((e) => e.type === "issue-skipped" && e.issue === 2)).toBe(true);
  });

  test("aborts when escalations exceed the budget", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "red-one", verification: "false" },
      { number: "02", slug: "red-two", verification: "false" },
      { number: "03", slug: "never-runs", verification: "test -f f3.txt" },
    ]);
    const git = createGit(repo);
    const { invoke, prompts } = fakeInvoke(repo, {});
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: config({ max_attempts_per_issue: 1, max_escalations_per_run: 1 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    expect(result.kind).toBe("aborted");
    if (result.kind !== "aborted") throw new Error("unreachable");
    expect(result.reason).toBe("escalation-budget-exceeded");
    expect(result.escalations).toBe(2);

    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(statusOf(plan, 2)).toBe("ready-for-human");
    // issue 3 was never dispatched
    expect(prompts.some((p) => p.includes("# Issue: 03"))).toBe(false);
    expect(statusOf(plan, 3)).toBe("ready-for-agent");

    const finished = events.at(-1);
    expect(finished?.type).toBe("run-finished");
    if (finished?.type !== "run-finished") throw new Error("unreachable");
    expect(finished.outcome).toBe("aborted");
  });

  test("hanging verification times out, becomes red attempts, escalates — never hangs", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "hang", verification: "sleep 60" },
    ]);
    const git = createGit(repo);
    const { invoke } = fakeInvoke(repo, {});
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: config({ max_attempts_per_issue: 2, verification_timeout_minutes: 0.005 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    expect(result.escalations).toBe(1);
    expect(statusOf(plan, 1)).toBe("ready-for-human");

    const verifications = events.filter((e) => e.type === "verification-result");
    expect(verifications).toHaveLength(2);
    for (const v of verifications) {
      if (v.type !== "verification-result") throw new Error("unreachable");
      expect(v.exitCode).not.toBe(0);
      expect(v.output).toContain("verification timed out after 0.005m");
    }

    // the timeout is visible in the report as the failure reason
    expect(renderReport(events)).toContain("verification timed out after 0.005m");
  }, 10_000);

  test("multi-MB verification output is truncated tail-first to the cap", async () => {
    const { repo, plan } = makeFixture([
      {
        number: "01",
        slug: "big-output",
        verification: "yes AAAA | head -c 3000000; echo TAIL-MARKER; false",
      },
    ]);
    const git = createGit(repo);
    const { invoke } = fakeInvoke(repo, {});
    const events: RunEvent[] = [];
    await runLoop({
      config: config({ max_attempts_per_issue: 1 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    const v = events.find((e) => e.type === "verification-result");
    if (v?.type !== "verification-result") throw new Error("no verification-result event");
    expect(v.output.length).toBeLessThanOrEqual(1_048_576);
    expect(v.output).toStartWith("[...truncated...]");
    expect(v.output).toContain("TAIL-MARKER");
  }, 10_000);

  test("commit failure is contained: escalates the issue, run continues", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "one", verification: "test -f f1.txt" },
      { number: "02", slug: "two", verification: "test -f f2.txt" },
    ]);
    const real = createGit(repo);
    const git: Git = {
      ...real,
      commitIssue(issue) {
        if (issue.number === 1) throw new Error("disk full");
        real.commitIssue(issue);
      },
    };
    const { invoke } = fakeInvoke(repo, {
      1: () => writeFileSync(join(repo, "f1.txt"), "1"),
      2: () => writeFileSync(join(repo, "f2.txt"), "2"),
    });
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: config({ max_escalations_per_run: 2 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    expect(result.kind).toBe("completed");
    expect(result.escalations).toBe(1);
    expect(statusOf(plan, 1)).toBe("ready-for-human");
    expect(statusOf(plan, 2)).toBe("done");

    const failure = events.find((e) => e.type === "infrastructure-failure");
    if (failure?.type !== "infrastructure-failure") throw new Error("no infrastructure-failure");
    expect(failure.issue).toBe(1);
    expect(failure.error).toContain("disk full");
    expect(events.some((e) => e.type === "issue-escalated" && e.issue === 1)).toBe(true);

    // every event survives a JSONL round-trip (report generation works on it)
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
    expect(() => renderReport(events)).not.toThrow();
  });

  test("revert failure aborts the run with a distinct reason, not an exception", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "red", verification: "false" },
      { number: "02", slug: "never-runs", verification: "test -f f2.txt" },
    ]);
    const real = createGit(repo);
    const git: Git = {
      ...real,
      revertToLastGood() {
        throw new Error("reset failed");
      },
    };
    const { invoke, prompts } = fakeInvoke(repo, {});
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: config({ max_attempts_per_issue: 1, max_escalations_per_run: 5 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      onEvent: (e) => events.push(e),
      noJudge: true,
    });

    expect(result.kind).toBe("aborted");
    if (result.kind !== "aborted") throw new Error("unreachable");
    expect(result.reason).toBe("infrastructure-failure");
    // issue 2 was never dispatched after the abort
    expect(prompts.some((p) => p.includes("# Issue: 02"))).toBe(false);

    const finished = events.at(-1);
    if (finished?.type !== "run-finished") throw new Error("no run-finished");
    expect(finished.outcome).toBe("aborted");
    expect(finished.reason).toBe("infrastructure-failure");
  });

  test("runner timeout counts as a failed attempt", async () => {
    const { repo, plan } = makeFixture([
      { number: "01", slug: "slow", verification: "test -f f1.txt" },
    ]);
    const git = createGit(repo);
    const timeoutResult: InvokeResult = {
      kind: "timeout",
      stdout: "partial output",
      stderr: "",
      durationMs: 100,
    };
    const invoke: InvokeFn = async () => timeoutResult;
    const result = await runLoop({
      config: config({ max_attempts_per_issue: 2, max_escalations_per_run: 5 }),
      plan,
      git,
      repoPath: repo,
      invokeFn: invoke,
      noJudge: true,
    });
    expect(result.escalations).toBe(1);
    expect(statusOf(plan, 1)).toBe("ready-for-human");
  });
});
