# 02 — Phase-2 code review nits

Status: needs-triage
Depends-on: none
Verification: bun test

Non-blocking findings from the phase-2 pre-merge review (standards axis).
All judgement calls; none affect behaviour covered by tests.

- **Duplicated Code**: `isTreeClean` exists in both `src/loop.ts` and
  `src/arming.ts`. `runVerification` was exported from the loop for reuse;
  export `isTreeClean` the same way (or move both spawn helpers to a small
  shared module).
- **Empty branch**: `src/loop.ts` has an `if (judged) { /* comment */ } else
  { doneSummaries.push(...) }` — invert the condition and drop the empty arm.
- **Report replay edge**: `renderReport` reads `event.judged` from
  `run-started`; replaying a phase-1 `events.jsonl` (no `judged` field) would
  falsely render the UNJUDGED banner. Default missing `judged` to `true`
  (or key the banner on `judged === false`). Only matters if a report-replay
  command ever exists.
- **Escalation containment duplicated**: the escalate-and-check-budget block
  appears in both the normal path and the infrastructure-failure catch in
  `runLoop`. Pre-existing phase-1 shape, now bigger; worth extracting when the
  loop next changes.
