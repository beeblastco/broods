import Broods.Ingress

/-!
# Async results

The polling row of an async run (`runtimeAsyncAgentResults`) as
`handleAsyncWorkerRequest` (`apps/core/src/harness/handler.ts`) and
`SubagentCoordinator.recordOutcome` (`apps/core/src/harness/subagents.ts`) write it next
to the run's envelope, and the detached tool row (`runtimeAsyncToolResults`) under
`updateAsyncToolResult`, `observeAsyncToolResult` and `bindAsyncToolResultSandbox`
(`packages/convex/runtime.ts`).

An async run settles its envelope and its polling rows in one `runtimeIngress.settle`
mutation, which writes the rows only when it finishes the owner's own envelope, so the
two change together or not at all. A handler is a list of `Act`s; any await may throw,
so a run is the program plus the index of the await that throws, if any, and the catch
block then runs as `recover`.
-/

namespace Broods.AsyncResults

open Broods.Ingress (Status Outcome)

/-- `runtimeAsyncAgentResults.status`. -/
inductive AgentStatus where
  | processing | awaitingApproval | awaitingInput | completed | failed
  deriving DecidableEq, Repr

/-- `AsyncAgentOutcome`: how an async run ends. -/
inductive Finish where
  | completed | failed | awaitingApproval | awaitingInput
  deriving DecidableEq, Repr

/-- How `runAgentLoopUntilSubagentsIdle` ends, or the no-input branch. A failed loop
always reaches `onErrorText`, so it is `error`; `silent` returns with no callback;
`replayed` asks questions, then replays an earlier pass's final text. -/
inductive Ending where
  | noInput | final | error | approval | questions | silent | replayed
  deriving DecidableEq, Repr

/-- One statement of a handler. -/
inductive Act where
  /-- `finish`: returns at once when `recorded`; otherwise keeps the first `outcome`,
  `settleAsyncRun`s it (`runtimeIngress.settle` with the polling rows), then
  `recorded = true`. -/
  | finish (f : Finish)
  /-- `finish` called inside the harness, which catches a callback's throw
  (`onQuestionsPending` in `runAgentLoop`'s `onEnd`), so a throw goes no further. -/
  | finishSwallowed (f : Finish)
  /-- The check after the loop: an outcome that was never recorded throws. -/
  | requireRecorded
  /-- An await that touches neither row and handles its own errors:
  `pushReplyToChannel`. -/
  | safe
  /-- An await that touches neither row and may throw: `settleCronRun`,
  `dispatchNextIngress`. -/
  | effect
  deriving DecidableEq, Repr

/-- The two rows and the handler's `outcome` and `recorded`. -/
structure State where
  envelope : Status
  result : AgentStatus
  recorded : Bool
  outcome : Option Finish
  deriving DecidableEq, Repr

/-- `runtimeAsyncToolResults.status`. -/
inductive ToolStatus where
  | processing | completed | failed
  deriving DecidableEq, Repr

/-- The tool row fields the settle path reads. -/
structure ToolRow where
  status : ToolStatus
  sandboxBound : Bool
  deriving DecidableEq, Repr

/-- The mutations core sends for a detached tool row. `reserved` is what
`sandboxStillReserved` answers inside that mutation. -/
inductive ToolCall where
  /-- `markAsyncToolResultCompleted` / `Failed` / `settleAsyncToolResultFromCallback`,
  all with `onlyWhenProcessing: true`. -/
  | settle (s : ToolStatus) (reserved : Bool)
  /-- `observeAsyncToolResult`: marks a finished row observed, status untouched. -/
  | observe
  /-- `bindAsyncToolResultSandbox`. -/
  | bind
  deriving DecidableEq, Repr

/-- The polling status a finish records. -/
def Finish.result : Finish → AgentStatus
  | .completed => .completed
  | .failed => .failed
  | .awaitingApproval => .awaitingApproval
  | .awaitingInput => .awaitingInput

/-- `outcomeSettlement`: the envelope outcome a finish settles; waiting for approval
or input completes the turn. -/
def Finish.envelope : Finish → Outcome
  | .failed => .failed
  | _ => .completed

/-- `runtimeIngress.settle` with `asyncResult`: the owner's fenced settle from
`Broods.Ingress.step` (see `settle_matches_ingress`), writing the polling rows only when
it finishes the owner's envelope. -/
def settle (f : Finish) (s : State) : State :=
  if s.envelope == .processing then
    { s with envelope := f.envelope.status, result := f.result }
  else s

/-- `recordAsyncRun`: `updateAsyncAgentResult` on the polling rows only. -/
def record (f : Finish) (s : State) : State := { s with result := f.result }

/-- A `finish` that ran to the end: a recorded run keeps its outcome, and an
unrecorded one settles the first outcome it produced. -/
def finished (f : Finish) (s : State) : State :=
  if s.recorded then s
  else
    let o := s.outcome.getD f
    { settle o s with recorded := true, outcome := some o }

/-- A statement that cannot throw hands a pending throw to the next statement. -/
def pass : Option Nat → Option Nat
  | some (k + 1) => some k
  | t => t

/-- Runs `acts`; `throwAt` is the index of the await that throws. The harness
swallows a throw in `finishSwallowed`. -/
def exec (recover : State → State) : List Act → Option Nat → State → State
  | [], _, s => s
  | .requireRecorded :: as, t, s => if s.recorded then exec recover as (pass t) s else recover s
  | .safe :: as, t, s => exec recover as (pass t) s
  | .finish f :: as, none, s | .finishSwallowed f :: as, none, s =>
    exec recover as none (finished f s)
  | .finish f :: as, some (k + 1), s | .finishSwallowed f :: as, some (k + 1), s =>
    exec recover as (some k) (finished f s)
  | .finish f :: as, some 0, s =>
    if s.recorded then exec recover as (some 0) s
    else recover { s with outcome := some (s.outcome.getD f) }
  | .finishSwallowed f :: as, some 0, s =>
    if s.recorded then exec recover as (some 0) s
    else exec recover as none { s with outcome := some (s.outcome.getD f) }
  | .effect :: as, none, s => exec recover as none s
  | .effect :: as, some (k + 1), s => exec recover as (some k) s
  | .effect :: _, some 0, s => recover s

/-- `handleAsyncWorkerRequest` from the moment it owns the run, per ending. -/
def program : Ending → List Act
  | .noInput => [.finish .failed, .requireRecorded, .effect, .effect]
  | .final => [.finish .completed, .safe, .requireRecorded, .effect, .effect]
  | .error => [.finish .failed, .safe, .requireRecorded, .effect, .effect]
  | .approval => [.finish .awaitingApproval, .requireRecorded, .effect, .effect]
  | .questions => [.finishSwallowed .awaitingInput, .requireRecorded, .effect, .effect]
  | .silent => [.requireRecorded, .effect, .effect]
  | .replayed =>
    [.finishSwallowed .awaitingInput, .finish .completed, .safe, .requireRecorded, .effect,
      .effect]

/-- The catch block: nothing once the outcome is recorded; otherwise it records the
outcome the run produced, or a failure when there is none: first through the settle,
and when that fails too (the lease is gone), on the polling rows alone
(`catchRecords`: whether that write lands). -/
def recover (catchSettles catchRecords : Bool) (s : State) : State :=
  let produced := s.outcome.getD .failed
  if s.recorded then s
  else if catchSettles then settle produced s
  else if catchRecords then record produced s
  else s

/-- Both rows start running: the envelope owns the turn, the row was created pending. -/
def start : State := ⟨.processing, .processing, false, none⟩

/-- One async worker run. -/
def worker (catchSettles catchRecords : Bool) (e : Ending) (throwAt : Option Nat) : State :=
  exec (recover catchSettles catchRecords) (program e) throwAt start

/-- `SubagentCoordinator.recordOutcome` for a completed child: the atomic settle, or,
when it throws, the polling row alone; everything after it handles its own errors, and
the failure paths skip a child whose outcome is recorded. `settleFails` is whether the
settle throws. -/
def subagent (settleFails : Bool) : State :=
  let s := if settleFails then record .completed start else settle .completed start
  { s with recorded := true, outcome := some .completed }

/-- The two rows agree: a completed envelope never sits next to a failed or still
running result, and a failed envelope always has a failed result. -/
def State.consistent (s : State) : Bool :=
  (s.envelope != .completed || (s.result != .failed && s.result != .processing)) &&
    (s.envelope != .failed || s.result == .failed)

/-- `updateAsyncToolResult` / `observeAsyncToolResult` / `bindAsyncToolResultSandbox`
on one row. A running job whose sandbox reservation is gone settles failed whatever
it reported. -/
def ToolRow.update (row : ToolRow) : ToolCall → ToolRow
  | .settle s reserved =>
    if row.status != .processing then row
    else if row.sandboxBound && !reserved then { row with status := .failed }
    else { row with status := s }
  | .observe => row
  | .bind => if row.status == .processing then { row with sandboxBound := true } else row

/-- How many calls in `cs` change the row's status. -/
def ToolRow.changes (row : ToolRow) : List ToolCall → Nat
  | [] => 0
  | c :: cs =>
    (if (row.update c).status == row.status then 0 else 1) + (row.update c).changes cs

/-! ## Properties -/

/-- The model's settle moves the envelope as the owner's settle in `Broods.Ingress`. -/
theorem settle_matches_ingress {c : Broods.Ingress.Coord} {now owner g : Nat} {o : Outcome}
    {e : Broods.Ingress.Envelope} (hfence : Broods.Ingress.requireOwner c owner g now = true)
    (hown : e.eventId = owner) :
    (Broods.Ingress.step c now (.settle owner g o) e).status =
      if e.status == .processing then o.status else e.status := by
  simp only [Broods.Ingress.step, hfence, hown, beq_self_eq_true, Bool.true_or, Bool.true_and]
  split <;> simp_all

private theorem exec_beyond {r : State → State} :
    ∀ (as : List Act) (k : Nat) (s : State), as.length ≤ k → exec r as (some k) s = exec r as none s
  | [], _, _, _ => by simp [exec]
  | a :: as, k + 1, s, h => by
    have h' : as.length ≤ k := by simp at h; omega
    cases a <;> simp only [exec, pass] <;> (try split) <;> (try rfl) <;> exact exec_beyond as k _ h'

/-- For every ending, every await that may throw, and whether the catch's settle and
its fallback row write land, the envelope and the polling row agree. -/
theorem worker_consistent (e : Ending) (catchSettles catchRecords : Bool)
    (throwAt : Option Nat) : (worker catchSettles catchRecords e throwAt).consistent = true := by
  unfold worker
  match throwAt with
  | none => cases e <;> cases catchSettles <;> cases catchRecords <;> decide
  | some 0 | some 1 | some 2 | some 3 | some 4 | some 5 =>
    cases e <;> cases catchSettles <;> cases catchRecords <;> decide
  | some (k + 6) =>
    rw [exec_beyond _ _ _ (by cases e <;> simp [program])]
    cases e <;> cases catchSettles <;> cases catchRecords <;> decide

/-- Once a run's outcome is recorded, no later throw changes either row. -/
theorem worker_settled_final (e : Ending) (catchSettles catchRecords : Bool) (k : Nat) :
    worker catchSettles catchRecords e (some (k + 1)) =
      worker catchSettles catchRecords e none := by
  unfold worker
  match k with
  | 0 | 1 | 2 | 3 | 4 => cases e <;> cases catchSettles <;> cases catchRecords <;> decide
  | k + 5 => rw [exec_beyond _ _ _ (by cases e <;> simp [program])]

/-- A throw before the outcome is recorded never loses what the run produced: when
either catch write lands, the polling row holds that outcome. -/
theorem worker_keeps_produced (e : Ending) (catchSettles : Bool) :
    (worker catchSettles true e (some 0)).result =
      match e with
      | .final => .completed
      | .questions | .replayed => .awaitingInput
      | .approval => .awaitingApproval
      | _ => .failed := by
  cases e <;> cases catchSettles <;> decide

/-- A subagent's settle and its fallback row write leave the rows agreeing. -/
theorem subagent_consistent (settleFails : Bool) : (subagent settleFails).consistent = true := by
  cases settleFails <;> decide

/-- A finished tool row never changes status again. -/
theorem tool_terminal_absorbing {row : ToolRow} (c : ToolCall)
    (h : row.status ≠ .processing) : (row.update c).status = row.status := by
  cases c <;> simp [ToolRow.update, h]

private theorem tool_no_changes {row : ToolRow} (h : row.status ≠ .processing) :
    ∀ cs, row.changes cs = 0 := by
  intro cs
  induction cs generalizing row with
  | nil => rfl
  | cons c cs ih =>
    have hs := tool_terminal_absorbing c h
    simp only [ToolRow.changes, hs, beq_self_eq_true, ite_true, Nat.zero_add]
    exact ih (hs ▸ h)

/-- A detached tool job settles at most once, whatever calls race on it. -/
theorem tool_settles_once (row : ToolRow) (cs : List ToolCall) : row.changes cs ≤ 1 := by
  induction cs generalizing row with
  | nil => simp [ToolRow.changes]
  | cons c cs ih =>
    simp only [ToolRow.changes]
    by_cases hc : (row.update c).status = row.status
    · simp [hc, ih]
    · have hp : row.status = .processing :=
        Decidable.byContradiction fun hp => hc (tool_terminal_absorbing c hp)
      have hdone : (row.update c).status ≠ .processing := fun h => hc (h.trans hp.symm)
      simp [hc, tool_no_changes hdone]

/-! ## Witnesses -/

/-- The run completes and its cron settle throws: both rows stay completed. -/
example : worker true true .final (some 3) = ⟨.completed, .completed, true, some .completed⟩ := by
  decide

/-- The lease is gone, so the settle and the catch's retry both fail: the polling row
still records the answer, and the envelope expires with the lease. -/
example : worker false true .final (some 0) = ⟨.processing, .completed, false, some .completed⟩ := by
  decide

/-- The harness swallows a failed questions write: the check after the loop throws and
the catch records the pending questions. -/
example :
    worker true true .questions (some 0) =
      ⟨.completed, .awaitingInput, false, some .awaitingInput⟩ := by
  decide

/-- The questions write fails and the harness swallows it; the replayed final text then
retries the pending questions, not `completed`, so a one-shot cron is not retired. -/
example :
    worker true true .replayed (some 0) =
      ⟨.completed, .awaitingInput, true, some .awaitingInput⟩ := by
  decide

end Broods.AsyncResults
