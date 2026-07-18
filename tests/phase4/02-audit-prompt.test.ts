import { describe, expect, test } from "bun:test";
import type { Issue } from "../../src/issue";
import {
  buildAuditPrompt,
  buildFixerPrompt,
  buildPrompt,
  MAX_PROMPT_CHARS,
  type DoneSummary,
} from "../../src/prompt";

const prd = "# PRD: Toy feature\n\nGoal: exercise the audit prompt.";
const diff = "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n";

describe("buildAuditPrompt", () => {
  test("architect: framing, Finding template, PRD and diff present", () => {
    const { prompt, truncated } = buildAuditPrompt({ role: "architect", prd, diff });
    expect(truncated).toBe(false);
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("NEVER edit files");
    expect(prompt).toContain("NEVER run git commands");
    expect(prompt).toContain("Architect");
    expect(prompt).toContain("architecture");
    expect(prompt).toContain("```finding");
    expect(prompt).toContain("Title: <one line>");
    expect(prompt).toContain("Verification: <executable command, or empty if none applies>");
    expect(prompt).toContain("## Acceptance criteria");
    expect(prompt).toContain(prd);
    expect(prompt).toContain(diff.trimEnd());
  });

  test("security_auditor: vulnerability-hunt framing", () => {
    const { prompt, truncated } = buildAuditPrompt({ role: "security_auditor", prd, diff });
    expect(truncated).toBe(false);
    expect(prompt).toContain("Security Auditor");
    expect(prompt).toContain("auth bypass");
    expect(prompt).toContain("IDOR");
    expect(prompt).toContain("XSS");
    expect(prompt).toContain("secrets");
    expect(prompt).toContain("unvalidated input");
    expect(prompt).toContain("```finding");
    expect(prompt).toContain(prd);
    expect(prompt).toContain(diff.trimEnd());
  });

  test("oversized diff is tail-truncated under MAX_PROMPT_CHARS with truncated: true", () => {
    const bigDiff = "early diff lines\n" + "x".repeat(MAX_PROMPT_CHARS * 2) + "\nfinal diff line";
    const { prompt, truncated } = buildAuditPrompt({ role: "architect", prd, diff: bigDiff });
    expect(truncated).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain("[...truncated...]");
    expect(prompt).toContain("final diff line");
    expect(prompt).not.toContain("early diff lines");
    // Framing and PRD survive capping.
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("```finding");
    expect(prompt).toContain(prd);
  });

  test("is a pure function (same inputs, same output)", () => {
    const a = buildAuditPrompt({ role: "security_auditor", prd, diff });
    const b = buildAuditPrompt({ role: "security_auditor", prd, diff });
    expect(a.prompt).toBe(b.prompt);
    expect(a.truncated).toBe(b.truncated);
  });

  test("snapshot: architect", () => {
    expect(buildAuditPrompt({ role: "architect", prd, diff }).prompt).toMatchSnapshot();
  });

  test("snapshot: security_auditor", () => {
    expect(buildAuditPrompt({ role: "security_auditor", prd, diff }).prompt).toMatchSnapshot();
  });
});

describe("existing prompts unchanged", () => {
  function issue(): Issue {
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
    };
  }

  const doneSummaries: DoneSummary[] = [
    {
      number: 1,
      title: "01 — Scaffold server",
      files: ["src/server.ts (+40/-0)", "package.json (+5/-1)"],
    },
  ];

  test("buildPrompt snapshot unchanged", () => {
    expect(buildPrompt(issue(), doneSummaries, ["boom"])).toMatchSnapshot();
  });

  test("buildFixerPrompt snapshot unchanged", () => {
    expect(buildFixerPrompt(issue(), doneSummaries, ["boom"])).toMatchSnapshot();
  });
});
