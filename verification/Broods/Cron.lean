/-!
# Cron runs

A `cronRuns` row under `createRun` and `settleRun` (behind `completeRun` /
`failRun`, `packages/convex/agent/crons.ts`), settled by core through
`settleCronRun` (the async worker, which leaves a paused run open) and the catch
in `startScheduledAgentRun` (`apps/core/src/harness/handler.ts`). A paused run is
settled by `settleAnsweredRun` from the turn that answered one of the approval or
question ids it waits on (`answeredRun`), and `sweepDeadRuns`
settles a run whose envelope ended without one; both are the same `settle` step.
A row is `none` once `removeRunsCascade` drained it with its one-time cron.

The cron row's `lastStatus` follows `lastRunId`, the run of the latest fire by
scheduled time (`lastInvokedAt`). `createRun` takes the cron only for a fire at
least as late as the one it shows, `settleRun` writes the status only for the run
the cron names, and `recordFailedFire` (a fire refused before it had a run row)
writes `failed` and detaches the run, again only for a fire at least as late. An
older fire, however late its writes land, never takes the status back.
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

/-- The cron row's `lastRunId`, `lastStatus` and `lastInvokedAt`. -/
structure CronRow where
  lastRunId : Option Nat
  lastStatus : Option Status
  lastFired : Option Nat
  deriving DecidableEq, Repr

/-- Every `cronRuns` row of one cron, by run id, and the cron row. -/
structure State where
  runs : Nat → Option Status
  cron : CronRow

/-- One write to a cron: `createRun` opens run `r` for a fire scheduled at `t`,
`completeRun` / `failRun` settle it, or `recordFailedFire` records a fire at `t`
with no run row. -/
inductive Step where
  | start (r t : Nat)
  | settle (r : Nat) (x : Settle)
  | refuse (t : Nat)

/-- The run table with run `r` set to `v`. -/
def update (runs : Nat → Option Status) (r : Nat) (v : Option Status) :
    Nat → Option Status :=
  fun r' => if r' = r then v else runs r'

/-- `isLatestFire`: a fire at `t` is at least as late as the one the cron shows. -/
def latest (c : CronRow) (t : Nat) : Bool :=
  c.lastFired.all (· ≤ t)

/-- One write. `createRun` inserts a fresh run id. A settle that changes its run
also changes the cron, but only while that run is the cron's last. -/
def step (s : State) : Step → State
  | .start r t =>
    if s.runs r = none then
      ⟨update s.runs r (some .started),
        if latest s.cron t then ⟨some r, some .started, some t⟩ else s.cron⟩
    else s
  | .settle r x =>
    if s.runs r = some .started then
      ⟨update s.runs r (settle (s.runs r) x),
        if s.cron.lastRunId = some r then { s.cron with lastStatus := some x.status }
        else s.cron⟩
    else s
  | .refuse t => if latest s.cron t then ⟨s.runs, ⟨none, some .failed, some t⟩⟩ else s

/-- Writes in the order Convex commits them. -/
def run (s : State) (steps : List Step) : State :=
  steps.foldl step s

/-- The cron shows the status of the run it names, and that run exists. -/
def Mirrors (s : State) : Prop :=
  ∀ r, s.cron.lastRunId = some r → s.cron.lastStatus = s.runs r ∧ s.runs r ≠ none

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

/-- A fire older than the one the cron shows leaves the cron alone, whether it
opens a run or is refused. -/
theorem older_fire_noop (s : State) (r t t' : Nat) (hf : s.cron.lastFired = some t')
    (ht : t < t') :
    (step s (.start r t)).cron = s.cron ∧ (step s (.refuse t)).cron = s.cron := by
  have hl : latest s.cron t = false := by
    simp only [latest, hf, Option.all_some, decide_eq_false_iff_not, Nat.not_le]
    exact ht
  constructor
  · by_cases hn : s.runs r = none
    · simp [step, hn, hl]
    · simp [step, hn]
  · simp [step, hl]

/-- Every write keeps the cron showing its last run's status. -/
theorem step_mirrors (s : State) (t : Step) (h : Mirrors s) : Mirrors (step s t) := by
  intro r' hr
  cases t with
  | start r t =>
    by_cases hn : s.runs r = none
    · by_cases hl : latest s.cron t
      · simp only [step, hn, hl, ite_true, Option.some.injEq] at hr ⊢
        subst hr
        simp [update]
      · simp only [step, hn, hl, ite_true] at hr ⊢
        have hne : r' ≠ r := by
          intro heq
          exact (h r' hr).2 (heq ▸ hn)
        simp [update, hne, h r' hr]
    · simp only [step, hn, ite_false] at hr ⊢
      exact h r' hr
  | settle r x =>
    by_cases hs : s.runs r = some .started
    · by_cases hl : s.cron.lastRunId = some r
      · simp only [step, hs, hl, ite_true, Option.some.injEq] at hr ⊢
        subst hr
        simp [update, settle]
      · simp only [step, hs, hl, ite_true, ite_false] at hr ⊢
        have hne : r' ≠ r := by
          intro heq
          exact hl (heq ▸ hr)
        simp [update, hne, h r' hr]
    · simp only [step, hs, ite_false] at hr ⊢
      exact h r' hr
  | refuse t =>
    by_cases hl : latest s.cron t
    · simp [step, hl] at hr
    · simp only [step, hl] at hr ⊢
      exact h r' hr

/-- Whatever order the writes commit in, the cron shows the status of the run
it names. -/
theorem run_mirrors (s : State) (ts : List Step) (h : Mirrors s) :
    Mirrors (run s ts) := by
  induction ts generalizing s with
  | nil => exact h
  | cons t ts ih => exact ih (step s t) (step_mirrors s t h)

/-- A started run of one conversation and the prompt ids it waits on (`waitingOn`),
`none` on a row created before the field existed. -/
structure Paused where
  run : Nat
  waitingOn : Option (List Nat)

/-- `settleAnsweredRun` with `runWaitingOn`: of the conversation's started runs, newest
first, one that waits on an id the answering turn names (`cronRunWaits`, any age);
else the newest started run, only when it predates `waitingOn`. -/
def answeredRun (started : List Paused) (answered : List Nat) : Option Nat :=
  match started.find? (fun p => (p.waitingOn.getD []).any (fun id => answered.contains id)) with
  | some p => some p.run
  | none =>
    match started.head? with
    | some ⟨r, none⟩ => some r
    | _ => none

/-- An answer settles only a run that waits on what it answers, or one from before
`waitingOn`: never a newer run that waits on something else or has not paused. -/
theorem answered_run_asked (started : List Paused) (answered : List Nat) (r : Nat)
    (h : answeredRun started answered = some r) :
    ∃ p ∈ started, p.run = r ∧
      ((∃ id ∈ p.waitingOn.getD [], id ∈ answered) ∨ p.waitingOn = none) := by
  unfold answeredRun at h
  cases hf : started.find? (fun p => (p.waitingOn.getD []).any (fun id => answered.contains id)) with
  | some p =>
    rw [hf] at h
    simp only [Option.some.injEq] at h
    have hp := List.find?_some hf
    simp only [List.any_eq_true, List.contains_iff_mem] at hp
    exact ⟨p, List.mem_of_find?_eq_some hf, h, Or.inl hp⟩
  | none =>
    rw [hf] at h
    cases started with
    | nil => cases h
    | cons q qs =>
      obtain ⟨run, waits⟩ := q
      cases waits with
      | none =>
        simp only [List.head?_cons, Option.some.injEq] at h
        exact ⟨⟨run, none⟩, List.mem_cons_self, h, Or.inr rfl⟩
      | some ws => simp at h

/-! ## Witnesses -/

/-- Fire 1 waits on approval 10, fire 2 (newer) on approval 20. Answering 10
settles fire 1; settling the newest started run, as it once did, hit fire 2. -/
example : answeredRun [⟨2, some [20]⟩, ⟨1, some [10]⟩] [10] = some 1 := by decide
example : ([⟨2, some [20]⟩, ⟨1, some [10]⟩] : List Paused).head?.map (·.run) = some 2 := by
  decide

/-- An answer no started run waits on settles nothing, not even a fire still running. -/
example : answeredRun [⟨3, some []⟩, ⟨2, some [20]⟩, ⟨1, some [10]⟩] [30] = none := by decide

/-- A run paused before `waitingOn` existed still ends by the answer, as it once did. -/
example : answeredRun [⟨1, none⟩] [10] = some 1 := by decide

/-- No run yet. -/
def fresh : State := ⟨fun _ => none, ⟨none, none, none⟩⟩

/-- Fire 1 is slow, fire 2 starts and completes, then fire 1 fails because
fire 2 holds the conversation: the cron still shows fire 2's `completed`. -/
example :
    (run fresh [.start 1 1000, .start 2 2000, .settle 2 .complete, .settle 1 .fail]).cron =
      ⟨some 2, some .completed, some 2000⟩ := by decide

/-- A newer fire's refusal survives the older run settling after it. -/
example : (run fresh [.start 1 1000, .refuse 2000, .settle 1 .complete]).cron =
    ⟨none, some .failed, some 2000⟩ := by decide

/-- An older fire refused late leaves the newer run on the cron. -/
example : (run fresh [.start 2 2000, .refuse 1000, .settle 2 .complete]).cron =
    ⟨some 2, some .completed, some 2000⟩ := by decide

/-- The worker records `completed`, then `invokeAsyncWorker` throws in
`startScheduledAgentRun` and its catch sends `failRun`: the run stays completed. -/
example : settleAll (some .started) [.complete, .fail] = some .completed := by decide

end Broods.Cron
