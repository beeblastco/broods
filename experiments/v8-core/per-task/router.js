/**
 * One fresh V8 isolate per request: the "each agent task is its own function
 * call" model. The router holds core's bundle as text and, for every request,
 * asks the Worker Loader for a worker under a name never used before, so
 * nothing (module state, caches, connections) carries over from one task to
 * the next. The loaded worker gets the same flags and env as core on workerd.
 *
 * ROUTER_KEY=agent instead keeps one worker per agent: a task for an agent
 * that already has a loaded worker reuses it, so only an agent's first task
 * pays the load. The agent comes from the run request's JSON body; anything
 * else (health checks, callbacks) gets a fresh worker as before.
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

let loaded = 0;

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

export default {
  fetch: async function (request, env) {
    loaded += 1;
    const { LOADER, ROUTER_KEY, ...vars } = env;
    const agent = ROUTER_KEY === "agent" ? await agentOf(request) : undefined;
    const id = agent
      ? `agent-${agent}`
      : `task-${loaded}-${crypto.randomUUID()}`;
    const worker = LOADER.get(id, () => ({
      compatibilityDate: "2026-09-30",
      compatibilityFlags: FLAGS,
      mainModule: "entry.js",
      modules: { "entry.js": BUNDLE },
      env: { ...vars, SERVICE_NAME: `${vars.SERVICE_NAME}-${loaded}` },
    }));
    const response = await worker.getEntrypoint().fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-isolate", id);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  },
};
