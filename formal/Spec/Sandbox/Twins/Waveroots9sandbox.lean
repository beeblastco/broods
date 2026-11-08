import Spec.Twin

/-!
Twin of `createTools` in `apps/core/src/harness/tools/index.ts`. Which factories run, and with what
context, is the logic here. A call where a provider tool or MCP server was registered is left out: the
callee writes to `tools` in place, and a recording does not show what it wrote.
-/

namespace Spec.Sandbox.Waveroots9sandbox

open Lean Spec

private def undef : Json := Twin.undefinedJson

/-- Reads a property from a plain object, or from a recorded instance's `$fields`. -/
private def get (value : Json) (name : String) : Json :=
  match value.getObjVal? name with
  | .ok item => item
  | .error _ => Twin.field value name

private def isNullish (value : Json) : Bool :=
  value == undef || value == Json.null

private def truthy (value : Json) : Bool :=
  match value with
  | .null | .bool false => false
  | .str "" => false
  | .num n => n != 0
  | other => other != undef

private def isTrue (value : Json) : Bool := value == toJson true

private def items (value : Json) : List Json :=
  match value with
  | .arr entries => entries.toList
  | _ => []

private def entries (value : Json) : List (String × Json) :=
  match value with
  | .obj kvs => (kvs.toList).filter fun (key, _) => key != "$keys" && key != "$fields" && key != "$undefined"
  | _ => []

private def orEmptyArray (value : Json) : Json :=
  if isNullish value then .arr #[] else value

private def fn (name : String) : Json := Json.mkObj [("$fn", toJson name)]

/-- `...(value ? { key: value } : {})`. -/
private def optional (key : String) (value : Json) : List (String × Json) :=
  if truthy value then [(key, value)] else []

/-- `Object.assign(target, source)` on the recorded shape of a tool set. -/
private def assign (target source : Json) : Json :=
  Json.mkObj ((entries target).filter (fun (key, _) => !(entries source).any (·.1 == key))
    ++ entries source)

/-- `isToolEnabled`: present, and not explicitly disabled. -/
private def isEnabled (config : Json) : Bool :=
  config != undef && get config "enabled" != toJson false

private def anyEnabled (table : Json) : Bool :=
  (entries table).any fun (_, config) => isEnabled config

/-- `array.some(predicate)` over an effect, which stops at the first truthy answer. -/
private def someEffect (label : String) (project : Json → Json) : List Json → Prog Bool
  | [] => pure false
  | head :: rest => do
    if truthy (← Prog.effect label [project head]) then return true
    someEffect label project rest

private def assignFrom (tools : Json) (label : String) (args : List Json) : Prog Json := do
  return assign tools (← Prog.effect label args)

/-- `withholdTools` with no stand-ins: every denied name goes. -/
private def withheld (tools denyTools : Json) : Json :=
  let denied := items denyTools
  Json.mkObj ((entries tools).filter fun (key, _) => !denied.contains (toJson key))

/-- An object literal as recorded: a key holding `undefined` is dropped. -/
private def obj (fields : List (String × Json)) : Json :=
  Json.mkObj (fields.filter (·.2 != undef))

private def sandboxSection (context agentConfig sandboxContext : Json) (hasBackground : Bool) :
    Prog Json := do
  let workspaces := orEmptyArray (get context "workspaces")
  let sandboxes := orEmptyArray (get context "sandboxes")
  let defaultSandbox := match items sandboxes with
    | head :: _ => get head "sandbox"
    | [] => undef
  let sandboxWorkspaces := (items workspaces).filter (truthy <| get · "sandbox")
  let session := get context "session"
  let conversationKey := get context "conversationKey"
  let onSandboxCpu := optional "onSandboxCpu" (get context "onSandboxCpu")
  let background : List (String × Json) :=
    if hasBackground && truthy session then
      [("background", obj
        ([("eventId", get session "eventId"), ("conversationKey", conversationKey)]
          ++ optional "delivery" (get session "delivery")
          ++ optional "onDetachedResult" (get context "onDetachedResult")))]
    else []
  let mut tools := obj []
  if !(items sandboxes).isEmpty || !sandboxWorkspaces.isEmpty then
    tools ← assignFrom tools "bashTool" [obj (entries sandboxContext ++ background)]
  let machines ← Prog.effect "machineSandboxes" [sandboxes]
  if !(items machines).isEmpty then
    tools ← assignFrom tools "computerTool" [machines]
  if isTrue (get (get agentConfig "browser") "enabled") then
    let problem ← Prog.effect "browserSandboxRefusal" [defaultSandbox]
    if truthy problem then
      Prog.throwError "Error" (problem.getStr?.toOption.getD "")
    tools ← assignFrom tools "browseTool" [sandboxContext]
  if !(items workspaces).isEmpty then
    tools ← assignFrom tools "readTool"
      [obj [("workspaces", workspaces), ("agentConfig", agentConfig)]]
    tools ← assignFrom tools "globTool" [obj [("workspaces", workspaces)]]
  if !sandboxWorkspaces.isEmpty then
    let fsEntries := [("workspaces", workspaces)] ++ onSandboxCpu
    let fsContext := obj fsEntries
    tools ← assignFrom tools "writeTool" [fsContext]
    tools ← assignFrom tools "editTool" [fsContext]
    tools ← assignFrom tools "grepTool" [fsContext]
    if ← someEffect "workspaceMemoryHarnessEnabled" (get · "config") sandboxWorkspaces then
      tools ← assignFrom tools "memoryTool"
        [obj (fsEntries ++ [("conversationKey", conversationKey)])]
  return tools

private def channelSection (context agentConfig start : Json) : Prog Json := do
  let mut tools := start
  let channel := get context "channel"
  if truthy channel then
    let extended := obj (entries channel
      ++ [("workspaces", orEmptyArray (get context "workspaces"))]
      ++ optional "accountId" (get context "accountId"))
    tools ← assignFrom tools "sendFilesTool" [extended]
    tools ← assignFrom tools "sendImagesTool" [extended]
    tools ← assignFrom tools "sendReactionsTool" [channel]
    tools ← assignFrom tools "sendStickerTool" [channel]
    tools ← assignFrom tools "sendUpdateTool" [channel]
  let dispatch := get context "dispatchSessionMessage"
  if truthy dispatch && !(entries (get agentConfig "channels")).isEmpty then
    tools ← assignFrom tools "sendMessageTool" [dispatch]
  return tools

private def subagentSection (context agentConfig start : Json) : Prog Json := do
  let mut tools := start
  let session := get context "session"
  let enabled := isTrue (get (get agentConfig "subagent") "enabled")
  let dispatch := get context "dispatchSubagents"
  if enabled && truthy dispatch then
    let mode ← Prog.effect "resolveSubagentMode" [agentConfig]
    tools ← assignFrom tools "runSubagentTool"
      [obj [("dispatchSubagents", dispatch), ("mode", mode)]]
    let again ← Prog.effect "resolveSubagentMode" [agentConfig]
    if again == toJson "persistent" && truthy (get context "accountId") && truthy session then
      tools ← assignFrom tools "stopSubagentTool"
        [obj [("accountId", get context "accountId"), ("eventId", get session "eventId"),
          ("conversationKey", get session "conversationKey")]]
  let messageChild ←
    if enabled then do
      let mode ← Prog.effect "resolveSubagentMode" [agentConfig]
      pure (if mode == toJson "persistent" then get context "messageChild" else undef)
    else pure undef
  let parent := get context "parentLink"
  if truthy messageChild || truthy parent then
    tools ← assignFrom tools "messageAgentsTool"
      [obj (optional "messageChild" messageChild ++ optional "parent" parent)]
  return tools

private def skillAndScheduleSection (context agentConfig start : Json) : Prog Json := do
  let mut tools := start
  let session := get context "session"
  let skills := get agentConfig "skills"
  if isTrue (get skills "enabled") && !(items (get skills "allowed")).isEmpty && truthy session then
    tools ← assignFrom tools "loadSkillTool" [session, fn ""]
  let accountId := get context "accountId"
  let agentId := get session "agentId"
  if isTrue (get (get agentConfig "scheduler") "enabled") && truthy accountId && truthy agentId
      && get session "trigger" != toJson "cron" then
    let key ← Prog.effect "publicConversationKeyFromScoped"
      [get context "conversationKey", accountId, agentId]
    let schedule := obj
      [("accountId", accountId), ("agentId", agentId), ("conversationKey", key)]
    tools ← assignFrom tools "cancelScheduleTool" [schedule]
    tools ← assignFrom tools "listSchedulesTool" [schedule]
    tools ← assignFrom tools "scheduleTool" [schedule]
    tools ← assignFrom tools "updateScheduleTool" [schedule]
  return tools

private def questionsSection (context start : Json) : Prog Json := do
  let session := get context "session"
  if get session "delivery" == undef || get session "trigger" == toJson "cron" then
    return start
  assignFrom start "askQuestionsTool"
    [obj ([("conversationKey", get context "conversationKey"),
      ("eventId", get session "eventId"), ("delivery", get session "delivery")]
      ++ optional "channel" (get context "channel")
      ++ optional "onBlockingQuestion" (get context "onBlockingQuestion")
      ++ optional "onDetachedResult" (get context "onDetachedResult"))]

private def asyncStatusSection (context start : Json) : Prog Json := do
  let workspaces := orEmptyArray (get context "workspaces")
  let supportsJobs ← someEffect "sandboxSupportsJobControls" (get · "sandbox") (items workspaces)
  assignFrom start "asyncStatusTool"
    [obj ([("conversationKey", get context "conversationKey"), ("workspaces", workspaces),
      ("supportsJobs", toJson supportsJobs)]
      ++ (if truthy (get context "session") then [("onResultRead", fn "onResultRead")] else []))]

/-- `createTools`: the factories selected by the context and config, in registration order. -/
def createTools (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let agentConfig := Twin.callArg call 1
  let workspaces := orEmptyArray (get context "workspaces")
  let sandboxes := orEmptyArray (get context "sandboxes")
  let defaultSandbox := match items sandboxes with
    | head :: _ => get head "sandbox"
    | [] => undef
  let sandboxContext := obj ([("workspaces", workspaces), ("sandboxes", sandboxes)]
    ++ optional "onSandboxCpu" (get context "onSandboxCpu")
    ++ [("principal", fn "principal")])
  if defaultSandbox != undef then
    let _ ← Prog.effect "statelessReservationKeyFor" [defaultSandbox]
  let _ ← Prog.effect "hasStandaloneSandbox" [sandboxContext]
  let hasBackground ←
    someEffect "sandboxSupportsBackgroundJobs" (get · "sandbox") (items workspaces)
  let sandboxTools ← sandboxSection context agentConfig sandboxContext hasBackground
  let beforeProviders ← skillAndScheduleSection context agentConfig
    (← subagentSection context agentConfig (← channelSection context agentConfig sandboxTools))
  let standIns :=
    if isNullish (get context "sandboxStandIns") then obj [("$map", .arr #[])]
    else get context "sandboxStandIns"
  let _ ← Prog.effect "registerProviderTools"
    [beforeProviders, agentConfig, context,
      obj [("sandboxTools", sandboxTools), ("fileContext", sandboxContext),
        ("standIns", standIns)]]
  if anyEnabled (get agentConfig "tools") then
    return ← Prog.unsupported "registerProviderTools wrote to tools; a recording does not show what"
  let beforeMcp ← questionsSection context beforeProviders
  let _ ← Prog.effect "registerMcpTools" [beforeMcp, agentConfig, context]
  if anyEnabled (get agentConfig "mcp") then
    return ← Prog.unsupported "registerMcpTools wrote to tools; a recording does not show what"
  let finished ← if hasBackground then asyncStatusSection context beforeMcp else pure beforeMcp
  let denyTools := get agentConfig "denyTools"
  let _ ← Prog.effect "withholdTools" [finished, denyTools, standIns, sandboxTools]
  return withheld finished denyTools

/-- This wave's twins. -/
def twins : List Twin :=
  [Twin.traced "apps/core/src/harness/tools/index.ts#createTools" createTools]

end Spec.Sandbox.Waveroots9sandbox
