# Performance suite

Deterministic CPU-only benchmarks over the paths that run per request, per
turn, or per streamed line. No network, no filesystem, no model call. The whole
suite runs in about five seconds.

## Commands

```
bun run bench          # measure and print
bun run bench:check    # measure, grade against baselines.json, exit 1 on a blocking regression (CI)
bun run bench:record   # overwrite baselines.json from a fresh run (never from CI)
bun run bench:test     # the gate's own grading rules
```

## Two gates per case

- **Ceiling** (`ceilingNs`). An absolute product threshold, roughly 10x the
  laptop number. It holds on any machine fit to serve traffic, so it blocks
  everywhere from the first run. Only a catastrophe trips it.
- **Drift** (`nsPerOp` plus `maxRegressionPct`, default 30%). Judged against
  the run's machine ratio, the median of measured/baseline across every gated
  case: a slower host in the same runner pool moves every case by about the
  same factor, and that factor is subtracted before any case is graded. A code
  regression moves one path and still stands out. Blocks only when the run's
  `platform/arch` match the baseline's, since a different arch shifts the paths
  unevenly and the ratio cannot cancel that.

A case whose own spread exceeds `noiseCeilingPct` reports as `NOISY` and never
fails. Widen the case's sample, do not widen its threshold.

## Baseline policy

- `baselines.json` is committed and reviewed. CI never writes it.
- `--record` carries each case's existing `gate`, `ceilingNs` and
  `maxRegressionPct` forward, so re-recording a number never quietly relaxes the
  policy that was reviewed with it. Change those fields by hand, in a commit
  that says why.
- The numbers are recorded on the CI runner class (linux/x64, GitHub
  `ubuntu-24.04`), so drift blocks in CI and only reports on a laptop. Every CI
  run uploads a `benchmark-<run id>` artifact containing the runner's fresh
  `baselines.json`; adopt it from there rather than recording locally.
- A `FASTER` result is a prompt to re-record, so the next regression is measured
  against the gain rather than the old number.

## Adding a case

A case belongs here only if it is on a path that executes per request, per
turn, or per streamed line. Give it a fixed input mix, control anything it reads
from the environment in `setup`/`teardown`, and tune `iterations` so one sample
lands near 5 ms. Run `bench:record`, then set its `gate` and `ceilingNs` by
hand before committing.
