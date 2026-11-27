import Lean.Data.Json
import Spec.Workers.Model

/-!
Vectors for `formal/replay/workers.test.ts`. Each is a trace with the model's effects for every
input. The inputs come from a seeded generator, so a failure can be reproduced from its seed.
-/

namespace Spec.Workers.Replay

open Lean

/-- The limits the replay runs at. `MAX_PENDING_WORKER_RUNS` is a constant in the code; the other
two are set through the environment by the test command. -/
def limits : Limits :=
  { maxWorkers := 2, maxPending := 1000, maxSlots := 3 }

/-- An input as JSON. -/
def inputJson : Input → Json
  | .openPlace p => Json.mkObj [("kind", "openPlace"), ("place", toJson p)]
  | .closePlace p => Json.mkObj [("kind", "closePlace"), ("place", toJson p)]
  | .dispatch r place =>
    Json.mkObj [("kind", "dispatch"), ("run", toJson r), ("place", toJson place)]
  | .settle r => Json.mkObj [("kind", "settle"), ("run", toJson r)]
  | .overrun r => Json.mkObj [("kind", "overrun"), ("run", toJson r)]
  | .yieldSlot r => Json.mkObj [("kind", "yieldSlot"), ("run", toJson r)]

/-- An effect as JSON. -/
def effectJson : Effect → Json
  | .started r slot => Json.mkObj [("kind", "started"), ("run", toJson r), ("slot", toJson slot)]
  | .refused r => Json.mkObj [("kind", "refused"), ("run", toJson r)]
  | .placeRefused p => Json.mkObj [("kind", "placeRefused"), ("place", toJson p)]
  | .aborted r => Json.mkObj [("kind", "aborted"), ("run", toJson r)]

/-- A small linear congruential generator: the same seed gives the same vectors everywhere. -/
def nextSeed (seed : Nat) : Nat :=
  (seed * 6364136223846793005 + 1442695040888963407) % 18446744073709551616

/-- A choice below `bound`, taken from the high bits, which vary most. -/
def pick (seed bound : Nat) : Nat :=
  (seed / 4294967296) % bound

/-- One input, biased toward ones that change the state. Ids count up, so runs and places are
fresh; a run named at random can be in any phase, so wrong-phase inputs are exercised too. -/
def randomInput (seed fresh : Nat) (s : State) : Input :=
  let choice := pick seed 100
  let other := pick (nextSeed seed) (fresh + 1)
  let someRunning := s.running[pick (nextSeed seed) (s.running.length + 1)]?.getD other
  let somePlace := s.places[pick (nextSeed seed) (s.places.length + 1)]?.getD other
  if choice < 40 then .dispatch fresh none
  else if choice < 48 then .dispatch fresh (some somePlace)
  else if choice < 56 then .openPlace fresh
  else if choice < 62 then .closePlace somePlace
  else if choice < 80 then .settle someRunning
  else if choice < 86 then .overrun someRunning
  else if choice < 96 then .yieldSlot someRunning
  else .settle other

/-- Inputs that empty the queue, so the module's state is clean for the next vector. -/
def drainInputs (L : Limits) (s : State) : List Input :=
  let rec go : Nat → State → List Input → List Input
    | 0, _, acc => acc.reverse
    | fuel + 1, t, acc =>
      match t.running with
      | [] => acc.reverse
      | r :: _ => go fuel (step L t (.settle r)).1 (.settle r :: acc)
  let closed := s.places.foldl (fun t p => (step L t (.closePlace p)).1) s
  (s.places.map .closePlace) ++ go (s.running.length + s.pending.length + 1) closed []

/-- A random trace of `length` inputs, then a drain, with the model's effects for each input. -/
def randomVector (L : Limits) (seed length : Nat) : List Input :=
  let rec go : Nat → Nat → Nat → State → List Input → List Input
    | 0, _, _, s, acc => acc.reverse ++ drainInputs L s
    | n + 1, sd, fresh, s, acc =>
      let i := randomInput sd fresh s
      go n (nextSeed (nextSeed sd)) (fresh + 1) (step L s i).1 (i :: acc)
  go length seed 0 State.empty []

/-- A trace followed by the inputs that empty the queue. -/
def drained (L : Limits) (inputs : List Input) : List Input :=
  inputs ++ drainInputs L (inputs.foldl (fun t i => (step L t i).1) State.empty)

/-- `count` fresh runs, numbered from 0. -/
def fill (count : Nat) : List Input :=
  (List.range count).map fun r => Input.dispatch r none

/-- Runs past capacity are refused, and so is a place. -/
def floodVector (L : Limits) : List Input :=
  drained L (fill (cap L + 2) ++ [.openPlace 0])

/-- A place taken at capacity is never shed, and using it gives the unit back. -/
def placedAtCapacity (L : Limits) : List Input :=
  drained L (fill (cap L - 1) ++ [.openPlace 0, .dispatch 5000 (some 0), .settle 0, .openPlace 1])

/-- Held places count toward fullness: a second place and a fresh run are both refused. -/
def placesAtCapacity (L : Limits) : List Input :=
  drained L (fill (cap L - 1) ++ [.openPlace 0, .openPlace 1, .dispatch 6000 none])

/-- A yield in the capacity slack is not shed, even though the queue reads as full. This is the
trace from `Controls.shed_on_yield_drops_a_live_run`, scaled to the replay's limits. -/
def yieldInSlack (L : Limits) : List Input :=
  drained L ((List.range (cap L)).map .openPlace ++
    [.dispatch 0 none, .dispatch 1 none, .dispatch 2 (some 0), .yieldSlot 0])

/-- After an overrun, the run's stale yield handle does nothing. -/
def yieldAfterOverrun (L : Limits) : List Input :=
  drained L [.dispatch 0 none, .dispatch 1 none, .dispatch 2 none, .overrun 0, .yieldSlot 0]

/-- The directed vectors, each reaching a state random traces rarely reach. -/
def directed (L : Limits) : List (String × List Input) :=
  [("flood", floodVector L), ("placed-at-capacity", placedAtCapacity L),
    ("places-at-capacity", placesAtCapacity L), ("yield-in-slack", yieldInSlack L),
    ("yield-after-overrun", yieldAfterOverrun L)]

/-- A trace as one line of JSON, carrying the model's effects for each input. -/
def vectorJson (L : Limits) (name : String) (inputs : List Input) : Json :=
  let rec go : List Input → State → List Json → List Json
    | [], _, acc => acc.reverse
    | i :: rest, s, acc =>
      let next := step L s i
      let row := Json.mkObj [("input", inputJson i), ("effects", toJson (next.2.map effectJson))]
      go rest next.1 (row :: acc)
  Json.mkObj [("name", name), ("steps", toJson (go inputs State.empty []))]

/-- Prints the vectors, one per line. -/
def run (count length seed : Nat) : IO Unit := do
  for (name, inputs) in directed limits do
    IO.println (vectorJson limits name inputs).compress
  let mut sd := seed
  for index in [0:count] do
    IO.println (vectorJson limits s!"random-{index}" (randomVector limits sd length)).compress
    sd := nextSeed sd

end Spec.Workers.Replay
