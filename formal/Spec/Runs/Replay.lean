import Lean.Data.Json
import Spec.Runs.Model
namespace Spec.Runs.Replay
open Lean

def row (key : Nat) (mode : Mode := .followup) : Row :=
  { key := key, event := key, digest := key, mode := mode, sender := 0, expires := 10, retainUntil := 1000, phase := .queued }
def owner : Owner := ⟨1, 1⟩
def phase : Phase → String
  | .queued => "queued" | .processing => "processing" | .completed => "completed"
  | .failed => "failed" | .expired => "expired"
def mode : Mode → String
  | .reject => "reject" | .followup => "followup" | .collect => "collect" | .steer => "steer"
def inputJson : Input → Json
  | .accept r now ttl => Json.mkObj [("op", toJson "accept"), ("key", toJson r.key),
      ("event", toJson r.event), ("mode", toJson (mode r.mode)), ("now", toJson now),
      ("ttl", toJson ttl), ("retain", toJson r.retainUntil), ("resume", toJson r.resume)]
  | .takeNext o now ttl settles rows => Json.mkObj [("op", toJson "takeNext"),
      ("event", toJson o.event), ("generation", toJson o.generation), ("now", toJson now),
      ("ttl", toJson ttl), ("settles", toJson settles), ("rows", toJson rows)]
  | .applySteering o now ttl _ => owned "applySteering" o now ttl
  | .stepBoundary o now ttl claim _ results => Json.mkObj [("op", toJson "stepBoundary"),
      ("event", toJson o.event), ("generation", toJson o.generation), ("now", toJson now),
      ("ttl", toJson ttl), ("claim", toJson claim), ("results", toJson results)]
  | .settle o now failed results asyncResult => Json.mkObj [("op", toJson "settle"),
      ("event", toJson o.event), ("generation", toJson o.generation), ("now", toJson now),
      ("failed", toJson failed), ("results", toJson results), ("asyncResult", toJson asyncResult)]
  | .status active => Json.mkObj [("op", toJson "status"), ("active", toJson active)]
  | .renewOwner o now ttl => owned "renewOwner" o now ttl
  | .releaseOwner o requeue => Json.mkObj [("op", toJson "releaseOwner"),
      ("event", toJson o.event), ("generation", toJson o.generation), ("requeue", toJson requeue)]
  | .stopOwner now => Json.mkObj [("op", toJson "stopOwner"), ("now", toJson now)]
  | .recoverQueued now ttl => Json.mkObj [("op", toJson "recoverQueued"), ("now", toJson now), ("ttl", toJson ttl)]
  | .declineRecovery now => Json.mkObj [("op", toJson "declineRecovery"), ("now", toJson now)]
  | .maintain now => Json.mkObj [("op", toJson "maintain"), ("now", toJson now)]
where
  owned (op : String) (o : Owner) (now ttl : Nat) : Json := Json.mkObj [
    ("op", toJson op), ("event", toJson o.event), ("generation", toJson o.generation),
    ("now", toJson now), ("ttl", toJson ttl)]
def traces : List (String × List Input) := [
  ("duplicate", [.accept (row 1) 0 100, .accept (row 1) 1 100]),
  ("fifo", [.accept (row 1) 0 100, .accept (row 2) 1 100, .accept (row 3) 2 100,
    .takeNext owner 3 100 true false, .takeNext ⟨2, 2⟩ 4 100 true false]),
  ("stale", [.accept (row 1) 0 100, .stepBoundary ⟨1, 0⟩ 1 100 false 0 [],
    .renewOwner ⟨1, 0⟩ 1 100, .settle ⟨1, 0⟩ 1 false [] false]),
  ("boundary-stop", [.accept (row 1) 0 100, .stepBoundary owner 1 100 false 0 [],
    .stopOwner 2, .renewOwner owner 2 100, .stepBoundary owner 2 100 true 0 []]),
  ("steering", [.accept (row 1) 0 100, .accept (row 2 .steer) 1 100,
    .applySteering owner 2 100 0, .settle owner 3 false [] false]),
  ("steering-barrier", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .accept (row 3 .steer) 2 100, .applySteering owner 3 100 0]),
  ("release-recover", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .settle owner 2 false [] false, .releaseOwner owner false, .recoverQueued 3 100]),
  ("collect", [.accept (row 1) 0 100, .accept (row 2 .collect) 1 100,
    .accept (row 3 .collect) 2 100, .takeNext owner 3 100 true false]),
  ("decline-expiry", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .settle owner 2 false [] false, .releaseOwner owner false, .declineRecovery 3, .maintain 11]),
  ("decline-recover", [.accept (row 1) 0 100, .accept (row 2) 1 100, .accept (row 3) 2 100,
    .settle owner 3 false [] false, .releaseOwner owner false, .declineRecovery 4, .recoverQueued 11 100]),
  ("event-conflict", [.accept (row 1) 0 100, .accept { row 2 with event := 1 } 1 100]),
  ("resume-readmitted", [.accept { row 1 with resume := true } 0 100, .settle owner 1 false [] false,
    .releaseOwner owner false, .accept { row 1 with resume := true } 2 100]),
  ("resume-stored", [.accept { row 1 with resume := true } 0 100, .stepBoundary owner 1 100 false 0 [1],
    .settle owner 2 false [] false, .releaseOwner owner false, .accept { row 1 with resume := true } 3 100]),
  ("resume-boundary-no-result", [.accept { row 1 with resume := true } 0 100,
    .stepBoundary owner 1 100 false 0 [], .settle owner 2 false [] false, .releaseOwner owner false,
    .accept { row 1 with resume := true } 3 100]),
  ("resume-settle-stores", [.accept { row 1 with resume := true } 0 100, .settle owner 1 false [1] false,
    .releaseOwner owner false, .accept { row 1 with resume := true } 2 100]),
  ("inactive-settle-drain", [.accept (row 1) 0 100, .accept (row 2) 1 100, .status false,
    .settle owner 2 false [9] false, .settle owner 2 true [] true, .takeNext owner 3 100 true false,
    .accept (row 3) 4 100, .stopOwner 4, .recoverQueued 5 100, .status true, .recoverQueued 6 100]),
  ("inactive-inline-takeNext", [.accept (row 1) 0 100, .accept (row 2) 1 100, .status false,
    .takeNext owner 2 100 true true, .settle owner 2 false [] false, .releaseOwner owner false,
    .recoverQueued 3 100]),
  ("requeue-shed", [.accept (row 1) 0 100, .accept (row 2) 1 100, .accept (row 3) 2 100,
    .takeNext owner 3 100 true false, .releaseOwner ⟨2, 2⟩ true, .recoverQueued 4 100]),
  ("requeue-collect", [.accept (row 1) 0 100, .accept (row 2 .collect) 1 100,
    .accept (row 3 .collect) 2 100, .accept (row 4) 3 100, .takeNext owner 4 100 true false,
    .releaseOwner ⟨2, 2⟩ true, .accept (row 5) 5 100]),
  ("requeue-stale", [.accept (row 1) 0 100, .accept (row 2) 1 100, .takeNext owner 2 100 true false,
    .releaseOwner ⟨2, 1⟩ true, .releaseOwner owner true, .settle ⟨2, 2⟩ 3 false [] false,
    .releaseOwner ⟨2, 2⟩ true]),
  ("requeue-admitted-owner", [.accept (row 1) 0 100, .stepBoundary owner 1 100 false 0 [],
    .releaseOwner owner true, .recoverQueued 2 100, .settle ⟨1, 2⟩ 3 false [] false]),
  ("retention-delete", [.accept { row 1 with retainUntil := 5 } 0 100, .settle owner 1 false [] false,
    .releaseOwner owner false, .maintain 6, .accept (row 1) 7 100]),
  ("G1-live", [.accept (row 1) 0 100, .accept (row 2) 1 100, .maintain 11]),
  ("G1-recovery", [.accept (row 1) 0 100, .accept (row 2) 1 100,
    .settle owner 2 false [] false, .releaseOwner owner false, .maintain 11, .recoverQueued 12 100])]
def vectorJson (name : String) (inputs : List Input) : Json :=
  let rec go : State → List Input → List Json
    | _, [] => []
    | s, i :: rest =>
      let n := (step s i).1
      Json.mkObj [("input", inputJson i), ("refused", toJson ((step s i).2.contains .refused)), ("rows", toJson (n.rows.map (fun r =>
        Json.mkObj [("key", toJson r.key), ("status", toJson (phase r.phase))]))),
        ("generation", toJson n.generation)] :: go n rest
  Json.mkObj [("name", toJson name), ("steps", toJson (go {} inputs))]
def run (_args : List String) : IO Unit := do
  for (name, inputs) in traces do IO.println (vectorJson name inputs).compress
end Spec.Runs.Replay
