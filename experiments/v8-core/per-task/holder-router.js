/**
 * One warm worker per agent, unloaded once the agent goes quiet: a Durable Object per agent holds
 * the agent's unnamed worker across requests (a request's own stub cannot be reused by the next)
 * and lets go of it IDLE_UNLOAD_MS after its last task. MEM_DEBUG=1 adds POST /__mem/unload.
 */

import BUNDLE from "bundle";

const FLAGS = [
  "nodejs_compat",
  "nodejs_compat_populate_process_env",
  "enable_nodejs_process_v2",
  "enable_nodejs_fs_module",
  "enable_nodejs_os_module",
  "enable_nodejs_http_modules",
  "enable_nodejs_child_process_module",
  "enable_nodejs_readline_module",
  "enable_nodejs_tty_module",
  "enable_nodejs_worker_threads_module",
  "enable_nodejs_perf_hooks_module",
  "enable_nodejs_console_module",
  "enable_nodejs_vm_module",
  "enable_nodejs_v8_module",
  "enable_nodejs_sqlite_module",
  "enable_nodejs_http2_module",
  "enable_nodejs_dgram_module",
  "enable_nodejs_cluster_module",
  "enable_nodejs_domain_module",
  "enable_nodejs_inspector_module",
  "enable_nodejs_punycode_module",
  "enable_nodejs_repl_module",
  "enable_nodejs_trace_events_module",
  "enable_nodejs_wasi_module",
  "enable_nodejs_stream_wrap_module",
];

let loads = 0;
/** Agents that have a holder, so /__mem/unload can reach them. */
const agents = new Set();

/** The agent a run request is for, or undefined. */
async function agentOf(request) {
  if (request.method !== "POST") return undefined;
  try {
    const body = await request.clone().json();

    return typeof body?.agentId === "string" ? body.agentId : undefined;
  } catch {
    return undefined;
  }
}

/** The router's own bindings, which a task worker does not get. */
const ROUTER_ONLY = new Set([
  "LOADER",
  "HOLDER",
  "ROUTER_KEY",
  "OUTBOUND",
  "IDLE_UNLOAD_MS",
  "MEM_DEBUG",
]);

/** What a task worker runs: core's bundle with the router's settings. */
function workerCode(env) {
  const vars = Object.fromEntries(
    Object.entries(env).filter(([name]) => !ROUTER_ONLY.has(name)),
  );
  const { OUTBOUND } = env;
  loads += 1;

  return {
    compatibilityDate: "2026-09-30",
    compatibilityFlags: FLAGS,
    mainModule: "entry.js",
    modules: { "entry.js": BUNDLE },
    env: { ...vars, SERVICE_NAME: `${vars.SERVICE_NAME}-${loads}` },
    ...(OUTBOUND ? { globalOutbound: OUTBOUND } : {}),
  };
}

export class AgentHolder {
  constructor(state, env) {
    this.env = env;
    this.worker = undefined;
    this.busy = 0;
    this.timer = undefined;
  }

  /**
   * Lets go of the worker. The engine frees it once the router's own handle to it is collected,
   * so with --expose-gc this collects the router's garbage right away.
   */
  unload() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.worker && this.env.MEM_DEBUG === "1")
      console.log("holder: unloading a worker");
    this.worker = undefined;
    globalThis.gc?.();
  }

  release() {
    this.busy -= 1;
    if (this.busy > 0) return;
    const idleMs = Number(this.env.IDLE_UNLOAD_MS || 0);
    if (idleMs > 0) this.timer = setTimeout(() => this.unload(), idleMs);
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/__mem/unload") {
      this.unload();

      return new Response(null, { status: 204 });
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.worker ??= this.env.LOADER.load(workerCode(this.env));
    this.busy += 1;
    let response;
    try {
      response = await this.worker.getEntrypoint().fetch(request);
    } catch (error) {
      this.release();
      throw error;
    }
    if (!response.body) {
      this.release();

      return response;
    }
    // The worker is in use until its answer has been read to the end.
    const { readable, writable } = new IdentityTransformStream();
    const release = () => this.release();
    response.body.pipeTo(writable).then(release, release);

    return new Response(readable, response);
  }
}

export default {
  fetch: async function (request, env) {
    const url = new URL(request.url);
    if (
      env.MEM_DEBUG === "1" &&
      request.method === "POST" &&
      url.pathname === "/__mem/unload"
    ) {
      await Promise.all(
        [...agents].map((agent) =>
          env.HOLDER.get(env.HOLDER.idFromName(agent)).fetch(
            "http://holder/__mem/unload",
            { method: "POST" },
          ),
        ),
      );

      return Response.json({ agents: agents.size });
    }
    const agent = await agentOf(request);
    if (!agent) {
      // No agent (health checks): a worker of its own, dropped with this request.
      return env.LOADER.load(workerCode(env)).getEntrypoint().fetch(request);
    }
    agents.add(agent);
    const response = await env.HOLDER.get(env.HOLDER.idFromName(agent)).fetch(
      request,
    );
    const headers = new Headers(response.headers);
    headers.set("x-isolate", `agent-${agent}`);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  },
};
