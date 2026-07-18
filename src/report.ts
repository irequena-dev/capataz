import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Auditor } from "./audit";
import type { Rung, RunEvent } from "./loop";

interface IssueRow {
  issue: number;
  title: string;
  status: "done" | "ready-for-human" | "skipped";
  attempts: number | undefined;
  resolvedBy: Rung | undefined;
  durationMs: number | undefined;
  filesTouched: string[];
  blockedBy: number[];
}

interface ArmingRow {
  issue: number;
  title: string;
  status: string;
}

interface AuditorRow {
  role: Auditor;
  outcome: string;
  findings: number;
  rogueEdit: boolean;
  inputTruncated: boolean;
}

interface AuditIssue {
  issue: number;
  auditor: Auditor;
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
  const promotions: { issue: number; from: string; to: Rung; attemptsUsed: number }[] = [];
  const lastRung = new Map<number, Rung>();
  let auditStarted = false;
  const auditorRows = new Map<Auditor, AuditorRow>();
  const findings: { auditor: Auditor; title: string; dispatchable: boolean }[] = [];
  const auditIssues = new Map<number, AuditIssue>();
  let notification: { ok: boolean; error?: string } | undefined;

  const row = (issue: number): IssueRow => {
    let existing = rows.get(issue);
    if (!existing) {
      existing = {
        issue,
        title: `${nn(issue)}`,
        status: "skipped",
        attempts: undefined,
        resolvedBy: undefined,
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
        // Older (phase-1) logs have no `judged` field; treat them as judged so
        // a replay never renders a false UNJUDGED banner.
        judged = event.judged ?? true;
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
        // Phase-2 logs predate resolvedBy; everything ran at l1 then.
        r.resolvedBy = event.resolvedBy ?? "l1";
        break;
      }
      case "rung-promoted":
        promotions.push({
          issue: event.issue,
          from: event.from,
          to: event.to,
          attemptsUsed: event.attemptsUsed,
        });
        lastRung.set(event.issue, event.to);
        break;
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
      case "audit-started":
        auditStarted = true;
        for (const role of event.auditors) {
          auditorRows.set(role, {
            role,
            outcome: "did not run",
            findings: 0,
            rogueEdit: false,
            inputTruncated: false,
          });
        }
        break;
      case "auditor-result": {
        const ar = auditorRows.get(event.role);
        if (ar) ar.outcome = event.kind === "timeout" ? "timed out" : event.kind;
        break;
      }
      case "finding-emitted": {
        findings.push({ auditor: event.auditor, title: event.title, dispatchable: event.dispatchable });
        const ar = auditorRows.get(event.auditor);
        if (ar) ar.findings += 1;
        break;
      }
      case "audit-issue-written":
        auditIssues.set(event.issue, {
          issue: event.issue,
          auditor: event.auditor,
          title: nn(event.issue),
          status: event.status,
        });
        break;
      case "rogue-audit-edit": {
        const ar = auditorRows.get(event.role);
        if (ar) ar.rogueEdit = true;
        break;
      }
      case "audit-input-truncated": {
        const ar = auditorRows.get(event.role);
        if (ar) ar.inputTruncated = true;
        break;
      }
      case "notification-result":
        notification = { ok: event.ok, error: event.error };
        break;
      case "run-finished":
        outcome = event.reason ? `${event.outcome} (${event.reason})` : event.outcome;
        escalations = event.escalations;
        break;
    }
  }

  // Titles for dispatched audit-Issues come from their issue-started events.
  for (const auditIssue of auditIssues.values()) {
    const r = rows.get(auditIssue.issue);
    if (r) auditIssue.title = r.title;
  }

  const sortedRows = [...rows.values()].toSorted((a, b) => a.issue - b.issue);
  const lines: string[] = [`# Capataz run report — ${feature}`, ""];
  if (!judged) {
    lines.push(
      "**UNJUDGED RUN** — Armorer and Reviewer were disabled with --no-judge.",
      "",
    );
  }
  lines.push(`- Outcome: ${outcome}`, `- Branch: capataz/${feature}`, `- Escalations: ${escalations}`);
  if (!auditStarted) {
    const fullPass =
      sortedRows.length > 0 && sortedRows.every((r) => r.status === "done") && escalations === 0;
    const why = !judged ? "unjudged run" : fullPass ? "no auditors configured" : "no full pass";
    lines.push(`- Audit: skipped (${why})`);
  }
  if (notification !== undefined) {
    lines.push(
      notification.ok
        ? "- Notification: sent"
        : `- Notification: failed (${notification.error ?? "unknown error"})`,
    );
  }
  lines.push(
    "",
    "## Issues",
    "",
    "| Issue | Status | Verdict | Attempts | Duration | Resolved by | Files touched |",
    "| ----- | ------ | ------- | -------- | -------- | ----------- | ------------- |",
  );
  for (const r of sortedRows) {
    const marker = auditIssues.has(r.issue) ? " (audit)" : "";
    lines.push(
      `| ${r.title}${marker} | ${r.status} | ${verdicts.get(r.issue) ?? "–"} | ${r.attempts ?? "–"} | ${formatDuration(r.durationMs)} | ${r.resolvedBy ?? "–"} | ${
        r.filesTouched.join(", ") || "–"
      } |`,
    );
  }

  if (auditStarted) {
    lines.push("", "## Audit", "");
    for (const ar of auditorRows.values()) {
      const notes = [
        ...(ar.inputTruncated ? ["input truncated"] : []),
        ...(ar.rogueEdit ? ["rogue edit reverted"] : []),
      ];
      const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
      lines.push(`- ${ar.role}: ${ar.outcome} — ${ar.findings} finding(s)${suffix}`);
    }
    if (findings.length > 0) {
      lines.push("", "### Findings", "");
      for (const f of findings) {
        lines.push(`- [${f.auditor}] ${f.title}${f.dispatchable ? "" : " (not dispatched)"}`);
      }
    }
    const sortedAuditIssues = [...auditIssues.values()].toSorted((a, b) => a.issue - b.issue);
    if (sortedAuditIssues.length > 0) {
      lines.push("", "### Audit-issues", "");
      for (const ai of sortedAuditIssues) {
        const r = rows.get(ai.issue);
        const state =
          r?.status === "done"
            ? `done by ${r.resolvedBy ?? "l1"}`
            : r?.status === "ready-for-human"
              ? "escalated"
              : ai.status;
        lines.push(`- ${ai.title} [${ai.auditor}]: ${state}`);
      }
    }
  }

  if (promotions.length > 0) {
    lines.push("", "## Escalation ladder", "");
    for (const p of promotions) {
      lines.push(`- ${row(p.issue).title}: ${p.from} → ${p.to} (after ${p.attemptsUsed} attempts)`);
    }
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
      const rung = lastRung.get(r.issue) ?? "l1";
      lines.push(
        `- ${r.title}: ${failureReasons.get(r.issue) ?? "see run log"} — exhausted ${rung}${patchSuffix}`,
      );
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
