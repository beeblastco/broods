import Broods.Ingress

/-!
# Async results

The polling row of an async run (`runtimeAsyncAgentResults`) as
`handleAsyncWorkerRequest` (`apps/core/src/harness/handler.ts`) and
`SubagentCoordinator.runTask` (`apps/core/src/harness/subagents.ts`) write it next to
the run's envelope, and the detached tool row (`runtimeAsyncToolResults`) under
`updateAsyncToolResult` and `bindAsyncToolResultSandbox`
(`packages/convex/runtime.ts`).

A handler is a list of `Act`s. Any await may throw, so a run is the program plus the
index of the await that throws, if any; the catch block then runs as `recover`.
-/

namespace Broods.AsyncResults

open Broods.Ingress (Status Outcome)

/-- `runtimeAsyncAgentResults.status`. -/
inductive AgentStatus where
  | processing | awaitingApproval | awaitingInput | completed | failed
  deriving DecidableEq, Repr

/-- How `runAgentLoopUntilSubagentsIdle` ends, or the no-input early return. -/
inductive Ending where
  | noInput | final | error | approval | questions | didFail | silent
  deriving DecidableEq, Repr

/-- One statement of a handler. -/
inductive Act where
  /-- `markAsyncAgentResult*` / `settleAsyncFailure`: `updateAsyncAgentResult`
  overwrites the row whatever it held. -/
  | markResult (s : AgentStatus)
  /-- `session.settleIngress`: moves the owner's envelope only while it runs. -/
  | settle (o : Outcome)
  /-- `settleIngress(...).catch(() => {})`: a failure is swallowed, not thrown. -/
  | settleQuiet (o : Outcome)
  /-- `didSettle = true`: an assignment, cannot throw. -/
  | setDidSettle
  /-- An await that touches neither row and handles its own errors. -/
  | safe
  /-- An await that touches neither row and may throw: cron settle, channel
  push, `dispatchNextIngress`. -/
  | effect
  deriving DecidableEq, Repr

/-- The two rows and the handler flag. -/
structure State where
  envelope : Status
  result : AgentStatus
  didSettle : Bool
  deriving DecidableEq, Repr

/-- `runtimeAsyncToolResults.status`. -/
inductive ToolStatus where
  | processing | completed | failed
  deriving DecidableEq, Repr

/-- The tool row fields the settle path reads. -/
structure ToolRow where
  status : ToolStatus
  sandboxBound : Bool
  observed : Bool
  deriving DecidableEq, Repr

/-- The mutations core sends for a detached tool row. `reserved` is what
`sandboxStillReserved` answers inside that mutation. -/
inductive ToolCall where
  /-- `markAsyncToolResultCompleted` / `Failed` / `settleAsyncToolResultFromCallback`,
  all with `onlyWhenProcessing: true`. -/
  | settle (s : ToolStatus) (reserved : Bool)
  /-- `markAsyncToolResultObserved`: `observed: true`, status kept. -/
  | observe (reserved : Bool)
  /-- `bindAsyncToolResultSandbox`. -/
  | bind
  deriving DecidableEq, Repr

/-- The effect of one statement. `settle` is the owner's fenced settle from
`Broods.Ingress.step` (see `settle_matches_ingress`). -/
def Act.apply : Act → State → State
  | .markResult r, s => { s with result := r }
  | .settle o, s | .settleQuiet o, s =>
    if s.envelope == .processing then { s with envelope := o.status } else s
  | .setDidSettle, s => { s with didSettle := true }
  | .safe, s | .effect, s => s

/-- Runs `acts`; `throwAt` is the index of the await that throws. An assignment or
a `safe` await passes the throw to the next statement, a quiet settle swallows it. -/
def exec (recover : State → State) : List Act → Option Nat → State → State
  | [], _, s => s
  | a :: as, none, s => exec recover as none (a.apply s)
  | a :: as, some (k + 1), s => exec recover as (some k) (a.apply s)
  | a :: as, some 0, s =>
    match a with
    | .setDidSettle | .safe => exec recover as (some 0) (a.apply s)
    | .settleQuiet _ => exec recover as none s
    | _ => recover s

/-- `handleAsyncWorkerRequest` from the moment it owns the run, per ending. `fixed`
is the current code; `false` is the code before this change. -/
def program (fixed : Bool) : Ending → List Act
  | .noInput => [.markResult .failed, .settle .failed, .setDidSettle, .effect, .effect]
  | .final =>
    if fixed then [.markResult .completed, .settle .completed, .setDidSettle, .effect, .effect, .effect]
    else [.setDidSettle, .settle .completed, .markResult .completed, .effect, .effect, .effect]
  | .error =>
    if fixed then [.markResult .failed, .settle .failed, .setDidSettle, .effect, .effect, .effect]
    else [.setDidSettle, .settle .failed, .markResult .failed, .effect, .effect, .effect]
  | .approval =>
    if fixed then [.markResult .awaitingApproval, .settle .completed, .setDidSettle, .effect]
    else [.markResult .awaitingApproval, .setDidSettle, .settle .completed, .effect]
  | .questions =>
    if fixed then [.markResult .awaitingInput, .settle .completed, .setDidSettle, .effect]
    else [.markResult .awaitingInput, .setDidSettle, .settle .completed, .effect]
  | .didFail =>
    if fixed then [.settleQuiet .failed, .markResult .failed, .setDidSettle, .effect, .effect]
    else [.setDidSettle, .settleQuiet .failed, .markResult .failed, .effect, .effect]
  | .silent => []

/-- The catch block: a quiet failed settle (which may itself fail, `catchSettles`),
then `settleAsyncFailure`, which the fix skips once `didSettle`. -/
def recover (fixed catchSettles : Bool) (s : State) : State :=
  let s := if catchSettles then Act.apply (.settleQuiet .failed) s else s
  if fixed && s.didSettle then s else { s with result := .failed }

/-- Both rows start running: the envelope owns the turn, the row was created pending. -/
def start : State := ⟨.processing, .processing, false⟩

/-- One async worker run. -/
def worker (fixed catchSettles : Bool) (e : Ending) (throwAt : Option Nat) : State :=
  exec (recover fixed catchSettles) (program fixed e) throwAt start

/-- A subagent run (`runTask` then `completeSuccessfulRun`): mark completed, then
`completeTask`, the settle and the drain, which all catch their own failures.
Its catch settles failed and `startTask`'s catch marks the row failed. -/
def subagent (throwAt : Option Nat) : State :=
  exec (fun s => { Act.apply (.settleQuiet .failed) s with result := .failed })
    [.markResult .completed, .safe, .settleQuiet .completed, .safe] throwAt start

/-- The two rows agree: a completed envelope never sits next to a failed or still
running result, and a failed envelope always has a failed result. -/
def State.consistent (s : State) : Bool :=
  (s.envelope != .completed || (s.result != .failed && s.result != .processing)) &&
    (s.envelope != .failed || s.result == .failed)

/-- Status route merge (`handler.ts` status handler): the polling status wins while
waiting or while the envelope has not failed. -/
def mergedStatus (envelope : Status) (result : AgentStatus) : Sum AgentStatus Status :=
  match result with
  | .awaitingApproval | .awaitingInput => .inl result
  | .processing => if envelope == .failed then .inr envelope else .inl result
  | _ => .inr envelope

/-- `updateAsyncToolResult` / `bindAsyncToolResultSandbox` on one row. A running job
whose sandbox reservation is gone settles failed whatever it reported. -/
def ToolRow.update (row : ToolRow) : ToolCall → ToolRow
  | .settle s reserved =>
    if row.status != .processing then row
    else if row.sandboxBound && !reserved then { row with status := .failed }
    else { row with status := s }
  | .observe reserved =>
    if row.status == .processing && row.sandboxBound && !reserved then
      { row with status := .failed, observed := true }
    else { row with observed := true }
  | .bind => if row.status == .processing then { row with sandboxBound := true } else row

/-- How many calls in `cs` change the row's status. -/
def ToolRow.changes (row : ToolRow) : List ToolCall → Nat
  | [] => 0
  | c :: cs =>
    (if (row.update c).status == row.status then 0 else 1) + (row.update c).changes cs

/-! ## Properties -/

/-- The model's `settle` is the owner's settle in `Broods.Ingress`. -/
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
    simp only [exec]
    exact exec_beyond as k _ (by simp at h; omega)

/-- For every ending, every await that may throw and whether the catch's own settle
lands, the fixed handler leaves the envelope and the polling row consistent. -/
theorem worker_consistent (e : Ending) (catchSettles : Bool) (throwAt : Option Nat) :
    (worker true catchSettles e throwAt).consistent = true := by
  unfold worker
  match throwAt with
  | none => cases e <;> cases catchSettles <;> decide
  | some 0 | some 1 | some 2 | some 3 | some 4 | some 5 =>
    cases e <;> cases catchSettles <;> decide
  | some (k + 6) =>
    rw [exec_beyond _ _ _ (by cases e <;> simp [program])]
    cases e <;> cases catchSettles <;> decide

/-- A subagent's completed result is never turned into a failure, since everything
after the mark handles its own errors. -/
theorem subagent_consistent (throwAt : Option Nat) : (subagent throwAt).consistent = true := by
  unfold subagent
  match throwAt with
  | none | some 0 | some 1 | some 2 | some 3 => decide
  | some (k + 4) =>
    rw [exec_beyond _ _ _ (by simp)]
    decide

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

/-! ## Regression witnesses -/

/-- Before the fix: the run completes, the channel push throws, and the catch marks
the polling row failed next to a completed envelope, which the status route reports
as `completed` with its response erased. -/
example :
    worker false true .final (some 4) = ⟨.completed, .failed, true⟩ ∧
      mergedStatus .completed .failed = .inr .completed := by
  decide

/-- The same throw after the fix leaves both rows completed. -/
example : worker true true .final (some 4) = ⟨.completed, .completed, true⟩ := by decide

/-- A throw between the result write and the envelope settle fails both rows. -/
example : worker true true .final (some 1) = ⟨.failed, .failed, false⟩ := by decide

end Broods.AsyncResults
