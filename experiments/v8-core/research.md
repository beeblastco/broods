# Research notes: making a worker per task fast

Compiled 2026-11-01 from public docs and the workerd source (main at 6472e6ee).
Tags: [SRC] read in source, [DOC] official docs or engineering blog, [3P] third
party. Figures from other workloads are not measurements of this bundle.

## Start-up

| Technique                                                                          | What it removes                      | Self-hosted workerd today                      |
| ---------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| Keep the bundle in a warm isolate per agent or tenant (what `slimWarmConfig` does) | compile and top-level run per task   | yes                                            |
| Trusted loop warm, only untrusted code (model-written snippets) in a fresh isolate | nearly all of the bundle per task    | yes                                            |
| Pool of unnamed `LOADER.load()` workers, each reused for N tasks                   | start-up / N                         | yes                                            |
| `new_module_registry` flag plus a bundle split into modules                        | compile of code a task never imports | partly; default registry compiles all modules  |
| V8 code cache (`jsg::CodeCacheStore`)                                              | parse and compile (20-40% elsewhere) | needs a custom build; the binary installs none |
| V8 startup snapshot of the evaluated top level                                     | compile and top-level run            | no; upstream discards the snapshot for now     |
| Load the worker when the task is queued                                            | latency only, no CPU                 | yes                                            |
| One workerd process per core                                                       | head-of-line blocking                | yes                                            |

- How platforms get near-zero cold starts is mostly reuse: Cloudflare routes a
  Worker's traffic to the server that already has it loaded (warm requests
  99.9% to 99.99%) [DOC blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer, 2025-09-26];
  Vercel Fluid shares one instance across invocations and caches bytecode
  [DOC vercel.com/docs/fluid-compute]; Deno Deploy keeps apps alive between
  requests and starts on the first TCP packet [DOC docs.deno.com/deploy/reference/runtime].
- Cloudflare's own agents run the loop in a long-lived per-agent Durable
  Object and put only model-written code in a fresh Dynamic Worker, with tools
  passed in as RPC bindings [DOC blog.cloudflare.com/project-think, 2026-04-15;
  blog.cloudflare.com/code-mode, 2025-09-26].
- Worker Loader ids: a named id stays loaded until its isolate crashes, with
  no eviction, so a unique id per task grows memory until restart; unnamed
  `load()` workers are freed by garbage collection. Each id is its own V8
  isolate and shares no compiled code [SRC src/workerd/server/server/loader.rs,
  src/workerd/server/factory/worker-factory.c++]. This matches what
  `run-isolate.sh` saw (about 110 MB per uniquely named worker, never evicted).
- workerd runs one single-threaded event loop per process; scale with more
  processes [SRC README.md, src/workerd/server/AGENTS.md]. Measured here: all
  JS runs on the `workerd` thread.
- workerd is not a hardened sandbox on its own; run it inside a VM or gVisor
  for untrusted code [SRC README.md].

## Real shell commands

- The common pattern: start or restore a sandbox once per task, then run each
  command through a small exec agent inside it (E2B `envd`, Cloudflare `exec()`).
  A process spawn costs about 0.5 ms (`posix_spawn`, HotOS'19).
- Self-hostable: E2B Embed (Firecracker, Apache-2.0, one KVM host, snapshot
  resume with lazy memory) [SRC github.com/e2b-dev/infra]; raw Firecracker
  (<=125 ms boot, <=5 MiB overhead, snapshot restore in milliseconds)
  [DOC firecracker SPECIFICATION.md]; gVisor without KVM (syscall 0.76-38 us
  depending on platform) [DOC gvisor.dev/docs/architecture_guide/performance];
  nsjail or bubblewrap (weakest isolation).
- Hosted time to first command, 100 creates at once, internet included
  [3P computesdk.com/benchmarks/sandboxes/burst-tti, 2026-10-30]: Vercel 423 ms,
  Daytona 668 ms, Modal 752 ms, Cloudflare 786 ms, E2B 1,268 ms.
- Cloudflare's guidance: the isolate tier is not for Linux tooling; use a
  microVM or container [DOC blog.cloudflare.com/claude-managed-agents, 2026-05-19].

## Open

- How the fresh-isolate start-up splits between compile and top-level run
  (decides between the code cache and lazy modules); profile with the inspector.
- Whether `new_module_registry` loads every module type this bundle uses.
