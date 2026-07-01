# 07 — Executor prompt assembly

Status: done
Depends-on: 04
Verification: bun test tests/prompt.test.ts

Build the prompt for one Issue dispatch:

- The issue body (self-contained spec).
- Mechanical state summary of done issues this run: `- <NN> <title>: <files from git diffStat>`, capped length.
- Hard framing: "Your job is ONLY this issue. Do not modify tests. Run `<verification>` yourself before finishing."
- On retries: previous attempt's verification output (tail-truncated).

## Acceptance criteria

- Pure function `buildPrompt(issue, doneSummaries, attemptFailures)` → string; snapshot tests.
- Total prompt size capped (config constant) — truncate summaries/failures oldest-first, never the issue body.
