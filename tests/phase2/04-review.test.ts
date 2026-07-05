import { describe, expect, test } from "bun:test";
import { buildReviewerPrompt, parseVerdict, reviewIssue } from "../../src/review";
import type { Backend } from "../../src/config";
import type { Issue } from "../../src/issue";
import type { InvokeFn } from "../../src/loop";

const issue: Issue = {
  number: 3,
  slug: "thing",
  title: "03 — thing",
  status: "in-progress",
  dependsOn: [],
  verification: "test -f impl.txt",
  body: "Create the thing. Acceptance: impl.txt exists and holds the thing.",
  path: "/tmp/nowhere/03-thing.md",
  arming: "auto",
} as Issue;

const backend: Backend = { command: ["rev-bin"], env: {}, timeout_minutes: 1 };

function result(stdout: string) {
  return { kind: "ok", stdout, stderr: "", durationMs: 5, exitCode: 0 } as const;
}

describe("parseVerdict", () => {
  test("approve with summary", () => {
    const verdict = parseVerdict(
      "Looked at the diff.\nVERDICT: approve\nSUMMARY: impl.txt now holds the thing\n",
    );
    expect(verdict).toEqual({ kind: "approve", summary: "impl.txt now holds the thing" });
  });

  test("reject with reason", () => {
    const verdict = parseVerdict("VERDICT: reject\nREASON: criteria 2 unmet\n");
    expect(verdict).toEqual({ kind: "reject", reason: "criteria 2 unmet" });
  });

  test("last VERDICT occurrence wins", () => {
    const verdict = parseVerdict(
      [
        "Thinking... a draft verdict:",
        "VERDICT: reject",
        "REASON: hmm wait",
        "Actually the diff is fine.",
        "VERDICT: approve",
        "SUMMARY: the thing exists in impl.txt",
      ].join("\n"),
    );
    expect(verdict.kind).toBe("approve");
  });

  test("approve without a SUMMARY is unparseable (fail-closed)", () => {
    expect(parseVerdict("VERDICT: approve\n").kind).toBe("unparseable");
  });

  test("reject without a REASON defaults to unspecified", () => {
    const verdict = parseVerdict("VERDICT: reject\n");
    expect(verdict).toEqual({ kind: "reject", reason: "unspecified" });
  });

  test("no verdict at all is unparseable", () => {
    expect(parseVerdict("The diff looks great, ship it!").kind).toBe("unparseable");
  });

  test("unknown verdict value is unparseable", () => {
    expect(parseVerdict("VERDICT: maybe\n").kind).toBe("unparseable");
  });

  test("tolerates whitespace and keyword casing", () => {
    const verdict = parseVerdict("  verdict:   approve  \n  summary:  it exists  \n");
    expect(verdict).toEqual({ kind: "approve", summary: "it exists" });
  });
});

describe("buildReviewerPrompt", () => {
  test("carries framing, criteria, diff, arming files and the output contract", () => {
    const prompt = buildReviewerPrompt({
      issue,
      diff: "+++ b/impl.txt\n+the thing",
      armingFiles: ["tests/armed-03.test.ts"],
    });
    expect(prompt).toContain("Reviewer");
    expect(prompt).toContain("Acceptance: impl.txt exists");
    expect(prompt).toContain("+the thing");
    expect(prompt).toContain("tests/armed-03.test.ts");
    expect(prompt).toContain("VERDICT:");
    expect(prompt).toContain("SUMMARY:");
    expect(prompt).toContain("REASON:");
    expect(prompt.toLowerCase()).toContain("read-only");
  });
});

describe("reviewIssue", () => {
  test("propagates a parseable approve", async () => {
    const invoke: InvokeFn = async () =>
      result("VERDICT: approve\nSUMMARY: impl.txt now holds the thing");
    const outcome = await reviewIssue({
      issue,
      backend,
      repoPath: "/tmp",
      invokeFn: invoke,
      diff: "diff",
      armingFiles: [],
    });
    expect(outcome).toEqual({ kind: "approve", summary: "impl.txt now holds the thing" });
  });

  test("junk output: one retry with contract reminder, then approve", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const invoke: InvokeFn = async (_backend, prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) return result("I like this diff a lot!");
      return result("VERDICT: approve\nSUMMARY: fine");
    };
    const outcome = await reviewIssue({
      issue,
      backend,
      repoPath: "/tmp",
      invokeFn: invoke,
      diff: "diff",
      armingFiles: [],
    });
    expect(outcome.kind).toBe("approve");
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("VERDICT:");
  });

  test("junk output twice rejects fail-closed", async () => {
    const invoke: InvokeFn = async () => result("no verdict here");
    const outcome = await reviewIssue({
      issue,
      backend,
      repoPath: "/tmp",
      invokeFn: invoke,
      diff: "diff",
      armingFiles: [],
    });
    expect(outcome.kind).toBe("reject");
    if (outcome.kind !== "reject") throw new Error("unreachable");
    expect(outcome.reason).toContain("fail-closed");
  });

  test("timeouts reject fail-closed, never approve", async () => {
    const invoke: InvokeFn = async () => ({
      kind: "timeout",
      stdout: "VERDICT: approve\nSUMMARY: half-written",
      stderr: "",
      durationMs: 10,
    });
    const outcome = await reviewIssue({
      issue,
      backend,
      repoPath: "/tmp",
      invokeFn: invoke,
      diff: "diff",
      armingFiles: [],
    });
    expect(outcome.kind).toBe("reject");
  });
});
