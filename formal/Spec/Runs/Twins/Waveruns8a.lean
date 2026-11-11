import Spec.Twin
import Spec.Access.Twins.Js

namespace Spec.Runs.Waveruns8a

open Lean Spec

private def entries (value : Json) : List Json :=
  ((value.getObjVal? "$map").toOption.getD Json.null).getArr?.toOption.getD #[] |>.toList

-- State comparison ignores recorder metadata, as conform.ts does.
def stateValue : Nat → Json → Json
  | 0, value => value
  | fuel + 1, .arr values => .arr (values.map (stateValue fuel))
  | fuel + 1, .obj values => Json.mkObj (values.toList.filterMap fun (key, value) =>
      if ["$fields", "$keys", "$class"].contains key then none
      else some (key, stateValue fuel value))
  | _, value => value

def changed (path : String) (old value : Json) : Prog Unit :=
  if stateValue 32 old == stateValue 32 value then pure () else Prog.setState path value

def mapDelete (value key : Json) : Json :=
  Json.mkObj [("$map", toJson ((entries value).filter fun entry => Twin.arg entry 0 != key))]

def mapPut (value key item : Json) : Json :=
  let current := entries value
  let found := current.any fun entry => Twin.arg entry 0 == key
  let next := if found then current.map fun entry =>
    if Twin.arg entry 0 == key then toJson [key, item] else entry
    else current ++ [toJson [key, item]]
  Json.mkObj [("$map", toJson next)]

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def truthy (value : Json) : Bool :=
  value != Twin.undefinedJson && Access.Js.truthy value

private def named (name : String) : Json := Json.mkObj [("$fn", toJson name)]

private def nonempty (value : Json) : Bool :=
  !(value.getArr?.toOption.getD #[]).isEmpty

-- The default consumer forwards the stream; the harness owns stream iteration.
def runAgentLoopUntilSubagentsIdle (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let config := Twin.callArg call 2
  let context := Twin.callArg call 3
  let reply := Twin.callArg call 4
  let dependencies := Twin.callArg call 5
  let hooks := Twin.callArg call 6
  let coordinator ← Prog.effect "new SubagentCoordinator"
    [session, config, named "", field dependencies "subagents"]
  let questions ← if truthy (field reply "onQuestionsPending") then do
    let bound ← Prog.effect "reply.onQuestionsPending.bind" [reply]
    pure [("onQuestionsPending", bound)]
    else pure []
  let consumer ← if truthy (field reply "streamMessage") then
    Prog.effect "reply.streamMessage.bind" [reply]
    else pure (named "")
  let options := Json.mkObj (
    [("session", session), ("subagentCoordinator", coordinator),
     ("initialTurnContext", Twin.callArg call 1), ("agentConfig", config),
     ("dependencies", dependencies)] ++
    (if truthy hooks then [("hooks", hooks)] else []) ++
    (if truthy context then [("context", context)] else []) ++
    questions ++ [("consumeStream", consumer)])
  Prog.drain (fun label _ => do
    if label != "consumeStream" then Prog.unsupported s!"callback {label}"
    let _ ← Prog.attempt "stream.consumeStream"
    pure ()) 64
  let result ← Prog.effect "runParentContinuationLoop" [options]
  let traceId := field result "traceId"
  let summary (failed : Bool) (failure questions : Json) : Json :=
    Json.mkObj ([("didFail", toJson failed), ("failureText", failure), ("questions", questions)] ++
      (if truthy traceId then [("traceId", traceId)] else []))
  let approvals := field result "approvals"
  if nonempty approvals then
    if truthy (field reply "onApprovalRequired") then
      let _ ← Prog.effect "reply.onApprovalRequired" [approvals]
    return summary false Json.null (.arr #[])
  if truthy (field result "didFail") then
    let failure := field result "failureText"
    let message := if failure == Json.null || failure == Twin.undefinedJson then
      toJson "Agent processing failed" else failure
    let _ ← Prog.effect "reply.onErrorText" [message, traceId]
    return summary true failure (.arr #[])
  let finalResponse := field result "finalResponse"
  if finalResponse != Twin.undefinedJson then
    let _ ← Prog.effect "reply.onFinalText" [finalResponse, traceId]
  return summary false Json.null (field result "questions")

/-- This wave's new orchestration twin. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/continuation.ts#runAgentLoopUntilSubagentsIdle"
    runAgentLoopUntilSubagentsIdle]

end Spec.Runs.Waveruns8a
