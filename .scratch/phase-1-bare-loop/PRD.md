# PRD: Phase 1 — The bare loop

Status: ready-for-agent

## Goal

Prove the core hypothesis: a local small model (Executor via `claude-local`) can execute well-specified Issues unattended. Build the minimal Capataz that walks a hand-written Plan, dispatches Issues, verifies, commits, and reports.

## Background

See `CONTEXT.md` (glossary) and `docs/adr/0001`, `docs/adr/0002`. Design decisions from the 2026-07-01 grilling session.

## In scope

- TypeScript (Bun) CLI: `capataz run <plan-dir>` (plus `--issue <NN>` to run a single Issue).
- Config: `~/.config/capataz/config.yaml` global + `./capataz.yaml` project override. Declares Backends (command template, env, timeout) and a Role→Backend map. Phase 1 only uses the `executor` Role, but the schema covers all Roles.
- Plan loading: parse Issues (`Status:`, `Depends-on:`, `Verification:` fields), topological order by dependencies. Refuse to start if any non-done Issue lacks a Verification command.
- Git safety: refuse dirty working tree; create branch `capataz/<feature>` from HEAD; one commit per verified Issue; on final failure of an Issue, revert working tree to last good commit. Never push/merge.
- Dispatch: spawn the executor Backend non-interactively with a prompt = Issue body + mechanical state summary (titles + `git show --stat` of done Issues). Kill on timeout.
- Loop: verify via the Issue's Verification command (exit code). On failure: retry L1 up to `max_attempts` with the failure output appended, then mark `ready-for-human`, revert, and continue with non-dependent Issues.
- Budgets: per-Role timeout, max attempts per Issue, max `ready-for-human` escalations per run (abort run when exceeded).
- Observability: structured log per run under `<plan-dir>/runs/<timestamp>/` (every invocation: backend, duration, result, full Runner output); human `report.md`; live `Status:` updates in Issue files.

## Out of scope (later phases)

- Armorer/Arming, Reviewer (phase 2). Fixers L2/L3 (phase 3). Audit, ntfy (phase 4). `capataz plan` command (indefinitely — planning is a human+frontier interactive session).

## Success criteria

- A sample Plan of 3+ Issues against a toy repo completes AFK: branch created, one commit per Issue, `report.md` accurate.
- An Issue whose Verification always fails ends `ready-for-human` after `max_attempts`, tree reverted, independent Issues still executed.
- Run aborts when the escalation budget is exceeded.
