/-!
# Run lifecycle

Model of one `runtimeIngressEnvelopes` row (the run behind `GET /v1/runs/{runId}`)
under the mutations in `packages/convex/runtimeIngress.ts`, plus the
`runtimeAsyncAgentResults` row that `handleAsyncWorkerRequest`
(`apps/core/src/harness/handler.ts`) writes next to it. Each mutation is a Convex
transaction, so a run is a sequence of `Step`s.
-/

namespace Broods.Ingress

/-- Stored envelope status. `accepted` and `applied` exist only in the public type. -/
inductive Status where
  | queued | processing | completed | failed | expired
  deriving DecidableEq, Repr

/-- How an owner ends its turn in `settle` / `takeNext`. -/
inductive Outcome where
  | completed | failed
  deriving DecidableEq, Repr

/-- `runtimeAsyncAgentResults.status`, the polling status. -/
inductive AgentStatus where
  | processing | awaitingApproval | awaitingInput | completed | failed
  deriving DecidableEq, Repr

/-- The `runtimeConversationCoordinators` fields the fence reads. -/
structure Coord where
  ownerGeneration : Nat
  ownerEventId : Option Nat
  leaseExpiresAt : Option Nat
  stopRequestedGeneration : Option Nat
  deriving DecidableEq, Repr

/-- The envelope fields the lifecycle reads and writes. -/
structure Envelope where
  eventId : Nat
  status : Status
  expiresAt : Nat
  ownerGeneration : Option Nat
  appliedToEventId : Option Nat
  stoppedByUser : Bool
  deriving DecidableEq, Repr

/-- One envelope write, named after the helper that performs it. -/
inductive Step where
  /-- `promoteQueuedGroup` and `applySteering`: queued to processing. -/
  | promote (generation appliedTo : Nat)
  /-- `settleAppliedEnvelopes`, reached through `settle` and `takeNext`. -/
  | settle (ownerEventId generation : Nat) (outcome : Outcome)
  /-- `expireQueuedEnvelopes`. -/
  | expireQueued
  /-- `expireStaleOwner`. -/
  | expireStaleOwner
  /-- The `maintain` cron. -/
  | maintain

def Status.terminal : Status → Bool
  | .completed | .failed | .expired => true
  | _ => false

def Outcome.status : Outcome → Status
  | .completed => .completed
  | .failed => .failed

/-- `requireOwner`: same owner event, same generation, lease not yet past `now`. -/
def requireOwner (c : Coord) (ownerEventId generation now : Nat) : Bool :=
  c.ownerEventId == some ownerEventId && c.ownerGeneration == generation &&
    match c.leaseExpiresAt with
    | some t => decide (now ≤ t)
    | none => false

/-- The effect of one step on one envelope at time `now`. -/
def step (c : Coord) (now : Nat) : Step → Envelope → Envelope
  | .promote g to, e =>
    if e.status == .queued && decide (now < e.expiresAt) then
      { e with status := .processing, ownerGeneration := some g, appliedToEventId := some to }
    else e
  | .settle owner g o, e =>
    if requireOwner c owner g now && (e.eventId == owner || e.appliedToEventId == some owner) &&
        !e.status.terminal then
      { e with
        status := o.status
        stoppedByUser := e.stoppedByUser || (o == .failed && c.stopRequestedGeneration == some g) }
    else e
  | .expireQueued, e =>
    if e.status == .queued && decide (e.expiresAt ≤ now) then { e with status := .expired } else e
  | .expireStaleOwner, e =>
    match c.leaseExpiresAt with
    | some t =>
      if decide (t < now) && c.ownerEventId == some e.eventId && !e.status.terminal then
        { e with status := .expired }
      else e
    | none => e
  | .maintain, e =>
    if (e.status == .queued || e.status == .processing) && decide (e.expiresAt ≤ now) then
      match c.leaseExpiresAt with
      | some t =>
        if e.status == .processing && decide (now < t) &&
            e.ownerGeneration == some c.ownerGeneration then
          { e with expiresAt := t }
        else { e with status := .expired }
      | none => { e with status := .expired }
    else e

/-- Replays a run: each step with the coordinator and clock it saw. -/
def run (e : Envelope) (steps : List (Coord × Nat × Step)) : Envelope :=
  steps.foldl (fun e (c, now, s) => step c now s e) e

/-- The transitions a single step may make. -/
inductive Allowed : Status → Status → Prop where
  | stay (s : Status) : Allowed s s
  | start : Allowed .queued .processing
  | expireQueued : Allowed .queued .expired
  | expireRunning : Allowed .processing .expired
  | finish (o : Outcome) : Allowed .processing o.status
  /-- `settleAppliedEnvelopes` guards "not terminal", not "is processing". Unreached
  only because the owner row and the rows applied to it are never queued. -/
  | finishQueued (o : Outcome) : Allowed .queued o.status

/-- Status route merge (`handler.ts` status handler): the polling status wins while
waiting or while the envelope has not failed. -/
def mergedStatus (envelope : Status) (result : AgentStatus) : Sum AgentStatus Status :=
  match result with
  | .awaitingApproval | .awaitingInput => .inl result
  | .processing => if envelope == .failed then .inr envelope else .inl result
  | _ => .inr envelope

/-! ## Properties -/

/-- A finished run stays finished: no step moves a terminal envelope. -/
theorem terminal_absorbing {c : Coord} {now : Nat} {e : Envelope} (s : Step)
    (h : e.status.terminal = true) : (step c now s e).status = e.status := by
  cases s <;> cases hst : e.status <;> simp [Status.terminal, hst] at h <;>
    simp only [step, hst] <;> (repeat' split) <;> simp_all [Status.terminal]

/-- Over any sequence of steps, a terminal run keeps its status. -/
theorem run_terminal {e : Envelope} (steps : List (Coord × Nat × Step))
    (h : e.status.terminal = true) : (run e steps).status = e.status := by
  induction steps generalizing e with
  | nil => rfl
  | cons hd tl ih =>
    obtain ⟨c, now, s⟩ := hd
    have hs := terminal_absorbing (c := c) (now := now) s h
    simp only [run, List.foldl_cons] at ih ⊢
    rw [ih (by rw [hs]; exact h), hs]

/-- Every step is a forward transition: nothing re-opens a finished run and nothing
returns a running row to the queue. -/
theorem step_allowed {c : Coord} {now : Nat} {e : Envelope} (s : Step) :
    Allowed e.status (step c now s e).status := by
  cases s with
  | settle owner g o =>
    simp only [step]
    split
    · cases hst : e.status <;> simp_all [Status.terminal]
      · exact .finishQueued o
      · exact .finish o
    · exact .stay _
  | _ =>
    simp only [step]
    (repeat' split) <;> first
      | exact .stay _
      | (cases hst : e.status <;> simp_all [Status.terminal] <;> constructor)

/-- A settle writes only for the fenced owner, and `stoppedByUser` only for the
generation that `/stop` targeted, which is the owner's own generation. -/
theorem settle_fenced {c : Coord} {now owner g : Nat} {o : Outcome} {e : Envelope}
    (h : step c now (.settle owner g o) e ≠ e) :
    requireOwner c owner g now = true := by
  simp only [step] at h
  split at h
  · simp_all
  · exact absurd rfl h

theorem stop_scoped {c : Coord} {now owner g : Nat} {o : Outcome} {e : Envelope}
    (hb : e.stoppedByUser = false)
    (h : (step c now (.settle owner g o) e).stoppedByUser = true) :
    c.stopRequestedGeneration = some g ∧ c.ownerGeneration = g ∧ o = .failed := by
  simp only [step] at h
  split at h
  · rename_i hc
    simp only [requireOwner, Bool.and_eq_true, beq_iff_eq] at hc
    simp_all
  · simp_all

/-! ## Findings, as executable witnesses -/

/-- At `now = leaseExpiresAt` the fence still accepts the owner, but `maintain`
(which defers only when `now < leaseExpiresAt`) expires its running row, so the
owner's settle a moment later is a no-op on an `expired` run. -/
example :
    let c : Coord := ⟨1, some 7, some 10, none⟩
    let e : Envelope := ⟨7, .processing, 10, some 1, some 7, false⟩
    requireOwner c 7 1 10 = true ∧
      (step c 10 .maintain e).status = .expired ∧
      (run e [(c, 10, .maintain), (c, 10, .settle 7 1 .completed)]).status = .expired := by
  decide

/-- `handleAsyncWorkerRequest`, the path where the run settles `completed` and a
later await (`pushReplyToChannel`, `dispatchNextIngress`) throws. The catch retries
a fenced failed settle, which the envelope ignores, and then calls
`settleAsyncFailure` unless `guarded` (a `didSettle` check, which is absent today). -/
def asyncWorkerAfterThrow (c : Coord) (now owner g : Nat) (e : Envelope) (guarded : Bool) :
    Status × AgentStatus :=
  let settled := step c now (.settle owner g .completed) e
  let caught := step c now (.settle owner g .failed) settled
  (caught.status, if guarded then .completed else .failed)

/-- Today: the envelope says completed, the polling row says failed with its response
erased, and the status route reports `completed`. -/
example :
    let c : Coord := ⟨1, some 7, some 10, none⟩
    let e : Envelope := ⟨7, .processing, 20, some 1, some 7, false⟩
    asyncWorkerAfterThrow c 5 7 1 e false = (.completed, .failed) ∧
      mergedStatus .completed .failed = .inr .completed := by
  decide

/-- With the `didSettle` guard both rows agree for every owner and run. -/
theorem asyncWorker_guarded_agrees {c : Coord} {now owner g : Nat} {e : Envelope}
    (hfence : requireOwner c owner g now = true) (hown : e.eventId = owner)
    (hrun : e.status = .processing) :
    asyncWorkerAfterThrow c now owner g e true = (.completed, .completed) := by
  simp [asyncWorkerAfterThrow, step, hfence, hown, hrun, Status.terminal, Outcome.status]

end Broods.Ingress
