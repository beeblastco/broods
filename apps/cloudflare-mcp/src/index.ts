import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { bearerMatches } from "../../cloudflare-sandbox/src/bearer.ts";

const COMPATIBILITY_DATE = "2026-09-29";
// MAX_REQUEST_BYTES, MAX_OUTPUT_BYTES and REQUEST_TIMEOUT_MS match the Lambda runner's.
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10_000_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Fits MAX_ERROR_MESSAGE_CHARS at JSON's worst 6 bytes each, a 32-char id and the frame keys.
const MAX_ERROR_FRAME_BYTES = 2048;
const MAX_ERROR_MESSAGE_CHARS = 256;
const REQUEST_TIMEOUT_MS = 30_000;
const BUNDLE_FETCH_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = BUNDLE_FETCH_TIMEOUT_MS + 2_000;
const NOTHING_RAN_HEADER = "x-broods-nothing-ran";
const END_FRAME = new TextEncoder().encode(`${JSON.stringify({ t: "end" })}\n`);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const TENANT_LIMITS = { cpuMs: 5_000, subRequests: 50 };
// Same default-export contract as apps/lambda/child-runner.mjs. Workers allow no I/O at module
// scope, so ensureLoaded pings `Loaded` to evaluate the bundle without serving a request.
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
  tenantId: z.string().min(1).max(256),
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
  BUNDLES: R2Bucket;
  MCP_API_KEY: string;
  BUNDLE_ORIGIN: string;
}

class DeadlineError extends Error {}

interface LoadedEntrypoint extends Rpc.WorkerEntrypointBranded {
  ping(): void;
}

interface OutboundProps {
  blockedHosts: string[];
}

type Batch = z.infer<typeof BATCH_SCHEMA>;

type BatchRequest = Batch["requests"][number];

/** Key order is wire format: core's frame reader expects `t`, then `id`. */
type Frame =
  | {
      t: "final";
      id: string;
      result: { status: number; headers: Record<string, string>; body: string };
    }
  | { t: "error"; id: string; error: string };

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

// redirect: "manual" makes every hop re-enter here; with no connect(), tenants get no raw TCP.
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
      `${batch.tenantId}:${batch.expectedSha256}`,
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

function boundedMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`.slice(
    0,
    MAX_ERROR_MESSAGE_CHARS,
  );
}

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

function encodeFrame(frame: Frame): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

async function ensureLoaded(worker: WorkerStub): Promise<void> {
  await withDeadline(
    worker.getEntrypoint<LoadedEntrypoint>("Loaded").ping(),
    LOAD_TIMEOUT_MS,
    "load timed out",
  );
}

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

async function loadBundle(
  batch: Batch,
  bundles: R2Bucket,
  ctx: ExecutionContext,
): Promise<string> {
  // Re-hashed on every load, so one content-addressed copy is safe to share across tenants.
  const key = `${batch.expectedSha256}.mjs`;
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

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  budget: ByteBudget,
): Promise<string> {
  return UTF8.decode(await readBoundedBytes(stream, budget));
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  budget: ByteBudget,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let taken = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      budget.remaining -= next.value.byteLength;
      taken += next.value.byteLength;
      if (budget.remaining < 0) throw new Error("body exceeds its size limit");
      chunks.push(next.value);
    }
  } catch (error) {
    budget.remaining += taken;
    throw error;
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

async function serveRequest(
  worker: WorkerStub,
  { id, mcpRequest }: BatchRequest,
  budget: ByteBudget,
): Promise<{ frame: Frame; drawn: number }> {
  try {
    return await withDeadline(
      (async (): Promise<{ frame: Frame; drawn: number }> => {
        const response = await worker.getEntrypoint().fetch(
          new Request("https://mcp.internal/mcp", {
            method: mcpRequest.method,
            headers: mcpRequest.headers,
            body: mcpRequest.body,
          }),
        );
        const bytes = await readBoundedBytes(response.body, budget);
        let body: string;
        try {
          body = UTF8.decode(bytes);
        } catch (error) {
          budget.remaining += bytes.byteLength;
          throw error;
        }

        return {
          frame: {
            t: "final",
            id: id,
            result: {
              status: response.status,
              headers: Object.fromEntries(response.headers),
              body: body,
            },
          },
          drawn: bytes.byteLength,
        };
      })(),
      REQUEST_TIMEOUT_MS,
      "run timed out",
    );
  } catch (error) {
    return { frame: errorFrame(id, error), drawn: 0 };
  }
}

// Reserves END_FRAME and one error frame per request, so an overrunning final becomes an error.
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
        const { frame, drawn } = await serveRequest(worker, request, budget);
        let line = encodeFrame(frame);
        const overhead = line.byteLength - drawn;
        if (frame.t === "final" && overhead > budget.remaining) {
          budget.remaining += drawn;
          line = encodeFrame(
            errorFrame(request.id, "output exceeded the 16 MiB batch limit"),
          );
        } else if (frame.t === "final") {
          budget.remaining -= overhead;
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
