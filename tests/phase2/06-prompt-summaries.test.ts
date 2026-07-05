import { describe, expect, test } from "bun:test";
import type { Issue } from "../../src/issue";
import { buildPrompt } from "../../src/prompt";

const issue: Issue = {
  number: 4,
  slug: "next-thing",
  title: "04 — next-thing",
  status: "ready-for-agent",
  dependsOn: [],
  verification: "bun test tests/next.test.ts",
  body: "Build the next thing.",
  path: "/tmp/nowhere/04-next-thing.md",
  arming: "auto",
} as Issue;

describe("phase 2 prompt: reviewer summaries", () => {
  test("summary present renders `- title: summary (files)`", () => {
    const prompt = buildPrompt(
      issue,
      [
        {
          number: 1,
          title: "01 — base",
          files: ["src/base.ts (+10/-0)"],
          summary: "base module exposes loadBase()",
        },
      ],
      [],
    );
    expect(prompt).toContain("- 01 — base: base module exposes loadBase() (src/base.ts (+10/-0))");
  });

  test("summary absent keeps the mechanical fallback", () => {
    const prompt = buildPrompt(
      issue,
      [{ number: 1, title: "01 — base", files: ["src/base.ts (+10/-0)"] }],
      [],
    );
    expect(prompt).toContain("- 01 — base: src/base.ts (+10/-0)");
  });
});

describe("phase 2 prompt: armed tests protection", () => {
  test("armingFiles renders a do-not-modify section listing every file", () => {
    const prompt = buildPrompt(issue, [], [], {
      armingFiles: ["tests/armed-04.test.ts", "tests/armed-04-helpers.ts"],
    });
    expect(prompt).toContain("Armed tests");
    expect(prompt).toContain("tests/armed-04.test.ts");
    expect(prompt).toContain("tests/armed-04-helpers.ts");
    expect(prompt.toLowerCase()).toContain("do not modify");
  });

  test("no armingFiles, no section", () => {
    const withEmpty = buildPrompt(issue, [], [], { armingFiles: [] });
    const without = buildPrompt(issue, [], []);
    expect(withEmpty).not.toContain("Armed tests");
    expect(without).not.toContain("Armed tests");
  });

  test("arming section survives the size cap", () => {
    const noise = Array.from({ length: 200 }, (_, i) => ({
      number: i + 1,
      title: `0${i} — noise`,
      files: [`src/noise-${i}.ts`],
      summary: "x".repeat(200),
    }));
    const prompt = buildPrompt(issue, noise, [], {
      armingFiles: ["tests/armed-04.test.ts"],
    });
    expect(prompt).toContain("tests/armed-04.test.ts");
    expect(prompt.length).toBeLessThanOrEqual(24_000);
  });
});
