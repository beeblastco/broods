import Spec.Channels.Model
import Spec.Channels.CronLifecycle
import Lean
namespace Spec.Channels
open Lean

def vector (kind : String) (input expected : Json) : Json :=
  Json.mkObj [("kind", toJson kind), ("input", input), ("expected", expected)]

/-- Directed vectors plus a fixed LCG seed; no shared replay executable needs rebuilding. -/
def vectors : List Json := Id.run do
  let mut out := []
  let mut seed := 20261105
  for i in List.range 80 do
    seed := (1664525 * seed + 1013904223) % 4294967296
    let a := [seed % 5, (seed / 5) % 5, 8]
    let r := if i % 4 == 0 then [] else [i % 5,9]
    out := out ++ [vector "workspaces" (toJson [a,r]) (toJson (selectRefs a r))]
    out := out ++ [vector "tools" (toJson [a,r]) (toJson (allowedTools a r))]
  for count in [0,1,2,17,999] do
    for unit in List.range 4 do
      out := out ++ [vector "rate" (toJson [count,unit]) (toJson (rate count unit))]
  for y in [1900,2000,2024,2026] do
    for m in [0,1,2,4,12,13] do
      for d in [0,1,28,29,30,31,32] do
        let c := Calendar.mk y m d 12 0 0
        out := out ++ [vector "date" (toJson (dateWire c)) (toJson (validDate c))]
  for c in [Calendar.mk 2026 2 30 0 0 0, ⟨2026,2,29,0,0,0⟩, ⟨2024,2,29,23,59,59⟩, ⟨2026,0,1,0,0,0⟩,
      ⟨2026,13,1,0,0,0⟩, ⟨2026,99,99,99,99,99⟩, ⟨2026,1,0,0,0,0⟩, ⟨2026,12,31,24,60,60⟩,
      ⟨50,1,1,0,0,0⟩, ⟨0,1,1,0,0,0⟩, ⟨99,12,31,0,0,0⟩, ⟨100,3,1,0,0,0⟩, ⟨1600,2,29,0,0,0⟩,
      ⟨1969,12,31,23,59,59⟩, ⟨9999,12,31,23,59,59⟩] do
    out := out ++ [vector "dateCode" (toJson (dateWire c)) (toJson (atUtc c))]
  for p in List.range 8 do
    for m in List.range 5 do
      out := out ++ [vector "native" (toJson [p,m]) (toJson (nativeMedia p m))]
  for s in ["x",".","..","a/b","a\\b","", "é"] do
    out := out ++ [vector "alias" (toJson s) (toJson (aliasValid s))]
  for token in ["/new","/clear","/compact","/steer","/stop","/cancel","/queue","/help","/bad"] do
    for hasText in [false,true] do
      out := out ++ [vector "command" (Json.mkObj [("token",toJson token),("text",toJson hasText)])
        (toJson (commandMode (command token) hasText))]
  for incoming in [none,some 7] do
    for r in [none, some false, some true] do
      let s := Source.mk 1 2 3 incoming (some 9)
      out := out ++ [vector "reply" (Json.mkObj [("incoming",toJson incoming),("replyIn",toJson r)])
        (toJson (reply s r).thread)]
  for incoming in [none, some 7] do
    for eventType in ["app_mention", "message", "reaction_added"] do
      for channelType in ["channel", "group", "im", "app_home", "mpim"] do
        out := out ++ [vector "replyThread" (Json.mkObj [("incoming",toJson incoming),
            ("type",toJson eventType),("channelType",toJson channelType)])
          (toJson (parsedThread incoming 3 (opensThread eventType channelType)))]
  for mask in List.range 16 do
    let cs := (List.range 4).map fun n => Candidate.mk n (mask / 2^n % 2 == 1) false
    out := out ++ [vector "holders" (toJson (cs.map fun c => [c.agent, if c.verifies then 1 else 0,0]))
      (toJson (receivers cs))]
    let batch := cs.map fun c => { c with eachEntry := true }
    out := out ++ [vector "holders" (toJson (batch.map fun c => [c.agent, if c.verifies then 1 else 0,1]))
      (toJson (receivers batch))]
  for mask in List.range 128 do
    let bit (n : Nat) : Bool := mask / 2^n % 2 == 1
    let c : Coarse := ⟨bit 0, bit 1, bit 2, bit 3, bit 4, bit 5, bit 6⟩
    if !c.candidates || c.configured then
      out := out ++ [vector "webhook"
        (toJson [c.get, c.query, c.active, c.available, c.stageKnown, c.configured, c.candidates])
        (toJson (probeStatus ⟨c, 0⟩))]
  for ts in [[],[1],[1,1],[1,2,1],[2,1,2,3]] do
    out := out ++ [vector "owners" (toJson ts) (toJson (socketOwners ts))]
  for valid in [false,true] do
    for present in [false,true] do
      for size in [0,100,26214400,26214401] do
        out := out ++ [vector "media" (toJson [if valid then 1 else 0, if present then 1 else 0,size])
          (toJson (mediaStatus valid present size))]
  for mask in List.range 16 do
    let es := (List.range 4).map fun n => (mask / 2^n % 2 == 1, toString n)
    out := out ++ [vector "rewrite" (toJson es) (toJson (rewriteLatest es "replacement"))]
  let base := 1000000000
  let run (tracked : Bool) : CronLifecycle.Run :=
    { id := 1, job := 1, conversation := 1, startedAt := base, tracked := tracked, oneShot := false,
      status := .started }
  let statusName : CronLifecycle.EnvelopeStatus → String
    | .active => "processing"
    | .completed => "completed"
    | .failed => "failed"
    | .expired => "expired"
  let cl := CronLifecycle.limits
  for limit in [cl.deadRunGrace, cl.expiredRunGrace, cl.pausedRunMaxAge, cl.untrackedRunMaxAge] do
    for offset in [0, 1, 2] do
      let now := base + limit + offset - 1
      for tracked in [false, true] do
        out := out ++ [vector "cronSweep"
          (Json.mkObj [("tracked", toJson tracked), ("startedAt", toJson base), ("now", toJson now)])
          (toJson (CronLifecycle.deadRunOutcome cl (run tracked) none now).name)]
        for status in [CronLifecycle.EnvelopeStatus.active, .completed, .failed, .expired] do
          for polling in [CronLifecycle.Polling.waitsOnPerson, .settled] do
            let e : CronLifecycle.Envelope := { status := status, updatedAt := base, polling := polling }
            out := out ++ [vector "cronSweep"
              (Json.mkObj
                [("tracked", toJson tracked), ("startedAt", toJson base), ("now", toJson now),
                 ("status", toJson (statusName status)), ("updatedAt", toJson base),
                 ("paused", toJson (polling == .waitsOnPerson))])
              (toJson (CronLifecycle.deadRunOutcome cl (run tracked) (some e) now).name)]
  return out
end Spec.Channels

namespace Spec.Channels.Replay

/-- Prints vectors, one JSON object per line. -/
def run (_args : List String) : IO Unit := do
  for v in Spec.Channels.vectors do IO.println v.compress

end Spec.Channels.Replay
