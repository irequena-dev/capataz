import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const ISSUE_STATUSES = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "in-progress",
  "done",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export type IssueArming = "auto" | "none";

export interface Issue {
  number: number;
  slug: string;
  title: string;
  status: IssueStatus;
  dependsOn: number[];
  /** Required unless the issue is `done`. */
  verification: string | undefined;
  arming: IssueArming;
  body: string;
  path: string;
}

export type IssueParseResult =
  | { kind: "valid"; issue: Issue }
  | { kind: "invalid"; path: string; problems: string[] };

const FILE_NAME_PATTERN = /^(\d+)-(.+)\.md$/;
const STATUS_LINE = /^Status:\s*(.*)$/;
const DEPENDS_LINE = /^Depends-on:\s*(.*)$/;
const VERIFICATION_LINE = /^Verification:\s*(.*)$/;
const ARMING_LINE = /^Arming:\s*(.*)$/;

function isIssueArming(value: string): value is IssueArming {
  return value === "auto" || value === "none";
}

function isIssueStatus(value: string): value is IssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(value);
}

export function parseIssueFile(path: string): IssueParseResult {
  const problems: string[] = [];
  const fileName = basename(path);
  const nameMatch = fileName.match(FILE_NAME_PATTERN);
  if (!nameMatch) {
    return { kind: "invalid", path, problems: [`file name "${fileName}" is not <NN>-<slug>.md`] };
  }
  const number = Number(nameMatch[1]);
  const slug = nameMatch[2]!;

  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");

  const title = lines
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim();
  if (title === undefined) problems.push("missing title (first `#` heading)");

  let status: IssueStatus | undefined;
  let dependsOn: number[] | undefined;
  let verification: string | undefined;
  let arming: IssueArming | undefined;
  const bodyLines: string[] = [];
  let seenTitle = false;

  for (const line of lines) {
    if (!seenTitle && line.startsWith("# ")) {
      seenTitle = true;
      continue;
    }
    const statusMatch = line.match(STATUS_LINE);
    if (statusMatch && status === undefined) {
      const raw = statusMatch[1]!.trim();
      if (isIssueStatus(raw)) status = raw;
      else problems.push(`unknown status "${raw}"`);
      continue;
    }
    const dependsMatch = line.match(DEPENDS_LINE);
    if (dependsMatch && dependsOn === undefined) {
      const raw = dependsMatch[1]!.trim();
      if (raw === "none" || raw === "") {
        dependsOn = [];
      } else {
        dependsOn = [];
        for (const part of raw.split(",").map((p) => p.trim())) {
          const n = Number(part);
          if (Number.isInteger(n) && n > 0) dependsOn.push(n);
          else problems.push(`invalid Depends-on entry "${part}"`);
        }
      }
      continue;
    }
    const verificationMatch = line.match(VERIFICATION_LINE);
    if (verificationMatch && verification === undefined) {
      verification = verificationMatch[1]!.trim();
      continue;
    }
    const armingMatch = line.match(ARMING_LINE);
    if (armingMatch && arming === undefined) {
      const raw = armingMatch[1]!.trim();
      if (isIssueArming(raw)) arming = raw;
      else problems.push(`unknown Arming "${raw}"`);
      continue;
    }
    bodyLines.push(line);
  }

  if (status === undefined && !problems.some((p) => p.startsWith("unknown status"))) {
    problems.push("missing Status: line");
  }
  if ((verification === undefined || verification === "") && status !== "done") {
    problems.push("missing Verification: command");
  }

  if (problems.length > 0 || status === undefined) {
    return { kind: "invalid", path, problems };
  }

  return {
    kind: "valid",
    issue: {
      number,
      slug,
      title: title ?? "",
      status,
      dependsOn: dependsOn ?? [],
      verification: verification === "" ? undefined : verification,
      arming: arming ?? "auto",
      body: bodyLines.join("\n").trim(),
      path,
    },
  };
}

export function writeIssueStatus(path: string, status: IssueStatus): void {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const index = lines.findIndex((line) => STATUS_LINE.test(line));
  if (index === -1) throw new Error(`No Status: line in ${path}`);
  lines[index] = `Status: ${status}`;
  writeFileSync(path, lines.join("\n"));
}
