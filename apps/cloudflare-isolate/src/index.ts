/**
 * The Worker behind core's `isolate` sandbox provider. Core calls it over
 * bearer-authenticated HTTP with one bash command per request; the Worker
 * runs the command in a V8 isolate of its own per sandbox (a Dynamic Worker
 * running just-bash, see `runtime.ts`) and keeps a reserved sandbox's files
 * in R2 between calls. No container, no Durable Object, nothing runs while
 * no command does. Only the calls the executor makes live here; reservation
 * bookkeeping stays in core.
 */

import { z } from "zod";
import RUNTIME from "../.generated/runtime.txt";
import type { ExecResult, RuntimeExecResult } from "./contract.ts";
import { MAX_OUTPUT_BYTES, MAX_STATE_BYTES, MAX_TIMEOUT_MS } from "./limits.ts";
import type { Runtime } from "./runtime.ts";

const COMPATIBILITY_DATE = "2026-09-30";
const SANDBOX_PATH = /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,128})(\/exec)?$/;
const STATE_PREFIX = "sandboxes/";
// Fetches one command may make once the sandbox has internet.
const INTERNET_SUBREQUESTS = 50;
// How the runtime reports a command the isolate's CPU limit stopped.
const CPU_LIMIT = /cpu|exceeded|limit/i;

const execRequest = z.object({
  script: z.string().min(1),
  args: z.array(z.string()).max(64),
  cwd: z.string().startsWith("/"),
  env: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
  outputLimitBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  enableInternet: z.boolean(),
  persist: z.boolean(),
});

type ExecRequest = z.infer<typeof execRequest>;

interface Env {
  LOADER: WorkerLoader;
  STATE: R2Bucket;
  ISOLATE_API_KEY: string;
}

const handler: ExportedHandler<Env> = {
  /** Authenticates core's bearer token, then routes to the sandbox it names. */
  fetch: async function (request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env.ISOLATE_API_KEY)))
      return new Response("Unauthorized", { status: 401 });
    const match = SANDBOX_PATH.exec(new URL(request.url).pathname);
    const id = match?.[1];
    if (!id) return new Response("Not found", { status: 404 });
    const key = `${STATE_PREFIX}${id}`;
    if (match[2] === "/exec" && request.method === "POST") {
      const body = execRequest.safeParse(
        await request.json().catch((): null => null),
      );
      if (!body.success)
        return Response.json({ error: body.error.message }, { status: 400 });

      return exec(env, id, key, body.data);
    }
    if (!match[2] && request.method === "GET")
      return Response.json({ exists: (await env.STATE.head(key)) !== null });
    if (!match[2] && request.method === "DELETE") {
      await env.STATE.delete(key);

      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

export default handler;

// Hashing first makes the compare constant-time whatever the token lengths.
async function authorized(request: Request, apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  const header = request.headers.get("Authorization") ?? "";
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${apiKey}`)),
  ]);

  return crypto.subtle.timingSafeEqual(given, expected);
}

/** A stored disk and the etag it was read under. */
interface StoredState {
  bytes: Uint8Array;
  etag: string;
}

/** Another call changed or dropped the stored disk while this one ran. */
class StateConflict extends Error {}

/**
 * Runs one command in the sandbox's isolate: its stored disk goes in, the
 * disk after the command comes back and is stored again if it changed. The
 * isolate is keyed by what is fixed at load (its network and CPU limit), so a
 * sandbox whose config changes gets a fresh one. Two calls on one sandbox at
 * once each start from the same disk; the write is conditional on the etag
 * it was read under, so the second to finish answers 409 and stores nothing,
 * and core runs it again on the disk the first left.
 */
async function exec(
  env: Env,
  id: string,
  key: string,
  request: ExecRequest,
): Promise<Response> {
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
        cpuMs: request.timeoutMs,
        subRequests: request.enableInternet ? INTERNET_SUBREQUESTS : 0,
      },
    }),
  );
  const startedAt = Date.now();
  const answer = await worker
    .getEntrypoint<Runtime>("Runtime")
    .exec(request, before?.bytes ?? null)
    .catch((error: unknown): RuntimeExecResult => {
      const message = error instanceof Error ? error.message : String(error);
      if (!CPU_LIMIT.test(message)) throw error;

      return { result: stopped(message), state: null };
    });
  const result: ExecResult = {
    ...answer.result,
    duration_ms: Date.now() - startedAt,
  };
  if (request.persist && !answer.result.timed_out) {
    try {
      await writeState(env.STATE, key, before, answer.state);
    } catch (error) {
      if (!(error instanceof StateConflict)) throw error;

      return new Response(error.message, { status: 409 });
    }
  }

  return Response.json(result);
}

async function readState(
  bucket: R2Bucket,
  key: string,
): Promise<StoredState | null> {
  const object = await bucket.get(key);
  if (object === null) return null;

  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    etag: object.etag,
  };
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }

  return true;
}

// A command the isolate's CPU limit ended: its output is gone with the isolate.
function stopped(message: string): ExecResult {
  return {
    ok: false,
    exit_code: null,
    timed_out: true,
    duration_ms: 0,
    stdout: "",
    stderr: message,
    truncated: false,
  };
}

// A disk past the cap stays as it was, so one runaway write cannot make the
// sandbox unloadable; the error tells the agent what to clean up. The put is
// conditional on the disk still being the one the command started from: the
// etag it was read under, or no object at all.
async function writeState(
  bucket: R2Bucket,
  key: string,
  before: StoredState | null,
  after: Uint8Array | null,
): Promise<void> {
  if (sameBytes(before?.bytes ?? null, after)) return;
  if (after === null) {
    if (before !== null) await bucket.delete(key);

    return;
  }
  if (after.byteLength > MAX_STATE_BYTES)
    throw new Error(
      `the sandbox's files exceed ${MAX_STATE_BYTES} bytes compressed; remove some before the next command`,
    );
  const stored = await bucket.put(key, after, {
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
