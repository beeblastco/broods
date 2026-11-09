# Writing and extending the Broods Lean specification

Follow this for a new subsystem and for any feature that changes one. `Spec/Workers/` and
`replay/workers.test.ts` are the worked example of a model with replay. `Spec/Agent/Twins/Continuation.lean`
is the worked example of a traced twin. Read them first and copy their shape.

## What a subsystem consists of

| File                       | Holds                                                                               | Rule                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Spec/<Sub>/Model.lean`    | The behaviour as computable Lean: state, inputs, effects, `step` or pure functions. | One-line docstring naming the TypeScript it describes. Runs with `#eval`. No proofs.                                 |
| `Spec/<Sub>/Proofs.lean`   | Invariants and lemmas, one input kind at a time.                                    | Anything goes as long as the kernel accepts it.                                                                      |
| `Spec/<Sub>/Theorems.lean` | The claims, stated in the shapes of `Spec/Statements.lean`.                         | Short statements a person can read. Proof bodies only call `Proofs`. Each needs a one-line docstring in plain words. |
| `Spec/<Sub>/Controls.lean` | A deliberately broken model, proved to fail a theorem.                              | One per major theorem. A theorem no broken model fails says nothing.                                                 |
| `Spec/<Sub>/Replay.lean`   | Prints vectors: inputs plus the model's outputs, one JSON object per line.          | Seeded and deterministic. Directed vectors for states random ones rarely reach.                                      |
| `Spec/<Sub>/All.lean`      | Imports every module of the subsystem.                                              |                                                                                                                      |
| `replay/<sub>.test.ts`     | Runs each vector against the real TypeScript and compares.                          | Imports real source. Never changes source files. No network.                                                         |
| `replay/suites/<sub>.ts`   | The suite's tests, env and injected faults.                                         | See "Faults" below.                                                                                                  |
| `manifest/<sub>.tsv`       | One row per source file, with its status.                                           | See "Manifest" below.                                                                                                |

## Twins

A twin is the Lean counterpart of one TypeScript function, in `Spec/<Sub>/Twins.lean` or files it
imports. `scripts/conform.ts` records the real function's calls while the repository's own tests run,
then checks every call against the twin. Recorded calls are real inputs, so this is the cheapest way
to cover a lot of logic, and the same calls can later grade a port.

- `.lake/conform/corpus/<url-encoded source>.jsonl` holds calls already recorded: one
  `{"fn", "args", "outcome"}` per line, where `outcome` is `{"returned": ...}` or `{"threw": message}`.
  Read a few before writing the twin. JSON rules apply: `undefined` is dropped from objects and becomes
  `null` in an array or as a result.
- A twin must compute its answer from its arguments and from effect answers, implementing the same logic as the function.
  Never embed recorded results, and never look a call up in a table of known inputs. A twin that
  memorises the corpus is worthless and worse than no twin.
- Reuse definitions in `Model.lean`, and put new logic in the twin's file as ordinary pure functions, so
  theorems can use it later.
- Use `Twin.unsupported` only for arguments the model really does not cover. A twin gets coverage credit
  only if at least 90% of its recorded calls are compared and none mismatches.
- A mismatch is a finding. Fix the twin if it is wrong. If the function is wrong per `DECISIONS.md`, set
  `gaps` on the twin to the `GAPS.md` id.
- First run `bun formal/scripts/conform.ts --all` once: recordings are not committed, so a fresh checkout has none and every twin comes back UNCHECKED. It takes about 15 minutes.
- A function no test reaches needs a test first. Put it in `replay/extra/<workspace>/` and record it with `conform.ts --record-extra=<workspace>`. Assert real behaviour there: these tests are also what the twin is graded on.
- Register a twin by adding it to its file's list and importing that file from `Spec/<Sub>/Twins.lean`. `Wave*` files are batches of twins from earlier work: a new file can have any name. `bun formal/scripts/worklist.ts` lists what to do next, callees first, so a twin's dependencies earn credit before it does.
- Then check with `bun formal/scripts/conform.ts --reuse --sub=<sub>`, which rebuilds the twins itself. If it prints STALE, source or tooling changed since recording, so it writes no results: run `--all` again.
- A twin's coverage credit lands only after a full `conform.ts --all` or `--reuse` followed by `bun formal/scripts/check.ts`.
- `bun formal/scripts/twin-controls.ts` must stay green: it damages recordings and injects source
  faults, and each must make the twin disagree.

### Traced twins

A function that talks to anything outside itself gets a traced twin: `Twin.traced source prog`. `prog`
is written in `Prog`, as the effects the function performs in order. `.lake/conform/traces/` holds one
line per call: `args`, `self`, `effects` (each with `fn`, `args`, `outcome`, `to`), `outcome`, `hits`.

- `Prog.effect "label" [args]` performs an effect and returns its value, or fails if it threw.
  `Prog.attempt` hands back the outcome instead. `Prog.all` starts overlapping effects together.
- The label is the call's source text with whitespace collapsed, such as `ctx.runQuery`. An effect's
  arguments and name are checked before its answer is released, so a twin can only read answers to
  questions it asked correctly.
- `call`/`Prog.effect` must be alone in time. Effects that overlapped in the recording need `Prog.all`.
- `Prog.attempt` returns `.pending` for an await the recording never saw settle, so a race can be modelled. `Prog.effect` fails on it.
- `Prog.spawn` starts an effect without waiting, for `void f()`. A plain effect still running when the function ended fails the comparison; a spawned one reads nothing from it.
- `Prog.setState path value` states a change the call made. A call that changed its receiver, module state or an argument, and whose twin does not state it, earns no credit. Paths are `self.x`, `module.cache`, and for arguments the changed leaf: `args.0.data.token`, or `args.1` for an array. A leaf needs no statement when its final value is what an effect on that object left (L18 says how this is decided). `Prog.setChanged` states a write only when it really changes the value, and each differing leaf when one object overwrites another.
- Errors are `{"$error":{"name","message","fields"}}`: use `Prog.throwError`. `undefined` is
  `Twin.undefinedJson`. Values the recorder cannot carry are `$`-tagged; see `record-preload.ts`.
- `Twin.callArg call i` and `Twin.self call` read the input. `Prog.unsupported "why"` opts out of a call.
- Calls to helpers declared inside the function are not effects: compute them in the twin.
- `Date.now`, `new Date()`, `Math.random` and `crypto.randomUUID` are effects. Logging is not.

What earns credit, per statement rather than per function:

- Only statements that ran in a call the twin matched. A branch no test took earns nothing.
- Every internal function the twin takes an answer from must itself be credited, or be listed in
  `boundaries.tsv` with a reason. So build leaves first.
- Every external effect label must match a `boundaries.tsv` regex, and every opaque class must be
  declared there, or the call does not count.
- A call with a value too big to record, or a late effect, is not compared.
- If a recording shows the call changed a field on its receiver or a module binding, the twin must state each change with `Prog.setState "self.field" value` or `"module.name"`, or it earns nothing.
- A callback runs inside the effect that called it, so `Prog.drain` comes before that effect's `Prog.effect`.
- A twin whose every call returned `undefined` with no effects earns nothing: there was nothing to be right about.
- A gap excuses only calls its `gapCovers` predicate names.
- Results are bound to a hash of the source, the Lean and the recording. Any change makes them stale.

External rules must be anchored, `^...$`, and a reason must say why the answer is outside the runtime. Do not list an internal function because it is hard to record: model it from its inputs. `boundaries.tsv` lines are `external<TAB>regex<TAB>reason`, `opaque<TAB>Class<TAB>reason`, or
`internal<TAB>path#name<TAB>reason`. The reason must say why the answer can be trusted here.
`exclusions.tsv` lines are `path#name` or `path#*`, a category, and a reason. Each excluded function
leaves the denominator and is listed in the report, so use it only for code with nothing to verify.

## Modelling rules

- Describe what the code does, except where `DECISIONS.md` says otherwise. Read the code. A doc or
  comment is a hint and can be stale.
- `Spec/` uses Lean core and `Std` only, on the pinned toolchain. No Mathlib.
- Forbidden in `Spec/`: `sorry`, `axiom`, `native_decide`, `partial` and `unsafe`. `Audit.lean` fails
  on them through the kernel, so a macro cannot hide one.
- Crashes, timeouts, duplicates, reordering, and attacker choices are inputs, never hidden state.
  A theorem over all input lists then covers them all.
- Keep exact evaluation order: first-match order is part of the behaviour.
- Use real constants from the code, and give the `path:line` in a docstring when not obvious.
- Prefer a total `step` that ignores wrong-phase inputs over a precondition. Ghost state is fine
  when a proof needs it, and the invariant must then tie it to the code's real variables.
- A hypothesis that a theorem assumes goes in `Spec/Assumptions.lean` if it concerns the outside
  world, with a plain-words reason. Otherwise it must be proved.
- External services are contracts: state what the code relies on, not their internals.

## Theorem rules

- Give each subsystem the three kinds where they apply: safety (`Always`, `Sound`), progress
  (`Progress`) and leakage (`Private`). Say so in the file's header if one does not apply.
- A claim false for today's code but required by `DECISIONS.md` is proved of the model, and the
  disagreement goes in `GAPS.md`. A claim false of the model is a finding: write the concrete
  counterexample as a Lean theorem in `Controls.lean`. Never weaken a claim silently to make it
  provable; narrow it openly and record what was given up in `LIMITS.md`.
- Prove non-vacuity for each main theorem: `NonVacuous`, or a concrete trace reaching the good case.

## Replay rules

- A vector that disagrees with TypeScript is a real finding. Do not edit either side to hide it.
  Decide which is right. If the model is wrong, fix the model. If the code is wrong, keep the model,
  add a `GAPS.md` entry, and use `test.failing` naming that entry in the title.
- `test.failing` passes only while the mismatch exists, so a fixed bug forces the entry's removal.
- A replay test with no vectors, or one that catches nothing, proves nothing.

## Faults

Each `replay/suites/<sub>.ts` lists faults injected into real source at load time. Each one is a
single plausible bug in a function the suite claims to cover. `scripts/controls.ts` requires a no-fault
baseline to pass, then replay to fail under every fault. A fault that survives means the vectors have
a hole: add a directed vector. If a fault truly cannot change behaviour, remove it and say why in the
suite's comment. Do not count a fault as caught unless tests ran and failed.

## Manifest

`manifest/<sub>.tsv` has one row per in-scope source file, tab-separated:
`path`, `class`, `status`, `lean`, `replay`, `note`.

- `class`: `decision` (decision or state logic), `protocol` (wire formats and parsers), `adapter` (thin
  wrapper over an external API), `glue` (wiring, logging, formatting, types). Correct a wrong class
  when you read the file.
- `status`: `replayed` (modelled in Lean and compared against TypeScript by replay), `modelled`
  (modelled in Lean, not replayed: the note says why), `contract` (an adapter or service: only what
  callers rely on is stated), `excluded` (glue: nothing to model), `open` (not done). The note gives
  a reason for every status but `replayed`.
- `lean`: the Lean module or definition. `replay`: the test file.

Be honest here: coverage itself counts statements (`scripts/check.ts`), but a file's status says what
kind of evidence it has, and a file marked `replayed` whose logic is not actually compared is worse
than one marked `open`.

## Adding a feature later

1. Change `Model.lean`. Lean's exhaustive `match` then breaks every proof the new input touches, which
   is the to-do list.
2. Repair `Proofs.lean`. Add a theorem if the feature promises something new.
3. Add a control for any new theorem, and a directed vector plus a fault for any new branch.
4. Update the manifest row, and add one for any new file. `scripts/check.ts` fails on an unlisted file.
5. Run `bun formal/scripts/check.ts`. If a statement changed, `STATEMENTS.txt` shows it for review.

## Commands

From `formal/`: `lake build Spec.<Sub>.All` builds one subsystem. `lake build` builds everything.
From the repository root: `bun test formal/replay/<sub>.test.ts` runs replay, and
`bun formal/scripts/check.ts` runs the audit, replay and coverage. `bun formal/scripts/conform.ts --all`
records and compares twins, and `bun formal/scripts/twin-controls.ts` shows they can fail. Run all three
before claiming a number.

`lake` lives in `~/.elan/bin`. Add it to `PATH` first. Build only your own subsystem's target while
others are working: Lake holds a lock on the shared build folder, so a build may wait for another.
