# 04 — Report: attribute Issues to the rung that resolved them

Status: done
Depends-on: 03
Verification: bun test tests/phase3/04-report-ladder.test.ts

Surface the ladder in `report.md` so a human can see at a glance who resolved
what at which rung (design blueprint, Observability).

## Changes in `src/report.ts`

- The Issues table gains a `Resolved by` column: `l1` / `l2` / `l3` from
  `issue-done.resolvedBy`, `–` for escalated/skipped rows. Older events without
  the field default to `l1`.
- New `## Escalation ladder` section, rendered only when at least one
  `rung-promoted` event exists: one line per promotion,
  `- <issue title>: l1 → l2 (after N attempts)`.
- The `## Escalated` section lines mention the last rung reached before
  `ready-for-human` (e.g. `— exhausted l3`), derived from `rung-promoted`
  events; no promotions means l1, as today.
- `createRunLog` needs no changes beyond what the new events already get for
  free (`events.jsonl` append, per-invocation output files keyed by role —
  verify `fixer_l2`/`fixer_l3` invocation files are written with the role in
  the filename).

## Acceptance criteria

- A replayed event list where issue 1 resolves at l2 and issue 2 at l1 renders
  `l2` and `l1` in the `Resolved by` column and one ladder line for issue 1.
- A phase-2 event list (no `resolvedBy`, no promotions) renders `l1` everywhere
  and no `## Escalation ladder` section; existing report snapshots stay valid
  or are regenerated deliberately.
- An escalated Issue that reached l3 shows `exhausted l3` in `## Escalated`.
- A `backend-result` with role `fixer_l2` produces
  `issue-NN-attempt-N-fixer_l2.txt` in the run dir.
