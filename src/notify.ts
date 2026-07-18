import type { NotifyConfig } from "./config";
import type { RunEvent } from "./loop";

export type NotificationResult = Extract<RunEvent, { type: "notification-result" }>;

/** Fixed push timeout — a notification must never hold a run. */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** Short run summary for the ntfy push: feature, outcome, issue counts, audit results. */
export function summarizeRun(events: RunEvent[]): string {
  let feature = "unknown";
  let outcome = "crashed";
  let done = 0;
  let escalated = 0;
  let skipped = 0;
  let findings = 0;
  const doneBy = new Map<number, string>();
  const escalatedIssues = new Set<number>();
  const auditIssues = new Map<number, string>();
  for (const event of events) {
    switch (event.type) {
      case "run-started":
        feature = event.feature;
        break;
      case "run-finished":
        outcome = event.reason ? `${event.outcome} (${event.reason})` : event.outcome;
        break;
      case "issue-done":
        done += 1;
        doneBy.set(event.issue, event.resolvedBy ?? "l1");
        break;
      case "issue-escalated":
        escalated += 1;
        escalatedIssues.add(event.issue);
        break;
      case "issue-skipped":
        skipped += 1;
        break;
      case "finding-emitted":
        findings += 1;
        break;
      case "audit-issue-written":
        auditIssues.set(event.issue, event.status);
        break;
    }
  }
  const lines = [
    `capataz ${feature}: ${outcome}`,
    `issues: ${done} done, ${escalated} escalated, ${skipped} skipped`,
  ];
  if (findings > 0) {
    const outcomes = [...auditIssues.entries()].map(([issue, status]) => {
      const nn = String(issue).padStart(2, "0");
      const rung = doneBy.get(issue);
      if (rung !== undefined) return `#${nn} done (${rung})`;
      if (escalatedIssues.has(issue)) return `#${nn} escalated`;
      return `#${nn} ${status}`;
    });
    lines.push(`audit: ${findings} findings — ${outcomes.join(", ") || "no audit-issues"}`);
  }
  return lines.join("\n");
}

/**
 * Best-effort ntfy push of the run summary to `<ntfy_server>/<ntfy_topic>`.
 * Returns the `notification-result` event to log (never throws), or undefined
 * when notifications are not configured (no POST, no event).
 */
export async function sendNotification(
  notify: NotifyConfig | undefined,
  summary: string,
): Promise<NotificationResult | undefined> {
  if (notify === undefined) return undefined;
  const url = `${notify.ntfy_server.replace(/\/+$/, "")}/${notify.ntfy_topic}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      body: summary,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { type: "notification-result", ok: false, url, error: `HTTP ${response.status}`, at: Date.now() };
    }
    return { type: "notification-result", ok: true, url, at: Date.now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "notification-result", ok: false, url, error: message, at: Date.now() };
  }
}
