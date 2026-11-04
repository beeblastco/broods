/**
 * A fresh worker per request, or with ROUTER_KEY=agent one named worker per agent, which workerd
 * keeps until the process ends. OUTBOUND becomes each worker's outbound fetch. MEM_DEBUG=1 adds
 * POST /__mem/gc: every named worker collects its garbage (the engine needs --expose-gc).
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
/** Named workers this router has asked for, so /__mem/gc can reach them. */
const named = new Set();

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
    const { LOADER, ROUTER_KEY, OUTBOUND, ...vars } = env;
    const code = () => ({
      compatibilityDate: "2026-09-30",
      compatibilityFlags: FLAGS,
      mainModule: "entry.js",
      modules: { "entry.js": BUNDLE },
      env: { ...vars, SERVICE_NAME: `${vars.SERVICE_NAME}-${loaded}` },
      ...(OUTBOUND ? { globalOutbound: OUTBOUND } : {}),
    });
    if (
      vars.MEM_DEBUG === "1" &&
      request.method === "POST" &&
      new URL(request.url).pathname === "/__mem/gc"
    ) {
      await Promise.all(
        [...named].map((name) =>
          LOADER.get(name, code)
            .getEntrypoint()
            .fetch("http://worker/__mem/gc", { method: "POST" }),
        ),
      );
      globalThis.gc?.();

      return Response.json({ workers: named.size });
    }
    const agent = ROUTER_KEY === "agent" ? await agentOf(request) : undefined;
    const id = agent
      ? `agent-${agent}`
      : `task-${loaded}-${crypto.randomUUID()}`;
    if (agent) named.add(id);
    const worker = LOADER.get(id, code);
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
