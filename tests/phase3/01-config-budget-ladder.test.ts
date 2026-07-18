import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "capataz-p3-config-"));
}

function writeYaml(dir: string, content: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

function baseConfig(budgets: string): string {
  return `
backends:
  claude-local:
    command: ["claude", "-p", "{prompt}"]
    timeout_minutes: 10
roles:
  executor: claude-local
  armorer: claude-local
  reviewer: claude-local
budgets:
${budgets}
`;
}

describe("phase 3 config: per-rung attempt budgets", () => {
  test("missing budgets.attempts_l1 fails naming the key", () => {
    const globalConfigPath = writeYaml(
      tmp(),
      baseConfig(`  max_attempts_per_issue: 3
  max_escalations_per_run: 2
  max_audit_issues: 5`),
    );
    expect(() => loadConfig(tmp(), { globalConfigPath })).toThrow(/attempts_l1/);
  });

  test("attempts_l2 and attempts_l3 default to 2 when absent", () => {
    const globalConfigPath = writeYaml(
      tmp(),
      baseConfig(`  max_attempts_per_issue: 3
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5`),
    );
    const config = loadConfig(tmp(), { globalConfigPath });
    expect(config.budgets.attempts_l1).toBe(3);
    expect(config.budgets.attempts_l2).toBe(2);
    expect(config.budgets.attempts_l3).toBe(2);
  });

  test("attempts_l2 and attempts_l3 round-trip when present", () => {
    const globalConfigPath = writeYaml(
      tmp(),
      baseConfig(`  max_attempts_per_issue: 9
  attempts_l1: 3
  attempts_l2: 4
  attempts_l3: 1
  max_escalations_per_run: 2
  max_audit_issues: 5`),
    );
    const config = loadConfig(tmp(), { globalConfigPath });
    expect(config.budgets.attempts_l2).toBe(4);
    expect(config.budgets.attempts_l3).toBe(1);
  });

  test("non-positive attempts_l1 fails naming the key", () => {
    const globalConfigPath = writeYaml(
      tmp(),
      baseConfig(`  max_attempts_per_issue: 3
  attempts_l1: 0
  max_escalations_per_run: 2
  max_audit_issues: 5`),
    );
    expect(() => loadConfig(tmp(), { globalConfigPath })).toThrow(/attempts_l1/);
  });

  test("max_attempts_per_issue < attempts_l1 fails naming both keys", () => {
    const globalConfigPath = writeYaml(
      tmp(),
      baseConfig(`  max_attempts_per_issue: 2
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5`),
    );
    expect(() => loadConfig(tmp(), { globalConfigPath })).toThrow(
      /max_attempts_per_issue.*attempts_l1/s,
    );
  });

  test("max_attempts_per_issue == attempts_l1 is valid", () => {
    const globalConfigPath = writeYaml(
      tmp(),
      baseConfig(`  max_attempts_per_issue: 3
  attempts_l1: 3
  max_escalations_per_run: 2
  max_audit_issues: 5`),
    );
    const config = loadConfig(tmp(), { globalConfigPath });
    expect(config.budgets.max_attempts_per_issue).toBe(3);
  });
});
