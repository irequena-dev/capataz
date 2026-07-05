# 04 — Reviewer module: verdict contract, fail-closed

Status: ready-for-agent
Depends-on: none
Verification: bun test tests/phase2/04-review.test.ts

Implement the judge: prompt, verdict parsing, fail-closed invocation.

## New file `src/review.ts`

```ts
export type Verdict =
  | { kind: "approve"; summary: string }
  | { kind: "reject"; reason: string }
  | { kind: "unparseable" };

export function parseVerdict(stdout: string): Verdict;

export function buildReviewerPrompt(args: {
  issue: Issue;
  diff: string;
  armingFiles: string[];
}): string;

export interface ReviewIssueDeps {
  issue: Issue;
  backend: Backend;
  repoPath: string;
  invokeFn: InvokeFn;   // type-only import from ./loop
  diff: string;
  armingFiles: string[];
}

export type ReviewIssueResult =
  | { kind: "approve"; summary: string }
  | { kind: "reject"; reason: string };

export function reviewIssue(deps: ReviewIssueDeps): Promise<ReviewIssueResult>;
```

## `parseVerdict` rules

- Scan stdout lines for `VERDICT:` (case-insensitive on the keyword, tolerate leading/trailing whitespace). The LAST occurrence wins.
- Verdict value `approve`: take the last `SUMMARY:` line's value; missing or empty summary → `unparseable` (an approve without a usable summary is not trusted — fail closed).
- Verdict value `reject`: take the last `REASON:` line's value; missing → reason `"unspecified"` (a reject is safe to accept without a reason).
- Verdict value anything else, or no `VERDICT:` line at all → `unparseable`.

## `buildReviewerPrompt` must include

- Framing: "You are the Reviewer", judge only, read-only — do not edit any file, do not run write commands.
- The Issue title and body (the acceptance criteria).
- The diff to judge.
- The Arming file list, with the instruction that those tests were pre-approved and the diff must not weaken them.
- The output contract, verbatim requirement to end with:
  - `VERDICT: approve` + `SUMMARY: <one line: what now exists and where>`, or
  - `VERDICT: reject` + `REASON: <why>`.

## `reviewIssue` behaviour

1. Invoke the backend with the prompt. Timeout or `unparseable` → one single retry (append a reminder of the output contract to the prompt).
2. Still unparseable/timeout → `{ kind: "reject", reason: "no parseable verdict after retry (fail-closed)" }`.
3. Never resolve `approve` unless a parseable approve verdict was emitted.

Working-tree cleanliness after the reviewer runs is enforced by the loop (later issue), not here.

Do NOT touch anything under `tests/phase2/` — those are the armed tests for this plan.

## Acceptance criteria

- All `parseVerdict` rules above, including: last verdict wins, approve without SUMMARY is unparseable, reject without REASON is `"unspecified"`.
- `reviewIssue` retries once on junk output, then rejects fail-closed.
- `reviewIssue` approves when stdout carries a valid approve verdict, propagating the summary.
