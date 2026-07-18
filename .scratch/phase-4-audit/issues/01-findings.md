# 01 — Findings: format, parser, audit-Issue writer

Status: ready-for-agent
Depends-on: none
Verification: bun test tests/phase4/01-findings.test.ts

New module `src/audit.ts`: the structured Finding an auditor emits, the parser
that extracts Findings from raw auditor output, and the writer that turns them
into audit-Issue files. No loop integration yet (later issue).

## Finding format

Auditors emit Findings inside their stdout as fenced blocks:

````
```finding
Title: <one line>
Verification: <executable command, or empty if none applies>

<description in prose>

## Acceptance criteria

- <criterion>
```
````

- `parseFindings(output: string): Finding[]` extracts every block in emission
  order. Malformed blocks (no Title) are skipped. `Finding` carries
  `title`, `verification: string | undefined` (empty → undefined), `body`
  (description + acceptance criteria), and `auditor: "architect" | "security_auditor"`
  (passed by the caller).

## audit-Issue writer

`writeAuditIssues(findings, opts)` writes one markdown Issue per Finding into
the Plan's `issues/` dir, reusing the existing Issue file conventions
(`src/issue.ts` must parse them back cleanly):

- Numbered after the highest existing Issue number, slugged from the title.
- `Depends-on: none` (Findings are independent by construction).
- Body notes which auditor emitted it.
- Status ladder:
  - valid Verification and within `max_audit_issues` → `Status: ready-for-agent`,
  - Verification missing/empty → `Status: needs-triage`,
  - beyond `max_audit_issues` (cap counts only dispatchable ones, in emission
    order) → `Status: needs-triage`.
- Returns the written issues split into `dispatchable` and `triage`.

## Acceptance criteria

- Two well-formed blocks plus a malformed one parse into exactly two Findings
  in order.
- A Finding with empty `Verification:` round-trips as `verification: undefined`.
- Written files parse with `parseIssue` without problems; numbering continues
  after existing issues; statuses follow the ladder above.
- With `max_audit_issues: 1` and two valid Findings, the first is
  `ready-for-agent`, the second `needs-triage`.
- `max_audit_issues: 0` writes everything `needs-triage`.
