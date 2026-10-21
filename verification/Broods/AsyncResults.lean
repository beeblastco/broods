import Broods.Ingress

/-!
# Async results

The polling row of an async run (`runtimeAsyncAgentResults`) as
`handleAsyncWorkerRequest` (`apps/core/src/harness/handler.ts`) and
`SubagentCoordinator.recordOutcome` (`apps/core/src/harness/subagents.ts`) write it next
to the run's envelope, and the detached tool row (`runtimeAsyncToolResults`) under
`updateAsyncToolResult`, `markAsyncToolHandback` and `bindAsyncToolResultSandbox`
(`packages/convex/runtime.ts`).

An async run settles its envelope and its polling rows in one `runtimeIngress.settle`
mutation, which writes the rows only when it finishes the owner's own envelope, so the
two change together or not at all. A handler is a list of `Act`s; any await may throw,
so a run is the program plus the index of the await that throws, if any, and the catch
block then runs as `recover`.

A subagent's row also carries `handback`: whether its parent has the result (`stored`).
The parent's `get_subagent_status` read
(`markAsyncAgentHandback`, once the step that carries it is saved), its own append of
the result (`insertConversationEvents`) and a late result's resume reaching its owner
(`runtimeIngress.accept` with `resultEventId` as owner, or the apply of the envelope it
queued) all store it, and the resume is admitted only while it is not stored and no
resume of it is queued, so the parent is told a result once. A queued resume that
expires leaves the row as it was, for the sweep to resume again. Only the sweep reads
`pending`, which the row carries from its creation, past the parent's hold. A tool
row's `handback` moves the same way: its
settle writes `pending`, the parent's append, `async_status` and the continuation
reaching its owner (`accept` with `toolResultId`) store it, and `markHandback` here stands
for either move of `markAsyncToolHandback`, which never touches the status the proofs
are about.
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

/-- How `runAgentLoopUntilSubagentsIdle` (`apps/core/src/harness/continuation.ts`) ends,
or the no-input branch. A failed loop always reaches `onErrorText`, so it is `error`;
`silent` returns with no callback; `replayed` asks questions, then replays an earlier
pass's final text. A queued command (`commandOutcome`) runs instead of the loop and never
throws: `commandReplied` when its reply went out, `commandFailed` when sending it failed. -/
inductive Ending where
  | noInput | final | error | approval | questions | silent | replayed
  | commandReplied | commandFailed
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
  /-- `markAsyncToolHandback`: moves a finished row's `handback` (`stored` or
  `detached`), status untouched. -/
  | markHandback
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
  | .commandReplied => [.finish .completed, .requireRecorded, .effect, .effect]
  | .commandFailed => [.finish .failed, .requireRecorded, .effect, .effect]

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

/-- `updateAsyncToolResult` / `markAsyncToolHandback` / `bindAsyncToolResultSandbox`
on one row. A running job whose sandbox reservation is gone settles failed whatever
it reported. -/
def ToolRow.update (row : ToolRow) : ToolCall → ToolRow
  | .settle s reserved =>
    if row.status != .processing then row
    else if row.sandboxBound && !reserved then { row with status := .failed }
    else { row with status := s }
  | .markHandback => row
  | .bind => if row.status == .processing then { row with sandboxBound := true } else row

/-- How many calls in `cs` change the row's status. -/
def ToolRow.changes (row : ToolRow) : List ToolCall → Nat
  | [] => 0
  | c :: cs =>
    (if (row.update c).status == row.status then 0 else 1) + (row.update c).changes cs

/-- `runtimeAsyncAgentResults.handback` on a subagent's row: `pending` from the row's
creation, `detached` once the parent stopped waiting on the child, `stored` once the
parent has its result. -/
inductive HandbackState where
  | pending | detached | stored
  deriving DecidableEq, Repr

/-- The calls that touch `handback`, in any order a race gives them. -/
inductive HandbackCall where
  /-- `markAsyncAgentHandback` with `detached`, when the parent stops waiting, or when
  a pass's last write fails, for each result it did not save and each child still
  working; those then resume. -/
  | detach
  /-- `markAsyncAgentHandback` with `stored`: the save of the step that carries a
  `get_subagent_status` read (`confirmDelivered`), or that read itself of a detached
  row, a result the parent is never told, or the parent's own append of the result
  (`insertConversationEvents`). `finished` is whether the row has its outcome yet. -/
  | read (finished : Bool)
  /-- `runtimeIngress.accept` with `resultEventId`, the late resume, under its one
  idempotency key; `room` is whether the conversation's queue has room for it, `stored`
  whether the conversation already stores the result under its dedupe key
  (`checkDuplicateAdmission`), a write that committed but lost its reply, and `busy`
  whether another run owns the conversation, so the resume queues. -/
  | resume (room stored busy : Bool)
  /-- The owner takes the queued resume (`promoteQueuedGroup` or `claimSteering`),
  storing the row in the same mutation (`markDeliveredResultsStored`). -/
  | apply
  /-- The queued resume expires (`maintain`, `expireQueuedEnvelopes`), writing nothing
  to the row; a later resume under its key replaces it (`expiredUndeliveredResume`). -/
  | expire
  deriving DecidableEq, Repr

/-- The row's state, and whether a resume of it waits in the conversation's queue. -/
structure Handback where
  state : HandbackState
  queued : Bool
  deriving DecidableEq, Repr

/-- One call in its own transaction: the new state, and whether it told the parent the
result, as a resume admitted as owner or a queued one applied. A resume is admitted only
while the row is not stored and none of it is queued. A resume of a result the conversation
already stores is refused and marks the row stored. -/
def Handback.step (h : Handback) : HandbackCall → Handback × Bool
  | .detach => (if h.state == .stored then h else { h with state := .detached }, false)
  | .read finished => (if finished then { h with state := .stored } else h, false)
  | .resume room stored busy =>
    if h.state == .stored || h.queued then (h, false)
    else if stored then ({ h with state := .stored }, false)
    else if !busy then ({ h with state := .stored }, true)
    else if room then ({ h with queued := true }, false)
    else (h, false)
  | .apply => if h.queued then (⟨.stored, false⟩, true) else (h, false)
  | .expire => ({ h with queued := false }, false)

/-- How many times `cs` tells the parent the result from state `h`. -/
def Handback.told : Handback → List HandbackCall → Nat
  | _, [] => 0
  | h, c :: cs => (if (h.step c).2 then 1 else 0) + (h.step c).1.told cs

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
      | .final | .commandReplied => .completed
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

/-- Telling the parent leaves the row stored with nothing queued. -/
theorem step_tells_stored (h : Handback) (c : HandbackCall) (ht : (h.step c).2 = true) :
    (h.step c).1 = ⟨.stored, false⟩ := by
  rcases h with ⟨o, q⟩
  cases o <;> cases q <;> cases c <;> simp_all [Handback.step] <;>
    (repeat' split at ht) <;> simp_all

/-- A stored row with nothing queued never moves, and tells the parent nothing. -/
theorem stored_step (c : HandbackCall) :
    (Handback.mk .stored false).step c = (⟨.stored, false⟩, false) := by
  cases c <;> simp [Handback.step]

/-- Nothing tells the parent a result its row marks stored, once no resume is queued. -/
theorem stored_tells_none : ∀ cs : List HandbackCall, (Handback.mk .stored false).told cs = 0
  | [] => rfl
  | c :: cs => by
    simp only [Handback.told, stored_step]
    simp [stored_tells_none cs]

/-- However the status reads, detaches, resumes, applies and expiries interleave, the
parent is told a late result by a resume at most once. -/
theorem resume_at_most_once (h : Handback) (cs : List HandbackCall) : h.told cs ≤ 1 := by
  induction cs generalizing h with
  | nil => simp [Handback.told]
  | cons c cs ih =>
    simp only [Handback.told]
    by_cases ht : (h.step c).2 = true
    · simp [ht, step_tells_stored h c ht, stored_tells_none]
    · simp [ht, ih]

/-- A status read of a finished result with no resume queued shuts out every later
resume: a child finishing after the read but before the read's step saved tells the
parent nothing more. -/
theorem read_shuts_out_resume (o : HandbackState) (cs : List HandbackCall) :
    ((Handback.mk o false).step (.read true)).1.told cs = 0 := by
  cases o <;> simp [Handback.step, stored_tells_none]

/-- A resume refused because the conversation already stores its result shuts out every
later resume too, so the recovery sweep stops retrying it. -/
theorem stored_shuts_out_resume (o : HandbackState) (room busy : Bool) (cs : List HandbackCall) :
    ((Handback.mk o false).step (.resume room true busy)).1.told cs = 0 := by
  cases o <;> simp [Handback.step, stored_tells_none]

/-- A queued resume that expires writes nothing to the row, so a row the parent never
got stays the sweep's, and the sweep's next resume tells the parent. -/
theorem expired_resume_told_again (o : HandbackState) (room : Bool) (ho : o ≠ .stored) :
    (Handback.mk o true).step .expire = (⟨o, false⟩, false) ∧
      (Handback.mk o true).told [.expire, .resume room false false] = 1 := by
  cases o <;> simp_all [Handback.told, Handback.step]

/-! ## Witnesses -/

/-- A status read while a resume of the result waits in the queue: the read returns
the result, and the apply still tells the parent, so it sees it twice. Before stores were
moved to the apply the queued admission stored the row first, and this was the same. -/
example :
    (Handback.mk .detached false).told [.resume true false true, .read true, .apply] = 1 := by
  decide

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
