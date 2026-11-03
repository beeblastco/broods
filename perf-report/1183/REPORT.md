# #1183: resume crash test on dev

**Verdict.** `dev` at `e5dd6b4`, with #1334 and #1346, survives a core crash between a resume's handover and the save of its message. All 20 conversations were told their result exactly once, and every row reads `stored`.

## Method

`bun run local:up -- --perf`, then `bun scripts/local-stack.ts crash --trials 20`. The fake model answers in process; no model key is used.

1. Opens 20 conversations, each with one text turn.
2. Seeds a settled background result per conversation and marks it `detached`, as a run that stopped waiting leaves it.
3. The recovery sweep resumes each one. The fake-model preload holds the owner's history write that carries the resume's message (`async_tool_resumehold_` ids), so the run is handed the resume but never saves it.
4. Once a write is held and the sweep's pass has admitted the rest, core is SIGKILLed and started again with holding off.
5. Waits up to 25 minutes (lease, `maintain`, sweep), then counts how many times each conversation's saved history carries its result.

## Result

| Run             | Held saves at kill | Told   | Rows `stored` |
| --------------- | ------------------ | ------ | ------------- |
| `dev` `e5dd6b4` | 8 (the worker cap) | 20 × 1 | 20 / 20       |

The other 12 resumes were admitted and still waiting for a worker when core died. Raw trials: `c2-dev-e5dd6b4.json`.

The negative control is from the earlier version of this branch (option A before its resume fix, on `e209108`). There, a resume was marked `stored` at handover, and the same test gave 0 / 20.

## Not covered

- **C1 (crash between a status read and its step save) cannot run locally on `dev`.** `async_status` now registers only for a workspace on a persistent sandbox. The local stack has no bucket, so the run fails at the workspace mount before the model is called. The read side is covered by #1334's Convex and core tests, and by the `status-read-handback` verify case.
- Latency was not measured. `local:perf` budgets cover per-turn Convex calls.
