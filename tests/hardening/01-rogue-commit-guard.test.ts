import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const repo = mkdtempSync(join(tmpdir(), "capataz-rogue-"));
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

function judgedConfig(): Config {
  return {
    backends: {
      "exec-b": { command: ["exec-bin"], env: {}, timeout_minutes: 1 },
      "arm-b": { command: ["arm-bin"], env: {}, timeout_minutes: 1 },
      "rev-b": { command: ["rev-bin"], env: {}, timeout_minutes: 1 },
    },
    roles: { executor: "exec-b", armorer: "arm-b", reviewer: "rev-b" },
    budgets: {
      max_attempts_per_issue: 4,
      max_escalations_per_run: 3,
      max_audit_issues: 5,
      verification_timeout_minutes: 1,
    },
  } as Config;
}

const okResult = { kind: "ok", stdout: "done", stderr: "", durationMs: 5, exitCode: 0 } as const;
const APPROVE = "VERDICT: approve\nSUMMARY: reviewed and fine";

/** Fake roles: armorer arms `armed.txt`, executor runs `executorFn`, reviewer approves. */
function fakeRoles(executorFn: (repo: string) => void, repo: string): InvokeFn {
  return async (backend) => {
    const bin = backend.command[0];
    if (bin === "rev-bin") return { ...okResult, stdout: APPROVE };
    if (bin === "arm-bin") {
      writeFileSync(join(repo, "armed.txt"), "red");
      return okResult;
    }
    executorFn(repo);
    return okResult;
  };
}

function eventsOf(events: RunEvent[], type: string): any[] {
  return events.filter((e) => (e.type as string) === type) as any[];
}

function statusOf(plan: Plan, n: number): string {
  const issue = plan.issues.get(n)!;
  return readFileSync(issue.path, "utf8").match(/^Status: (.*)$/m)![1]!;
}

describe("rogue-commit guard", () => {
  test("an executor that self-commits lands as a normal capataz commit, no escalation", async () => {
    const { repo, plan } = makeFixture("selfcommit", "test -f impl.txt");
    const git = createGit(repo);
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: fakeRoles((r) => {
        writeFileSync(join(r, "impl.txt"), "impl");
        sh(r, "add", "-A");
        sh(r, "commit", "-m", "executor: sneaky commit");
      }, repo),
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(statusOf(plan, 1)).toBe("done");
    expect(eventsOf(events, "infrastructure-failure")).toHaveLength(0);
    expect(eventsOf(events, "issue-escalated")).toHaveLength(0);
    const rogue = eventsOf(events, "rogue-commit");
    expect(rogue).toHaveLength(1);
    // the runner's own commit message never survives on the branch
    expect(gitLog(repo)).toEqual([
      "capataz: 01-selfcommit",
      "capataz: arming 01-selfcommit",
      "initial",
    ]);
    expect(gitLog(repo)).not.toContain("executor: sneaky commit");
  });

  test("an executor that self-commits AND leaves the tree dirty is contained", async () => {
    const { repo, plan } = makeFixture("dirty", "test -f impl.txt");
    const git = createGit(repo);
    const events: RunEvent[] = [];
    const result = await runLoop({
      config: judgedConfig(),
      plan,
      git,
      repoPath: repo,
      invokeFn: fakeRoles((r) => {
        writeFileSync(join(r, "impl.txt"), "impl");
        sh(r, "add", "-A");
        sh(r, "commit", "-m", "executor: sneaky commit");
        // extra work left uncommitted after the rogue commit
        writeFileSync(join(r, "extra.txt"), "leftover");
      }, repo),
      onEvent: (e: RunEvent) => events.push(e),
    } as any);

    expect(result.outcomes[0]?.kind).toBe("done");
    expect(eventsOf(events, "rogue-commit")).toHaveLength(1);
    // working tree ends clean: both the un-committed impl and the leftover landed
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo });
    expect(status.stdout.toString().trim()).toBe("");
    const committed = Bun.spawnSync(["git", "show", "HEAD:extra.txt"], { cwd: repo });
    expect(committed.stdout.toString()).toBe("leftover");
  });
});
