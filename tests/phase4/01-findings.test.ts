import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseFindings, writeAuditIssues, type Finding } from "../../src/audit";
import { parseIssueFile } from "../../src/issue";

function findingBlock(title: string, verification: string, body: string): string {
  return "```finding\nTitle: " + title + "\nVerification: " + verification + "\n\n" + body + "\n```";
}

const body = "Something is off.\n\n## Acceptance criteria\n\n- It is fixed.";

describe("parseFindings", () => {
  test("two well-formed blocks plus a malformed one parse into two Findings in order", () => {
    const output = [
      "noise before",
      findingBlock("First problem", "bun test tests/a.test.ts", body),
      "chatter between",
      "```finding\nVerification: bun test\n\nno title here\n```",
      findingBlock("Second problem", "bun test tests/b.test.ts", body),
      "noise after",
    ].join("\n\n");
    const findings = parseFindings(output, "architect");
    expect(findings.length).toBe(2);
    expect(findings[0]!.title).toBe("First problem");
    expect(findings[0]!.verification).toBe("bun test tests/a.test.ts");
    expect(findings[0]!.body).toContain("Acceptance criteria");
    expect(findings[0]!.auditor).toBe("architect");
    expect(findings[1]!.title).toBe("Second problem");
  });

  test("empty Verification round-trips as undefined", () => {
    const findings = parseFindings(findingBlock("No check", "", body), "security_auditor");
    expect(findings.length).toBe(1);
    expect(findings[0]!.verification).toBeUndefined();
    expect(findings[0]!.auditor).toBe("security_auditor");
  });

  test("no blocks yields empty list", () => {
    expect(parseFindings("nothing to see", "architect")).toEqual([]);
  });
});

function tmpIssuesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "capataz-audit-"));
  const issuesDir = join(dir, "issues");
  mkdirSync(issuesDir);
  writeFileSync(
    join(issuesDir, "01-existing.md"),
    "# 01 — Existing\n\nStatus: done\nDepends-on: none\n\nDone already.\n",
  );
  writeFileSync(
    join(issuesDir, "02-also-existing.md"),
    "# 02 — Also existing\n\nStatus: done\nDepends-on: none\n\nDone too.\n",
  );
  return issuesDir;
}

function finding(title: string, verification: string | undefined): Finding {
  return { title, verification, body, auditor: "architect" };
}

describe("writeAuditIssues", () => {
  test("numbers after existing issues, files parse cleanly, statuses follow the ladder", () => {
    const issuesDir = tmpIssuesDir();
    const { dispatchable, triage } = writeAuditIssues(
      [finding("Tighten input validation", "bun test tests/a.test.ts"), finding("Vague worry", undefined)],
      { issuesDir, maxAuditIssues: 5 },
    );
    expect(dispatchable.length).toBe(1);
    expect(triage.length).toBe(1);
    expect(dispatchable[0]!.number).toBe(3);
    expect(dispatchable[0]!.status).toBe("ready-for-agent");
    expect(dispatchable[0]!.verification).toBe("bun test tests/a.test.ts");
    expect(triage[0]!.number).toBe(4);
    expect(triage[0]!.status).toBe("needs-triage");
    expect(triage[0]!.verification).toBeUndefined();
    for (const issue of [...dispatchable, ...triage]) {
      const reparsed = parseIssueFile(issue.path);
      expect(reparsed.kind).toBe("valid");
      if (reparsed.kind !== "valid") throw new Error("unreachable");
      expect(reparsed.issue.dependsOn).toEqual([]);
      expect(reparsed.issue.body).toContain("architect");
    }
    expect(basename(dispatchable[0]!.path)).toMatch(/^03-/);
  });

  test("cap: with max_audit_issues 1 and two valid Findings, second is needs-triage", () => {
    const issuesDir = tmpIssuesDir();
    const { dispatchable, triage } = writeAuditIssues(
      [finding("First", "bun test a"), finding("Second", "bun test b")],
      { issuesDir, maxAuditIssues: 1 },
    );
    expect(dispatchable.map((i) => i.title)).toEqual([expect.stringContaining("First")]);
    expect(triage.map((i) => i.status)).toEqual(["needs-triage"]);
  });

  test("cap counts only dispatchable findings, in emission order", () => {
    const issuesDir = tmpIssuesDir();
    const { dispatchable, triage } = writeAuditIssues(
      [finding("No check", undefined), finding("Checked", "bun test a")],
      { issuesDir, maxAuditIssues: 1 },
    );
    expect(dispatchable.length).toBe(1);
    expect(dispatchable[0]!.title).toContain("Checked");
    expect(triage.length).toBe(1);
  });

  test("max_audit_issues 0 writes everything needs-triage", () => {
    const issuesDir = tmpIssuesDir();
    const { dispatchable, triage } = writeAuditIssues(
      [finding("First", "bun test a"), finding("Second", "bun test b")],
      { issuesDir, maxAuditIssues: 0 },
    );
    expect(dispatchable).toEqual([]);
    expect(triage.length).toBe(2);
    for (const issue of triage) expect(issue.status).toBe("needs-triage");
  });
});
