/**
 * SSRF-guarded pinned fetch: resolve the name, validate every address, then
 * connect to the address that was validated. Backs the isolate
 * fetch bridge and inbound attachment fetches in `channel-media.ts`.
 *
 * Error messages are neutral — every caller shows them to a different
 * audience, so the isolate bridge adds its own "ctx.fetch" label at its
 * boundary in `runner.mjs`. Types live in the sibling `pinned-fetch.d.mts`;
 * keep the two in sync.
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
// Tests may inject lookup/createConnection/allowAddresses/ca through opts;
// production callers should leave those unset so Node opens the socket directly
// to the validated address and verifies TLS against the system roots.
// `allowAddresses` exempts exact addresses (the test loopback) from the
// denylist — deliberately not a replacement for the check itself.
// `binary: true` returns the body as bytes in `bodyBytes` instead of decoded
// text in `bodyText`, and skips the body of a non-2xx answer entirely;
// `bodyLimitBytes` overrides the default body cap.
export async function guardedFetch(url, init, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(0, Number(opts.timeoutMs))
    : FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      guardedFetchWithDeadline(url, sanitizeFetchInit(init), {
        ...opts,
        signal: controller.signal,
        deadlineAt: Date.now() + timeoutMs,
        redirects: 0,
      }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function guardedFetchWithDeadline(url, init, state) {
  if (state.redirects > REDIRECT_LIMIT) {
    throw new Error("redirect limit exceeded");
  }
  throwIfAborted(state.signal);
  const parsed = validateHttpUrl(url);
  const pinned = await resolveAllowedAddress(parsed.hostname, state);
  const response = await requestPinned(parsed, pinned, init, state);
  if (isRedirect(response.status)) {
    const location = response.headers.location;
    if (!location) throw new Error("redirect missing location");

    return guardedFetchWithDeadline(
      new URL(location, parsed).toString(),
      init,
      {
        ...state,
        redirects: state.redirects + 1,
      },
    );
  }

  return response;
}

function validateHttpUrl(value) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new Error("url must be a string or URL");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http(s) URLs are supported");
  }
  if (!parsed.hostname) {
    throw new Error("URL must include a hostname");
  }

  return parsed;
}

async function resolveAllowedAddress(hostname, state) {
  const resolver = state.lookup ?? defaultLookup;
  const allowed = state.allowAddresses ?? [];
  const addresses = await resolver(hostname, { all: true, verbatim: false });
  const normalized = Array.isArray(addresses) ? addresses : [addresses];
  if (normalized.length === 0) {
    throw new Error(`hostname ${hostname} did not resolve`);
  }
  for (const address of normalized) {
    if (
      !address ||
      typeof address.address !== "string" ||
      (!allowed.includes(address.address) && isDeniedAddress(address.address))
    ) {
      throw new Error(`blocked private or metadata address for ${hostname}`);
    }
  }

  return normalized[0];
}

function requestPinned(parsed, pinned, init, state) {
  return new Promise((resolve, reject) => {
    throwIfAborted(state.signal);
    const client = parsed.protocol === "https:" ? https : http;
    const headers = normalizeRequestHeaders(init.headers);
    headers.Host = parsed.host;
    const request = client.request(
      {
        protocol: parsed.protocol,
        hostname: pinned.address,
        family: pinned.family,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        method: init.method === undefined ? "GET" : String(init.method),
        path: `${parsed.pathname}${parsed.search}`,
        headers: headers,
        servername: parsed.hostname,
        signal: state.signal,
        createConnection: state.createConnection,
        ca: state.ca,
        timeout: Math.max(1, state.deadlineAt - Date.now()),
      },
      async (response) => {
        try {
          const status = response.statusCode ?? 0;
          // A redirect's body is never surfaced, and a binary caller keeps
          // only bytes it can use: skip the download instead of buffering up
          // to the cap just to throw it away. Text callers still read error
          // bodies — ctx.fetch hands those back to the tool.
          const skipBody =
            isRedirect(status) ||
            (state.binary && (status < 200 || status >= 300));
          const body = skipBody
            ? new Uint8Array(0)
            : await readBodyBytes(response, state.bodyLimitBytes);
          if (skipBody) {
            response.resume();
          }
          resolve({
            status: status,
            headers: responseHeadersToRecord(response.headers),
            ...(state.binary
              ? { bodyBytes: body }
              : { bodyText: new TextDecoder().decode(body) }),
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("timed out"));
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
      if (key.toLowerCase() !== "host" && value !== undefined)
        result[key] = String(value);
    }

    return result;
  }
  throw new Error("init headers must be an object, array, or Headers");
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
  throw new Error("init body must be a string or bytes");
}

function isIpv6LinkLocal(normalized) {
  // fe80::/10 range: first 10 bits are 1111111010
  // fe80 = 1111 1110 1000 0000 through febf = 1111 1110 1011 1111
  const firstGroup = normalized.split(":")[0];
  if (!firstGroup) return false;
  const value = Number.parseInt(firstGroup, 16);
  if (!Number.isFinite(value)) return false;

  // fe80 (0xfe80 = 65152) through febf (0xfebf = 65215)
  return value >= 0xfe80 && value <= 0xfebf;
}

export function isDeniedAddress(address) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) tunnels a v4 address past the v6 checks —
    // evaluate the embedded v4 against the CIDR denylist instead.
    const mapped = normalized.match(
      /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
    );
    if (mapped) return isDeniedAddress(mapped[1]);

    return (
      normalized === "::" ||
      normalized === "::1" ||
      isIpv6LinkLocal(normalized) ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    );
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
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

// A declared Content-Length past the cap fails before any byte is read; a
// missing or lying one fails the moment the read crosses the cap, and the
// connection is torn down so the rest of the body is never downloaded.
async function readBodyBytes(response, limitBytes) {
  const limit = Number.isFinite(limitBytes) ? limitBytes : BODY_LIMIT_BYTES;
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    response.destroy();
    throw new Error(bodyLimitMessage(limit));
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > limit) {
      response.destroy();
      throw new Error(bodyLimitMessage(limit));
    }
    chunks.push(bytes);
  }

  return concatBytes(chunks, total);
}

function bodyLimitMessage(limitBytes) {
  return `response body exceeded ${Math.round(limitBytes / (1024 * 1024))}MB`;
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
    throw new Error("init must be an object");
  }
  const result = {};
  if (init.method !== undefined) result.method = String(init.method);
  if (init.headers !== undefined) result.headers = init.headers;
  if (init.body !== undefined) result.body = init.body;

  return result;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error("timed out");
  }
}
