# 01 — Config: per-rung attempt budgets

Status: ready-for-agent
Depends-on: none
Verification: bun test tests/phase3/01-config-budget-ladder.test.ts

Add per-rung attempt budgets to the config, keeping `max_attempts_per_issue` as
the global total across the whole Escalation ladder.

## Changes in `src/config.ts`

- `budgets` gains:
  - `attempts_l1`: required positive int. Takes over the phase-2 semantics of
    the shared Armorer+Executor counter (one Arming or Executor invocation =
    one L1 attempt).
  - `attempts_l2`: optional positive int, default `2`. Attempts for `fixer_l2`.
  - `attempts_l3`: optional positive int, default `2`. Attempts for `fixer_l3`.
- `max_attempts_per_issue` stays and becomes the global total across all rungs:
  reject config where `max_attempts_per_issue < attempts_l1` with an error
  naming both keys (a ladder that cannot even finish L1 is a misconfiguration).
- `roles.fixer_l2` / `roles.fixer_l3` stay optional (an unconfigured rung is
  skipped by the loop — later issue). The existing role→backend existence check
  already covers them.

## Existing config files and fixtures

- Update `capataz.yaml` at the repo root: add `attempts_l1` mirroring the
  current `max_attempts_per_issue` value.
- Update every test fixture that builds a `Config` or a config YAML
  (`tests/config.test.ts`, `tests/loop.test.ts`, `tests/e2e.test.ts`,
  `tests/phase2/*.test.ts`, `tests/hardening/*.test.ts`) to declare
  `attempts_l1`. Do not change their behaviour otherwise.

## Acceptance criteria

- Config missing `budgets.attempts_l1` fails to load naming the key.
- `attempts_l2`/`attempts_l3` default to 2 when absent and round-trip when
  present.
- `max_attempts_per_issue: 2` with `attempts_l1: 3` fails to load with an error
  naming both keys.
- Full existing suite stays green after fixture updates: `bun test`.
