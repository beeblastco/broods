/**
 * AWS Lambda entry for the sandbox-tier tool runner. It runs an uploaded account
 * tool bundle (passed inline in the invoke event) in a per-invocation child Node
 * process with a scrubbed env and a fresh TMPDIR, and streams the child's raw
 * NDJSON frames back to the core invoker as they are written, so an
 * async-generator tool's yields reach the agent loop live. The child is a
 * containment layer, not a trust boundary — it runs same-UID, so keep this
 * function's execution role empty and assume anything it can reach is reachable
 * by tenant code. Execution logic lives in child-runner.mjs; keep this file to
 * spawn + forward + clean up.
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
// A streamed response may run to 200 MB, so this is a runaway-tool bound rather
// than the old 6 MB buffered-invoke ceiling. Core holds one frame at a time.
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

// streamifyResponse is injected by the Node managed runtime. Falling back to the
// identity wrapper keeps the module importable (and testable) off Lambda.
const streamifyResponse =
  globalThis.awslambda?.streamifyResponse ?? ((fn) => fn);

export const handler = streamifyResponse(async (event, responseStream) => {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.toolName !== "string"
  ) {
    endWithError(responseStream, "invalid tool runner event");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "broods-tool-"));
  try {
    await runChild(event, home, responseStream);
  } catch (error) {
    endWithError(
      responseStream,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function childRunnerPath() {
  const root = process.env.LAMBDA_TASK_ROOT;
  return root
    ? join(root, "child-runner.mjs")
    : fileURLToPath(new URL("./child-runner.mjs", import.meta.url));
}

async function runChild(event, home, responseStream) {
  return await new Promise((resolve) => {
    // detached puts the child in its own process group so killGroup can reap the
    // grandchildren too; a survivor outlives the invocation in a warm sandbox.
    const child = spawn(process.execPath, [childRunnerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: scrubbedEnv(home),
      detached: true,
    });
    let forwardedBytes = 0;
    let stderr = "";
    let overflow = false;
    let stopped = false;
    // Abandon forwarding and let the pipe run dry: a paused stdout never emits
    // "end", so the child would never reach "close" and the run would hang.
    const stopForwarding = () => {
      stopped = true;
      child.stdout.resume();
      killGroup(child);
    };
    const timeout = setTimeout(stopForwarding, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stopped) return;
      forwardedBytes += chunk.length;
      if (forwardedBytes > OUTPUT_LIMIT_BYTES) {
        overflow = true;
        stopForwarding();
        return;
      }
      // Pause on a full response buffer so a chatty tool cannot outrun the
      // stream; the child's own stdout pipe then applies the backpressure.
      if (!responseStream.write(chunk)) {
        child.stdout.pause();
        responseStream.once("drain", () => child.stdout.resume());
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      endWithError(
        responseStream,
        error instanceof Error ? error.message : String(error),
      );
      resolve();
    });
    // "close", not "exit": exit fires while stdout may still hold buffered data,
    // and pausing for backpressure widens that window into lost output.
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      // The child is gone, but anything it spawned is not. Reap the group before
      // returning so nothing survives into the next tenant's invocation.
      killGroup(child);
      if (overflow) {
        endWithError(
          responseStream,
          "custom tool sandbox output exceeded limit",
        );
      } else if (forwardedBytes === 0) {
        endWithError(
          responseStream,
          stderr.trim() ||
            (signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`),
        );
      } else {
        responseStream.end();
      }
      resolve();
    });

    // A child that exits before reading stdin makes end() emit EPIPE; an
    // unhandled stream error would crash the handler instead of returning a frame.
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

// Handler-side failures speak the same NDJSON protocol as the child, so core has
// exactly one frame format to parse whether the run died before or during output.
function endWithError(responseStream, error) {
  responseStream.write(`${JSON.stringify({ t: "error", error })}\n`);
  responseStream.end();
}

// SIGKILL the child's whole process group, not just the child. Falls back to the
// child alone if the group is already gone (ESRCH) or was never detached.
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
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
