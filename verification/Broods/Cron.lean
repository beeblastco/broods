/-!
# Cron runs

A `cronRuns` row under `createRun` / `completeRun` / `failRun`
(`packages/convex/agent/crons.ts`), settled by core through `settleCronRun`
(the async worker) and the catch in `startScheduledAgentRun`
(`apps/core/src/harness/handler.ts`), plus the per-job `crons.lastStatus` that
`recordInvocation` writes around each fire.
-/

namespace Broods.Cron

/-- `cronRuns.status` and `crons.lastStatus`. -/
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

/-- `completeRun` / `failRun` on a started row. `guarded` is the `status ===
"started"` check; `false` is the pre-fix code without it. -/
def settle (guarded : Bool) (s : Status) (x : Settle) : Status :=
  if guarded && s != .started then s else x.status

/-- Every settle a run receives, in order. -/
def settleAll (guarded : Bool) (s : Status) (xs : List Settle) : Status :=
  xs.foldl (settle guarded) s

/-- `recordInvocation`: the job's latest write wins, whichever fire sent it. -/
def recordInvocation (_last : Status) (s : Status) : Status := s

/-! ## Properties -/

/-- A run settles once: its first settle decides the outcome for good. -/
theorem settle_once (x : Settle) (xs : List Settle) :
    settleAll true .started (x :: xs) = x.status := by
  simp only [settleAll, List.foldl_cons]
  have hx : settle true .started x = x.status := by cases x <;> rfl
  rw [hx]
  induction xs with
  | nil => rfl
  | cons y ys ih =>
    simp only [List.foldl_cons]
    have hy : settle true x.status y = x.status := by cases x <;> cases y <;> rfl
    rw [hy, ih]

/-! ## Regression witnesses -/

/-- Before the guard: the worker records `completed`, then `invokeAsyncWorker`
throws in `startScheduledAgentRun` and its catch rewrites the run to `failed`. -/
example : settleAll false .started [.complete, .fail] = .failed := by decide

/-- With the guard the run keeps its first outcome. -/
example : settleAll true .started [.complete, .fail] = .completed := by decide

/-- `lastStatus` has no invocation id, so two overlapping fires interleave: the first
fire's `completed` lands while the second is still running. Reported, not fixed. -/
example :
    recordInvocation (recordInvocation (recordInvocation .completed .started) .started)
      .completed = .completed := by
  decide

end Broods.Cron
