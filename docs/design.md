# Capataz — Design blueprint

Source of truth for the overall system design, agreed in the 2026-07-01 grilling session. Vocabulary: `CONTEXT.md`. Foundational decisions: `docs/adr/`. Per-phase scope: each phase's PRD under `.scratch/`.

## What it is

AFK development orchestrator. A frontier model plans a task into a Plan (PRD + self-contained Issues); Capataz executes the Plan unattended by dispatching each Issue to a small local model, verifying, committing, and escalating failures up a ladder of stronger models. TypeScript, run with Bun.

## The flow

```
human + Planner (interactive: grilling → to-prd → to-issue)
        → Plan in .scratch/<feature>/          ← human approves (HITL gate)
capataz run <plan-dir>                         ← 100% unattended from here
        → per Issue, in dependency order:
            Armorer writes red tests (the Arming), committed just-in-time before dispatch
            Executor implements → Verification (command exit code)
            → Reviewer judges diff vs acceptance criteria (rejects if Arming touched)
            → green+approved: commit, next
            → failure: Escalation ladder
        → Audit phase: Architect + Security Auditor read full branch diff
            → findings become new Issues (auditors never edit code)
        → report.md + notification; human merges the branch (never Capataz)
```

## Roles → default Backends

Roles are functions; Backends (command+model+env) are assigned per Role in config and swappable (`~/.config/capataz/config.yaml`, project override `./capataz.yaml`).

| Role             | Responsibility                                    | Default backend            |
| ---------------- | ------------------------------------------------- | -------------------------- |
| Planner          | task → PRD + Issues (prose criteria, no code)     | Devin CLI (`devin -p --model X`) |
| Armorer          | criteria → red tests (Arming), pre-dispatch       | `claude-glm` (GLM via z.ai) |
| Executor         | turn armed tests green; may not touch Arming      | `claude-local` (Ornith @ unsloth studio, localhost:8888) |
| Reviewer         | approve/reject Issue diff; emits one-line "what now exists" summary | `claude-glm` |
| Fixer L2         | repair after L1 retries exhausted                 | `claude-glm`               |
| Fixer L3         | repair after L2 fails                             | Devin CLI                  |
| Architect        | per-Plan architecture audit (improve-codebase-architecture) → findings | `claude-glm` |
| Security Auditor | per-Plan vuln audit (auth bypass, IDOR, XSS, secrets) → findings | `claude-glm` |

## Escalation (SOC ladder)

Failure = Verification red, Reviewer rejection, or timeout.
L1 Executor retries (with failure feedback) → Fixer L2 → Fixer L3 → `ready-for-human` + revert to last good commit + skip transitive dependents, continue independents.

## Budgets (config, enforced from day 1)

1. Timeout per Role invocation.
2. Max attempts per Issue across the whole ladder.
3. Max `ready-for-human` escalations per run → abort run.
4. Cap on Audit-generated Issues.

## Git contract

Branch `capataz/<feature>` per Plan; refuse dirty tree; per Issue two commits: Arming first, then the verified+reviewed implementation (checkpoints); never push/merge — a run always ends as "branch + report", merging is human.

## Executor context (anti-lost design for a 9B)

Issue must be self-contained (Planner quality bar: "an Issue that needs the PRD to be understood is badly written"). Prompt = Issue body + accumulated Reviewer summaries ("what exists now and where") + hard framing (only this Issue, don't touch tests, run Verification yourself). Reviewer gets Issue + diff + criteria. Capped prompt sizes.

## Observability

Per run: `<plan-dir>/runs/<ts>/` with `events.jsonl` + full runner outputs per invocation; human `report.md` (issue table, who resolved what at which rung, audit findings); live `Status:` lines in Issue files; optional ntfy.sh push on completion.

## Docs ownership

CONTEXT.md / AGENTS.md / ADRs are produced by human grilling sessions, never by the pipeline.

## Roadmap

| Phase | Adds | Hypothesis it validates |
| ----- | ---- | ----------------------- |
| 1 — bare loop (`.scratch/phase-1-bare-loop/`) | run loop, config, git, verify, commit, retry L1 → ready-for-human, report | can Ornith execute well-specified Issues? |
| 2 — the judge | Reviewer + Armorer/Arming | does test-writer/implementer separation contain a 9B's cheating? |
| 3 — full Escalation | Fixers L2/L3 + full budget ladder | |
| 4 — Audit | Architect + Security Auditor + ntfy | |

Deliberately unplanned: `capataz plan` command (planning stays a human+frontier interactive session); daemon mode; parallel runs (would need worktrees).
