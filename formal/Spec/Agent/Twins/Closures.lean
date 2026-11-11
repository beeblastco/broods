import Spec.Twin

/-!
Twins of closures in the agent harness that run after the function that made them has returned.
Each is registered under `file#maker/label` and reads the maker's variables through `Twin.moduleValue`.
-/

namespace Spec.Agent.Closures

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool :=
  value == Twin.undefinedJson

private def int (value : Json) : Int :=
  (value.getInt?).toOption.getD 0

private def isNumber (value : Json) : Bool :=
  (value.getInt?).toOption.isSome

private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

private def array (value : Json) : List Json :=
  value.getArr?.toOption.getD #[] |>.toList

private def text (value : Json) : String :=
  value.getStr?.toOption.getD ""

private def mapEntries (map : Json) : List (Json × Json) :=
  (array (field map "$map")).map fun pair => (Twin.arg pair 0, Twin.arg pair 1)

private def mapGet (map key : Json) : Option Json :=
  (mapEntries map).find? (fun entry => entry.1 == key) |>.map (·.2)

private def mapSet (map key value : Json) : Json :=
  let entries := mapEntries map
  let next := if entries.any (fun entry => entry.1 == key) then
      entries.map fun entry => if entry.1 == key then (key, value) else entry
    else entries ++ [(key, value)]
  Json.mkObj [("$map", Json.arr (next.map fun entry => Json.arr #[entry.1, entry.2]).toArray)]

private def mapDelete (map key : Json) : Json :=
  Json.mkObj [("$map", Json.arr
    ((mapEntries map).filter (fun entry => entry.1 != key) |>.map
      fun entry => Json.arr #[entry.1, entry.2]).toArray)]

/-- A value without the recorder's `$keys`, `$fields` and `$class` bookkeeping. -/
private def plain : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .arr items => .arr (items.map (plain fuel))
    | .obj entries =>
      Json.mkObj (entries.toList.filterMap fun entry =>
        if entry.1 == "$keys" || entry.1 == "$fields" || entry.1 == "$class" then none
        else some (entry.1, plain fuel entry.2))
    | other => other

/-- States a write to a binding of the maker, only when it changes the value. -/
private def setModule (name : String) (before after : Json) : Prog Unit :=
  if (plain 16 before).compress == (plain 16 after).compress then pure ()
  else Prog.setState s!"module.{name}" (if undef after then Json.null else after)

private def emptyMap : Json :=
  Json.mkObj [("$map", Json.arr #[])]

/-! ### usage-metering.ts: `createSandboxCpuLedger` -/

private def usageFile : String := "apps/core/src/harness/usage-metering.ts"

/-- `record`: adds a positive sample to the per-call and per-key totals, mutating the stored entries. -/
private def ledgerRecord (call : Json) : Prog Json := do
  let sample := Twin.callArg call 0
  let usageBefore := Twin.moduleValue call "sandboxUsageByKey"
  let computeBefore := Twin.moduleValue call "toolComputeByCallId"
  let cpu := field sample "cpuUsec"
  if !(isNumber cpu && int cpu > 0) then
    return Twin.undefinedJson
  let compute :=
    if field sample "role" == toJson "tool" && !undef (field sample "toolCallId") then
      let id := field sample "toolCallId"
      match mapGet computeBefore id with
      | some existing =>
        mapSet computeBefore id (obj
          [("type", field existing "type"), ("cpuUsec", toJson (int (field existing "cpuUsec") + int cpu))])
      | none =>
        mapSet computeBefore id (obj [("type", field sample "type"), ("cpuUsec", cpu)])
    else computeBefore
  let toolName := field sample "toolName"
  let named := if undef toolName || toolName == Json.null then "" else text toolName
  let key := toJson s!"{text (field sample "type")}|{text (field sample "role")}|{named}"
  let usage :=
    match mapGet usageBefore key with
    | some existing =>
      mapSet usageBefore key (obj
        [("type", field existing "type"), ("role", field existing "role"),
         ("toolName", field existing "toolName"),
         ("cpuUsec", toJson (int (field existing "cpuUsec") + int cpu))])
    | none =>
      mapSet usageBefore key (obj
        [("type", field sample "type"), ("role", field sample "role"),
         ("toolName", if named == "" then Twin.undefinedJson else toJson named), ("cpuUsec", cpu)])
  setModule "toolComputeByCallId" computeBefore compute
  setModule "sandboxUsageByKey" usageBefore usage
  return Twin.undefinedJson

/-- `roleAttributes`: total CPU per role, `agent` and `tool` only, when positive. -/
private def ledgerRoleAttributes (call : Json) : Prog Json := do
  let samples := (mapEntries (Twin.moduleValue call "sandboxUsageByKey")).map (·.2)
  let sum (role : String) : Int :=
    (samples.filter fun sample => field sample "role" == toJson role).foldl
      (fun total sample => total + int (field sample "cpuUsec")) 0
  let agent := sum "agent"
  let tool := sum "tool"
  return obj
    [("sandbox.cpu_usec.role.agent", if agent > 0 then toJson agent else Twin.undefinedJson),
     ("sandbox.cpu_usec.role.tool", if tool > 0 then toJson tool else Twin.undefinedJson)]

/-- `typeAttributes`: total CPU per sandbox type. -/
private def ledgerTypeAttributes (call : Json) : Prog Json := do
  let samples := (mapEntries (Twin.moduleValue call "sandboxUsageByKey")).map (·.2)
  let totals : List (String × Int) := samples.foldl
    (fun (acc : List (String × Int)) sample =>
      let type := text (field sample "type")
      let cpu := int (field sample "cpuUsec")
      if acc.any (·.1 == type) then acc.map fun entry =>
        if entry.1 == type then (type, entry.2 + cpu) else entry
      else acc ++ [(type, cpu)]) []
  return Json.mkObj (totals.map fun entry => (s!"sandbox.cpu_usec.{entry.1}", toJson entry.2))

/-- `takeToolCompute`: hands back and forgets one call's compute. -/
private def ledgerTakeToolCompute (call : Json) : Prog Json := do
  let before := Twin.moduleValue call "toolComputeByCallId"
  let id := Twin.callArg call 0
  setModule "toolComputeByCallId" before (mapDelete before id)
  return (mapGet before id).getD Twin.undefinedJson

/-! ### usage-metering.ts: `createStepTimingTracker` -/

/-- `attemptAttributes`, shared with `closeStep`, where the serializer is not reachable. -/
private def attemptAttributesOf (steps : Json) (step : Json) (serializes : Bool) : Prog Json := do
  let timing := (mapGet steps step).getD Twin.undefinedJson
  let attempts := array (field timing "attempts")
  let stepStart := field timing "startedAt"
  let errors := attempts.filterMap fun attempt =>
    let error := field attempt "error"
    if undef error || error == Json.null || error == toJson "" then none else some error
  let lastAttemptAt := (attempts.getLast?).map (fun attempt => field attempt "startedAt")
  let retryWait : Json :=
    match lastAttemptAt with
    | some at_ =>
      if attempts.length > 1 && isNumber at_ && isNumber stepStart then
        toJson (max 0 (int at_ - int stepStart))
      else Twin.undefinedJson
    | none => Twin.undefinedJson
  let serialized ←
    if errors.isEmpty then pure Twin.undefinedJson
    else if serializes then Prog.effect "serialize" [Json.arr errors.toArray]
    else Prog.unsupported "closeStep reaches the maker's serializer only through attemptAttributes"
  return obj
    [("model.attempts", if attempts.isEmpty then Twin.undefinedJson else toJson attempts.length),
     ("model.retry_wait_ms", retryWait),
     ("model.attempt_errors", serialized)]

private def trackerAttemptAttributes (call : Json) : Prog Json :=
  attemptAttributesOf (Twin.moduleValue call "steps") (Twin.callArg call 0) true

/-- `closeStep`: durations of one step's phases, then forgets the step. -/
private def trackerCloseStep (call : Json) : Prog Json := do
  let steps := Twin.moduleValue call "steps"
  let step := Twin.callArg call 0
  let end_ := int (Twin.callArg call 1)
  let timing := (mapGet steps step).getD Twin.undefinedJson
  let startMs := field timing "startedAt"
  let first := field timing "firstChunkAt"
  let last := if undef (field timing "lastChunkAt") then first else field timing "lastChunkAt"
  let ttft : Json :=
    if !undef first && !undef startMs then toJson (max 0 (int first - int startMs)) else Twin.undefinedJson
  let stream : Json :=
    if !undef first && !undef last then toJson (max 0 (int last - int first)) else Twin.undefinedJson
  let toolWait : Json :=
    if !undef last then toJson (max 0 (end_ - int last)) else Twin.undefinedJson
  let reasoning ← Prog.effect "windowMs" [field timing "reasoning"]
  let textMs ← Prog.effect "windowMs" [field timing "text"]
  let toolInput ← Prog.effect "windowMs" [field timing "toolInput"]
  let attempts ← attemptAttributesOf steps step false
  setModule "steps" steps (mapDelete steps step)
  let attemptEntries : List (String × Json) :=
    match attempts with
    | .obj entries => entries.toList
    | _ => []
  return Json.mkObj
    (([("model.ttft_ms", ttft)] ++ attemptEntries ++
      [("model.stream_ms", stream), ("model.tool_wait_ms", toolWait),
       ("model.reasoning_stream_ms", reasoning), ("model.text_stream_ms", textMs),
       ("model.tool_input_stream_ms", toolInput)]).filter fun entry => !undef entry.2)

/-- `startStep`: marks the step active. -/
private def trackerStartStep (call : Json) : Prog Json := do
  setModule "activeStepNumber" (Twin.moduleValue call "activeStepNumber")
    (Twin.callArg call 0)
  return Twin.undefinedJson

/-- `endActiveStep`: clears the active step only if it is the given one. -/
private def trackerEndActiveStep (call : Json) : Prog Json := do
  let active := Twin.moduleValue call "activeStepNumber"
  if active == Twin.callArg call 0 then
    setModule "activeStepNumber" active Twin.undefinedJson
  return Twin.undefinedJson

/-- `stepStartMs`. -/
private def trackerStepStartMs (call : Json) : Prog Json := do
  let timing := (mapGet (Twin.moduleValue call "steps") (Twin.callArg call 0)).getD Twin.undefinedJson
  return field timing "startedAt"

/-- `clear`: forgets every step and the active one. -/
private def trackerClear (call : Json) : Prog Json := do
  setModule "steps" (Twin.moduleValue call "steps") emptyMap
  setModule "activeStepNumber" (Twin.moduleValue call "activeStepNumber")
    Twin.undefinedJson
  return Twin.undefinedJson

/-! ### usage-metering.ts: `createTaskTotals` -/

private def anyPositive (totals : Json) : Bool :=
  match totals with
  | .obj entries => entries.toList.any fun entry => isNumber entry.2 && int entry.2 > 0
  | _ => false

/-- `finish`: a nonempty turn total replaces the folded one, and the step count is set. -/
private def totalsFinish (call : Json) : Prog Json := do
  let turnUsage := Twin.callArg call 0
  let totals ← Prog.effect "usageTokenTotals" [turnUsage]
  if anyPositive totals then
    setModule "usage" (Twin.moduleValue call "usage") turnUsage
  setModule "steps" (Twin.moduleValue call "steps") (Twin.callArg call 1)
  return Twin.undefinedJson

/-! ### deadline-policy.ts and lifecycle.ts -/

/-- `AGENT_MAX_TURN_UNLIMITED` in `agent-config.ts`. -/
private def maxTurnUnlimited : Int := 0

/-- `shouldStop`: past the wind-down point, either yield the worker slot or start winding down. -/
private def deadlineShouldStop (call : Json) : Prog Json := do
  let options := Twin.moduleValue call "options"
  let deadline := field options "deadlineMs"
  if undef deadline then
    return toJson false
  let now ← Prog.effect "options.now"
  if int now < int deadline - int (field options "windDownMs") then
    return toJson false
  if int (Twin.callArg call 1) > 0 then
    return toJson false
  let maxTurn := int (field options "maxTurn")
  let yielded := field options "canYield" == toJson true &&
    (maxTurn == maxTurnUnlimited || int (Twin.callArg call 0) < maxTurn)
  setModule "yielded" (Twin.moduleValue call "yielded") (toJson yielded)
  setModule "windingDown" (Twin.moduleValue call "windingDown") (toJson (!yielded))
  return toJson yielded

private def pad (width : Nat) (n : Int) : String :=
  let digits := toString n.toNat
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `new Date(ms).toISOString()`, by the days-to-civil algorithm. -/
private def isoFromMillis (ms : Int) : String :=
  let day := ms / 86400000
  let rest := ms - day * 86400000
  let z := day + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let d := doy - (153 * mp + 2) / 5 + 1
  let m := if mp < 10 then mp + 3 else mp - 9
  let y := yoe + era * 400 + (if m <= 2 then 1 else 0)
  s!"{pad 4 y}-{pad 2 m}-{pad 2 d}T{pad 2 (rest / 3600000)}:{pad 2 (rest / 60000 % 60)}:{pad 2 (rest / 1000 % 60)}.{pad 3 (rest % 1000)}Z"

private def truthy (value : Json) : Bool :=
  !(undef value || value == Json.null || value == toJson false || value == toJson "" ||
    value == toJson (0 : Nat))

/-- `emit`: posts the event to every webhook subscribed to it. A failed delivery is only logged. -/
private def lifecycleEmit (call : Json) : Prog Json := do
  let type := Twin.callArg call 0
  let payload := if undef (Twin.callArg call 1) then Json.mkObj [] else Twin.callArg call 1
  let targets := (array (Twin.moduleValue call "webhooks")).filter fun webhook =>
    undef (field webhook "events") || (array (field webhook "events")).contains type
  if targets.isEmpty then
    return Twin.undefinedJson
  let session := Twin.moduleValue call "session"
  let now ← Prog.effect "new Date"
  let event := obj
    [("type", type), ("timestamp", toJson (isoFromMillis (int now))),
     ("accountId", if truthy (field session "accountId") then field session "accountId" else Twin.undefinedJson),
     ("agentId", if truthy (field session "agentId") then field session "agentId" else Twin.undefinedJson),
     ("eventId", field session "eventId"), ("conversationKey", field session "conversationKey"),
     ("payload", payload)]
  let _ ← Prog.all (targets.map fun webhook =>
    ("fireWebhook", [obj [("url", field webhook "url"), ("secret", field webhook "secret")],
      event, Twin.moduleValue call "transport"]))
  return Twin.undefinedJson

/-! ### policy.ts -/

private def computerToolName : String := "computer"

private def nullish (value : Json) : Bool :=
  undef value || value == Json.null

private def firstPresent (values : List Json) : Json :=
  (values.find? fun value => !nullish value).getD Twin.undefinedJson

/-- `object` with one field replaced, as `{...object, name: value}`. -/
private def withField (object : Json) (name : String) (value : Json) : Json :=
  match object with
  | .obj entries =>
    Json.mkObj (((entries.toList.filter fun entry => entry.1 != name && entry.1 != "$keys")) ++
      [(name, value)])
  | _ => Json.mkObj [(name, value)]

/-- `approval` of `createRuntimeToolApproval`: policy denials win, then compatibility and configured
approvals; a computer call after one awaiting a person waits too. -/
private def runtimeToolApproval (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let options := Twin.moduleValue call "options"
  let event ← Prog.effect "asSandboxToolCall" [request, field options "sandboxStandIns"]
  let policy ←
    if undef (field options "policyApproval") then pure Twin.undefinedJson
    else Prog.effect "options.policyApproval" [event]
  let toolName := field (field request "toolCall") "toolName"
  let configured :=
    if (plain 16 event).compress != (plain 16 request).compress &&
        (mapGet (field options "configuredApprovals") toolName).isSome
      then toJson "user-approval" else Twin.undefinedJson
  let first ← Prog.effect "approvalDecision" [policy]
  let eventTool := field (field event "toolCall") "toolName"
  let status ←
    if first == toJson "denied" then pure policy
    else do
      let compatible ← Prog.effect "compatibilityApprovalStatus"
        [eventTool, field (field event "toolCall") "input", options]
      pure (firstPresent [compatible, configured, policy])
  if eventTool != toJson computerToolName then
    return status
  let decision ← Prog.effect "approvalDecision" [status]
  let waits := Twin.moduleValue call "computerWaits"
  if decision == toJson "user-approval" then
    setModule "computerWaits" waits (toJson true)
  else if waits == toJson true && decision != toJson "denied" then
    return obj
      [("type", toJson "user-approval"),
       ("reason", toJson s!"Waits for the {computerToolName} call before it, which needs approval.")]
  return status

/-- `onDecision` of `createPolicyToolApproval`: an enforced denial is appended to the audit ledger. -/
private def policyOnDecision (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let toolCall := field event "toolCall"
  let decision := field event "decision"
  let baseInput := Twin.moduleValue call "baseInput"
  let mode := Twin.moduleValue call "mode"
  let reason := field decision "reason"
  let policyInput ← Prog.effect "policyInputForTool"
    [field toolCall "toolName", field toolCall "input", Twin.moduleValue call "workspaces",
     Twin.moduleValue call "options"]
  let action := field policyInput "action"
  let _ ← Prog.effect "policyDecisionLogMessage"
    [obj [("action", action), ("decision", field decision "type"), ("enforced", field event "enforced"),
          ("inputPreview", field (field policyInput "tool") "inputPreview"), ("mode", mode),
          ("reason", reason), ("toolName", field toolCall "toolName")]]
  if field decision "type" == toJson "denied" && field event "enforced" == toJson true then
    let _ ← Prog.effect "getStorage"
    let suffix := if truthy reason then s!": {text reason}" else ""
    let entry := obj
      [("accountId", Twin.moduleValue call "accountId"), ("agentId", field baseInput "agentId"),
       ("chain", field (field baseInput "principal") "chain"),
       ("traceId", field (Twin.observabilityContext call) "traceId"),
       ("action", toJson "tool.denied"),
       ("resource", obj [("kind", toJson "tool"), ("name", field toolCall "toolName")]),
       ("summary", toJson s!"Policy denied {text (field toolCall "toolName")} ({text action}){suffix}"),
       ("details", obj
         [("action", action), ("toolCallId", field toolCall "toolCallId"), ("reason", reason),
          ("mcpId", field policyInput "mcpId"), ("workspaceId", field policyInput "workspaceId"),
          ("filePath", field policyInput "filePath"), ("skillPath", field policyInput "skillPath"),
          ("subagentId", field policyInput "subagentId"),
          ("channelId", field baseInput "channelId"), ("userId", field baseInput "userId")])]
    Prog.spawn "getStorage().auditLedger.append" [entry]
    let _ ← Prog.effect "waitUntil" [Json.mkObj [("$opaque", toJson "Promise")]]
  return Twin.undefinedJson

/-- `evaluate` of `withEvaluationDeadline`: the client's answer, or a timeout when it never settles. -/
private def evaluationDeadline (call : Json) : Prog Json := do
  let outcome ← Prog.attempt "client.evaluate" [Twin.callArg call 0, Twin.callArg call 1]
  let _ ← Prog.effect "clearTimeout" [Json.mkObj [("$opaque", toJson "Timeout")]]
  match outcome with
  | .ok value => return value
  | .threw error _ => throw error
  | .pending =>
    Prog.throwError "Error"
      s!"OPA evaluation timed out after {int (Twin.moduleValue call "timeoutMs")}ms"

/-! ### subagents.ts -/

/-- `publish` of `bestEffortSubagentPublisher`: an error event is remembered, a failed publish is only logged. -/
private def subagentPublish (call : Json) : Prog Json := do
  let data := Twin.callArg call 0
  if field data "type" == toJson "error" then
    let state := Twin.moduleValue call "state"
    setModule "state" state (withField state "emittedError" (toJson true))
  let _ ← Prog.attempt "publisher.publish" [data]
  return Twin.undefinedJson

/-- `close` of `bestEffortSubagentPublisher`: a failed flush is only logged. -/
private def subagentClose (_call : Json) : Prog Json := do
  let _ ← Prog.attempt "publisher.close"
  return Twin.undefinedJson

/-- `finishedBefore` of `lostResultWindows`: pending handbacks use the abandon cutoff. -/
private def finishedBefore (call : Json) : Prog Json := do
  if Twin.callArg call 0 == toJson "pending" then
    return Twin.moduleValue call "abandonedBefore"
  return Twin.moduleValue call "settledBefore"

/-! ### provider.ts -/

private def providerFile : String := "apps/core/src/harness/provider.ts"

/-- A thrown outcome as the value it carries. -/
private def thrown (outcome : Outcome) : Prog Json :=
  match outcome with
  | .threw error _ => throw error
  | _ => Prog.unsupported "an effect that never settled"

/-- `wrapGenerate` of `retryingMiddleware`: one retry on a recovered request, reported to `retried`. -/
private def retryingWrapGenerate (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let retried := Twin.moduleValue call "retried"
  let report (error : Json) : Prog Unit := do
    if !undef retried then
      let _ ← Prog.effect "retried" [error]
  match ← Prog.attempt "doGenerate" with
  | .ok value => return value
  | .threw error _ =>
    let retry ← Prog.effect "recover" [error, field input "params"]
    if nullish retry || retry == toJson false then
      throw error
    match ← Prog.attempt "model.doGenerate" [retry] with
    | .ok value =>
      match ← Prog.attempt "retried" [Twin.undefinedJson] with
      | .threw reportError _ =>
        report reportError
        throw reportError
      | _ => return value
    | .threw retryError _ =>
      report retryError
      throw retryError
    | .pending => Prog.unsupported "a retry that never settled"
  | .pending => Prog.unsupported "a model call that never settled"

/-- `wrapStream` of `attemptRecordingMiddleware`: records the start, and the error if the stream fails. -/
private def attemptRecordingWrapStream (_call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "record" [Json.mkObj [("startedAt", now)]]
  match ← Prog.attempt "doStream" with
  | .ok value => return value
  | .threw error _ =>
    let _ ← Prog.effect "describeError" [error]
    throw error
  | .pending => Prog.unsupported "a stream start that never settled"

/-- The retry callback of `moveRefusedToolImagesMiddleware`: remembers an endpoint that refused. -/
private def toolImageRefusalReport (call : Json) : Prog Json := do
  let retryError := Twin.callArg call 0
  let refused ←
    if undef retryError then pure true
    else do
      let answer ← Prog.effect "isRefusedRequest" [retryError]
      pure (answer == toJson true)
  if refused then
    let endpoint := Twin.moduleValue call "endpoint"
    let before := Twin.moduleValue call "toolImageRefusals"
    let members := array (field before "$set")
    if !members.contains endpoint then
      Prog.setState "module.toolImageRefusals"
        (Json.mkObj [("$set", Json.arr (members ++ [endpoint]).toArray)])
  return Twin.undefinedJson

/-- `transformParams` of `moveRefusedToolImagesMiddleware`: tool images move once the endpoint refused them. -/
private def toolImageTransformParams (call : Json) : Prog Json := do
  let params := field (Twin.callArg call 0) "params"
  let refused := (array (field (Twin.moduleValue call "toolImageRefusals") "$set")).contains
    (Twin.moduleValue call "endpoint")
  let prompt ← Prog.effect (if refused then "toolImagesAsUserMessages" else "withTextToolResultsAsText")
    [field params "prompt"]
  return withField params "prompt" prompt

/-- The model builder `createCloudflare` returns when a gateway is configured. -/
private def cloudflareGatewayModel (call : Json) : Prog Json := do
  let modelId := Twin.callArg call 0
  let workersModel ← Prog.effect "workersAIModelId" [modelId]
  if (text workersModel).startsWith "@" then
    Prog.effect "workersAI"
      [workersModel, Json.mkObj [("extraHeaders", Twin.moduleValue call "gatewayAuth")]]
  else
    Prog.effect "compatible" [modelId]

/-- The `ollama` factory: an empty base URL means Ollama Cloud. -/
private def ollamaFactory (call : Json) : Prog Json := do
  let settings := Twin.callArg call 0
  let base := field settings "baseURL"
  let trimmed := if nullish base then "" else (text base).trimAscii.toString
  Prog.effect "createOllama"
    [withField settings "baseURL" (toJson (if trimmed == "" then "https://ollama.com" else trimmed))]

/-! ### ai-sdk-harness -/

private def harnessFile : String := "apps/core/src/harness/ai-sdk-harness"

/-- `stop` of `startHarnessLeaseMonitor`: marks the monitor done and clears its timer. -/
private def leaseMonitorStop (call : Json) : Prog Json := do
  setModule "done" (Twin.moduleValue call "done") (toJson true)
  let _ ← Prog.effect "clearInterval" [Twin.moduleValue call "timer"]
  return Twin.undefinedJson

/-- `dispose` of `prepareHarnessTurn`: stops the lease monitor, then destroys the harness session. -/
private def harnessDispose (call : Json) : Prog Json := do
  let _ ← Prog.effect "stopLeaseMonitor"
  let _ ← Prog.effect "destroyHarnessSession" [Twin.moduleValue call "harnessSession"]
  return Twin.undefinedJson

/-- `appendMany` of `createPiSessionStorage`: each entry is fitted, then all are appended at once. -/
private def piAppendMany (call : Json) : Prog Json := do
  let entries := array (field (Twin.callArg call 0) "entries")
  let mut rows : List Json := []
  for entry in entries do
    let data := field entry "data"
    let fitted ← Prog.effect "fitPiEntry" [data]
    rows := rows ++ [obj
      [("entryId", field entry "entryId"), ("parentEntryId", field entry "parentEntryId"),
       ("version", field entry "version"), ("entry", fitted),
       ("firstKeptEntryId",
         if field data "type" == toJson "compaction" then field data "firstKeptEntryId"
         else Twin.undefinedJson)]]
  let _ ← Prog.effect "session.appendHarnessSessionEntries" [Json.arr rows.toArray]
  return Twin.undefinedJson

/-- `read` of `createPiSessionStorage`: each stored row's entry is parsed back. -/
private def piRead (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let rows ← Prog.effect "session.readHarnessSessionEntries"
    [field input "sessionId", field input "leafId"]
  let mut entries : List Json := []
  for row in array rows do
    match Json.parse (text (field row "entry")) with
    | .ok data =>
      entries := entries ++ [obj
        [("entryId", field row "entryId"), ("parentEntryId", field row "parentEntryId"),
         ("version", field row "version"), ("data", data)]]
    | .error _ => return ← Prog.throwError "SyntaxError" "stored entry is not JSON"
  return Json.arr entries.toArray

/-! ### harness.ts: `runAgentLoop` -/

private def harnessLoopFile : String := "apps/core/src/harness/harness.ts"

/-- `MAX_TRACE_ATTRIBUTE_CHARS` in `harness.ts`. -/
private def maxTraceAttributeChars : Nat := 32000

/-- `traceAttribute` on `value`: scrubbed of the run's secrets and cut to the attribute limit. -/
private def redactAttribute (call value : Json) : Prog Json := do
  let secrets := field (Twin.observabilityContext call) "secretValues"
  Prog.effect "redactSerialized"
    [value, if undef secrets then Json.arr #[] else secrets, toJson maxTraceAttributeChars]

/-- `traceAttribute`, traced on its own. -/
private def traceAttribute (call : Json) : Prog Json := redactAttribute call (Twin.callArg call 0)

/-- `onChunk`: stamps the chunk type into the active step's timing. -/
private def onChunk (call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "stepTiming.recordChunk" [field (field (Twin.callArg call 0) "chunk") "type", now]
  return Twin.undefinedJson

/-- The stream watcher's error callback: the first error stops the run, unless it already stopped. -/
private def watchModelStreamError (call : Json) : Prog Json := do
  if Twin.abortedRead call 0 then
    return Twin.undefinedJson
  let error := Twin.callArg call 0
  let terminal := Twin.moduleValue call "terminalError"
  if undef terminal then
    setModule "terminalError" terminal error
  let _ ← Prog.effect "runAbort.abort" [error]
  return Twin.undefinedJson

/-- `yielded` of the returned stream: the run gave up its worker slot without failing. -/
private def streamYielded (call : Json) : Prog Json := do
  let yielded ← Prog.effect "deadline.hasYielded"
  return toJson (yielded == toJson true && Twin.moduleValue call "didFail" != toJson true)

/-- `release` of the run finalizer: detaches the abort listener. -/
private def finalizerRelease (call : Json) : Prog Json := do
  if !undef (Twin.moduleValue call "releaseSandboxOccupancy") then
    return ← Prog.unsupported "a held sandbox occupancy is released through a callback the model does not name"
  if !undef (field (Twin.moduleValue call "options") "abortSignal") then
    let _ ← Prog.effect "options.abortSignal?.removeEventListener"
      [toJson "abort", Twin.moduleValue call "abortRun"]
  return Twin.undefinedJson

/-- `restoreObservabilityContext`: puts back the context the run found. -/
private def restoreObservabilityContext (call : Json) : Prog Json := do
  let _ ← Prog.effect "setObservabilityContext" [Twin.moduleValue call "parentObservabilityContext"]
  return Twin.undefinedJson

/-- `rootAttributes`: the root span's running attributes plus the system prompt's. -/
private def rootAttributes (call : Json) : Prog Json := do
  let system ← Prog.effect "systemTraceAttributes"
    [field (Twin.moduleValue call "turnContext") "system", Json.mkObj [("$fn", toJson "traceAttribute")]]
  -- `traceAttribute` ran inside that call. Without trace room of its own, its calls show here, in
  -- the order they started, and each is a redaction.
  Prog.drain (fun _ given => do let _ ← redactAttribute call (Twin.arg given 0)) 64
  let entriesOf (value : Json) : List (String × Json) :=
    match value with
    | .obj entries => entries.toList.filter fun entry => entry.1 != "$keys"
    | _ => []
  let base := entriesOf (Twin.moduleValue call "rootRunningAttributes")
  let over := entriesOf system
  return Json.mkObj (base.filter (fun entry => !over.any (·.1 == entry.1)) ++ over)

/-- `openWork` of the run finalizer: what the run left open after it ended. -/
private def finalizerOpenWork (call : Json) : Prog Json := do
  let options := Twin.moduleValue call "options"
  Prog.effect "openWorkAfterRun"
    [obj [("conversationKey", firstPresent [field (Twin.moduleValue call "session") "conversationKey", Twin.field (Twin.moduleValue call "session") "conversationKey"]),
          ("awaitingApproval", toJson (decide ((array (Twin.moduleValue call "approvalSummaries")).length > 0))),
          ("detachedResultIds", Twin.moduleValue call "detachedResultIds"),
          ("questionSummaries", Twin.moduleValue call "questionSummaries"),
          ("pendingWork", field options "pendingWork")]]

/-- The `onStepStart` handed to a harness: the loop's own step start, then any steer waiting for it. -/
private def harnessStepStart (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  Prog.drain (fun _ _ => pure ()) 8
  let _ ← Prog.effect "streamOptions.onStepStart" [event]
  match ← Prog.attempt "steerHarnessTurn"
      [Twin.moduleValue call "session", Twin.moduleValue call "activeHarnessSession",
       field (field (Twin.moduleValue call "agentConfig") "harness") "type"] with
  | .threw error _ =>
    let _ ← Prog.effect "runAbort.abort" [error]
  | _ => pure ()
  return Twin.undefinedJson

/-- `WIND_DOWN_INSTRUCTION` in `harness.ts`. -/
private def windDownInstruction : String :=
  "This turn is out of time. Reply now with what you have so far and say what is left; the user can ask you to continue."

/-- `prepareStep`: stores the finished step, applies steering and parent messages, and refreshes the
system prompt. A step with messages to store needs the run's random dedupe keys, so it is not modelled. -/
private def prepareStep (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let responseMessages := array (field input "responseMessages")
  let messages := array (field input "messages")
  let persisted := (int (Twin.moduleValue call "persistedResponseCount")).toNat
  if (responseMessages.drop persisted).length > 0 then
    return ← Prog.unsupported "dedupe keys embed the run's random id"
  let winding ← Prog.effect "deadline.isWindingDown"
  let boundary ← Prog.effect "session.stepBoundary"
    [Json.arr #[], obj [("claimSteering", toJson (!(winding == toJson true))),
      ("dedupeKeys", Json.arr #[])]]
  if field boundary "renewal" == toJson "stopped" then
    return ← Prog.throwError "Error" (text (Twin.moduleValue call "stopMessage"))
  if field boundary "renewal" == toJson "stale" then
    return ← Prog.throwError "Error" "Conversation ownership changed before the next model step"
  setModule "persistedResponseCount" (Twin.moduleValue call "persistedResponseCount")
    (toJson responseMessages.length)
  let turnContext := Twin.moduleValue call "turnContext"
  let session := Twin.moduleValue call "session"
  let steering := field boundary "steering"
  let mut ephemeral := array (field turnContext "ephemeralSystem")
  let mut stepMessages := messages
  let mut changed := false
  if !nullish steering then
    let events := field steering "events"
    let steeringSystem ← Prog.effect "session.appendIngressEvents" [events]
    ephemeral := ephemeral ++ array steeringSystem
    let extra ← Prog.effect "steeringModelMessages"
      [events, Twin.moduleValue call "agentConfig",
       firstPresent [field session "accountId", Twin.field session "accountId"]]
    stepMessages := stepMessages ++ array extra
    changed := true
  let watch := field (Twin.moduleValue call "options") "subagentWatch"
  let parentMessages ←
    if undef watch then pure []
    else do
      let taken ← Prog.effect "options.subagentWatch?.takeParentMessages"
      pure (if nullish taken then [] else array taken)
  if parentMessages.length > 0 then
    let stripped ← Prog.effect "stripEnvelopeFieldsFromMessages" [Json.arr parentMessages.toArray]
    stepMessages := stepMessages ++ array stripped
    changed := true
  let refreshed ← Prog.effect "session.loadRefreshedSystemPromptParts"
    [obj [("systemContextSnapshot", Twin.moduleValue call "systemContextSnapshot"),
          ("ephemeralSystem", Json.arr ephemeral.toArray)]]
  setModule "systemContextSnapshot" (Twin.moduleValue call "systemContextSnapshot")
    (field refreshed "systemContextSnapshot")
  let instructions ← Prog.effect "withCacheBreakpoint"
    [field refreshed "system", Twin.moduleValue call "cacheBreakpoint", field refreshed "storedSystemEnd"]
  setModule "turnContext" turnContext
    (withField (withField turnContext "ephemeralSystem" (Json.arr ephemeral.toArray)) "system"
      (field refreshed "system"))
  let windingNow ← Prog.effect "deadline.isWindingDown"
  let messagesField : List (String × Json) :=
    if changed then [("messages", Json.arr stepMessages.toArray)] else []
  if windingNow == toJson true then
    return Json.mkObj
      ([("instructions", Json.arr (array instructions ++
          [obj [("role", toJson "system"), ("content", toJson windDownInstruction)]]).toArray),
        ("toolChoice", toJson "none")] ++ messagesField)
  return Json.mkObj ([("instructions", instructions)] ++ messagesField)

/-! ### usage-metering.ts: getters -/

private def totalsUsage (call : Json) : Prog Json :=
  pure (Twin.moduleValue call "usage")

private def totalsSteps (call : Json) : Prog Json :=
  pure (Twin.moduleValue call "steps")

private def totalsCacheWriteTokens (call : Json) : Prog Json :=
  pure (Twin.moduleValue call "cacheWriteTokens")

private def trackerActiveStep (call : Json) : Prog Json :=
  pure (Twin.moduleValue call "activeStepNumber")

/-- `usage` of the CPU ledger: every per-key total, in the order first recorded. -/
private def ledgerUsage (call : Json) : Prog Json :=
  pure (Json.arr ((mapEntries (Twin.moduleValue call "sandboxUsageByKey")).map (·.2)).toArray)

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [ Twin.traced s!"{usageFile}#createSandboxCpuLedger/record" ledgerRecord
  , Twin.traced s!"{usageFile}#createSandboxCpuLedger/roleAttributes" ledgerRoleAttributes
  , Twin.traced s!"{usageFile}#createSandboxCpuLedger/typeAttributes" ledgerTypeAttributes
  , Twin.traced s!"{usageFile}#createSandboxCpuLedger/takeToolCompute" ledgerTakeToolCompute
  , Twin.traced s!"{usageFile}#createStepTimingTracker/attemptAttributes" trackerAttemptAttributes
  , Twin.traced s!"{usageFile}#createStepTimingTracker/closeStep" trackerCloseStep
  , Twin.traced s!"{usageFile}#createStepTimingTracker/startStep" trackerStartStep
  , Twin.traced s!"{usageFile}#createStepTimingTracker/endActiveStep" trackerEndActiveStep
  , Twin.traced s!"{usageFile}#createStepTimingTracker/stepStartMs" trackerStepStartMs
  , Twin.traced s!"{usageFile}#createStepTimingTracker/clear" trackerClear
  , Twin.traced s!"{usageFile}#createTaskTotals/finish" totalsFinish
  , Twin.traced "apps/core/src/harness/deadline-policy.ts#createDeadlinePolicy/shouldStop" deadlineShouldStop
  , Twin.traced "apps/core/src/harness/lifecycle.ts#createAgentLifecycleEmitter/emit" lifecycleEmit
  , Twin.traced "apps/core/src/harness/policy.ts#createRuntimeToolApproval/approval" runtimeToolApproval
  , Twin.traced "apps/core/src/harness/policy.ts#createPolicyToolApproval/onDecision" policyOnDecision
  , Twin.traced "apps/core/src/harness/policy.ts#withEvaluationDeadline/evaluate" evaluationDeadline
  , Twin.traced "apps/core/src/harness/subagents.ts#bestEffortSubagentPublisher/publish" subagentPublish
  , Twin.traced "apps/core/src/harness/subagents.ts#bestEffortSubagentPublisher/close" subagentClose
  , Twin.traced "apps/core/src/harness/subagents.ts#lostResultWindows/finishedBefore" finishedBefore
  , Twin.traced s!"{providerFile}#retryingMiddleware/wrapGenerate" retryingWrapGenerate
  , Twin.traced s!"{providerFile}#attemptRecordingMiddleware/wrapStream" attemptRecordingWrapStream
  , Twin.traced s!"{providerFile}#moveRefusedToolImagesMiddleware/arg1" toolImageRefusalReport
  , Twin.traced s!"{providerFile}#moveRefusedToolImagesMiddleware/transformParams" toolImageTransformParams
  , Twin.traced s!"{providerFile}#createCloudflare/return~2" cloudflareGatewayModel
  , Twin.traced s!"{providerFile}#modelProviderFactories/ollama" ollamaFactory
  , Twin.traced s!"{harnessFile}/session.ts#startHarnessLeaseMonitor/stop" leaseMonitorStop
  , Twin.traced s!"{harnessFile}/session.ts#prepareHarnessTurn/dispose" harnessDispose
  , Twin.traced s!"{harnessFile}/adapters/pi.ts#createPiSessionStorage/appendMany" piAppendMany
  , Twin.traced s!"{harnessFile}/adapters/pi.ts#createPiSessionStorage/read" piRead
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/traceAttribute" traceAttribute
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/onChunk" onChunk
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/arg2" watchModelStreamError
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/yielded" streamYielded
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/release" finalizerRelease
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/restoreObservabilityContext" restoreObservabilityContext
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/rootAttributes" rootAttributes
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/openWork" finalizerOpenWork
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/onStepStart~2" harnessStepStart
  , Twin.traced s!"{harnessLoopFile}#runAgentLoop/prepareStep" prepareStep
  , Twin.traced s!"{usageFile}#createTaskTotals/usage" totalsUsage
  , Twin.traced s!"{usageFile}#createTaskTotals/steps" totalsSteps
  , Twin.traced s!"{usageFile}#createTaskTotals/cacheWriteTokens" totalsCacheWriteTokens
  , Twin.traced s!"{usageFile}#createStepTimingTracker/activeStep" trackerActiveStep
  , Twin.traced s!"{usageFile}#createSandboxCpuLedger/usage" ledgerUsage ]

end Spec.Agent.Closures
