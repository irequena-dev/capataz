import { spawn } from "node:child_process";
import { armIssue } from "./arming";
import type { Backend, Config } from "./config";
import type { Git } from "./git";
import { invoke, type InvokeOptions, type InvokeResult } from "./invoker";
import { writeIssueStatus, type Issue } from "./issue";
import { blockedBy, type Plan } from "./plan";
import { buildPrompt, type DoneSummary } from "./prompt";
import { reviewIssue } from "./review";

export type InvokeFn = (
  backend: Backend,
  prompt: string,
  options: InvokeOptions,
) => Promise<InvokeResult>;

export type RunEvent =
  | { type: "run-started"; feature: string; judged: boolean; at: number }
  | { type: "issue-started"; issue: number; title: string; at: number }
  | { type: "attempt-started"; issue: number; attempt: number; at: number }
  | {
      type: "backend-result";
      issue: number;
      attempt: number;
      backend: string;
      role: "executor" | "armorer" | "reviewer";
      kind: InvokeResult["kind"];
      exitCode: number | undefined;
      durationMs: number;
      stdout: string;
      stderr: string;
      at: number;
    }
  | {
      type: "verification-result";
      issue: number;
      attempt: number;
      command: string;
      exitCode: number;
      output: string;
      at: number;
    }
  | { type: "issue-committed"; issue: number; commit: string; filesTouched: string[]; at: number }
  | { type: "issue-done"; issue: number; attempts: number; durationMs: number; at: number }
  | { type: "issue-escalated"; issue: number; attempts: number; durationMs: number; at: number }
  | { type: "issue-skipped"; issue: number; title: string; blockedBy: number[]; at: number }
  | { type: "infrastructure-failure"; issue: number; error: string; at: number }
  | { type: "arming-started"; issue: number; at: number }
  | { type: "arming-committed"; issue: number; commit: string; files: string[]; at: number }
  | { type: "arming-failed"; issue: number; reason: string; at: number }
  | { type: "arming-skipped"; issue: number; reason: "none" | "no-judge"; at: number }
  | {
      type: "suite-result";
      issue: number;
      attempt: number;
      command: string;
      exitCode: number;
      output: string;
      at: number;
    }
  | { type: "arming-violation"; issue: number; attempt: number; files: string[]; at: number }
  | { type: "rogue-commit"; issue: number; attempt: number; from: string; to: string; at: number }
  | {
      type: "review-result";
      issue: number;
      attempt: number;
      verdict: "approve" | "reject";
      summary?: string;
      reason?: string;
      at: number;
    }
  | { type: "reviewer-dirty-tree"; issue: number; attempt: number; at: number }
  | { type: "arming-patch"; issue: number; patch: string; at: number }
  | {
      type: "run-finished";
      outcome: "completed" | "aborted";
      reason?: string;
      escalations: number;
      at: number;
    };

export type IssueOutcome =
  | {
      kind: "done";
      issue: number;
      attempts: number;
      commit: string;
      filesTouched: string[];
      durationMs: number;
    }
  | { kind: "escalated"; issue: number; attempts: number; durationMs: number }
  | { kind: "skipped"; issue: number; blockedBy: number[] };

export type RunResult =
  | { kind: "completed"; outcomes: IssueOutcome[]; escalations: number }
  | {
      kind: "aborted";
      reason: "escalation-budget-exceeded" | "infrastructure-failure";
      outcomes: IssueOutcome[];
      escalations: number;
    };

export interface RunLoopDeps {
  config: Config;
  plan: Plan;
  git: Git;
  repoPath: string;
  invokeFn?: InvokeFn;
  onEvent?: (event: RunEvent) => void;
  /** Run exactly this issue instead of the whole plan (deps must be done). */
  only?: number;
  /** Escape hatch: skip the judge (armorer/reviewer) roles for this run. */
  noJudge?: boolean;
}

/** Max captured verification output; the tail is kept (end of test output). */
export const VERIFICATION_OUTPUT_CAP = 1_048_576;
const TRUNCATION_MARK = "[...truncated...]\n";

function capTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return TRUNCATION_MARK + text.slice(text.length - (maxLength - TRUNCATION_MARK.length));
}

export function runVerification(
  command: string,
  cwd: string,
  timeoutMinutes: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so a timeout can kill the whole tree.
      detached: true,
    });

    const chunks: Buffer[] = [];
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMinutes * 60_000);

    child.on("error", () => {
      // reported through the close handler via a non-zero exit
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = capTail(Buffer.concat(chunks).toString("utf8"), VERIFICATION_OUTPUT_CAP);
      if (timedOut) {
        resolve({
          exitCode: 1,
          output: `verification timed out after ${timeoutMinutes}m\n${output}`,
        });
      } else {
        resolve({ exitCode: code ?? 1, output });
      }
    });
  });
}

type AttemptResult =
  | { kind: "green" }
  | { kind: "red"; failureOutput: string };

export function isTreeClean(repoPath: string): boolean {
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoPath });
  return status.stdout.toString().trim() === "";
}

/** Files changed or deleted in the working tree relative to HEAD (`git diff --name-only HEAD`). */
function changedFilesSinceHead(repoPath: string): string[] {
  const proc = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], { cwd: repoPath });
  return proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** Wrap `invokeFn` so every call also emits a `backend-result` event for the given role. */
function invokeAndEmit(
  invokeFn: InvokeFn,
  emit: (event: RunEvent) => void,
  role: "armorer" | "reviewer",
  backendName: string,
  issueNumber: number,
): InvokeFn {
  let attempt = 0;
  return async (backend, prompt, options) => {
    attempt += 1;
    const invoked = await invokeFn(backend, prompt, options);
    emit({
      type: "backend-result",
      issue: issueNumber,
      attempt,
      backend: backendName,
      role,
      kind: invoked.kind,
      exitCode: invoked.kind === "timeout" ? undefined : invoked.exitCode,
      durationMs: invoked.durationMs,
      stdout: invoked.stdout,
      stderr: invoked.stderr,
      at: Date.now(),
    });
    return invoked;
  };
}

export async function runLoop(deps: RunLoopDeps): Promise<RunResult> {
  const { config, plan, git, repoPath } = deps;
  const invokeFn = deps.invokeFn ?? invoke;
  const emit = (event: RunEvent) => deps.onEvent?.(event);
  const judged = !deps.noJudge;

  const executorName = config.roles.executor;
  const executor = config.backends[executorName];
  if (!executor) throw new Error(`Executor backend "${executorName}" not found in config`);
  const armorerName = config.roles.armorer;
  const armorer = config.backends[armorerName];
  if (!armorer) throw new Error(`Armorer backend "${armorerName}" not found in config`);
  const reviewerName = config.roles.reviewer;
  const reviewerBackend = config.backends[reviewerName];
  if (!reviewerBackend) throw new Error(`Reviewer backend "${reviewerName}" not found in config`);

  const outcomes: IssueOutcome[] = [];
  const doneSummaries: DoneSummary[] = [];
  const escalatedIssues: Issue[] = [];
  let escalations = 0;

  let order = plan.order;
  if (deps.only !== undefined) {
    if (!plan.issues.has(deps.only)) throw new Error(`Unknown issue number ${deps.only}`);
    order = [deps.only];
  }

  emit({ type: "run-started", feature: plan.feature, judged, at: Date.now() });

  for (const number of order) {
    const issue = plan.issues.get(number)!;
    if (issue.status === "done") continue;

    if (issue.status !== "ready-for-agent") {
      const outcome: IssueOutcome = { kind: "skipped", issue: number, blockedBy: [] };
      outcomes.push(outcome);
      emit({ type: "issue-skipped", issue: number, title: issue.title, blockedBy: [], at: Date.now() });
      continue;
    }

    const blockers = blockedBy(plan, number);
    if (blockers.length > 0) {
      outcomes.push({ kind: "skipped", issue: number, blockedBy: blockers });
      emit({
        type: "issue-skipped",
        issue: number,
        title: issue.title,
        blockedBy: blockers,
        at: Date.now(),
      });
      continue;
    }

    const startedAt = Date.now();
    const failures: string[] = [];
    let done = false;
    let attempts = 0;
    let pre: string | undefined;
    let armingCommit: string | undefined;

    // Mark this issue ready-for-human, record the outcome, and enforce the
    // per-run escalation budget. Returns the aborted RunResult when the budget
    // is exceeded, otherwise undefined (the run continues).
    const escalate = (): RunResult | undefined => {
      issue.status = "ready-for-human";
      escalatedIssues.push(issue);
      const durationMs = Date.now() - startedAt;
      emit({ type: "issue-escalated", issue: number, attempts, durationMs, at: Date.now() });
      outcomes.push({ kind: "escalated", issue: number, attempts, durationMs });
      escalations += 1;
      if (escalations > config.budgets.max_escalations_per_run) {
        emit({
          type: "run-finished",
          outcome: "aborted",
          reason: "escalation-budget-exceeded",
          escalations,
          at: Date.now(),
        });
        return { kind: "aborted", reason: "escalation-budget-exceeded", outcomes, escalations };
      }
      return undefined;
    };

    try {
      // Guaranteed by the plan loader for non-done issues.
      const verification = issue.verification;
      if (verification === undefined) {
        throw new Error(`Issue ${number} has no Verification command`);
      }
      pre = git.head();
      emit({ type: "issue-started", issue: number, title: issue.title, at: startedAt });
      writeIssueStatus(issue.path, "in-progress");
      issue.status = "in-progress";

      let armingFiles: string[] = [];
      let armingFailed: string | undefined;

      if (!judged) {
        emit({ type: "arming-skipped", issue: number, reason: "no-judge", at: Date.now() });
      } else if (issue.arming === "none") {
        emit({ type: "arming-skipped", issue: number, reason: "none", at: Date.now() });
      } else {
        emit({ type: "arming-started", issue: number, at: Date.now() });
        const armResult = await armIssue({
          issue,
          backend: armorer,
          git,
          repoPath,
          invokeFn: invokeAndEmit(invokeFn, emit, "armorer", armorerName, number),
          verificationTimeoutMinutes: config.budgets.verification_timeout_minutes,
          maxAttempts: config.budgets.max_attempts_per_issue,
          doneSummaries,
        });
        attempts = armResult.attemptsUsed;
        if (armResult.kind === "armed") {
          armingCommit = armResult.commit;
          armingFiles = armResult.files;
          emit({
            type: "arming-committed",
            issue: number,
            commit: armResult.commit,
            files: armResult.files,
            at: Date.now(),
          });
        } else {
          armingFailed = armResult.reason;
          emit({ type: "arming-failed", issue: number, reason: armResult.reason, at: Date.now() });
        }
      }

      const baseForImpl = git.head();

      while (armingFailed === undefined && attempts < config.budgets.max_attempts_per_issue && !done) {
        attempts += 1;
        emit({ type: "attempt-started", issue: number, attempt: attempts, at: Date.now() });

        const prompt = buildPrompt(issue, doneSummaries, failures, { armingFiles });
        const preInvoke = git.head();
        const invoked = await invokeFn(executor, prompt, { cwd: repoPath });
        // Rogue-commit guard: capataz owns version control. If the runner
        // committed on its own (dangerous permission mode), un-commit back to
        // where we were, keeping the work in the tree so the normal gates
        // (verification, arming check, review, commit) still decide its fate.
        const postInvoke = git.head();
        if (postInvoke !== preInvoke) {
          git.softResetTo(preInvoke);
          emit({
            type: "rogue-commit",
            issue: number,
            attempt: attempts,
            from: preInvoke,
            to: postInvoke,
            at: Date.now(),
          });
        }
        emit({
          type: "backend-result",
          issue: number,
          attempt: attempts,
          backend: executorName,
          role: "executor",
          kind: invoked.kind,
          exitCode: invoked.kind === "timeout" ? undefined : invoked.exitCode,
          durationMs: invoked.durationMs,
          stdout: invoked.stdout,
          stderr: invoked.stderr,
          at: Date.now(),
        });

        let attemptResult: AttemptResult;
        switch (invoked.kind) {
          case "timeout":
            attemptResult = {
              kind: "red",
              failureOutput: `Runner timed out after ${invoked.durationMs}ms.\n${invoked.stdout}${invoked.stderr}`,
            };
            break;
          case "ok":
          case "error": {
            // Even if the runner exited non-zero, the Verification command decides.
            const verified = await runVerification(
              verification,
              repoPath,
              config.budgets.verification_timeout_minutes,
            );
            emit({
              type: "verification-result",
              issue: number,
              attempt: attempts,
              command: verification,
              exitCode: verified.exitCode,
              output: verified.output,
              at: Date.now(),
            });
            if (verified.exitCode !== 0) {
              attemptResult = { kind: "red", failureOutput: verified.output };
              break;
            }

            if (config.suite_command) {
              const suite = await runVerification(
                config.suite_command,
                repoPath,
                config.budgets.verification_timeout_minutes,
              );
              emit({
                type: "suite-result",
                issue: number,
                attempt: attempts,
                command: config.suite_command,
                exitCode: suite.exitCode,
                output: suite.output,
                at: Date.now(),
              });
              if (suite.exitCode !== 0) {
                attemptResult = {
                  kind: "red",
                  failureOutput: `The full suite command regressed (not just this issue's verification):\n${suite.output}`,
                };
                break;
              }
            }

            if (!judged) {
              writeIssueStatus(issue.path, "done");
              issue.status = "done";
              git.commitIssue(issue);
              attemptResult = { kind: "green" };
              break;
            }

            const changed = changedFilesSinceHead(repoPath);
            const violated = changed.filter((f) => armingFiles.includes(f));
            if (violated.length > 0) {
              git.restoreFiles("HEAD", armingFiles);
              emit({ type: "arming-violation", issue: number, attempt: attempts, files: violated, at: Date.now() });
              attemptResult = {
                kind: "red",
                failureOutput: `Modified or deleted armed test file(s), which is not allowed: ${violated.join(", ")}. These have been restored from HEAD.`,
              };
              break;
            }

            const commitBefore = git.head();
            writeIssueStatus(issue.path, "done");
            issue.status = "done";
            git.commitIssue(issue);
            const diff = git.diffPatch(commitBefore, "HEAD");
            const reviewResult = await reviewIssue({
              issue,
              backend: reviewerBackend,
              repoPath,
              invokeFn: invokeAndEmit(invokeFn, emit, "reviewer", reviewerName, number),
              diff,
              armingFiles,
            });

            if (!isTreeClean(repoPath)) {
              git.revertToLastGood();
              emit({ type: "reviewer-dirty-tree", issue: number, attempt: attempts, at: Date.now() });
            }

            if (reviewResult.kind === "approve") {
              emit({
                type: "review-result",
                issue: number,
                attempt: attempts,
                verdict: "approve",
                summary: reviewResult.summary,
                at: Date.now(),
              });
              doneSummaries.push({
                number,
                title: issue.title,
                files: git.diffStat(baseForImpl),
                summary: reviewResult.summary,
              });
              attemptResult = { kind: "green" };
            } else {
              emit({
                type: "review-result",
                issue: number,
                attempt: attempts,
                verdict: "reject",
                reason: reviewResult.reason,
                at: Date.now(),
              });
              git.softResetLast();
              writeIssueStatus(issue.path, "in-progress");
              issue.status = "in-progress";
              attemptResult = { kind: "red", failureOutput: reviewResult.reason };
            }
            break;
          }
        }

        switch (attemptResult.kind) {
          case "green":
            done = true;
            break;
          case "red":
            failures.push(attemptResult.failureOutput);
            break;
        }
      }

      if (done) {
        const commit = git.head();
        const filesTouched = git.diffStat(baseForImpl);
        const durationMs = Date.now() - startedAt;
        emit({ type: "issue-committed", issue: number, commit, filesTouched, at: Date.now() });
        emit({ type: "issue-done", issue: number, attempts, durationMs, at: Date.now() });
        outcomes.push({ kind: "done", issue: number, attempts, commit, filesTouched, durationMs });
        // Judged runs already recorded the reviewer's summary on approve; only
        // the unjudged path needs a mechanical (title + files) summary.
        if (!judged) {
          doneSummaries.push({ number, title: issue.title, files: filesTouched });
        }
      } else {
        if (armingCommit !== undefined) {
          const patch = git.diffPatch(pre, armingCommit);
          emit({ type: "arming-patch", issue: number, patch, at: Date.now() });
          git.resetHardTo(pre);
        } else {
          git.revertToLastGood();
        }
        // The revert also wipes earlier uncommitted status writes; restore them.
        for (const prev of escalatedIssues) writeIssueStatus(prev.path, "ready-for-human");
        writeIssueStatus(issue.path, "ready-for-human");
        const aborted = escalate();
        if (aborted) return aborted;
      }
    } catch (error) {
      // Infrastructure failure (git or status write): degrade, don't die.
      emit({
        type: "infrastructure-failure",
        issue: number,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
      try {
        if (armingCommit !== undefined && pre !== undefined) {
          git.resetHardTo(pre);
        } else {
          git.revertToLastGood();
        }
        for (const prev of escalatedIssues) writeIssueStatus(prev.path, "ready-for-human");
        writeIssueStatus(issue.path, "ready-for-human");
      } catch {
        // Even the containment failed: abort the run, never throw.
        emit({
          type: "run-finished",
          outcome: "aborted",
          reason: "infrastructure-failure",
          escalations,
          at: Date.now(),
        });
        return { kind: "aborted", reason: "infrastructure-failure", outcomes, escalations };
      }
      const aborted = escalate();
      if (aborted) return aborted;
    }
  }

  emit({ type: "run-finished", outcome: "completed", escalations, at: Date.now() });
  return { kind: "completed", outcomes, escalations };
}
