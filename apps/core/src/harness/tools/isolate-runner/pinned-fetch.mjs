/**
 * SSRF-guarded fetch bridge helper for custom-tool isolates.
 */

import http from "node:http";
import https from "node:https";
import { lookup as defaultLookup } from "node:dns/promises";

export const BODY_LIMIT_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
export const REDIRECT_LIMIT = 5;
export const DENY_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10",
];

// Resolve -> validate all resolved IPs -> pick one -> connect to that pinned IP.
// Tests may inject lookup/createConnection through opts; production callers should
// leave those unset so Node opens the socket directly to the validated address.
export async function guardedFetch(url, init, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, Number(opts.timeoutMs)) : FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("ctx.fetch timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([guardedFetchWithDeadline(url, sanitizeFetchInit(init), {
      ...opts,
      signal: controller.signal,
      deadlineAt: Date.now() + timeoutMs,
      redirects: 0,
    }), timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("ctx.fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function guardedFetchWithDeadline(url, init, state) {
  if (state.redirects > REDIRECT_LIMIT) {
    throw new Error("fetch redirect limit exceeded");
  }
  throwIfAborted(state.signal);
  const parsed = validateHttpUrl(url);
  const pinned = await resolveAllowedAddress(parsed.hostname, state.lookup);
  const response = await requestPinned(parsed, pinned, init, state);
  if (isRedirect(response.status)) {
    const location = response.headers.location;
    if (!location) throw new Error("fetch redirect missing location");
    return guardedFetchWithDeadline(new URL(location, parsed).toString(), init, {
      ...state,
      redirects: state.redirects + 1,
    });
  }
  return response;
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

async function resolveAllowedAddress(hostname, lookup) {
  const resolver = lookup ?? defaultLookup;
  const addresses = await resolver(hostname, { all: true, verbatim: false });
  const normalized = Array.isArray(addresses) ? addresses : [addresses];
  if (normalized.length === 0) {
    throw new Error("ctx.fetch hostname did not resolve");
  }
  for (const address of normalized) {
    if (!address || typeof address.address !== "string" || isDeniedAddress(address.address)) {
      throw new Error("ctx.fetch blocked private or metadata address");
    }
  }
  return normalized[0];
}

function requestPinned(parsed, pinned, init, state) {
  return new Promise((resolve, reject) => {
    throwIfAborted(state.signal);
    const client = parsed.protocol === "https:" ? https : http;
    const headers = normalizeRequestHeaders(init.headers);
    headers.Host = parsed.hostname;
    const request = client.request({
      protocol: parsed.protocol,
      hostname: pinned.address,
      family: pinned.family,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      method: init.method === undefined ? "GET" : String(init.method),
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      servername: parsed.hostname,
      signal: state.signal,
      createConnection: state.createConnection,
      timeout: Math.max(1, state.deadlineAt - Date.now()),
    }, async (response) => {
      try {
        resolve({
          status: response.statusCode ?? 0,
          headers: responseHeadersToRecord(response.headers),
          bodyText: await readBodyText(response),
        });
      } catch (error) {
        reject(error);
      }
    });
    request.on("timeout", () => {
      request.destroy(new Error("ctx.fetch timed out"));
    });
    request.on("error", reject);
    try {
      writeRequestBody(request, init.body);
    } catch (error) {
      request.destroy(error);
    }
  });
}

function normalizeRequestHeaders(headers) {
  const result = {};
  if (headers == null) return result;
  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() !== "host") result[key] = value;
    }
    return result;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const key = String(entry[0]);
      if (key.toLowerCase() !== "host") result[key] = String(entry[1]);
    }
    return result;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "host" && value !== undefined) result[key] = String(value);
    }
    return result;
  }
  throw new Error("ctx.fetch init headers must be an object, array, or Headers");
}

function responseHeadersToRecord(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function writeRequestBody(request, body) {
  if (body === undefined || body === null) {
    request.end();
    return;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    request.end(body);
    return;
  }
  if (body instanceof ArrayBuffer) {
    request.end(new Uint8Array(body));
    return;
  }
  if (ArrayBuffer.isView(body)) {
    request.end(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return;
  }
  throw new Error("ctx.fetch init body must be a string or bytes");
}

export function isDeniedAddress(address) {
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
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      throw new Error("ctx.fetch response body exceeded 5MB");
    }
    chunks.push(bytes);
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

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error("ctx.fetch timed out");
  }
}
