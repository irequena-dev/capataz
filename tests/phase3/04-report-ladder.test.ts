import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../../src/loop";
import { createRunLog, renderReport } from "../../src/report";

const t0 = 1_750_000_000_000;

/** Issue 1 resolves at l2 (one promotion), issue 2 at l1, issue 3 escalated after reaching l3. */
function ladderEvents(): RunEvent[] {
  return [
    { type: "run-started", feature: "toy-feature", judged: true, at: t0 },
    { type: "issue-started", issue: 1, title: "01 — ladder", at: t0 + 100 },
    { type: "attempt-started", issue: 1, attempt: 1, rung: "l1", at: t0 + 200 },
    {
      type: "backend-result",
      role: "executor",
      issue: 1,
      attempt: 1,
      backend: "fake",
      kind: "ok",
      exitCode: 0,
      durationMs: 500,
      stdout: "tried",
      stderr: "",
      at: t0 + 700,
    },
    { type: "rung-promoted", issue: 1, from: "l1", to: "l2", attemptsUsed: 2, at: t0 + 800 },
    { type: "attempt-started", issue: 1, attempt: 3, rung: "l2", at: t0 + 900 },
    {
      type: "backend-result",
      role: "fixer_l2",
      issue: 1,
      attempt: 3,
      backend: "fake",
      kind: "ok",
      exitCode: 0,
      durationMs: 500,
      stdout: "fixed it",
      stderr: "",
      at: t0 + 1_400,
    },
    { type: "issue-committed", issue: 1, commit: "abc1234def5678", filesTouched: ["f1.txt"], at: t0 + 1_500 },
    { type: "issue-done", issue: 1, attempts: 3, resolvedBy: "l2", durationMs: 1_400, at: t0 + 1_500 },
    { type: "issue-started", issue: 2, title: "02 — easy", at: t0 + 2_000 },
    { type: "attempt-started", issue: 2, attempt: 1, rung: "l1", at: t0 + 2_100 },
    { type: "issue-committed", issue: 2, commit: "9876543210fedc", filesTouched: ["f2.txt"], at: t0 + 2_200 },
    { type: "issue-done", issue: 2, attempts: 1, resolvedBy: "l1", durationMs: 200, at: t0 + 2_300 },
    { type: "issue-started", issue: 3, title: "03 — hopeless", at: t0 + 3_000 },
    { type: "rung-promoted", issue: 3, from: "l1", to: "l2", attemptsUsed: 2, at: t0 + 3_100 },
    { type: "rung-promoted", issue: 3, from: "l2", to: "l3", attemptsUsed: 4, at: t0 + 3_200 },
    { type: "issue-escalated", issue: 3, attempts: 6, durationMs: 600, at: t0 + 3_300 },
    { type: "run-finished", outcome: "completed", escalations: 1, at: t0 + 4_000 },
  ];
}

/** Phase-2 shape: no resolvedBy, no promotions. */
function phase2Events(): RunEvent[] {
  const events = [
    { type: "run-started", feature: "toy-feature", judged: true, at: t0 },
    { type: "issue-started", issue: 1, title: "01 — old", at: t0 + 100 },
    { type: "issue-committed", issue: 1, commit: "abc1234def5678", filesTouched: ["f1.txt"], at: t0 + 200 },
    { type: "issue-done", issue: 1, attempts: 1, durationMs: 200, at: t0 + 300 },
    { type: "issue-started", issue: 2, title: "02 — stuck", at: t0 + 400 },
    { type: "issue-escalated", issue: 2, attempts: 2, durationMs: 300, at: t0 + 700 },
    { type: "run-finished", outcome: "completed", escalations: 1, at: t0 + 1_000 },
  ];
  return events as RunEvent[];
}

describe("Resolved by column", () => {
  test("shows the rung from issue-done.resolvedBy", () => {
    const report = renderReport(ladderEvents());
    expect(report).toContain("| Resolved by |");
    expect(report).toContain("| 01 — ladder | done | – | 3 | 1.4s | l2 | f1.txt |");
    expect(report).toContain("| 02 — easy | done | – | 1 | 0.2s | l1 | f2.txt |");
  });

  test("shows – for escalated rows", () => {
    const report = renderReport(ladderEvents());
    expect(report).toContain("| 03 — hopeless | ready-for-human | – | 6 | 0.6s | – | – |");
  });

  test("phase-2 events without resolvedBy default to l1", () => {
    const report = renderReport(phase2Events());
    expect(report).toContain("| 01 — old | done | – | 1 | 0.2s | l1 | f1.txt |");
  });
});

describe("Escalation ladder section", () => {
  test("renders one line per rung-promoted event", () => {
    const report = renderReport(ladderEvents());
    expect(report).toContain("## Escalation ladder");
    expect(report).toContain("- 01 — ladder: l1 → l2 (after 2 attempts)");
    expect(report).toContain("- 03 — hopeless: l1 → l2 (after 2 attempts)");
    expect(report).toContain("- 03 — hopeless: l2 → l3 (after 4 attempts)");
  });

  test("is omitted when no rung-promoted events exist", () => {
    expect(renderReport(phase2Events())).not.toContain("## Escalation ladder");
  });
});

describe("Escalated section rung", () => {
  test("mentions the last rung reached, derived from rung-promoted", () => {
    const report = renderReport(ladderEvents());
    expect(report).toContain("- 03 — hopeless: see run log — exhausted l3");
  });

  test("no promotions means l1", () => {
    const report = renderReport(phase2Events());
    expect(report).toContain("- 02 — stuck: see run log — exhausted l1");
  });
});

describe("createRunLog fixer invocation files", () => {
  test("backend-result with role fixer_l2 writes issue-NN-attempt-N-fixer_l2.txt", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-p3-report-"));
    const log = createRunLog(planDir);
    for (const event of ladderEvents()) log.onEvent(event);
    const files = readdirSync(log.dir);
    expect(files).toContain("issue-01-attempt-1-executor.txt");
    expect(files).toContain("issue-01-attempt-3-fixer_l2.txt");
  });
});
