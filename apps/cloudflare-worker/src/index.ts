import { z } from "zod";
import RUNTIME from "../.generated/runtime.txt";
import { bearerMatches } from "../../cloudflare-sandbox/src/bearer.ts";
import type { SandboxExecAnswer } from "../../core/src/shared/domain/sandbox-config.ts";
import type { WorkerExecRequest } from "./contract.ts";
import { MAX_OUTPUT_BYTES, MAX_STATE_BYTES, MAX_TIMEOUT_MS } from "./limits.ts";
import type { Runtime } from "./runtime.ts";

const COMPATIBILITY_DATE = "2026-09-30";
const SANDBOX_PATH = /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,128})(\/exec)?$/;
const INTERNET_SUBREQUESTS = 50;
// Gunzip before and pack + gzip after the command, sized for a disk at the cap.
const CODEC_CPU_MS = 5_000;
// R2 deletes only unconditionally, so an emptied disk stays as an empty object with an etag.
const EMPTY_DISK = new Uint8Array(0);

const execRequest: z.ZodType<WorkerExecRequest> = z.object({
  script: z.string().min(1),
  args: z.array(z.string()).max(64),
  cwd: z.string().startsWith("/"),
  env: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
  outputLimitBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  enableInternet: z.boolean(),
  persist: z.boolean(),
});

interface Env {
  LOADER: WorkerLoader;
  STATE: R2Bucket;
  WORKER_API_KEY: string;
}

interface StoredState {
  bytes: Uint8Array | null;
  etag: string;
}

class StateConflict extends Error {}

class StateTooLarge extends Error {}

const handler: ExportedHandler<Env> = {
  fetch: async function (request: Request, env: Env): Promise<Response> {
    if (!(await bearerMatches(request, env.WORKER_API_KEY)))
      return new Response("Unauthorized", { status: 401 });
    const match = SANDBOX_PATH.exec(new URL(request.url).pathname);
    const id = match?.[1];
    if (!id) return new Response("Not found", { status: 404 });
    if (match[2] === "/exec" && request.method === "POST") {
      const body = execRequest.safeParse(
        await request.json().catch((): null => null),
      );
      if (!body.success)
        return Response.json({ error: body.error.message }, { status: 400 });

      return exec(env, id, body.data);
    }
    if (!match[2] && request.method === "GET")
      return Response.json({
        exists: (await env.STATE.head(stateKey(id))) !== null,
      });
    if (!match[2] && request.method === "DELETE") {
      await env.STATE.delete(stateKey(id));

      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

export default handler;

async function exec(
  env: Env,
  id: string,
  request: WorkerExecRequest,
): Promise<Response> {
  const key = stateKey(id);
  const startedAt = Date.now();
  try {
    const before = request.persist ? await readState(env.STATE, key) : null;
    const worker = env.LOADER.get(
      `${id}:${request.enableInternet ? "internet" : "offline"}:${request.timeoutMs}`,
      (): WorkerLoaderWorkerCode => ({
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "runtime.js",
        modules: { "runtime.js": RUNTIME },
        env: {},
        ...(request.enableInternet ? {} : { globalOutbound: null }),
        limits: {
          cpuMs: request.timeoutMs + CODEC_CPU_MS,
          subRequests: request.enableInternet ? INTERNET_SUBREQUESTS : 0,
        },
      }),
    );
    const answer = await worker
      .getEntrypoint<Runtime>("Runtime")
      .exec(request, before?.bytes ?? null);
    const result: SandboxExecAnswer = {
      ...answer.result,
      duration_ms: Date.now() - startedAt,
    };
    if (answer.state !== "unchanged")
      await writeState(env.STATE, key, before, answer.state);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof StateConflict)
      return new Response(message, { status: 409 });
    if (error instanceof StateTooLarge)
      return new Response(message, { status: 413 });

    return new Response(`the sandbox's isolate failed: ${message}`, {
      status: 500,
    });
  }
}

async function readState(
  bucket: R2Bucket,
  key: string,
): Promise<StoredState | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());

  return { bytes: bytes.byteLength === 0 ? null : bytes, etag: object.etag };
}

function stateKey(id: string): string {
  return `sandboxes/${id}`;
}

// Past the cap the old disk stays, so one runaway write cannot make the sandbox unloadable.
async function writeState(
  bucket: R2Bucket,
  key: string,
  before: StoredState | null,
  after: Uint8Array | null,
): Promise<void> {
  if (after === null && before === null) return;
  if (after !== null && after.byteLength > MAX_STATE_BYTES)
    throw new StateTooLarge(
      `the sandbox's files exceed ${MAX_STATE_BYTES} bytes compressed; remove some before the next command`,
    );
  const stored = await bucket.put(key, after ?? EMPTY_DISK, {
    onlyIf:
      before === null
        ? new Headers({ "If-None-Match": "*" })
        : { etagMatches: before.etag },
  });
  if (stored === null)
    throw new StateConflict(
      "another command changed the sandbox's files while this one ran; it stored nothing",
    );
}
