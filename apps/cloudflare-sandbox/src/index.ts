/**
 * Bridge between core's `cloudflare` sandbox executor and Cloudflare Containers.
 * The Container API only answers inside a Durable Object, so core calls this
 * Worker over bearer-authenticated HTTP and each sandbox id is one `Sandbox`
 * Durable Object that owns one Container. Only the calls the executor and the
 * dashboard terminal make live here; reservation bookkeeping stays in core.
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { SandboxExecResponse } from "../../core/src/shared/domain/sandbox-config.ts";
import { MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS } from "./limits.ts";

const SANDBOX_PATH =
  /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,128})(\/exec|\/terminal)?$/;
const TERMINAL_SIZE = { cols: 120, rows: 32 };
// Seconds `timeout` waits after its TERM before it sends KILL.
const KILL_GRACE_SECONDS = 5;
// The abort fires only past the KILL, for an exec that never settles.
const BACKSTOP_GRACE_MS = (KILL_GRACE_SECONDS + 5) * 1000;

const execRequest = z.object({
  argv: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
  outputLimitBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  idleTimeoutSeconds: z.number().int().positive(),
  enableInternet: z.boolean(),
  instance: z.enum([
    "lite",
    "standard-1",
    "standard-2",
    "standard-3",
    "standard-4",
  ]),
});

type ExecRequest = z.infer<typeof execRequest>;

interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  SANDBOX_API_KEY: string;
}

/**
 * One finished command, its output capped at the request's limit per stream:
 * core's `SandboxExecResponse` (the sandbox exec contract), so core reads it
 * with the parser every exec server goes through.
 */
export type ExecResult = Required<
  Pick<
    SandboxExecResponse,
    | "duration_ms"
    | "exit_code"
    | "ok"
    | "stderr"
    | "stdout"
    | "timed_out"
    | "truncated"
  >
>;

/** One sandbox: the Container it starts and the commands core runs in it. */
export class Sandbox extends DurableObject<Env> {
  #starting: Promise<void> | null = null;
  #booting = false;

  /**
   * Starts the Container on first use, then runs one command to completion.
   * GNU `timeout` kills the command's whole process group at the deadline, so
   * a background child dies with it; the abort is only a backstop for a wedged
   * exec, and it is cleared once the command settles, because aborting an
   * exited process throws.
   */
  async exec(request: ExecRequest): Promise<ExecResult> {
    const startedAt = Date.now();
    const container = this.#container();
    await this.#ensureRunning(container, request);
    const backstop = new AbortController();
    const timer = setTimeout(
      (): void => backstop.abort(),
      request.timeoutMs + BACKSTOP_GRACE_MS,
    );
    try {
      const process = await container
        .exec(
          [
            "timeout",
            "-k",
            `${KILL_GRACE_SECONDS}`,
            `${request.timeoutMs / 1000}s`,
            ...request.argv,
          ],
          {
            env: request.env,
            signal: backstop.signal,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        .finally((): void => {
          this.#booting = false;
        });
      const [stdout, stderr] = await Promise.all([
        readCapped(process.stdout, request.outputLimitBytes, backstop.signal),
        readCapped(process.stderr, request.outputLimitBytes, backstop.signal),
      ]);
      const finished = await process.exitCode.catch((): null => null);
      // 124 is the TERM `timeout` sends, 137 the KILL its `-k` follows with.
      const timedOut =
        backstop.signal.aborted || finished === 124 || finished === 137;
      const exitCode = timedOut ? null : finished;

      return {
        ok: exitCode === 0,
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stops the Container and drops its disk. One still starting is stopped too,
   * so a terminate during the first exec does not leave it running.
   */
  async destroy(): Promise<void> {
    const container = this.#container();
    if (container.running || this.#booting) await container.destroy();
  }

  /** Opens a PTY shell over a WebSocket: raw bytes both ways, no resize frames. */
  async fetch(request: Request): Promise<Response> {
    const container = this.#container();
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    if (!container.running)
      return new Response("Sandbox is not running", { status: 409 });
    const abort = new AbortController();
    const shell = await container.exec(["bash", "-l"], {
      pty: TERMINAL_SIZE,
      env: { TERM: "xterm-256color" },
      signal: abort.signal,
      stdin: "pipe",
    });
    if (!shell.stdin) {
      abort.abort();
      throw new Error("The terminal shell has no stdin");
    }
    const stdin = shell.stdin.getWriter();
    const { 0: client, 1: server } = new WebSocketPair();
    server.binaryType = "arraybuffer";
    server.accept();
    const encoder = new TextEncoder();
    server.addEventListener("message", (event): void => {
      const bytes =
        typeof event.data === "string"
          ? encoder.encode(event.data)
          : new Uint8Array(event.data);
      stdin
        .write(bytes)
        .catch((): void => server.close(1011, "Terminal input failed"));
    });
    // Aborting a shell that already exited throws, so only a live one is killed.
    let exited = false;
    void shell.exitCode.finally((): void => {
      exited = true;
    });
    server.addEventListener("close", (): void => {
      if (!exited) abort.abort();
    });
    void (async (): Promise<void> => {
      if (shell.stdout)
        for await (const chunk of shell.stdout) server.send(chunk);
      server.close(1000, `Shell exited with code ${await shell.exitCode}`);
    })().catch((): void => server.close(1011, "Terminal output failed"));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether the Container is up. A stopped one has lost its disk. */
  status(): { running: boolean } {
    return { running: this.#container().running };
  }

  #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The container binding is not configured");

    return container;
  }

  // `start()` returns before the Container is ready and its first `exec()`
  // waits for it, per the Container API. `running` can read false until then,
  // so `#booting` holds the shared start until an exec gets through. Concurrent
  // first calls share one start, and a failed setup destroys the half-started
  // Container.
  #ensureRunning(container: Container, request: ExecRequest): Promise<void> {
    if (this.#starting === null || (!this.#booting && !container.running)) {
      this.#booting = true;
      this.#starting = (async (): Promise<void> => {
        if (!container.running) {
          container.start({
            image: requiredImage(container),
            enableInternet: request.enableInternet,
            instance: request.instance,
          });
        }
        try {
          await container.setInactivityTimeout(
            request.idleTimeoutSeconds * 1000,
          );
        } catch (error) {
          await container.destroy();
          throw error;
        }
      })().catch((error: unknown): never => {
        this.#starting = null;
        this.#booting = false;
        throw error;
      });
    }

    return this.#starting;
  }
}

const handler: ExportedHandler<Env> = {
  /** Authenticates core's bearer token, then routes to the sandbox it names. */
  fetch: async function (request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env.SANDBOX_API_KEY)))
      return new Response("Unauthorized", { status: 401 });
    const match = SANDBOX_PATH.exec(new URL(request.url).pathname);
    if (!match?.[1]) return new Response("Not found", { status: 404 });
    const sandbox = env.SANDBOX.getByName(match[1]);
    const action = match[2];
    if (action === "/terminal") return sandbox.fetch(request);
    if (action === "/exec" && request.method === "POST") {
      const body = execRequest.safeParse(
        await request.json().catch((): null => null),
      );
      if (!body.success)
        return Response.json({ error: body.error.message }, { status: 400 });

      return Response.json(await sandbox.exec(body.data));
    }
    if (!action && request.method === "GET")
      return Response.json(await sandbox.status());
    if (!action && request.method === "DELETE") {
      await sandbox.destroy();

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

// Keeps the first `limit` bytes and drains the rest, so a chatty command can
// not grow the Durable Object's memory. The timeout cancels the read, so a
// stream the killed process left open can not hold the request past it.
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const kept: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream?.getReader();
  const cancel = (): void => void reader?.cancel().catch((): void => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - size;
      if (value.byteLength > room) truncated = true;
      if (room > 0) {
        // A copy, so a kept prefix does not pin the whole chunk's buffer.
        const part = value.slice(0, room);
        kept.push(part);
        size += part.byteLength;
      }
    }
  } catch {
    // The process was killed mid-stream; keep what arrived.
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return { text: new TextDecoder().decode(bytes), truncated: truncated };
}

function requiredImage(container: Container): string {
  const image = container.images.sandbox;
  if (!image) throw new Error("wrangler.jsonc must define the sandbox image");

  return image;
}
