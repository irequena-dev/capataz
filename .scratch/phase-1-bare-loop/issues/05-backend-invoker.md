# 05 — Backend invoker

Status: done
Depends-on: 01
Verification: bun test tests/invoker.test.ts

`invoke(backend, prompt, { cwd })`: spawn the backend's command (array template; `{prompt}` placeholder or stdin) with its env merged over process env, in the target repo cwd. Capture stdout/stderr, wall-clock duration, exit code. Enforce `timeout_minutes`: kill process tree on expiry and return a `timeout` result instead of throwing.

## Acceptance criteria

- Result is a discriminated union: `{ kind: 'ok' | 'error' | 'timeout', stdout, stderr, durationMs, exitCode? }`.
- Timeout test uses a fake backend (`sleep`) with sub-second timeout override.
- No shell string interpolation of the prompt (pass as argv element or stdin) — prompts contain arbitrary text.
