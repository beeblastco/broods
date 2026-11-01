# V8 core experiment

Measures whether Broods' core can run as V8 isolates on self-hosted workerd,
including one fresh isolate per agent task, against today's core on Bun. It
runs on the local stack only and changes nothing in production.

## Setups

| Setup                  | Core                                                                                                    | Bash sandbox                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Today                  | `apps/core` on Bun (`start-bun.sh`, port 4301)                                                          | a connected machine (`bench/machine-daemon.ts`)                     |
| V8 core                | core's router bundled into one Worker on workerd (`start.sh`, 4311)                                     | `apps/cloudflare-worker` on wrangler dev (`start-sandbox.sh`, 8790) |
| Control                | Bun core                                                                                                | the V8 sandbox                                                      |
| Fresh isolate per task | `per-task/router.js` loads all of core into a new isolate for every request (`start-per-task.sh`, 4321) | the V8 sandbox                                                      |

`workerd.capnp` also has `floorConfig` (4331): the same per-request router
holding an empty worker, the floor a fresh isolate costs, and `slimConfig`
(4341): the router holding core built with `SLIM=1` (`dist-slim/entry.js`).

## Slim core

`SLIM=1 bun build.ts ./entry.ts ./dist-slim` swaps the packages the benchmark
agent never uses (chat channels, other sandbox and model providers, the
coding-agent harnesses) for `slim-stub.cjs`, which throws as soon as a running
task calls or constructs one; while the isolate loads it stays quiet, because
core builds some channel helpers at load. The bundle drops from 20.7 MB to
2.9 MB. `PER_TASK_CONFIG=slimConfig` makes `run-isolate.sh` and `run-real.sh`
use it. `bench/bundle-sizes.mjs` sums a bundle's bytes per source package from
its source map (build with `sourcemap: "external"`).

## Faster variants

Two levers on top of the slim core, each switchable on its own:

- **A warm worker per agent.** `slimWarmConfig` (4351) runs the same router
  with `ROUTER_KEY=agent`: it reads `agentId` from a POST body and asks the
  Worker Loader for `agent-<id>`, so every task of one agent reuses one loaded
  isolate while different agents still get separate ones. Requests without an
  agent id still get a fresh isolate. `PER_TASK_CONFIG=slimWarmConfig` selects it.
- **A real-shell sandbox over HTTP.** `bench/native-sandbox.ts` serves the
  same API as `apps/cloudflare-worker` but runs each command in real bash in
  the sandbox's own folder, so core's `worker` provider reaches it unchanged
  through `CLOUDFLARE_WORKER_URL`. It stands in for a microVM or container
  pool and isolates nothing: loopback and benchmarks only. `SANDBOX=native`
  makes `run-isolate.sh` start it on 8791; in `run-real.sh` an
  `isolate:native` arm does the same.

- **One shared queue for usage writes.** Every finished run writes its usage
  and its `run.completed` audit row in one Convex mutation that moves the
  account's audit chain head. Today's core sends those from one queued
  ConvexHttpClient; separate task workers race on the head and Convex drops
  the losers (up to a quarter of the rows at 20 users with the fast sandbox).
  `slimFastConfig` (4361) is `slimWarmConfig` plus `per-task/write-queue.js`
  as every task worker's outbound fetch: one shared worker that passes
  everything through except `usage:recordTaskUsage`, which it sends one at a
  time through a Durable Object. A first version kept the queue as a promise
  chain in a plain worker; workerd cancels a request left waiting on another
  request's promise as hung, and most usage rows were lost
  (`results/fast-final-hung-queue.jsonl`).

`restart-cores.sh` with `SANDBOX_PORT=8791` points both long-lived cores at the
real-shell sandbox, and `run-scripted.sh` then takes `bun:native` and
`workerd:native` arms, the controls for how much of the gap is the sandbox.

`WARMUP_EACH=1` (all three run scripts) runs one task per agent before the
timed rounds, so a warm worker is measured warm; without it the first task of
each agent pays the load.

Core needed two patches to load in a V8 isolate: `shared/cache-digest.ts`
draws its key on first use, and `shared/http.ts` fetches by hostname on
workerd. The second weakens the SSRF guard and is for this experiment only.
`entry.ts` waits for the response body and then core's in-flight writes, or
workerd drops core's usage rows.

## The task

`bench/lib.ts` builds one agent with the Cloudflare docs MCP server, bash, and
subagents. Each task searches the docs, writes a file and prints its sha256,
delegates a prime count to a subagent without waiting, and answers again when
the result comes back: three runs and seven model calls. A task passes only if
a bash result holds a sha256 and the final answer holds 3245 and 29989.

`BENCH_SCRIPTED_MODEL=1` answers the model in process with the same tool calls
(`scripted-model.ts`), optionally after `BENCH_MODEL_DELAY_MS`; otherwise the
agent uses Haiku 5.5 at high effort with `ANTHROPIC_API_KEY` from the
environment.

## Running

With the local stack up (`bun scripts/local-stack.ts up`):

```sh
cd experiments/v8-core
bun build.ts
./start-sandbox.sh logs/worker-sandbox.key logs/worker-state logs/worker-sandbox.log
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=0
bench/restart-cores.sh logs
AGENT_PER_TASK=1 bench/run-scripted.sh results/agents.jsonl logs 2 1,5,10,20
AGENT_PER_TASK=1 bench/run-isolate.sh results/isolate.jsonl logs 2 1,5,10,20
BENCH_SCRIPTED_MODEL=0 bench/restart-cores.sh logs -real
AGENT_PER_TASK=1 SHARED_FILES=1 bench/run-real.sh results/real.jsonl logs 3 1
bun bench/analyze-log.ts results/real.jsonl bun=logs/bun-core-real.log workerd=logs/workerd-core-real.log isolate=logs/isolate-core-real.log
bun bench/summarize.ts results/agents.jsonl results/isolate.jsonl
```

`bench/cold-start.ts` times start-up per request, and `bench/sandbox-probe.ts`
times the task's commands against each sandbox directly. Keep the machine
otherwise idle while a run is going; the scripts read CPU from `/proc`.

`results/` holds the rows behind the published report. Files ending in
`-prefix`, `-8workers` or `-overlapped` were set aside from the report's tables
(before the usage fix, at core's default run limit, or overlapping other work);
`-one-agent` and `-separate-files` are shown as evidence for the problems they
found. `SHARED_FILES=1` pins each agent's V8 sandbox to one reservation key so a
subagent sees its parent's files, as it does on a machine.

`report/` builds the published pages from `results/`:
`python3 report/gen.py results report.html` for the benchmark report (https://claude.ai/artifact/BE46ta7uPrZRwJ7BqvcVbG) and
`python3 report/diagrams.py results page.html` for the diagrams and slim-core
results; `python3 report/simple.py results page.html` builds the short page
published at https://claude.ai/artifact/2qS6mM9RgPqgnrAeuSLCnt (from version 3 on, the
faster setups: `fast-d0`, `fast-final`, `real-fast`). Every number on it is read
from the rows; only prices and the bundle size are typed in. `research.md` holds
the research behind it, with sources.
