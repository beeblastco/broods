import Broods.Ingress

/-!
# Async results

The polling row of an async run (`runtimeAsyncAgentResults`) as
`handleAsyncWorkerRequest` (`apps/core/src/harness/handler.ts`) and
`SubagentCoordinator.runTask` (`apps/core/src/harness/subagents.ts`) write it next to
the run's envelope, and the detached tool row (`runtimeAsyncToolResults`) under
`updateAsyncToolResult`, `observeAsyncToolResult` and `bindAsyncToolResultSandbox`
(`packages/convex/runtime.ts`).

An async run settles its envelope and its polling rows in one `runtimeIngress.settle`
mutation, so the two change together or not at all. A handler is a list of `Act`s;
any await may throw, so a run is the program plus the index of the await that
throws, if any, and the catch block then runs as `recover`.
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

/-- How `runAgentLoopUntilSubagentsIdle` ends, or the no-input early return. A failed
loop always reaches `onErrorText`, so it is `error`. -/
inductive Ending where
  | noInput | final | error | approval | questions | silent
  deriving DecidableEq, Repr

/-- One statement of a handler. -/
inductive Act where
  /-- `settleAsyncRun` with an owned envelope: `runtimeIngress.settle` writes the
  envelope and the polling rows in one transaction. -/
  | settle (f : Finish)
  /-- `recordAsyncRun`: `updateAsyncAgentResult` on the polling rows only. -/
  | record (f : Finish)
  /-- `settleIngress(...).catch(...)` without polling rows: a failure is swallowed. -/
  | settleEnvelope (o : Outcome)
  /-- `didSettle = true`: an assignment, cannot throw. -/
  | setDidSettle
  /-- An await that touches neither row and handles its own errors. -/
  | safe
  /-- An await that touches neither row and may throw: cron settle, channel push,
  `dispatchNextIngress`. -/
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

/-- The envelope outcome a finish settles: waiting for approval or input completes
the turn. -/
def Finish.envelope : Finish → Outcome
  | .failed => .failed
  | _ => .completed

/-- The effect of one statement. A settle is the owner's fenced settle from
`Broods.Ingress.step` (see `settle_matches_ingress`), with the polling rows in the same
transaction. -/
def Act.apply : Act → State → State
  | .settle f, s =>
    if s.envelope == .processing then
      { s with envelope := f.envelope.status, result := f.result }
    else s
  | .record f, s => { s with result := f.result }
  | .settleEnvelope o, s =>
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
    | .settleEnvelope _ => exec recover as none s
    | _ => recover s

/-- `handleAsyncWorkerRequest` from the moment it owns the run, per ending. -/
def program : Ending → List Act
  | .noInput => [.settle .failed, .setDidSettle, .effect, .effect]
  | .final => [.settle .completed, .setDidSettle, .effect, .effect, .effect]
  | .error => [.settle .failed, .setDidSettle, .effect, .effect, .effect]
  | .approval => [.settle .awaitingApproval, .setDidSettle, .effect]
  | .questions => [.settle .awaitingInput, .setDidSettle, .effect]
  | .silent => []

/-- The catch block: nothing once the outcome is recorded; otherwise a failed settle,
and when that fails too (the lease is gone), the polling rows alone
(`catchRecords`: whether that write lands). -/
def recover (catchSettles catchRecords : Bool) (s : State) : State :=
  if s.didSettle then s
  else if catchSettles then Act.apply (.settle .failed) s
  else if catchRecords then Act.apply (.record .failed) s
  else s

/-- Both rows start running: the envelope owns the turn, the row was created pending. -/
def start : State := ⟨.processing, .processing, false⟩

/-- One async worker run. -/
def worker (catchSettles catchRecords : Bool) (e : Ending) (throwAt : Option Nat) : State :=
  exec (recover catchSettles catchRecords) (program e) throwAt start

/-- A subagent run (`runTask` then `completeSuccessfulRun`): record completed, then
`completeTask`, the settle and the drain, which all catch their own failures.
Its catch settles failed and `startTask`'s catch records the row failed. -/
def subagent (throwAt : Option Nat) : State :=
  exec (fun s => { Act.apply (.settleEnvelope .failed) s with result := .failed })
    [.record .completed, .safe, .settleEnvelope .completed, .safe] throwAt start

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
    simp only [exec]
    exact exec_beyond as k _ (by simp at h; omega)

/-- For every ending, every await that may throw, and whether the catch's settle and
its fallback row write land, the envelope and the polling row agree. -/
theorem worker_consistent (e : Ending) (catchSettles catchRecords : Bool)
    (throwAt : Option Nat) : (worker catchSettles catchRecords e throwAt).consistent = true := by
  unfold worker
  match throwAt with
  | none => cases e <;> cases catchSettles <;> cases catchRecords <;> decide
  | some 0 | some 1 | some 2 | some 3 | some 4 =>
    cases e <;> cases catchSettles <;> cases catchRecords <;> decide
  | some (k + 5) =>
    rw [exec_beyond _ _ _ (by cases e <;> simp [program])]
    cases e <;> cases catchSettles <;> cases catchRecords <;> decide

/-- Once a run's outcome is recorded, no later throw changes either row. -/
theorem worker_settled_final (e : Ending) (catchSettles catchRecords : Bool) (k : Nat) :
    worker catchSettles catchRecords e (some (k + 1)) =
      worker catchSettles catchRecords e none := by
  unfold worker
  match k with
  | 0 | 1 | 2 | 3 => cases e <;> cases catchSettles <;> cases catchRecords <;> decide
  | k + 4 => rw [exec_beyond _ _ _ (by cases e <;> simp [program])]

/-- A subagent's completed result is never turned into a failure, since everything
after the record handles its own errors. -/
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

/-! ## Witnesses -/

/-- The run completes and the channel push throws: both rows stay completed. -/
example : worker true true .final (some 3) = ⟨.completed, .completed, true⟩ := by decide

/-- The settle itself throws: the catch fails both rows. -/
example : worker true true .final (some 0) = ⟨.failed, .failed, false⟩ := by decide

/-- The lease is gone, so the catch's settle fails too: the row alone records the
failure and the envelope expires with the lease. -/
example : worker false true .final (some 0) = ⟨.processing, .failed, false⟩ := by decide

end Broods.AsyncResults
