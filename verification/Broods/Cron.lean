/-!
# Cron runs

A `cronRuns` row under `createRun` and `settleRun` (behind `completeRun` /
`failRun`, `packages/convex/agent/crons.ts`), settled by core through
`settleCronRun` (the async worker) and the catch in `startScheduledAgentRun`
(`apps/core/src/harness/handler.ts`). A row is `none` once `removeRunsCascade`
drained it with its one-time cron.

The cron row's `lastStatus` follows `lastRunId`, the run `createRun` opened last.
`settleRun` writes it only for that run, and `recordFailedFire` (a fire refused
before it had a run row) writes `failed` and detaches it, so an older fire that
settles late cannot overwrite a newer one.
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

/-- The cron row's `lastRunId` and `lastStatus`. -/
structure CronRow where
  lastRunId : Option Nat
  lastStatus : Option Status
  deriving DecidableEq, Repr

/-- Every `cronRuns` row of one cron, by run id, and the cron row. -/
structure State where
  runs : Nat → Option Status
  cron : CronRow

/-- One write to a cron: `createRun` opens run `r`, `completeRun` / `failRun`
settle it, or `recordFailedFire` records a fire with no run row. -/
inductive Step where
  | start (r : Nat)
  | settle (r : Nat) (x : Settle)
  | refuse

/-- The run table with run `r` set to `v`. -/
def update (runs : Nat → Option Status) (r : Nat) (v : Option Status) :
    Nat → Option Status :=
  fun r' => if r' = r then v else runs r'

/-- One write. A settle that changes its run also changes the cron, but only
while that run is the cron's last. -/
def step (s : State) : Step → State
  | .start r => ⟨update s.runs r (some .started), ⟨some r, some .started⟩⟩
  | .settle r x =>
    if s.runs r = some .started then
      ⟨update s.runs r (settle (s.runs r) x),
        if s.cron.lastRunId = some r then ⟨some r, some x.status⟩ else s.cron⟩
    else s
  | .refuse => ⟨s.runs, ⟨none, some .failed⟩⟩

/-- Writes in the order Convex commits them. -/
def run (s : State) (steps : List Step) : State :=
  steps.foldl step s

/-- The cron shows the status of the run it names. -/
def Mirrors (s : State) : Prop :=
  ∀ r, s.cron.lastRunId = some r → s.cron.lastStatus = s.runs r

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

/-- A settle for a run that is not the cron's last leaves the cron alone. -/
theorem stale_settle_noop (s : State) (r : Nat) (x : Settle)
    (h : s.cron.lastRunId ≠ some r) : (step s (.settle r x)).cron = s.cron := by
  by_cases hs : s.runs r = some .started
  · simp [step, hs, h]
  · simp [step, hs]

/-- Every write keeps the cron showing its last run's status. -/
theorem step_mirrors (s : State) (t : Step) (h : Mirrors s) : Mirrors (step s t) := by
  intro r' hr
  cases t with
  | start r =>
    simp only [step, Option.some.injEq] at hr
    subst hr
    simp [step, update]
  | settle r x =>
    simp only [step] at hr ⊢
    by_cases hs : s.runs r = some .started
    · simp only [hs, ite_true] at hr ⊢
      by_cases hl : s.cron.lastRunId = some r
      · simp only [hl, ite_true, Option.some.injEq] at hr ⊢
        subst hr
        simp [update, settle]
      · simp only [hl, ite_false] at hr ⊢
        have hne : r' ≠ r := by
          intro heq
          exact hl (heq ▸ hr)
        simp [update, hne, h r' hr]
    · simp only [hs, ite_false] at hr ⊢
      exact h r' hr
  | refuse => simp [step] at hr

/-- Whatever order the settles arrive in, the cron shows the status of the
run it names. -/
theorem run_mirrors (s : State) (ts : List Step) (h : Mirrors s) :
    Mirrors (run s ts) := by
  induction ts generalizing s with
  | nil => exact h
  | cons t ts ih => exact ih (step s t) (step_mirrors s t h)

/-! ## Witnesses -/

/-- No run yet. -/
def fresh : State := ⟨fun _ => none, ⟨none, none⟩⟩

/-- Fire 1 is slow, fire 2 starts and completes, then fire 1 fails because
fire 2 holds the conversation: the cron still shows fire 2's `completed`. -/
example :
    (run fresh [.start 1, .start 2, .settle 2 .complete, .settle 1 .fail]).cron =
      ⟨some 2, some .completed⟩ := by decide

/-- A refused fire's `failed` survives a run that settles after it. -/
example : (run fresh [.start 1, .refuse, .settle 1 .complete]).cron = ⟨none, some .failed⟩ := by
  decide

/-- The worker records `completed`, then `invokeAsyncWorker` throws in
`startScheduledAgentRun` and its catch sends `failRun`: the run stays completed. -/
example : settleAll (some .started) [.complete, .fail] = some .completed := by decide

end Broods.Cron
