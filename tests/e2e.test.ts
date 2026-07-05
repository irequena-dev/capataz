import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "index.ts");

function sh(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

interface FixtureIssue {
  number: string;
  slug: string;
  status?: string;
  dependsOn?: string;
  verification: string;
  body?: string;
}

interface Fixture {
  repo: string;
  planDir: string;
}

/**
 * Toy target repo with a plan under .scratch/, a project capataz.yaml pointing
 * at a fake backend script, and everything committed on main.
 */
function makeFixture(issues: FixtureIssue[], backendScript: string): Fixture {
  const outside = mkdtempSync(join(tmpdir(), "capataz-e2e-"));
  const repo = join(outside, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-b", "main");
  sh(repo, "config", "user.email", "test@capataz.local");
  sh(repo, "config", "user.name", "Capataz Test");

  const scriptPath = join(outside, "fake-backend.sh");
  writeFileSync(scriptPath, backendScript);

  writeFileSync(join(repo, ".gitignore"), ".scratch/*/runs/\n");
  writeFileSync(
    join(repo, "capataz.yaml"),
    [
      "backends:",
      "  fake:",
      `    command: ["sh", "${scriptPath}"]`,
      "    timeout_minutes: 1",
      "roles:",
      "  executor: fake",
      "  armorer: fake",
      "  reviewer: fake",
      "budgets:",
      "  max_attempts_per_issue: 2",
      "  max_escalations_per_run: 3",
      "  max_audit_issues: 5",
      "",
    ].join("\n"),
  );

  const planDir = join(repo, ".scratch", "toy-feature");
  mkdirSync(join(planDir, "issues"), { recursive: true });
  writeFileSync(join(planDir, "PRD.md"), "# PRD: toy feature\n");
  for (const issue of issues) {
    writeFileSync(
      join(planDir, "issues", `${issue.number}-${issue.slug}.md`),
      [
        `# ${issue.number} — ${issue.slug}`,
        "",
        `Status: ${issue.status ?? "ready-for-agent"}`,
        `Depends-on: ${issue.dependsOn ?? "none"}`,
        `Verification: ${issue.verification}`,
        "",
        issue.body ?? `Create the file this issue asks for.`,
      ].join("\n"),
    );
  }
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "initial");
  return { repo, planDir };
}

/** Reads the prompt from stdin, writes f<N>.txt for the issue it was asked. */
const obedientBackend = `#!/bin/sh
prompt=$(cat)
n=$(printf '%s' "$prompt" | sed -n 's/^# Issue: 0*\\([0-9]*\\).*/\\1/p' | head -n 1)
printf 'content %s' "$n" > "f$n.txt"
`;

/** Same, but silently ignores issue 2. */
const ignoresIssue2Backend = `#!/bin/sh
prompt=$(cat)
n=$(printf '%s' "$prompt" | sed -n 's/^# Issue: 0*\\([0-9]*\\).*/\\1/p' | head -n 1)
if [ "$n" != "2" ]; then printf 'content %s' "$n" > "f$n.txt"; fi
`;

function runCli(fixture: Fixture, ...extraArgs: string[]) {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      CLI,
      "run",
      fixture.planDir,
      "--repo",
      fixture.repo,
      "--no-judge",
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        CAPATAZ_GLOBAL_CONFIG: join(fixture.repo, "no-such-global-config.yaml"),
      },
    },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function statusOf(fixture: Fixture, file: string): string {
  const content = readFileSync(join(fixture.planDir, "issues", file), "utf8");
  return content.match(/^Status: (.*)$/m)![1]!;
}

function reportOf(fixture: Fixture): string {
  const runs = readdirSync(join(fixture.planDir, "runs"));
  expect(runs).toHaveLength(1);
  return readFileSync(join(fixture.planDir, "runs", runs[0]!, "report.md"), "utf8");
}

describe("capataz run (e2e)", () => {
  test("happy path: 3 commits on capataz/<feature>, all done, accurate report, exit 0", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", verification: "test -f f1.txt" },
        { number: "02", slug: "two", dependsOn: "01", verification: "test -f f2.txt" },
        { number: "03", slug: "three", verification: "test -f f3.txt" },
      ],
      obedientBackend,
    );
    const result = runCli(fixture);
    expect(result.exitCode).toBe(0);

    const branch = sh(fixture.repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    expect(branch).toBe("capataz/toy-feature");
    const subjects = sh(fixture.repo, "log", "--format=%s").trim().split("\n");
    expect(subjects).toEqual([
      "capataz: 03-three",
      "capataz: 02-two",
      "capataz: 01-one",
      "initial",
    ]);

    for (const f of ["01-one.md", "02-two.md", "03-three.md"]) {
      expect(statusOf(fixture, f)).toBe("done");
    }

    const report = reportOf(fixture);
    expect(report).toContain("Outcome: completed");
    expect(report).toContain("Branch: capataz/toy-feature");
    expect(report).toContain("Escalations: 0");
    for (const title of ["01 — one", "02 — two", "03 — three"]) {
      expect(report).toContain(`| ${title} | done |`);
    }
    // the commit list in the report matches git history
    const hashes = sh(fixture.repo, "log", "--format=%h", "-3").trim().split("\n");
    for (const hash of hashes) expect(report).toContain(hash.slice(0, 7));

    expect(result.stdout).toContain("report.md");
  });

  test("failure: issue 2 ready-for-human, dependent skipped, independent done, exit non-zero", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", verification: "test -f f1.txt" },
        { number: "02", slug: "two", verification: "test -f f2.txt" },
        { number: "03", slug: "three", verification: "test -f f3.txt" },
        { number: "04", slug: "dependent", dependsOn: "02", verification: "test -f f4.txt" },
      ],
      ignoresIssue2Backend,
    );
    const result = runCli(fixture);
    expect(result.exitCode).not.toBe(0);

    expect(statusOf(fixture, "01-one.md")).toBe("done");
    expect(statusOf(fixture, "02-two.md")).toBe("ready-for-human");
    expect(statusOf(fixture, "03-three.md")).toBe("done");
    expect(statusOf(fixture, "04-dependent.md")).toBe("ready-for-agent");

    const subjects = sh(fixture.repo, "log", "--format=%s").trim().split("\n");
    expect(subjects).toContain("capataz: 01-one");
    expect(subjects).toContain("capataz: 03-three");
    expect(subjects).not.toContain("capataz: 02-two");
    expect(subjects).not.toContain("capataz: 04-dependent");

    const report = reportOf(fixture);
    expect(report).toContain("| 02 — two | ready-for-human |");
    expect(report).toContain("blocked by 02");
    expect(report).toContain("Escalations: 1");
  });

  test("--issue NN runs exactly one issue (deps already done)", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", status: "done", verification: "true" },
        { number: "02", slug: "two", dependsOn: "01", verification: "test -f f2.txt" },
        { number: "03", slug: "three", verification: "test -f f3.txt" },
      ],
      obedientBackend,
    );
    const result = runCli(fixture, "--issue", "2");
    expect(result.exitCode).toBe(0);

    const subjects = sh(fixture.repo, "log", "--format=%s").trim().split("\n");
    expect(subjects).toEqual(["capataz: 02-two", "initial"]);
    expect(statusOf(fixture, "02-two.md")).toBe("done");
    expect(statusOf(fixture, "03-three.md")).toBe("ready-for-agent");
    expect(existsSync(join(fixture.repo, "f3.txt"))).toBe(false);
  });

  test("--issue NN with a non-done dependency skips without dispatching (exit 0: no escalations)", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", verification: "test -f f1.txt" },
        { number: "02", slug: "two", dependsOn: "01", verification: "test -f f2.txt" },
      ],
      obedientBackend,
    );
    const result = runCli(fixture, "--issue", "2");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fixture.repo, "f2.txt"))).toBe(false);
    expect(statusOf(fixture, "02-two.md")).toBe("ready-for-agent");
  });

  test("--issue NN with other issues left pending exits 0", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", verification: "test -f f1.txt" },
        { number: "02", slug: "two", verification: "test -f f2.txt" },
      ],
      obedientBackend,
    );
    const result = runCli(fixture, "--issue", "1");
    expect(result.exitCode).toBe(0);
    expect(statusOf(fixture, "01-one.md")).toBe("done");
    expect(statusOf(fixture, "02-two.md")).toBe("ready-for-agent");
    expect(existsSync(join(fixture.repo, "f2.txt"))).toBe(false);
  });

  test("skipped-but-unescalated full run exits 0", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", verification: "test -f f1.txt" },
        { number: "02", slug: "triage-me", status: "needs-triage", verification: "true" },
      ],
      obedientBackend,
    );
    const result = runCli(fixture);
    expect(result.exitCode).toBe(0);
    expect(statusOf(fixture, "01-one.md")).toBe("done");
    expect(statusOf(fixture, "02-triage-me.md")).toBe("needs-triage");
  });

  test("refuses a dirty working tree", () => {
    const fixture = makeFixture(
      [{ number: "01", slug: "one", verification: "test -f f1.txt" }],
      obedientBackend,
    );
    writeFileSync(join(fixture.repo, "uncommitted.txt"), "dirt");
    const result = runCli(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/dirty/i);
  });

  test("invalid plan reports all problems and exits non-zero", () => {
    const fixture = makeFixture(
      [
        { number: "01", slug: "one", verification: "test -f f1.txt" },
        { number: "02", slug: "two", dependsOn: "99", verification: "test -f f2.txt" },
      ],
      obedientBackend,
    );
    // strip the Verification line from issue 01 → two distinct problems
    const issue1 = join(fixture.planDir, "issues", "01-one.md");
    writeFileSync(
      issue1,
      readFileSync(issue1, "utf8").replace(/^Verification: .*\n/m, ""),
    );
    sh(fixture.repo, "add", "-A");
    sh(fixture.repo, "commit", "-m", "break plan");
    const result = runCli(fixture);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/Verification/);
    expect(output).toMatch(/99/);
    // nothing was executed
    const subjects = sh(fixture.repo, "log", "--format=%s").trim().split("\n");
    expect(subjects.some((s) => s.startsWith("capataz:"))).toBe(false);
  });
});
