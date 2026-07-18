export interface Git {
  /** Fail if the working tree has modifications or untracked files. */
  assertClean(): void;
  /** Create and check out `capataz/<feature>` from HEAD; fail if it exists. */
  createRunBranch(feature: string): void;
  /** Stage all changes and commit as `capataz: <NN>-<slug>`. */
  commitIssue(issue: { number: number; slug: string }): void;
  /** Hard-reset tracked files and clean untracked ones, back to last commit. */
  revertToLastGood(): void;
  /** Per-file change summaries (`path (+added/-deleted)`) between `ref` and HEAD. */
  diffStat(ref: string): string[];
  /** Current commit hash. */
  head(): string;
  /** Stage all changes and commit as `capataz: arming <NN>-<slug>`. */
  commitArming(issue: { number: number; slug: string }): void;
  /** Stage all changes and commit as `capataz: audit issues`; no-op when clean. */
  commitAudit(): void;
  /** File paths touched by a single commit. */
  filesInCommit(ref: string): string[];
  /** Hard-reset to `ref` and clean untracked files. */
  resetHardTo(ref: string): void;
  /** Restore `paths` from `ref`; no-op on empty `paths`. */
  restoreFiles(ref: string, paths: string[]): void;
  /** Uncommit the last commit, keeping its changes in the tree and index. */
  softResetLast(): void;
  /** Uncommit every commit back to `ref`, keeping all changes in the tree and index. */
  softResetTo(ref: string): void;
  /** Full patch text between `fromRef` and `toRef`. */
  diffPatch(fromRef: string, toRef: string): string;
}

export function createGit(repoPath: string): Git {
  function run(...args: string[]): string {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repoPath });
    if (proc.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
      );
    }
    return proc.stdout.toString();
  }

  return {
    assertClean() {
      const status = run("status", "--porcelain").trim();
      if (status !== "") {
        throw new Error(
          `Working tree is dirty (commit or stash before running capataz):\n${status}`,
        );
      }
    },

    createRunBranch(feature) {
      const branch = `capataz/${feature}`;
      const exists =
        Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
          cwd: repoPath,
        }).exitCode === 0;
      if (exists) {
        throw new Error(`Branch ${branch} already exists`);
      }
      run("checkout", "-b", branch);
    },

    commitIssue(issue) {
      const id = `${String(issue.number).padStart(2, "0")}-${issue.slug}`;
      run("add", "-A");
      // A clean index here means the work is already committed (e.g. a rogue
      // runner commit that the loop's guard couldn't un-stage): a no-op, not an
      // infrastructure failure.
      const staged = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repoPath });
      if (staged.exitCode === 0) return;
      run("commit", "-m", `capataz: ${id}`);
    },

    revertToLastGood() {
      run("reset", "--hard", "HEAD");
      run("clean", "-fd");
    },

    diffStat(ref) {
      return run("diff", "--numstat", ref, "HEAD")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [added, deleted, ...rest] = line.split("\t");
          const path = rest.join("\t");
          if (added === "-" || deleted === "-") return `${path} (binary)`;
          return `${path} (+${added}/-${deleted})`;
        });
    },

    head() {
      return run("rev-parse", "HEAD").trim();
    },

    commitArming(issue) {
      const id = `${String(issue.number).padStart(2, "0")}-${issue.slug}`;
      run("add", "-A");
      run("commit", "-m", `capataz: arming ${id}`);
    },

    commitAudit() {
      run("add", "-A");
      const staged = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repoPath });
      if (staged.exitCode === 0) return;
      run("commit", "-m", "capataz: audit issues");
    },

    filesInCommit(ref) {
      return run("diff-tree", "--no-commit-id", "--name-only", "-r", ref)
        .split("\n")
        .filter((line) => line.trim() !== "");
    },

    resetHardTo(ref) {
      run("reset", "--hard", ref);
      run("clean", "-fd");
    },

    restoreFiles(ref, paths) {
      if (paths.length === 0) return;
      run("checkout", ref, "--", ...paths);
    },

    softResetLast() {
      run("reset", "--soft", "HEAD~1");
    },

    softResetTo(ref) {
      run("reset", "--soft", ref);
    },

    diffPatch(fromRef, toRef) {
      return run("diff", fromRef, toRef);
    },
  };
}
