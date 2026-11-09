import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of the MCP task helpers in `apps/core/src/harness/mcp-tasks.ts` that turn a waiting run's
approvals and prompts into elicitation forms, and the replies back into answers.
-/

namespace Spec.Hosted.Wave11

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def defined (value : Json) : Bool := value != Twin.undefinedJson

private def truthy (value : Json) : Bool := defined value && Access.Js.truthy value

private def items (value : Json) : List Json := value.getArr?.toOption.getD #[] |>.toList

private def text (value : Json) : String := value.getStr?.toOption.getD ""

/-- `DECLINED_ANSWER` in `harness/mcp-tasks.ts`. -/
def declinedAnswer : String := "The user declined to answer."

/-- `String(value)` for the scalar an elicitation form can hold. -/
private def stringOf (value : Json) : Option String :=
  match value with
  | .str text => some text
  | .num _ => some value.compress
  | .bool flag => some (if flag then "true" else "false")
  | .null => some "null"
  | _ => none

/-- `promptAnswers`: the reply's value for each question, or the decline note when it has none. -/
def promptAnswers (call : Json) : Prog Json := do
  let prompt := Twin.callArg call 0
  let response := Twin.callArg call 1
  let accepted := field response "action" == toJson "accept"
  let mut answers : List (String × Json) := []
  for question in items (field prompt "questions") do
    let id := text (field question "id")
    let value := if accepted then field (field response "content") id else Twin.undefinedJson
    let answer ← if !defined value then pure declinedAnswer
      else match stringOf value with
        | some rendered => pure rendered
        | none => Prog.unsupported "a reply value that is an object or array"
    answers := answers.filter (·.1 != id) ++ [(id, toJson [answer])]
  return Json.mkObj answers

/-- `answerQuestions`: each prompt the reply answers is sent as one answer in a single run request. -/
def answerQuestions (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let run := Twin.callArg call 1
  let responses := Twin.callArg call 2
  let mut answers : List Json := []
  for prompt in items (field run "questions") do
    let parsed ← Prog.effect "ElicitResultV2Schema.safeParse"
      [field responses ("question-" ++ text (field prompt "statusId"))]
    let response := field parsed "data"
    if truthy response then
      let given ← Prog.effect "promptAnswers" [prompt, response]
      answers := answers ++ [Json.mkObj [("statusId", field prompt "statusId"), ("answers", given)]]
  if answers.isEmpty then return Twin.undefinedJson
  let uuid ← Prog.effect "crypto.randomUUID"
  let _ ← Prog.effect "sendRunRequest"
    [caller,
     Json.mkObj [("agentId", field run "agentId"), ("conversationKey", field run "conversationKey"),
       ("eventId", toJson ("mcp-" ++ text uuid)), ("answers", Json.arr answers.toArray)],
     toJson true]
  return Twin.undefinedJson

/-- `approvalRequest`: every tool call waiting on approval as one checkbox of a single form. -/
def approvalRequest (call : Json) : Prog Json :=
  let approvals := items (Twin.callArg call 0)
  pure (Json.mkObj [("method", toJson "elicitation/create"), ("params", Json.mkObj
    [("mode", toJson "form"), ("message", toJson "The agent wants to run these tools."),
     ("requestedSchema", Json.mkObj
       [("type", toJson "object"),
        ("properties", Json.mkObj (approvals.map fun approval =>
          (text (field approval "approvalId"), Json.mkObj
            [("type", toJson "boolean"),
             ("title", toJson ("Allow " ++ text (field approval "toolName") ++ "?")),
             ("description", toJson (Twin.jsonStringify 64 (field approval "input")))]))),
        ("required", Json.arr (approvals.map fun approval => field approval "approvalId").toArray)])])])

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/mcp-tasks.ts#promptAnswers" promptAnswers,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#answerQuestions" answerQuestions,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#approvalRequest" approvalRequest]

end Spec.Hosted.Wave11
