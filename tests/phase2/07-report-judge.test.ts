import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../../src/loop";
import { createRunLog, renderReport } from "../../src/report";

const at = 1_000;

function judgedEvents(): RunEvent[] {
  return [
    { type: "run-started", feature: "toy", judged: true, at },
    { type: "issue-started", issue: 1, title: "01 — one", at },
    { type: "arming-started", issue: 1, at },
    { type: "arming-committed", issue: 1, commit: "aaa111", files: ["tests/armed-01.test.ts"], at },
    { type: "attempt-started", issue: 1, attempt: 1, at },
    {
      type: "review-result",
      issue: 1,
      attempt: 1,
      verdict: "approve",
      summary: "one exists at impl-1.txt",
      at,
    },
    { type: "issue-committed", issue: 1, commit: "bbb222", filesTouched: ["impl-1.txt"], at },
    { type: "issue-done", issue: 1, attempts: 2, durationMs: 1000, at },

    { type: "issue-started", issue: 2, title: "02 — two", at },
    { type: "arming-skipped", issue: 2, reason: "none", at },
    { type: "attempt-started", issue: 2, attempt: 1, at },
    {
      type: "review-result",
      issue: 2,
      attempt: 1,
      verdict: "reject",
      reason: "criteria unmet: two must be blue",
      at,
    },
    { type: "issue-escalated", issue: 2, attempts: 4, durationMs: 2000, at },

    { type: "issue-started", issue: 3, title: "03 — three", at },
    { type: "arming-committed", issue: 3, commit: "ccc333", files: ["tests/armed-03.test.ts"], at },
    { type: "arming-patch", issue: 3, patch: "diff --git a/tests/armed-03.test.ts ...\n+red", at },
    { type: "issue-escalated", issue: 3, attempts: 4, durationMs: 2000, at },

    { type: "run-finished", outcome: "completed", escalations: 2, at },
  ] as unknown as RunEvent[];
}

describe("phase 2 report: verdicts and arming", () => {
  test("issue table shows the last verdict per issue", () => {
    const report = renderReport(judgedEvents());
    expect(report).toContain("Verdict");
    const row1 = report.split("\n").find((l) => l.includes("01 — one"));
    expect(row1).toContain("approve");
    const row2 = report.split("\n").find((l) => l.includes("02 — two") && l.startsWith("|"));
    expect(row2).toContain("reject");
  });

  test("arming section reports armed, skipped and patch-saved issues", () => {
    const report = renderReport(judgedEvents());
    expect(report).toContain("## Arming");
    expect(report).toMatch(/01 — one.*armed/);
    expect(report).toMatch(/02 — two.*skipped \(none\)/);
    expect(report).toContain("arming-03.patch");
  });

  test("reviewer rejection reason surfaces for escalated issues", () => {
    const report = renderReport(judgedEvents());
    expect(report).toContain("criteria unmet: two must be blue");
  });

  test("judged run shows no UNJUDGED banner", () => {
    expect(renderReport(judgedEvents())).not.toContain("UNJUDGED");
  });

  test("unjudged run shows the banner prominently", () => {
    const events = [
      { type: "run-started", feature: "toy", judged: false, at },
      { type: "run-finished", outcome: "completed", escalations: 0, at },
    ] as unknown as RunEvent[];
    const report = renderReport(events);
    expect(report).toContain("UNJUDGED RUN");
    expect(report).toContain("--no-judge");
  });
});

describe("phase 2 run log: arming patches", () => {
  test("arming-patch events are written as patch files in the run dir", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-p2-runlog-"));
    const runLog = createRunLog(planDir);
    const patch = "diff --git a/tests/armed-03.test.ts b/tests/armed-03.test.ts\n+red forever\n";
    runLog.onEvent({ type: "arming-patch", issue: 3, patch, at } as unknown as RunEvent);

    const patchPath = join(runLog.dir, "arming-03.patch");
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(patch);
  });

  test("backend-result files carry the role in the filename", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-p2-runlog-"));
    const runLog = createRunLog(planDir);
    runLog.onEvent({
      type: "backend-result",
      issue: 1,
      attempt: 1,
      backend: "arm-b",
      role: "armorer",
      kind: "ok",
      exitCode: 0,
      durationMs: 10,
      stdout: "wrote tests",
      stderr: "",
      at,
    } as unknown as RunEvent);

    expect(existsSync(join(runLog.dir, "issue-01-attempt-1-armorer.txt"))).toBe(true);
  });
});
