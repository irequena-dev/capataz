import { describe, expect, test } from "bun:test";
import type { Issue } from "../src/issue";
import { buildPrompt, MAX_PROMPT_CHARS, type DoneSummary } from "../src/prompt";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 3,
    slug: "add-endpoint",
    title: "03 — Add the /health endpoint",
    status: "ready-for-agent",
    dependsOn: [1],
    verification: "bun test tests/health.test.ts",
    body: "Add a GET /health endpoint returning 200 with body `ok`.\n\n## Acceptance criteria\n\n- Returns 200.",
    path: "/plan/issues/03-add-endpoint.md",
    ...overrides,
  };
}

const doneSummaries: DoneSummary[] = [
  { number: 1, title: "01 — Scaffold server", files: ["src/server.ts", "package.json"] },
  { number: 2, title: "02 — Add router", files: ["src/router.ts"] },
];

describe("buildPrompt", () => {
  test("first attempt: snapshot", () => {
    expect(buildPrompt(issue(), doneSummaries, [])).toMatchSnapshot();
  });

  test("retry attempt with failures: snapshot", () => {
    const failures = ["FAIL tests/health.test.ts\nexpected 200, got 404"];
    expect(buildPrompt(issue(), doneSummaries, failures)).toMatchSnapshot();
  });

  test("contains the hard framing and the verification command", () => {
    const prompt = buildPrompt(issue(), [], []);
    expect(prompt).toContain("ONLY this issue");
    expect(prompt).toContain("Do not modify tests");
    expect(prompt).toContain("bun test tests/health.test.ts");
  });

  test("contains done summaries as `- <NN> <title>: <files>` lines", () => {
    const prompt = buildPrompt(issue(), doneSummaries, []);
    expect(prompt).toContain("- 01 — Scaffold server: src/server.ts, package.json");
    expect(prompt).toContain("- 02 — Add router: src/router.ts");
  });

  test("is a pure function (same inputs, same output)", () => {
    const a = buildPrompt(issue(), doneSummaries, ["boom"]);
    const b = buildPrompt(issue(), doneSummaries, ["boom"]);
    expect(a).toBe(b);
  });

  test("caps total size, dropping summaries/failures oldest-first, never the body", () => {
    const body = "IMPORTANT BODY ".repeat(50).trim();
    const bigIssue = issue({ body });
    const manySummaries: DoneSummary[] = Array.from({ length: 200 }, (_, i) => ({
      number: i + 1,
      title: `${String(i + 1).padStart(2, "0")} — Done issue number ${i + 1}`,
      files: [`src/file-${i + 1}.ts`],
    }));
    const failures = Array.from({ length: 50 }, (_, i) => `failure output ${i} `.repeat(100));
    const maxChars = 4_000;
    const prompt = buildPrompt(bigIssue, manySummaries, failures, { maxChars });
    expect(prompt.length).toBeLessThanOrEqual(maxChars);
    // the body is never truncated
    expect(prompt).toContain(body);
    // newest failure survives, oldest dropped
    expect(prompt).toContain("failure output 49");
    expect(prompt).not.toContain("failure output 0 ");
    // newest summary preferred over oldest
    expect(prompt).not.toContain("Done issue number 1 ");
  });

  test("failures are tail-truncated (keeps the end of the output)", () => {
    const long = "early diagnostics\n" + "x".repeat(10_000) + "\nFINAL VERDICT: 3 tests failed";
    const prompt = buildPrompt(issue(), [], [long], { maxChars: 6_000 });
    expect(prompt).toContain("FINAL VERDICT: 3 tests failed");
    expect(prompt).not.toContain("early diagnostics");
  });

  test("default cap constant is exported and sane", () => {
    expect(MAX_PROMPT_CHARS).toBeGreaterThan(1_000);
  });
});
