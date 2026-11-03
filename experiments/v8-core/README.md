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

- **One shared writer for usage writes.** Every finished run writes its usage
  and its `run.completed` audit row in one Convex mutation that moves the
  account's audit chain head, and worker commands add to the account's
  monthly meter. Today's core sends those from one queued ConvexHttpClient;
  separate task workers race on those rows and Convex retries or drops the
  losers (up to a quarter of the audit rows at 20 users with the fast
  sandbox). `slimFastConfig` (4361) is `slimWarmConfig` plus
  `per-task/write-queue.js` as every task worker's outbound fetch: one shared
  worker that passes everything through except `usage:recordTaskUsage` and
  `account/budget:record`, which go to a Durable Object per account and kind.
  It sends them as a group commit: whatever arrived while the last write was
  in flight goes out as one batch mutation (`usage:recordTaskUsages`,
  `account/budget:recordMany`), each write still deduplicated by its own id,
  and each caller gets its own answer back. Those two mutations were measured
  (commit 4631eaa) but left out of Broods, which has no shared writer to call
  them; without them the queue sends its writes one at a time, still from one
  writer per account, so none race. A first version kept the queue as
  a promise chain in a plain worker; workerd cancels a request left waiting
  on another request's promise as hung, and most usage rows were lost
  (`results/fast-final-hung-queue.jsonl`).

## Database round trips

These core changes were merged to dev in #1349 and taken out again in #1366
(Phicks had not asked for the merge and wanted more proof), so core on dev
and in this folder's runs is unchanged: a platform sandbox is booked with a
get and a claim, mirrored on every command. What #1349 carried: one-trip
booking (`reserveSandboxReservation`), the booking held in memory, the mirror
once per task, and a second of command usage summed into one budget write.
`results/db-final.jsonl` and `results/db-before.jsonl` are the measurements
from then. With `BENCH_SCRIPTED_MODEL=1`, every Convex call core makes logs a
`BENCH_CONVEX <function> <ms>` line. `bench/convex-cpu.sh <arm> <level> <out>`
runs one arm at one level and prints the database container's CPU per task
(from its cgroup) and each Convex function's calls per task and average time.

## Same footing (2026-11-03)

`bench/run-gap.sh <out> <rounds> <level>` takes turns between arms
(`GAP_ARMS`: `bun:machine`, `bun:native`, `fast`, `direct`, `cfg:<Config>`)
and adds a `box` row per arm with the database container's CPU per task and
how busy the whole machine was. `NO_MCP=1` leaves the docs search out of the
agent (it is 3.5 to 4.5 s of outside wait per task) and `NO_SANDBOX=1` leaves
the sandbox out too, so a task is model turns, a subagent and Broods' own
bookkeeping, and both runtimes pay the same Convex calls.

- **Same sandbox.** Today's arm runs bash on a connected machine, which
  skips the platform bookkeeping (booking, mirror, metering); every platform
  sandbox, Lambda included, pays it. With both runtimes on the real-shell
  sandbox the isolates are as fast or faster in 17 of 18 pairs at 1, 10 and
  20 users (`gap-nomcp`, `gap-mcp3`, `gap-hold`, `gap-direct`) and the
  database works about 20% less per task. That saving is the shared usage
  writer, which today's core could have too. Each test task is a new
  conversation and books a fresh sandbox, so holding a booking in memory (the
  Lambda executor's 3-minute `reservedEndpoints`, tried on the Worker
  executor) changed nothing (`gap-hold`). This holds for core's `worker`
  provider, which writes the account's budget row on every command; the
  `cloudflare` provider does not, and on it today's core is ahead (below).
- **No sandbox.** `fast` cost about 65 ms of CPU per task against about 40
  for today's core and was 0 to 8% slower (`gap-nosb`). Three changes bring
  it to about 55 ms: `slimDirectConfig` hands the write queue to task
  workers as a `WRITES` binding and `outbound.ts` sends only the usage and
  budget writes through it, so every other call leaves directly (one hop
  fewer, about 10% of the CPU); the V8 flags `--no-lazy-feedback-allocation
  --always-sparkplug` (`eagerConfig`, about 14%, `gap-v8flags`); and
  `IDENTITY_STREAM=1`, workerd's native pass-through for the response body in
  `entry.ts`. `directEagerIdConfig` has all three. It is even with today's core
  at 20 users and 6 to 12% slower at 40 (`gap-stack`, `gap-eng`); one
  isolate for every task costs 58 ms, so most of what is left is workerd's own
  cost per request and fetch, not separate isolates (`gap-one`).
- **Two engines** (`ENGINES=2` in `run-isolate.sh`, `engines:2:<Config>` in
  `run-gap.sh`; the bench spreads agents over the engines' URLs): no gain at
  20 or 40 users, and with a write queue in each engine two writers race on an
  account's rows (122 of 123 audit rows; `gap-eng`, `gap-eng-sandbox`).
- **Memory.** A warm worker per agent holds its own copy of core: about
  1 GB for 20 agents against 340 MB for today's core.

## Real Cloudflare sandbox

`bench/run-cf.sh [rounds] [level] [warm|cold]` runs today's core (`bun:cf`) and
`directEagerIdConfig` (`cf:directEagerIdConfig`) in turns, both on core's
`cloudflare` sandbox provider (`bench.ts --sandbox-provider cloudflare`, a
two-minute idle window), so every command goes to the bridge Worker at
`CLOUDFLARE_SANDBOX_URL` with `CLOUDFLARE_SANDBOX_API_KEY` (environment only).
`warm` keeps one sandbox per agent (`SHARED_FILES=1`), booted by the warm-up
task, like a conversation that is already going; `cold` books a new Container
for every task and subagent. It needs the local stack up in the same checkout;
the bench's cores take the stack's own port block (`BENCH_PORT_BASE`, from the
stack state), and it stops the stack's own core for the run.

The scripts also run on macOS: `env.sh` and `bench/lib.ts` find the stack this
checkout started, `workerd_bin` picks this machine's workerd, `bench/proc.ts`
reads `ps` where there is no `/proc`, and `run-gap.sh` leaves the database and
box CPU columns at 0 where it cannot read them. `bench/native-sandbox.ts` also
takes the bridge's request shape, so pointing `CLOUDFLARE_SANDBOX_URL` at it
tries the whole path locally (`cf-local-*`). `bench/gap-summary.py` prints the
table for any `run-gap.sh` rows.

Locally at 20 users (`cf-local-warm`, `cf-local-cold`) today's core is 9%
faster warm and 13% cold, with the same database work per task (about 770 and
665 ms). On the same checkout and machine the `worker` provider still gives the
isolates the lead (`gap-worker-recheck`: 3.7 against 4.5 s, database 683
against 900 ms per task), so the win came from that provider's per-command budget write,
which today's core sends from one queued client and the isolates through the
shared writer; the `cloudflare` provider has no such write, so what is left is
the isolates' own CPU (110 to 125 ms per task against about 65 here, on one
workerd thread). Profiles put about a fifth of it in workerd's native `fetch`;
connections to the database are reused, so it is not connection setup.

On the real dev bridge, from Phicks' Mac (`cf-warm`: 3 rounds, `cf-cold`: 2,
20 tasks at once; every audit row saved) the typical task took 3.0 s on
today's core and 3.1 s on the isolates with the sandbox already running, a tie
next to rounds that swing from 1.9 to 4.1 s; with a new Container per task 5.1
against 6.1 s, though today's slowest task took 12.1 s against 6.9. CPU per
task was 44 against 58 ms and memory about 250 MB against 900 MB. The bench
leaves its cores running when it ends, so stop them before a second run.
The page's version 7 reports these rows.

## One writer per account (2026-11-03)

More engines did not close the gap. `writerConfig` runs the write queue alone
and `directEagerSpokeConfig` reaches it as an external service, so two or
three engines (`run-gap.sh` arm `cfengines:<n>:<Config>`) still send one
account's writes through one queue. On the local stand-in (`eng-*`, 2 rounds)
one, two and three engines all took 104 to 110% of today's time at 20 and 40
users: the box was busy with the database (about 800 to 900 ms of Convex CPU
per task), not with workerd's thread.

Convex's own function log (`/api/stream_function_logs`, one round at 20 users,
both runtimes) showed why: on the `cloudflare` provider every command mirrors
its sandbox row (`sandbox/instances:upsert`), which adds the sandbox's time to
the account's `usageDays` row. Twenty tasks at once on one account made about
170 executions for 40 mirror writes, a third of the database's execution time,
and 20 of the 40 failed after four retries, so that sandbox time was never
metered. This is today's core as much as the isolates.

`per-task/write-queue.js` now keeps one Durable Object per account for usage,
budget and mirror writes (`outbound.ts` sends all three through `WRITES`),
sends them in order, and of the mirror writes queued for one sandbox row sends
only the last, which meters the same time: 41 executions, no conflicts, none
lost. With it (`acct-*`, 2 rounds) the isolates took 74% and 73% of today's
time with a running sandbox at 20 and 40 users, and 85% and 80% with a new
sandbox per task; two engines with the shared writer matched one.

The same fix fits today's core: `CORE_FIX=1 bench/run-cf.sh` applies
`bench/core-account-mirror.patch` (one mirror queue per account inside the
process) for that run only. Against that (`ctl-*`) the isolates took 96% and
95% (running sandbox) and 100% and 98% (new sandbox), so they are now level or
slightly ahead, with about 100 to 110 ms of CPU per task against 60 to 80 and
still about three times the memory. Today's core's queue holds only inside one
process; the isolates' writer is one per account across every engine.

## Two ideas that did not help

Commit `8f59ca0` built the two fixes the page proposed for the time still
left inside Broods, and `bench/run-two-ideas.sh` there measured them against
today and the fast setup at 1, 10 and 20 users, twice
(`results/two-ideas.jsonl`). Neither beat the fast setup at 20 users, so both
were taken out again:

- **One workerd per CPU core.** Two or three engines (`slimEngineConfig`)
  behind a front that keeps each agent on one engine, with one writer
  process for every engine's usage writes: 167 tasks a minute against 168
  with one engine, for more CPU per task. One engine at 20 users is busy
  about a third of the time, so it was never the limit.
- **Booking the sandbox while the model thinks** (core's `reserveAhead`
  from `createTools`): 167 against 168, and with a 1 s model delay 97
  against 94, inside the swing between runs. It saves one database call per
  new sandbox, which is not where the time goes.

`results/warm-reps.jsonl` is five batches on one warm router (`REPS=5`):
core CPU per batch does not fall as the workers warm up, so warm-up is not
why a task costs more CPU in a worker than in today's core.

`restart-cores.sh` with `SANDBOX_PORT=8791` points both long-lived cores at the
real-shell sandbox, and `run-scripted.sh` then takes `bun:native` and
`workerd:native` arms, the controls for how much of the gap is the sandbox.

`WARMUP_EACH=1` (all three run scripts) runs one task per agent before the
timed rounds, so a warm worker is measured warm; without it the first task of
each agent pays the load.

Core needs two changes to run in a V8 isolate, and `build.ts` patches both
into the bundle at build time (`PATCHES`), so core itself is unchanged:
`shared/cache-digest.ts` draws its key on first use, and `shared/http.ts`
fetches by hostname. The second weakens core's SSRF guard, which is why it
stays out of core.
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
faster setups: `fast-d0`, `fast-final`, `real-fast`; version 4 adds the
database work: `db-final`, `db-before`, `real-db`; version 5 leads with the
two ideas that did not help: `two-ideas`, `warm-reps`; version 6 is the same-footing
work above, typed in from `gap-*.jsonl`). Up to version 5 every number on it is read
from the rows; only prices and the bundle size are typed in. `research.md` holds
the research behind it, with sources.
