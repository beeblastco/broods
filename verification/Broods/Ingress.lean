/-!
# Run lifecycle

Model of one `runtimeIngressEnvelopes` row (the run behind `GET /v1/runs/{runId}`)
under the mutations in `packages/convex/runtimeIngress.ts`. Each mutation is a
Convex transaction, so a run is a sequence of `Step`s. The polling row written
next to it lives in `Broods.AsyncResults`.
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

/-- `TERMINAL_STATUSES` in `runtimeIngress.ts`. -/
def Status.terminal : Status → Bool
  | .completed | .failed | .expired => true
  | _ => false

/-- The envelope status a `settle` / `takeNext` outcome writes. -/
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
        e.status == .processing then
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
        if e.status == .processing && decide (now ≤ t) &&
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
    · rename_i hc
      simp only [Bool.and_eq_true, beq_iff_eq] at hc
      rw [hc.2]
      exact .finish o
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

/-- The expiry sweeps agree with the fence: while `requireOwner` accepts the
owner, neither `maintain` nor `expireStaleOwner` expires its running row. -/
theorem fence_agreement {c : Coord} {now owner : Nat} {e : Envelope}
    (hfence : requireOwner c owner c.ownerGeneration now = true)
    (hrun : e.status = .processing) (hgen : e.ownerGeneration = some c.ownerGeneration) :
    (step c now .maintain e).status = .processing ∧
      (step c now .expireStaleOwner e).status = .processing := by
  simp only [requireOwner, Bool.and_eq_true, beq_iff_eq] at hfence
  obtain ⟨-, hlease⟩ := hfence
  cases ht : c.leaseExpiresAt with
  | none => simp [ht] at hlease
  | some t =>
    simp only [ht, decide_eq_true_eq] at hlease
    have hlt : ¬ t < now := Nat.not_lt.mpr hlease
    constructor
    · simp only [step, ht, hrun, hgen]
      split <;> simp_all
    · simp [step, ht, hlt, hrun]

/-! ## Regression witnesses -/

/-- At `now = leaseExpiresAt` the fence accepts the owner, `maintain` defers its
running row, and the owner's settle completes the run. -/
example :
    let c : Coord := ⟨1, some 7, some 10, none⟩
    let e : Envelope := ⟨7, .processing, 10, some 1, some 7, false⟩
    requireOwner c 7 1 10 = true ∧
      (step c 10 .maintain e).status = .processing ∧
      (run e [(c, 10, .maintain), (c, 10, .settle 7 1 .completed)]).status = .completed := by
  decide

/-- A queued row that names the owner is left queued by its settle. -/
example :
    let c : Coord := ⟨1, some 7, some 10, none⟩
    let e : Envelope := ⟨8, .queued, 20, none, some 7, false⟩
    (step c 5 (.settle 7 1 .completed) e).status = .queued := by
  decide

end Broods.Ingress
