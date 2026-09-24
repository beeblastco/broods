# verification

Lean 4 models of broods contracts, with machine-checked proofs. Not a Bun workspace. No Mathlib, core Lean only.

- `Broods/Gateway.lean`: `apps/gateway/src/routes.ts` + `route()` in `main.ts`. proves internal core paths are 404 for every method.
- `Broods/Ingress.lean`: `packages/convex/runtimeIngress.ts` envelope lifecycle + the async result row from `handleAsyncWorkerRequest`. proves terminal runs stay terminal, every step moves forward, settle is fenced, `/stop` hits only its generation.
- `Broods/Sync.lean`: `broods dev` / `deploy` manifest sync. proves the next diff after a sync is deletes only, empty after prune, given the server reads back what it stored.

## Rules

- the model is hand-written from the TypeScript. change the mirrored code = update the model in the same PR. docstring on each def names the TS it mirrors.
- `example ... := by decide` blocks are findings: concrete inputs where the code does something surprising. fix the code = flip the example to the fixed outcome.
- no `sorry`, no `native_decide`, no new `axiom`. `#print axioms` must stay at `propext`, `Quot.sound`, `Classical.choice`.

## Run

- install: `curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none`
- check: `lake build` in this folder. CI: `.github/workflows/lean-verification.yaml`.
