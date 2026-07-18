# 03 — Loop: the Audit phase

Status: done
Depends-on: 1, 2
Verification: bun test tests/phase4/03-loop-audit-phase.test.ts

Wire the Audit phase into `src/loop.ts` after the main issue walk.

## Trigger

Enter the Audit only when ALL hold, else skip silently to run end:

- every Issue of the Plan ended `done` (any escalation, skip or abort → no
  Audit),
- judged run (`--no-judge` skips the Audit),
- at least one of `roles.architect` / `roles.security_auditor` is configured
  (unconfigured roles are skipped individually, like the Fixers).

## Auditor invocations

Sequential: Architect first (if configured), then Security Auditor.
Per auditor:

1. Build the prompt with `buildAuditPrompt` (issue 02) from the PRD and
   `git diff <base>..HEAD` of the run branch; emit `audit-input-truncated`
   when capped.
2. Record HEAD before invoking. After the invocation, if the tree is dirty or
   HEAD moved: hard-reset working tree and HEAD to the pre-invocation state and
   emit `rogue-audit-edit` (harder than the Executor's rogue-commit guard:
   auditor edits are discarded by definition). Findings are parsed from the
   invocation output, never from the tree.
3. `parseFindings` (issue 01); emit `finding-emitted` per Finding. A timeout or
   crash of one auditor emits its `auditor-result` and continues with the next
   auditor (the Audit is best-effort, never an infrastructure failure for the
   run).

## Dispatch

- `writeAuditIssues` with `budgets.max_audit_issues` (cap shared across both
  auditors, emission order; Architect runs first so its Findings are
  prioritised). Emit `audit-issue-written` per file.
- Dispatchable audit-Issues run through the EXISTING issue loop unchanged:
  Arming, Verification, `suite_command`, Reviewer, full Escalation ladder,
  same commit conventions. Their `ready-for-human` escalations count against
  `max_escalations_per_run` (abort applies).
- Single pass: after the audit-Issues finish, the run ends — no re-audit.

## Events

New: `audit-started`, `auditor-result` (role, backend, kind, exitCode,
durationMs, stdout, stderr), `finding-emitted` (auditor, title, dispatchable),
`audit-issue-written` (issue, auditor, status), `rogue-audit-edit` (role, from,
to), `audit-input-truncated` (role). Extend existing issue events untouched —
audit-Issues reuse them (the report distinguishes them by number — issue 04).

## Acceptance criteria

- Full-pass run invokes both auditors sequentially, writes and dispatches
  audit-Issues, ends `done`.
- Escalated run, unjudged run, and no-auditor config never emit `audit-started`.
- Auditor that edits/commits is reset (tree clean, HEAD restored) with
  `rogue-audit-edit`, and its Findings still dispatch.
- Findings beyond the cap or without Verification are written `needs-triage`
  and never dispatched.
- An audit-Issue that exhausts the ladder escalates `ready-for-human` and
  counts against `max_escalations_per_run`.
- One auditor timing out does not prevent the other from running.
