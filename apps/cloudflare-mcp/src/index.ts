import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

const COMPATIBILITY_DATE = "2026-09-29";
/** Lambda's own synchronous invoke payload cap, so both runtimes take the same batch. */
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
/** Workers' script size cap. A bigger bundle has to stay on Lambda. */
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
/** The Lambda handler's OUTPUT_LIMIT_BYTES, shared by every response in a batch. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BUNDLE_FETCH_TIMEOUT_MS = 10_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
/** Per request into the tenant isolate. */
const TENANT_LIMITS = { cpuMs: 5_000, subRequests: 50 };
/** Same default-export contract as apps/lambda/child-runner.mjs. */
const ENTRY_MODULE = `import handler from "./tenant.js";
const serve = handler && typeof handler.fetch === "function" ? handler.fetch.bind(handler) : handler;
export default {
  fetch(request) {
    if (typeof serve !== "function") throw new Error("mcp server bundle default export must be a fetch handler (createMcpHandler)");
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
          method: z.enum(["POST", "DELETE"]),
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
  /** Bearer core sends as CLOUDFLARE_MCP_API_KEY. */
  MCP_API_KEY: string;
  /** Exact origin of the presigned tool-bundles S3 URLs core sends. */
  BUNDLE_ORIGIN: string;
}

/** Hosts tenant code may not reach: this runtime and the bundle store. */
interface OutboundProps {
  blockedHosts: string[];
}

type Batch = z.infer<typeof BATCH_SCHEMA>;

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
 * its own Dynamic Worker, cached by account and content hash, with no
 * bindings, no Node compatibility and egress through TenantOutbound. The
 * response is the NDJSON frame stream the Lambda runner speaks.
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
          "tenant.js": await loadBundle(batch),
        },
        env: {},
        globalOutbound: ctx.exports.TenantOutbound({
          props: { blockedHosts: [url.host, bundleOrigin.host] },
        }),
        limits: TENANT_LIMITS,
      }),
    );
    const budget: ByteBudget = { remaining: MAX_OUTPUT_BYTES };
    const frames = await Promise.all(
      batch.requests.map(
        async ({ id, mcpRequest }): Promise<string> =>
          await serveRequest(worker, id, mcpRequest, budget),
      ),
    );

    return new Response(
      `${[...frames, JSON.stringify({ t: "end" })].join("\n")}\n`,
      {
        headers: { "content-type": "application/x-ndjson" },
      },
    );
  },
};

/** Compares digests, so the check takes the same time whatever the guess. */
async function bearerMatches(request: Request, key: string): Promise<boolean> {
  const given = request.headers.get("authorization") ?? "";
  const [left, right] = await Promise.all(
    [given, `Bearer ${key}`].map(async (value): Promise<string> =>
      hex(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    ),
  );

  return left === right;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte): string => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Download the bundle once per isolate and refuse any byte the row did not hash. */
async function loadBundle(batch: Batch): Promise<string> {
  const response = await fetch(batch.bundleUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(BUNDLE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`bundle fetch failed with HTTP ${response.status}`);
  }
  const bytes = await readBoundedBytes(response.body, {
    remaining: MAX_BUNDLE_BYTES,
  });
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha256 !== batch.expectedSha256) {
    throw new Error("bundle sha256 does not match the uploaded row");
  }

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

/** One request into the tenant isolate, as the frame core settles it by. */
async function serveRequest(
  worker: WorkerStub,
  id: string,
  mcpRequest: Batch["requests"][number]["mcpRequest"],
  budget: ByteBudget,
): Promise<string> {
  try {
    const response = await worker.getEntrypoint().fetch(
      new Request("https://mcp.internal/mcp", {
        method: mcpRequest.method,
        headers: mcpRequest.headers,
        body: mcpRequest.body,
      }),
    );
    const body = await readBounded(response.body, budget);

    return JSON.stringify({
      t: "final",
      id: id,
      result: {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: body,
      },
    });
  } catch (error) {
    return JSON.stringify({
      t: "error",
      id: id,
      error: `mcp server failed on the cloudflare runtime: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
