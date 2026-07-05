import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "./loop";

interface IssueRow {
  issue: number;
  title: string;
  status: "done" | "ready-for-human" | "skipped";
  attempts: number | undefined;
  durationMs: number | undefined;
  filesTouched: string[];
  blockedBy: number[];
}

interface ArmingRow {
  issue: number;
  title: string;
  status: string;
}

function nn(issue: number): string {
  return String(issue).padStart(2, "0");
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "–";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Render the human report purely from the run's event list. */
export function renderReport(events: RunEvent[]): string {
  let feature = "unknown";
  let outcome = "crashed (no run-finished event)";
  let escalations = 0;
  let judged = true;
  const rows = new Map<number, IssueRow>();
  const commits: { commit: string; issue: number }[] = [];
  const failureReasons = new Map<number, string>();
  const verdicts = new Map<number, "approve" | "reject">();
  const armingRows = new Map<number, ArmingRow>();
  const armingPatches = new Map<number, string>();

  const row = (issue: number): IssueRow => {
    let existing = rows.get(issue);
    if (!existing) {
      existing = {
        issue,
        title: `${nn(issue)}`,
        status: "skipped",
        attempts: undefined,
        durationMs: undefined,
        filesTouched: [],
        blockedBy: [],
      };
      rows.set(issue, existing);
    }
    return existing;
  };

  const armingRow = (issue: number): ArmingRow => {
    let existing = armingRows.get(issue);
    if (!existing) {
      existing = { issue, title: row(issue).title, status: "" };
      armingRows.set(issue, existing);
    }
    return existing;
  };

  for (const event of events) {
    switch (event.type) {
      case "run-started":
        feature = event.feature;
        judged = event.judged;
        break;
      case "issue-started":
        row(event.issue).title = event.title;
        break;
      case "attempt-started":
      case "backend-result":
        break;
      case "verification-result":
        if (event.exitCode !== 0) {
          const firstLine = event.output.split("\n").find((l) => l.trim() !== "");
          failureReasons.set(event.issue, firstLine ?? "verification failed");
        }
        break;
      case "infrastructure-failure":
        failureReasons.set(event.issue, `infrastructure failure: ${event.error}`);
        break;
      case "arming-committed": {
        const ar = armingRow(event.issue);
        ar.title = row(event.issue).title;
        ar.status = `armed (${event.files.length} files)`;
        break;
      }
      case "arming-skipped": {
        const ar = armingRow(event.issue);
        ar.title = row(event.issue).title;
        ar.status = `skipped (${event.reason})`;
        break;
      }
      case "arming-failed": {
        const ar = armingRow(event.issue);
        ar.title = row(event.issue).title;
        ar.status = `failed: ${event.reason}`;
        break;
      }
      case "arming-patch":
        armingPatches.set(event.issue, `arming-${nn(event.issue)}.patch`);
        break;
      case "review-result":
        verdicts.set(event.issue, event.verdict);
        if (event.verdict === "reject") {
          failureReasons.set(event.issue, event.reason ?? "rejected by reviewer");
        }
        break;
      case "issue-committed":
        row(event.issue).filesTouched = event.filesTouched;
        commits.push({ commit: event.commit, issue: event.issue });
        break;
      case "issue-done": {
        const r = row(event.issue);
        r.status = "done";
        r.attempts = event.attempts;
        r.durationMs = event.durationMs;
        break;
      }
      case "issue-escalated": {
        const r = row(event.issue);
        r.status = "ready-for-human";
        r.attempts = event.attempts;
        r.durationMs = event.durationMs;
        break;
      }
      case "issue-skipped": {
        const r = row(event.issue);
        r.title = event.title;
        r.status = "skipped";
        r.blockedBy = event.blockedBy;
        break;
      }
      case "run-finished":
        outcome = event.reason ? `${event.outcome} (${event.reason})` : event.outcome;
        escalations = event.escalations;
        break;
    }
  }

  const sortedRows = [...rows.values()].toSorted((a, b) => a.issue - b.issue);
  const lines: string[] = [`# Capataz run report — ${feature}`, ""];
  if (!judged) {
    lines.push(
      "**UNJUDGED RUN** — Armorer and Reviewer were disabled with --no-judge.",
      "",
    );
  }
  lines.push(
    `- Outcome: ${outcome}`,
    `- Branch: capataz/${feature}`,
    `- Escalations: ${escalations}`,
    "",
    "## Issues",
    "",
    "| Issue | Status | Verdict | Attempts | Duration | Files touched |",
    "| ----- | ------ | ------- | -------- | -------- | ------------- |",
  );
  for (const r of sortedRows) {
    lines.push(
      `| ${r.title} | ${r.status} | ${verdicts.get(r.issue) ?? "–"} | ${r.attempts ?? "–"} | ${formatDuration(r.durationMs)} | ${
        r.filesTouched.join(", ") || "–"
      } |`,
    );
  }

  const sortedArmingRows = [...armingRows.values()].toSorted((a, b) => a.issue - b.issue);
  if (sortedArmingRows.length > 0) {
    lines.push("", "## Arming", "");
    for (const ar of sortedArmingRows) {
      lines.push(`- ${ar.title}: ${ar.status}`);
    }
  }

  const escalated = sortedRows.filter((r) => r.status === "ready-for-human");
  if (escalated.length > 0) {
    lines.push("", "## Escalated", "");
    for (const r of escalated) {
      const patch = armingPatches.get(r.issue);
      const patchSuffix = patch ? ` — arming saved to ${patch}` : "";
      lines.push(`- ${r.title}: ${failureReasons.get(r.issue) ?? "see run log"}${patchSuffix}`);
    }
  }

  const skipped = sortedRows.filter((r) => r.status === "skipped");
  if (skipped.length > 0) {
    lines.push("", "## Skipped", "");
    for (const r of skipped) {
      const why =
        r.blockedBy.length > 0
          ? `blocked by ${r.blockedBy.map(nn).join(", ")}`
          : "not ready-for-agent";
      lines.push(`- ${r.title}: ${why}`);
    }
  }

  if (commits.length > 0) {
    lines.push("", "## Commits", "");
    for (const c of commits) {
      const issueRow = rows.get(c.issue);
      lines.push(`- ${c.commit.slice(0, 7)} — ${issueRow?.title ?? nn(c.issue)}`);
    }
  }

  return lines.join("\n") + "\n";
}

export interface RunLog {
  dir: string;
  onEvent(event: RunEvent): void;
  writeReport(): string;
}

/**
 * Structured log for one run under `<plan-dir>/runs/<timestamp>/`:
 * append-only `events.jsonl` (a crash leaves a valid partial log), one file
 * per backend invocation with the full runner output, and `report.md`.
 */
export function createRunLog(planDir: string): RunLog {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const dir = join(planDir, "runs", timestamp);
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  const events: RunEvent[] = [];

  return {
    dir,
    onEvent(event) {
      events.push(event);
      appendFileSync(eventsPath, JSON.stringify(event) + "\n");
      if (event.type === "backend-result") {
        const role = event.role ?? "executor";
        const file = join(dir, `issue-${nn(event.issue)}-attempt-${event.attempt}-${role}.txt`);
        writeFileSync(
          file,
          `backend: ${event.backend}\nresult: ${event.kind}\nexit code: ${event.exitCode ?? "n/a"}\nduration: ${event.durationMs}ms\n\n--- stdout ---\n${event.stdout}\n\n--- stderr ---\n${event.stderr}\n`,
        );
      }
      if (event.type === "arming-patch") {
        const file = join(dir, `arming-${nn(event.issue)}.patch`);
        writeFileSync(file, event.patch);
      }
    },
    writeReport() {
      const reportPath = join(dir, "report.md");
      writeFileSync(reportPath, renderReport(events));
      return reportPath;
    },
  };
}
