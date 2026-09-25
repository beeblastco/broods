/-!
# Cron runs

A `cronRuns` row under `createRun` and `settleRun` (behind `completeRun` /
`failRun`, `packages/convex/agent/crons.ts`), settled by core through
`settleCronRun` (the async worker) and the catch in `startScheduledAgentRun`
(`apps/core/src/harness/handler.ts`). A row is `none` once `removeRunsCascade`
drained it with its one-time cron.

`crons.lastStatus` is not modelled: `recordInvocation` has no invocation id, so two
overlapping fires can interleave their writes. Reported, not fixed.
-/

namespace Broods.Cron

/-- `cronRuns.status`. -/
inductive Status where
  | started | completed | failed
  deriving DecidableEq, Repr

/-- A settle core sends for one run. -/
inductive Settle where
  | complete | fail
  deriving DecidableEq, Repr

/-- The `cronRuns.status` a settle writes: `completeRun` or `failRun`. -/
def Settle.status : Settle → Status
  | .complete => .completed
  | .fail => .failed

/-- `settleRun`: a drained row and a row already settled are left alone. -/
def settle (row : Option Status) (x : Settle) : Option Status :=
  match row with
  | some .started => some x.status
  | _ => row

/-- Every settle a run receives, in order. -/
def settleAll (row : Option Status) (xs : List Settle) : Option Status :=
  xs.foldl settle row

/-! ## Properties -/

/-- A run settles once: its first settle decides the outcome for good. -/
theorem settle_once (x : Settle) (xs : List Settle) :
    settleAll (some .started) (x :: xs) = some x.status := by
  simp only [settleAll, List.foldl_cons, settle]
  induction xs with
  | nil => rfl
  | cons y ys ih =>
    simp only [List.foldl_cons]
    have hy : settle (some x.status) y = some x.status := by cases x <;> rfl
    rw [hy, ih]

/-- Settling a drained run writes nothing and does not fail. -/
theorem settle_drained (xs : List Settle) : settleAll none xs = none := by
  induction xs with
  | nil => rfl
  | cons x xs ih => simpa [settleAll, settle] using ih

/-! ## Witnesses -/

/-- The worker records `completed`, then `invokeAsyncWorker` throws in
`startScheduledAgentRun` and its catch sends `failRun`: the run stays completed. -/
example : settleAll (some .started) [.complete, .fail] = some .completed := by decide

end Broods.Cron
