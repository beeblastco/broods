/**
 * Real-bash sandbox behind apps/cloudflare-worker's HTTP API (core's `worker` provider) and
 * apps/cloudflare-sandbox's (`cloudflare`, the folder standing in for /workspace). Each sandbox is
 * a folder; it isolates nothing else: loopback only. bun native-sandbox.ts <port> <key> <root>
 */

import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const [port, keyFile, root] = process.argv.slice(2);
const key = readFileSync(keyFile!, "utf8").trim();
mkdirSync(root!, { recursive: true });

interface ExecRequest {
  script: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  persist: boolean;
}

/** apps/cloudflare-sandbox's body: one persistent container per id. */
interface BridgeExecRequest {
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
}

function fromBridge(id: string, body: BridgeExecRequest): ExecRequest {
  const dir = join(root!, id);
  const argv = body.argv.map((arg) =>
    arg === "/workspace" || arg.startsWith("/workspace/")
      ? dir + arg.slice("/workspace".length)
      : arg,
  );

  return {
    script: 'exec "$@"',
    args: argv,
    env: body.env,
    timeoutMs: body.timeoutMs,
    outputLimitBytes: body.outputLimitBytes,
    persist: true,
  };
}

// One command per sandbox at a time; a second caller waits instead of getting a 409.
const queues = new Map<string, Promise<unknown>>();

function capped(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return { text: text, truncated: false };

  return {
    text: new TextDecoder().decode(bytes.slice(0, limit)),
    truncated: true,
  };
}

async function exec(id: string, body: ExecRequest): Promise<Response> {
  const dir = join(root!, body.persist ? id : `once-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  const child = Bun.spawn(["bash", "-c", body.script, "bash", ...body.args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...body.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, body.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (!body.persist) rmSync(dir, { recursive: true, force: true });
  const out = capped(stdout, body.outputLimitBytes);
  const err = capped(stderr, body.outputLimitBytes);

  return Response.json({
    ok: !timedOut && exitCode === 0,
    runtime: "native-bash",
    exit_code: timedOut ? null : exitCode,
    timed_out: timedOut,
    duration_ms: Math.round(performance.now() - started),
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
  });
}

Bun.serve({
  port: Number(port),
  hostname: "127.0.0.1",
  fetch: async function (request): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${key}`)
      return new Response("unauthorized", { status: 401 });
    const match = /^\/v1\/sandboxes\/([A-Za-z0-9_-]+)(\/exec)?$/.exec(
      new URL(request.url).pathname,
    );
    if (!match) return new Response("not found", { status: 404 });
    const id = match[1]!;
    if (match[2] && request.method === "POST") {
      const raw = (await request.json()) as ExecRequest | BridgeExecRequest;
      const body = "argv" in raw ? fromBridge(id, raw) : raw;
      const previous = queues.get(id) ?? Promise.resolve();
      const run = previous.then(
        () => exec(id, body),
        () => exec(id, body),
      );
      queues.set(
        id,
        run.catch(() => {}),
      );

      return run;
    }
    if (request.method === "GET") {
      const exists = existsSync(join(root!, id));

      return Response.json({ exists: exists, running: exists });
    }
    if (request.method === "DELETE") {
      rmSync(join(root!, id), { recursive: true, force: true });

      return Response.json({ ok: true });
    }

    return new Response("method not allowed", { status: 405 });
  },
});
console.log(`native sandbox on ${port}`);
