import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "capataz-config-"));
}

function writeYaml(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const validGlobal = `
backends:
  claude-local:
    command: ["claude", "-p", "{prompt}"]
    env:
      ANTHROPIC_BASE_URL: "http://localhost:8888"
    timeout_minutes: 10
roles:
  executor: claude-local
  armorer: claude-local
  reviewer: claude-local
budgets:
  max_attempts_per_issue: 3
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5
`;

describe("loadConfig", () => {
  test("loads a valid global config", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, "config.yaml", validGlobal);
    const config = loadConfig(cwd, { globalConfigPath });
    expect(config.roles.executor).toBe("claude-local");
    expect(config.backends["claude-local"]?.command).toEqual(["claude", "-p", "{prompt}"]);
    expect(config.backends["claude-local"]?.timeout_minutes).toBe(10);
    expect(config.budgets.max_attempts_per_issue).toBe(3);
  });

  test("project override replaces individual keys, not whole sections", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, "config.yaml", validGlobal);
    writeYaml(
      cwd,
      "capataz.yaml",
      `
budgets:
  max_attempts_per_issue: 5
`,
    );
    const config = loadConfig(cwd, { globalConfigPath });
    // overridden key
    expect(config.budgets.max_attempts_per_issue).toBe(5);
    // untouched siblings in the same section survive
    expect(config.budgets.max_escalations_per_run).toBe(2);
    expect(config.budgets.max_audit_issues).toBe(5);
    // other sections survive
    expect(config.roles.executor).toBe("claude-local");
    expect(config.backends["claude-local"]?.timeout_minutes).toBe(10);
  });

  test("project can add a backend without erasing global backends", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, "config.yaml", validGlobal);
    writeYaml(
      cwd,
      "capataz.yaml",
      `
backends:
  claude-glm:
    command: ["claude-glm", "-p"]
    timeout_minutes: 20
roles:
  reviewer: claude-glm
`,
    );
    const config = loadConfig(cwd, { globalConfigPath });
    expect(config.backends["claude-local"]).toBeDefined();
    expect(config.backends["claude-glm"]?.timeout_minutes).toBe(20);
    expect(config.roles.reviewer).toBe("claude-glm");
    expect(config.roles.executor).toBe("claude-local");
  });

  test("verification_timeout_minutes defaults when absent and accepts overrides", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(home, "config.yaml", validGlobal);
    const config = loadConfig(cwd, { globalConfigPath });
    expect(config.budgets.verification_timeout_minutes).toBe(10);

    writeYaml(
      cwd,
      "capataz.yaml",
      `
budgets:
  verification_timeout_minutes: 0.5
`,
    );
    const overridden = loadConfig(cwd, { globalConfigPath });
    expect(overridden.budgets.verification_timeout_minutes).toBe(0.5);
  });

  test("works with only a project config (no global file)", () => {
    const home = tmp();
    const cwd = tmp();
    writeYaml(cwd, "capataz.yaml", validGlobal);
    const config = loadConfig(cwd, { globalConfigPath: join(home, "config.yaml") });
    expect(config.roles.executor).toBe("claude-local");
  });

  test("unknown role fails naming the offending key", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(
      home,
      "config.yaml",
      validGlobal.replace(
        "roles:\n  executor: claude-local",
        "roles:\n  executor: claude-local\n  chef: claude-local",
      ),
    );
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/roles.*chef/s);
  });

  test("missing executor role fails naming executor", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(
      home,
      "config.yaml",
      `
backends:
  claude-local:
    command: ["claude", "-p"]
    timeout_minutes: 10
roles: {}
budgets:
  max_attempts_per_issue: 3
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5
`,
    );
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/executor/);
  });

  test("role pointing at a backend that does not exist fails naming both", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(
      home,
      "config.yaml",
      `
backends:
  claude-local:
    command: ["claude", "-p"]
    timeout_minutes: 10
roles:
  executor: ghost-backend
  armorer: claude-local
  reviewer: claude-local
budgets:
  max_attempts_per_issue: 3
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5
`,
    );
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/executor.*ghost-backend/s);
  });

  test("negative budget fails naming the offending key", () => {
    const home = tmp();
    const cwd = tmp();
    const globalConfigPath = writeYaml(
      home,
      "config.yaml",
      validGlobal.replace("max_attempts_per_issue: 3", "max_attempts_per_issue: -1"),
    );
    expect(() => loadConfig(cwd, { globalConfigPath })).toThrow(/max_attempts_per_issue/);
  });

  test("missing config entirely fails with a clear error", () => {
    const home = tmp();
    const cwd = tmp();
    expect(() => loadConfig(cwd, { globalConfigPath: join(home, "config.yaml") })).toThrow(
      /config/i,
    );
  });
});
