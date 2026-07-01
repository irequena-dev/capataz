# 03 — Plan loader and dependency ordering

Status: ready-for-agent
Depends-on: 02
Verification: bun test tests/plan.test.ts

Load a plan directory: PRD.md + all issue files. Produce an execution order via topological sort of `Depends-on`. Validate before any execution:

- Every non-`done` issue has a Verification command.
- No dependency cycles, no references to missing issue numbers.
- Only `ready-for-agent` issues are executable; `done` issues satisfy dependencies; anything else blocks its dependents.

## Acceptance criteria

- Validation reports ALL problems in one pass with issue numbers.
- Given issues 1←2←3 and 4 independent, order is [1,2,3,4] or interleaved but dependency-respecting.
- `blockedBy(issue)` helper: returns transitive incomplete dependencies (used later to skip dependents of a failed issue).
