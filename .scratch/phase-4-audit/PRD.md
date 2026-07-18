# PRD: Phase 4 — Audit

Status: done

## Goal

Close the roadmap (design blueprint): once a run finishes with every Issue `done`, an Audit phase has the Architect and the Security Auditor read the branch's full diff, emit Findings, and Capataz converts them into audit-Issues that are dispatched through the normal loop in the same run — then a best-effort ntfy Notification reports the outcome. Hypothesis: a final read-only pass by stronger models catches what per-Issue review misses, without breaking AFK mode.

## Background

See `CONTEXT.md` (Audit, Finding, audit-Issue, Notification), `docs/design.md`, `docs/adr/0001..0003`. Decisions from the 2026-07-18 grilling session:

1. **Auto-dispatch, single pass**: audit-Issues enter the loop in the same run (full gates: Arming, Verification, `suite_command`, Reviewer, Escalation ladder). The Audit runs exactly once — fixes of audit-Issues are not re-audited.
2. **Auditor proposes the Verification**: each Finding carries title, description, acceptance criteria and a proposed Verification command. A Finding without a valid Verification is written as a `needs-triage` issue file and never dispatched — nobody else invents a Verification at runtime.
3. **Audit only on full success**: the Audit phase is entered only when every Issue in the Plan ended `done`. Escalations to human or a run abort skip the Audit. Auditors run sequentially (Architect, then Security Auditor); parallelism stays deliberately out of scope.
4. **Normal budgets apply**: audit-Issues climb the full Escalation ladder like any Issue; their `ready-for-human` escalations count against `max_escalations_per_run`; Findings beyond `max_audit_issues` are written `needs-triage` (in emission order) — never discarded.
5. **Mechanical read-only guard**: after each auditor invocation, if the working tree is dirty or HEAD moved, hard-reset to the pre-invocation state and emit a `rogue-audit-edit` event. Findings are read from the auditor's output, not the tree, so nothing is lost.
6. **Notification is best-effort**: optional `notify.ntfy_topic` (+ optional `notify.ntfy_server`, default `https://ntfy.sh`). Sent whenever a run ends — success, abort or escalations — with a summary (issues done/escalated, audit findings). A failed push is a warning event, never a run failure.
7. **Optional roles, skipped in unjudged runs**: `roles.architect` and `roles.security_auditor` are optional with individual skip (like the Fixers); with neither configured there is no Audit phase. `--no-judge` runs skip the Audit entirely.
8. **Capped auditor input**: the auditor prompt is the Plan's PRD plus the branch's full diff, tail-truncated to the prompt cap, with an `audit-input-truncated` event when capped.

## In scope

- **Findings** (`src/audit.ts`): structured Finding format the auditors must emit, parser from auditor output, conversion into audit-Issue markdown files in the Plan's issues dir (numbered after the existing Issues), applying the `max_audit_issues` cap and the invalid-Verification → `needs-triage` fallback.
- **Auditor prompts** (`src/prompt.ts`): `buildAuditPrompt(role, prd, diff)` — read-only framing, the Finding output contract, PRD + full branch diff (tail-capped).
- **Audit phase in the loop** (`src/loop.ts`): trigger condition (all `done`, judged run, ≥1 auditor role configured), sequential auditor invocations with the read-only guard, dispatch of the generated audit-Issues through the existing issue loop, single pass.
- **Notification + report** (`src/notify.ts`, `src/report.ts`): ntfy push on run end with summary; report gains an `## Audit` section (findings per auditor, resulting audit-Issues and their outcome) and marks audit-Issues in the issue table.
- **Config** (`src/config.ts`): optional `notify` block. `max_audit_issues`, `roles.architect`, `roles.security_auditor` already exist.
- **Observability**: new events `audit-started`, `auditor-result`, `finding-emitted`, `audit-issue-written`, `rogue-audit-edit`, `audit-input-truncated`, `notification-result`.

## Out of scope

- Re-audit loops; auditing partial runs; parallel auditors; `capataz plan`; daemon mode; parallel runs (deliberately unplanned).

## Success criteria

Against a toy repo:

- **Full pass**: a run whose Issues all end `done` invokes Architect then Security Auditor, writes their Findings as audit-Issues, dispatches them through the loop (arming commit + implementation commit each), and the report attributes them to the Audit.
- **Skip conditions**: a run with an escalation, an unjudged run, or a config without auditor roles never enters the Audit.
- **Cap and fallback**: with `max_audit_issues: 1` and two Findings, the second is written `needs-triage` and not dispatched; a Finding without valid Verification likewise.
- **Read-only guard**: an auditor that edits files or commits is hard-reset and `rogue-audit-edit` is emitted; its Findings still convert.
- **Single pass**: an audit-Issue whose fix would itself trigger a Finding is not re-audited.
- **Notification**: with `notify.ntfy_topic` set, run end POSTs a summary; a failing ntfy server produces a warning event and the run still succeeds. Without `notify`, no push and no warning.
