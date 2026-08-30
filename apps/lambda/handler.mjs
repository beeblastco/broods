/**
 * AWS Lambda entry for the hosted MCP runner. Resolves the uploaded bundle,
 * runs the request in a child Node process with a scrubbed env and a fresh
 * per-call TMPDIR, and streams the child's raw NDJSON frames to core. The
 * child stays warm keyed by accountId + sha256 (#189), bounded and retired on
 * any failure. It is a containment layer, not a trust boundary — same-UID, so
 * keep the execution role empty. Execution logic lives in child-runner.mjs;
 * keep this file to spawn + forward + clean up.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Hard bound on the whole invocation; the child self-aborts CHILD_GRACE_MS
// earlier via TOOL_RUNNER_TIMEOUT_SECONDS so the request signal fires (letting
// the run settle) before this SIGKILL. The Lambda's own timeout sits above both so
// the handler always wins and returns a clean error frame.
const RUN_TIMEOUT_MS = 30_000;
const CHILD_GRACE_MS = 2_000;
// Deliberately far below Lambda's 200 MB streamed ceiling: every forwarded byte
// lands in core's memory and then in an agent's context, so this bounds a run.
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

// Reuse bounds (#189), env-overridable; MCP_CHILD_REUSE=0 is the kill switch
// back to one process per invocation.
const DEFAULT_MAX_CHILD_CALLS = 64;
const DEFAULT_CHILD_IDLE_SECONDS = 300;

// Terminal frames are the only lines the child itself writes, with `t` first
// (emitTerminal pins that key order), so a byte compare on the line prefix
// spots the end of a run without parsing a multi-megabyte frame.
const FINAL_PREFIX = Buffer.from('{"t":"final"', "latin1");
const ERROR_PREFIX = Buffer.from('{"t":"error"', "latin1");
const TERMINAL_PREFIX_BYTES = FINAL_PREFIX.length;

// The one warm child this execution environment may hold. Lambda serializes
// invocations per environment, so a single slot is the whole pool.
let warm = null;

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
    endWithError(responseStream, "invalid mcp runner event");

    return;
  }
  const home = mkdtempSync(join(tmpdir(), "broods-mcp-"));
  let state = null;
  try {
    const key = reuseKey(event);
    state = matchesWarm(key) ? warm : null;
    if (warm && !state) retire(warm);
    if (!state) {
      // Started before the spawn so the S3 round trip overlaps Node's startup,
      // and done here rather than in the child because this process is warm
      // across invocations and keeps its connection to S3; a fresh child would
      // pay a TLS handshake every call.
      const bundle = readBundleSource(event);
      bundle.catch(() => {});
      state = spawnChild(key, home, bundle);
    }
    const keep = await runRequest(state, event, home, responseStream);
    if (keep && key !== null && state.dead !== true) {
      state.callsServed += 1;
      state.lastUsedAt = Date.now();
      warm = state;
    } else {
      retire(state);
    }
  } catch (error) {
    if (state) retire(state);
    endWithError(
      responseStream,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function readBundleSource(event) {
  if (typeof event.bundleSourceB64 === "string") {
    return Buffer.from(event.bundleSourceB64, "base64");
  }
  if (typeof event.bundleUrl !== "string") {
    throw new Error(
      "mcp runner event needs one of bundleSourceB64 or bundleUrl",
    );
  }
  const response = await fetch(event.bundleUrl);
  if (!response.ok) {
    throw new Error(
      `mcp server bundle fetch failed with HTTP ${response.status}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

// One invocation against one child: write the request line, forward stdout
// until the terminal frame line, settle. Resolves true only when the run
// ended on a clean `final` frame, so the child may serve another call.
async function runRequest(state, event, home, responseStream) {
  return await new Promise((resolve) => {
    const child = state.child;
    let forwardedBytes = 0;
    let stopReason;
    let terminal = null;
    let drained = false;
    let settled = false;
    // First bytes of the current stdout line, enough to spot a terminal frame.
    const linePrefix = Buffer.alloc(TERMINAL_PREFIX_BYTES);
    let linePrefixLen = 0;
    const finish = (error, keep) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.removeListener("data", onStdout);
      child.stdout.removeListener("end", onStdoutEnd);
      state.onExit = null;
      if (error) endWithError(responseStream, error);
      else responseStream.end();
      resolve(keep === true && !error);
    };
    // A dead child settles on both the exit and the last byte of stdout:
    // "exit" alone can fire with output still buffered behind a backpressure
    // pause; stdout's "end" alone can never arrive while a detached grandchild
    // holds the pipe's write end open, which is what killGroup releases.
    const settleDead = () => {
      if (!state.dead || !drained) return;
      if (terminal !== null) {
        // The frame made it out before the exit; deliver it as written.
        finish(undefined, false);
      } else if (stopReason) {
        finish(stopReason);
      } else if (forwardedBytes === 0) {
        finish(
          state.stderr.trim() ||
            (state.exit?.signal
              ? `signal ${state.exit.signal}`
              : `exit ${state.exit?.code ?? "unknown"}`),
        );
      } else {
        finish(undefined, false);
      }
    };
    // Abandon forwarding and let the pipe run dry: a paused stdout never
    // reaches its end, so the run would never settle.
    const stopForwarding = (reason) => {
      stopReason = reason;
      child.stdout.resume();
      killGroup(child);
    };
    const timeout = setTimeout(
      () => stopForwarding("mcp server run timed out"),
      RUN_TIMEOUT_MS,
    );

    const onStdout = (chunk) => {
      if (stopReason || terminal !== null) return;
      // Forward through the terminal frame's newline; later bytes in the same
      // chunk are noise from the tenant's own stray writers and are dropped.
      let cut = chunk.length;
      let index = 0;
      while (index < chunk.length) {
        const newline = chunk.indexOf(0x0a, index);
        const lineEnd = newline === -1 ? chunk.length : newline;
        if (linePrefixLen < TERMINAL_PREFIX_BYTES) {
          const copied = chunk.copy(
            linePrefix,
            linePrefixLen,
            index,
            Math.min(lineEnd, index + TERMINAL_PREFIX_BYTES - linePrefixLen),
          );
          linePrefixLen += copied;
        }
        if (newline === -1) break;
        const complete = linePrefixLen === TERMINAL_PREFIX_BYTES;
        const isFinal = complete && linePrefix.equals(FINAL_PREFIX);
        const isError = complete && linePrefix.equals(ERROR_PREFIX);
        linePrefixLen = 0;
        index = newline + 1;
        if (isFinal || isError) {
          terminal = isFinal ? "final" : "error";
          cut = index;
          break;
        }
      }
      const forwarded = cut === chunk.length ? chunk : chunk.subarray(0, cut);
      forwardedBytes += forwarded.length;
      if (forwardedBytes > OUTPUT_LIMIT_BYTES) {
        stopForwarding("mcp server output exceeded limit");

        return;
      }
      // Pause on a full response buffer so a chatty child cannot outrun the
      // stream; the child's own stdout pipe then applies the backpressure.
      const flushed = responseStream.write(forwarded);
      if (terminal !== null) {
        finish(undefined, terminal === "final");

        return;
      }
      if (!flushed) {
        child.stdout.pause();
        responseStream.once("drain", () => child.stdout.resume());
      }
    };
    const onStdoutEnd = () => {
      drained = true;
      settleDead();
    };
    child.stdout.on("data", onStdout);
    child.stdout.once("end", onStdoutEnd);
    state.onExit = () => settleDead();
    if (state.dead) {
      drained = true;
      settleDead();

      return;
    }

    // The request does not wait on the bundle fetch; stdin stays open for the
    // next request.
    child.stdin.write(
      `${JSON.stringify({
        ...event,
        bundleSourceB64: undefined,
        bundleUrl: undefined,
        home: home,
      })}\n`,
    );
    if (state.bundle) {
      const bundle = state.bundle;
      state.bundle = null;
      void bundle.then(
        (bytes) => state.bundleStream.end(bytes),
        (error) => {
          // The child is blocked on a pipe that will never arrive, so the same
          // stop path a timeout takes is what settles the run on an error frame.
          stopForwarding(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    }
  });
}

// Spawn the runner child, detached so killGroup can reap grandchildren on
// retire. The fourth pipe carries the bundle bytes (child-runner.mjs BUNDLE_FD).
function spawnChild(key, home, bundle) {
  const child = spawn(process.execPath, [childRunnerPath()], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: scrubbedEnv(home),
    detached: true,
  });
  // `key` is fixed for the child's lifetime; null means one-shot, never kept.
  const state = {
    key: key,
    child: child,
    bundle: bundle,
    bundleStream: child.stdio[3],
    callsServed: 0,
    lastUsedAt: Date.now(),
    stderr: "",
    dead: false,
    exit: null,
    onExit: null,
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
    if (state.stderr.length > 16 * 1024)
      state.stderr = state.stderr.slice(-16 * 1024);
  });
  child.once("error", (error) => {
    state.dead = true;
    state.stderr ||= error instanceof Error ? error.message : String(error);
    state.onExit?.();
  });
  child.once("exit", (code, signal) => {
    state.dead = true;
    state.exit = { code: code, signal: signal };
    if (warm === state) warm = null;
    // The child is gone, but anything it spawned is not. Reaping the group is
    // also what lets a held-open stdout pipe end and the remaining bytes land.
    killGroup(child);
    state.onExit?.();
  });
  // A child that exits before reading a pipe makes writes emit EPIPE; an
  // unhandled stream error would crash the handler instead of returning a frame.
  child.stdin.on("error", () => {});
  state.bundleStream.on("error", () => {});

  return state;
}

function childRunnerPath() {
  const root = process.env.LAMBDA_TASK_ROOT;

  return root
    ? join(root, "child-runner.mjs")
    : fileURLToPath(new URL("./child-runner.mjs", import.meta.url));
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
  responseStream.write(`${JSON.stringify({ t: "error", error: error })}\n`);
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

// Only the exact accountId + sha256 the child was spawned for, and never past
// its call or idle bounds.
function matchesWarm(key) {
  if (!warm || warm.dead || warm.key !== key) return false;
  if (
    warm.callsServed >=
    positiveEnvInt("MCP_CHILD_MAX_CALLS", DEFAULT_MAX_CHILD_CALLS)
  ) {
    return false;
  }
  const idleSeconds = positiveEnvInt(
    "MCP_CHILD_IDLE_SECONDS",
    DEFAULT_CHILD_IDLE_SECONDS,
  );

  return Date.now() - warm.lastUsedAt <= idleSeconds * 1000;
}

function positiveEnvInt(name, fallback) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Dispose one child: clear the warm slot if it holds it, SIGKILL its group.
function retire(state) {
  if (warm === state) warm = null;
  killGroup(state.child);
}

// Reuse needs the tenant identity in the key: without accountId the call runs
// in a one-shot child exactly as before.
function reuseKey(event) {
  if (process.env.MCP_CHILD_REUSE === "0") return null;
  if (
    typeof event.accountId !== "string" ||
    typeof event.expectedSha256 !== "string"
  ) {
    return null;
  }

  return `${event.accountId}:${event.expectedSha256}`;
}

// A minimal, credential-free env. Explicitly no AWS_*/Lambda vars so user code
// cannot reach the execution role; HOME/TMPDIR start at the first call's
// scratch dir and every request line re-points them at its own fresh one.
function scrubbedEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    NODE_ENV: "production",
    TOOL_RUNNER_TIMEOUT_SECONDS: childTimeoutSeconds(),
  };
}
