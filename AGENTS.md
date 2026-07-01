Be concise. Sacrify grammar for the sake of concesion.

## Agent skills

### Issue tracker

Issues and PRDs live as local markdown files under `.scratch/<feature>/` — no external tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded on a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Design blueprint

Overall system design (roles, escalation, budgets, roadmap) lives in `docs/design.md`. Phase PRDs under `.scratch/` only cover their slice; read the blueprint first.

### Required global skills

This project assumes these skills are installed globally on the machine (not vendored here): `grilling`, `domain-modeling`, `tdd`, `grill-with-docs`, `to-prd`, `to-issue`, `improve-codebase-architecture`, `writing-great-skills`. Capataz-specific skills, when they exist, live in `.devin/skills/`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
Always write `CONTEXT.md` and `docs/adr/` in english.