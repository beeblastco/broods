/**
 * AWS Lambda entry for the sandbox-tier tool runner. It runs an uploaded account
 * tool bundle (passed inline in the invoke event) in a per-invocation child Node
 * process with a scrubbed env and a fresh TMPDIR, then returns the child's raw
 * NDJSON frame stream to the core invoker. The child boundary is the untrusted-
 * code isolation: user code cannot read this function's AWS credentials or leak
 * state into the next (cross-tenant) warm invocation. Execution logic lives in
 * child-runner.mjs; keep this file to spawn + collect + clean up.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Hard bound on the whole invocation; the child self-aborts CHILD_GRACE_MS
// earlier via TOOL_RUNNER_TIMEOUT_SECONDS so ctx.abortSignal fires (letting the
// tool settle) before this SIGKILL. The Lambda's own timeout sits above both so
// the handler always wins and returns a clean error frame.
const RUN_TIMEOUT_MS = 30_000;
const CHILD_GRACE_MS = 2_000;
// Well under Lambda's 6 MB sync-response cap: the NDJSON is re-embedded as a JSON
// string in { stdout }, and escaping (quotes/backslashes) inflates it.
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export const handler = async (event) => {
  if (!event || typeof event !== "object" || typeof event.toolName !== "string") {
    return { error: "invalid tool runner event" };
  }
  const home = mkdtempSync(join(tmpdir(), "broods-tool-"));
  try {
    return await runChild(event, home);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

function childRunnerPath() {
  const root = process.env.LAMBDA_TASK_ROOT;
  return root
    ? join(root, "child-runner.mjs")
    : fileURLToPath(new URL("./child-runner.mjs", import.meta.url));
}

async function runChild(event, home) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [childRunnerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: scrubbedEnv(home),
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let overflow = false;
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, RUN_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > OUTPUT_LIMIT_BYTES) {
        overflow = true;
        try {
          child.kill("SIGKILL");
        } catch {}
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ error: error instanceof Error ? error.message : String(error) });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (overflow) {
        resolve({ error: "custom tool sandbox output exceeded limit" });
        return;
      }
      if (!stdout) {
        resolve({
          error:
            stderr.trim() ||
            (signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`),
        });
        return;
      }
      resolve({ stdout });
    });

    // A child that exits before reading stdin makes end() emit EPIPE; an
    // unhandled stream error would crash the handler instead of returning { error }.
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

// The child's cooperative deadline: the smaller of our grace-adjusted bound and
// any operator override, floored at 1s.
function childTimeoutSeconds() {
  const graceBound = Math.floor((RUN_TIMEOUT_MS - CHILD_GRACE_MS) / 1000);
  const override = Number(process.env.TOOL_RUNNER_TIMEOUT_SECONDS);
  const seconds =
    Number.isFinite(override) && override > 0
      ? Math.min(graceBound, override)
      : graceBound;
  return String(Math.max(1, seconds));
}

// A minimal, credential-free env. Explicitly no AWS_*/Lambda vars so user code
// cannot reach the execution role; HOME/TMPDIR point at the per-run scratch dir.
function scrubbedEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    NODE_ENV: "production",
    TOOL_RUNNER_TIMEOUT_SECONDS: childTimeoutSeconds(),
  };
}
