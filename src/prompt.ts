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
}

export interface BuildPromptOptions {
  maxChars?: number;
}

interface SelectedFailure {
  attempt: number;
  output: string;
}

function render(issue: Issue, summaryLines: string[], failures: SelectedFailure[]): string {
  const parts: string[] = [
    `You are the Executor. Your job is ONLY this issue. Do not modify tests. Run \`${issue.verification}\` yourself before finishing.`,
    `# Issue: ${issue.title}\n\n${issue.body}`,
  ];
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
  const maxChars = options.maxChars ?? MAX_PROMPT_CHARS;

  // Failures first (newest→oldest): retry feedback matters more than old summaries.
  const selectedFailures: SelectedFailure[] = [];
  for (let i = attemptFailures.length - 1; i >= 0; i--) {
    const candidate: SelectedFailure = {
      attempt: i + 1,
      output: tail(attemptFailures[i]!, FAILURE_TAIL_CHARS),
    };
    const attempt = [candidate, ...selectedFailures];
    if (render(issue, [], attempt).length <= maxChars) {
      selectedFailures.unshift(candidate);
      continue;
    }
    if (selectedFailures.length === 0) {
      // Newest failure alone does not fit: tail-truncate it harder.
      const overflow = render(issue, [], attempt).length - maxChars;
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
    const line = `- ${s.title}: ${s.files.join(", ")}`;
    const attempt = [line, ...summaryLines];
    if (render(issue, attempt, selectedFailures).length > maxChars) break;
    summaryLines.unshift(line);
  }

  return render(issue, summaryLines, selectedFailures);
}
