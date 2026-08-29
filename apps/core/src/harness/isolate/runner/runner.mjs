/**
 * Node-only isolated-vm runner for uploaded account tools.
 * Core spawns this file because Bun runs on JavaScriptCore and cannot load the
 * V8-native isolated-vm addon.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import ivm from "isolated-vm";
import {
  guardedFetch,
  BODY_LIMIT_BYTES,
  FETCH_TIMEOUT_MS,
} from "./pinned-fetch.mjs";
import { WEB_GLOBALS_SOURCE } from "./web-globals.mjs";

// Wall-clock deadline for the whole run; ctx.fetch caps each bridge call at the
// remaining budget. Declared before the entry dispatch below assigns it.
let runDeadlineAt = 0;

// A timer sleep resolving after the isolate is disposed (timeout/final) rejects
// when it tries to re-enter the dead isolate. All real outcomes are already on
// stdout as frames by then — never let that teardown noise crash the runner.
process.on("unhandledRejection", () => {});

// Cross-process tool cancellation: the core host forwards the AI SDK abortSignal
// as SIGUSR2, which fires the in-isolate AbortController of the run in flight.
// Only the active run sets this; it is cleared when the run settles.
let activeAbort = null;
process.on("SIGUSR2", () => {
  try {
    activeAbort?.();
  } catch {}
});

if (process.argv[2] === "--fetch-bridge") {
  await runFetchBridgeHelper();
} else if (process.argv[2] === "--pool") {
  await runPoolWorker();
} else {
  await runToolRequest();
}

function memoryLimitMb() {
  const value = Number(process.env.ISOLATE_MEMORY_LIMIT_MB);

  return Number.isFinite(value) && value > 0 ? value : 128;
}

function runTimeoutMs() {
  const value = Number(process.env.ISOLATE_RUNNER_TIMEOUT_SECONDS);
  const seconds = Number.isFinite(value) && value > 0 ? value : 30;

  return seconds * 1000;
}

// One-shot legacy mode: spawn per call, throwaway isolate. Kept as the fallback
// behind ISOLATE_POOL so the pooled worker can land + soak before it is default.
async function runToolRequest() {
  let isolate;
  let timedOut = false;
  const timeoutMs = runTimeoutMs();
  runDeadlineAt = Date.now() + timeoutMs;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      isolate?.dispose();
    } catch {}
    writeFrame({
      t: "error",
      error: "custom tool isolate execution timed out",
    });
  }, timeoutMs);

  try {
    const payload = JSON.parse(await readAllStdin());
    isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb() });
    const result = await runIsolateJob(isolate, payload, {
      timeoutMs: timeoutMs,
      emitChunk: (output) => writeFrame({ t: "chunk", output: output }),
      emitLog: makeLogEmitter(undefined),
      registerAbort: (fire) => {
        activeAbort = fire;
      },
    });
    if (!timedOut) writeFrame({ t: "final", result: result });
  } catch (error) {
    if (!timedOut) writeFrame({ t: "error", error: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    activeAbort = null;
    clearTimeout(timeout);
    try {
      isolate?.dispose();
    } catch {}
  }
}

// Persistent pooled worker: a long-lived process the core pool checks out one
// call at a time (no in-worker multiplexing). It keeps a tenant-keyed isolate
// cache so same-tenant calls reuse a warm isolate (compile caches stay hot),
// while every call gets a FRESH context (via runIsolateJob) so no state leaks
// between calls. Isolates are never shared across tenants; a tripped isolate is
// disposed and evicted. Mirrors Convex Funrun's per-tenant isolate reuse.
async function runPoolWorker() {
  const cacheCapRaw = Number(process.env.ISOLATE_TENANT_CACHE_PER_WORKER);
  // Deliberately small: acquireWorker prefers a worker that already holds the
  // tenant, so most workers only ever need one, and every cached isolate is
  // resident memory in a pod that has 1 GiB for everything.
  const cacheCap =
    Number.isFinite(cacheCapRaw) && cacheCapRaw > 0
      ? Math.max(1, cacheCapRaw)
      : 2;
  const cache = new Map(); // tenantId -> { isolate, lastCpu: bigint }
  writeFrame({ t: "ready" });
  for await (const line of readLines(process.stdin)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!request || request.t !== "run") continue;
    await handlePoolRun(request, cache, cacheCap);
  }
}

async function handlePoolRun(request, cache, cacheCap) {
  const { callId, tenantId, payload } = request;
  const timeoutMs = runTimeoutMs();
  let entry = cache.get(tenantId);
  let poisoned = false;
  let watchdog;
  try {
    if (!entry) {
      entry = {
        isolate: new ivm.Isolate({ memoryLimit: memoryLimitMb() }),
        lastCpu: 0n,
      };
    }
    // LRU touch + bound the per-worker isolate cache.
    cache.delete(tenantId);
    cache.set(tenantId, entry);
    while (cache.size > cacheCap) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      try {
        oldest?.isolate.dispose();
      } catch {}
    }

    const isolate = entry.isolate;
    runDeadlineAt = Date.now() + timeoutMs;
    // Watchdog covers the whole job (compile + evaluate + run), not just the run
    // eval's own timeout: dispose the isolate if it blocks past the deadline.
    watchdog = setTimeout(() => {
      poisoned = true;
      try {
        isolate.dispose();
      } catch {}
    }, timeoutMs + 1_000);

    const result = await runIsolateJob(isolate, payload, {
      timeoutMs: timeoutMs,
      emitChunk: (output) =>
        writeFrame({ t: "chunk", callId: callId, output: output }),
      emitLog: makeLogEmitter(callId),
      registerAbort: (fire) => {
        activeAbort = fire;
      },
    });
    clearTimeout(watchdog);
    watchdog = undefined;

    // Metering: the same CPU counter that bounds the isolate is the billing
    // signal. cpuTime is cumulative per isolate, so bill the per-call delta.
    const cpuNow = readCpuTimeNs(isolate);
    const cpuMs = Number(cpuNow - entry.lastCpu) / 1e6;
    entry.lastCpu = cpuNow;
    writeFrame({
      t: "meter",
      callId: callId,
      tenantId: tenantId,
      toolName: payload.toolName,
      cpuMs: cpuMs,
    });
    writeFrame({ t: "final", callId: callId, result: result });
  } catch (error) {
    poisoned = true;
    writeFrame({ t: "error", callId: callId, error: errorMessage(error) });
  } finally {
    activeAbort = null;
    if (watchdog) clearTimeout(watchdog);
    if (poisoned) {
      try {
        entry?.isolate.dispose();
      } catch {}
      cache.delete(tenantId);
    }
  }
}

// Runs one tool bundle on the given isolate in a FRESH context and returns its
// result; the caller owns isolate lifetime and terminal frames. Shared by the
// one-shot and pooled paths so the security-critical setup lives in one place.
async function runIsolateJob(
  isolate,
  payload,
  { timeoutMs, emitChunk, emitLog, registerAbort },
) {
  const bundleSource = decodeBundle(payload);
  const actualSha = createHash("sha256").update(bundleSource).digest("hex");
  if (actualSha !== payload.expectedSha256) {
    throw new Error("custom tool bundle hash mismatch inside isolate runner");
  }

  const context = await isolate.createContext();
  try {
    await context.global.set("globalThis", context.global.derefInto());
    // Besides ctx/input, inject the minimal runtime surface tool bundles
    // reasonably assume in a fresh V8 isolate: timers, queueMicrotask, console
    // (a log frame, so the host can emit it under the run's tenant context and
    // it reaches the dashboard and `broods logs`), and a global fetch aliased
    // to the same SSRF-guarded bridge as ctx.fetch. Timers cannot await the
    // host (promises do not cross the isolate boundary): the isolate registers
    // the id, the host arms a real timer, and on expiry re-enters the isolate
    // through the __fireTimer reference.
    let fireTimer;
    await context.evalClosure(
      `const __fetch = async (url, init) => $2(url, init ?? {});
      globalThis.__ctx = {
        config: $0,
        fetch: __fetch,
        state: $5,
      };
      globalThis.__input = $1;
      globalThis.__toolCallId = $6;
      globalThis.__messages = $7;
      globalThis.__experimentalContext = $8;
      globalThis.fetch = __fetch;
      let __nextTimer = 1;
      const __timers = new Map();
      globalThis.__fireTimer = (id) => {
        const timer = __timers.get(id);
        if (!timer) return;
        if (!timer.repeat) __timers.delete(id);
        timer.cb();
      };
      globalThis.setTimeout = (fn, ms, ...args) => {
        const id = __nextTimer++;
        __timers.set(id, { repeat: false, cb: () => fn(...args) });
        $3(id, Math.max(0, Number(ms) || 0));
        return id;
      };
      globalThis.clearTimeout = (id) => { __timers.delete(id); };
      globalThis.setInterval = (fn, ms, ...args) => {
        const id = __nextTimer++;
        const delay = Math.max(0, Number(ms) || 0);
        __timers.set(id, {
          repeat: true,
          cb: () => {
            fn(...args);
            if (__timers.has(id)) $3(id, delay);
          },
        });
        $3(id, delay);
        return id;
      };
      globalThis.clearInterval = (id) => { __timers.delete(id); };
      globalThis.queueMicrotask = (fn) => { void Promise.resolve().then(fn); };
      // String(value) alone renders every object as "[object Object]" and throws
      // outright on a null-prototype or hostile toString, which would kill the
      // run from inside a console.log. Serialize structurally, guard cycles, and
      // bound the line so one log cannot blow the runner's stdout budget.
      const __LOG_MAX = 8192;
      const __fmt = (value) => {
        if (typeof value === "string") return value;
        if (typeof value === "bigint") return \`\${value}n\`;
        if (typeof value === "function") return \`[Function: \${value.name || "anonymous"}]\`;
        if (value instanceof Error) return value.stack || \`\${value.name}: \${value.message}\`;
        try {
          const seen = new WeakSet();
          const text = JSON.stringify(value, (_key, entry) => {
            if (typeof entry === "bigint") return \`\${entry}n\`;
            if (typeof entry === "function") return \`[Function: \${entry.name || "anonymous"}]\`;
            if (entry && typeof entry === "object") {
              if (seen.has(entry)) return "[Circular]";
              seen.add(entry);
            }
            return entry;
          });
          if (text !== undefined) return text;
        } catch {}
        try { return String(value); } catch { return "[unserializable]"; }
      };
      const __log = (level) => (...args) => {
        let line = "";
        for (const arg of args) {
          if (line.length >= __LOG_MAX) break;
          line += (line.length ? " " : "") + __fmt(arg);
        }
        $4(level, line.length > __LOG_MAX ? line.slice(0, __LOG_MAX) + "... [truncated]" : line);
      };
      // Every console method Node exposes, so a bundle calling console.trace or
      // console.table gets a log line instead of "is not a function" mid-run.
      const __noop = () => {};
      globalThis.console = {
        log: __log("log"),
        info: __log("info"),
        warn: __log("warn"),
        error: __log("error"),
        debug: __log("debug"),
        trace: __log("debug"),
        dir: __log("log"),
        table: __log("log"),
        group: __log("log"),
        groupCollapsed: __log("log"),
        groupEnd: __noop,
        time: __noop,
        timeEnd: __noop,
        timeLog: __noop,
        count: __noop,
        countReset: __noop,
        assert: (condition, ...args) => {
          if (condition) return;
          __log("error")("Assertion failed:", ...args);
        },
      };
      // Minimal AbortController/AbortSignal (absent in a bare V8 isolate). The run's
      // signal is exposed as options.abortSignal; the host fires __abort on cancel.
      class AbortSignalPoly {
        constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; this.__listeners = []; }
        addEventListener(type, cb) { if (type === "abort" && typeof cb === "function") this.__listeners.push(cb); }
        removeEventListener(type, cb) { if (type === "abort") this.__listeners = this.__listeners.filter((fn) => fn !== cb); }
        dispatchEvent() { return true; }
        throwIfAborted() { if (this.aborted) throw this.reason; }
        __abortWith(reason) {
          if (this.aborted) return;
          this.aborted = true;
          this.reason = reason;
          const event = { type: "abort" };
          if (typeof this.onabort === "function") { try { this.onabort(event); } catch {} }
          for (const cb of this.__listeners.slice()) { try { cb.call(this, event); } catch {} }
        }
      }
      const __makeAbortError = () => { const error = new Error("The operation was aborted"); error.name = "AbortError"; return error; };
      globalThis.AbortSignal = AbortSignalPoly;
      globalThis.AbortController = class { constructor() { this.signal = new AbortSignalPoly(); } abort(reason) { this.signal.__abortWith(reason ?? __makeAbortError()); } };
      const __abortController = new globalThis.AbortController();
      globalThis.__abortSignal = __abortController.signal;
      globalThis.__abort = (reason) => __abortController.abort(reason);`,
      [
        new ivm.ExternalCopy(
          asPlainRecord(payload.config, "config"),
        ).copyInto(),
        new ivm.ExternalCopy(payload.input).copyInto(),
        new ivm.Callback((url, init) => bridgeFetchSync(url, init), {
          sync: true,
        }),
        // unref: stray timers must not keep the runner alive after the final
        // frame; a fire on a disposed/released context rejects and is swallowed.
        new ivm.Callback(
          (id, ms) => {
            const timer = setTimeout(
              () => {
                fireTimer?.apply(undefined, [id]).catch(() => {});
              },
              Math.min(ms, 60_000),
            );
            timer.unref?.();
          },
          { ignored: true },
        ),
        // sync, like __emitChunk: an `ignored` callback is dispatched on a later
        // host turn, so the log frame could be written AFTER this call's terminal
        // frame — by which time the host has detached the sink (line lost) or
        // handed the worker to the next call (line emitted under that tenant's
        // observability context). Ordering is the correctness property here.
        new ivm.Callback((level, line) => emitLog(level, line), { sync: true }),
        // Mutable per-run scratchpad for hooks (ctx.state); read back out after a
        // hook runs so the host can thread it into the next fire-point. Empty for
        // tools, which are stateless single calls.
        new ivm.ExternalCopy(asPlainRecord(payload.state, "state")).copyInto(),
        new ivm.ExternalCopy(payload.toolCallId ?? null).copyInto(),
        // The AI SDK's own execute options, so an uploaded bundle sees what the
        // same tool would see in-process. Core bounds messages before it sends.
        new ivm.ExternalCopy(payload.messages ?? null).copyInto(),
        new ivm.ExternalCopy(payload.experimentalContext ?? null).copyInto(),
      ],
      { timeout: 1_000 },
    );
    // Text codecs, base64, URL and crypto, in a second closure so the host-bridged
    // setup above stays readable. Installed before the module evaluates: bundles
    // reach for these at import time, not only inside execute.
    await context.evalClosure(
      WEB_GLOBALS_SOURCE,
      [
        new ivm.Callback(
          (input, base, key, value) => parseUrl(input, base, key, value),
          { sync: true },
        ),
        new ivm.Callback(
          (length) =>
            Array.from(randomBytes(Math.min(Number(length) || 0, 65_536))),
          { sync: true },
        ),
      ],
      { timeout: 1_000 },
    );
    fireTimer = await context.global.get("__fireTimer", { reference: true });
    // Expose the run's cancel hook to the SIGUSR2 handler so the core host can
    // trip the in-isolate AbortController when the AI SDK abortSignal fires.
    const abortRun = await context.global.get("__abort", { reference: true });
    registerAbort?.(() => {
      void abortRun.apply(undefined, [], { timeout: 1_000 }).catch(() => {});
    });

    const module = await isolate.compileModule(bundleSource.toString("utf8"), {
      filename: "tool.mjs",
    });
    await module.instantiate(context, (specifier) => {
      throw new Error(`custom tool isolate bundles cannot import ${specifier}`);
    });
    await module.evaluate({ timeout: 5_000 });

    let definition = await module.namespace.get("default", { reference: true });
    if (definition.typeof === "function") {
      definition = await definition.apply(undefined, [], {
        result: { promise: true, reference: true },
        timeout: 5_000,
      });
    }
    // Hook bundles export handlers keyed by event name (default[event](ctx, event));
    // tool bundles export the AI SDK execute(input, options). Resolve accordingly.
    let entry;
    if (typeof payload.hookEvent === "string") {
      entry = await definition.get(payload.hookEvent, { reference: true });
      if (!entry || entry.typeof !== "function") {
        // No handler for this event: no mutation, state unchanged. Same
        // { result, state } shape as a real hook run so the host parses one shape.
        return { result: undefined, state: payload.state ?? {} };
      }
    } else {
      entry = await definition.get("execute", { reference: true });
      if (!entry || entry.typeof !== "function") {
        throw new Error(
          "custom tool bundle default export must expose execute(input, options)",
        );
      }
      const definitionName = await definition.get("name", { copy: true });
      if (definitionName && definitionName !== payload.toolName) {
        throw new Error(
          "custom tool bundle name does not match uploaded manifest",
        );
      }
    }

    await context.global.set("__execute", entry.derefInto());
    await context.global.set(
      "__emitChunk",
      new ivm.Callback((output) => emitChunk(output), { sync: true }),
    );
    if (typeof payload.hookEvent === "string") {
      // A hook returns a single value; also read back ctx.state so the host can
      // persist any run-scoped state the hook mutated for the next fire-point.
      return await context.eval(
        `(async () => {
          const result = await globalThis.__execute(globalThis.__ctx, globalThis.__input);
          return { result, state: globalThis.__ctx.state };
        })()`,
        {
          promise: true,
          copy: true,
          timeout: timeoutMs,
        },
      );
    }

    return await context.eval(
      `(async () => {
        const options = {
          toolCallId: globalThis.__toolCallId,
          context: globalThis.__ctx,
          abortSignal: globalThis.__abortSignal,
          messages: globalThis.__messages ?? [],
          experimental_context: globalThis.__experimentalContext ?? undefined,
        };
        const value = globalThis.__execute(globalThis.__input, options);
        if (value != null && typeof value[Symbol.asyncIterator] === "function") {
          let last;
          for await (const output of value) {
            last = output;
            globalThis.__emitChunk(output);
          }
          return last;
        }
        return await value;
      })()`,
      {
        promise: true,
        copy: true,
        timeout: timeoutMs,
      },
    );
  } finally {
    // Free the context but keep the isolate warm for the next same-tenant call.
    try {
      context.release();
    } catch {}
  }
}

// isolated-vm exposes cumulative isolate CPU time; normalize across versions
// (bigint ns in v7, [seconds, nanoseconds] in older builds) to nanoseconds.
function readCpuTimeNs(isolate) {
  const value = isolate.cpuTime;
  if (typeof value === "bigint") return value;
  if (Array.isArray(value))
    return BigInt(value[0]) * 1_000_000_000n + BigInt(value[1]);

  return 0n;
}

async function* readLines(stream) {
  stream.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer.length) yield buffer;
}

function bridgeFetchSync(url, init) {
  // spawnSync blocks the event loop, so the runner's own timeout timer cannot
  // fire mid-fetch. Cap each fetch at the remaining run deadline so ctx.fetch
  // cannot stretch the run past ISOLATE_RUNNER_TIMEOUT_SECONDS.
  const remainingMs =
    runDeadlineAt > 0 ? runDeadlineAt - Date.now() : FETCH_TIMEOUT_MS;
  if (remainingMs <= 0) {
    throw new Error("custom tool isolate execution timed out");
  }
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--fetch-bridge"],
    {
      input: JSON.stringify({ url: url, init: init }),
      encoding: "utf8",
      timeout: Math.min(FETCH_TIMEOUT_MS, remainingMs),
      maxBuffer: BODY_LIMIT_BYTES + 64 * 1024,
      env: process.env,
    },
  );
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(
      (child.stderr || child.stdout || "fetch bridge failed").trim(),
    );
  }
  const parsed = JSON.parse(child.stdout);
  if (!parsed.ok) {
    throw new Error(
      typeof parsed.error === "string" ? parsed.error : "fetch bridge failed",
    );
  }

  return parsed.result;
}

async function runFetchBridgeHelper() {
  try {
    const { url, init } = JSON.parse(await readAllStdin());
    const result = await guardedFetch(url, init);
    process.stdout.write(JSON.stringify({ ok: true, result: result }));
  } catch (error) {
    // guardedFetch throws neutral messages; the tool author should see which
    // API failed, so the label is added here at the bridge boundary.
    process.stdout.write(
      JSON.stringify({ ok: false, error: `ctx.fetch ${errorMessage(error)}` }),
    );
    process.exitCode = 1;
  }
}

function decodeBundle(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid isolate runner payload");
  }
  if (typeof payload.bundleSourceB64 !== "string") {
    throw new Error("isolate runner payload missing bundleSourceB64");
  }
  if (typeof payload.expectedSha256 !== "string") {
    throw new Error("isolate runner payload missing expectedSha256");
  }
  if (typeof payload.toolName !== "string") {
    throw new Error("isolate runner payload missing toolName");
  }

  return Buffer.from(payload.bundleSourceB64, "base64");
}

function asPlainRecord(value, name) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`isolate runner payload ${name} must be an object`);
  }

  return value;
}

// Backs the isolate's URL global. Parsing on the host means bundles get Node's
// WHATWG parser instead of a hand-rolled one; null is an invalid URL, which the
// isolate turns back into a TypeError.
function parseUrl(input, base, setterKey, setterValue) {
  try {
    const url = new URL(input, base ?? undefined);
    if (setterKey) url[setterKey] = setterValue;

    return {
      href: url.href,
      protocol: url.protocol,
      username: url.username,
      password: url.password,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      origin: url.origin,
    };
  } catch {
    return null;
  }
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

// A tool logging in a tight loop would otherwise walk straight into the host's
// 1 MiB stdout cap, which kills the worker and fails the call. Spend a per-call
// budget on console lines, then say so once and stay quiet — the tool still runs.
// The budget lives in here, not at module scope: the entry dispatch at the top of
// this file is a top-level await, so a module-level const below it is still in
// its temporal dead zone while a run is emitting, and reading one would throw a
// ReferenceError out of the console callback and into the tool.
function makeLogEmitter(callId) {
  const budgetBytes = 256 * 1024;
  const budgetLines = 2_000;
  const tag = callId === undefined ? {} : { callId: callId };
  let bytes = 0;
  let lines = 0;
  let stopped = false;

  return (level, message) => {
    if (stopped) return;
    lines += 1;
    bytes += Buffer.byteLength(message, "utf8");
    if (lines > budgetLines || bytes > budgetBytes) {
      stopped = true;
      writeFrame({
        t: "log",
        ...tag,
        level: "warn",
        message:
          "console output budget for this call is spent; later lines are dropped",
      });

      return;
    }
    writeFrame({ t: "log", ...tag, level: level, message: message });
  };
}

async function readAllStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;

  return input.trim();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
