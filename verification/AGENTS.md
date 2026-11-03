# verification

Lean 4 models of broods contracts, with machine-checked proofs. Not a Bun workspace. No Mathlib, core Lean only.

- `Broods/Gateway.lean`: the edge route table, `ROUTERS` + `resolveRouter` in `apps/edge/src/routes.ts`, which Traefik serves. proves routing ignores trailing slashes.
- `Broods/Ingress.lean`: `packages/convex/runtimeIngress.ts` envelope lifecycle. proves terminal runs stay terminal, every step moves forward, settle is fenced, `/stop` hits only its generation, `maintain` never expires a run its owner still holds, a step boundary claims steers only behind its own fence and stop check, and an ownership proof holds for the rest of its lease.
- `Broods/AsyncResults.lean`: the async result row, settled with its envelope in one `runtimeIngress.settle`, plus `runtimeAsyncToolResults`. proves envelope and result row agree at every throw point, including a callback throw the harness swallows, a recorded outcome survives later throws, a failed write never loses what the run produced, a tool row settles once, and a late result reaches its parent at most once, by a saved status read or a resume, never through a resume after the row is stored; a status read whose turn dies before its step is saved stores nothing, so a resume tells the parent exactly once, a saved read completes a queued resume of it, a resume whose owner dies before saving it is told again by the next one, and a result is told again after a queued resume of it expired.
- `Broods/Cron.lean`: `packages/convex/agent/crons.ts` run rows. proves the first settle wins and a drained run settles as a no-op.
- `Broods/Sync.lean`: `broods dev` / `deploy` manifest sync with server rename matching. proves the next diff after a sync is deletes only, empty after prune; outright for skill/hook/mcp, given `normalize` round-trips for the rest.
- `Broods/SyncExternal.lean`, `SyncCron.lean`, `SyncEnv.lean`, `SyncConcurrency.lean`: stage-scoped external prune by recorded row that waits for the manifest sync, cron keys and orphans, env push, and exclusive manifest PUT claims (overlapping writes are refused with or without a revision; stale cleanup cannot release a newer claim).
- `Broods/StageTicket.lean`: `broods run`'s stage ticket in `packages/broods/src/cli/index.ts` `run()`. proves no request sends an expired ticket, for any set of requests and any interleaving of concurrent re-mints, given latency plus clock lag under the 60 s margin and latency under the ticket TTL.
- `Broods/DevWatch.lean`: the `broods dev` watch loop in `dev()`. proves the stage holds the source whenever no sync is running or queued, unless the last sync failed or a source read errored (both print the error and wait for the next save), for unbounded saves of any content. The source is the `.ts` and `.md` files the signature hashes. Two findings show saves once lost and now synced: one made during the first sync, and one undone while a sync ran.
- `Broods/EscFilter.lean`: `stopTurnOnEscape` in `packages/broods/src/cli/tui.ts`. proves a lone Esc read mid-turn only stops the turn (a read of Esc plus more, like Alt+key, is a key and passes through), an arrow key split across reads stays one key, and key order holds. Liveness over infinite behaviors under the spec's weak fairness of reading and of the hold timer: no Esc stays held, and once keys stop every read is handled. Given a split key's halves arrive within the 30 ms wait.

## Rules

- `bun run verification:test` runs the TypeScript contract tests beside `lake build` in CI. These test implementation behavior and representative normalization round trips; they do not prove TypeScript equivalent to Lean. Models omit auth, admission, I/O and many product features.
- the model is hand-written from the TypeScript. change the mirrored code = update the model in the same PR. docstring on each def names the TS it mirrors.
- `example ... := by decide` blocks are findings: concrete inputs where the code does something surprising. fix the code = flip the example to the fixed outcome.
- no `sorry`, no `native_decide`, no new `axiom`, so every proof rests on `propext`, `Quot.sound`, `Classical.choice` only. `lake build` enforces it: the audit at the end of `Broods.lean` fails on any other axiom a `Broods` declaration rests on, `sorryAx` and `native_decide`'s included.

## Run

- install: `curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none`
- check: `lake build` in this folder. CI: `.github/workflows/lean-verification.yaml`.
