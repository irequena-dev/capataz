import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssueFile, writeIssueStatus } from "../src/issue";

function tmpIssue(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "capataz-issue-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const sample = `# 02 — Issue file parser and writer

Status: ready-for-agent
Depends-on: 01
Verification: bun test tests/issue.test.ts

Parse issue files into a typed \`Issue\`.

## Acceptance criteria

- Round-trip.
`;

describe("parseIssueFile", () => {
  test("parses a valid issue", () => {
    const path = tmpIssue("02-issue-parser.md", sample);
    const result = parseIssueFile(path);
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    const issue = result.issue;
    expect(issue.number).toBe(2);
    expect(issue.slug).toBe("issue-parser");
    expect(issue.title).toBe("02 — Issue file parser and writer");
    expect(issue.status).toBe("ready-for-agent");
    expect(issue.dependsOn).toEqual([1]);
    expect(issue.verification).toBe("bun test tests/issue.test.ts");
    expect(issue.body).toContain("Parse issue files");
    expect(issue.path).toBe(path);
  });

  test("Depends-on: none yields empty list", () => {
    const path = tmpIssue(
      "01-scaffold.md",
      sample.replace("Depends-on: 01", "Depends-on: none"),
    );
    const result = parseIssueFile(path);
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(result.issue.dependsOn).toEqual([]);
  });

  test("Depends-on with multiple numbers", () => {
    const path = tmpIssue(
      "06-run-loop.md",
      sample.replace("Depends-on: 01", "Depends-on: 03, 04, 05"),
    );
    const result = parseIssueFile(path);
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(result.issue.dependsOn).toEqual([3, 4, 5]);
  });

  test("all seven status values accepted", () => {
    const statuses = [
      "needs-triage",
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
      "in-progress",
      "done",
    ] as const;
    for (const status of statuses) {
      const path = tmpIssue(
        "03-x.md",
        sample.replace("Status: ready-for-agent", `Status: ${status}`),
      );
      const result = parseIssueFile(path);
      if (result.kind !== "valid") throw new Error(`expected valid for ${status}`);
      expect(result.issue.status).toBe(status);
    }
  });

  test("missing Verification yields invalid result, not an exception", () => {
    const path = tmpIssue(
      "04-x.md",
      sample.replace("Verification: bun test tests/issue.test.ts\n", ""),
    );
    const result = parseIssueFile(path);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems.join(" ")).toMatch(/Verification/);
  });

  test("unknown status yields invalid result", () => {
    const path = tmpIssue(
      "05-x.md",
      sample.replace("Status: ready-for-agent", "Status: cooking"),
    );
    const result = parseIssueFile(path);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems.join(" ")).toMatch(/cooking/);
  });

  test("invalid result reports all problems at once", () => {
    const path = tmpIssue(
      "07-x.md",
      sample
        .replace("Status: ready-for-agent", "Status: cooking")
        .replace("Verification: bun test tests/issue.test.ts\n", ""),
    );
    const result = parseIssueFile(path);
    if (result.kind !== "invalid") throw new Error("expected invalid");
    expect(result.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("writeIssueStatus", () => {
  test("round-trip: only the Status line changes", () => {
    const path = tmpIssue("02-issue-parser.md", sample);
    writeIssueStatus(path, "done");
    const after = readFileSync(path, "utf8");
    expect(after).toBe(sample.replace("Status: ready-for-agent", "Status: done"));
    const reparsed = parseIssueFile(path);
    if (reparsed.kind !== "valid") throw new Error("expected valid");
    expect(reparsed.issue.status).toBe("done");
  });
});
