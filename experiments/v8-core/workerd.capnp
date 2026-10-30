# Self-hosted workerd: core's real router (dist/entry.js) in one long-lived
# isolate on "http", and a fresh isolate per request on "per-task".
# Secrets come from the launching process's environment, never this file.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "core", worker = .coreWorker),
    # The local stack's Convex and sandboxes live on loopback.
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4311", http = (), service = "core") ],
);

const coreWorker :Workerd.Worker = (
  modules = [ (name = "entry.js", esModule = embed "dist/entry.js") ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat", "nodejs_compat_populate_process_env", "enable_nodejs_process_v2", "enable_nodejs_fs_module", "enable_nodejs_os_module", "enable_nodejs_http_modules", "enable_nodejs_child_process_module", "enable_nodejs_readline_module", "enable_nodejs_tty_module", "enable_nodejs_worker_threads_module", "enable_nodejs_perf_hooks_module", "enable_nodejs_console_module", "enable_nodejs_vm_module", "enable_nodejs_v8_module", "enable_nodejs_sqlite_module", "enable_nodejs_http2_module", "enable_nodejs_dgram_module", "enable_nodejs_cluster_module", "enable_nodejs_domain_module", "enable_nodejs_inspector_module", "enable_nodejs_punycode_module", "enable_nodejs_repl_module", "enable_nodejs_trace_events_module", "enable_nodejs_wasi_module", "enable_nodejs_stream_wrap_module"],
  globalOutbound = "net",
  bindings = [
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "BENCH_SCRIPTED_MODEL", fromEnvironment = "BENCH_SCRIPTED_MODEL"),
    (name = "BENCH_MODEL_DELAY_MS", fromEnvironment = "BENCH_MODEL_DELAY_MS"),
    (name = "MAX_INPROCESS_WORKERS", fromEnvironment = "MAX_INPROCESS_WORKERS"),
    (name = "CONVEX_DEPLOY_KEY", fromEnvironment = "CONVEX_DEPLOY_KEY"),
    (name = "CONVEX_URL", fromEnvironment = "CONVEX_URL"),
    (name = "MEDIA_TICKET_SECRET", fromEnvironment = "MEDIA_TICKET_SECRET"),
    (name = "PUBLIC_BASE_URL", fromEnvironment = "PUBLIC_BASE_URL"),
    (name = "SERVICE_AUTH_SECRET", fromEnvironment = "SERVICE_AUTH_SECRET"),
    (name = "SERVICE_NAME", fromEnvironment = "SERVICE_NAME"),
    (name = "STAGE_TICKET_SECRET", fromEnvironment = "STAGE_TICKET_SECRET"),
    (name = "TERMINAL_TICKET_SECRET", fromEnvironment = "TERMINAL_TICKET_SECRET"),
  ],
);

# Its own process (`workerd serve workerd.capnp perTaskConfig`), so its CPU and
# memory are read apart from the long-lived core's.
const perTaskConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .perTaskRouter),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4321", http = (), service = "router") ],
);

const perTaskRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "BENCH_SCRIPTED_MODEL", fromEnvironment = "BENCH_SCRIPTED_MODEL"),
    (name = "BENCH_MODEL_DELAY_MS", fromEnvironment = "BENCH_MODEL_DELAY_MS"),
    (name = "MAX_INPROCESS_WORKERS", fromEnvironment = "MAX_INPROCESS_WORKERS"),
    (name = "CONVEX_DEPLOY_KEY", fromEnvironment = "CONVEX_DEPLOY_KEY"),
    (name = "CONVEX_URL", fromEnvironment = "CONVEX_URL"),
    (name = "MEDIA_TICKET_SECRET", fromEnvironment = "MEDIA_TICKET_SECRET"),
    (name = "PUBLIC_BASE_URL", fromEnvironment = "PUBLIC_BASE_URL"),
    (name = "SERVICE_AUTH_SECRET", fromEnvironment = "SERVICE_AUTH_SECRET"),
    (name = "SERVICE_NAME", fromEnvironment = "SERVICE_NAME"),
    (name = "STAGE_TICKET_SECRET", fromEnvironment = "STAGE_TICKET_SECRET"),
    (name = "TERMINAL_TICKET_SECRET", fromEnvironment = "TERMINAL_TICKET_SECRET"),
  ],
);

# The same per-request router holding an empty worker instead of core, on
# 4331: the floor a fresh isolate costs (`workerd serve workerd.capnp floorConfig`).
const floorConfig :Workerd.Config = (
  services = [ (name = "router", worker = .floorRouter) ],
  sockets = [ (name = "http", address = "127.0.0.1:4331", http = (), service = "router") ],
);

const floorRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "per-task/tiny.js"),
  ],
  compatibilityDate = "2026-09-30",
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "SERVICE_NAME", text = "floor"),
  ],
);
