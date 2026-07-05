import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../src/loop";
import { createRunLog, renderReport } from "../src/report";

const t0 = 1_750_000_000_000;

/** A full happy+sad run: 01 done, 02 escalated, 03 skipped (dependent), 04 done. */
function sampleEvents(): RunEvent[] {
  return [
    { type: "run-started", feature: "toy-feature", at: t0 },
    { type: "issue-started", issue: 1, title: "01 — scaffold", at: t0 + 1_000 },
    { type: "attempt-started", issue: 1, attempt: 1, at: t0 + 1_100 },
    {
      type: "backend-result",
      issue: 1,
      attempt: 1,
      backend: "fake",
      kind: "ok",
      exitCode: 0,
      durationMs: 2_000,
      stdout: "did the thing",
      stderr: "",
      at: t0 + 3_100,
    },
    {
      type: "verification-result",
      issue: 1,
      attempt: 1,
      command: "test -f f1.txt",
      exitCode: 0,
      output: "",
      at: t0 + 3_200,
    },
    {
      type: "issue-committed",
      issue: 1,
      commit: "abc1234def5678",
      filesTouched: ["f1.txt", "src/a.ts"],
      at: t0 + 3_300,
    },
    { type: "issue-done", issue: 1, attempts: 1, durationMs: 2_300, at: t0 + 3_300 },
    { type: "issue-started", issue: 2, title: "02 — flaky", at: t0 + 4_000 },
    { type: "attempt-started", issue: 2, attempt: 1, at: t0 + 4_100 },
    {
      type: "backend-result",
      issue: 2,
      attempt: 1,
      backend: "fake",
      kind: "ok",
      exitCode: 0,
      durationMs: 1_000,
      stdout: "tried",
      stderr: "warn",
      at: t0 + 5_100,
    },
    {
      type: "verification-result",
      issue: 2,
      attempt: 1,
      command: "false",
      exitCode: 1,
      output: "assertion failed",
      at: t0 + 5_200,
    },
    { type: "attempt-started", issue: 2, attempt: 2, at: t0 + 5_300 },
    {
      type: "backend-result",
      issue: 2,
      attempt: 2,
      backend: "fake",
      kind: "timeout",
      exitCode: undefined,
      durationMs: 60_000,
      stdout: "partial",
      stderr: "",
      at: t0 + 65_300,
    },
    { type: "issue-escalated", issue: 2, attempts: 2, durationMs: 61_300, at: t0 + 65_400 },
    { type: "issue-skipped", issue: 3, title: "03 — dependent", blockedBy: [2], at: t0 + 65_500 },
    { type: "issue-started", issue: 4, title: "04 — independent", at: t0 + 66_000 },
    { type: "attempt-started", issue: 4, attempt: 1, at: t0 + 66_100 },
    {
      type: "backend-result",
      issue: 4,
      attempt: 1,
      backend: "fake",
      kind: "ok",
      exitCode: 0,
      durationMs: 500,
      stdout: "ok",
      stderr: "",
      at: t0 + 66_600,
    },
    {
      type: "verification-result",
      issue: 4,
      attempt: 1,
      command: "test -f f4.txt",
      exitCode: 0,
      output: "",
      at: t0 + 66_700,
    },
    {
      type: "issue-committed",
      issue: 4,
      commit: "9876543210fedc",
      filesTouched: ["f4.txt"],
      at: t0 + 66_800,
    },
    { type: "issue-done", issue: 4, attempts: 1, durationMs: 800, at: t0 + 66_800 },
    { type: "run-finished", outcome: "completed", escalations: 1, at: t0 + 67_000 },
  ];
}

describe("renderReport", () => {
  test("is a pure function over the event list: snapshot", () => {
    const report = renderReport(sampleEvents());
    expect(report).toMatchSnapshot();
    expect(renderReport(sampleEvents())).toBe(report);
  });

  test("includes outcome, branch, issue table, skips and commits", () => {
    const report = renderReport(sampleEvents());
    expect(report).toContain("completed");
    expect(report).toContain("capataz/toy-feature");
    expect(report).toContain("01 — scaffold");
    expect(report).toContain("ready-for-human");
    expect(report).toContain("blocked by 02");
    expect(report).toContain("abc1234");
    expect(report).toContain("f1.txt, src/a.ts");
  });

  test("aborted run is reported with its reason", () => {
    const events: RunEvent[] = [
      { type: "run-started", feature: "toy-feature", at: t0 },
      {
        type: "run-finished",
        outcome: "aborted",
        reason: "escalation-budget-exceeded",
        escalations: 3,
        at: t0 + 1_000,
      },
    ];
    const report = renderReport(events);
    expect(report).toContain("aborted");
    expect(report).toContain("escalation-budget-exceeded");
  });
});

describe("createRunLog", () => {
  test("appends events to events.jsonl as they arrive (crash-safe partial log)", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-report-"));
    const log = createRunLog(planDir);
    const events = sampleEvents();
    // simulate a crash: only the first three events ever arrive, no report written
    for (const event of events.slice(0, 3)) log.onEvent(event);
    const content = readFileSync(join(log.dir, "events.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as RunEvent).type)).toEqual([
      "run-started",
      "issue-started",
      "attempt-started",
    ]);
  });

  test("run dir lives under <plan-dir>/runs/<timestamp>", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-report-"));
    const log = createRunLog(planDir);
    expect(log.dir.startsWith(join(planDir, "runs"))).toBe(true);
    expect(existsSync(log.dir)).toBe(true);
  });

  test("writes one file per backend invocation with full output", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-report-"));
    const log = createRunLog(planDir);
    for (const event of sampleEvents()) log.onEvent(event);
    const files = readdirSync(log.dir).toSorted();
    expect(files).toContain("issue-01-attempt-1.txt");
    expect(files).toContain("issue-02-attempt-1.txt");
    expect(files).toContain("issue-02-attempt-2.txt");
    expect(files).toContain("issue-04-attempt-1.txt");
    const first = readFileSync(join(log.dir, "issue-01-attempt-1.txt"), "utf8");
    expect(first).toContain("did the thing");
  });

  test("writeReport renders from the collected events and writes report.md", () => {
    const planDir = mkdtempSync(join(tmpdir(), "capataz-report-"));
    const log = createRunLog(planDir);
    for (const event of sampleEvents()) log.onEvent(event);
    const reportPath = log.writeReport();
    expect(reportPath).toBe(join(log.dir, "report.md"));
    const written = readFileSync(reportPath, "utf8");
    expect(written).toBe(renderReport(sampleEvents()));
  });
});
