# 08 — Run log and report

Status: done
Depends-on: 06
Verification: bun test tests/report.test.ts

Consume loop events (issue 06):

- Structured log under `<plan-dir>/runs/<ISO-timestamp>/`: one `events.jsonl` + per-invocation files with full runner stdout/stderr (gold for debugging why the local model got lost).
- `report.md` in the same dir: run outcome; table of issues (final status, attempts, duration, files touched); skipped issues and why; branch name and commit list.

## Acceptance criteria

- Report generated from events alone (pure function over event list) — snapshot tested.
- A crashed run still leaves a valid partial `events.jsonl` (append-only writes).
