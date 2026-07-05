import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armIssue, buildArmorerPrompt } from "../../src/arming";
import type { Backend } from "../../src/config";
import { createGit } from "../../src/git";
import type { Issue } from "../../src/issue";
import type { InvokeFn } from "../../src/loop";

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

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "capataz-p2-arming-"));
  sh(repo, "init", "-b", "main");
  sh(repo, "config", "user.email", "test@capataz.local");
  sh(repo, "config", "user.name", "Capataz Test");
  return repo;
}

function makeIssue(repo: string, verification: string): Issue {
  const issuesDir = join(repo, ".scratch", "toy", "issues");
  mkdirSync(issuesDir, { recursive: true });
  const path = join(issuesDir, "03-thing.md");
  writeFileSync(
    path,
    [
      "# 03 — thing",
      "",
      "Status: ready-for-agent",
      "Depends-on: none",
      `Verification: ${verification}`,
      "",
      "Create the thing.",
    ].join("\n"),
  );
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "initial");
  return {
    number: 3,
    slug: "thing",
    title: "03 — thing",
    status: "ready-for-agent",
    dependsOn: [],
    verification,
    body: "Create the thing.",
    path,
    arming: "auto",
  } as Issue;
}

const backend: Backend = { command: ["arm-bin"], env: {}, timeout_minutes: 1 };

const okResult = { kind: "ok", stdout: "wrote tests", stderr: "", durationMs: 5, exitCode: 0 } as const;

function fakeArmorer(behavior: (attempt: number) => void): { invoke: InvokeFn; prompts: string[] } {
  const prompts: string[] = [];
  const invoke: InvokeFn = async (_backend, prompt) => {
    prompts.push(prompt);
    behavior(prompts.length);
    return okResult;
  };
  return { invoke, prompts };
}

describe("buildArmorerPrompt", () => {
  test("carries framing, issue, verification command, summaries and feedback", () => {
    const repo = makeRepo();
    const issue = makeIssue(repo, "test -f impl.txt");
    const prompt = buildArmorerPrompt(
      issue,
      [{ number: 1, title: "01 — base", files: ["src/base.ts"], summary: "base module exists" }],
      ["tests passed on arrival; the Arming must fail before implementation"],
    );
    expect(prompt).toContain("Armorer");
    expect(prompt).toContain("# Issue: 03 — thing");
    expect(prompt).toContain("Create the thing.");
    expect(prompt).toContain("test -f impl.txt");
    expect(prompt).toContain("base module exists");
    expect(prompt).toContain("passed on arrival");
    expect(prompt.toLowerCase()).toContain("do not implement");
  });
});

describe("armIssue", () => {
  test("red arming is committed: right message, right files, clean tree", async () => {
    const repo = makeRepo();
    const git = createGit(repo);
    const issue = makeIssue(repo, "test -f impl.txt");
    const headBefore = git.head();
    const { invoke } = fakeArmorer(() => {
      writeFileSync(join(repo, "armed.txt"), "assert impl.txt exists");
    });

    const result = await armIssue({
      issue,
      backend,
      git,
      repoPath: repo,
      invokeFn: invoke,
      verificationTimeoutMinutes: 1,
      maxAttempts: 3,
      doneSummaries: [],
    });

    expect(result.kind).toBe("armed");
    if (result.kind !== "armed") throw new Error("unreachable");
    expect(result.files).toEqual(["armed.txt"]);
    expect(result.attemptsUsed).toBe(1);
    expect(result.commit).toBe(git.head());
    expect(git.head()).not.toBe(headBefore);
    expect(gitLog(repo)[0]).toBe("capataz: arming 03-thing");
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo });
    expect(status.stdout.toString().trim()).toBe("");
  });

  test("green on arrival: retries with feedback, then fails with no arming commit", async () => {
    const repo = makeRepo();
    const git = createGit(repo);
    const issue = makeIssue(repo, "true");
    const { invoke, prompts } = fakeArmorer(() => {
      writeFileSync(join(repo, "armed.txt"), "vacuous test");
    });

    const result = await armIssue({
      issue,
      backend,
      git,
      repoPath: repo,
      invokeFn: invoke,
      verificationTimeoutMinutes: 1,
      maxAttempts: 2,
      doneSummaries: [],
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.attemptsUsed).toBe(2);
    expect(prompts).toHaveLength(2);
    // second attempt carries the red-on-arrival feedback
    expect(prompts[1]).toContain("passed on arrival");
    // no arming commit, junk reverted
    expect(gitLog(repo)).toEqual(["initial"]);
    expect(existsSync(join(repo, "armed.txt"))).toBe(false);
  });

  test("armorer that writes nothing fails with a 'no changes' reason", async () => {
    const repo = makeRepo();
    const git = createGit(repo);
    const issue = makeIssue(repo, "test -f impl.txt");
    const { invoke } = fakeArmorer(() => {});

    const result = await armIssue({
      issue,
      backend,
      git,
      repoPath: repo,
      invokeFn: invoke,
      verificationTimeoutMinutes: 1,
      maxAttempts: 2,
      doneSummaries: [],
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("no changes");
    expect(gitLog(repo)).toEqual(["initial"]);
  });

  test("armorer timeout counts as a failed attempt, then a red arming succeeds", async () => {
    const repo = makeRepo();
    const git = createGit(repo);
    const issue = makeIssue(repo, "test -f impl.txt");
    let calls = 0;
    const invoke: InvokeFn = async () => {
      calls += 1;
      if (calls === 1) return { kind: "timeout", stdout: "", stderr: "", durationMs: 10 };
      writeFileSync(join(repo, "armed.txt"), "assert impl.txt exists");
      return okResult;
    };

    const result = await armIssue({
      issue,
      backend,
      git,
      repoPath: repo,
      invokeFn: invoke,
      verificationTimeoutMinutes: 1,
      maxAttempts: 3,
      doneSummaries: [],
    });

    expect(result.kind).toBe("armed");
    if (result.kind !== "armed") throw new Error("unreachable");
    expect(result.attemptsUsed).toBe(2);
  });
});

describe("git extensions", () => {
  test("commitArming, filesInCommit, diffPatch, resetHardTo, restoreFiles, softResetLast", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "base.txt"), "base");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-m", "initial");
    const git = createGit(repo);
    const pre = git.head();

    // commitArming + filesInCommit
    writeFileSync(join(repo, "armed.txt"), "red test");
    git.commitArming({ number: 3, slug: "thing" });
    const armingCommit = git.head();
    expect(gitLog(repo)[0]).toBe("capataz: arming 03-thing");
    expect(git.filesInCommit(armingCommit)).toEqual(["armed.txt"]);

    // diffPatch carries the arming content
    const patch = git.diffPatch(pre, armingCommit);
    expect(patch).toContain("armed.txt");
    expect(patch).toContain("+red test");

    // restoreFiles: corrupt the armed file, restore it from HEAD
    writeFileSync(join(repo, "armed.txt"), "weakened");
    git.restoreFiles("HEAD", ["armed.txt"]);
    expect(Bun.file(join(repo, "armed.txt")).size).toBeGreaterThan(0);
    const restored = Bun.spawnSync(["cat", "armed.txt"], { cwd: repo }).stdout.toString();
    expect(restored).toBe("red test");

    // softResetLast: provisional commit undone, work stays in tree
    writeFileSync(join(repo, "impl.txt"), "implementation");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-m", "provisional");
    git.softResetLast();
    expect(gitLog(repo)[0]).toBe("capataz: arming 03-thing");
    expect(existsSync(join(repo, "impl.txt"))).toBe(true);

    // resetHardTo: drops the arming commit and cleans the tree
    git.resetHardTo(pre);
    expect(git.head()).toBe(pre);
    expect(existsSync(join(repo, "armed.txt"))).toBe(false);
    expect(existsSync(join(repo, "impl.txt"))).toBe(false);
  });
});
