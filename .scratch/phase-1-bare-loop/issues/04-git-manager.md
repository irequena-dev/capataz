# 04 — Git safety manager

Status: ready-for-agent
Depends-on: 01
Verification: bun test tests/git.test.ts

Wrapper over the `git` CLI (subprocess, no library) operating on a target repo path:

- `assertClean()`: fail if working tree dirty or untracked files present.
- `createRunBranch(feature)`: `capataz/<feature>` from HEAD; fail if it already exists.
- `commitIssue(issue)`: stage all, commit `capataz: <NN>-<slug>`.
- `revertToLastGood()`: hard-reset tracked files + clean untracked, back to last commit.
- `diffStat(ref)`: files touched since ref (for the state summary).
- Never push, never merge, never touch config.

## Acceptance criteria

- Tests run against a temp fixture repo created in the test (no network).
- `revertToLastGood()` removes untracked junk created by a failed attempt.
