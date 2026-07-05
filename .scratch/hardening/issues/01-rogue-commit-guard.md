# 01 — Loop: contain runner-made commits (rogue commit guard)

Status: needs-triage
Depends-on: none
Verification: bun test

Found during the phase-2 run: the Issue-03 executor ran `git commit` itself
(dangerous permission mode). Capataz's own `commitIssue` then failed with
"nothing to commit" (exit 1, empty stderr) and a green, verified Issue was
escalated as an infrastructure failure. The framing now forbids git usage
(prompt-level fix, commit 0cbd442), but nothing mechanical enforces it.

## Proposal

- Record `git.head()` before each backend invocation (executor, armorer,
  reviewer). After it returns, if HEAD moved, the runner committed on its own:
  `git.resetHardTo(<pre-invocation head>)` keeps nothing? — no: soft-handle it.
  Options to weigh at triage:
  1. Hard containment: `resetHardTo` the pre-invocation head, fail the attempt
     with feedback ("you ran git commit; capataz owns version control").
  2. Tolerant: `git reset --soft <pre>` to un-commit but keep the work, then
     proceed with the normal gates (verification, arming check, review).
- `revertToLastGood` (`reset --hard HEAD`) does not undo rogue commits; any
  guard must use the recorded pre-invocation head, not HEAD.
- Also consider making `commitIssue` distinguish "nothing to commit" (stdout,
  exit 1) from real git failures so a stray no-op never reads as an
  infrastructure failure.

## Acceptance criteria

- A fake executor that commits its own work no longer causes an escalation:
  either the attempt fails with the guard feedback (option 1) or the work is
  re-gated and lands as a normal capataz commit (option 2).
- A fake executor that commits AND leaves the tree dirty is also contained.
- Existing loop/judge tests stay green.
