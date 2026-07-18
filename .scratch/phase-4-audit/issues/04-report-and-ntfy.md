# 04 — Report Audit section + ntfy Notification

Status: done
Depends-on: 3
Verification: bun test tests/phase4/04-report-and-ntfy.test.ts

## Config (`src/config.ts`)

Optional top-level `notify` block:

```yaml
notify:
  ntfy_topic: capataz-runs   # required inside the block
  ntfy_server: https://ntfy.sh   # optional, default
```

Absent block → notifications disabled. No other keys.

## Notification (`src/notify.ts`)

`sendNotification(config.notify, summary)` POSTs to
`<ntfy_server>/<ntfy_topic>` at run end — ALWAYS (success, abort or
escalations), from the run summary: feature, issues done/escalated/skipped,
audit findings count and audit-Issue outcomes. Any failure (network, non-2xx)
emits a `notification-result` event with `ok: false` and never fails the run;
success emits `ok: true`. No `notify` config → no POST and no event. Fixed
10s timeout — a notification must never hold a run.

## Report (`src/report.ts`)

- New `## Audit` section: per auditor its outcome (ran, skipped, timed out,
  rogue edit), Findings emitted, and the resulting audit-Issues with their
  final state (`done` by which rung / escalated / `needs-triage`).
- Issue table marks audit-Issues (e.g. an `audit` marker column or suffix) so
  they are distinguishable from planned Issues.
- Runs without an Audit phase state why (escalations, unjudged, no auditors) in
  one line.
- Replay of pre-phase-4 `events.jsonl` (no audit/notification events) must
  still render — new sections degrade gracefully.

## Acceptance criteria

- Config with `notify.ntfy_topic` round-trips; `ntfy_server` defaults; block
  with unknown keys or missing topic fails to load naming the key.
- Run end with `notify` set POSTs once with the summary; server 500 → event
  `ok: false`, run still succeeds; no config → no POST.
- Report snapshot with a full Audit (findings, audit-Issues done and triaged).
- Phase-3 report snapshots unchanged except the one-line audit-skip note (or
  regenerate deliberately, stating why in the PR).
