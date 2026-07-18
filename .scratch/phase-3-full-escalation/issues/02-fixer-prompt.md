# 02 — Fixer prompt: repair framing

Status: done
Depends-on: none
Verification: bun test tests/phase3/02-fixer-prompt.test.ts

Build the prompt a Fixer receives when an Issue is promoted to its rung. A
Fixer repairs the partial work a weaker model left in the tree; it never
reimplements from scratch and never touches the Arming.

## New export in `src/prompt.ts`

`buildFixerPrompt(issue, doneSummaries, failures, options)` with the same
argument shapes as `buildPrompt` (`options.armingFiles: string[]`), returning a
string with:

- Hard framing: you are a Fixer; a previous model attempted this Issue and
  failed; its partial work is already in the working tree — repair it until the
  Verification command passes. Work only on this Issue. Never modify or delete
  the armed test files (list them). Run the Verification yourself before
  finishing. Do not run git; capataz owns version control.
- The Issue title and body, and its Verification command.
- Accumulated done-summaries of this run (same rendering as `buildPrompt`).
- The full failure history so far (all rungs), rendered like `buildPrompt`'s
  failure feedback and tail-capped with the existing prompt-size cap mechanism
  so the newest failures survive truncation.

Reuse the existing private helpers in `src/prompt.ts` (summary rendering,
capping) rather than duplicating them.

## Acceptance criteria

- The prompt contains the repair framing, the Issue body, the Verification
  command, every armed file name, and every failure block (when under the cap).
- With an oversized failure history the output stays within the existing cap
  and keeps the most recent failure.
- No arming files → no "do not touch" list, framing still present.
- `buildPrompt` output is unchanged (snapshot tests in
  `tests/__snapshots__/prompt.test.ts.snap` still pass).
