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

/-- The caller `createTaskServer` was made for. -/
private def caller (call : Json) : Json := Twin.moduleValue call "caller"

/-- `tools/list`: `list_agents` and `ask_agent`, plus `get_run` and `continue_run` without tasks. -/
def toolsList (call : Json) : Prog Json := do
  enter "arg1"
  let declares ← Prog.effect "declaresTasks" [Twin.callArg call 1]
  let tools := [Twin.moduleValue call "LIST_TOOL_DEFINITION", Twin.moduleValue call "ASK_TOOL_DEFINITION"] ++
    (if declares == toJson true then []
     else [Twin.moduleValue call "GET_RUN_TOOL_DEFINITION", Twin.moduleValue call "CONTINUE_TOOL_DEFINITION"])
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

/-- One issue of `ASK_ARGS` for the string field `name`, as `z.prettifyError` prints it. -/
private def stringIssue (name : String) (required : Bool) (value : Json) (trimmed : Bool := true) : Option String :=
  let line (message : String) : Option String := some s!"\u2716 {message}\n  \u2192 at {name}"
  if undef value then
    if required then line "Invalid input: expected string, received undefined" else none
  else
    match value with
    | .str text =>
      if (if trimmed then Access.Js.trim text else text).isEmpty then line "Too small: expected string to have >=1 characters"
      else none
    | other => line s!"Invalid input: expected string, received {receivedType other}"

/-- `z.prettifyError` of a failed `ASK_ARGS` parse: the `agent`, `prompt` and `conversationId` issues. -/
private def askArgsError (arguments : Json) : Option String :=
  let issues := [stringIssue "agent" true (field arguments "agent"),
    stringIssue "prompt" true (field arguments "prompt"),
    stringIssue "conversationId" false (field arguments "conversationId")].filterMap id
  if issues.isEmpty then none else some ("\n".intercalate issues)

/-- `tools/call`: the four tools; `ask_agent` starts a run, as a task for a client with tasks. -/
def toolsCall (call : Json) : Prog Json := do
  enter "arg2"
  let params := Twin.callArg call 0
  let ctx := Twin.callArg call 1
  let signal := field (field ctx "mcpReq") "signal"
  let name := field params "name"
  let declares ← Prog.effect "declaresTasks" [ctx]
  let direct := declares != toJson true
  if name == toJson "list_agents" then
    return ← Prog.effect "listAgents" [caller call, field params "arguments"]
  if direct && name == toJson "continue_run" then
    return ← Prog.effect "continueRun" [caller call, field params "arguments", signal]
  if direct && name == toJson "get_run" then
    return ← Prog.effect "getRun" [caller call, field params "arguments"]
  if name != toJson "ask_agent" then
    let error ← Prog.effect "new ProtocolError"
      [toJson (-32602), toJson s!"No tool named {text name}. Call list_agents to see the agents, then ask_agent to run one."]
    Prog.fail error
  let parsed ← Prog.effect "ASK_ARGS.safeParse" [field params "arguments"]
  if field parsed "success" != toJson true then
    match askArgsError (field params "arguments") with
    | some message => return ← Prog.effect "toolResult" [toJson message, toJson true]
    | none => return ← Prog.unsupported "a zod issue the model does not print"
  let agents ← Prog.effect "listRunnableAgents" [field (caller call) "auth"]
  let agent ← Prog.effect "findAgent" [agents, field (field parsed "data") "agent"]
  if (agent.getStr?).toOption.isSome then
    return ← Prog.effect "toolResult" [agent, toJson true]
  let runId ← Prog.effect "startRun" [caller call, field agent "agentId", field parsed "data"]
  if (runId.getStr?).toOption.isNone then return runId
  if direct then Prog.effect "waitForRun" [caller call, runId, signal]
  else Prog.effect "startedTask" [caller call, runId]

/-- `protocolErrorResult`: a missed run call as a tool error; any other error is rethrown. -/
def protocolErrorResult (call : Json) : Prog Json := do
  let error := Twin.callArg call 0
  if field (field error "$error") "name" == toJson "ProtocolError" then
    Prog.effect "toolResult" [field (field error "$error") "message", toJson true]
  else
    Prog.fail error

/-- `getRun`: where a run stands now, a miss on the run id read as a tool error. -/
def getRun (call : Json) : Prog Json := do
  let parsed ← Prog.effect "RUN_ARGS.safeParse" [Twin.callArg call 1]
  if field parsed "success" != toJson true then
    match stringIssue "runId" true (field (Twin.callArg call 1) "runId") false with
    | some message => return ← Prog.effect "toolResult" [toJson message, toJson true]
    | none => return ← Prog.unsupported "a zod issue the model does not print"
  let resolved ← Prog.attempt "resolveTask" [Twin.callArg call 0, field (field parsed "data") "runId"]
  match resolved with
  | .ok task =>
    match ← Prog.attempt "directReply" [task] with
    | .ok reply => return reply
    | .threw error _ => Prog.effect "protocolErrorResult" [error]
    | .pending => Prog.unsupported "the reply never settled"
  | .threw error _ => Prog.effect "protocolErrorResult" [error]
  | .pending => Prog.unsupported "the task never resolved"

/-- `findAgent`: the agent an id or name picks, else what to tell the caller. -/
def findAgent (call : Json) : Prog Json := do
  let agents := match Twin.callArg call 0 with | .arr items => items.toList | _ => []
  let wanted := text (Twin.callArg call 1)
  if !(Access.Js.isAscii wanted) || agents.any (fun agent => !(Access.Js.isAscii (text (field agent "name")))) then
    return ← Prog.unsupported "case folding of names outside ASCII"
  let named := agents.filter fun agent => (text (field agent "name")).toLower == wanted.toLower
  let byId := agents.find? fun agent => field agent "agentId" == toJson wanted
  let picked := byId.orElse fun _ => match named with | [only] => some only | _ => none
  if let some agent := picked then return agent
  if named.isEmpty then
    return toJson s!"No agent named {wanted}. Call list_agents to see the agents you can ask."
  let _ ← Prog.effect "getStorage" []
  let scopes ← Prog.effect "getStorage().agents.scopes" [toJson named]
  let scopeOf (id : Json) : Option Json :=
    match field scopes "$map" with
    | .arr pairs => (pairs.toList.find? fun pair => Twin.arg pair 0 == id).map (Twin.arg · 1)
    | _ => none
  let choices := named.map fun agent =>
    let id := text (field agent "agentId")
    match scopeOf (field agent "agentId") with
    | some scope => s!"{id} (project {text (field scope "project")}, stage {text (field scope "stage")})"
    | none => id
  return toJson s!"{named.length} agents are named {wanted}. Pass one of these ids as agent: {", ".intercalate choices}."

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
     obj ([("abortSignal", field options "abortSignal"),
       ("toolDefinition", Twin.moduleValue call "remote"), ("onRetry", named "onRetry")] ++
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
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#findAgent" findAgent,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#getRun" getRun,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#protocolErrorResult" protocolErrorResult,
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
