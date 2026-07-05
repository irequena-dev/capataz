import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit, type Git } from "../src/git";

function sh(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "capataz-git-"));
  sh(dir, "init", "-b", "main");
  sh(dir, "config", "user.email", "test@capataz.local");
  sh(dir, "config", "user.name", "Capataz Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-m", "initial");
  return dir;
}

describe("Git", () => {
  let repo: string;
  let git: Git;

  beforeEach(() => {
    repo = makeRepo();
    git = createGit(repo);
  });

  describe("assertClean", () => {
    test("passes on a clean tree", () => {
      expect(() => git.assertClean()).not.toThrow();
    });

    test("fails on modified tracked file", () => {
      writeFileSync(join(repo, "README.md"), "changed\n");
      expect(() => git.assertClean()).toThrow(/dirty|clean/i);
    });

    test("fails on untracked file", () => {
      writeFileSync(join(repo, "junk.txt"), "x\n");
      expect(() => git.assertClean()).toThrow(/dirty|clean/i);
    });
  });

  describe("createRunBranch", () => {
    test("creates and checks out capataz/<feature>", () => {
      git.createRunBranch("my-feature");
      const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
      expect(branch).toBe("capataz/my-feature");
    });

    test("fails if the branch already exists", () => {
      sh(repo, "branch", "capataz/my-feature");
      expect(() => git.createRunBranch("my-feature")).toThrow(/capataz\/my-feature/);
    });
  });

  describe("commitIssue", () => {
    test("stages everything and commits with capataz: <NN>-<slug>", () => {
      writeFileSync(join(repo, "new-file.ts"), "export {};\n");
      git.commitIssue({ number: 2, slug: "issue-parser" });
      const subject = sh(repo, "log", "-1", "--format=%s").trim();
      expect(subject).toBe("capataz: 02-issue-parser");
      const status = sh(repo, "status", "--porcelain").trim();
      expect(status).toBe("");
    });
  });

  describe("revertToLastGood", () => {
    test("resets tracked changes and removes untracked junk", () => {
      writeFileSync(join(repo, "README.md"), "broken\n");
      writeFileSync(join(repo, "junk.txt"), "junk\n");
      git.revertToLastGood();
      const status = sh(repo, "status", "--porcelain").trim();
      expect(status).toBe("");
      expect(Bun.file(join(repo, "README.md")).size).toBe(6);
    });
  });

  describe("diffStat", () => {
    test("lists per-file entries with line-change counts since a ref", () => {
      const base = sh(repo, "rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "a.ts"), "export {};\nexport const x = 1;\n");
      writeFileSync(join(repo, "README.md"), "goodbye\nworld\n");
      git.commitIssue({ number: 1, slug: "two-files" });
      expect(git.diffStat(base).toSorted()).toEqual([
        "README.md (+2/-1)",
        "a.ts (+2/-0)",
      ]);
    });
  });

  test("head() returns current commit hash", () => {
    const head = sh(repo, "rev-parse", "HEAD").trim();
    expect(git.head()).toBe(head);
  });
});
