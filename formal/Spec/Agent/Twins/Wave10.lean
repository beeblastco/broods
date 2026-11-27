import Spec.Twin

/-!
Twins of the agent subsystem's functions added in wave 10.
-/

namespace Spec.Agent.Wave10

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def items (value : Json) : List Json :=
  (value.getArr?.toOption.getD #[]).toList

private def arr (values : List Json) : Json :=
  .arr values.toArray

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def isFalsy (value : Json) : Bool :=
  isUndef value || value == Json.null || value == toJson false || value == toJson "" ||
    value == toJson (0 : Nat)

private def pairsOf (value : Json) : List (String × Json) :=
  match value with
  | .obj entries =>
    if isUndef value then [] else entries.toList.filter fun entry => entry.1 != "$keys"
  | _ => []

/-- `{...base, ...over}`: a later key wins, and one holding `undefined` leaves the key out. -/
private def spread (base : Json) (over : List (String × Json)) : Json :=
  Json.mkObj ((pairsOf base ++ over).foldl
    (fun acc entry => (acc.filter (·.1 != entry.1)) ++ (if isUndef entry.2 then [] else [entry]))
    [])

/-- `Map.set` on a recorded Map: the entry is replaced in place, or appended. -/
private def mapPut (table key value : Json) : Json :=
  let pairs := items (field table "$map")
  let entry := arr [key, value]
  let next := if pairs.any (fun pair => Twin.arg pair 0 == key) then
    pairs.map fun pair => if Twin.arg pair 0 == key then entry else pair
    else pairs ++ [entry]
  Json.mkObj [("$map", arr next)]

private def mapGet (table key : Json) : Json :=
  match (items (field table "$map")).find? (fun pair => Twin.arg pair 0 == key) with
  | some pair => Twin.arg pair 1
  | none => undef

/-- `recordToolCallSummary`: merges the update over what the map held for that call id. -/
private def recordToolCallSummary (call : Json) : Prog Json := do
  let summaries := Twin.callArg call 0
  let toolCall := Twin.callArg call 1
  let id := field toolCall "toolCallId"
  let merged := spread (mapGet summaries id)
    ([("toolCallId", id), ("toolName", field toolCall "toolName")] ++ pairsOf (Twin.callArg call 2))
  if merged.compress != (spread (mapGet summaries id) []).compress then
    Prog.setState "args.0.$map" (field (mapPut summaries id merged) "$map")
  return undef

/-- `requireHarnessModelId` -/
private def requireHarnessModelId (call : Json) : Prog Json := do
  let modelId := field (field (Twin.callArg call 0) "model") "modelId"
  if isFalsy modelId then
    return ← Prog.throwError "Error" "config.model.modelId is required for config.harness"
  return modelId

/-- `harnessAdapterVersion` -/
private def harnessAdapterVersion (call : Json) : Prog Json := do
  let versions := Twin.moduleValue call "HARNESS_VERSIONS"
  match Twin.callArg call 0 with
  | .str kind => return field versions kind
  | _ => return undef

/-- `waitUntil`: the tracked promise joins the in-flight set before the call returns. -/
private def waitUntil (call : Json) : Prog Json := do
  let tracked := Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [])]
  let current := field (Twin.moduleValue call "inFlight") "$set"
  Prog.setState "module.inFlight" (Json.mkObj [("$set", arr (items current ++ [tracked]))])
  return undef

/-- `create<Harness>Adapter`: hands the settings to the harness package's own factory. -/
private def adapterFrom (factory : String) (call : Json) : Prog Json :=
  Prog.effect factory [Twin.callArg call 0]

private def adapterTwin (file name factory : String) : Spec.Twin :=
  Twin.traced s!"apps/core/src/harness/ai-sdk-harness/adapters/{file}.ts#{name}" (adapterFrom factory)

/-- `Session.loadSkillMetadata`: lists once, then every call reads that one promise. -/
private def loadSkillMetadata (call : Json) : Prog Json := do
  let self := Twin.self call
  let cached := Twin.field self "skillMetadataPromise"
  if !isUndef cached then
    let settled := Twin.resolved cached
    if isUndef settled then
      return ← Prog.unsupported "the cached promise had not settled when recorded"
    return settled
  if ((Twin.field self "agentConfig").compress.splitOn "too-deep").length > 1 then
    return ← Prog.unsupported "the config was cut short where the receiver was recorded"
  let listed ← Prog.effect "listConfiguredSkillMetadata"
    [Twin.field self "accountId", Twin.field self "agentConfig"]
  Prog.setState "self.skillMetadataPromise"
    (Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [("$resolved", listed)])])
  return listed

private def isEmptyMap (table : Json) : Bool :=
  (items (field table "$map")).isEmpty

private def natOf (value : Json) : Nat :=
  value.getNat?.toOption.getD 0

/-- `session.accountId`, whether the recorder kept the session as a plain record or an instance. -/
private def accountOf (session : Json) : Json :=
  let plain := field session "accountId"
  if isUndef plain then Twin.field session "accountId" else plain

/-- `SubagentCoordinator.getHooks`: builds the dispatcher once, then every call reads that promise. -/
private def getHooks (call : Json) : Prog Json := do
  let self := Twin.self call
  let cached := Twin.field self "hooksPromise"
  if !isUndef cached then
    let settled := Twin.resolved cached
    if isUndef settled then
      return ← Prog.unsupported "the cached promise had not settled when recorded"
    return settled
  let hooks ← Prog.effect "createAgentHookDispatcher"
    [accountOf (Twin.field self "parentSession"), Twin.field self "parentAgentConfig"]
  Prog.setState "self.hooksPromise"
    (Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [("$resolved", hooks)])])
  return hooks

/-- `refundRun`: gives back one counted run when the admission's window is still the open one. -/
private def refundRun (call : Json) : Prog Json := do
  let admission := Twin.callArg call 0
  let accountId := Twin.callArg call 1
  let windows := Twin.moduleValue call "windows"
  match (items (field windows "$map")).find? (fun pair => Twin.arg pair 0 == accountId) with
  | none => return undef
  | some pair =>
    let window := Twin.arg pair 1
    if field window "startedAt" == field admission "countedIn" && natOf (field window "runs") > 0 then
      let refunded := spread window [("runs", toJson (natOf (field window "runs") - 1))]
      Prog.setState "module.windows" (Json.mkObj [("$map", arr ((items (field windows "$map")).map
        fun entry => if Twin.arg entry 0 == accountId then arr [accountId, refunded] else entry))])
    return undef

/-- `resetPlanLimitsForTests`: both tables are emptied. -/
private def resetPlanLimitsForTests (call : Json) : Prog Json := do
  let empty := Json.mkObj [("$map", arr [])]
  for name in ["windows", "budgets"] do
    if !isEmptyMap (Twin.moduleValue call name) then
      Prog.setState s!"module.{name}" empty
  return undef

private def noteDelivered : List String := ["owner", "queued", "duplicate", "conflict"]

private def noteRefusal (message : Json) (note : String) : Json :=
  Json.mkObj [("status", toJson "not_delivered"), ("exchangeId", field message "exchangeId"),
    ("note", toJson note)]

private def notReading (message : Json) : Json :=
  noteRefusal message "Your parent is not reading messages now. Put it in your final answer instead."

/-- `SubagentCoordinator.noteFromChild`: a note to the parent, refused once the passes are over. -/
private def noteFromChild (call : Json) : Prog Json := do
  let taskId := Twin.callArg call 0
  let message := Twin.callArg call 1
  let metadata := Twin.param call 2
  let session := Twin.field (Twin.self call) "parentSession"
  if Twin.abortedRead call 0 || isUndef metadata then
    return notReading message
  let claimed ← Prog.effect "this.parentSession.claimMessageTurn" [toJson (40 : Nat)]
  if claimed != toJson true then
    return noteRefusal message
      "Agents in this run already started 40 turns by messaging each other. Finish with what you have."
  let nonce ← Prog.effect "noteNonce" [taskId, field message "text"]
  let send : Prog Json := do
    let id ← Prog.effect "createSubagentTaskId" [field session "eventId", nonce]
    let body ← Prog.effect "noteToParentMessage" [metadata, message, nonce]
    Prog.effect "this.resumeParent" [session, id, body, undef]
  let outcome : Json ←
    if Twin.abortedRead call 1 then pure (toJson "closed")
    else
      Prog.catchFail (Prog.catchFail send (fun _ => send))
        (fun error => Prog.effect "toErrorMessage" [error])
  if match outcome with | .str kind => noteDelivered.contains kind | _ => false then
    return Json.mkObj [("status", toJson "delivered"), ("exchangeId", field message "exchangeId"),
      ("note", toJson "Your parent reads it at its next step.")]
  let _ ← Prog.effect "this.parentSession.releaseMessageTurn"
  if outcome == toJson "closed" then
    return notReading message
  return noteRefusal message s!"Your parent could not take the note: {outcome.getStr?.toOption.getD ""}."

/-- `emitOtelLog`: asks the OpenTelemetry logs API for the harness logger, then emits through it. -/
private def emitOtelLog (_ : Json) : Prog Json := do
  let _ ← Prog.attempt "logs.getLogger" [toJson "broods-harness"]
  return undef

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [ Twin.traced "apps/core/src/harness/ai-sdk-harness/provider.ts#requireHarnessModelId"
      requireHarnessModelId
  , Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/index.ts#harnessAdapterVersion"
      harnessAdapterVersion
  , Twin.traced "apps/core/src/shared/in-flight.ts#waitUntil" waitUntil
  , Twin.traced "apps/core/src/harness/harness.ts#recordToolCallSummary" recordToolCallSummary
  , Twin.traced "apps/core/src/harness/session.ts#Session.loadSkillMetadata" loadSkillMetadata
  , Twin.traced "apps/core/src/harness/subagents.ts#SubagentCoordinator.noteFromChild" noteFromChild
  , Twin.traced "apps/core/src/harness/subagents.ts#SubagentCoordinator.getHooks" getHooks
  , Twin.traced "apps/core/src/harness/plan-limits.ts#refundRun" refundRun
  , Twin.traced "apps/core/src/harness/plan-limits.ts#resetPlanLimitsForTests" resetPlanLimitsForTests
  , Twin.traced "apps/core/src/shared/otel.ts#emitOtelLog" emitOtelLog
  , adapterTwin "claude-code" "createClaudeCodeAdapter" "createClaudeCode"
  , adapterTwin "codex" "createCodexAdapter" "createCodex"
  , adapterTwin "deepagents" "createDeepAgentsAdapter" "createDeepAgents"
  , adapterTwin "opencode" "createOpenCodeAdapter" "createOpenCode"
  , adapterTwin "pi" "createPiAdapter" "createPi" ]

end Spec.Agent.Wave10
