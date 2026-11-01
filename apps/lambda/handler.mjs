// Event: McpHostPayload from apps/core/src/harness/mcp/hosted.ts; the two roll together.
// The child is containment, not a trust boundary: it shares our UID, so keep the role empty.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The child aborts CHILD_GRACE_MS before this SIGKILL; the Lambda timeout sits above both.
const RUN_TIMEOUT_MS = 30_000;
const CHILD_GRACE_MS = 2_000;
// Far below Lambda's 200 MB stream cap: every byte lands in core's memory and agent context.
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const DEFAULT_MAX_CHILD_CALLS = 64;
const DEFAULT_CHILD_IDLE_SECONDS = 300;

// Matched on line prefixes so big frames are never parsed; an id-less error ends the batch.
const END_PREFIX = Buffer.from('{"t":"end"', "latin1");
const BATCH_ERROR_PREFIX = Buffer.from('{"t":"error","error"', "latin1");
const TERMINAL_PREFIX_BYTES = BATCH_ERROR_PREFIX.length;

// Lambda serializes invocations per environment, so one slot is the whole pool.
let warm = null;

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
      reapStrays();
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

async function runRequest(state, event, home, responseStream) {
  return await new Promise((resolve) => {
    const child = state.child;
    let forwardedBytes = 0;
    let stopReason;
    let terminal = null;
    let drained = false;
    let settled = false;
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
    // Waits for both exit and stdout end: exit can beat buffered output, and end never comes
    // while a detached grandchild holds the pipe, which killGroup releases.
    const settleDead = () => {
      if (!state.dead || !drained) return;
      if (terminal !== null) {
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
    // A paused stdout never ends, so the run would never settle.
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
        const isEnd = lineStartsWith(linePrefix, linePrefixLen, END_PREFIX);
        const isError = lineStartsWith(
          linePrefix,
          linePrefixLen,
          BATCH_ERROR_PREFIX,
        );
        linePrefixLen = 0;
        index = newline + 1;
        if (isEnd || isError) {
          terminal = isEnd ? "end" : "error";
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
      const flushed = responseStream.write(forwarded);
      if (terminal !== null) {
        finish(undefined, terminal === "end");

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
          stopForwarding(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    }
  });
}

function spawnChild(key, home, bundle) {
  const child = spawn(process.execPath, [childRunnerPath()], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: scrubbedEnv(home),
    detached: true,
  });
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
    killGroup(child);
    state.onExit?.();
  });
  // EPIPE from a child that exited early must not crash the handler.
  child.stdin.on("error", () => {});
  state.bundleStream.on("error", () => {});

  return state;
}

function ancestorPids() {
  const pids = new Set();
  let pid = String(process.pid);
  while (pid !== "0" && !pids.has(pid)) {
    pids.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] ?? "0";
    } catch {
      break;
    }
  }

  return pids;
}

function childRunnerPath() {
  const root = process.env.LAMBDA_TASK_ROOT;

  return root
    ? join(root, "child-runner.mjs")
    : fileURLToPath(new URL("./child-runner.mjs", import.meta.url));
}

function childTimeoutSeconds() {
  const graceBound = Math.floor((RUN_TIMEOUT_MS - CHILD_GRACE_MS) / 1000);
  const override = Number(process.env.TOOL_RUNNER_TIMEOUT_SECONDS);
  const seconds =
    Number.isFinite(override) && override > 0
      ? Math.min(graceBound, override)
      : graceBound;

  return String(Math.max(1, seconds));
}

function endWithError(responseStream, error) {
  responseStream.write(`${JSON.stringify({ t: "error", error: error })}\n`);
  responseStream.end();
}

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function lineStartsWith(linePrefix, linePrefixLen, prefix) {
  return (
    linePrefixLen >= prefix.length &&
    linePrefix.subarray(0, prefix.length).equals(prefix)
  );
}

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

// A bundle can setsid() out of killGroup's reach and live on beside the next account's child, so
// every same-UID process but our ancestors dies before a spawn (a Lambda extension would too).
function reapStrays() {
  let pids;
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return;
  }
  const uid = process.getuid?.();
  const keep = ancestorPids();
  for (const pid of pids) {
    if (keep.has(pid)) continue;
    try {
      if (statSync(`/proc/${pid}`).uid !== uid) continue;
      process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
}

function retire(state) {
  if (warm === state) warm = null;
  killGroup(state.child);
}

function reuseKey(event) {
  if (process.env.MCP_CHILD_REUSE === "0") return null;
  if (
    typeof event.tenantId !== "string" ||
    typeof event.expectedSha256 !== "string"
  ) {
    return null;
  }

  return `${event.tenantId}:${event.expectedSha256}`;
}

// No AWS_* or Lambda vars: user code must not reach the execution role.
function scrubbedEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    NODE_ENV: "production",
    TOOL_RUNNER_TIMEOUT_SECONDS: childTimeoutSeconds(),
  };
}
