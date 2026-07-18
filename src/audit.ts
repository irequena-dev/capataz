import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseIssueFile, type Issue } from "./issue";

export type Auditor = "architect" | "security_auditor";

export interface Finding {
  title: string;
  /** Proposed Verification command; undefined when the auditor left it empty. */
  verification: string | undefined;
  /** Description plus acceptance criteria, verbatim from the block. */
  body: string;
  auditor: Auditor;
}

const FINDING_BLOCK = /```finding\n([\s\S]*?)```/g;
const TITLE_LINE = /^Title:\s*(.*)$/;
const VERIFICATION_LINE = /^Verification:\s*(.*)$/;

/** Extracts every well-formed `finding` block, in emission order. Blocks without a Title are skipped. */
export function parseFindings(output: string, auditor: Auditor): Finding[] {
  const findings: Finding[] = [];
  for (const match of output.matchAll(FINDING_BLOCK)) {
    let title: string | undefined;
    let verification: string | undefined;
    const bodyLines: string[] = [];
    for (const line of match[1]!.split("\n")) {
      const titleMatch = line.match(TITLE_LINE);
      if (titleMatch && title === undefined) {
        title = titleMatch[1]!.trim();
        continue;
      }
      const verificationMatch = line.match(VERIFICATION_LINE);
      if (verificationMatch && verification === undefined) {
        verification = verificationMatch[1]!.trim();
        continue;
      }
      bodyLines.push(line);
    }
    if (title === undefined || title === "") continue;
    findings.push({
      title,
      verification: verification === "" ? undefined : verification,
      body: bodyLines.join("\n").trim(),
      auditor,
    });
  }
  return findings;
}

export interface WriteAuditIssuesOptions {
  issuesDir: string;
  /** `budgets.max_audit_issues` cap on dispatchable audit-Issues. */
  maxAuditIssues: number;
}

export interface WrittenAuditIssues {
  dispatchable: Issue[];
  triage: Issue[];
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "finding"
  );
}

function highestIssueNumber(issuesDir: string): number {
  let highest = 0;
  for (const file of readdirSync(issuesDir)) {
    const match = file.match(/^(\d+)-.+\.md$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Writes one Issue file per Finding into the Plan's issues dir, numbered after
 * the highest existing Issue. Findings with a Verification get
 * `ready-for-agent` while within the `max_audit_issues` cap (counting only
 * dispatchable ones, in emission order); everything else `needs-triage`.
 */
export function writeAuditIssues(
  findings: Finding[],
  opts: WriteAuditIssuesOptions,
): WrittenAuditIssues {
  let next = highestIssueNumber(opts.issuesDir) + 1;
  let dispatched = 0;
  const dispatchable: Issue[] = [];
  const triage: Issue[] = [];
  for (const finding of findings) {
    const ready =
      finding.verification !== undefined && dispatched < opts.maxAuditIssues;
    if (ready) dispatched++;
    const nn = String(next++).padStart(2, "0");
    const path = join(opts.issuesDir, `${nn}-${slugify(finding.title)}.md`);
    const lines = [
      `# ${nn} — ${finding.title}`,
      "",
      `Status: ${ready ? "ready-for-agent" : "needs-triage"}`,
      "Depends-on: none",
      ...(finding.verification === undefined
        ? []
        : [`Verification: ${finding.verification}`]),
      "",
      `Audit finding emitted by the ${finding.auditor} auditor.`,
      "",
      finding.body,
      "",
    ];
    writeFileSync(path, lines.join("\n"));
    const result = parseIssueFile(path);
    if (result.kind !== "valid") {
      throw new Error(`audit issue ${path} does not parse: ${result.problems.join("; ")}`);
    }
    (ready ? dispatchable : triage).push(result.issue);
  }
  return { dispatchable, triage };
}
