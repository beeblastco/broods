# verification

Lean 4 models of broods contracts, with machine-checked proofs. Not a Bun workspace. No Mathlib, core Lean only.

- `Broods/Gateway.lean`: the edge route table, `ROUTERS` + `resolveRouter` in `apps/edge/src/routes.ts`, which Traefik serves. proves routing ignores trailing slashes.
- `Broods/Ingress.lean`: `packages/convex/runtimeIngress.ts` envelope lifecycle. proves terminal runs stay terminal, every step moves forward, settle is fenced, `/stop` hits only its generation, `maintain` never expires a run its owner still holds, a step boundary claims steers only behind its own fence and stop check, and an ownership proof holds for the rest of its lease.
- `Broods/AsyncResults.lean`: the async result row, settled with its envelope in one `runtimeIngress.settle`, plus `runtimeAsyncToolResults`. proves envelope and result row agree at every throw point, including a callback throw the harness swallows, a recorded outcome survives later throws, a failed write never loses what the run produced, a tool row settles once, and a late result reaches its parent at most once, by a saved status read or a resume, never through a resume after the row is stored; a status read whose turn dies before its step is saved stores nothing, so a resume tells the parent exactly once, a saved read completes a queued resume of it, a resume whose owner dies before saving it is told again by the next one, and a result is told again after a queued resume of it expired.
- `Broods/Cron.lean`: `packages/convex/agent/crons.ts` run rows. proves the first settle wins and a drained run settles as a no-op.
- `Broods/Sync.lean`: `broods dev` / `deploy` manifest sync with server rename matching. proves the next diff after a sync is deletes only, empty after prune; outright for skill/hook/mcp, given `normalize` round-trips for the rest.
- `Broods/SyncExternal.lean`, `SyncCron.lean`, `SyncEnv.lean`, `SyncConcurrency.lean`: stage-scoped external prune by recorded row that waits for the manifest sync, cron keys and orphans, env push, and exclusive manifest PUT claims (overlapping writes are refused with or without a revision; stale cleanup cannot release a newer claim).

- `tla/`: TLA+ specs of the CLI's concurrent loops, model-checked with TLC (every interleaving, bounded). Lean proves the pure state machines; TLA+ covers timing and async races Lean models do not express.
  - `DevWatch.tla`: the `broods dev` watch loop in `packages/broods/src/cli/index.ts` `dev()`. checks the stage holds the source whenever no sync is running or queued, unless the last one failed. It found two lost saves, now fixed: one made during the first sync, and one undone while a sync ran.
  - `StageTicket.tla`: `broods run`'s stage ticket in `run()`. checks no request sends an expired ticket with any interleaving of concurrent re-mints, given latency under the 60 s margin and a local clock within margin minus latency of the server's.
  - `EscFilter.tla`: `stopTurnOnEscape` in `packages/broods/src/cli/tui.ts`. checks an Esc read mid-turn only stops the turn, an arrow key split across reads stays one key, key order holds, and every held Esc settles, given a split key's halves arrive within the 30 ms wait.

## Rules

- `bun run verification:test` runs the TypeScript contract tests beside `lake build` in CI. These test implementation behavior and representative normalization round trips; they do not prove TypeScript equivalent to Lean. Models omit auth, admission, I/O and many product features.
- the model is hand-written from the TypeScript (TLA+ specs too; the header names the TS). change the mirrored code = update the model in the same PR. docstring on each def names the TS it mirrors.
- `example ... := by decide` blocks are findings: concrete inputs where the code does something surprising. fix the code = flip the example to the fixed outcome.
- no `sorry`, no `native_decide`, no new `axiom`, so every proof rests on `propext`, `Quot.sound`, `Classical.choice` only. `lake build` enforces it: the audit at the end of `Broods.lean` fails on any other axiom a `Broods` declaration rests on, `sorryAx` and `native_decide`'s included.

## Run

- install: `curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none`
- check: `lake build` in this folder. CI: `.github/workflows/lean-verification.yaml`.
- TLA+: `TLA_JAR=<tla2tools.jar> tla/check.sh` (Java 11+). CI runs it in the same workflow, TLC pinned by checksum.
