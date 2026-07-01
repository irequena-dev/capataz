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
      reason: "escalation-budget-exceeded";
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
}

async function runVerification(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: stdout + stderr };
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

  emit({ type: "run-started", feature: plan.feature, at: Date.now() });

  for (const number of plan.order) {
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
    const headBefore = git.head();
    emit({ type: "issue-started", issue: number, title: issue.title, at: startedAt });
    writeIssueStatus(issue.path, "in-progress");
    issue.status = "in-progress";

    const failures: string[] = [];
    let done = false;
    let attempts = 0;

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
          const verified = await runVerification(issue.verification, repoPath);
          emit({
            type: "verification-result",
            issue: number,
            attempt: attempts,
            command: issue.verification,
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
  }

  emit({ type: "run-finished", outcome: "completed", escalations, at: Date.now() });
  return { kind: "completed", outcomes, escalations };
}
