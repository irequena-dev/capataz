# 02 — Auditor prompt

Status: ready-for-agent
Depends-on: none
Verification: bun test tests/phase4/02-audit-prompt.test.ts

New `buildAuditPrompt` in `src/prompt.ts`, alongside `buildPrompt` and
`buildFixerPrompt` (whose outputs must not change byte-for-byte).

## Contract

```ts
buildAuditPrompt(input: {
  role: "architect" | "security_auditor";
  prd: string;
  diff: string; // full branch diff
}): { prompt: string; truncated: boolean }
```

- **Hard framing**: read-only audit — never edit files, never run git commands;
  the only output is Findings in the fenced `finding` block format of issue 01
  (embed the exact template). Each Finding must be self-contained and carry a
  proposed executable Verification when one is possible.
- **Role framing**: architect → architecture/deepening focus
  (per `docs/design.md`: improve-codebase-architecture); security_auditor →
  vulnerability hunt (auth bypass, IDOR, XSS, secrets, unvalidated input).
- **Body**: the Plan's PRD, then the full branch diff. Reuse the existing
  tail-truncation capping (`MAX_PROMPT_CHARS`); `truncated: true` when the diff
  was capped (the loop emits `audit-input-truncated` — later issue).

## Acceptance criteria

- Snapshot per role: framing, Finding template, PRD and diff all present.
- Oversized diff is tail-truncated under `MAX_PROMPT_CHARS` with
  `truncated: true`; the PRD and framing survive capping.
- `buildPrompt` and `buildFixerPrompt` snapshots unchanged.
