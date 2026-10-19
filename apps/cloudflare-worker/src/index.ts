/**
 * The Worker behind core's `worker` sandbox provider. Core calls it over
 * bearer-authenticated HTTP with one bash command per request; the Worker
 * runs the command in a V8 isolate of its own per sandbox (a Dynamic Worker
 * running just-bash, see `runtime.ts`) and keeps a reserved sandbox's files
 * in R2 between calls. No container, no Durable Object, nothing runs while
 * no command does. Only the calls the executor makes live here; reservation
 * bookkeeping stays in core.
 */

import { z } from "zod";
import RUNTIME from "../.generated/runtime.txt";
import { bearerMatches } from "../../cloudflare-sandbox/src/bearer.ts";
import type { SandboxExecAnswer } from "../../core/src/shared/domain/sandbox-config.ts";
import type { WorkerExecRequest } from "./contract.ts";
import { MAX_OUTPUT_BYTES, MAX_STATE_BYTES, MAX_TIMEOUT_MS } from "./limits.ts";
import type { Runtime } from "./runtime.ts";

const COMPATIBILITY_DATE = "2026-09-30";
const SANDBOX_PATH = /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,128})(\/exec)?$/;
// Fetches one command may make once the sandbox has internet.
const INTERNET_SUBREQUESTS = 50;
// CPU the isolate spends on the disk around the command (gunzip before, pack
// and gzip after), sized for a disk at the cap, so a short timeout on a big
// disk does not kill the isolate before the command runs.
const CODEC_CPU_MS = 5_000;
// What an emptied disk is stored as, so the next write still has an etag to
// condition on: R2 can delete unconditionally only.
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

/** The stored object under a sandbox id: its disk, or null once emptied, and the etag it was read under. */
interface StoredState {
  bytes: Uint8Array | null;
  etag: string;
}

/** Another command changed or dropped the stored disk while this one ran. */
class StateConflict extends Error {}

/** The disk after a command would not fit the store. */
class StateTooLarge extends Error {}

const handler: ExportedHandler<Env> = {
  /** Authenticates core's bearer token, then routes to the sandbox it names. */
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

/**
 * Runs one command in the sandbox's isolate: its stored disk goes in, the
 * disk after the command comes back and is stored again if it changed. The
 * isolate is keyed by what is fixed at load (its network and CPU limit), so a
 * sandbox whose config changes gets a fresh one. Every store is conditional
 * on the etag the disk was read under, so of two calls on one sandbox at
 * once the second to finish answers 409 and stores nothing. A failure in the
 * runtime or the store answers its message, so core can show it.
 */
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

// The stored disk under `key`, with its etag; an emptied disk reads as null bytes.
async function readState(
  bucket: R2Bucket,
  key: string,
): Promise<StoredState | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());

  return { bytes: bytes.byteLength === 0 ? null : bytes, etag: object.etag };
}

// Where a sandbox's disk lives in the bucket.
function stateKey(id: string): string {
  return `sandboxes/${id}`;
}

// Stores the disk after a command, only if the disk is still the one the
// command started from: the etag it was read under, or no object at all. An
// emptied disk is stored as an empty object for the same reason. A disk past
// the cap stays as it was, so one runaway write cannot make the sandbox
// unloadable; the error tells the agent what to clean up.
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
