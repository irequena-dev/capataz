import { describe, expect, test } from "bun:test";
import type { Backend } from "../src/config";
import { invoke } from "../src/invoker";

function backend(command: string[], overrides: Partial<Backend> = {}): Backend {
  return { command, env: {}, timeout_minutes: 1, ...overrides };
}

const cwd = process.cwd();

describe("invoke", () => {
  test("replaces {prompt} placeholder as an argv element", async () => {
    const result = await invoke(backend(["printf", "%s", "{prompt}"]), "hello world", { cwd });
    expect(result.kind).toBe("ok");
    expect(result.stdout).toBe("hello world");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("prompt with shell metacharacters is never interpreted", async () => {
    const evil = `"; touch /tmp/capataz-pwned; echo "$(id)' | rm -rf`;
    const result = await invoke(backend(["printf", "%s", "{prompt}"]), evil, { cwd });
    expect(result.kind).toBe("ok");
    expect(result.stdout).toBe(evil);
  });

  test("without placeholder, prompt goes to stdin", async () => {
    const result = await invoke(backend(["cat"]), "from stdin", { cwd });
    expect(result.kind).toBe("ok");
    expect(result.stdout).toBe("from stdin");
  });

  test("multi-byte character split across two writes is captured intact", async () => {
    // ñ is \303\261 in UTF-8; flush each byte separately (stdout and stderr)
    const result = await invoke(
      backend([
        "sh",
        "-c",
        "printf '\\303'; printf '\\303' >&2; sleep 0.1; printf '\\261'; printf '\\261' >&2",
      ]),
      "x",
      { cwd },
    );
    expect(result.kind).toBe("ok");
    expect(result.stdout).toBe("ñ");
    expect(result.stderr).toBe("ñ");
  });

  test("non-zero exit yields kind error with exitCode", async () => {
    const result = await invoke(backend(["sh", "-c", "echo oops >&2; exit 3"]), "x", { cwd });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("oops");
  });

  test("unknown command yields kind error, not an exception", async () => {
    const result = await invoke(backend(["capataz-no-such-binary-xyz"]), "x", { cwd });
    expect(result.kind).toBe("error");
  });

  test("timeout kills the process and returns kind timeout", async () => {
    const started = Date.now();
    const result = await invoke(
      backend(["sleep", "30"], { timeout_minutes: 0.005 }),
      "x",
      { cwd },
    );
    expect(result.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("backend env is merged over the process env", async () => {
    const result = await invoke(
      backend(["sh", "-c", 'printf "%s:%s" "$CAPATAZ_TEST_VAR" "${PATH:+has-path}"'], {
        env: { CAPATAZ_TEST_VAR: "injected" },
      }),
      "x",
      { cwd },
    );
    expect(result.kind).toBe("ok");
    expect(result.stdout).toBe("injected:has-path");
  });

  test("runs in the given cwd", async () => {
    const result = await invoke(backend(["pwd"]), "x", { cwd: "/tmp" });
    expect(result.kind).toBe("ok");
    expect(result.stdout.trim()).toBe("/tmp");
  });
});
