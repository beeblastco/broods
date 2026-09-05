# Performance suite

Deterministic benchmarks over the paths that run per request, per turn, or per
streamed line, plus what a developer waits on every time they use the CLI. No
network, no model call, no clock a case does not control. The whole suite runs
in about thirty seconds; the CPU-only half in five.

## Commands

```
bun run bench                  # measure and print
bun run bench --only core/     # one slice, while iterating on a case
bun run bench:check            # grade against baselines.json, exit 1 on a blocking regression (CI)
bun run bench:record           # overwrite baselines.json from a fresh run (never from CI)
bun run bench:test             # the gate's own grading rules
bun bench/bundles.ts --check dashboard|cli   # payload budgets, run where each is built
```

## What is measured

- **gateway/** path classification, WebSocket path match, rate limit. Every
  public request.
- **core/server-** route to a handler, lower a Web Request. Every request core
  receives.
- **core/bearer-, timing-safe-** the bearer auth every request runs.
- **core/config-** normalize, encrypt and decrypt round trip, env ref
  injection. Every agent load and every `broods dev` sync.
- **core/log-** the redaction chokepoint every log line passes through.
- **core/runner-frame-** the NDJSON protocol every line of uploaded code
  output passes through.
- **core/session-prune-** per-turn pruning at two history sizes; the pair
  catches superlinear growth.
- **core/isolate-** the V8 isolate tier for hooks: cold is a fresh Node runner,
  warm is the pooled default. Needs `BROODS_TEST_ISOLATE_RUNNER_PATH`, else
  skipped.
- **core/agent-run-** the agent loop end to end through the real harness,
  provider and tool registry: first token, a text turn, a turn with a tool
  call. The model is answered in-process at `globalThis.fetch`.
- **convex/api-authorize-** the config-plane authorization decision.
- **convex/ingress-, session-, conversation-** the functions core calls each
  turn, run in memory through convex-test. Informational: the harness costs
  more than the functions.
- **cli/compile-** a cold compile of `bench/fixtures/project` in a fresh
  process, and the cached in-process compile. **cli/startup-** `--version`
  under Node and Bun against the built dist; skipped without a build.

## Two gates per case

- **Ceiling** (`ceilingNs`). An absolute product threshold, roughly 10x the
  laptop number for a CPU case and a wall-clock budget for a spawn. It holds on
  any machine fit to serve traffic, so it blocks everywhere from the first run.
  Only a catastrophe trips it.
- **Drift** (`nsPerOp` plus `maxRegressionPct`, default 30%, 50% on spawns).
  Judged against the run's machine ratio, the median of measured/baseline
  across every gated case: a slower host in the same runner pool moves every
  case by about the same factor, and that factor is subtracted before any case
  is graded. A code regression moves one path and still stands out. A case
  counts as slower only when it is slower by both the raw and the adjusted
  clock, since a host far from the baseline's does not move every path by the
  same factor. Blocks only when the run's `platform/arch` match the
  baseline's, since a different arch shifts the paths unevenly and the ratio
  cannot cancel that.

A case whose own spread exceeds `noiseCeilingPct` reports as `NOISY` and never
fails on drift; it still fails the ceiling when even its fastest sample is over
it. Widen the case's sample, do not widen its threshold. A case whose runtime
is missing reports as `SKIPPED` and keeps its baseline. A baseline whose case
no longer exists fails the check until a `--record` drops it, so a case cannot
be renamed or deleted around its own regression.

The machine ratio is a median, so it absorbs a change that moves more than half
the suite the same way. Only the ceilings catch that; keep them honest.

## Baseline policy

- `baselines.json` is committed and reviewed. CI never writes it.
- `--record` carries each case's existing `gate`, `ceilingNs` and
  `maxRegressionPct` forward, so re-recording a number never quietly relaxes the
  policy that was reviewed with it. Change those fields by hand, in a commit
  that says why.
- One file, one machine. The numbers should come from the CI runner class
  (linux/x64, GitHub `ubuntu-24.04`), so drift blocks in CI and only reports
  on a laptop. Every CI run uploads a `benchmark-<run id>` artifact containing
  the runner's fresh `baselines.json`, built from the same numbers the check
  graded; adopt it from there rather than recording locally. Never mix a laptop number into a runner file: the machine
  ratio is a median and a mixed file bends it.
- A `FASTER` result is a prompt to re-record, so the next regression is measured
  against the gain rather than the old number.
- `bundle-budgets.json` follows the same rules for payload sizes, with a 10%
  growth allowance and a 1.5x ceiling.

## Adding a case

A case belongs here only if it is on a path that executes per request, per
turn, or per streamed line, or is something a developer waits on. Give it a
fixed input mix, control anything it reads from the environment in
`setup`/`teardown`, and tune `iterations` so one sample lands near 5 ms; a
spawn sets `samples` low instead. Run `bench:record`, then set its `gate` and
`ceilingNs` by hand before committing.
