import Lean.Data.Json
import Spec.Runs.Model
namespace Spec.Runs.Replay
open Lean

def row (key : Nat) (mode : Mode := .followup) : Row :=
  ⟨key, key, key, mode, 0, 10, .queued, 0, 0⟩
def owner : Owner := ⟨1, 1⟩
def phase : Phase → String
  | .queued => "queued" | .processing => "processing" | .completed => "completed"
  | .failed => "failed" | .expired => "expired"
def mode : Mode → String
  | .reject => "reject" | .followup => "followup" | .collect => "collect" | .steer => "steer"
def inputJson : Input → Json
  | .accept r now ttl => Json.mkObj [("op", toJson "accept"), ("key", toJson r.key),
      ("mode", toJson (mode r.mode)), ("now", toJson now), ("ttl", toJson ttl)]
  | .takeNext o now ttl => owned "takeNext" o now ttl
  | .applySteering o now ttl _ => owned "applySteering" o now ttl
  | .stepBoundary o now ttl claim _ => Json.mkObj [("op", toJson "stepBoundary"),
      ("event", toJson o.event), ("generation", toJson o.generation), ("now", toJson now),
      ("ttl", toJson ttl), ("claim", toJson claim)]
  | .settle o now failed => Json.mkObj [("op", toJson "settle"), ("event", toJson o.event),
      ("generation", toJson o.generation), ("now", toJson now), ("failed", toJson failed)]
  | .renewOwner o now ttl => owned "renewOwner" o now ttl
  | .releaseOwner o => owned "releaseOwner" o 0 0
  | .stopOwner now => Json.mkObj [("op", toJson "stopOwner"), ("now", toJson now)]
  | .recoverQueued now ttl => Json.mkObj [("op", toJson "recoverQueued"), ("now", toJson now), ("ttl", toJson ttl)]
  | .maintain now => Json.mkObj [("op", toJson "maintain"), ("now", toJson now)]
where
  owned (op : String) (o : Owner) (now ttl : Nat) : Json := Json.mkObj [
    ("op", toJson op), ("event", toJson o.event), ("generation", toJson o.generation),
    ("now", toJson now), ("ttl", toJson ttl)]
def traces : List (String × List Input) := [
  ("duplicate", [.accept (row 1) 0 100, .accept (row 1) 1 100]),
  ("fifo", [.accept (row 1) 0 100, .accept (row 2) 1 100, .accept (row 3) 2 100,
    .takeNext owner 3 100, .takeNext ⟨2, 2⟩ 4 100]),
  ("stale", [.accept (row 1) 0 100, .stepBoundary ⟨1, 0⟩ 1 100 false 0,
    .renewOwner ⟨1, 0⟩ 1 100, .settle ⟨1, 0⟩ 1 false]),
  ("boundary-stop", [.accept (row 1) 0 100, .stepBoundary owner 1 100 false 0,
    .stopOwner 2, .renewOwner owner 2 100, .stepBoundary owner 2 100 true 0]),
  ("steering", [.accept (row 1) 0 100, .accept (row 2 .steer) 1 100,
    .applySteering owner 2 100 0, .settle owner 3 false]),
  ("steering-barrier", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .accept (row 3 .steer) 2 100, .applySteering owner 3 100 0]),
  ("release-recover", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .settle owner 2 false, .releaseOwner owner, .recoverQueued 3 100]),
  ("collect", [.accept (row 1) 0 100, .accept (row 2 .collect) 1 100,
    .accept (row 3 .collect) 2 100, .takeNext owner 3 100]),
  ("G1-live", [.accept (row 1) 0 100, .accept (row 2) 1 100, .maintain 11]),
  ("G1-recovery", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .settle owner 2 false, .releaseOwner owner, .maintain 11, .recoverQueued 12 100])]
def vectorJson (name : String) (inputs : List Input) : Json :=
  let rec go : State → List Input → List Json
    | _, [] => []
    | s, i :: rest =>
      let n := (step s i).1
      Json.mkObj [("input", inputJson i), ("rows", toJson (n.rows.map (fun r =>
        Json.mkObj [("key", toJson r.key), ("status", toJson (phase r.phase))]))),
        ("generation", toJson n.generation)] :: go n rest
  Json.mkObj [("name", toJson name), ("steps", toJson (go {} inputs))]
def run (_args : List String) : IO Unit := do
  for (name, inputs) in traces do IO.println (vectorJson name inputs).compress
end Spec.Runs.Replay
