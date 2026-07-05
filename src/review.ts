import type { Backend } from "./config";
import type { Issue } from "./issue";
import type { InvokeFn } from "./loop";

export type Verdict =
  | { kind: "approve"; summary: string }
  | { kind: "reject"; reason: string }
  | { kind: "unparseable" };

const VERDICT_LINE = /^\s*verdict:\s*(.*?)\s*$/i;
const SUMMARY_LINE = /^\s*summary:\s*(.*?)\s*$/i;
const REASON_LINE = /^\s*reason:\s*(.*?)\s*$/i;

/**
 * Parse the last `VERDICT:` line in stdout. Fail-closed: an approve without
 * a usable summary, an unknown verdict value, or no verdict at all all
 * resolve to `unparseable`. A reject without a reason is still trusted, and
 * defaults its reason to "unspecified".
 */
export function parseVerdict(stdout: string): Verdict {
  const lines = stdout.split("\n");

  let verdictValue: string | undefined;
  let summary: string | undefined;
  let reason: string | undefined;

  for (const line of lines) {
    const verdictMatch = line.match(VERDICT_LINE);
    if (verdictMatch) {
      verdictValue = verdictMatch[1]!.toLowerCase();
      continue;
    }
    const summaryMatch = line.match(SUMMARY_LINE);
    if (summaryMatch) {
      summary = summaryMatch[1];
      continue;
    }
    const reasonMatch = line.match(REASON_LINE);
    if (reasonMatch) {
      reason = reasonMatch[1];
      continue;
    }
  }

  if (verdictValue === "approve") {
    if (!summary) return { kind: "unparseable" };
    return { kind: "approve", summary };
  }
  if (verdictValue === "reject") {
    return { kind: "reject", reason: reason && reason !== "" ? reason : "unspecified" };
  }
  return { kind: "unparseable" };
}

export function buildReviewerPrompt(args: {
  issue: Issue;
  diff: string;
  armingFiles: string[];
}): string {
  const { issue, diff, armingFiles } = args;
  const armingSection =
    armingFiles.length > 0
      ? armingFiles.join("\n")
      : "(none)";

  return [
    "You are the Reviewer. You judge only; you do not implement. Read-only: do not edit any file, do not run write commands.",
    `# Issue: ${issue.title}\n\n${issue.body}`,
    `## Diff to judge\n\n${diff}`,
    `## Arming files\n\nThese tests were pre-approved for this plan. The diff must not weaken or remove them:\n\n${armingSection}`,
    [
      "## Output contract",
      "",
      "End your response with exactly one of:",
      "",
      "VERDICT: approve",
      "SUMMARY: <one line: what now exists and where>",
      "",
      "or",
      "",
      "VERDICT: reject",
      "REASON: <why>",
    ].join("\n"),
  ].join("\n\n");
}

const CONTRACT_REMINDER = [
  "Your previous response did not carry a parseable verdict. End your response with exactly one of:",
  "",
  "VERDICT: approve",
  "SUMMARY: <one line: what now exists and where>",
  "",
  "or",
  "",
  "VERDICT: reject",
  "REASON: <why>",
].join("\n");

export interface ReviewIssueDeps {
  issue: Issue;
  backend: Backend;
  repoPath: string;
  invokeFn: InvokeFn;
  diff: string;
  armingFiles: string[];
}

export type ReviewIssueResult =
  | { kind: "approve"; summary: string }
  | { kind: "reject"; reason: string };

/**
 * Invoke the backend as the Reviewer. Timeout or unparseable output gets one
 * retry with a reminder of the output contract appended; still unparseable
 * (or timed out) fails closed as a reject, never an approve.
 */
export async function reviewIssue(deps: ReviewIssueDeps): Promise<ReviewIssueResult> {
  const { issue, backend, repoPath, invokeFn, diff, armingFiles } = deps;
  const prompt = buildReviewerPrompt({ issue, diff, armingFiles });

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptPrompt = attempt === 0 ? prompt : `${prompt}\n\n${CONTRACT_REMINDER}`;
    const invoked = await invokeFn(backend, attemptPrompt, { cwd: repoPath });
    if (invoked.kind === "timeout") continue;

    const verdict = parseVerdict(invoked.stdout);
    if (verdict.kind === "approve") return { kind: "approve", summary: verdict.summary };
    if (verdict.kind === "reject") return { kind: "reject", reason: verdict.reason };
  }

  return { kind: "reject", reason: "no parseable verdict after retry (fail-closed)" };
}
