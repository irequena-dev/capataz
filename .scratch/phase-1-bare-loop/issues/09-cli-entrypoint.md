# 09 — CLI entrypoint and end-to-end smoke

Status: ready-for-agent
Depends-on: 06, 07, 08
Verification: bun test tests/e2e.test.ts

Wire it together: `capataz run <plan-dir> [--issue NN] [--repo <path>]` (repo defaults to cwd). Sequence: load config → load+validate plan → git assertClean + createRunBranch → loop → write report → print summary + report path, exit code 0 only if no escalations.

## Acceptance criteria

- E2E test: temp git repo + 3-issue toy plan + fake backend script that writes the file each issue asks for → run ends with 3 commits on `capataz/<feature>`, all issues `done`, report matches.
- E2E failure test: fake backend that ignores issue 2 → issue 2 `ready-for-human`, its dependent skipped, independent issue 3 done, exit code non-zero.
- `--issue NN` runs exactly one issue (deps must already be `done`).
