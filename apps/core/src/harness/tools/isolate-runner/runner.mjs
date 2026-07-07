/**
 * Node-only isolated-vm runner for uploaded account tools.
 * Core spawns this file because Bun runs on JavaScriptCore and cannot load the
 * V8-native isolated-vm addon.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import ivm from "isolated-vm";

const BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const REDIRECT_LIMIT = 5;
const DENY_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10",
];

if (process.argv[2] === "--fetch-bridge") {
  await runFetchBridgeHelper();
} else {
  await runToolRequest();
}

async function runToolRequest() {
  let isolate;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      isolate?.dispose();
    } catch {}
    writeFrame({ t: "error", error: "custom tool isolate execution timed out" });
  }, Number(process.env.ISOLATE_RUNNER_TIMEOUT_SECONDS || 30) * 1000);

  try {
    const payload = JSON.parse(await readAllStdin());
    const bundleSource = decodeBundle(payload);
    const actualSha = createHash("sha256").update(bundleSource).digest("hex");
    if (actualSha !== payload.expectedSha256) {
      throw new Error("custom tool bundle hash mismatch inside isolate runner");
    }

    isolate = new ivm.Isolate({ memoryLimit: 128 });
    const context = await isolate.createContext();
    await context.global.set("globalThis", context.global.derefInto());
    await context.evalClosure(
      `globalThis.__ctx = {
        config: $0,
        asyncTool: null,
        env: {},
        fetch: async (url, init) => $2(url, init ?? {}),
      };
      globalThis.__input = $1;`,
      [
        new ivm.ExternalCopy(asPlainRecord(payload.config, "config")).copyInto(),
        new ivm.ExternalCopy(payload.input).copyInto(),
        new ivm.Callback((url, init) => bridgeFetchSync(url, init), { sync: true }),
      ],
      { timeout: 1_000 },
    );

    const module = await isolate.compileModule(bundleSource.toString("utf8"), { filename: "tool.mjs" });
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
    const execute = await definition.get("execute", { reference: true });
    if (!execute || execute.typeof !== "function") {
      throw new Error("custom tool bundle default export must expose execute(ctx, input)");
    }
    const definitionName = await definition.get("name", { copy: true });
    if (definitionName && definitionName !== payload.toolName) {
      throw new Error("custom tool bundle name does not match uploaded manifest");
    }

    await context.global.set("__execute", execute.derefInto());
    await context.global.set("__emitChunk", new ivm.Callback((output) => writeFrame({ t: "chunk", output }), { sync: true }));
    const result = await context.eval(
      `(async () => {
        const value = globalThis.__execute(globalThis.__ctx, globalThis.__input);
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
        timeout: Number(process.env.ISOLATE_RUNNER_TIMEOUT_SECONDS || 30) * 1000,
      },
    );
    if (!timedOut) writeFrame({ t: "final", result });
  } catch (error) {
    if (!timedOut) writeFrame({ t: "error", error: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    try {
      isolate?.dispose();
    } catch {}
  }
}

function bridgeFetchSync(url, init) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--fetch-bridge"], {
    input: JSON.stringify({ url, init }),
    encoding: "utf8",
    timeout: FETCH_TIMEOUT_MS,
    maxBuffer: BODY_LIMIT_BYTES + 64 * 1024,
    env: process.env,
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || "fetch bridge failed").trim());
  }
  const parsed = JSON.parse(child.stdout);
  if (!parsed.ok) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "fetch bridge failed");
  }
  return parsed.result;
}

async function runFetchBridgeHelper() {
  try {
    const { url, init } = JSON.parse(await readAllStdin());
    const result = await guardedFetch(url, sanitizeFetchInit(init));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: errorMessage(error) }));
    process.exitCode = 1;
  }
}

async function guardedFetch(url, init, redirects = 0) {
  if (redirects > REDIRECT_LIMIT) {
    throw new Error("fetch redirect limit exceeded");
  }
  const parsed = validateHttpUrl(url);
  await assertHostAllowed(parsed.hostname);
  const response = await fetch(parsed, { ...init, redirect: "manual" });
  if (isRedirect(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("fetch redirect missing location");
    return guardedFetch(new URL(location, parsed).toString(), init, redirects + 1);
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText: await readBodyText(response),
  };
}

function validateHttpUrl(value) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new Error("ctx.fetch url must be a string or URL");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ctx.fetch only supports http(s) URLs");
  }
  if (!parsed.hostname) {
    throw new Error("ctx.fetch URL must include a hostname");
  }
  return parsed;
}

// NOTE (pre-multitenant hardening TODO): this validates the resolved IPs, but the
// subsequent fetch() re-resolves DNS, so a hostile resolver can still rebind to a
// denied address between the check and the connection. The full fix pins the
// validated IP through an undici dispatcher with a fixed lookup; tracked for the PR.
async function assertHostAllowed(hostname) {
  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0) {
    throw new Error("ctx.fetch hostname did not resolve");
  }
  for (const address of addresses) {
    if (isDeniedAddress(address.address)) {
      throw new Error("ctx.fetch blocked private or metadata address");
    }
  }
}

function isDeniedAddress(address) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) tunnels a v4 address past the v6 checks —
    // evaluate the embedded v4 against the CIDR denylist instead.
    const mapped = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isDeniedAddress(mapped[1]);
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd");
  }
  const numeric = ipv4ToInt(address);
  if (numeric === null) return true;
  return DENY_CIDRS.some((cidr) => ipv4InCidr(numeric, cidr));
}

function ipv4ToInt(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(address, cidr) {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const baseInt = ipv4ToInt(base);
  if (baseInt === null || !Number.isInteger(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseInt & mask);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBodyText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      throw new Error("ctx.fetch response body exceeded 5MB");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(chunks, total));
}

function concatBytes(chunks, total) {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sanitizeFetchInit(init) {
  if (init == null) return {};
  if (typeof init !== "object" || Array.isArray(init)) {
    throw new Error("ctx.fetch init must be an object");
  }
  const result = {};
  if (init.method !== undefined) result.method = String(init.method);
  if (init.headers !== undefined) result.headers = init.headers;
  if (init.body !== undefined) result.body = init.body;
  return result;
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

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
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
