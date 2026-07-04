# 10 — Timeout and output cap for Verification commands

Status: done
Depends-on: 06
Verification: bun test tests/loop.test.ts

Found in review: `runVerification()` in `src/loop.ts` has no timeout — a hanging Verification command freezes an unattended run forever (worst AFK failure mode). Its output is also unbounded.

Changes:

- Add `verification_timeout_minutes` to the `budgets` config section (zod schema in `src/config.ts`, positive number, sensible default so existing configs stay valid).
- `runVerification()` spawns in its own process group and kills the whole tree on expiry (same technique as `src/invoker.ts`), returning a result that the loop treats as a red attempt with a clear `verification timed out after Nm` failure output.
- Cap captured verification output (e.g. 1 MB, keep the TAIL — the end of test output is the informative part) before storing/appending to retry prompts.

## Acceptance criteria

- Loop test: an issue whose Verification is `sleep 60` with a sub-second timeout override becomes a red attempt, retries, and escalates normally — the run never hangs.
- Timeout appears in events and report as the failure reason.
- Output cap test: multi-MB verification output is truncated tail-first to the cap.
