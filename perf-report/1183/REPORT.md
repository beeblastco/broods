# #1183 option A vs dev: long-horizon benchmark

## Verdict

**A is not slower than dev. It is the same or faster in every scenario, and it fixes the lost result.**

- **L1** (200 reads of a finished result): turn p50 195 → 192 ms (−1.5%), p95 288 → 280 ms, p99 334 → 311 ms. Convex calls per turn 11.6 → 10.5: the `markAsyncToolHandback` call per read is gone. `stepBoundary` reads one more document and writes 0.5 more on average (it now stores the row), and its mean execution time goes from 11.2 to 12.6 ms. That costs less than the ~10 ms mutation round trip it replaces.
- **L2** (200 reads of a result whose resume is queued behind the turn, the #1183 shape): turn p50 681 → 612 ms (−10%), p95 819 → 702 ms (−14%). Turn→idle p50 857 → 614 ms (−28%), p95 1121 → 710 ms (−37%). Convex calls per turn 29.9 → 18.7 (−37%). Conversation rows 1202 → 802, Convex container CPU 64% → 48%, wall time 223 → 163 s. On dev the read gives way, and the queued resume then runs a whole extra turn just to tell the model again. On A the saved step completes that resume. Both commits tell each result exactly once.
- **L3** (bash/text/status mix, 200 turns): p50 174 → 172 ms, p95 268 → 252 ms, calls 10.8 → 10.4.
- **L4** (10 conversations × 100 turns, L3 mix): p50 585 → 550 ms (−6%), p95 803 → 737 ms (−8%), calls 10.4 → 10.1.
- **Drift** (mean of the last 20 turns minus the first 20) is about +100 to +220 ms on both commits. It comes from history growth (`listConversationEvents` reads ~300 documents per turn by turn 200), not from A. A's drift is equal or lower in every scenario.
- **Memory/CPU**: core RSS and CPU are within run-to-run noise. The RSS slopes are the same order on both commits; the samples are noisy and do not point to a leak introduced by A. The gateway is untouched (~46–49 MB, <0.3% CPU).
- **C1 correctness** (SIGKILL core after `async_status` returned and before its step was saved; 20 trials, one kill each): dev tells the parent **0 times in 20/20 trials**: the row is marked `stored` and the result is lost. A tells it **exactly once in 20/20 trials**, through the recovery sweep's resume after the dead lease ran out.

## Environment

- 4 vCPU Intel Xeon @ 2.10 GHz (1 thread per core), 15 GiB RAM, Ubuntu 24.04.5 LTS, kernel 6.18.44 (Firecracker VM).
- Bun 1.4.2, Docker 29.9.2. Self-hosted Convex backend pinned by `scripts/local-stack.ts` (`ghcr.io/convex/convex-backend@sha256:b756b066…`), Traefik v3.7.12.
- Model: the in-process fake from `local:up -- --perf` (`scripts/local-verify/fake-model.ts`). No real model key was used.

## Method

- Commits: `2dffa69` = dev (`e209108`) + the benchmark harness, and `dab81ec` = that + option A. The only difference between them is A.
- Harness: `bun scripts/local-stack.ts long-horizon --label <name> --out <dir> [--runs 3] [--scenarios …]`, with core started by `up --fresh --perf`. Each commit ran on its own fresh stack (its own Convex container), and the two stacks never ran perf scenarios at the same time.
- Results are seeded straight into Convex with the admin key, shaped like a background job's row (`runtime:createAsyncToolResult` under an earlier turn of the conversation, `delivery: async`). Seeding is untimed and never appears in core's trace.
  - L1 and the status turns in L3/L4: the row is settled `completed` up front, then the turn is `ASYNC_STATUS:<id>`.
  - L2: the row is left `processing` with a job token. The turn is `ASYNC_STATUS_AFTER:400:<id>` (the fake model waits 400 ms), and 120 ms into the turn the harness posts core's real job callback (`POST /v1/sandbox-jobs/<id>/complete`). That settles the row and queues its resume behind the running turn.
  - L3/L4 bash turns run `hostname` on a machine sandbox whose daemon runs in the harness.
- Per turn: SSE stream time (`turn`), and turn→idle, which runs until the last Convex call of the turn, including the queued resume it left behind. Sequential scenarios wait for the resume envelope to be terminal and for the trace to go quiet before the next turn starts.
- Convex calls come from core's trace (`BROODS_LOCAL_CONVEX_TRACE`), `sandbox/machines:*` heartbeats excluded. Per-function execution time and documents read/written come from the backend's `/api/stream_function_logs`, the stream the Convex dashboard reads. Those executions include the harness's own admin calls (seeding, status polls), so compare them function by function, not as totals.
- Resources: core and gateway `/proc/<pid>/stat` (utime+stime) and `VmRSS` every 1 s, and `docker stats` of the Convex container every ~1 s. Slope = least-squares MB per minute.
- Every L scenario ran 3 times per commit. Tables show the median of the runs with min–max. C1 is a correctness check: 20 trials per commit, each its own SIGKILL and restart, then one shared wait of up to 18 min for the dead leases (15 min TTL) and the recovery sweep (2 min grace on detached rows).
- C1 window: the read row is created `detached` with id prefix `async_tool_hold_`. The fake model's preload holds (never sends) the Convex write whose body carries a tool result for such an id, so the tool has returned but the step is never saved. Core is SIGKILLed while that write is held. `told` counts how many saved history rows carry the result's payload.
- `--summarize raw/dev raw/A` regenerates every table below from `raw/` (gunzip the JSON first).
- Only the async kind of C1 ran. The subagent kind needs a `get_subagent_status` tool, and dev has none (see Problems).

## C1: crash between the status read and the step save

20 trials per commit. Each trial: a new conversation, a `detached` finished result, an `async_status` read that returned, the step save held, then SIGKILL and restart of core. After the last trial, one shared wait of up to 18 min.

| commit | conversations | told 0 | told 1 | told 2+ | row hand-back at end |
| ------ | ------------- | ------ | ------ | ------- | -------------------- |
| dev    | 20            | 20     | 0      | 0       | {"stored":20}        |
| A      | 20            | 0      | 20     | 0       | {"stored":20}        |

- Dev: the read marked each row `stored` while the tool ran. The row then left the sweep's list, nothing re-delivered it, and the history never got it (told = 0 in 20/20).
- A: the read wrote nothing. After the restart, the sweep resumed each still-`detached` row. The resume queued behind the dead owner until its lease ran out, and then the resume turn saved the result once (told = 1 in 20/20, no doubles).
- At the end, dev still holds the 20 killed turns' envelopes in `processing` (nothing touched those conversations again). On A, the resume admissions expired them (0 left).

## Scenario tables (dev vs A)

Median of 3 runs, with min–max. "turn" = SSE stream time. "turn→idle" = until the turn's last Convex call, including a queued resume it left behind. Memory and CPU rows are the per-second samples of core, gateway and the Convex container.

### L1

| metric (median of runs, min–max) | dev (3 runs)      | A (3 runs)       |
| -------------------------------- | ----------------- | ---------------- |
| turn p50 ms                      | 195 (187–195)     | 192 (189–193)    |
| turn p95 ms                      | 288 (276–292)     | 280 (268–286)    |
| turn p99 ms                      | 334 (332–340)     | 311 (300–312)    |
| turn→idle p50 ms                 | 195 (189–195)     | 192 (191–193)    |
| turn→idle p95 ms                 | 288 (277–292)     | 280 (268–290)    |
| drift ms (last 20 − first 20)    | 130 (119–137)     | 124 (123–131)    |
| Convex calls / turn              | 11.6 (11.5–11.6)  | 10.5 (10.5–10.5) |
| wall s                           | 79.5 (79.2–79.5)  | 78.9 (78.4–79.5) |
| core RSS start MB                | 317 (267–346)     | 290 (259–339)    |
| core RSS peak MB                 | 347 (345–349)     | 340 (327–341)    |
| core RSS end MB                  | 345 (318–346)     | 308 (294–340)    |
| core RSS slope MB/min            | 35.4 (7.7–61.2)   | 21.8 (19.5–57.8) |
| core CPU mean %                  | 9.78 (9.33–11.31) | 10.5 (9.9–13.0)  |
| gateway RSS start MB             | 48.0 (48.0–49.8)  | 46.3 (46.3–48.6) |
| gateway RSS peak MB              | 48.0 (48.0–49.9)  | 46.3 (46.3–48.6) |
| gateway RSS end MB               | 48.0 (48.0–48.0)  | 46.3 (46.3–46.3) |
| gateway CPU mean %               | 0.08 (0.04–0.12)  | 0.04 (0.04–0.10) |
| convex mem start MB              | 414 (390–448)     | 478 (435–510)    |
| convex mem peak MB               | 445 (409–473)     | 505 (501–530)    |
| convex mem end MB                | 445 (409–473)     | 505 (501–530)    |
| convex CPU mean %                | 73.4 (71.7–74.5)  | 72.9 (71.1–73.1) |
| turn errors                      | 0.00 (0.00–0.00)  | 0.00 (0.00–0.00) |

Convex calls per turn by function (median of runs):

| function                               | dev              | A                |
| -------------------------------------- | ---------------- | ---------------- |
| account/accounts:getBySecretHash       | 1.00 (1.00–1.01) | 1.00 (1.00–1.01) |
| account/budget:get                     | 0.01 (0.01–0.01) | 0.01 (0.01–0.01) |
| agent/agents:getById                   | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtime:getAsyncToolResult             | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtime:listBuildingSandboxSnapshots   | 0.01 (0.01–0.01) | 0.01 (0.00–0.01) |
| runtime:listConversationEvents         | 1.36 (1.36–1.36) | 1.36 (1.36–1.36) |
| runtime:listExpiredSandboxReservations | 0.00 (0.00–0.01) | 0.00 (0.00–0.01) |
| runtime:listOrphanedSandboxInstances   | 0.00 (0.00–0.01) | 0.00 (0.00–0.01) |
| runtime:listOwedAsyncAgentResults      | 0.09 (0.06–0.09) | 0.09 (0.06–0.09) |
| runtime:listOwedAsyncToolResults       | 0.06 (0.04–0.06) | 0.06 (0.04–0.06) |
| runtime:markAsyncToolHandback          | 1.00 (1.00–1.00) | 0.00 (0.00–0.00) |
| runtimeIngress:accept                  | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtimeIngress:appendConversationEvent | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtimeIngress:recoverQueued           | 0.01 (0.01–0.01) | 0.01 (0.01–0.01) |
| runtimeIngress:stepBoundary            | 2.00 (2.00–2.00) | 2.00 (2.00–2.00) |
| runtimeIngress:takeNext                | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| usage:recordTaskUsage                  | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |

Convex function executions (all runs pooled): calls, mean / p95 ms, mean docs read / written:

| function                               | dev                                        | A                                          |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| runtimeIngress:stepBoundary            | 401/run, 11.21 / 16.34 ms, 2.0 r / 1.5 w   | 401/run, 12.64 / 18.31 ms, 3.0 r / 2.0 w   |
| runtimeIngress:appendConversationEvent | 201/run, 9.60 / 14.35 ms, 2.0 r / 1.0 w    | 201/run, 10.56 / 15.44 ms, 2.0 r / 1.0 w   |
| runtime:markAsyncToolHandback          | 200/run, 9.95 / 14.63 ms, 3.0 r / 1.0 w    | -                                          |
| runtimeIngress:accept                  | 201/run, 12.66 / 18.35 ms, 3.0 r / 2.0 w   | 201/run, 13.11 / 18.79 ms, 3.0 r / 2.0 w   |
| runtimeIngress:takeNext                | 201/run, 14.63 / 23.47 ms, 6.0 r / 2.0 w   | 201/run, 14.68 / 22.18 ms, 6.0 r / 2.0 w   |
| runtimeIngress:recoverQueued           | 3/run, 11.72 / 23.54 ms, 0.0 r / 0.0 w     | 3/run, 9.67 / 14.96 ms, 0.0 r / 0.0 w      |
| runtime:getAsyncToolResult             | 200/run, 8.39 / 12.32 ms, 1.0 r / 0.0 w    | 200/run, 8.42 / 12.00 ms, 1.0 r / 0.0 w    |
| runtime:listConversationEvents         | 273/run, 43.96 / 85.69 ms, 293.3 r / 0.0 w | 273/run, 45.47 / 90.51 ms, 293.3 r / 0.0 w |

Rows at the end (median of runs):

| rows                           | dev              | A                |
| ------------------------------ | ---------------- | ---------------- |
| conversation events            | 802 (802–802)    | 802 (802–802)    |
| queued envelopes               | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| processing envelopes           | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| result rows completed/stored   | 200 (200–200)    | 200 (200–200)    |
| results the history carries 1× | 200 (200–200)    | 200 (200–200)    |

### L2

| metric (median of runs, min–max) | dev (3 runs)     | A (3 runs)       |
| -------------------------------- | ---------------- | ---------------- |
| turn p50 ms                      | 681 (680–698)    | 612 (608–615)    |
| turn p95 ms                      | 819 (814–829)    | 702 (697–787)    |
| turn p99 ms                      | 869 (843–894)    | 826 (744–890)    |
| turn→idle p50 ms                 | 857 (854–887)    | 614 (609–618)    |
| turn→idle p95 ms                 | 1121 (1114–1150) | 710 (708–787)    |
| drift ms (last 20 − first 20)    | 219 (207–243)    | 153 (142–178)    |
| Convex calls / turn              | 29.9 (29.9–30.0) | 18.7 (18.7–18.7) |
| wall s                           | 223 (223–225)    | 163 (162–164)    |
| core RSS start MB                | 341 (338–365)    | 303 (258–328)    |
| core RSS peak MB                 | 392 (392–405)    | 328 (322–329)    |
| core RSS end MB                  | 354 (340–364)    | 315 (307–328)    |
| core RSS slope MB/min            | 12.7 (12.0–16.1) | 11.7 (7.4–15.2)  |
| core CPU mean %                  | 8.96 (8.74–9.24) | 7.08 (6.84–8.45) |
| gateway RSS start MB             | 48.0 (48.0–48.0) | 46.2 (46.2–47.6) |
| gateway RSS peak MB              | 48.0 (48.0–48.0) | 46.2 (46.2–47.6) |
| gateway RSS end MB               | 48.0 (48.0–48.0) | 46.2 (46.2–46.2) |
| gateway CPU mean %               | 0.03 (0.03–0.03) | 0.04 (0.03–0.06) |
| convex mem start MB              | 578 (478–605)    | 468 (389–513)    |
| convex mem peak MB               | 591 (562–623)    | 494 (462–530)    |
| convex mem end MB                | 579 (562–623)    | 493 (462–530)    |
| convex CPU mean %                | 64.2 (62.9–64.4) | 47.6 (45.0–48.4) |
| turn errors                      | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |

Convex calls per turn by function (median of runs):

| function                               | dev              | A                |
| -------------------------------------- | ---------------- | ---------------- |
| account/accounts:getBySecretHash       | 1.02 (1.01–1.02) | 1.01 (1.01–1.01) |
| account/budget:get                     | 0.04 (0.04–0.04) | 0.03 (0.03–0.03) |
| account/keys:list                      | 0.01 (0.01–0.01) | 0.00 (0.00–0.01) |
| agent/agents:getById                   | 4.00 (4.00–4.00) | 3.00 (3.00–3.00) |
| agent/deployments:getByAgentId         | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtime:createAsyncAgentResult         | 2.00 (2.00–2.00) | 0.00 (0.00–0.00) |
| runtime:getAsyncToolResult             | 2.00 (2.00–2.00) | 2.00 (2.00–2.00) |
| runtime:getAsyncToolToken              | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtime:listBuildingSandboxSnapshots   | 0.02 (0.01–0.02) | 0.01 (0.01–0.01) |
| runtime:listConversationEvents         | 3.44 (3.44–3.44) | 1.36 (1.36–1.36) |
| runtime:listExpiredSandboxReservations | 0.00 (0.00–0.00) | 0.00 (0.00–0.01) |
| runtime:listOrphanedSandboxInstances   | 0.00 (0.00–0.00) | 0.00 (0.00–0.01) |
| runtime:listOwedAsyncAgentResults      | 0.21 (0.21–0.24) | 0.15 (0.15–0.15) |
| runtime:listOwedAsyncToolResults       | 0.14 (0.14–0.16) | 0.10 (0.10–0.10) |
| runtime:markAsyncToolHandback          | 1.00 (1.00–1.00) | 0.00 (0.00–0.00) |
| runtime:updateAsyncToolResult          | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtimeIngress:accept                  | 2.00 (2.00–2.00) | 2.00 (2.00–2.00) |
| runtimeIngress:appendConversationEvent | 2.00 (2.00–2.00) | 1.00 (1.00–1.00) |
| runtimeIngress:getConversationTarget   | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtimeIngress:recoverQueued           | 0.04 (0.04–0.04) | 0.03 (0.03–0.03) |
| runtimeIngress:settle                  | 1.00 (1.00–1.00) | 0.00 (0.00–0.00) |
| runtimeIngress:stepBoundary            | 3.00 (3.00–3.00) | 2.00 (2.00–2.00) |
| runtimeIngress:takeNext                | 2.00 (2.00–2.00) | 1.00 (1.00–1.00) |
| usage:recordTaskUsage                  | 2.00 (2.00–2.00) | 1.00 (1.00–1.00) |

Convex function executions (all runs pooled): calls, mean / p95 ms, mean docs read / written:

| function                               | dev                                         | A                                          |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| runtimeIngress:stepBoundary            | 610/run, 12.37 / 18.08 ms, 2.4 r / 1.3 w    | 406/run, 15.07 / 24.09 ms, 5.5 r / 3.0 w   |
| runtimeIngress:appendConversationEvent | 401/run, 10.17 / 14.86 ms, 2.0 r / 1.0 w    | 201/run, 11.05 / 16.58 ms, 2.0 r / 1.0 w   |
| runtime:markAsyncToolHandback          | 200/run, 11.20 / 16.25 ms, 3.0 r / 0.0 w    | -                                          |
| runtimeIngress:accept                  | 401/run, 14.33 / 21.46 ms, 3.5 r / 2.0 w    | 401/run, 14.21 / 21.00 ms, 3.5 r / 2.0 w   |
| runtimeIngress:takeNext                | 401/run, 14.72 / 25.38 ms, 6.0 r / 3.0 w    | 201/run, 14.91 / 23.03 ms, 6.0 r / 2.0 w   |
| runtimeIngress:settle                  | 200/run, 17.26 / 24.49 ms, 8.0 r / 2.0 w    | -                                          |
| runtimeIngress:recoverQueued           | 7/run, 12.74 / 17.40 ms, 1.2 r / 0.0 w      | 5/run, 12.87 / 26.33 ms, 1.3 r / 0.0 w     |
| runtime:getAsyncToolResult             | 400/run, 10.40 / 15.54 ms, 1.0 r / 0.0 w    | 400/run, 10.32 / 16.22 ms, 1.0 r / 0.0 w   |
| runtime:listConversationEvents         | 689/run, 58.17 / 110.70 ms, 345.6 r / 0.0 w | 273/run, 47.70 / 93.12 ms, 293.3 r / 0.0 w |

Rows at the end (median of runs):

| rows                           | dev              | A                |
| ------------------------------ | ---------------- | ---------------- |
| conversation events            | 1202 (1202–1202) | 802 (802–802)    |
| queued envelopes               | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| processing envelopes           | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| result rows completed/stored   | 200 (200–200)    | 200 (200–200)    |
| results the history carries 1× | 200 (200–200)    | 200 (200–200)    |

### L3

| metric (median of runs, min–max) | dev (3 runs)     | A (3 runs)        |
| -------------------------------- | ---------------- | ----------------- |
| turn p50 ms                      | 174 (174–179)    | 172 (169–176)     |
| turn p95 ms                      | 268 (259–273)    | 252 (244–260)     |
| turn p99 ms                      | 299 (290–313)    | 285 (267–384)     |
| turn→idle p50 ms                 | 176 (175–180)    | 173 (169–176)     |
| turn→idle p95 ms                 | 271 (268–274)    | 256 (250–262)     |
| drift ms (last 20 − first 20)    | 116 (114–120)    | 96.7 (90.4–141.0) |
| Convex calls / turn              | 10.8 (10.7–10.8) | 10.4 (10.4–10.4)  |
| wall s                           | 71.0 (70.5–71.2) | 69.4 (69.4–70.8)  |
| core RSS start MB                | 342 (329–355)    | 313 (312–317)     |
| core RSS peak MB                 | 346 (344–364)    | 332 (331–340)     |
| core RSS end MB                  | 341 (339–342)    | 332 (316–340)     |
| core RSS slope MB/min            | 14.7 (14.5–16.1) | 17.6 (15.2–40.3)  |
| core CPU mean %                  | 10.4 (10.3–10.5) | 10.4 (10.3–11.0)  |
| gateway RSS start MB             | 48.2 (48.0–48.2) | 46.3 (46.2–46.3)  |
| gateway RSS peak MB              | 48.6 (48.2–48.7) | 46.4 (46.3–46.7)  |
| gateway RSS end MB               | 48.2 (48.2–48.5) | 46.3 (46.3–46.6)  |
| gateway CPU mean %               | 0.22 (0.17–0.23) | 0.21 (0.19–0.22)  |
| convex mem start MB              | 721 (691–746)    | 558 (545–571)     |
| convex mem peak MB               | 721 (691–747)    | 563 (548–574)     |
| convex mem end MB                | 697 (659–719)    | 547 (525–574)     |
| convex CPU mean %                | 64.7 (63.8–64.8) | 64.5 (64.3–64.9)  |
| turn errors                      | 0.00 (0.00–0.00) | 0.00 (0.00–0.00)  |

Convex calls per turn by function (median of runs):

| function                               | dev              | A                |
| -------------------------------------- | ---------------- | ---------------- |
| account/accounts:getBySecretHash       | 1.00 (1.00–1.01) | 1.00 (1.00–1.00) |
| account/budget:get                     | 0.01 (0.01–0.01) | 0.01 (0.01–0.01) |
| account/keys:list                      | 0.00 (0.00–0.00) | 0.00 (0.00–0.01) |
| agent/agents:getById                   | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtime:getAsyncToolResult             | 0.34 (0.34–0.34) | 0.34 (0.34–0.34) |
| runtime:listBuildingSandboxSnapshots   | 0.01 (0.01–0.01) | 0.01 (0.01–0.01) |
| runtime:listConversationEvents         | 1.23 (1.23–1.23) | 1.23 (1.23–1.23) |
| runtime:listOwedAsyncAgentResults      | 0.09 (0.06–0.09) | 0.06 (0.06–0.06) |
| runtime:listOwedAsyncToolResults       | 0.06 (0.04–0.06) | 0.04 (0.04–0.04) |
| runtime:markAsyncToolHandback          | 0.34 (0.34–0.34) | 0.00 (0.00–0.00) |
| runtimeIngress:accept                  | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtimeIngress:appendConversationEvent | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| runtimeIngress:recoverQueued           | 0.01 (0.01–0.01) | 0.01 (0.01–0.01) |
| runtimeIngress:stepBoundary            | 1.67 (1.67–1.67) | 1.67 (1.67–1.67) |
| runtimeIngress:takeNext                | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| sandbox/configs:getById                | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |
| usage:recordTaskUsage                  | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) |

Convex function executions (all runs pooled): calls, mean / p95 ms, mean docs read / written:

| function                               | dev                                        | A                                          |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| runtimeIngress:stepBoundary            | 334/run, 11.40 / 16.29 ms, 2.0 r / 1.4 w   | 334/run, 12.07 / 17.51 ms, 2.4 r / 1.6 w   |
| runtimeIngress:appendConversationEvent | 201/run, 10.08 / 14.85 ms, 2.0 r / 1.0 w   | 201/run, 10.22 / 14.97 ms, 2.0 r / 1.0 w   |
| runtime:markAsyncToolHandback          | 67/run, 10.69 / 15.16 ms, 3.0 r / 1.0 w    | -                                          |
| runtimeIngress:accept                  | 201/run, 14.01 / 20.03 ms, 3.0 r / 2.0 w   | 201/run, 14.36 / 20.73 ms, 3.0 r / 2.0 w   |
| runtimeIngress:takeNext                | 201/run, 14.40 / 22.62 ms, 6.0 r / 2.0 w   | 201/run, 14.76 / 23.25 ms, 6.0 r / 2.0 w   |
| runtimeIngress:recoverQueued           | 3/run, 10.78 / 15.36 ms, 0.0 r / 0.0 w     | 2/run, 11.35 / 21.50 ms, 0.0 r / 0.0 w     |
| runtime:getAsyncToolResult             | 67/run, 8.21 / 12.11 ms, 1.0 r / 0.0 w     | 67/run, 8.67 / 12.42 ms, 1.0 r / 0.0 w     |
| runtime:listConversationEvents         | 247/run, 42.34 / 85.53 ms, 269.8 r / 0.0 w | 247/run, 41.22 / 79.10 ms, 269.8 r / 0.0 w |

Rows at the end (median of runs):

| rows                           | dev              | A                |
| ------------------------------ | ---------------- | ---------------- |
| conversation events            | 668 (668–668)    | 668 (668–668)    |
| queued envelopes               | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| processing envelopes           | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| result rows completed/stored   | 67.0 (67.0–67.0) | 67.0 (67.0–67.0) |
| results the history carries 1× | 67.0 (67.0–67.0) | 67.0 (67.0–67.0) |

### L4

| metric (median of runs, min–max) | dev (3 runs)     | A (3 runs)       |
| -------------------------------- | ---------------- | ---------------- |
| turn p50 ms                      | 585 (576–596)    | 550 (536–561)    |
| turn p95 ms                      | 803 (797–837)    | 737 (732–738)    |
| turn p99 ms                      | 895 (876–942)    | 808 (791–839)    |
| turn→idle p50 ms                 | 585 (576–596)    | 550 (536–561)    |
| turn→idle p95 ms                 | 803 (797–837)    | 737 (732–738)    |
| drift ms (last 20 − first 20)    | 169 (142–179)    | 127 (94–173)     |
| Convex calls / turn              | 10.4 (10.4–10.5) | 10.1 (10.1–10.1) |
| wall s                           | 73.9 (71.7–75.4) | 71.2 (69.3–71.5) |
| core RSS start MB                | 340 (324–345)    | 302 (301–309)    |
| core RSS peak MB                 | 490 (481–494)    | 469 (468–477)    |
| core RSS end MB                  | 462 (451–467)    | 435 (360–468)    |
| core RSS slope MB/min            | 114 (109–116)    | 130 (126–135)    |
| core CPU mean %                  | 30.6 (29.7–30.6) | 30.9 (30.9–32.5) |
| gateway RSS start MB             | 48.7 (48.5–49.2) | 46.7 (46.6–46.8) |
| gateway RSS peak MB              | 49.2 (49.2–49.3) | 47.3 (47.2–47.3) |
| gateway RSS end MB               | 48.8 (48.7–49.2) | 46.8 (46.8–47.2) |
| gateway CPU mean %               | 0.30 (0.28–0.33) | 0.29 (0.28–0.29) |
| convex mem start MB              | 1057 (795–1226)  | 904 (619–1041)   |
| convex mem peak MB               | 1084 (960–1230)  | 930 (815–1044)   |
| convex mem end MB                | 1083 (960–1210)  | 930 (815–1028)   |
| convex CPU mean %                | 249 (247–251)    | 249 (247–251)    |
| turn errors                      | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |

Convex calls per turn by function (median of runs):

| function                               | dev              | A                |
| -------------------------------------- | ---------------- | ---------------- |
| account/accounts:getBySecretHash       | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| account/budget:get                     | 0.01 (0.00–0.01) | 0.01 (0.00–0.01) |
| account/keys:list                      | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| agent/agents:getById                   | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| runtime:getAsyncToolResult             | 0.33 (0.33–0.33) | 0.33 (0.33–0.33) |
| runtime:listBuildingSandboxSnapshots   | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| runtime:listConversationEvents         | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| runtime:listOwedAsyncAgentResults      | 0.01 (0.01–0.02) | 0.02 (0.01–0.02) |
| runtime:listOwedAsyncToolResults       | 0.01 (0.01–0.01) | 0.01 (0.01–0.01) |
| runtime:markAsyncToolHandback          | 0.33 (0.33–0.33) | 0.00 (0.00–0.00) |
| runtimeIngress:accept                  | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| runtimeIngress:appendConversationEvent | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| runtimeIngress:recoverQueued           | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| runtimeIngress:stepBoundary            | 1.67 (1.67–1.67) | 1.67 (1.67–1.67) |
| runtimeIngress:takeNext                | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| sandbox/configs:getById                | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |
| usage:recordTaskUsage                  | 1.01 (1.01–1.01) | 1.01 (1.01–1.01) |

Convex function executions (all runs pooled): calls, mean / p95 ms, mean docs read / written:

| function                               | dev                                          | A                                            |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| runtimeIngress:stepBoundary            | 1670/run, 48.31 / 79.73 ms, 2.0 r / 1.4 w    | 1670/run, 49.37 / 83.55 ms, 2.4 r / 1.6 w    |
| runtimeIngress:appendConversationEvent | 1010/run, 39.27 / 66.79 ms, 2.0 r / 1.0 w    | 1010/run, 37.73 / 62.72 ms, 2.0 r / 1.0 w    |
| runtime:markAsyncToolHandback          | 330/run, 44.06 / 71.38 ms, 3.0 r / 1.0 w     | -                                            |
| runtimeIngress:accept                  | 1010/run, 53.31 / 84.33 ms, 3.0 r / 2.0 w    | 1010/run, 52.18 / 82.85 ms, 3.0 r / 2.0 w    |
| runtimeIngress:takeNext                | 1010/run, 49.30 / 79.35 ms, 6.0 r / 2.0 w    | 1010/run, 47.63 / 77.18 ms, 6.0 r / 2.0 w    |
| runtimeIngress:recoverQueued           | 2/run, 36.16 / 63.69 ms, 0.0 r / 0.0 w       | 3/run, 25.50 / 50.07 ms, 0.0 r / 0.0 w       |
| runtime:getAsyncToolResult             | 330/run, 31.76 / 54.67 ms, 1.0 r / 0.0 w     | 330/run, 29.40 / 49.96 ms, 1.0 r / 0.0 w     |
| runtime:listConversationEvents         | 1010/run, 79.59 / 139.92 ms, 164.7 r / 0.0 w | 1010/run, 74.84 / 131.23 ms, 164.7 r / 0.0 w |

Rows at the end (median of runs):

| rows                           | dev              | A                |
| ------------------------------ | ---------------- | ---------------- |
| conversation events            | 3340 (3340–3340) | 3340 (3340–3340) |
| queued envelopes               | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| processing envelopes           | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) |
| result rows completed/stored   | 330 (330–330)    | 330 (330–330)    |
| results the history carries 1× | 330 (330–330)    | 330 (330–330)    |

## Checks run on A (`dab81ec`)

| check                                           | result                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| root `bun run format` / `format:check`          | clean                                                                                                                                     |
| root `bun run lint`                             | pass (pre-existing complexity warnings only)                                                                                              |
| root `bun run lint:types`                       | pass                                                                                                                                      |
| `packages/convex` `bun run check`               | pass                                                                                                                                      |
| `apps/core` `bun run check`                     | pass                                                                                                                                      |
| Convex tests (`packages/convex` `bun run test`) | 92 files, 849 tests pass                                                                                                                  |
| core tests (`apps/core` `bun run test`)         | 1977 pass, 33 skip, 0 fail (see Problems: run it only on a disposable box)                                                                |
| `bun run local:verify`                          | pass (61.7 s), including the new `status-read-handback` case                                                                              |
| `bun run local:perf`                            | pass: sse text turn 8 calls (budget 8), sse bash tool turn 10 calls (budget 10); `async text run` p50 drift warning only (machine timing) |
| `lake build` in `verification/`                 | pass, axiom audit included                                                                                                                |
| Convex codegen                                  | `_generated/api.d.ts` regenerated by `local:up` and committed; a fresh `up` leaves no diff                                                |

## Problems

1. **The core test suite kills every process of its UID (critical for anyone running it as root).** `apps/lambda/handler.mjs` `reapStrays()` SIGKILLs every process of the handler's UID except its ancestors. `apps/core/tests/mcp-runner-security.test.ts` runs that handler on the host. Running `apps/core` `bun run test` as root (this container) killed `dockerd`, both local stacks, the dev C1 benchmark run and the session's commit-signing helper, with no log lines (SIGKILL). The same run also killed the `tail` in the shell pipeline. Consequences here: the first dev C1 attempt was lost, Docker had to be restarted, and **the last commits on this branch are unsigned** because the signing helper never came back. Not fixed here (out of scope); I filed it as a separate task: guard `reapStrays()` to a real Lambda environment and isolate the test.
2. **A gap of the same kind remains on the resume side.** A queued or admitted resume still marks its result `stored` when it is handed to an owner (`markDeliveredResultsStored` in `accept`, `promoteQueuedGroup`, `claimSteering`), not when the resume turn's history is saved. If core dies between that hand-over and the resume turn's first step boundary, the envelope expires, the row is already `stored`, and the result is lost exactly like #1183. Option A's invariant ("only history writes set stored") holds for status reads, not yet for resumes. The first C1 attempt on A showed the hand-over marking: 12 rows were `stored` with told = 0 while their resume turns still waited for a worker. The cause there was a harness artifact (next item), but it is exactly the window this gap leaves.
3. **Harness artifacts found and fixed during the run. The published numbers come from the fixed runs.**
   - Trace-quiet detection let the next L2 turn start while dev's follow-up resume turn still owned the conversation. One dev L2 run then had 49 turns answered `202 queued` instead of streaming. Fix: after each turn, wait until the resume envelope (and a queued turn) is terminal. Every dev L run was repeated after the fix, on a fresh stack.
   - `convex data` output overflowed `spawnSync`'s 1 MiB buffer, which crashed the first dev L2 run. Fix: `maxBuffer` raised for the stack's Convex CLI calls.
   - C1 with 20 conversations at once hit `MAX_INPROCESS_WORKERS` (8): held saves keep their worker slots, so only 8 reads ran. Fix: one trial per kill.
   - In the first C1 attempt, the resume's text merged into the dead turn's user message, which still carried the `ASYNC_STATUS:` trigger. The fake model then read the result again in the resume turn, and that save was held too, so 8 resume turns hung and filled every worker slot. Dev was unaffected (0/20 either way); A showed 8×1 and 12×0. That attempt's raw data is kept in `raw/c1-first-attempt/`. Fix: the fake model asks for no tool when the message already carries a delivered result. Rerun: A 20×1.
4. **Harness versions behind the numbers.** The harness commit was amended while it was being fixed, and the branch history was rewritten accordingly (force-pushed, my branch only). Dev L1–L4 ran on harness `d18eb84` and A L1–L4 on harness `73d9dc0` (+A). The harness code differs between these only in C1 and in the fake model's handling of merged resume messages, which no L turn produces. Both C1 runs used the final harness (`2dffa69`, `dab81ec`). A's L1 and L2–L4 ran on two different fresh stacks because the session's worker restart killed the first one mid-L2. Dev L1–L4 ran on one stack.
5. **Spec items that do not exist on dev.** There is no `get_subagent_status` tool, and no `markDelivered` / `confirmDelivered` / `readUnsaved` or in-turn delivered set in core. Only `async_status` marked on read. So:
   - the subagent kind of C1 could not run;
   - the subagent half of A is the Convex side only: `handbacks` with a `subagent:<id>:<status>` key store the row and complete its queued resume, and Convex tests cover it;
   - nothing was deleted on the core side beyond the mark in `async_status`.
   - `markAsyncAgentHandback` / `markAsyncToolHandback` `stored` stay for results the parent is never told (hidden by a finish hook, given up by the sweep), now without the give-way.
6. **`stepBoundary` per call is a little heavier on A when it carries a hand-back.** It reads one more document and writes 0.5 more on average in L1, and 3.1 more reads and 1.7 more writes in L2, where it also completes the queued envelope and patches the coordinator. Mean execution time rises from 11.2 to 12.6 ms (L1) and from 12.4 to 15.1 ms (L2). That is far less than the separate mark mutation (L1), or the extra resume turn (L2), it replaces.
7. **Noise worth knowing.** The Convex container's memory grows with the stack's age (dev and A ran on different stacks), so compare its absolute memory with care. Core RSS slopes swing from 8 to 61 MB/min between runs of the same commit (GC timing over 80-second runs), so they cannot confirm or rule out a slow leak on either commit. The `local:perf` timing drifts against the darwin-arm64 baseline and the warning are machine-dependent (linux-x64 has no recorded baseline).

## Raw data

`raw/<dev|A>/<scenario>-run<n>.json.gz` holds every turn (stream ms, idle ms, Convex calls by function), the per-second resource samples, the Convex function executions, row counts and the C1 records. `*.turns.csv` and `*.resources.csv` are flat copies for plotting. `raw/logs/` has the harness output and the A `local:perf` report.
