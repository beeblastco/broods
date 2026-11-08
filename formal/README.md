# A Lean specification of the Broods runtime

A second, independent model of what the runtime does, written to guide a rewrite in Rust or another
language. `verification/` is a separate library and was not read while writing this one.

## How to read it

Read these in order. Nothing else is needed to learn what is claimed.

1. `DECISIONS.md`: what the owner decided the runtime should do.
2. `Spec/Statements.lean` and `Spec/Assumptions.lean`: the properties, and what they take as given.
3. `Spec/Top.lean`: the main theorems.
4. `Spec/<Sub>/Theorems.lean`: each subsystem's claims. `STATEMENTS.txt` has them as the kernel holds them.
5. `LIMITS.md` and `GAPS.md`: what is not said, and where today's code disagrees with the model.

## How the parts fit

- **Lean proves properties of the model.** The kernel checks these, and `Audit.lean` confirms no proof
  rests on `sorry` or a new axiom.
- **Replay ties the model to the code.** Generated vectors run through both the Lean model and the real
  TypeScript, and any difference is a failure. It is a test, not a proof, and the same vectors can
  later grade a port.
- **Controls test the tests.** Kernel-checked controls prove a broken model fails a theorem. Injected
  faults check that replay notices a broken implementation.
- **The manifest measures coverage.** Each in-scope source file has a row saying what covers it.

## Commands

From the repository root, with `~/.elan/bin` on `PATH`:

| Command                                      | Does                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `bun formal/scripts/check.ts`                | Every check, then the coverage table                                         |
| `bun formal/scripts/controls.ts [subsystem]` | Injected faults only                                                         |
| `bun test formal/replay/<sub>.test.ts`       | Replay for one subsystem; check `replay/suites/<sub>.ts` for its environment |

`AUTHORING.md` says how to write a subsystem and how to extend the library for a new feature.
