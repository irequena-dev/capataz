# 06 — The run loop

Status: ready-for-agent
Depends-on: 03, 04, 05
Verification: bun test tests/loop.test.ts

The state machine, using a fake backend in tests. Per issue in dependency order:

1. Mark `in-progress`. Build prompt (issue body + state summary, see issue 07).
2. Invoke executor backend. Run Verification command (subprocess, exit code).
3. Green → commit → mark `done`.
4. Red/timeout → retry up to `budgets.max_attempts_per_issue`, appending the verification/runner failure output to the prompt.
5. Attempts exhausted → `revertToLastGood()`, mark `ready-for-human`, skip all transitive dependents (leave them `ready-for-agent`, record as `skipped` in the run result).
6. If `ready-for-human` count exceeds `budgets.max_escalations_per_run` → abort run.

## Acceptance criteria

- Issue states as discriminated unions; no stringly-typed transitions.
- Scenario tests: all-green run; one always-red issue with independent survivor; escalation-budget abort.
- Loop emits structured events (issue started/attempt/verified/committed/escalated/skipped) consumed by issue 08.
