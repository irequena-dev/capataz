import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedBy, loadPlan } from "../src/plan";

interface FakeIssue {
  number: string;
  slug: string;
  status?: string;
  dependsOn?: string;
  verification?: string | null;
}

function makePlan(issues: FakeIssue[]): string {
  const dir = mkdtempSync(join(tmpdir(), "capataz-plan-"));
  writeFileSync(join(dir, "PRD.md"), "# PRD: test plan\n");
  mkdirSync(join(dir, "issues"));
  for (const issue of issues) {
    const lines = [
      `# ${issue.number} — ${issue.slug}`,
      "",
      `Status: ${issue.status ?? "ready-for-agent"}`,
      `Depends-on: ${issue.dependsOn ?? "none"}`,
    ];
    if (issue.verification !== null) {
      lines.push(`Verification: ${issue.verification ?? "true"}`);
    }
    lines.push("", `Body of ${issue.slug}.`);
    writeFileSync(join(dir, "issues", `${issue.number}-${issue.slug}.md`), lines.join("\n"));
  }
  return dir;
}

describe("loadPlan", () => {
  test("valid plan: dependency-respecting order", () => {
    const dir = makePlan([
      { number: "01", slug: "a" },
      { number: "02", slug: "b", dependsOn: "01" },
      { number: "03", slug: "c", dependsOn: "02" },
      { number: "04", slug: "d" },
    ]);
    const result = loadPlan(dir);
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    const order = result.plan.order;
    expect(order.toSorted()).toEqual([1, 2, 3, 4]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
  });

  test("feature name comes from the plan dir basename", () => {
    const dir = makePlan([{ number: "01", slug: "a" }]);
    const result = loadPlan(dir);
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(result.plan.feature).toBe(dir.split("/").at(-1)!);
  });

  test("reports ALL problems in one pass with issue numbers", () => {
    const dir = makePlan([
      { number: "01", slug: "a", verification: null },
      { number: "02", slug: "b", dependsOn: "99" },
      { number: "03", slug: "c", dependsOn: "04" },
      { number: "04", slug: "d", dependsOn: "03" },
    ]);
    const result = loadPlan(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    const all = result.problems.join("\n");
    expect(all).toMatch(/01.*Verification|Verification.*01/s);
    expect(all).toMatch(/99/);
    expect(all).toMatch(/cycle/i);
  });

  test("missing PRD.md is a problem", () => {
    const dir = makePlan([{ number: "01", slug: "a" }]);
    rmSync(join(dir, "PRD.md"));
    const result = loadPlan(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems.join(" ")).toMatch(/PRD/);
  });
});

describe("blockedBy", () => {
  test("returns transitive incomplete dependencies", () => {
    const dir = makePlan([
      { number: "01", slug: "a", status: "done" },
      { number: "02", slug: "b", dependsOn: "01" },
      { number: "03", slug: "c", dependsOn: "02" },
      { number: "04", slug: "d", dependsOn: "03" },
      { number: "05", slug: "e" },
    ]);
    const result = loadPlan(dir);
    if (result.kind !== "valid") throw new Error("expected valid");
    const plan = result.plan;
    // 01 is done: satisfies dependencies
    expect(blockedBy(plan, 2)).toEqual([]);
    // 03 blocked by 02; 04 blocked transitively by 03 and 02
    expect(blockedBy(plan, 3)).toEqual([2]);
    expect(blockedBy(plan, 4).toSorted()).toEqual([2, 3]);
    expect(blockedBy(plan, 5)).toEqual([]);
  });

  test("non-executable statuses block dependents", () => {
    const dir = makePlan([
      { number: "01", slug: "a", status: "needs-info" },
      { number: "02", slug: "b", dependsOn: "01" },
    ]);
    const result = loadPlan(dir);
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(blockedBy(result.plan, 2)).toEqual([1]);
  });
});
