import type { Issue } from "./issue";

/** Total prompt size cap, in characters. */
export const MAX_PROMPT_CHARS = 24_000;
/** Per-failure tail kept when embedding verification output. */
const FAILURE_TAIL_CHARS = 4_000;
const TRUNCATION_MARK = "[...truncated...]\n";

export interface DoneSummary {
  number: number;
  title: string;
  files: string[];
  /** Optional free-text summary of what the issue did, for the Armorer. */
  summary?: string;
}

export interface BuildPromptOptions {
  maxChars?: number;
  /** Armed test files that must not be modified or deleted by the Executor. */
  armingFiles?: string[];
}

interface SelectedFailure {
  attempt: number;
  output: string;
}

function executorFraming(issue: Issue): string {
  return `You are the Executor. Your job is ONLY this issue. Do not modify tests. Run \`${issue.verification}\` yourself before finishing. NEVER run git commands (commit, branch, reset, stash): capataz verifies and commits your work itself; a commit made by you breaks the run.`;
}

function fixerFraming(issue: Issue): string {
  return `You are a Fixer. A previous model attempted this issue and failed; its partial work is already in the working tree. Your job is to repair that work — not reimplement from scratch — until the Verification command passes. Work ONLY on this issue. Never modify or delete the armed test files. Run \`${issue.verification}\` yourself before finishing. NEVER run git commands (commit, branch, reset, stash): capataz verifies and commits your work itself; a commit made by you breaks the run.`;
}

function render(
  issue: Issue,
  summaryLines: string[],
  failures: SelectedFailure[],
  armingFiles: string[] = [],
  framing: (issue: Issue) => string = executorFraming,
): string {
  const parts: string[] = [framing(issue), `# Issue: ${issue.title}\n\n${issue.body}`];
  if (armingFiles.length > 0) {
    const fileLines = armingFiles.map((f) => `- ${f}`).join("\n");
    parts.push(
      `## Armed tests (do not modify or delete)\n\nModifying or deleting any of these files fails the Issue automatically.\n\n${fileLines}`,
    );
  }
  if (summaryLines.length > 0) {
    parts.push(`## Done so far this run\n\n${summaryLines.join("\n")}`);
  }
  if (failures.length > 0) {
    const blocks = failures.map(
      (f) => `### Attempt ${f.attempt} failed. Verification output (tail):\n\n${f.output}`,
    );
    parts.push(`## Previous failed attempts\n\n${blocks.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

const FINDING_TEMPLATE = `\`\`\`finding
Title: <one line>
Verification: <executable command, or empty if none applies>

<description in prose>

## Acceptance criteria

- <criterion>
\`\`\``;

const AUDIT_ROLE_FRAMING: Record<AuditRole, string> = {
  architect:
    "You are the Architect. Audit the architecture of the branch's result: apply improve-codebase-architecture — hunt structural weaknesses, missing abstractions, coupling, and opportunities for deepening the design.",
  security_auditor:
    "You are the Security Auditor. Hunt vulnerabilities in the branch's result: auth bypass, IDOR, XSS, leaked secrets, unvalidated input.",
};

export type AuditRole = "architect" | "security_auditor";

export interface AuditPromptInput {
  role: AuditRole;
  prd: string;
  /** Full branch diff. */
  diff: string;
}

/**
 * Auditor dispatch prompt: read-only hard framing, role framing, the Finding
 * output contract, the Plan's PRD, and the full branch diff tail-truncated to
 * fit `MAX_PROMPT_CHARS`. `truncated` is true when the diff was capped.
 */
export function buildAuditPrompt(input: AuditPromptInput): {
  prompt: string;
  truncated: boolean;
} {
  const hardFraming = `This is a read-only audit. NEVER edit files. NEVER run git commands (commit, branch, reset, stash). Your ONLY output is Findings, emitted in your response as fenced \`finding\` blocks in this exact format:

${FINDING_TEMPLATE}

Each Finding must be self-contained and carry a proposed executable Verification command when one is possible (leave Verification empty otherwise).`;

  const renderAudit = (diff: string): string =>
    [
      AUDIT_ROLE_FRAMING[input.role],
      hardFraming,
      `# PRD\n\n${input.prd}`,
      `# Branch diff\n\n${diff}`,
    ].join("\n\n");

  const full = renderAudit(input.diff);
  if (full.length <= MAX_PROMPT_CHARS) return { prompt: full, truncated: false };
  const overflow = full.length - MAX_PROMPT_CHARS;
  const room = Math.max(input.diff.length - overflow, TRUNCATION_MARK.length);
  return { prompt: renderAudit(tail(input.diff, room)), truncated: true };
}

function tail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return TRUNCATION_MARK + text.slice(text.length - (maxLength - TRUNCATION_MARK.length));
}

/**
 * Pure assembly of one Executor dispatch prompt: issue body (never truncated),
 * state summary of done issues, hard framing, and previous attempt failures.
 * Total size capped at `maxChars`; summaries and failures are dropped
 * oldest-first to fit.
 */
export function buildPrompt(
  issue: Issue,
  doneSummaries: DoneSummary[],
  attemptFailures: string[],
  options: BuildPromptOptions = {},
): string {
  return assemble(issue, doneSummaries, attemptFailures, options, executorFraming);
}

/**
 * Fixer dispatch prompt: repair framing over the same assembly as
 * `buildPrompt` (issue body never truncated, done summaries and failure
 * history dropped oldest-first to fit the cap).
 */
export function buildFixerPrompt(
  issue: Issue,
  doneSummaries: DoneSummary[],
  attemptFailures: string[],
  options: BuildPromptOptions = {},
): string {
  return assemble(issue, doneSummaries, attemptFailures, options, fixerFraming);
}

function assemble(
  issue: Issue,
  doneSummaries: DoneSummary[],
  attemptFailures: string[],
  options: BuildPromptOptions,
  framing: (issue: Issue) => string,
): string {
  const maxChars = options.maxChars ?? MAX_PROMPT_CHARS;
  const armingFiles = options.armingFiles ?? [];

  // Failures first (newest→oldest): retry feedback matters more than old summaries.
  const selectedFailures: SelectedFailure[] = [];
  for (let i = attemptFailures.length - 1; i >= 0; i--) {
    const candidate: SelectedFailure = {
      attempt: i + 1,
      output: tail(attemptFailures[i]!, FAILURE_TAIL_CHARS),
    };
    const attempt = [candidate, ...selectedFailures];
    if (render(issue, [], attempt, armingFiles, framing).length <= maxChars) {
      selectedFailures.unshift(candidate);
      continue;
    }
    if (selectedFailures.length === 0) {
      // Newest failure alone does not fit: tail-truncate it harder.
      const overflow = render(issue, [], attempt, armingFiles, framing).length - maxChars;
      const room = candidate.output.length - overflow;
      if (room > TRUNCATION_MARK.length) {
        candidate.output = tail(candidate.output, room);
        selectedFailures.unshift(candidate);
      }
    }
    break;
  }

  // Then done summaries, newest→oldest.
  const summaryLines: string[] = [];
  for (let i = doneSummaries.length - 1; i >= 0; i--) {
    const s = doneSummaries[i]!;
    const line = s.summary
      ? `- ${s.title}: ${s.summary} (${s.files.join(", ")})`
      : `- ${s.title}: ${s.files.join(", ")}`;
    const attempt = [line, ...summaryLines];
    if (render(issue, attempt, selectedFailures, armingFiles, framing).length > maxChars) break;
    summaryLines.unshift(line);
  }

  return render(issue, summaryLines, selectedFailures, armingFiles, framing);
}
