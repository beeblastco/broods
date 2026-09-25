# verification

Lean 4 models of broods contracts, with machine-checked proofs. Not a Bun workspace. No Mathlib, core Lean only.

- `Broods/Gateway.lean`: `apps/gateway/src/routes.ts` + `route()` in `main.ts`. proves internal core paths are 404 for every method, and routing ignores trailing slashes.
- `Broods/Ingress.lean`: `packages/convex/runtimeIngress.ts` envelope lifecycle. proves terminal runs stay terminal, every step moves forward, settle is fenced, `/stop` hits only its generation, `maintain` never expires a run its owner still holds.
- `Broods/AsyncResults.lean`: the async result row, settled with its envelope in one `runtimeIngress.settle`, plus `runtimeAsyncToolResults`. proves envelope and result row agree at every throw point, including a callback throw the harness swallows, a recorded outcome survives later throws, a failed write never loses what the run produced, a tool row settles once.
- `Broods/Cron.lean`: `packages/convex/agent/crons.ts` run rows. proves the first settle wins and a drained run settles as a no-op.
- `Broods/Sync.lean`: `broods dev` / `deploy` manifest sync with server rename matching. proves the next diff after a sync is deletes only, empty after prune; outright for skill/hook/mcp, given `normalize` round-trips for the rest.
- `Broods/SyncExternal.lean`, `SyncCron.lean`, `SyncEnv.lean`, `SyncConcurrency.lean`: stage-scoped external prune by recorded row that waits for the manifest sync, cron keys, legacy-name renames and orphans, env push, and interleaved PUTs (last writer per row group wins; mixed stage witnessed).

## Rules

- the model is hand-written from the TypeScript. change the mirrored code = update the model in the same PR. docstring on each def names the TS it mirrors.
- `example ... := by decide` blocks are findings: concrete inputs where the code does something surprising. fix the code = flip the example to the fixed outcome.
- no `sorry`, no `native_decide`, no new `axiom`, so every proof rests on `propext`, `Quot.sound`, `Classical.choice` only. `lake build` enforces it: the audit at the end of `Broods.lean` fails on any other axiom a `Broods` declaration rests on, `sorryAx` and `native_decide`'s included.

## Run

- install: `curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none`
- check: `lake build` in this folder. CI: `.github/workflows/lean-verification.yaml`.
