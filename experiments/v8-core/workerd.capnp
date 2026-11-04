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
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  bindings = .perTaskBindings,
);

const perTaskBindings :List(Workerd.Worker.Binding) = [
    (name = "LOADER", workerLoader = ()),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];

# The same router holding core built with SLIM=1 (dist-slim/entry.js, the
# packages this agent never calls swapped for throwing stubs), on 4341
# (`workerd serve workerd.capnp slimConfig`).
const slimConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimRouter),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4341", http = (), service = "router") ],
);

const slimRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .perTaskBindings,
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

# The slim router keeping one loaded worker per agent (ROUTER_KEY=agent), on
# 4351 (`workerd serve workerd.capnp slimWarmConfig`).
const slimWarmConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimWarmRouter),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4351", http = (), service = "router") ],
);

const slimWarmRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .warmBindings,
);

const warmBindings :List(Workerd.Worker.Binding) = [
    (name = "ROUTER_KEY", text = "agent"),
    (name = "LOADER", workerLoader = ()),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];

# The warm router again, with every task worker's outbound fetches going through
# one shared worker that sends usage writes one at a time through a Durable
# Object (per-task/write-queue.js), on 4361 (`workerd serve workerd.capnp slimFastConfig`).
const slimFastConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimFastRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4361", http = (), service = "router") ],
);

const slimFastRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .fastBindings,
);

# slimFastConfig with the write queue as a WRITES binding instead of every task worker's
# globalOutbound: only the usage and budget writes take the hop (outbound.ts picks them out).
const slimDirectConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimDirectRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4362", http = (), service = "router") ],
);

const slimDirectRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .directBindings,
);

# slimFastConfig with V8 flags, to see what per-isolate CPU the engine's tiering costs.
const sparkConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimFastRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4363", http = (), service = "router") ],
  v8Flags = ["--always-sparkplug"],
);

const eagerConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimFastRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4364", http = (), service = "router") ],
  v8Flags = ["--no-lazy-feedback-allocation", "--always-sparkplug"],
);

# slimDirectConfig with the eager V8 flags, and that plus a native stream pass-through.
const directEagerConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimDirectRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4365", http = (), service = "router") ],
  v8Flags = ["--no-lazy-feedback-allocation", "--always-sparkplug"],
);

const directEagerIdConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimDirectIdRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4366", http = (), service = "router") ],
  v8Flags = ["--no-lazy-feedback-allocation", "--always-sparkplug"],
);

# Several engines with one write queue between them, so usage rows from tasks on different engines
# still go through one queue per account. writerConfig runs only the queue, on its own socket
# (start-per-task.sh <port> sets it); each spoke engine reaches it as an external service
# (`--external-addr writes=...`). Proxy style keeps the Convex URL's scheme and host on the hop.
const writerConfig :Workerd.Config = (
  services = [
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4399", http = (style = proxy), service = "writes") ],
);

const directEagerSpokeConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .slimDirectIdRouter),
    (name = "writes", external = (address = "127.0.0.1:4399", http = (style = proxy))),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4367", http = (), service = "router") ],
  v8Flags = ["--no-lazy-feedback-allocation", "--always-sparkplug"],
);

const slimDirectIdRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .directIdBindings,
);

const writeQueue :Workerd.Worker = (
  modules = [ (name = "write-queue.js", esModule = embed "per-task/write-queue.js") ],
  compatibilityDate = "2026-09-30",
  globalOutbound = "net",
  durableObjectNamespaces = [ (className = "WriteQueue", uniqueKey = "broods-bench-write-queue") ],
  durableObjectStorage = (inMemory = void),
  bindings = [ (name = "QUEUE", durableObjectNamespace = "WriteQueue") ],
);

const fastBindings :List(Workerd.Worker.Binding) = [
    (name = "ROUTER_KEY", text = "agent"),
    (name = "LOADER", workerLoader = ()),
    (name = "OUTBOUND", service = "writes"),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];

# fastBindings with the write queue passed on to task workers as WRITES (slimDirectConfig).
const directBindings :List(Workerd.Worker.Binding) = [
    (name = "ROUTER_KEY", text = "agent"),
    (name = "LOADER", workerLoader = ()),
    (name = "WRITES", service = "writes"),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];

# directBindings plus IDENTITY_STREAM=1 (entry.ts).
const directIdBindings :List(Workerd.Worker.Binding) = [
    (name = "ROUTER_KEY", text = "agent"),
    (name = "LOADER", workerLoader = ()),
    (name = "WRITES", service = "writes"),
    (name = "IDENTITY_STREAM", text = "1"),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];

# Memory variants of directEagerIdConfig (bench/mem-probe.sh). All run with --expose-gc so
# MEM_DEBUG=1 can make every loaded worker collect its garbage (per-task/router.js). Only the V8
# flags differ.
const memRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .memBindings,
);

# The eager flags of directEagerIdConfig.
const memEagerConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4370", http = (), service = "router") ],
  v8Flags = ["--expose-gc", "--no-lazy-feedback-allocation", "--always-sparkplug"],
);

# V8's default tiering: feedback and baseline code only for functions that run often.
const memLazyConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4371", http = (), service = "router") ],
  v8Flags = ["--expose-gc"],
);

# A young generation of at most 2 MB per half, so a worker keeps less short-lived space.
const memSemiConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4372", http = (), service = "router") ],
  v8Flags = ["--expose-gc", "--no-lazy-feedback-allocation", "--always-sparkplug", "--max-semi-space-size=2"],
);

# V8's own memory-over-speed switch.
const memSizeConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4373", http = (), service = "router") ],
  v8Flags = ["--expose-gc", "--no-lazy-feedback-allocation", "--always-sparkplug", "--optimize-for-size"],
);

# Default tiering, small young generation and optimize-for-size together.
const memLeanConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4374", http = (), service = "router") ],
  v8Flags = ["--expose-gc", "--max-semi-space-size=2", "--optimize-for-size"],
);

# No V8 flags at all. Any flag, even --expose-gc, fails the check on workerd's own compile cache
# for its built-in modules, so every loaded worker compiles those from source.
const memPlainConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4375", http = (), service = "router") ],
);

# memPlainConfig on the bundle built with ASCII=1 (dist-slim-ascii/): the same code, but each
# worker's copy of the source takes one byte a character instead of two.
const memAsciiConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memAsciiRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4376", http = (), service = "router") ],
);

const memAsciiRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/router.js"),
    (name = "bundle", text = embed "dist-slim-ascii/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  bindings = .memBindings,
);

const memBindings :List(Workerd.Worker.Binding) = [
    (name = "ROUTER_KEY", text = "agent"),
    (name = "LOADER", workerLoader = ()),
    (name = "WRITES", service = "writes"),
    (name = "IDENTITY_STREAM", text = "1"),
    (name = "MEM_DEBUG", fromEnvironment = "MEM_DEBUG"),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];

# memAsciiConfig with a Durable Object per agent holding that agent's worker
# (per-task/holder-router.js), so a worker can be unloaded IDLE_UNLOAD_MS after its agent's last task.
const memHolderConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memHolderRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4377", http = (), service = "router") ],
);

# memHolderConfig with --expose-gc, so a holder that lets go also collects the router's handle.
const memHolderGcConfig :Workerd.Config = (
  services = [
    (name = "router", worker = .memHolderRouter),
    (name = "writes", worker = .writeQueue),
    (name = "net", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:4378", http = (), service = "router") ],
  v8Flags = ["--expose-gc"],
);

const memHolderRouter :Workerd.Worker = (
  modules = [
    (name = "router.js", esModule = embed "per-task/holder-router.js"),
    (name = "bundle", text = embed "dist-slim-ascii/entry.js"),
  ],
  compatibilityDate = "2026-09-30",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "net",
  durableObjectNamespaces = [ (className = "AgentHolder", uniqueKey = "broods-bench-agent-holder") ],
  durableObjectStorage = (inMemory = void),
  bindings = .holderBindings,
);

const holderBindings :List(Workerd.Worker.Binding) = [
    (name = "ROUTER_KEY", text = "agent"),
    (name = "LOADER", workerLoader = ()),
    (name = "WRITES", service = "writes"),
    (name = "IDENTITY_STREAM", text = "1"),
    (name = "MEM_DEBUG", fromEnvironment = "MEM_DEBUG"),
    (name = "HOLDER", durableObjectNamespace = "AgentHolder"),
    (name = "IDLE_UNLOAD_MS", fromEnvironment = "IDLE_UNLOAD_MS"),
    (name = "ACCOUNT_CONFIG_ENCRYPTION_SECRET", fromEnvironment = "ACCOUNT_CONFIG_ENCRYPTION_SECRET"),
    (name = "ADMIN_ACCOUNT_SECRET", fromEnvironment = "ADMIN_ACCOUNT_SECRET"),
    (name = "ANTHROPIC_BASE_URL", fromEnvironment = "ANTHROPIC_BASE_URL"),
    (name = "CLOUDFLARE_WORKER_URL", fromEnvironment = "CLOUDFLARE_WORKER_URL"),
    (name = "CLOUDFLARE_WORKER_API_KEY", fromEnvironment = "CLOUDFLARE_WORKER_API_KEY"),
    (name = "CLOUDFLARE_SANDBOX_URL", fromEnvironment = "CLOUDFLARE_SANDBOX_URL"),
    (name = "CLOUDFLARE_SANDBOX_API_KEY", fromEnvironment = "CLOUDFLARE_SANDBOX_API_KEY"),
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
  ];
