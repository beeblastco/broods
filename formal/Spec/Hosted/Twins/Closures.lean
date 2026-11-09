import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of closures that outlive their maker in the hosted subsystem. See `AUTHORING.md`.
-/

namespace Spec.Hosted.Closures

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def text (value : Json) : String := value.getStr?.toOption.getD ""
private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def nullish (value : Json) : Bool := undef value || value == Json.null
private def named (name : String) : Json := Json.mkObj [("$fn", toJson name)]

/-- An object literal. The recorder drops `undefined` values from plain objects. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

/-- `{...base, ...over}`, leaving out the recorder's own bookkeeping keys. -/
private def merge (base over : List (String × Json)) : Json :=
  obj ((base.filter fun entry => !over.any (·.1 == entry.1)) ++ over)

/-- The fields of a record, without the recorder's bookkeeping keys. -/
private def plain (value : Json) : List (String × Json) :=
  (Access.Js.entries value).filter fun entry => entry.1 != "$keys" && entry.1 != "$class"

/-- The callback entry every handler closure may start with: the closure's own label. -/
private def enter (label : String) : Prog Unit :=
  Prog.drain (fun entered _ => if entered == label then pure () else Prog.unsupported entered) 1

/-- `PROMPT_INPUT_SCHEMA` in `mcp-tasks.ts`. -/
private def promptInputSchema : Json :=
  Json.mkObj [("type", toJson "object"),
    ("properties", Json.mkObj [("prompt", Json.mkObj
      [("type", toJson "string"), ("description", toJson "What to ask the agent.")])]),
    ("required", toJson ["prompt"])]

/-- `agentTool`: the tool an agent is listed as. -/
private def agentTool (agent : Json) : Json :=
  obj [("name", field agent "agentId"), ("title", field agent "name"),
    ("description", if nullish (field agent "description")
      then toJson s!"Ask the {text (field agent "name")} agent." else field agent "description"),
    ("inputSchema", promptInputSchema)]

/-- The caller `createTaskServer` was made for. -/
private def caller (call : Json) : Json := Twin.moduleValue call "caller"

/-- `tools/list`: every runnable agent as a tool. -/
def toolsList (call : Json) : Prog Json := do
  enter "arg1"
  let agents ← Prog.effect "listRunnableAgents" [field (caller call) "auth"]
  let list := match agents with | .arr items => items.toList | _ => []
  return Json.mkObj [("tools", toJson (list.map agentTool))]

/-- `tools/call`: starts a task for the agent with the prompt. -/
def toolsCall (call : Json) : Prog Json := do
  enter "arg2"
  let params := Twin.callArg call 0
  let _ ← Prog.effect "requireTaskCapability" [Twin.callArg call 1]
  Prog.effect "startTask"
    [caller call, field params "name", field (field params "arguments") "prompt"]

/-- `tasks/get`: the task a run belongs to, as a finished result. -/
def tasksGet (call : Json) : Prog Json := do
  enter "arg2"
  let _ ← Prog.effect "requireTaskCapability" [Twin.callArg call 1]
  let resolved ← Prog.effect "resolveTask" [caller call, field (Twin.callArg call 0) "taskId"]
  let task ← Prog.effect "taskFromRuns" [resolved]
  return merge (plain task) [("resultType", toJson "complete")]

/-- `tasks/update`: hands the client's input responses to the run; none is a protocol error. -/
def tasksUpdate (call : Json) : Prog Json := do
  enter "arg2"
  let params := Twin.callArg call 0
  let request := field (Twin.callArg call 1) "mcpReq"
  let _ ← Prog.effect "requireTaskCapability" [Twin.callArg call 1]
  let responses := field request "inputResponses"
  let empty := match responses with
    | .obj _ => (plain responses).isEmpty
    | _ => !Access.Js.truthy responses
  if undef responses || empty || !undef (field request "droppedInputResponseKeys") then
    let error ← Prog.effect "new ProtocolError"
      [toJson (-32602), toJson "tasks/update needs an inputResponses map of bare responses"]
    return ← Prog.fail error
  let _ ← Prog.effect "updateTask" [caller call, field params "taskId", responses]
  return Json.mkObj [("resultType", toJson "complete")]

/-- `tasks/cancel`: cancels the task's run. -/
def tasksCancel (call : Json) : Prog Json := do
  enter "arg2"
  let _ ← Prog.effect "requireTaskCapability" [Twin.callArg call 1]
  let _ ← Prog.effect "cancelTask" [caller call, field (Twin.callArg call 0) "taskId"]
  return Json.mkObj [("resultType", toJson "complete")]

/-- `mcpTools`' `execute`: calls the remote tool with the model's input. -/
def mcpExecute (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let options := Twin.callArg call 1
  let sandbox := !undef (Twin.moduleValue call "onSandboxCpu")
  Prog.effect "callMcpTool"
    [Twin.moduleValue call "connection", field (Twin.moduleValue call "remote") "name",
     if nullish input then Json.mkObj [] else input,
     obj ([("abortSignal", field options "abortSignal"), ("onRetry", named "onRetry")] ++
       (if sandbox then [("onCpuUsec", named "onCpuUsec")] else []))]

/-- `forwardAbortSignal`'s `onAbort`: signals the child, ignoring a failure. -/
def forwardAbort (_call : Json) : Prog Json := do
  let _ ← Prog.attempt "child.kill" [toJson "SIGUSR2"]
  return Twin.undefinedJson

/-- `forwardAbortSignal`'s returned detach: removes the abort listener. -/
def detachAbort (call : Json) : Prog Json := do
  let _ ← Prog.effect "abortSignal.removeEventListener"
    [toJson "abort", Twin.moduleValue call "onAbort"]
  return Twin.undefinedJson

/-- `flushBatch`'s abort listener: aborts the batch once every live call has been aborted. -/
def batchAbort (call : Json) : Prog Json := do
  let live := match Twin.moduleValue call "live" with | .arr items => items.size | _ => 0
  let mut all := true
  let mut index := 0
  while all && index < live do
    all := Twin.abortedRead call index
    index := index + 1
  if all then
    let _ ← Prog.effect "controller.abort" []
  return Twin.undefinedJson

/-- `spawnChild`'s stderr listener: appends to the kept stderr, which holds only the last 16 KiB. -/
def childStderr (call : Json) : Prog Json := do
  let state := Twin.moduleValue call "state"
  let combined := text (field state "stderr") ++ text (Twin.callArg call 0)
  if Access.Js.utf16Length combined > 16384 && combined.toList.any (fun (c : Char) => c.toNat > 65535) then
    Prog.unsupported "stderr past the cap with characters outside the BMP"
  let kept := if Access.Js.utf16Length combined > 16384
    then String.ofList (combined.toList.drop (combined.length - 16384)) else combined
  Prog.setState "module.state" (merge (plain state) [("stderr", toJson kept)])
  return Twin.undefinedJson

/-- The exit callback `state.onExit?.()`: runs only when one is set. -/
private def notifyExit (state : Json) : Prog Unit := do
  if Access.Js.truthy (field state "onExit") && !undef (field state "onExit") then
    let _ ← Prog.effect "state.onExit" []

/-- `spawnChild`'s `error` listener: marks the child dead and keeps the error as its stderr. -/
def childError (call : Json) : Prog Json := do
  enter "arg1"
  let state := Twin.moduleValue call "state"
  let error := Twin.callArg call 0
  let message := match field error "$error" with
    | .null => none
    | body => if undef body then none else some (text (field body "message"))
  let given ← match message, error with
    | some msg, _ => pure msg
    | none, .str value => pure value
    | none, _ => Prog.unsupported "an error value that is neither an Error nor a string"
  let stderr := if text (field state "stderr") == "" then given else text (field state "stderr")
  Prog.setState "module.state"
    (merge (plain state) [("dead", toJson true), ("stderr", toJson stderr)])
  notifyExit state
  return Twin.undefinedJson

/-- `spawnChild`'s `exit` listener: records the exit, drops the warm slot and kills the group. -/
def childExit (call : Json) : Prog Json := do
  enter "arg1"
  let state := Twin.moduleValue call "state"
  let exit := Json.mkObj [("code", Twin.callArg call 0), ("signal", Twin.callArg call 1)]
  Prog.setState "module.state" (merge (plain state) [("dead", toJson true), ("exit", exit)])
  if Twin.moduleValue call "warm" == state then
    Prog.setState "module.warm" Json.null
  let _ ← Prog.effect "killGroup" [Twin.moduleValue call "child"]
  notifyExit state
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/mcp-tasks.ts#createTaskServer/arg1" toolsList,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#createTaskServer/arg2" toolsCall,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#createTaskServer/arg2~2" tasksGet,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#createTaskServer/arg2~3" tasksUpdate,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#createTaskServer/arg2~4" tasksCancel,
   Twin.traced "apps/core/src/harness/mcp/mcp.tool.ts#mcpTools/execute" mcpExecute,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#forwardAbortSignal/onAbort" forwardAbort,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#forwardAbortSignal/return" detachAbort,
   Twin.traced "apps/core/src/harness/mcp/hosted.ts#flushBatch/arg1" batchAbort,
   Twin.traced "apps/lambda/handler.mjs#spawnChild/arg1" childStderr,
   Twin.traced "apps/lambda/handler.mjs#spawnChild/arg1~2" childError,
   Twin.traced "apps/lambda/handler.mjs#spawnChild/arg1~3" childExit]

end Spec.Hosted.Closures
