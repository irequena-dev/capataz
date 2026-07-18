# 03 — Loop: climb the Escalation ladder

Status: ready-for-agent
Depends-on: 01, 02
Verification: bun test tests/phase3/03-loop-escalation-ladder.test.ts

Replace the single "L1 exhausted → ready-for-human" step in `runLoop` with the
full ladder: L1 (Executor) → L2 (`fixer_l2`) → L3 (`fixer_l3`) →
`ready-for-human`.

## Rules (from the PRD)

- **Rungs**: L1 = Armorer+Executor sharing `budgets.attempts_l1` (current
  phase-2 semantics, today read from `max_attempts_per_issue`). L2 =
  `roles.fixer_l2` with `budgets.attempts_l2`. L3 = `roles.fixer_l3` with
  `budgets.attempts_l3`. An unconfigured fixer role skips its rung.
- **Global total**: every Armorer/Executor/Fixer invocation also consumes from
  `budgets.max_attempts_per_issue`; when it runs out mid-rung the Issue
  escalates `ready-for-human` immediately, without invoking the next rung.
- **Promotion**: on rung exhaustion (Verification red, Reviewer rejection, or
  timeout on its last attempt) promote to the next configured rung. Keep the
  working tree exactly as the failed attempt left it — no revert on promotion —
  and keep appending to the same `failures` history.
- **Fixer attempts**: prompt from `buildFixerPrompt` (issue 02); everything
  else is identical to an Executor attempt — the rogue-commit guard, the gate
  order (Verification → `suite_command` → mechanical Arming check → provisional
  commit → Reviewer), reject/soft-reset handling, and event emission.
- **Arming failures bypass the ladder**: when `armIssue` fails
  (red-on-arrival exhausted, no diff, timeouts), escalate `ready-for-human`
  directly as today. Fixers only ever see implementation failures.
- **`--no-judge`**: the ladder still climbs; fixer attempts skip the
  arming/reviewer gates exactly as executor attempts do.
- **Escalation to human**: unchanged mechanics (arming patch, hard reset,
  status restore, `max_escalations_per_run`).

## Events (`src/loop.ts` types)

- New: `{ type: "rung-promoted"; issue; from: "l1" | "l2"; to: "l2" | "l3"; attemptsUsed: number; at }`.
- `backend-result.role` union gains `"fixer_l2" | "fixer_l3"`.
- `issue-done` gains `resolvedBy: "l1" | "l2" | "l3"`.
- `attempt-started` gains `rung: "l1" | "l2" | "l3"`.

## Acceptance criteria

- An Issue L1 never solves but L2 does ends `done` with `resolvedBy: "l2"`,
  one arming commit and one implementation commit on the branch.
- Same with L2 also failing and L3 succeeding: `resolvedBy: "l3"`.
- No `fixer_l2` configured → L1 exhaustion emits `rung-promoted` to `l3`
  directly; no fixers configured → behaviour identical to phase 2 (existing
  loop/judge tests stay green untouched).
- Global cap mid-rung: with `max_attempts_per_issue` reached during L2, the
  Issue escalates without any L3 invocation.
- The first L2 prompt contains L1's failure history, and L1's partial work is
  in the tree when the L2 backend is invoked.
- A fixer that modifies the Arming triggers the mechanical violation exactly
  like an executor; a fixer rogue commit is contained by the guard.
- An arming failure never invokes any fixer backend.
