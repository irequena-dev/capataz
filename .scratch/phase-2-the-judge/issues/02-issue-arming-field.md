# 02 — Issue parser: Arming field

Status: done
Depends-on: none
Verification: bun test tests/phase2/02-issue-arming-field.test.ts

Add the per-Issue opt-out of arming, decided by the Planner and approved at the HITL gate.

## Changes in `src/issue.ts`

- New exported type: `export type IssueArming = "auto" | "none";`
- `Issue` interface gains `arming: IssueArming`.
- Parse an optional `Arming:` line (same style as `Status:` / `Depends-on:`: first occurrence wins, consumed out of the body):
  - `Arming: none` → `arming: "none"`
  - `Arming: auto` → `arming: "auto"`
  - absent → `arming: "auto"` (default)
  - any other value → parse problem `unknown Arming "<value>"` (issue invalid)

Semantics (consumed by the loop in a later issue): `none` skips the Armorer and the red-on-arrival gate for that Issue; Verification and Reviewer still apply.

## Acceptance criteria

- File without `Arming:` line parses with `arming === "auto"` and everything else unchanged.
- `Arming: none` parses with `arming === "none"`; the line does not appear in `body`.
- `Arming: whatever` makes the issue invalid with a problem mentioning `Arming`.
- `writeIssueStatus` untouched and still working.
