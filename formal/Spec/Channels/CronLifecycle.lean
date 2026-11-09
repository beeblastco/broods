/-!
The cron run lifecycle in `packages/convex/agent/crons.ts`, `packages/convex/runtimeIngress.ts` and
`settleCronRun` in `apps/core/src/harness/handler.ts`: how a started run ends.
-/

namespace Spec.Channels.CronLifecycle

abbrev Time := Nat

/-- The time limits, as parameters so the theorems hold for any values. -/
structure Limits where
  /-- How long after its envelope ended a run may still settle itself. -/
  deadRunGrace : Nat
  expiredRunGrace : Nat
  /-- How long a run waits on a person. -/
  pausedRunMaxAge : Nat
  /-- For a run with no ingress id to look up. -/
  untrackedRunMaxAge : Nat

/-- `DEAD_RUN_GRACE_MS`, `EXPIRED_RUN_GRACE_MS`, `PAUSED_RUN_MAX_AGE_MS`, `UNTRACKED_RUN_MAX_AGE_MS`. -/
def limits : Limits :=
  { deadRunGrace := 5 * 60 * 1000
    expiredRunGrace := 60 * 60 * 1000
    pausedRunMaxAge := 7 * 24 * 60 * 60 * 1000
    untrackedRunMaxAge := 24 * 60 * 60 * 1000 }

inductive EnvelopeStatus where
  | active
  | completed
  | failed
  | expired
  deriving DecidableEq, Repr

/-- What the polling row says about a completed envelope. -/
inductive Polling where
  | waitsOnPerson
  | settled
  deriving DecidableEq, Repr

structure Envelope where
  status : EnvelopeStatus
  updatedAt : Time
  polling : Polling
  deriving DecidableEq, Repr

inductive RunStatus where
  | started
  | completed
  | failed
  deriving DecidableEq, Repr

structure Run where
  id : Nat
  job : Nat
  conversation : Nat
  startedAt : Time
  tracked : Bool
  /-- Fixed when the run fires, so a later reschedule does not reach it. -/
  oneShot : Bool
  status : RunStatus
  deriving DecidableEq, Repr

/-- What the sweep decides. -/
inductive Verdict where
  | wait
  | finished
  | failedDead
  | failedUnanswered
  | failedEnvelope
  deriving DecidableEq, Repr

/-- `deadRunOutcome`. `envelope` is `none` when no row has that id. Envelope statuses before
`completed`, `failed` and `expired` are all `active`. -/
def deadRunOutcome (l : Limits) (run : Run) (envelope : Option Envelope) (now : Time) : Verdict :=
  if !run.tracked then
    if run.startedAt + l.untrackedRunMaxAge < now then .failedDead else .wait
  else
    match envelope with
    | none => .failedDead
    | some e =>
      match e.status with
      | .completed =>
        match e.polling with
        | .waitsOnPerson =>
          if run.startedAt + l.pausedRunMaxAge < now then .failedUnanswered else .wait
        | .settled => if e.updatedAt + l.deadRunGrace < now then .finished else .wait
      | .failed => if e.updatedAt + l.deadRunGrace < now then .failedEnvelope else .wait
      | .expired => if e.updatedAt + l.expiredRunGrace < now then .failedDead else .wait
      | .active => .wait

/-- A verdict's name, for replay. -/
def Verdict.name : Verdict → String
  | .wait => "wait"
  | .finished => "finished"
  | .failedDead => "failedDead"
  | .failedUnanswered => "failedUnanswered"
  | .failedEnvelope => "failedEnvelope"

/-- Whether a verdict shows the run as failed. -/
def Verdict.isFailure : Verdict → Bool
  | .failedDead | .failedUnanswered | .failedEnvelope => true
  | .wait | .finished => false

structure Job where
  id : Nat
  /-- Whether the job's current schedule fires once. -/
  oneShot : Bool
  deriving DecidableEq, Repr

structure State where
  runs : List Run
  jobs : List Job
  deriving DecidableEq, Repr

/-- `settleRun`: only a started run changes, so the first outcome stands. -/
def settleRun (status : RunStatus) (id : Nat) (runs : List Run) : List Run :=
  runs.map fun run =>
    if run.id == id && run.status == .started then { run with status := status } else run

/-- `finishRun`: settles the run and retires a job the run was fired as a one-shot of. -/
def finishRun (status : RunStatus) (run : Run) (s : State) : State :=
  { runs := settleRun status run.id s.runs
    jobs := if run.oneShot then s.jobs.filter (·.id != run.job) else s.jobs }

/-- What a turn reported to `settleCronRun`. -/
inductive TurnOutcome where
  | completed
  | failed
  | awaitingApproval
  | awaitingInput
  deriving DecidableEq, Repr

/-- `settleCronRun`: a paused turn leaves the run started. -/
def settleCronRun (outcome : TurnOutcome) (run : Run) (s : State) : State :=
  match outcome with
  | .completed => finishRun .completed run s
  | .failed => finishRun .failed run s
  | .awaitingApproval | .awaitingInput => s

/-- The newest started run of a conversation, as the `by_ingressConversationKey_and_status` lookup
in `settleAnsweredRun` finds it. Later rows are newer. -/
def newestStarted (conversation : Nat) (runs : List Run) : Option Run :=
  (runs.filter fun run => run.conversation == conversation && run.status == .started).getLast?

/-- `settleAnsweredRun`: scheduled when a turn that answers a prompt finishes. -/
def settleAnsweredRun (conversation : Nat) (status : RunStatus) (s : State) : State :=
  match newestStarted conversation s.runs with
  | some run => finishRun status run s
  | none => s

/-- The `update` mutation changing a job's schedule, while any run it fired stays as it was. -/
def reschedule (job : Nat) (oneShot : Bool) (s : State) : State :=
  { s with jobs := s.jobs.map fun j => if j.id == job then { j with oneShot := oneShot } else j }

/-- A run whose envelope really completed is shown failed only once it has waited its limit on a
person. The sweep treats a missing envelope as dead, which assumes a tracked run has its row. -/
theorem completed_envelope_fails_only_after_limit (l : Limits) (run : Run) (e : Envelope)
    (now : Time) (tracked : run.tracked = true) (ended : e.status = .completed)
    (shown : (deadRunOutcome l run (some e) now).isFailure = true) :
    e.polling = .waitsOnPerson ∧ run.startedAt + l.pausedRunMaxAge < now := by
  cases hp : e.polling
  · by_cases h : run.startedAt + l.pausedRunMaxAge < now
    · exact ⟨rfl, h⟩
    · simp [deadRunOutcome, tracked, ended, hp, h, Verdict.isFailure] at shown
  · by_cases h : e.updatedAt + l.deadRunGrace < now <;>
      simp [deadRunOutcome, tracked, ended, hp, h, Verdict.isFailure] at shown

/-- A run that waits on a person is not failed inside its limit. -/
theorem paused_not_failed_inside_limit (l : Limits) (run : Run) (e : Envelope) (now : Time)
    (tracked : run.tracked = true) (ended : e.status = .completed)
    (waits : e.polling = .waitsOnPerson) (inside : now ≤ run.startedAt + l.pausedRunMaxAge) :
    deadRunOutcome l run (some e) now = .wait := by
  have : ¬ run.startedAt + l.pausedRunMaxAge < now := Nat.not_lt.mpr inside
  simp [deadRunOutcome, tracked, ended, waits, this]

/-- A run still in flight is never ended by the sweep. -/
theorem active_envelope_waits (l : Limits) (run : Run) (e : Envelope) (now : Time)
    (tracked : run.tracked = true) (active : e.status = .active) :
    deadRunOutcome l run (some e) now = .wait := by
  simp [deadRunOutcome, tracked, active]

/-- A paused turn changes nothing, so the run stays `started`. -/
theorem pause_keeps_run_started (run : Run) (s : State) :
    settleCronRun .awaitingApproval run s = s ∧ settleCronRun .awaitingInput run s = s :=
  ⟨rfl, rfl⟩

/-- The first outcome stands: settling a run already finished changes nothing. -/
theorem settle_first_wins (status : RunStatus) (id : Nat) (runs : List Run)
    (finished : ∀ run ∈ runs, run.id = id → run.status ≠ .started) :
    settleRun status id runs = runs := by
  induction runs with
  | nil => rfl
  | cons head tail ih =>
    have hhead := finished head (by simp)
    have htail := ih fun run mem => finished run (by simp [mem])
    simp only [settleRun, List.map_cons] at htail ⊢
    rw [htail]
    by_cases hid : head.id = id
    · simp [hid, hhead hid]
    · simp [hid]

/-- An answer only ever ends a run of its own conversation. -/
theorem answer_settles_own_conversation (conversation : Nat) (run : Run) (runs : List Run)
    (found : newestStarted conversation runs = some run) :
    run.conversation = conversation ∧ run.status = .started := by
  have mem : run ∈ runs.filter fun r => r.conversation == conversation && r.status == .started :=
    List.mem_of_getLast? found
  simpa using (List.mem_filter.mp mem).2

/-- Control: a sweep that fails every run breaks the guarantee for a run that really finished. -/
example :
    ¬ ∀ (run : Run) (e : Envelope), run.tracked = true → e.status = .completed →
      Verdict.failedDead.isFailure = true → e.polling = .waitsOnPerson := by
  intro claim
  have wrong := claim
    { id := 1, job := 1, conversation := 1, startedAt := 0, tracked := true, oneShot := false,
      status := .started }
    { status := .completed, updatedAt := 0, polling := .settled } rfl rfl rfl
  cases wrong

/-- Finding: when a conversation has two started runs, an answer to the older one ends the newer
one, and the run that asked stays open. See `GAPS.md` G505. -/
example :
    let older : Run :=
      { id := 1, job := 1, conversation := 7, startedAt := 0, tracked := true, oneShot := false,
        status := .started }
    let newer : Run := { older with id := 2, job := 2, startedAt := 1 }
    (settleAnsweredRun 7 .completed { runs := [older, newer], jobs := [] }).runs =
      [older, { newer with status := .completed }] := by
  decide

/-- Finding: a job rescheduled to recur while its one-shot run is open is deleted when that run
finishes, because the run keeps the flag it fired with. See `GAPS.md` G506. -/
example :
    let run : Run :=
      { id := 1, job := 1, conversation := 7, startedAt := 0, tracked := true, oneShot := true,
        status := .started }
    let rescheduled := reschedule 1 false { runs := [run], jobs := [{ id := 1, oneShot := true }] }
    rescheduled.jobs = [{ id := 1, oneShot := false }] ∧
      (finishRun .completed run rescheduled).jobs = [] := by
  decide

end Spec.Channels.CronLifecycle
