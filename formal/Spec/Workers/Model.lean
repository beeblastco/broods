import Spec.Statements

/-!
The in-process worker queue: `apps/core/src/harness/worker-queue.ts`. Every agent run takes a slot
here. `running`, `places` and the run phases are ghost state: the code keeps only the two counters
and the pending list, and the proofs show the counters agree with the ghost state.
-/

namespace Spec.Workers

/-- A run's name. The code has no id: each `dispatchInProcessWorker` call is one run. -/
abbrev RunId := Nat

/-- A `withQueuePlace` call's name. -/
abbrev PlaceId := Nat

/-- `MAX_INPROCESS_WORKERS`, `MAX_PENDING_WORKER_RUNS` and `MAX_RUN_SLOTS`. -/
structure Limits where
  maxWorkers : Nat
  maxPending : Nat
  maxSlots : Nat
  deriving Repr

/-- The limits the code runs with unless the environment overrides them. Theorems hold at any
limits with `0 < maxSlots`. -/
def Limits.default : Limits :=
  { maxWorkers := 8, maxPending := 1000, maxSlots := 6 }

/-- Where a run is. The number counts the slots it has held so far. -/
inductive Phase where
  | absent
  | waiting (slotsUsed : Nat)
  | running (slotsUsed : Nat)
  | finished
  | refused
  deriving DecidableEq, Repr

/-- The queue's state. `active`, `pending` and `held` are the code's own variables. -/
structure State where
  active : Nat
  pending : List RunId
  held : Nat
  running : List RunId
  places : List PlaceId
  phase : RunId → Phase

/-- What a test or a run can do to the queue. A slot timer firing is an input too. -/
inductive Input where
  | openPlace (p : PlaceId)
  | closePlace (p : PlaceId)
  | dispatch (r : RunId) (place : Option PlaceId)
  | settle (r : RunId)
  | overrun (r : RunId)
  | yieldSlot (r : RunId)
  deriving Repr

/-- What the queue does that the outside world can see. `started` fires for a first slot and for a
slot after a yield, and its number is the slot's position for that run. -/
inductive Effect where
  | started (r : RunId) (slot : Nat)
  | refused (r : RunId)
  | placeRefused (p : PlaceId)
  | aborted (r : RunId)
  deriving DecidableEq, Repr

/-- The queue before any run. -/
def State.empty : State :=
  { active := 0, pending := [], held := 0, running := [], places := [], phase := fun _ => .absent }

/-- The state with one run's phase replaced. -/
def State.setPhase (s : State) (r : RunId) (p : Phase) : State :=
  { s with phase := fun x => if x = r then p else s.phase x }

/-- `MAX_INPROCESS_WORKERS + MAX_PENDING_WORKER_RUNS`. -/
def cap (L : Limits) : Nat :=
  L.maxWorkers + L.maxPending

/-- `workerQueueFull`. -/
def full (L : Limits) (s : State) : Bool :=
  decide (cap L ≤ s.active + s.pending.length + s.held)

/-- `takeSlot`: the run holds a slot now. -/
def start (s : State) (r : RunId) (used : Nat) : State × List Effect :=
  ({ s.setPhase r (.running (used + 1)) with
      active := s.active + 1
      running := r :: s.running },
    [.started r (used + 1)])

/-- `enqueueWorker`: run now if a slot is free, otherwise wait, refusing a sheddable run when the
queue is full. -/
def enqueue (L : Limits) (s : State) (r : RunId) (used : Nat) (loadShed : Bool) :
    State × List Effect :=
  if s.active < L.maxWorkers then
    start s r used
  else if loadShed && full L s then
    (s.setPhase r .refused, [.refused r])
  else
    ({ s.setPhase r (.waiting used) with pending := s.pending ++ [r] }, [])

/-- The run gives up its slot and is finished. -/
def State.free (s : State) (r : RunId) : State :=
  { s with
      active := s.active - 1
      running := s.running.erase r
      phase := fun x => if x = r then .finished else s.phase x }

/-- The state with the queue replaced. -/
def State.withPending (s : State) (rest : List RunId) : State :=
  { s with pending := rest }

/-- `releaseSlot` with `startNextWorker`: the slot goes to the head of the queue, if there is one. -/
def release (s : State) (r : RunId) : State × List Effect :=
  match s.pending with
  | [] => (s.free r, [])
  | next :: rest =>
    match s.phase next with
    | .waiting used => start ((s.free r).withPending rest) next used
    | _ => ((s.free r).withPending rest, [])

/-- One input. An input that names a run or place in the wrong phase does nothing: the code cannot
reach it, because the handle to call only exists in the right phase. -/
def step (L : Limits) (s : State) : Input → State × List Effect
  | .openPlace p =>
    if p ∈ s.places then (s, [])
    else if full L s then (s, [.placeRefused p])
    else ({ s with held := s.held + 1, places := p :: s.places }, [])
  | .closePlace p =>
    if p ∈ s.places then
      ({ s with held := s.held - 1, places := s.places.erase p }, [])
    else (s, [])
  | .dispatch r place =>
    match s.phase r with
    | .absent =>
      match place with
      | some p =>
        if p ∈ s.places then
          enqueue L { s with held := s.held - 1, places := s.places.erase p } r 0 false
        else enqueue L s r 0 true
      | none => enqueue L s r 0 true
    | _ => (s, [])
  | .settle r =>
    match s.phase r with
    | .running _ => release s r
    | _ => (s, [])
  | .overrun r =>
    match s.phase r with
    | .running _ =>
      let done := release s r
      (done.1, .aborted r :: done.2)
    | _ => (s, [])
  | .yieldSlot r =>
    match s.phase r with
    | .running used =>
      if used < L.maxSlots then
        let freed := release s r
        let queued := enqueue L freed.1 r used false
        (queued.1, freed.2 ++ queued.2)
      else (s, [])
    | _ => (s, [])

/-- The queue as a transition system. -/
def system (L : Limits) : Spec.System where
  State := State
  Input := Input
  Effect := Effect
  init := State.empty
  step := step L

end Spec.Workers
