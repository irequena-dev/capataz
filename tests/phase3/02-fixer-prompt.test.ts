import { describe, expect, test } from "bun:test";
import type { Issue } from "../../src/issue";
import { buildFixerPrompt, type DoneSummary } from "../../src/prompt";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 3,
    slug: "add-endpoint",
    title: "03 — Add the /health endpoint",
    status: "ready-for-agent",
    dependsOn: [1],
    verification: "bun test tests/health.test.ts",
    arming: "auto",
    body: "Add a GET /health endpoint returning 200 with body `ok`.\n\n## Acceptance criteria\n\n- Returns 200.",
    path: "/plan/issues/03-add-endpoint.md",
    ...overrides,
  };
}

const doneSummaries: DoneSummary[] = [
  {
    number: 1,
    title: "01 — Scaffold server",
    files: ["src/server.ts (+40/-0)", "package.json (+5/-1)"],
  },
  { number: 2, title: "02 — Add router", files: ["src/router.ts (+12/-0)"] },
];

const armingFiles = ["tests/health.test.ts", "tests/health-edge.test.ts"];

describe("buildFixerPrompt", () => {
  test("contains the repair framing, issue body, and verification command", () => {
    const prompt = buildFixerPrompt(issue(), [], ["boom"], { armingFiles });
    expect(prompt).toContain("You are a Fixer");
    expect(prompt).toContain("previous model");
    expect(prompt).toContain("already in the working tree");
    expect(prompt).toContain("repair");
    expect(prompt).toContain("Add a GET /health endpoint");
    expect(prompt).toContain("bun test tests/health.test.ts");
    expect(prompt).toContain("NEVER run git commands");
  });

  test("lists every armed file", () => {
    const prompt = buildFixerPrompt(issue(), [], [], { armingFiles });
    expect(prompt).toContain("- tests/health.test.ts");
    expect(prompt).toContain("- tests/health-edge.test.ts");
    expect(prompt).toContain("do not modify or delete");
  });

  test("no arming files → no do-not-touch list, framing still present", () => {
    const prompt = buildFixerPrompt(issue(), [], []);
    expect(prompt).not.toContain("Armed tests");
    expect(prompt).toContain("You are a Fixer");
  });

  test("renders done summaries like buildPrompt", () => {
    const prompt = buildFixerPrompt(issue(), doneSummaries, []);
    expect(prompt).toContain("- 01 — Scaffold server: src/server.ts (+40/-0), package.json (+5/-1)");
    expect(prompt).toContain("- 02 — Add router: src/router.ts (+12/-0)");
  });

  test("contains every failure block when under the cap", () => {
    const failures = ["failure one output", "failure two output", "failure three output"];
    const prompt = buildFixerPrompt(issue(), [], failures);
    expect(prompt).toContain("Attempt 1");
    expect(prompt).toContain("failure one output");
    expect(prompt).toContain("Attempt 2");
    expect(prompt).toContain("failure two output");
    expect(prompt).toContain("Attempt 3");
    expect(prompt).toContain("failure three output");
  });

  test("oversized failure history stays within the cap and keeps the newest failure", () => {
    const failures = Array.from({ length: 50 }, (_, i) => `failure output ${i} `.repeat(100));
    const maxChars = 4_000;
    const prompt = buildFixerPrompt(issue(), [], failures, { maxChars });
    expect(prompt.length).toBeLessThanOrEqual(maxChars);
    expect(prompt).toContain("failure output 49");
    expect(prompt).not.toContain("failure output 0 ");
  });

  test("failures are tail-truncated (keeps the end of the output)", () => {
    const long = "early diagnostics\n" + "x".repeat(10_000) + "\nFINAL VERDICT: 3 tests failed";
    const prompt = buildFixerPrompt(issue(), [], [long], { maxChars: 6_000 });
    expect(prompt).toContain("FINAL VERDICT: 3 tests failed");
    expect(prompt).not.toContain("early diagnostics");
  });

  test("is a pure function (same inputs, same output)", () => {
    const a = buildFixerPrompt(issue(), doneSummaries, ["boom"], { armingFiles });
    const b = buildFixerPrompt(issue(), doneSummaries, ["boom"], { armingFiles });
    expect(a).toBe(b);
  });

  test("snapshot", () => {
    const failures = ["FAIL tests/health.test.ts\nexpected 200, got 404"];
    expect(buildFixerPrompt(issue(), doneSummaries, failures, { armingFiles })).toMatchSnapshot();
  });
});
