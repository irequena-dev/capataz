# 11 — Contain git and status-write failures inside the loop

Status: done
Depends-on: 06
Verification: bun test tests/loop.test.ts

Found in review: if `git.commitIssue()`, `git.revertToLastGood()` or `writeIssueStatus()` throws mid-run, the whole run crashes leaving inconsistent state (issue stuck `in-progress`, verified work uncommitted). An unattended loop must degrade, not die.

Changes:

- Wrap per-issue git operations and status writes in the loop: on failure, emit a structured `infrastructure-failure` event, attempt best-effort revert + mark `ready-for-human`, count it against `max_escalations_per_run`, and continue with independent issues.
- If even the containment fails (revert itself throws), abort the whole run with a distinct `aborted` reason — never an unhandled exception.
- No behavior change for the happy path; commit boundaries stay one-per-issue.

## Acceptance criteria

- Loop tests with a failing fake Git (commit throws; revert throws): first case escalates the issue and the run continues; second case aborts with the distinct reason. No test ends via unhandled exception.
- `events.jsonl` from a contained failure still parses line-by-line (report generation works on it).
