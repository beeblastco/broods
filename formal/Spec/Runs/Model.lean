import Spec.Statements

/-! Atomic ingress contract for packages/convex/runtimeIngress.ts under A2; D6 and D8 are intended rules. -/
namespace Spec.Runs
inductive Mode where
  | reject | followup | collect | steer
  deriving DecidableEq, Repr
inductive Phase where
  | queued | processing | completed | failed | expired
  deriving DecidableEq, Repr
structure Row where
  key : Nat
  event : Nat
  digest : Nat
  mode : Mode
  sender : Nat
  expires : Nat
  phase : Phase
  generation : Nat := 0
  appliedTo : Nat := 0
  deriving DecidableEq, Repr
structure Owner where
  event : Nat
  generation : Nat
  deriving DecidableEq, Repr
structure State where
  rows : List Row := []
  owner : Option Owner := none
  generation : Nat := 0
  lease : Nat := 0
  stopped : Bool := false
  recoveryOffered : Bool := false
  writes : List Nat := []
  deriving DecidableEq, Repr
inductive Input where
  | accept (row : Row) (now ttl : Nat)
  | takeNext (owner : Owner) (now ttl : Nat)
  | applySteering (owner : Owner) (now ttl sender : Nat)
  | stepBoundary (owner : Owner) (now ttl : Nat) (claim : Bool) (sender : Nat)
  | settle (owner : Owner) (now : Nat) (failed : Bool)
  | renewOwner (owner : Owner) (now ttl : Nat)
  | releaseOwner (owner : Owner)
  | stopOwner (now : Nat)
  | recoverQueued (now ttl : Nat)
  | maintain (now : Nat)
  deriving Repr
inductive Effect where
  | admission (outcome : String)
  | applied (events : List Nat)
  | renewal (outcome : String)
  | written (event : Nat)
  deriving DecidableEq, Repr

def active (s : State) (now : Nat) : Bool := s.owner.isSome && decide (now ≤ s.lease)
def fence (s : State) (o : Owner) (now : Nat) : Bool :=
  s.owner == some o && active s now

def queued (s : State) : List Row := s.rows.filter (fun r => r.phase == .queued)
def mark (s : State) (selected : List Row) (o : Owner) : State :=
  { s with rows := s.rows.map (fun r => if r ∈ selected then
      { r with phase := .processing, generation := o.generation, appliedTo := o.event } else r) }
def promote (s : State) (now ttl : Nat) : State × List Effect :=
  match queued s with
  | [] => ({ s with owner := none, stopped := false, recoveryOffered := true }, [])
  | r :: rest =>
    let selected := if r.mode == .collect || r.mode == .steer then
      r :: rest.takeWhile (fun x => x.mode == r.mode && x.sender == r.sender) else [r]
    let o := { event := r.event, generation := s.generation + 1 : Owner }
    ({ mark s selected o with owner := some o, generation := o.generation, lease := now + ttl, stopped := false, recoveryOffered := false },
      [.applied (selected.map (·.event))])
def renew (s : State) (now ttl : Nat) : State :=
  if (s.lease - now) * 10 > ttl * 9 then s else { s with lease := now + ttl }
def finish (s : State) (o : Owner) (failed : Bool) : State :=
  { s with rows := s.rows.map (fun r =>
      if r.phase == .processing && r.appliedTo == o.event then
        { r with phase := if failed then .failed else .completed } else r) }
def steer (s : State) (o : Owner) (now ttl sender : Nat) : State × List Effect :=
  if s.stopped then (s, []) else
  let selected := (queued s).takeWhile (fun r => r.mode == .steer && r.sender == sender)
  ({ mark s selected o with lease := now + ttl },
    if selected.isEmpty then [] else [.applied (selected.map (·.event))])

/-- D6: no queue expiry until recovery has been offered after lease loss; promotion precedes expiry. -/
def maintainRow (s : State) (now : Nat) (r : Row) : Row :=

      if r.phase == .queued && !active s now && s.recoveryOffered && r.expires ≤ now then
        { r with phase := .expired }
      else if r.phase == .processing && !active s now && r.expires ≤ now then
        { r with phase := .expired } else r

def maintain (s : State) (now : Nat) : State :=
  { s with rows := s.rows.map (maintainRow s now) }

def step (s : State) : Input → State × List Effect
  | .accept r now ttl =>
    match s.rows.find? (fun x => x.key == r.key) with
    | some old => (s, [.admission (if old.digest == r.digest then "duplicate" else "conflict")])
    | none =>
      let ready := if active s now then s else (promote s now ttl).1
      if active ready now && r.mode == .reject then (ready, [.admission "rejected"])
      else if active ready now then
        ({ ready with rows := ready.rows ++ [{ r with phase := .queued }], recoveryOffered := false },
          [.admission "queued"])
      else
        let o := { event := r.event, generation := ready.generation + 1 : Owner }
        ({ ready with rows := ready.rows ++ [{ r with phase := .processing, generation := o.generation, appliedTo := o.event }], owner := some o, generation := o.generation, lease := now + ttl, recoveryOffered := false }, [.admission "owner"])
  | .takeNext o now ttl => if fence s o now then promote (finish s o false) now ttl else (s, [])
  | .applySteering o now ttl sender => if fence s o now then steer s o now ttl sender else (s, [])
  | .stepBoundary o now ttl claim sender =>
    if !fence s o now then (s, [.renewal "stale"]) else
    let saved := { s with writes := s.writes ++ [o.event] }
    if s.stopped then (saved, [.written o.event, .renewal "stopped"])
    else if claim then
      let next := steer saved o now ttl sender
      (next.1, .written o.event :: .renewal "renewed" :: next.2)
    else (renew saved now ttl, [.written o.event, .renewal "renewed"])
  | .settle o now failed => if fence s o now then (finish s o failed, []) else (s, [])
  | .renewOwner o now ttl =>
    if !fence s o now then (s, [.renewal "stale"])
    else if s.stopped then (s, [.renewal "stopped"])
    else (renew s now ttl, [.renewal "renewed"])
  | .releaseOwner o =>
    if s.owner == some o then ({ s with owner := none, stopped := false, recoveryOffered := false }, [])
    else (s, [])
  | .stopOwner now => if active s now then ({ s with stopped := true }, []) else (s, [])
  | .recoverQueued now ttl => if active s now then (s, []) else promote s now ttl
  | .maintain now => (maintain s now, [])
abbrev system : Spec.System := ⟨State, Input, Effect, {}, step⟩

/-- handler.ts:2009: awaiting states dominate even a failed envelope; processing does not. -/
def pollStatus (envelope : String) (asyncStatus : Option String) : String :=
  match asyncStatus with
  | none => envelope
  | some a => if a == "awaiting_approval" || a == "awaiting_input" ||
      (a == "processing" && envelope != "failed") then a else envelope

/-- continuation.ts:320: failure precedes approvals, then questions. -/
def turnStatus (failed approvals questions : Bool) : String :=
  if failed then "failed" else if approvals then "awaiting_approval"
  else if questions then "awaiting_input" else "completed"

/-- worker-queue.ts:157-197: exceptions retain the lease; stopped/stale relinquish it. -/
def queuedLease (held : Bool) (result : Option String) : Bool :=
  held && match result with | none => true | some r => r == "renewed"

/-- D8/G3: a terminal async row requires a continuation tied to its own run. -/
def asyncWrite (terminal : Bool) (run : Nat) (continuation : Option Nat) : Bool :=
  !terminal || continuation == some run

/-- Independent conversation state; account/agent authorization is a precondition of routing (L201). -/
abbrev World := Nat → State
structure RoutedInput where
  conversation : Nat
  input : Input
abbrev RoutedEffect := Nat × Effect

def worldStep (s : World) (i : RoutedInput) : World × List RoutedEffect :=
  let next := step (s i.conversation) i.input
  (fun c => if c = i.conversation then next.1 else s c,
    next.2.map (fun e => (i.conversation, e)))
abbrev worldSystem : Spec.System := ⟨World, RoutedInput, RoutedEffect, fun _ => {}, worldStep⟩
def ownInputs (party : Nat) (trace : List RoutedInput) : List Input :=
  (trace.filter (fun i => i.conversation == party)).map (·.input)
def observations (party : Nat) (effects : List RoutedEffect) : List Effect :=
  (effects.filter (fun e => e.1 == party)).map (·.2)
end Spec.Runs
