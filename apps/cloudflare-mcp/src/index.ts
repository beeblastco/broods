import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

const COMPATIBILITY_DATE = "2026-09-29";
/** Lambda's own synchronous invoke payload cap, so both runtimes take the same batch. */
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
/** The config plane's inline bundle cap, under Workers' script size cap. */
const MAX_BUNDLE_BYTES = 10_000_000;
/** The Lambda handler's OUTPUT_LIMIT_BYTES: every encoded frame of a batch, newlines included. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/**
 * Reserved per request for its error frame. 256 message chars at JSON's worst
 * 6 bytes each, plus a 32-char id and the frame keys, stay under it.
 */
const MAX_ERROR_FRAME_BYTES = 2048;
const MAX_ERROR_MESSAGE_CHARS = 256;
/** The Lambda runner's RUN_TIMEOUT_MS, per request here. */
const REQUEST_TIMEOUT_MS = 30_000;
const BUNDLE_FETCH_TIMEOUT_MS = 10_000;
/** Bundle download plus module evaluation, before the batch is answered. */
const LOAD_TIMEOUT_MS = BUNDLE_FETCH_TIMEOUT_MS + 2_000;
/** Set only on this Worker's own refusals before any request ran; core reruns those on Lambda. */
const NOTHING_RAN_HEADER = "x-broods-nothing-ran";
const END_FRAME = new TextEncoder().encode(`${JSON.stringify({ t: "end" })}\n`);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
/** Per request into the tenant isolate. */
const TENANT_LIMITS = { cpuMs: 5_000, subRequests: 50 };
/**
 * Same default-export contract as apps/lambda/child-runner.mjs, checked while
 * the modules evaluate. ensureLoaded calls `Loaded`, which evaluates the
 * modules but serves no request; Workers allow no I/O at module scope.
 */
const ENTRY_MODULE = `import { WorkerEntrypoint } from "cloudflare:workers";
import handler from "./tenant.js";
const serve = handler && typeof handler.fetch === "function" ? handler.fetch.bind(handler) : handler;
if (typeof serve !== "function") throw new Error("mcp server bundle default export must be a fetch handler (createMcpHandler)");
export class Loaded extends WorkerEntrypoint {
  ping() {}
}
export default {
  fetch(request) {
    return serve(request);
  },
};`;
const BATCH_SCHEMA = z.object({
  accountId: z.string().min(1).max(128),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bundleUrl: z.url({ protocol: /^https$/ }),
  requests: z
    .array(
      z.object({
        id: z.string().min(1).max(32),
        mcpRequest: z.object({
          method: z.string().regex(/^[A-Z]{1,16}$/),
          headers: z.record(z.string(), z.string()),
          body: z.string().optional(),
        }),
      }),
    )
    .min(1)
    .max(32),
});

interface Env {
  LOADER: WorkerLoader;
  /** This runtime's own copy of each bundle it loaded, so a cold load stays in Cloudflare. */
  BUNDLES: R2Bucket;
  /** Bearer core sends as CLOUDFLARE_MCP_API_KEY. */
  MCP_API_KEY: string;
  /** Exact origin of the presigned tool-bundles S3 URLs core sends. */
  BUNDLE_ORIGIN: string;
}

/** A withDeadline that ran out: transient, unlike a bundle that cannot load. */
class DeadlineError extends Error {}

/** The entry module's `Loaded` entrypoint; ensureLoaded calls it. */
interface LoadedEntrypoint extends Rpc.WorkerEntrypointBranded {
  ping(): void;
}

/** Hosts tenant code may not reach: this runtime and the bundle store. */
interface OutboundProps {
  blockedHosts: string[];
}

type Batch = z.infer<typeof BATCH_SCHEMA>;

type BatchRequest = Batch["requests"][number];

/** One NDJSON frame, `t` then `id` first as core's frame reader expects. */
type Frame =
  | {
      t: "final";
      id: string;
      result: { status: number; headers: Record<string, string>; body: string };
    }
  | { t: "error"; id: string; error: string };

/** A shared byte allowance; every read of a batch draws from one. */
interface ByteBudget {
  remaining: number;
}

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index.ts");
    }
  }
}

/**
 * Every fetch the tenant isolate makes arrives here (its `globalOutbound`).
 * Public http(s) passes; this runtime and the bundle store do not. Redirects
 * come back to the tenant's own fetch, which re-enters here for each hop.
 * No `connect()`, so raw TCP sockets are unavailable to tenant code.
 */
export class TenantOutbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      this.ctx.props.blockedHosts.includes(url.host)
    ) {
      return new Response("blocked by the Broods MCP egress policy", {
        status: 403,
      });
    }

    return await fetch(request, { redirect: "manual" });
  }
}

/**
 * Core's hosted MCP transport POSTs one batch to `/mcp` with the shared
 * bearer (apps/core/src/harness/mcp/hosted.ts). Each account bundle runs in
 * its own Dynamic Worker, cached by account and content hash and read from
 * this runtime's R2 copy before S3, with no
 * bindings, no Node compatibility and egress through TenantOutbound. The
 * bundle loads before the batch is answered: a bundle that cannot load is a
 * 422 (504 when loading only timed out) tagged NOTHING_RAN_HEADER, which
 * core reruns on Lambda. The response streams
 * the NDJSON frames the Lambda runner speaks, each as soon as its request
 * settles, then `end`.
 */
export default {
  fetch: async function (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (!env.MCP_API_KEY || !env.BUNDLE_ORIGIN) {
      return new Response("runtime is not configured", { status: 503 });
    }
    if (!(await bearerMatches(request, env.MCP_API_KEY))) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname !== "/mcp" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    let batch: Batch;
    try {
      batch = BATCH_SCHEMA.parse(
        JSON.parse(
          await readBounded(request.body, { remaining: MAX_REQUEST_BYTES }),
        ),
      );
    } catch {
      return new Response("invalid or oversized MCP batch", { status: 400 });
    }
    const bundleOrigin = new URL(env.BUNDLE_ORIGIN);
    if (new URL(batch.bundleUrl).origin !== bundleOrigin.origin) {
      return new Response("bundleUrl is outside BUNDLE_ORIGIN", {
        status: 400,
      });
    }
    const worker = env.LOADER.get(
      `${batch.accountId}:${batch.expectedSha256}`,
      async (): Promise<WorkerLoaderWorkerCode> => ({
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: "entry.js",
        modules: {
          "entry.js": ENTRY_MODULE,
          "tenant.js": await loadBundle(batch, env.BUNDLES, ctx),
        },
        env: {},
        globalOutbound: ctx.exports.TenantOutbound({
          props: { blockedHosts: [url.host, bundleOrigin.host] },
        }),
        limits: TENANT_LIMITS,
      }),
    );
    try {
      await ensureLoaded(worker);
    } catch (error) {
      return new Response(boundedMessage("bundle failed to load", error), {
        status: error instanceof DeadlineError ? 504 : 422,
        headers: { [NOTHING_RAN_HEADER]: "1" },
      });
    }
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    ctx.waitUntil(streamFrames(worker, batch.requests, writable));

    return new Response(readable, {
      headers: { "content-type": "application/x-ndjson" },
    });
  },
};

/** Compares equal-length digests in constant time, whatever the guess. */
async function bearerMatches(request: Request, key: string): Promise<boolean> {
  const given = request.headers.get("authorization") ?? "";
  const [left, right] = await Promise.all(
    [given, `Bearer ${key}`].map(
      async (value): Promise<ArrayBuffer> =>
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );

  return crypto.subtle.timingSafeEqual(left!, right!);
}

/** A thrown value as one line, capped like every message a batch carries. */
function boundedMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`.slice(
    0,
    MAX_ERROR_MESSAGE_CHARS,
  );
}

/** Download a bundle from the presigned S3 URL, capped at the Worker bundle size. */
async function downloadBundle(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(BUNDLE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`bundle fetch failed with HTTP ${response.status}`);
  }

  return await readBoundedBytes(response.body, {
    remaining: MAX_BUNDLE_BYTES,
  });
}

/** Encode a frame as one NDJSON line. */
function encodeFrame(frame: Frame): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

/**
 * Load the bundle and evaluate its modules without running a request. Throws
 * on a failed download, a hash mismatch, code workerd refuses, or a bad
 * default export.
 */
async function ensureLoaded(worker: WorkerStub): Promise<void> {
  await withDeadline(
    worker.getEntrypoint<LoadedEntrypoint>("Loaded").ping(),
    LOAD_TIMEOUT_MS,
    "load timed out",
  );
}

/** A bounded error frame; it always fits the reserve streamFrames keeps for it. */
function errorFrame(id: string, error: unknown): Frame {
  return {
    t: "error",
    id: id,
    error: boundedMessage("mcp server failed on the cloudflare runtime", error),
  };
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte): string => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The bundle's bytes, once per isolate: from this runtime's R2 copy, or on a
 * miss (or an R2 error) from S3, keeping a copy for the next cold load.
 * Refuses any byte the row did not hash, whichever store served it.
 */
async function loadBundle(
  batch: Batch,
  bundles: R2Bucket,
  ctx: ExecutionContext,
): Promise<string> {
  const key = `${encodeURIComponent(batch.accountId)}/${batch.expectedSha256}.mjs`;
  const copy = await bundles
    .get(key)
    .then(async (object): Promise<Uint8Array | null> =>
      object ? new Uint8Array(await object.arrayBuffer()) : null,
    )
    .catch((): null => null);
  const bytes = copy ?? (await downloadBundle(batch.bundleUrl));
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha256 !== batch.expectedSha256) {
    throw new Error("bundle sha256 does not match the uploaded row");
  }
  if (!copy) ctx.waitUntil(bundles.put(key, bytes, { sha256: sha256 }));

  return UTF8.decode(bytes);
}

/** Read a body as UTF-8 text, drawing its bytes from the budget. */
async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  budget: ByteBudget,
): Promise<string> {
  return UTF8.decode(await readBoundedBytes(stream, budget));
}

/** Read a body, throwing as soon as it overdraws the budget. */
async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  budget: ByteBudget,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      budget.remaining -= next.value.byteLength;
      if (budget.remaining < 0) throw new Error("body exceeds its size limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk): number => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/**
 * One request into the tenant isolate, bounded by REQUEST_TIMEOUT_MS. Reads
 * at most `maxBodyBytes`, the most a frame could still take of the batch.
 */
async function serveRequest(
  worker: WorkerStub,
  { id, mcpRequest }: BatchRequest,
  maxBodyBytes: number,
): Promise<Frame> {
  try {
    return await withDeadline(
      (async (): Promise<Frame> => {
        const response = await worker.getEntrypoint().fetch(
          new Request("https://mcp.internal/mcp", {
            method: mcpRequest.method,
            headers: mcpRequest.headers,
            body: mcpRequest.body,
          }),
        );
        const body = await readBounded(response.body, {
          remaining: maxBodyBytes,
        });

        return {
          t: "final",
          id: id,
          result: {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: body,
          },
        };
      })(),
      REQUEST_TIMEOUT_MS,
      "run timed out",
    );
  } catch (error) {
    return errorFrame(id, error);
  }
}

/**
 * Serve every request concurrently and write each frame the moment it
 * settles, then `end`. Encoded frames share one MAX_OUTPUT_BYTES budget; the
 * end frame and one error frame per request are reserved up front, so a
 * final frame that would overrun the batch becomes an error instead.
 */
async function streamFrames(
  worker: WorkerStub,
  requests: BatchRequest[],
  writable: WritableStream<Uint8Array>,
): Promise<void> {
  const writer = writable.getWriter();
  const budget: ByteBudget = {
    remaining:
      MAX_OUTPUT_BYTES -
      END_FRAME.byteLength -
      requests.length * MAX_ERROR_FRAME_BYTES,
  };
  try {
    await Promise.all(
      requests.map(async (request): Promise<void> => {
        const frame = await serveRequest(worker, request, budget.remaining);
        let line = encodeFrame(frame);
        if (frame.t === "final" && line.byteLength > budget.remaining) {
          line = encodeFrame(
            errorFrame(request.id, "output exceeded the 16 MiB batch limit"),
          );
        } else if (frame.t === "final") {
          budget.remaining -= line.byteLength;
        }
        await writer.write(line);
      }),
    );
    await writer.write(END_FRAME);
    await writer.close();
  } catch (error) {
    await writer.abort(error);
  }
}

/** Settle with `work`, or reject with `message` once `ms` pass. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject): void => {
        timer = setTimeout((): void => reject(new DeadlineError(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
