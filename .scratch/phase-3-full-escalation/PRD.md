# PRD: Phase 3 — Full Escalation

Status: ready-for-agent

## Goal

Complete the SOC-style Escalation ladder (design blueprint): when L1 (Executor) exhausts its attempts, a Fixer L2 repairs, then a Fixer L3, and only then does the Issue reach `ready-for-human`. Hypothesis: stronger models can rescue a stuck 9B without a human in the loop.

## Background

See `CONTEXT.md` (Fixer, Escalation), `docs/design.md`, `docs/adr/0001..0003`. Decisions from the 2026-07-18 grilling session:

1. **Per-rung budgets** in config, each independent, plus `max_attempts_per_issue` kept as a global total across the whole ladder.
2. **Rung inheritance**: a Fixer starts from the working tree of the last failed attempt (no revert on promotion) and receives the full accumulated failure history (size-capped) as feedback.
3. **Fixers are optional** in config: an unconfigured rung is skipped (L1 → L3, or L1 → human). Unlike Armorer/Reviewer they are an escalation improvement, not a safety gate.
4. **Arming failures bypass the ladder**: red-on-arrival exhausted or an Armorer that never produces a red Arming escalates `ready-for-human` directly — that is a plan/Armorer problem, not an implementation one.
5. **Identical gates at every rung**: each Fixer attempt passes Verification → `suite_command` → mechanical Arming check → provisional commit → Reviewer, exactly like an Executor attempt. The rogue-commit guard also applies.
6. **Orthogonal to the judge**: `--no-judge` runs still climb the ladder (without Arming/Reviewer gates, as in phase 1).

## In scope

- **Config**: new `budgets.attempts_l1` (required), `budgets.attempts_l2` and `budgets.attempts_l3` (optional, default 2). `attempts_l1` takes over the phase-2 semantics of the shared Armorer+Executor counter. `max_attempts_per_issue` becomes the global total across the whole ladder: when it runs out mid-rung the Issue escalates `ready-for-human` immediately. Config with `max_attempts_per_issue < attempts_l1` is invalid.
- **Ladder in the loop**: on L1 exhaustion (Verification red, Reviewer rejection, or timeout on the last L1 attempt), promote to `fixer_l2` if configured, else `fixer_l3`, else `ready-for-human`. Same from L2 to L3. Promotion keeps the working tree as-is; the failure history keeps accumulating across rungs.
- **Fixer prompt**: repair framing (not reimplementation): the Issue, its Verification command, the Arming files it must not touch, accumulated done-summaries, and the full failure history so far (tail-capped). States explicitly that a previous model left partial work in the tree and its job is to repair it until Verification is green.
- **Observability**: `rung-promoted` event (`from`, `to`, `issue`, `attemptsUsed`); `backend-result.role` gains `"fixer_l2" | "fixer_l3"`; `issue-done` records the resolving rung; `report.md` shows per Issue which rung resolved it and how many attempts each rung consumed.
- **Escalation to human**: unchanged mechanics (arming patch saved, hard reset, skip dependents, `max_escalations_per_run` counts only `ready-for-human`), it just happens after the ladder instead of after L1.

## Out of scope (later phases)

- Architect, Security Auditor, audit-generated Issues, ntfy (phase 4). `capataz plan`, daemon mode, parallel runs (deliberately unplanned).

## Success criteria

Against a toy repo:

- **L2 rescue**: an Issue that L1 never solves but L2 does ends `done`, with one arming commit and one implementation commit, and the report attributes it to `fixer_l2`.
- **L3 rescue**: same with L2 also failing; report attributes `fixer_l3`.
- **Skip rung**: with no `fixer_l2` configured, L1 exhaustion promotes straight to L3; with no fixers at all, phase-2 behaviour is reproduced exactly.
- **Global cap**: an Issue that hits `max_attempts_per_issue` mid-L2 escalates `ready-for-human` without invoking L3.
- **Inheritance**: the L2 prompt contains L1's failure history, and L1's partial work is present in the tree when L2 is invoked.
- **Arming bypass**: an arming failure never invokes a Fixer.
- **Gates hold at every rung**: a Fixer that touches the Arming is mechanically rejected; a Fixer rogue commit is contained.
