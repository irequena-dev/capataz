import { spawn } from "node:child_process";
import type { Backend, Config } from "./config";
import type { Git } from "./git";
import { invoke, type InvokeOptions, type InvokeResult } from "./invoker";
import { writeIssueStatus, type Issue } from "./issue";
import { blockedBy, type Plan } from "./plan";
import { buildPrompt, type DoneSummary } from "./prompt";

export type InvokeFn = (
  backend: Backend,
  prompt: string,
  options: InvokeOptions,
) => Promise<InvokeResult>;

export type RunEvent =
  | { type: "run-started"; feature: string; at: number }
  | { type: "issue-started"; issue: number; title: string; at: number }
  | { type: "attempt-started"; issue: number; attempt: number; at: number }
  | {
      type: "backend-result";
      issue: number;
      attempt: number;
      backend: string;
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

export async function runLoop(deps: RunLoopDeps): Promise<RunResult> {
  const { config, plan, git, repoPath } = deps;
  const invokeFn = deps.invokeFn ?? invoke;
  const emit = (event: RunEvent) => deps.onEvent?.(event);

  const executorName = config.roles.executor;
  const executor = config.backends[executorName];
  if (!executor) throw new Error(`Executor backend "${executorName}" not found in config`);

  const outcomes: IssueOutcome[] = [];
  const doneSummaries: DoneSummary[] = [];
  const escalatedIssues: Issue[] = [];
  let escalations = 0;

  let order = plan.order;
  if (deps.only !== undefined) {
    if (!plan.issues.has(deps.only)) throw new Error(`Unknown issue number ${deps.only}`);
    order = [deps.only];
  }

  emit({ type: "run-started", feature: plan.feature, at: Date.now() });

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

    try {
      // Guaranteed by the plan loader for non-done issues.
      const verification = issue.verification;
      if (verification === undefined) {
        throw new Error(`Issue ${number} has no Verification command`);
      }
      const headBefore = git.head();
      emit({ type: "issue-started", issue: number, title: issue.title, at: startedAt });
      writeIssueStatus(issue.path, "in-progress");
      issue.status = "in-progress";

      while (attempts < config.budgets.max_attempts_per_issue && !done) {
        attempts += 1;
        emit({ type: "attempt-started", issue: number, attempt: attempts, at: Date.now() });

        const prompt = buildPrompt(issue, doneSummaries, failures);
        const invoked = await invokeFn(executor, prompt, { cwd: repoPath });
        emit({
          type: "backend-result",
          issue: number,
          attempt: attempts,
          backend: executorName,
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
            attemptResult =
              verified.exitCode === 0
                ? { kind: "green" }
                : { kind: "red", failureOutput: verified.output };
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
        writeIssueStatus(issue.path, "done");
        issue.status = "done";
        git.commitIssue(issue);
        const commit = git.head();
        const filesTouched = git.diffStat(headBefore);
        const durationMs = Date.now() - startedAt;
        emit({ type: "issue-committed", issue: number, commit, filesTouched, at: Date.now() });
        emit({ type: "issue-done", issue: number, attempts, durationMs, at: Date.now() });
        outcomes.push({ kind: "done", issue: number, attempts, commit, filesTouched, durationMs });
        doneSummaries.push({ number, title: issue.title, files: filesTouched });
      } else {
        git.revertToLastGood();
        // The revert also wipes earlier uncommitted status writes; restore them.
        for (const prev of escalatedIssues) writeIssueStatus(prev.path, "ready-for-human");
        writeIssueStatus(issue.path, "ready-for-human");
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
        git.revertToLastGood();
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
    }
  }

  emit({ type: "run-finished", outcome: "completed", escalations, at: Date.now() });
  return { kind: "completed", outcomes, escalations };
}
