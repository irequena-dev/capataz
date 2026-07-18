import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import type { RunEvent } from "../../src/loop";
import { NOTIFY_TIMEOUT_MS, sendNotification, summarizeRun } from "../../src/notify";
import { renderReport } from "../../src/report";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "capataz-p4-notify-"));
}

const validConfig = `
backends:
  fake:
    command: ["fake-bin"]
    timeout_minutes: 1
roles:
  executor: fake
  armorer: fake
  reviewer: fake
budgets:
  max_attempts_per_issue: 2
  attempts_l1: 2
  max_escalations_per_run: 2
  max_audit_issues: 5
`;

function loadWith(extra: string) {
  const home = tmp();
  const cwd = tmp();
  const globalConfigPath = join(home, "config.yaml");
  writeFileSync(globalConfigPath, validConfig + extra);
  return loadConfig(cwd, { globalConfigPath });
}

describe("config: notify block", () => {
  test("round-trips ntfy_topic and ntfy_server", () => {
    const config = loadWith(`
notify:
  ntfy_topic: capataz-runs
  ntfy_server: https://ntfy.example.com
`);
    expect(config.notify).toEqual({
      ntfy_topic: "capataz-runs",
      ntfy_server: "https://ntfy.example.com",
    });
  });

  test("ntfy_server defaults to https://ntfy.sh", () => {
    const config = loadWith(`
notify:
  ntfy_topic: capataz-runs
`);
    expect(config.notify?.ntfy_server).toBe("https://ntfy.sh");
  });

  test("absent block leaves notify undefined", () => {
    expect(loadWith("").notify).toBeUndefined();
  });

  test("unknown key in the block fails naming the key", () => {
    expect(() =>
      loadWith(`
notify:
  ntfy_topic: capataz-runs
  webhook: https://example.com
`),
    ).toThrow(/webhook/);
  });

  test("block without ntfy_topic fails naming the key", () => {
    expect(() =>
      loadWith(`
notify:
  ntfy_server: https://ntfy.example.com
`),
    ).toThrow(/ntfy_topic/);
  });
});

const t0 = 1_750_000_000_000;

/** Judged full pass with an Audit: 01 planned done, findings, audit-Issues 02 done / 03 triaged. */
function auditRunEvents(): RunEvent[] {
  return [
    { type: "run-started", feature: "toy-feature", judged: true, at: t0 },
    { type: "issue-started", issue: 1, title: "01 — scaffold", at: t0 + 100 },
    { type: "issue-committed", issue: 1, commit: "abc1234def5678", filesTouched: ["f1.txt"], at: t0 + 200 },
    { type: "issue-done", issue: 1, attempts: 1, resolvedBy: "l1", durationMs: 200, at: t0 + 300 },
    { type: "audit-started", auditors: ["architect", "security_auditor"], at: t0 + 400 },
    {
      type: "auditor-result",
      role: "architect",
      backend: "arch-b",
      kind: "ok",
      exitCode: 0,
      durationMs: 900,
      stdout: "findings",
      stderr: "",
      at: t0 + 1_300,
    },
    { type: "finding-emitted", auditor: "architect", title: "Arch gap", dispatchable: true, at: t0 + 1_400 },
    { type: "finding-emitted", auditor: "architect", title: "Vague worry", dispatchable: false, at: t0 + 1_450 },
    {
      type: "auditor-result",
      role: "security_auditor",
      backend: "sec-b",
      kind: "timeout",
      exitCode: undefined,
      durationMs: 60_000,
      stdout: "",
      stderr: "",
      at: t0 + 61_450,
    },
    { type: "audit-issue-written", issue: 2, auditor: "architect", status: "ready-for-agent", at: t0 + 61_500 },
    { type: "audit-issue-written", issue: 3, auditor: "architect", status: "needs-triage", at: t0 + 61_550 },
    { type: "issue-started", issue: 2, title: "02 — arch-gap", at: t0 + 61_600 },
    { type: "issue-committed", issue: 2, commit: "9876543210fedc", filesTouched: ["fix.ts"], at: t0 + 61_700 },
    { type: "issue-done", issue: 2, attempts: 1, resolvedBy: "l2", durationMs: 100, at: t0 + 61_800 },
    { type: "notification-result", ok: true, url: "https://ntfy.sh/capataz-runs", at: t0 + 61_900 },
    { type: "run-finished", outcome: "completed", escalations: 0, at: t0 + 62_000 },
  ];
}

describe("notify: sendNotification", () => {
  test("POSTs the summary once to <server>/<topic> and reports ok: true", async () => {
    const posts: { path: string; body: string }[] = [];
    using server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        posts.push({ path: new URL(req.url).pathname, body: await req.text() });
        return new Response("ok");
      },
    });
    const event = await sendNotification(
      { ntfy_topic: "capataz-runs", ntfy_server: server.url.origin },
      "run summary here",
    );
    expect(posts).toEqual([{ path: "/capataz-runs", body: "run summary here" }]);
    expect(event).toMatchObject({ type: "notification-result", ok: true });
  });

  test("server 500 reports ok: false and never throws", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response("boom", { status: 500 }),
    });
    const event = await sendNotification(
      { ntfy_topic: "capataz-runs", ntfy_server: server.url.origin },
      "summary",
    );
    expect(event).toMatchObject({ type: "notification-result", ok: false });
  });

  test("unreachable server reports ok: false and never throws", async () => {
    const event = await sendNotification(
      { ntfy_topic: "capataz-runs", ntfy_server: "http://127.0.0.1:1" },
      "summary",
    );
    expect(event).toMatchObject({ type: "notification-result", ok: false });
  });

  test("no notify config: no POST, no event", async () => {
    const event = await sendNotification(undefined, "summary");
    expect(event).toBeUndefined();
  });

  test("timeout is fixed at 10s", () => {
    expect(NOTIFY_TIMEOUT_MS).toBe(10_000);
  });
});

describe("notify: summarizeRun", () => {
  test("summary carries feature, outcome, issue counts, findings and audit-Issue outcomes", () => {
    const summary = summarizeRun(auditRunEvents());
    expect(summary).toContain("toy-feature");
    expect(summary).toContain("completed");
    expect(summary).toContain("2 done");
    expect(summary).toContain("0 escalated");
    expect(summary).toContain("2 findings");
    expect(summary).toContain("#02 done (l2)");
    expect(summary).toContain("#03 needs-triage");
  });
});

describe("report: Audit section", () => {
  test("full audit run: snapshot", () => {
    expect(renderReport(auditRunEvents())).toMatchSnapshot();
  });

  test("per-auditor outcome, findings and audit-Issue final states", () => {
    const report = renderReport(auditRunEvents());
    expect(report).toContain("## Audit");
    expect(report).toMatch(/architect: ok/);
    expect(report).toMatch(/security_auditor: timed out/);
    expect(report).toContain("Arch gap");
    expect(report).toContain("Vague worry");
    expect(report).toMatch(/02.*done by l2/);
    expect(report).toMatch(/03.*needs-triage/);
  });

  test("issue table marks audit-Issues, not planned ones", () => {
    const report = renderReport(auditRunEvents());
    const rows = report.split("\n").filter((l) => l.startsWith("|"));
    expect(rows.find((l) => l.includes("01 — scaffold"))).not.toContain("(audit)");
    expect(rows.find((l) => l.includes("02 — arch-gap"))).toContain("(audit)");
  });

  test("rogue edit and escalated audit-Issue are reflected", () => {
    const events: RunEvent[] = [
      { type: "run-started", feature: "toy", judged: true, at: t0 },
      { type: "issue-done", issue: 1, attempts: 1, resolvedBy: "l1", durationMs: 10, at: t0 + 1 },
      { type: "audit-started", auditors: ["architect"], at: t0 + 2 },
      {
        type: "auditor-result",
        role: "architect",
        backend: "arch-b",
        kind: "ok",
        exitCode: 0,
        durationMs: 10,
        stdout: "",
        stderr: "",
        at: t0 + 3,
      },
      { type: "rogue-audit-edit", role: "architect", from: "aaa", to: "bbb", at: t0 + 4 },
      { type: "finding-emitted", auditor: "architect", title: "Never done", dispatchable: true, at: t0 + 5 },
      { type: "audit-issue-written", issue: 2, auditor: "architect", status: "ready-for-agent", at: t0 + 6 },
      { type: "issue-started", issue: 2, title: "02 — never-done", at: t0 + 7 },
      { type: "issue-escalated", issue: 2, attempts: 2, durationMs: 100, at: t0 + 8 },
      { type: "run-finished", outcome: "completed", escalations: 1, at: t0 + 9 },
    ];
    const report = renderReport(events);
    expect(report).toContain("rogue edit");
    expect(report).toMatch(/02.*escalated/);
  });

  test("unjudged run states why there was no Audit in one line", () => {
    const events: RunEvent[] = [
      { type: "run-started", feature: "toy", judged: false, at: t0 },
      { type: "run-finished", outcome: "completed", escalations: 0, at: t0 + 1 },
    ];
    const report = renderReport(events);
    const line = report.split("\n").find((l) => l.includes("Audit"));
    expect(line).toContain("skipped");
    expect(line).toContain("unjudged");
  });

  test("run with escalations states why there was no Audit", () => {
    const events: RunEvent[] = [
      { type: "run-started", feature: "toy", judged: true, at: t0 },
      { type: "issue-started", issue: 1, title: "01 — hard", at: t0 + 1 },
      { type: "issue-escalated", issue: 1, attempts: 2, durationMs: 10, at: t0 + 2 },
      { type: "run-finished", outcome: "completed", escalations: 1, at: t0 + 3 },
    ];
    const line = renderReport(events)
      .split("\n")
      .find((l) => l.includes("Audit"));
    expect(line).toContain("skipped");
  });

  test("judged full pass without auditors states why", () => {
    const events: RunEvent[] = [
      { type: "run-started", feature: "toy", judged: true, at: t0 },
      { type: "issue-done", issue: 1, attempts: 1, resolvedBy: "l1", durationMs: 10, at: t0 + 1 },
      { type: "run-finished", outcome: "completed", escalations: 0, at: t0 + 2 },
    ];
    const line = renderReport(events)
      .split("\n")
      .find((l) => l.includes("Audit"));
    expect(line).toContain("skipped");
    expect(line).toContain("no auditors");
  });

  test("pre-phase-4 events.jsonl replay still renders (graceful degradation)", () => {
    // A phase-1-era log: no judged field, no audit or notification events.
    const events = [
      { type: "run-started", feature: "old-feature", at: t0 },
      { type: "issue-started", issue: 1, title: "01 — old", at: t0 + 1 },
      { type: "issue-done", issue: 1, attempts: 1, durationMs: 10, at: t0 + 2 },
      { type: "run-finished", outcome: "completed", escalations: 0, at: t0 + 3 },
    ] as RunEvent[];
    const report = renderReport(events);
    expect(report).toContain("# Capataz run report — old-feature");
    expect(report).toContain("01 — old");
    expect(report).not.toContain("## Audit");
  });

  test("notification result is reflected in the report", () => {
    const report = renderReport(auditRunEvents());
    expect(report).toMatch(/Notification: sent/);
    const failed: RunEvent[] = [
      { type: "run-started", feature: "toy", judged: true, at: t0 },
      { type: "notification-result", ok: false, url: "https://ntfy.sh/t", error: "HTTP 500", at: t0 + 1 },
      { type: "run-finished", outcome: "completed", escalations: 0, at: t0 + 2 },
    ];
    expect(renderReport(failed)).toMatch(/Notification: failed/);
  });
});

describe("cli: notification at run end", () => {
  test("a run with notify configured POSTs once, even unjudged", async () => {
    const posts: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        posts.push(await req.text());
        return new Response("ok");
      },
    });

    const outside = mkdtempSync(join(tmpdir(), "capataz-p4-cli-"));
    const repo = join(outside, "repo");
    mkdirSync(repo);
    const sh = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], { cwd: repo });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    };
    sh("init", "-b", "main");
    sh("config", "user.email", "test@capataz.local");
    sh("config", "user.name", "Capataz Test");
    const scriptPath = join(outside, "fake-backend.sh");
    writeFileSync(scriptPath, "#!/bin/sh\ntouch impl.txt\n");
    writeFileSync(
      join(repo, "capataz.yaml"),
      [
        "backends:",
        "  fake:",
        `    command: ["sh", "${scriptPath}"]`,
        "    timeout_minutes: 1",
        "roles:",
        "  executor: fake",
        "  armorer: fake",
        "  reviewer: fake",
        "budgets:",
        "  max_attempts_per_issue: 2",
        "  attempts_l1: 2",
        "  max_escalations_per_run: 2",
        "  max_audit_issues: 5",
        "notify:",
        "  ntfy_topic: capataz-runs",
        `  ntfy_server: ${server.url.origin}`,
        "",
      ].join("\n"),
    );
    const planDir = join(repo, ".scratch", "toy-feature");
    mkdirSync(join(planDir, "issues"), { recursive: true });
    writeFileSync(join(planDir, "PRD.md"), "# PRD: toy\n");
    writeFileSync(
      join(planDir, "issues", "01-base.md"),
      ["# 01 — base", "", "Status: ready-for-agent", "Depends-on: none", "Verification: test -f impl.txt", "", "Create impl.txt."].join("\n"),
    );
    sh("add", "-A");
    sh("commit", "-m", "initial");

    const { main } = await import("../../src/cli");
    const globalBefore = process.env.CAPATAZ_GLOBAL_CONFIG;
    process.env.CAPATAZ_GLOBAL_CONFIG = join(outside, "no-such-global.yaml");
    try {
      const code = await main(["run", planDir, "--repo", repo, "--no-judge"]);
      expect(code).toBe(0);
    } finally {
      if (globalBefore === undefined) delete process.env.CAPATAZ_GLOBAL_CONFIG;
      else process.env.CAPATAZ_GLOBAL_CONFIG = globalBefore;
    }
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("toy-feature");
    expect(posts[0]).toContain("1 done");
  });
});
