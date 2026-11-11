import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign8/hosted8a.tsv`.
-/

namespace Spec.Hosted.Wavehosted8a

open Lean Spec

/-- `HOSTED_MCP_MEMORY_GB` in `packages/convex/model/pricing.ts`. -/
def hostedMcpMemoryGb : Float := 1.769

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def entries (value : Json) : List Json :=
  match field value "$map" with
  | .arr values => values.toList
  | _ => []

private def fnValue : Json := Json.mkObj [("$fn", toJson "")]

/-- What `queue.frames()` records as: an async generator object. It starts alongside its consumer. -/
private def framesIterator : Json := Json.mkObj [("$opaque", toJson "AsyncGenerator")]

private def numberOf (value : Json) : Float :=
  match value with
  | .num number => Spec.Access.Js.numFloat number
  | _ => 0.0

/-- Records the promise cached by `AccountCipher.dataKey`, including rejected asynchronous loads. -/
def cacheDataKeyState (call key : Json) : Prog Unit := do
  let self := Twin.self call
  let cache := Twin.field self "dataKeys"
  if (entries cache).any (fun entry => Twin.arg entry 0 == key) then
    return ()
  let wrapped := (entries (Twin.field self "keys")).find? (fun entry => Twin.arg entry 0 == key)
  match wrapped with
  | none => pure ()
  | some entry =>
    if field (Twin.arg entry 1) "retiredAt" != Twin.undefinedJson then
      return ()
    let pending := Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [])]
    Prog.setState "self.dataKeys"
      (Json.mkObj [("$map", .arr ((entries cache) ++ [Json.arr #[key, pending]]).toArray)])

/-- Takes the `onInvoked` callback's `startedAt`, the last one to run winning. -/
private def drainInvoked : Nat → Option Json → Prog (Option Json)
  | 0, invokedAt => pure invokedAt
  | limit + 1, invokedAt =>
    .input fun
      | some ("arg1", args) => drainInvoked limit (some (Twin.arg args 0))
      | some (label, _) => Prog.unsupported s!"callback {label}"
      | none => pure invokedAt

/-- `runBatch`: the pump, the frame reader and the close overlap; usage is metered in `finally`. -/
def runBatch (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let requests := Twin.callArg call 1
  let name := field record "name"
  let queue ← Prog.effect "new FrameQueue"
  let invokedAt ← drainInvoked 16 none
  let outcomes ← Prog.all
    [("drain", [queue, fnValue]),
     ("queue.frames", []),
     ("collectBatchFrames", [name, requests, framesIterator]),
     ("queue.close", [])]
  let meter : Prog Unit := do
    match invokedAt with
    | none => pure ()
    | some startedAt =>
      let now ← Prog.effect "Date.now"
      let seconds := (numberOf now - numberOf startedAt) / 1000.0
      let _ ← Prog.effect "recordUsage"
        [field record "accountId",
         Json.mkObj
          [("hostedMcpGbSeconds", Spec.Access.Js.floatJson (seconds * hostedMcpMemoryGb)),
           ("hostedMcpRequests", toJson (1 : Nat))],
         Json.mkObj [("projectId", field record "projectId")]]
  let transportError : Option Json := match outcomes.head? with
    | some (.threw error _) => some error
    | _ => none
  match outcomes.getD 2 .pending with
  | .ok collected =>
    meter
    if field collected "ended" == toJson true then
      return field collected "result"
    match transportError with
    | some error => throw error
    | none =>
      Prog.throwError "Error"
        s!"hosted MCP server {(name.getStr?).toOption.getD ""} stream closed without an end frame"
  | .threw error _ =>
    meter
    throw error
  | .pending => Prog.unsupported "the frame reader never finished"

/-- `map.set`: an existing key keeps its place and takes the new value. -/
private def mapSet (table : List (String × Json)) (key : String) (value : Json) :
    List (String × Json) :=
  if table.any (·.1 == key) then
    table.map fun entry => if entry.1 == key then (key, value) else entry
  else
    table ++ [(key, value)]

private def isPresent (value : Json) : Bool :=
  match value with
  | .str "" | .null => false
  | other => other != Twin.undefinedJson

/-- `loadMcpServersByNode`: the placement of every active server that sits on a node. -/
def loadMcpServersByNode (_call : Json) : Prog Json := do
  let _ ← Prog.effect "ctx.db .query" [toJson "mcp"]
  let _ ← Prog.effect "ctx.db .query(\"mcp\") .withIndex"
    [toJson "by_stageId_and_status_and_name", fnValue]
  let servers ← Prog.effect
    ("ctx.db .query(\"mcp\") .withIndex(\"by_stageId_and_status_and_name\", " ++
      "(q) => q.eq(\"stageId\", stageId).eq(\"status\", \"active\"), ) .collect")
  let rows := match servers with
    | .arr items => items.toList
    | _ => []
  let placements := rows.foldl
    (fun table server =>
      let nodeId := field server "nodeId"
      if isPresent nodeId then
        let sandbox := field server "sandbox"
        mapSet table ((nodeId.getStr?).toOption.getD "")
          (Json.mkObj
            [("sandbox", if sandbox == Twin.undefinedJson || sandbox == Json.null then Json.null else sandbox),
             ("transport", field server "transport")])
      else table)
    []
  return Json.mkObj
    [("$map", .arr (placements.map fun (key, value) => Json.arr #[toJson key, value]).toArray)]

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/mcp/hosted.ts#runBatch" runBatch,
   Twin.traced "packages/convex/model/mcp.ts#loadMcpServersByNode" loadMcpServersByNode]

end Spec.Hosted.Wavehosted8a
