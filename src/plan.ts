import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseIssueFile, type Issue } from "./issue";

export interface Plan {
  dir: string;
  feature: string;
  issues: Map<number, Issue>;
  /** Issue numbers in a dependency-respecting order. */
  order: number[];
}

export type PlanLoadResult =
  | { kind: "valid"; plan: Plan }
  | { kind: "invalid"; problems: string[] };

export function loadPlan(dir: string): PlanLoadResult {
  const problems: string[] = [];

  if (!existsSync(join(dir, "PRD.md"))) {
    problems.push(`missing PRD.md in ${dir}`);
  }

  const issuesDir = join(dir, "issues");
  if (!existsSync(issuesDir)) {
    problems.push(`missing issues/ directory in ${dir}`);
    return { kind: "invalid", problems };
  }

  const issues = new Map<number, Issue>();
  const files = readdirSync(issuesDir)
    .filter((f) => f.endsWith(".md"))
    .toSorted();
  for (const file of files) {
    const result = parseIssueFile(join(issuesDir, file));
    if (result.kind === "invalid") {
      problems.push(`issue ${file}: ${result.problems.join("; ")}`);
      continue;
    }
    if (issues.has(result.issue.number)) {
      problems.push(`issue ${file}: duplicate issue number ${result.issue.number}`);
      continue;
    }
    issues.set(result.issue.number, result.issue);
  }

  for (const issue of issues.values()) {
    for (const dep of issue.dependsOn) {
      if (!issues.has(dep)) {
        problems.push(
          `issue ${issue.number}: Depends-on references missing issue ${dep}`,
        );
      }
    }
  }

  const order = topologicalOrder(issues);
  if (order === undefined) {
    const inCycle = findCycleMembers(issues);
    problems.push(`dependency cycle involving issues: ${inCycle.join(", ")}`);
  }

  if (problems.length > 0 || order === undefined) {
    return { kind: "invalid", problems };
  }

  return {
    kind: "valid",
    plan: { dir, feature: basename(dir), issues, order },
  };
}

/** Kahn's algorithm; returns undefined if a cycle prevents a full order. */
function topologicalOrder(issues: Map<number, Issue>): number[] | undefined {
  const remaining = new Map<number, Set<number>>();
  for (const issue of issues.values()) {
    remaining.set(
      issue.number,
      new Set(issue.dependsOn.filter((dep) => issues.has(dep))),
    );
  }
  const order: number[] = [];
  while (remaining.size > 0) {
    // Lowest ready issue number first, so the order follows plan authoring.
    const next = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([n]) => n)
      .toSorted((a, b) => a - b)[0];
    if (next === undefined) return undefined;
    order.push(next);
    remaining.delete(next);
    for (const deps of remaining.values()) deps.delete(next);
  }
  return order;
}

function findCycleMembers(issues: Map<number, Issue>): number[] {
  const remaining = new Map<number, Set<number>>();
  for (const issue of issues.values()) {
    remaining.set(
      issue.number,
      new Set(issue.dependsOn.filter((dep) => issues.has(dep))),
    );
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [n, deps] of remaining) {
      if (deps.size === 0) {
        remaining.delete(n);
        for (const other of remaining.values()) other.delete(n);
        changed = true;
      }
    }
  }
  return [...remaining.keys()].toSorted((a, b) => a - b);
}

/**
 * Transitive dependencies of an issue that are not `done`.
 * Used to decide executability and to skip dependents of a failed issue.
 */
export function blockedBy(plan: Plan, issueNumber: number): number[] {
  const issue = plan.issues.get(issueNumber);
  if (!issue) throw new Error(`Unknown issue number ${issueNumber}`);
  const blocked = new Set<number>();
  const visit = (deps: number[]) => {
    for (const dep of deps) {
      const depIssue = plan.issues.get(dep);
      if (!depIssue || blocked.has(dep)) continue;
      if (depIssue.status !== "done") blocked.add(dep);
      visit(depIssue.dependsOn);
    }
  };
  visit(issue.dependsOn);
  return [...blocked].toSorted((a, b) => a - b);
}
