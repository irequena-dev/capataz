# 02 — Issue file parser and writer

Status: done
Depends-on: 01
Verification: bun test tests/issue.test.ts

Parse `.scratch/<feature>/issues/<NN>-<slug>.md` files into a typed `Issue`: number, slug, title (first `#` heading), `Status:`, `Depends-on:` (list of issue numbers or `none`), `Verification:` (shell command), body. Support writing back an updated `Status:` line without disturbing the rest of the file.

## Acceptance criteria

- Status values restricted to: `needs-triage | needs-info | ready-for-agent | ready-for-human | wontfix | in-progress | done` (union type).
- Missing `Verification:` yields a parse result flagged as invalid (not an exception), so the plan loader can report all invalid issues at once.
- Round-trip test: parse → update status → file diff touches only the `Status:` line.
