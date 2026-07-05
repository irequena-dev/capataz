# 13 — Spec alignment: exit code, diffStat, done-issue Verification

Status: done
Depends-on: 09
Verification: bun test

Three small divergences between implementation and spec found in review:

1. **Exit code** (`src/cli.ts`): spec says exit 0 "only if no escalations"; implementation also requires `skipped === 0`. Align to the spec: `result.kind === "completed" && escalated === 0`. Add a test for a `--issue NN` run where other issues remain pending → exit 0.
2. **`diffStat`** (`src/git.ts`): PRD asks for `git show --stat`-style summaries; implementation uses `--name-only`. Return per-file entries including line-change counts (parse `git show --stat` output); update `src/prompt.ts` formatting and its snapshot accordingly.
3. **Verification requirement scope** (`src/issue.ts` / `src/plan.ts`): spec exempts `done` issues from requiring `Verification:`. Parser: missing Verification on a `done` issue is valid (field optional in the type). Plan loader: enforce "every non-done issue has a Verification command" and keep reporting all problems in one pass. Add both test cases.

## Acceptance criteria

- The three behaviors above, each with a test.
- Full suite green; no other behavior changes.
