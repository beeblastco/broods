/-!
The cron run lifecycle in `packages/convex/agent/crons.ts`, `packages/convex/runtimeIngress.ts` and
`settleCronRun` in `apps/core/src/harness/handler.ts`: how a started run ends. The claims are safety
only: progress depends on the sweep being scheduled, and leakage does not apply to one job's runs.
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

end Spec.Channels.CronLifecycle
