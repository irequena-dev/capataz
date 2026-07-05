# 06 — Prompt: Reviewer summaries and Arming protection line

Status: done
Depends-on: none
Verification: bun test tests/phase2/06-prompt-summaries.test.ts

Enrich the Executor prompt with the Reviewer's semantic summaries and the list of untouchable Arming files.

## Changes in `src/prompt.ts`

- `DoneSummary` gains optional `summary?: string` (the Reviewer's one-line "what now exists" for that Issue).
- Summary line rendering in `buildPrompt`:
  - with summary: `- <title>: <summary> (<files comma-joined>)`
  - without (mechanical fallback, current behaviour): `- <title>: <files comma-joined>`
- `BuildPromptOptions` gains optional `armingFiles?: string[]`. When present and non-empty, the prompt includes a hard section (near the framing, never dropped by the size cap) listing the armed test files with the instruction that modifying or deleting them fails the Issue automatically. Example shape:

  ```
  ## Armed tests (do not modify or delete)

  - tests/foo.test.ts
  - tests/bar.test.ts
  ```

- The size-capping behaviour (issue body never truncated, failures newest-first, summaries newest-first) is unchanged; the arming section counts toward the cap like the framing does (i.e. it is part of the fixed skeleton).

Do NOT touch anything under `tests/phase2/` — those are the armed tests for this plan. `bun test tests/prompt.test.ts` must stay green.

## Acceptance criteria

- Summary present → new line format; absent → old format (existing tests keep passing).
- `armingFiles` provided → the section lists every file; omitted or empty → no such section.
