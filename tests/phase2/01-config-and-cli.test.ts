import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
// parseArgs must be exported from the CLI module.
import { parseArgs } from "../../src/cli";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "capataz-p2-config-"));
}

function writeYaml(dir: string, content: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

const fullRoles = `
backends:
  exec-b:
    command: ["exec-bin", "{prompt}"]
    timeout_minutes: 1
  arm-b:
    command: ["arm-bin", "{prompt}"]
    timeout_minutes: 1
  rev-b:
    command: ["rev-bin", "{prompt}"]
    timeout_minutes: 1
roles:
  executor: exec-b
  armorer: arm-b
  reviewer: rev-b
budgets:
  max_attempts_per_issue: 3
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5
`;

describe("phase 2 config: judge roles are mandatory", () => {
  test("config with executor, armorer and reviewer loads", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, fullRoles);
    const config = loadConfig(cwd, { globalConfigPath });
    expect(config.roles.armorer).toBe("arm-b");
    expect(config.roles.reviewer).toBe("rev-b");
  });

  test("config missing roles.armorer is invalid, naming armorer", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, fullRoles.replace("  armorer: arm-b\n", ""));
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/armorer/);
  });

  test("config missing roles.reviewer is invalid, naming reviewer", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, fullRoles.replace("  reviewer: rev-b\n", ""));
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/reviewer/);
  });

  test("armorer/reviewer pointing at an undeclared backend fails", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, fullRoles.replace("armorer: arm-b", "armorer: ghost"));
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/armorer.*ghost/s);
  });
});

describe("phase 2 config: suite_command", () => {
  test("optional suite_command round-trips", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, `${fullRoles}suite_command: bun test\n`);
    const config = loadConfig(cwd, { globalConfigPath });
    expect(config.suite_command).toBe("bun test");
  });

  test("absent suite_command is undefined", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, fullRoles);
    const config = loadConfig(cwd, { globalConfigPath });
    expect(config.suite_command).toBeUndefined();
  });
});

describe("phase 2 CLI: --no-judge", () => {
  test("defaults to a judged run", () => {
    const args = parseArgs(["run", "some-plan"]);
    expect(args.noJudge).toBe(false);
    expect(args.planDir.endsWith("some-plan")).toBe(true);
  });

  test("--no-judge flips the flag", () => {
    const args = parseArgs(["run", "some-plan", "--no-judge"]);
    expect(args.noJudge).toBe(true);
  });

  test("--no-judge composes with --issue", () => {
    const args = parseArgs(["run", "some-plan", "--no-judge", "--issue", "3"]);
    expect(args.noJudge).toBe(true);
    expect(args.issue).toBe(3);
  });

  test("unknown flags are still rejected", () => {
    expect(() => parseArgs(["run", "some-plan", "--bogus"])).toThrow();
  });
});
