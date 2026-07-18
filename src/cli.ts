import { resolve } from "node:path";
import { loadConfig } from "./config";
import { createGit } from "./git";
import { runLoop, type RunEvent } from "./loop";
import { sendNotification, summarizeRun } from "./notify";
import { loadPlan } from "./plan";
import { createRunLog } from "./report";

const USAGE = "Usage: capataz run <plan-dir> [--issue NN] [--repo <path>] [--no-judge]";

interface CliArgs {
  planDir: string;
  repo: string;
  issue: number | undefined;
  noJudge: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== "run") throw new Error(USAGE);
  let planDir: string | undefined;
  let repo = process.cwd();
  let issue: number | undefined;
  let noJudge = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--issue") {
      const value = Number(rest[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --issue value\n${USAGE}`);
      issue = value;
    } else if (arg === "--repo") {
      const value = rest[++i];
      if (!value) throw new Error(`--repo needs a path\n${USAGE}`);
      repo = value;
    } else if (arg === "--no-judge") {
      noJudge = true;
    } else if (planDir === undefined) {
      planDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    }
  }
  if (!planDir) throw new Error(USAGE);
  return { planDir: resolve(planDir), repo: resolve(repo), issue, noJudge };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const config = loadConfig(args.repo, {
      globalConfigPath: process.env.CAPATAZ_GLOBAL_CONFIG,
    });

    const loaded = loadPlan(args.planDir);
    if (loaded.kind === "invalid") {
      console.error(`Plan ${args.planDir} is invalid:`);
      for (const problem of loaded.problems) console.error(`  - ${problem}`);
      return 1;
    }
    const plan = loaded.plan;

    const git = createGit(args.repo);
    git.assertClean();
    git.createRunBranch(plan.feature);

    const runLog = createRunLog(plan.dir);
    const events: RunEvent[] = [];
    const result = await runLoop({
      config,
      plan,
      git,
      repoPath: args.repo,
      onEvent: (event) => {
        events.push(event);
        runLog.onEvent(event);
      },
      only: args.issue,
      noJudge: args.noJudge,
    });
    const notified = await sendNotification(config.notify, summarizeRun(events));
    if (notified) runLog.onEvent(notified);
    const reportPath = runLog.writeReport();

    const done = result.outcomes.filter((o) => o.kind === "done").length;
    const escalated = result.outcomes.filter((o) => o.kind === "escalated").length;
    const skipped = result.outcomes.filter((o) => o.kind === "skipped").length;
    console.log(
      `Run ${result.kind === "aborted" ? `aborted (${result.reason})` : "completed"}: ` +
        `${done} done, ${escalated} escalated, ${skipped} skipped.`,
    );
    console.log(`Branch: capataz/${plan.feature}`);
    console.log(`Report: ${reportPath}`);

    const clean = result.kind === "completed" && escalated === 0;
    return clean ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
