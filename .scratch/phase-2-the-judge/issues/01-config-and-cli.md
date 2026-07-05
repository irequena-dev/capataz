# 01 — Config: mandatory judge roles, suite_command, --no-judge flag

Status: ready-for-agent
Depends-on: none
Verification: bun test tests/phase2/01-config-and-cli.test.ts

Make the judge roles mandatory in config and add the per-run escape hatch.

## Changes in `src/config.ts`

- `RolesSchema`: `armorer` and `reviewer` become required strings (like `executor`). `planner`, `fixer_l2`, `fixer_l3`, `architect`, `security_auditor` stay optional.
- `ConfigSchema`: new optional top-level key `suite_command` (string). It is a project-level regression command (e.g. `bun test`) run after an Issue's own Verification; absent means no full-suite gate.
- The existing role→backend existence check must keep covering the new required roles (it already iterates all roles).

## Changes in `src/cli.ts`

- Export `parseArgs` (currently private) so it is unit-testable.
- `CliArgs` gains `noJudge: boolean`. New flag `--no-judge` (no value). Default `false`.
- Update `USAGE` to `Usage: capataz run <plan-dir> [--issue NN] [--repo <path>] [--no-judge]`.
- `main` passes `noJudge` through to `runLoop` as deps field `noJudge` (the loop consumes it in a later issue; passing an extra field is harmless now).

## Existing tests

Fixtures in `tests/config.test.ts` (and any other phase-1 test that builds a `Config`, e.g. `tests/loop.test.ts`, `tests/e2e.test.ts`) declare only `executor`; update those fixtures to also declare `armorer` and `reviewer` roles pointing at declared backends. Do NOT touch anything under `tests/phase2/` — those are the armed tests for this plan.

## Acceptance criteria

- Config missing `roles.armorer` or `roles.reviewer` fails to load with an error naming the missing role.
- `suite_command` round-trips: present → in `Config`; absent → `undefined`.
- `parseArgs(["run", "plan"])` → `noJudge: false`; with `--no-judge` → `true`; unknown flags still rejected.
- Full phase-1 suite still green after fixture updates: `bun test tests/config.test.ts tests/loop.test.ts tests/e2e.test.ts`.
