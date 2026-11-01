import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { SandboxExecAnswer } from "../../core/src/shared/domain/sandbox-config.ts";
import { bearerMatches } from "./bearer.ts";
import {
  MAX_IDLE_TIMEOUT_SECONDS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
} from "./limits.ts";
import { verifyTerminalToken } from "./terminal-token.ts";

const SANDBOX_PATH =
  /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,128})(\/exec|\/terminal)?$/;
const TERMINAL_SIZE = { cols: 120, rows: 32 };
const PROMPT_UNSAFE = /[^A-Za-z0-9_.-]+/g;
const KILL_GRACE_SECONDS = 5;
const BACKSTOP_GRACE_MS = (KILL_GRACE_SECONDS + 5) * 1000;
const LAUNCH_KEY = "launch";
const IDLE_KEY = "idleMs";

const execRequest = z.object({
  argv: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
  outputLimitBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  idleTimeoutSeconds: z.number().int().positive().max(MAX_IDLE_TIMEOUT_SECONDS),
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

export type ExecResult = SandboxExecAnswer;

export class Sandbox extends DurableObject<Env> {
  #starting: Promise<void> | null = null;
  #booting = false;

  // The idle window lives on this DO instance, so a restarted one must set it again or the
  // platform default stops the running Container within a minute.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    const idleMs = ctx.storage.kv.get<number>(IDLE_KEY);
    if (container?.running && idleMs !== undefined) {
      void ctx.blockConcurrencyWhile((): Promise<void> =>
        container
          .setInactivityTimeout(idleMs)
          .catch((error: unknown): void =>
            console.error("restoring the idle window failed", error),
          ),
      );
    }
  }

  // GNU timeout kills the command's whole process group; the abort only backstops a wedged exec.
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
      // 124/137 are timeout's TERM/KILL, but before the deadline the command's own exit or an OOM.
      const pastDeadline = Date.now() - startedAt >= request.timeoutMs;
      const timedOut =
        backstop.signal.aborted ||
        (pastDeadline && (finished === 124 || finished === 137));
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

  async destroy(): Promise<void> {
    const container = this.#container();
    if (container.running || this.#booting) await container.destroy();
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.#container();
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    if (!container.running)
      return new Response("Sandbox is not running", { status: 409 });
    const abort = new AbortController();
    const name = (new URL(request.url).searchParams.get("name") ?? "")
      .replace(PROMPT_UNSAFE, "-")
      .slice(0, 63);
    const shell = await container.exec(["bash", "-l"], {
      cwd: "/workspace",
      pty: TERMINAL_SIZE,
      env: {
        TERM: "xterm-256color",
        ...(name ? { BROODS_SANDBOX_NAME: name } : {}),
      },
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
    // Aborting an exited process throws.
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

  status(): { running: boolean } {
    return { running: this.#container().running };
  }

  #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The container binding is not configured");

    return container;
  }

  // `running` reads false until the first exec after start() gets through; #booting covers that.
  // Internet and size are fixed at start(), so a Container under another policy is replaced.
  #ensureRunning(container: Container, request: ExecRequest): Promise<void> {
    const launch = `${request.enableInternet ? "internet" : "offline"}:${request.instance}`;
    const relaunch =
      container.running &&
      this.ctx.storage.kv.get<string>(LAUNCH_KEY) !== launch;
    if (
      this.#starting === null ||
      relaunch ||
      (!this.#booting && !container.running)
    ) {
      this.#booting = true;
      this.#starting = (async (): Promise<void> => {
        if (relaunch) await container.destroy();
        if (!container.running) {
          container.start({
            image: requiredImage(container),
            enableInternet: request.enableInternet,
            instance: request.instance,
          });
          this.ctx.storage.kv.put(LAUNCH_KEY, launch);
        }
        try {
          await container.setInactivityTimeout(
            request.idleTimeoutSeconds * 1000,
          );
          this.ctx.storage.kv.put(IDLE_KEY, request.idleTimeoutSeconds * 1000);
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
  fetch: async function (request: Request, env: Env): Promise<Response> {
    const match = SANDBOX_PATH.exec(new URL(request.url).pathname);
    const action = match?.[2];
    const allowed =
      (await bearerMatches(request, env.SANDBOX_API_KEY)) ||
      (action === "/terminal" &&
        (await terminalAuthorized(request, env.SANDBOX_API_KEY, match![1]!)));
    if (!allowed) return new Response("Unauthorized", { status: 401 });
    if (!match?.[1]) return new Response("Not found", { status: 404 });
    const sandbox = env.SANDBOX.getByName(match[1]);
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

async function terminalAuthorized(
  request: Request,
  apiKey: string,
  sandboxId: string,
): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;

  return await verifyTerminalToken(
    apiKey,
    header.slice("Bearer ".length),
    sandboxId,
    Date.now(),
  );
}

// Drains past the limit to bound memory; the abort cancels a stream a killed process left open.
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
