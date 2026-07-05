import { spawn } from "node:child_process";
import type { Backend } from "./config";

export type InvokeResult =
  | { kind: "ok"; stdout: string; stderr: string; durationMs: number; exitCode: number }
  | {
      kind: "error";
      stdout: string;
      stderr: string;
      durationMs: number;
      exitCode: number | undefined;
    }
  | { kind: "timeout"; stdout: string; stderr: string; durationMs: number };

export interface InvokeOptions {
  cwd: string;
}

const PROMPT_PLACEHOLDER = "{prompt}";

/**
 * Spawn a backend's command with the prompt substituted for `{prompt}` in the
 * argv template (or piped to stdin when no placeholder is present). Never
 * interpolates the prompt into a shell string. On timeout, kills the whole
 * process tree and reports it as a result rather than throwing.
 */
export function invoke(
  backend: Backend,
  prompt: string,
  options: InvokeOptions,
): Promise<InvokeResult> {
  const hasPlaceholder = backend.command.some((arg) => arg.includes(PROMPT_PLACEHOLDER));
  const argv = backend.command.map((arg) =>
    arg.replaceAll(PROMPT_PLACEHOLDER, prompt),
  );
  const [command, ...args] = argv;
  if (!command) throw new Error("Backend command is empty");

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...backend.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so a timeout can kill the whole tree.
      detached: true,
    });

    // Collect raw Buffers and decode once at the end, so a multi-byte UTF-8
    // character split across chunk boundaries is never corrupted.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let spawnError: Error | undefined;

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, backend.timeout_minutes * 60_000);

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        resolve({ kind: "timeout", stdout, stderr, durationMs });
      } else if (spawnError) {
        resolve({
          kind: "error",
          stdout,
          stderr: stderr || spawnError.message,
          durationMs,
          exitCode: undefined,
        });
      } else if (code === 0) {
        resolve({ kind: "ok", stdout, stderr, durationMs, exitCode: 0 });
      } else {
        resolve({ kind: "error", stdout, stderr, durationMs, exitCode: code ?? undefined });
      }
    });

    if (!hasPlaceholder) child.stdin.write(prompt);
    child.stdin.end();
  });
}
