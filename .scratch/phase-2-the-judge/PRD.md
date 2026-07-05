# PRD: Phase 2 — The judge

Status: ready-for-agent

## Goal

Prove the central bet (ADR 0002): the Armorer/Executor separation plus a Reviewer contains a small model's cheating. Add to the phase-1 loop: just-in-time Arming (ADR 0003), the red-on-arrival gate, a mechanical Arming-intact check, an optional full-suite regression gate, and the Reviewer verdict gate.

## Background

See `CONTEXT.md` (glossary), `docs/adr/0001..0003`, and `docs/design.md`. Decisions from the 2026-07-05 grilling session. Dogfooding: this Plan is executed by phase-1 capataz, so the Arming for these Issues is hand-written and pre-committed under `tests/phase2/`; each Issue's Verification runs only its own test file.

## In scope

- **Config**: `roles.armorer` and `roles.reviewer` become required (config without them is invalid). New optional top-level `suite_command` (string). CLI flag `capataz run <plan-dir> --no-judge` disables Armorer+Reviewer for that run only — the escape hatch never lives in config.
- **Issue field**: optional `Arming: none | auto` (default `auto`), set by the Planner, approved at the HITL gate. `none` skips the Armorer and the red-on-arrival gate for that Issue; Verification and Reviewer still apply.
- **Per-Issue flow (judged, `Arming: auto`)**:
  1. **Arm**: invoke the Armorer (prompt = Issue + Verification command + accumulated summaries + hard framing: failing tests only, no implementation). Require a non-empty diff, then run the Verification: exit 0 (green) → revert, retry the Armorer with feedback; red → commit `capataz: arming <NN>-<slug>`; the Arming file list = files of that commit.
  2. **Red-on-arrival exhausted** → escalate without dispatching the Executor.
  3. **Execute**: Executor attempts as in phase 1. Gates per attempt, cheap to expensive: Issue Verification → `suite_command` (if set) → mechanical Arming check → provisional commit → Reviewer.
  4. **Mechanical Arming check**: if the working diff touches (modifies/deletes) any Arming file, restore those files from HEAD, fail the attempt with explicit feedback. No LLM involved.
  5. **Reviewer**: judges the provisional commit's diff vs the Issue's acceptance criteria. Verdict contract on stdout: `VERDICT: approve|reject`, then `SUMMARY: <one line>` (approve) or `REASON: <why>` (reject). Last `VERDICT:` occurrence wins. Fail-closed: unparseable → one retry → reject. Reviewer is read-only: any working-tree dirt after its invocation is reverted (safe: executor work is already committed) and logged. Approve → commit stands, Issue done. Reject → `git reset --soft HEAD~1` (work stays in tree), REASON becomes feedback for the next attempt.
- **Budget**: one shared `max_attempts_per_issue` counter per Issue; every Armorer and Executor invocation consumes one attempt. Reviewer invocations do not (its one parse-retry is internal).
- **Escalation (armed Issue)**: hard-reset the branch to the commit before the Arming (the arming commit disappears from the branch), save the Arming as `arming-<NN>.patch` in the run directory, mark `ready-for-human`, continue with independent Issues. Safe because the branch is never pushed mid-run.
- **Prompts**: done-Issue summaries become the Reviewer's `SUMMARY` lines (`- <title>: <summary> (<files>)`), consumed by both Executor and Armorer prompts; mechanical fallback (title + files) when no summary exists. Executor prompt lists the Arming files it must not touch.
- **Observability**: new events (arming lifecycle, gate results, verdicts, violations, patches) in `events.jsonl`; `report.md` shows verdicts per Issue, arming outcomes, and a prominent `UNJUDGED RUN` banner when `--no-judge` was used; `arming-<NN>.patch` files written by the run log.

## Out of scope (later phases)

- Fixers L2/L3 and the full Escalation ladder (phase 3). Architect, Security Auditor, ntfy (phase 4). Distinguishing "red because assertions fail" from "red because tests don't compile" — the Escalation catches Armings broken enough to make an Issue impossible; measuring how often that happens is part of this phase's hypothesis.

## Success criteria

Against a toy repo (like phase 1):

- **Happy path**: a 3+ Issue plan completes AFK with two commits per Issue (arming + implementation); `report.md` reflects the Reviewer's verdicts and summaries.
- **Cheating contained**: an Issue whose easy path is editing the Arming gets mechanically rejected with feedback; either the Executor solves it without touching tests or it escalates. No diff that modifies the Arming is ever committed.
- **Red-on-arrival**: an Issue whose feature already exists (tests green at arming) escalates without dispatching the Executor.
- **Clean escalation**: an exhausted Issue leaves no arming commit on the branch, its patch is saved under `runs/<ts>/`, and independent Issues still run.
- **`--no-judge`**: reproduces phase-1 behaviour and the run is marked UNJUDGED.
- **Regression gate**: a red `suite_command` blocks the commit even when the Issue's own Verification is green.
