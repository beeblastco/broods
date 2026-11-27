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
  /-- `statusExpiresAt`: maintenance deletes the row once it is terminal and this has passed. -/
  retainUntil : Nat
  generation : Nat := 0
  appliedTo : Nat := 0
  /-- A late-result resume: it tells the late result named by its `key`. -/
  resume : Bool := false
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
  /-- The late results the conversation has stored (`handback: "stored"`), by resume key. -/
  stored : List Nat := []
  /-- The account row's status. `requireActiveAccount` refuses `accept`, `stopOwner`, and every
  fenced write that carries history rows or an async result; `recoverQueued` skips the account. -/
  accountActive : Bool := true
  deriving DecidableEq, Repr
inductive Input where
  | accept (row : Row) (now ttl : Nat)
  /-- `settles`: the call carries the owner's settle (core's drain after a separate settle does not);
  `rows`: it carries the turn's pending history rows. -/
  | takeNext (owner : Owner) (now ttl : Nat) (settles rows : Bool)
  | applySteering (owner : Owner) (now ttl sender : Nat)
  /-- `results`: the late results whose events the write carries, named by the key of the resume
  envelope that tells them. -/
  | stepBoundary (owner : Owner) (now ttl : Nat) (claim : Bool) (sender : Nat) (results : List Nat)
  /-- A settle may carry the turn's last history rows (`results` as for `stepBoundary`) and a
  background run's outcome for its polling row (`asyncResult`). -/
  | settle (owner : Owner) (now : Nat) (failed : Bool) (results : List Nat) (asyncResult : Bool)
  | renewOwner (owner : Owner) (now ttl : Nat)
  /-- `requeue`: a full pod shed the owner's dispatch, so the rows it took go back to the queue. -/
  | releaseOwner (owner : Owner) (requeue : Bool)
  | stopOwner (now : Nat)
  | recoverQueued (now ttl : Nat)
  /-- Recovery visited the conversation and promoted nothing: the account is not active. -/
  | declineRecovery (now : Nat)
  | maintain (now : Nat)
  /-- The operator activates or suspends the account. -/
  | status (active : Bool)
  deriving Repr
inductive Effect where
  | admission (outcome : String)
  | applied (events : List Nat)
  | renewal (outcome : String)
  | written (event : Nat)
  /-- The mutation threw `Account is not active` and wrote nothing. -/
  | refused
  deriving DecidableEq, Repr

def active (s : State) (now : Nat) : Bool := s.owner.isSome && decide (now ≤ s.lease)
def fence (s : State) (o : Owner) (now : Nat) : Bool :=
  s.owner == some o && active s now

def queued (s : State) : List Row := s.rows.filter (fun r => r.phase == .queued)
def terminal (r : Row) : Bool := r.phase == .completed || r.phase == .failed || r.phase == .expired
/-- `undeliveredResume`: a finished resume whose result was never stored is admitted again. -/
def undelivered (s : State) (r : Row) : Bool := r.resume && terminal r && !s.stored.contains r.key
/-- D6: queued work expires only with no live owner, after recovery was offered, past its TTL. -/
def mayExpire (s : State) (now : Nat) (r : Row) : Bool :=
  r.phase == .queued && !active s now && s.recoveryOffered && decide (r.expires ≤ now)
/-- `expireQueuedEnvelopes`, run by admission, takeNext, steering and recovery, under D6. -/
def expireQueued (s : State) (now : Nat) : State :=
  { s with rows := s.rows.map (fun r => if mayExpire s now r then { r with phase := .expired } else r) }
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
/-- A fenced write carrying the events of `results` marks those late results stored
(`insertConversationEvents`), so no resume of them is undelivered any more. -/
def storeResults (s : State) (results : List Nat) : State :=
  { s with stored := s.stored ++ results }
/-- The owner's step-boundary write: it appends history and stores the results it carries. -/
def store (s : State) (o : Owner) (results : List Nat) : State :=
  { storeResults s results with writes := s.writes ++ [o.event] }
/-- `releaseOwner` with `requeue`: each row processing under this owner and generation is queued
again in place, so in its old order, with no owner (`releaseOwner`, `runtimeIngress.ts:772`). -/
def requeueRow (o : Owner) (r : Row) : Row :=
  if r.phase == .processing && r.appliedTo == o.event && r.generation == o.generation then
    { r with phase := .queued, generation := 0, appliedTo := 0 } else r
def requeue (s : State) (o : Owner) : State :=
  { s with rows := s.rows.map (requeueRow o) }
/-- `takeNext` in an account that is not active: after the settle and the expiry pass it promotes
nothing and clears the owner, so the queue waits for recovery after reactivation. -/
def holdQueue (s : State) : State :=
  { s with owner := none, stopped := false, recoveryOffered := false }
def renew (s : State) (now ttl : Nat) : State :=
  if (s.lease - now) * 10 > ttl * 9 then s else { s with lease := now + ttl }
def finish (s : State) (o : Owner) (failed : Bool) : State :=
  { s with rows := s.rows.map (fun r =>
      if r.phase == .processing && r.appliedTo == o.event then
        { r with phase := if failed then .failed else .completed } else r) }
def steer (s : State) (o : Owner) (now ttl sender : Nat) : State × List Effect :=
  if s.stopped then (s, []) else
  let swept := expireQueued s now
  let selected := (queued swept).takeWhile (fun r => r.mode == .steer && r.sender == sender)
  ({ mark swept selected o with lease := now + ttl },
    if selected.isEmpty then [] else [.applied (selected.map (·.event))])

/-- `maintain`'s expiry pass: queued rows under D6, processing rows of a dead owner. -/
def maintainRow (s : State) (now : Nat) (r : Row) : Row :=
  if mayExpire s now r then { r with phase := .expired }
  else if r.phase == .processing && !active s now && r.expires ≤ now then
    { r with phase := .expired } else r

/-- `maintain` expires due rows, then deletes terminal rows whose retention has passed (G200). -/
def maintain (s : State) (now : Nat) : State :=
  let kept := fun r => !(terminal r && decide (r.retainUntil ≤ now))
  { s with rows := (s.rows.map (maintainRow s now)).filter kept }

/-- `prepareAdmissionCoordinator` and FIFO recovery: sweep, then promote queued work of a dead owner. -/
def prepare (s : State) (now ttl : Nat) : State :=
  if active s now then expireQueued s now else (promote (expireQueued s now) now ttl).1

/-- Admission after the idempotency check: a client-chosen event id is unique too. -/
def admit (s : State) (r : Row) (now ttl : Nat) : State × List Effect :=
  if s.rows.any (fun x => x.event == r.event) then (s, [.admission "conflict"]) else
  let ready := prepare s now ttl
  if active ready now && r.mode == .reject then (ready, [.admission "rejected"])
  else if active ready now then
    ({ ready with rows := ready.rows ++ [{ r with phase := .queued }], recoveryOffered := false },
      [.admission "queued"])
  else
    let o := { event := r.event, generation := ready.generation + 1 : Owner }
    ({ ready with rows := ready.rows ++ [{ r with phase := .processing, generation := o.generation, appliedTo := o.event }], owner := some o, generation := o.generation, lease := now + ttl, recoveryOffered := false }, [.admission "owner"])

def step (s : State) : Input → State × List Effect
  | .accept r now ttl =>
    if !s.accountActive then (s, [.refused]) else
    match s.rows.find? (fun x => x.key == r.key) with
    | some old =>
      if undelivered s old then admit { s with rows := s.rows.filter (fun x => x.key != r.key) } r now ttl
      else (s, [.admission (if old.digest == r.digest then "duplicate" else "conflict")])
    | none => admit s r now ttl
  | .takeNext o now ttl settles rows =>
    if fence s o now then
      if !s.accountActive && rows then (s, [.refused]) else
      let swept := expireQueued (if settles then finish s o false else s) now
      if s.accountActive then promote swept now ttl else (holdQueue swept, [])
    else (s, [])
  | .applySteering o now ttl sender => if fence s o now then steer s o now ttl sender else (s, [])
  | .stepBoundary o now ttl claim sender results =>
    if !fence s o now then (s, [.renewal "stale"]) else
    if !s.accountActive && !results.isEmpty then (s, [.refused]) else
    let saved := store s o results
    if s.stopped then (saved, [.written o.event, .renewal "stopped"])
    else if claim then
      let next := steer saved o now ttl sender
      (next.1, .written o.event :: .renewal "renewed" :: next.2)
    else (renew saved now ttl, [.written o.event, .renewal "renewed"])
  | .settle o now failed results asyncResult =>
    if !fence s o now then (s, [])
    else if !s.accountActive && (!results.isEmpty || asyncResult) then (s, [.refused])
    else (finish (storeResults s results) o failed, [])
  | .renewOwner o now ttl =>
    if !fence s o now then (s, [.renewal "stale"])
    else if s.stopped then (s, [.renewal "stopped"])
    else (renew s now ttl, [.renewal "renewed"])
  | .releaseOwner o requeued =>
    if s.owner == some o then (holdQueue (if requeued then requeue s o else s), [])
    else (s, [])
  | .stopOwner now =>
    if !s.accountActive then (s, [.refused])
    else if active s now then ({ s with stopped := true }, []) else (s, [])
  | .recoverQueued now ttl =>
    if active s now || !s.accountActive then (s, []) else promote (expireQueued s now) now ttl
  | .declineRecovery now =>
    if active s now then (s, []) else ({ s with recoveryOffered := true }, [])
  | .maintain now => (maintain s now, [])
  | .status a => ({ s with accountActive := a }, [])
abbrev system : Spec.System := ⟨State, Input, Effect, {}, step⟩

/-- The clock reading an input carries; `releaseOwner` carries none. -/
def Input.time : Input → Option Nat
  | .accept _ now _ | .takeNext _ now _ _ _ | .applySteering _ now _ _ | .stepBoundary _ now _ _ _ _
  | .settle _ now _ _ _ | .renewOwner _ now _ | .stopOwner now | .recoverQueued now _
  | .declineRecovery now | .maintain now => some now
  | .releaseOwner _ _ | .status _ => none

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
