import Lean.Data.Json
import Spec.Agent.Model
namespace Spec.Agent.Replay
open Lean

def verdict (n : Nat) : Verdict := if n == 0 then .allow else if n == 1 then .ask else .deny

def code : Verdict → Nat | .allow => 0 | .ask => 1 | .deny => 2

def row (kind : String) (input output : List Nat) : Json :=
  Json.mkObj [("kind", toJson kind), ("input", toJson input), ("output", toJson output)]

/-- Exhaustive small gate states and deterministic boundary vectors; no random ambient state. -/
def vectors : List Json := Id.run do
  let mut out := []
  for p in List.range 3 do
    for c in [0,2] do
      for flags in List.range 8 do
        let i : GateInput := ⟨verdict p, if c == 0 then none else some (verdict (c-1)),
          flags % 2 == 1, flags / 2 % 2 == 1⟩
        let r := gate (flags / 4 == 1) i
        out := out ++ [row "gate" [p,c,flags] [code r.1, if r.2 then 1 else 0]]
  for enabled in List.range 2 do
    for overflow in List.range 2 do
      for n in [0,499999,500000,500001] do
        out := out ++ [row "compact" [enabled,overflow,n]
          [if autoCompact (enabled == 1) (overflow == 1) (some n) then 1 else 0]]
  for input in [0,10,100] do
    for cache in [0,5,200] do
      out := out ++ [row "cost" [input,cache]
        [tokenCostNumerator input 8 cache 2 3 4 1 5]]
  for maxTurn in [0,1,30] do
    for steps in [0,1,29,30] do
      for flags in List.range 8 do
        let r := deadline {} (flags%2 == 1) (flags/2%2 == 1) (flags/4) steps maxTurn
        out := out ++ [row "deadline" [maxTurn,steps,flags]
          [if r.1 then 1 else 0, if r.2.winding then 1 else 0, if r.2.yielded then 1 else 0]]
  for n in List.range 101 do
    let s := meter (meter {} (.step 0 { input := n, total := n } 3))
      (.finish { input := n*2, total := n*2 } 1)
    out := out ++ [row "usage" [n] [s.usage.input,s.usage.total,s.writes,s.steps]]
  let z := meter (meter {} (.step 0 { input := 5, total := 5 } 3)) (.finish {} 1)
  out := out ++ [row "usage-zero" [] [z.usage.input,z.usage.total,z.writes,z.steps]]
  for n in [0,1,99,100,101,201] do
    out := out ++ [row "batches" [n] ((entryBatches (List.replicate n 3)).map List.length)]
  for pct in [0,79,80,99,100,101] do
    out := out ++ [row "level" [pct] [budgetLevel pct]]
  let keys := ["subagent:x:completed", "async-tool:x:y:failed", "subagent:x:awaiting_input",
    "subagent:x:running", "subagent::completed", "invalid:x:completed", "subagent:completed"]
  for key in keys do
    let parsed := parseHandback key
    out := out ++ [Json.mkObj [("kind", toJson "handback"), ("input", toJson ([] : List Nat)),
      ("key", toJson key), ("decoded", toJson parsed), ("output", toJson (if parsed.isSome then [1] else [0]))]]
  let events := ["agent.started", "agent.finished", "agent.approval.required", "tool.call.started",
    "tool.result", "subagent.task.finished", "channel.message.received", "channel.message.sending", "agent.failed"]
  let fields := ["system", "messages", "output", "approve", "decision", "args", "denyReason", "visibleResult", "drop", "text", "metadata", "injected"]
  for event in events do
    let kept := hookResult event (fields.map (fun f => (f,1)))
    out := out ++ [Json.mkObj [("kind", toJson "hook"), ("input", toJson ([] : List Nat)),
      ("key", toJson event), ("output", toJson (fields.map (fun f => if kept.any (fun p => p.1 == f) then 1 else 0)))]]
  for n in List.range 7 do
    for rows in List.range 4 do
      for bytes in [0,2,3,5,6] do
        let batch := takeEntryBatch (List.replicate n 3) rows bytes
        out := out ++ [row "take-batch" [n,rows,bytes] [batch.1.length, if batch.2 then 1 else 0]]
  for flags in [0,1,2] do
    let state : Deadline := ⟨flags%2 == 1, flags/2 == 1⟩
    let withdrawn := withdrawYield state
    out := out ++ [row "withdraw" [flags] [if withdrawn.winding then 1 else 0, if withdrawn.yielded then 1 else 0]]
  for lengths in [[4194302,1], [4194300,0], [4194301,0], [4194305], [0,0]] do
    out := out ++ [row "batch-sizes" lengths ((entryBatches (lengths.map (fun n => n+2))).map List.length)]
  return out

def run (_args : List String) : IO Unit := do
  for v in vectors do IO.println v.compress
end Spec.Agent.Replay
