/**
 * A real-shell sandbox behind the same HTTP API as apps/cloudflare-worker
 * (POST /v1/sandboxes/:id/exec, GET and DELETE /v1/sandboxes/:id), so core's
 * `worker` provider can use it unchanged by pointing CLOUDFLARE_WORKER_URL here.
 * Each command runs in real bash with the sandbox's own folder as the working
 * directory; a persistent sandbox keeps its folder between commands.
 *
 * It stands in for a Linux sandbox a worker reaches over HTTP (a microVM or
 * container pool). It isolates nothing beyond the folder: bench use only, on
 * loopback. A production one adds the VM or container's own overhead.
 *
 * bun native-sandbox.ts <port> <key-file> <root-dir>
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

// One command per sandbox at a time, in arrival order, like the V8 sandbox's
// stored files; a second caller waits instead of getting a 409.
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
      const body = (await request.json()) as ExecRequest;
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
    if (request.method === "GET")
      return Response.json({ exists: existsSync(join(root!, id)) });
    if (request.method === "DELETE") {
      rmSync(join(root!, id), { recursive: true, force: true });

      return Response.json({ ok: true });
    }

    return new Response("method not allowed", { status: 405 });
  },
});
console.log(`native sandbox on ${port}`);
