# 01 — Scaffold Bun project and config loading

Status: done
Depends-on: none
Verification: bun test tests/config.test.ts

Scaffold the Bun + TypeScript project (`bun init`, strict tsconfig, `bun test`). Implement config loading with zod validation:

- Global `~/.config/capataz/config.yaml`, deep-merged with project-level `./capataz.yaml` (project wins).
- Schema: `backends` (name → `{ command: string[], env: Record<string,string>, timeout_minutes: number }`), `roles` (planner|armorer|executor|reviewer|fixer_l2|fixer_l3|architect|security_auditor → backend name), `budgets` (`max_attempts_per_issue`, `max_escalations_per_run`, `max_audit_issues`).
- Only `executor` role is required in phase 1; others optional.

## Acceptance criteria

- Invalid config (unknown role, missing executor backend, negative budget) fails with a clear error naming the offending key.
- Project override replaces individual keys, not whole sections.
- Exported typed `loadConfig(cwd)` used by later issues.
