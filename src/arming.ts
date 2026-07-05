import { relative } from "node:path";
import type { Backend } from "./config";
import type { Git } from "./git";
import type { Issue } from "./issue";
import type { InvokeFn } from "./loop";
import { runVerification } from "./loop";
import type { DoneSummary } from "./prompt";

export interface ArmIssueDeps {
  issue: Issue;
  backend: Backend;
  git: Git;
  repoPath: string;
  invokeFn: InvokeFn;
  verificationTimeoutMinutes: number;
  /** Attempts this arming may consume. */
  maxAttempts: number;
  doneSummaries: DoneSummary[];
}

export type ArmIssueResult =
  | { kind: "armed"; commit: string; files: string[]; attemptsUsed: number }
  | { kind: "failed"; reason: string; attemptsUsed: number };

/**
 * Prompt for the Armorer: write failing tests only, never implement the
 * feature, never touch existing tests. Includes the Issue, its Verification
 * command, what already exists (done summaries) and feedback from previous
 * failed arming attempts (e.g. red-on-arrival violations).
 */
export function buildArmorerPrompt(
  issue: Issue,
  doneSummaries: DoneSummary[],
  feedback: string[],
): string {
  const parts: string[] = [
    "You are the Armorer. Your job is ONLY to write failing tests for this issue, before it is implemented. " +
      "Hard rules: write failing tests only. Do not implement the feature. Do not modify existing tests. " +
      `Run \`${issue.verification}\` yourself and confirm it fails before finishing.`,
    `# Issue: ${issue.title}\n\n${issue.body}`,
    `## Verification\n\n\`${issue.verification}\``,
  ];

  if (doneSummaries.length > 0) {
    const summaryLines = doneSummaries.map(
      (s) => `- ${s.title}: ${s.files.join(", ")}${s.summary ? ` — ${s.summary}` : ""}`,
    );
    parts.push(`## Done so far this run\n\n${summaryLines.join("\n")}`);
  }

  if (feedback.length > 0) {
    const blocks = feedback.map((f, i) => `### Attempt ${i + 1} failed\n\n${f}`);
    parts.push(`## Previous failed arming attempts\n\n${blocks.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

function isTreeClean(repoPath: string): boolean {
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoPath });
  return status.stdout.toString().trim() === "";
}

export async function armIssue(deps: ArmIssueDeps): Promise<ArmIssueResult> {
  const { issue, backend, git, repoPath, invokeFn, verificationTimeoutMinutes, maxAttempts } =
    deps;
  const doneSummaries = deps.doneSummaries;

  const feedback: string[] = [];
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const prompt = buildArmorerPrompt(issue, doneSummaries, feedback);
    const invoked = await invokeFn(backend, prompt, { cwd: repoPath });

    if (invoked.kind === "timeout") {
      git.revertToLastGood();
      feedback.push(
        `Armorer timed out after ${invoked.durationMs}ms.\n${invoked.stdout}${invoked.stderr}`,
      );
      continue;
    }

    if (isTreeClean(repoPath)) {
      feedback.push("armorer produced no changes");
      continue;
    }

    const verified = await runVerification(
      issue.verification!,
      repoPath,
      verificationTimeoutMinutes,
    );

    if (verified.exitCode === 0) {
      git.revertToLastGood();
      feedback.push("tests passed on arrival; the Arming must fail before implementation");
      continue;
    }

    git.commitArming(issue);
    const commit = git.head();
    const issueRelPath = relative(repoPath, issue.path);
    const files = git.filesInCommit(commit).filter((f) => f !== issueRelPath);
    return { kind: "armed", commit, files, attemptsUsed: attempt };
  }

  return {
    kind: "failed",
    reason: feedback[feedback.length - 1] ?? "arming failed",
    attemptsUsed: attempt,
  };
}
