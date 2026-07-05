# 05 — Loop: judged flow integration

Status: done
Depends-on: 01, 02, 03, 04, 06
Verification: bun test tests/phase2/05-loop-judge.test.ts

Wire arming, gates and reviewer into `runLoop`. This is the heart of phase 2.

## Deps and events (`src/loop.ts`)

- `RunLoopDeps` gains `noJudge?: boolean` (default false).
- `run-started` event gains `judged: boolean` (`!noJudge`).
- `backend-result` event gains `role: "executor" | "armorer" | "reviewer"` (phase-1 emissions use `"executor"`).
- New events:
  - `{ type: "arming-started"; issue; at }`
  - `{ type: "arming-committed"; issue; commit; files: string[]; at }`
  - `{ type: "arming-failed"; issue; reason: string; at }`
  - `{ type: "arming-skipped"; issue; reason: "none" | "no-judge"; at }`
  - `{ type: "suite-result"; issue; attempt; command: string; exitCode: number; output: string; at }`
  - `{ type: "arming-violation"; issue; attempt; files: string[]; at }`
  - `{ type: "review-result"; issue; attempt; verdict: "approve" | "reject"; summary?: string; reason?: string; at }`
  - `{ type: "reviewer-dirty-tree"; issue; attempt; at }`
  - `{ type: "arming-patch"; issue; patch: string; at }`
- All events must stay JSON-serialisable (JSONL round-trip).

## Judged flow per Issue (`noJudge` false)

Let `pre = git.head()` before anything.

1. **Arm** (skip if `issue.arming === "none"` → emit `arming-skipped`): call `armIssue` with the armorer backend from config and `maxAttempts = budgets.max_attempts_per_issue`. Its `attemptsUsed` counts against the Issue's shared attempt budget. Emit `arming-started`, per-invocation `backend-result` (role `armorer` — pass an emitting wrapper or emit from the loop), then `arming-committed` or `arming-failed`.
   - `failed` → escalate the Issue immediately (no Executor dispatch): same containment as phase-1 escalation (revert, status `ready-for-human`, count escalation, budget check). No arming commit exists, so no reset/patch needed.
2. **Execute**: while shared attempts remain:
   1. Executor invocation (prompt via `buildPrompt` with `armingFiles` option and accumulated failures/summaries).
   2. Issue Verification (as today) → red: failed attempt.
   3. `suite_command` (if configured): run with the same verification runner; emit `suite-result`; red: failed attempt with its output as feedback prefixed so the Executor knows the full suite broke, not its Issue tests.
   4. Mechanical Arming check: changed/deleted files vs HEAD (`git diff --name-only HEAD` semantics) intersected with the arming file list. Non-empty → `git.restoreFiles("HEAD", armingFiles)`, emit `arming-violation`, failed attempt with feedback naming the violated files.
   5. Provisional commit: `git.commitIssue(issue)`.
   6. Reviewer: diff = `git.diffPatch(<commit before provisional>, "HEAD")`; call `reviewIssue`. After the invocation, if `git status --porcelain` is non-empty → `git.revertToLastGood()` + emit `reviewer-dirty-tree` (safe: executor work is committed).
      - Approve → emit `review-result`, Issue done: status `done` was already written pre-commit as in phase 1 — keep the current write-status-then-commit order so the status rides the provisional commit; record the summary into `doneSummaries` (`summary` field).
      - Reject → emit `review-result`, `git.softResetLast()` (work stays in tree), failed attempt with the REASON as feedback.
   - Note the status-file ordering: in phase 1 `Status: done` is written before `commitIssue`. Keep that, but a rejected provisional commit un-commits that status write; restore the issue file to `in-progress` after `softResetLast` so the tree reflects reality.
3. **Escalation of an armed Issue** (attempts exhausted or arming check unfixable): compute `patch = git.diffPatch(pre, <arming commit>)`, emit `arming-patch`, then `git.resetHardTo(pre)` instead of `revertToLastGood` (drops the arming commit). Then the usual containment: statuses, escalation count, budget check. Re-write `ready-for-human` statuses of previously escalated issues (they may have been wiped by the reset, as phase 1 already does after reverts).

## Unjudged flow (`noJudge` true)

Exactly phase-1 behaviour: no armorer, no reviewer, no suite gate? — NO: `suite_command` still applies (it is mechanical, not part of the judge). Emit `arming-skipped` with reason `"no-judge"` per issue. `run-started.judged` is false.

## Infrastructure failures

Git/status errors keep the phase-1 containment (degrade to `ready-for-human`, never throw out of the loop), using `resetHardTo(pre)` when an arming commit exists.

Do NOT touch anything under `tests/phase2/` — those are the armed tests for this plan. `bun test tests/loop.test.ts` must stay green (update only its config fixtures if issue 01's schema change requires it and that was not already done).

## Acceptance criteria

Covered by `tests/phase2/05-loop-judge.test.ts`: happy path (two commits per issue, right order, verdict recorded), cheating contained (violation → restore → feedback → recovery), reject-then-approve with REASON feedback, red-on-arrival escalation without executor dispatch, clean escalation (no arming commit left, patch event emitted), `Arming: none` skips armorer, `--no-judge` reproduces phase 1, suite gate blocks commit, reviewer dirty tree reverted.
