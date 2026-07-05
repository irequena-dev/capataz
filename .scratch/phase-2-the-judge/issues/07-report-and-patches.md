# 07 — Report and run log: verdicts, UNJUDGED banner, arming patches

Status: done
Depends-on: 05
Verification: bun test

Surface the judge in the human-facing artifacts. Verification is the FULL suite: everything built in this plan must be green together.

## Changes in `src/report.ts`

### `renderReport`

- Issue table gains a `Verdict` column: `approved` / `rejected ×N then approved` style is not required — show the LAST `review-result` for the issue (`approve` / `reject`), `–` when none (unjudged or never reviewed).
- `run-started` with `judged: false` → a prominent banner right under the title:

  ```
  **UNJUDGED RUN** — Armorer and Reviewer were disabled with --no-judge.
  ```

- New `## Arming` section when any arming event exists: one line per issue — `armed (N files)`, `skipped (none)`, `skipped (no-judge)`, or `failed: <reason>`.
- Escalated section: when an `arming-patch` event exists for the issue, append `— arming saved to arming-<NN>.patch`.
- Rejected attempts: the last `review-result` with verdict `reject` for an escalated issue joins the failure reasons (so a human sees why the judge kept rejecting).

### `createRunLog`

- On `arming-patch` event: write the patch text to `<run-dir>/arming-<NN>.patch` (NN zero-padded).
- `backend-result` per-invocation files gain the role in the filename: `issue-<NN>-attempt-<N>-<role>.txt` (keep content format; role from the event, default `executor`).

Do NOT touch anything under `tests/phase2/` — those are the armed tests for this plan. All phase-1 report tests must stay green (`bun test tests/report.test.ts`), updated only if the `backend-result` filename change requires it.

## Acceptance criteria

- Report with judged events shows verdict column values and the Arming section.
- `judged: false` run-started produces the UNJUDGED banner; judged runs never show it.
- `arming-patch` event → patch file exists in the run dir with the exact patch text; escalated line references it.
- Full `bun test` green (this is the Verification).
