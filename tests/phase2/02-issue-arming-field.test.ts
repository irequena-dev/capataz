import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssueFile } from "../../src/issue";

function writeIssue(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "capataz-p2-issue-"));
  const path = join(dir, "03-thing.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}

const base = [
  "# 03 — thing",
  "",
  "Status: ready-for-agent",
  "Depends-on: none",
  "Verification: bun test",
];

describe("phase 2 issue parser: Arming field", () => {
  test("absent Arming line defaults to auto", () => {
    const result = parseIssueFile(writeIssue([...base, "", "Body text."]));
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    expect(result.issue.arming).toBe("auto");
    expect(result.issue.verification).toBe("bun test");
  });

  test("Arming: none parses and is consumed out of the body", () => {
    const result = parseIssueFile(writeIssue([...base, "Arming: none", "", "Body text."]));
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    expect(result.issue.arming).toBe("none");
    expect(result.issue.body).not.toContain("Arming:");
    expect(result.issue.body).toContain("Body text.");
  });

  test("Arming: auto parses explicitly", () => {
    const result = parseIssueFile(writeIssue([...base, "Arming: auto", "", "Body text."]));
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    expect(result.issue.arming).toBe("auto");
  });

  test("unknown Arming value invalidates the issue naming the field", () => {
    const result = parseIssueFile(writeIssue([...base, "Arming: whatever", "", "Body text."]));
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems.join("\n")).toContain("Arming");
  });
});
