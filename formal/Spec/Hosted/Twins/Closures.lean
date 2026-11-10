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

/-- The entries of a recorded `Map`. -/
private def mapEntries (value : Json) : List (Json × Json) :=
  match field value "$map" with
  | .arr entries => entries.toList.map fun entry =>
    (match entry with | .arr pair => pair[0]?.getD Json.null | _ => Json.null,
     match entry with | .arr pair => pair[1]?.getD Json.null | _ => Json.null)
  | _ => []

/-- The caller `createTaskServer` was made for. -/
private def caller (call : Json) : Json := Twin.moduleValue call "caller"

/-- `tools/list`: every runnable agent as a tool, plus `continue_run` for a client without tasks. -/
def toolsList (call : Json) : Prog Json := do
  enter "arg1"
  let agents ← Prog.effect "listRunnableAgents" [field (caller call) "auth"]
  let named ← Prog.effect "agentsByToolName" [agents]
  let entries := mapEntries named
  let mut tools : List Json := []
  for (name, agent) in entries do
    tools := tools ++ [← Prog.effect "agentTool" [name, agent]]
  if !entries.isEmpty then
    let declares ← Prog.effect "declaresTasks" [Twin.callArg call 1]
    if declares != toJson true then
      tools := tools ++ [Twin.moduleValue call "CONTINUE_TOOL_DEFINITION"]
  return Json.mkObj [("tools", toJson tools)]

/-- The word `received ...` in zod's type issue. -/
private def receivedType (value : Json) : String :=
  match value with
  | .null => "null"
  | .bool _ => "boolean"
  | .num _ => "number"
  | .str _ => "string"
  | .arr _ => "array"
  | .obj _ => "object"

/-- One issue of `AGENT_ARGS` for the string field `name`, as `z.prettifyError` prints it. -/
private def stringIssue (name : String) (required : Bool) (value : Json) : Option String :=
  let line (message : String) : Option String := some s!"\u2716 {message}\n  \u2192 at {name}"
  if undef value then
    if required then line "Invalid input: expected string, received undefined" else none
  else
    match value with
    | .str text =>
      if (Access.Js.trim text).isEmpty then line "Too small: expected string to have >=1 characters"
      else none
    | other => line s!"Invalid input: expected string, received {receivedType other}"

/-- `z.prettifyError` of a failed `AGENT_ARGS` parse: the `prompt` issue, then `conversationId`. -/
private def agentArgsError (arguments : Json) : Option String :=
  let issues := [stringIssue "prompt" true (field arguments "prompt"),
    stringIssue "conversationId" false (field arguments "conversationId")].filterMap id
  if issues.isEmpty then none else some ("\n".intercalate issues)

/-- `tools/call`: starts a run for the agent named by the tool; a task for a client with tasks. -/
def toolsCall (call : Json) : Prog Json := do
  enter "arg2"
  let params := Twin.callArg call 0
  let ctx := Twin.callArg call 1
  let signal := field (field ctx "mcpReq") "signal"
  let declares ← Prog.effect "declaresTasks" [ctx]
  let direct := declares != toJson true
  if direct && field params "name" == toJson "continue_run" then
    return ← Prog.effect "continueRun" [caller call, field params "arguments", signal]
  let agents ← Prog.effect "listRunnableAgents" [field (caller call) "auth"]
  let named ← Prog.effect "agentsByToolName" [agents]
  let entries := mapEntries named
  let byName := (entries.find? fun entry => entry.1 == field params "name").map (·.2)
  let agent := byName.orElse fun _ =>
    (entries.find? fun entry => field entry.2 "agentId" == field params "name").map (·.2)
  let some agent := agent | do
    let names := ", ".intercalate (entries.map fun entry => text entry.1)
    let error ← Prog.effect "new ProtocolError"
      [toJson (-32602), toJson s!"No tool named {text (field params "name")}. Tools are named after agents, so it may have been renamed. Current tools: {if names.isEmpty then "none" else names}."]
    Prog.fail error
  let parsed ← Prog.effect "AGENT_ARGS.safeParse" [field params "arguments"]
  if field parsed "success" != toJson true then
    match agentArgsError (field params "arguments") with
    | some message => return ← Prog.effect "toolResult" [toJson message, toJson true]
    | none => return ← Prog.unsupported "a zod issue the model does not print"
  let runId ← Prog.effect "startRun" [caller call, field agent "agentId", field parsed "data"]
  if (runId.getStr?).toOption.isNone then return runId
  if direct then Prog.effect "waitForRun" [caller call, runId, signal]
  else Prog.effect "startedTask" [caller call, runId]

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
