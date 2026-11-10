import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign6/agent6a.tsv`.

`runAgentLoop` is modelled through the start of its stream and the `streamOptions` callbacks. A
recording closes one microtask after the function returns, so a callback is seen only up to its
second suspension. A recording cannot replay an await it never saw settle: those calls opt out.
-/

namespace Spec.Agent.Waveagent6a

open Lean Spec

def maxTraceAttributeChars : Nat := 32000
def maxTaskInputChars : Nat := 500
def maxAgentIterations : Nat := 30
def deadlineWindDownMs : Nat := 180000
def userStopMessage : String := "Stopped by user at the model boundary"
def computerToolName : String := "computer"

/-- The most callbacks one drain handles. -/
def maxCallbacks : Nat := 256

private def undef : Json := Twin.undefinedJson

private def isUndefined (value : Json) : Bool :=
  value.compress == undef.compress

private def nullish (value : Json) : Bool :=
  isUndefined value || value.compress == "null"

private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str text => !text.isEmpty
  | .num number => number.mantissa != 0
  | other => !isUndefined other

private def get (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

/-- A session is a test's plain object or a recorded `Session` instance. -/
private def sessionField (session : Json) (name : String) : Json :=
  let direct := get session name
  if isUndefined direct then Twin.field session name else direct

/-- An object literal: the recorder drops keys whose value is `undefined`. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter (fun entry => !isUndefined entry.2))

private def entries (value : Json) : List (String × Json) :=
  match value with
  | .obj kvs =>
    if isUndefined value then []
    else (kvs.keys.filter (· != "$keys")).map fun key => (key, get value key)
  | _ => []

private def fn (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

private def emptyMap : Json :=
  Json.mkObj [("$map", Json.arr #[])]

private def runSignal : Json :=
  Json.mkObj [("$signal", toJson false)]

private def firstOf (value : Json) : Json :=
  match value with
  | .arr items => items.getD 0 undef
  | _ => undef

private def lengthOf (value : Json) : Nat :=
  match value with
  | .arr items => items.size
  | _ => 0

/-- `Object.keys`, in the recorded key order when there is one. -/
private def keysOf (value : Json) : List Json :=
  match value.getObjVal? "$keys", value with
  | .ok (.arr keys), _ => keys.toList
  | _, .obj kvs => kvs.keys.map toJson
  | _, _ => []

private def elapsed (later earlier : Json) : Json :=
  match later.getInt?, earlier.getInt? with
  | .ok a, .ok b => toJson (a - b)
  | _, _ => Json.null

private def isError (value : Json) : Bool :=
  !isUndefined (get value "$error")

private def outcomeValue : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "an effect that never finished"

/-- What stays fixed through one call. -/
structure Ctx where
  session : Json
  turnContext : Json
  agentConfig : Json
  reply : Json
  options : Json
  secrets : Json
  parentContext : Json

private def handleCallback (c : Ctx) (occupied : Bool) (label : String) (args : Json) :
    Prog Bool := do
  match label with
  | "traceAttribute" =>
    let _ ← Prog.effect "redactSerialized"
      [Twin.arg args 0, c.secrets, toJson maxTraceAttributeChars]
    pure occupied
  | "applySteering" =>
    let _ ← Prog.effect "applyHarnessSteeringBeforeTurn" [c.session, c.turnContext, c.agentConfig]
    pure occupied
  | "onOccupied" => pure true
  | "release" =>
    if truthy (get c.options "abortSignal") then
      let _ ← Prog.effect "options.abortSignal?.removeEventListener" [toJson "abort", fn "abortRun"]
    if occupied then
      let _ ← Prog.effect "releaseSandboxOccupancy"
    pure occupied
  | "rootAttributes" =>
    let _ ← Prog.effect "systemTraceAttributes" [get c.turnContext "system", fn "traceAttribute"]
    pure occupied
  | "restoreObservabilityContext" =>
    let _ ← Prog.effect "setObservabilityContext" [c.parentContext]
    pure occupied
  | other => Prog.unsupported s!"callback {other}"

private def drainCallbacks (c : Ctx) : Nat → Bool → Prog Bool
  | 0, occupied => pure occupied
  | limit + 1, occupied =>
    .input fun
      | none => pure occupied
      | some (label, args) =>
        (handleCallback c occupied label args).bind (drainCallbacks c limit)

/-- `traceAttribute` called from the function's own body. -/
private def trace (c : Ctx) (value : Json) : Prog Json :=
  .input fun
    | some ("traceAttribute", _) =>
      Prog.effect "redactSerialized" [value, c.secrets, toJson maxTraceAttributeChars]
    | _ => Prog.throwError "Twin" "traceAttribute was not entered"

private def systemAttributes (c : Ctx) (nested : Bool := false) : Prog Json := do
  let system := get c.turnContext "system"
  let text := "\n\n".intercalate ((system.getArr?.toOption.getD #[]).toList.map
    fun part => (get part "content").getStr?.toOption.getD "")
  if nested then
    let attributes ← Prog.effect "systemTraceAttributes" [system, fn "traceAttribute"]
    let _ ← trace c (toJson text)
    return attributes
  let _ ← trace c (toJson text)
  Prog.effect "systemTraceAttributes" [system, fn "traceAttribute"]

/-- `.slice(0, n)` counts UTF-16 units, which equal characters unless a long text is astral. -/
private def sliceText (value : Json) (limit : Nat) : Prog Json :=
  match value with
  | .str text =>
    if text.length <= limit then pure value
    else if text.toList.any (fun ch => ch.toNat > 0xFFFF) then
      Prog.unsupported "slice through astral text"
    else pure (toJson (String.ofList (text.toList.take limit)))
  | other => pure other

/-- What the run's callbacks share. `Ctx` plus the values they read from the run's body. -/
structure Run where
  c : Ctx
  hooks : Json
  providerName : Json
  startedAt : Json
  responseRunKey : Json
  modelOutput : Json
  deadlineRun : Bool

/-- The mutable locals of the run that a callback reads back. -/
structure St where
  lastStepText : String := ""
  didFail : Bool := false
  /-- `toolCallSummaries` has entries. Their value is not an effect's answer, so reads opt out. -/
  summaries : Bool := false

/-- What runs when a callback's first `await` settles. -/
abbrev Resume := St → Prog St

/-- Names of the tools that deliver the reply themselves. -/
def deliveryToolNames : List String := ["send-message", "send-files", "send-images", "send-reactions", "send-sticker"]

private def textOf (value : Json) : String :=
  value.getStr?.toOption.getD ""

private def listOf (value : Json) : List Json :=
  match value with
  | .arr items => items.toList
  | _ => []

private def toolSummaries (st : St) : Prog Json :=
  if st.summaries then Prog.unsupported "a tool summary map with entries"
  else Prog.effect "summarizeToolsUsed" [emptyMap]

/-- The `agent.failed` event `announceFailure` emits. -/
private def failureEvent (st : St) (message : Json) : Prog Json := do
  let tools ← toolSummaries st
  let toolsUsed ← Prog.effect "toLifecycleValue" [get tools "toolsUsed"]
  let toolUsage ← Prog.effect "toLifecycleValue" [get tools "toolUsage"]
  let toolCalls ← Prog.effect "toLifecycleValue" [get tools "toolCalls"]
  pure (obj [("error", message), ("toolsUsed", toolsUsed), ("toolUsage", toolUsage),
             ("toolCalls", toolCalls)])

/-- `announceFailure` inside a callback, where the recording never sees the event settle. -/
private def announceFailure (st : St) (message : Json) : Prog St := do
  let event ← failureEvent st message
  Prog.spawn "lifecycle.emit" [toJson "agent.failed", event]
  if truthy (← Prog.effect "hooks.hasHooksFor" [toJson "agent.failed"]) then
    Prog.unsupported "an agent.failed hook"
  pure st

/-- The `.catch` on `onErrorText` takes more microtasks than the recording stays open, so only a
run with no `reply` is seen going on to announce the failure. -/
private def failedReply (r : Run) (st : St) (message : Json) : Prog (St × Option Resume) := do
  if nullish r.c.reply then
    pure (st, some fun st => announceFailure st message)
  else
    Prog.spawn "reply?.onErrorText" [message]
    pure (st, none)

/-- The `catch` of `onEnd`, up to where it waits on `onErrorText`. -/
private def onEndCaught (r : Run) (st : St) (error : Json) : Prog (St × Option Resume) := do
  let message ← Prog.effect "errorMessage" [error]
  let _ ← toolSummaries st
  let _ ← Prog.effect "Date.now"
  let _ ← Prog.effect "serializeError" [error]
  failedReply r { st with didFail := true } message

/-- `onEnd` after its messages are stored, up to its next `await`. -/
private def onEndStored (r : Run) (tools text finishReason : Json) (stepCount toolCallCount : Nat)
    (approvals : List Json) (durationMs : Json) (st : St) : Prog St := do
  if !approvals.isEmpty then
    let _ ← Prog.effect "deadline.withdrawYield"
  if truthy (← Prog.effect "deadline.hasYielded") then
    return st
  let finalText := (if st.lastStepText.isEmpty then textOf text else st.lastStepText).trimAscii.toString
  let delivered :=
    finishReason.compress == (toJson "stop").compress &&
    (listOf (get tools "toolCalls")).any fun call =>
      deliveryToolNames.contains (textOf (get call "toolName")) &&
      (get call "success").compress == (toJson true).compress
  if approvals.isEmpty && !truthy r.modelOutput && finalText.isEmpty && !delivered then
    if st.didFail then
      return st
    let _ ← Prog.effect "Date.now"
    let _ ← Prog.effect "taskTotals.usage"
    if !nullish r.c.reply then
      Prog.spawn "reply?.onErrorText"
        [toJson ("Model returned empty response (finishReason: " ++ textOf finishReason ++
          ", steps: " ++ toString stepCount ++ ", toolCalls: " ++ toString toolCallCount ++ ")")]
    return { st with didFail := true }
  let usage ← Prog.effect "taskTotals.usage"
  let _ ← Prog.effect "formatUsageSummary" [usage]
  let _ ← Prog.effect "formatDuration" [durationMs]
  if !approvals.isEmpty then
    let lifecycleApprovals ← Prog.effect "toLifecycleValue" [Json.arr approvals.toArray]
    let toolsUsed ← Prog.effect "toLifecycleValue" [get tools "toolsUsed"]
    let toolUsage ← Prog.effect "toLifecycleValue" [get tools "toolUsage"]
    let toolCalls ← Prog.effect "toLifecycleValue" [get tools "toolCalls"]
    Prog.spawn "lifecycle.emit"
      [toJson "agent.approval.required",
       obj [("approvals", lifecycleApprovals), ("toolsUsed", toolsUsed), ("toolUsage", toolUsage),
            ("toolCalls", toolCalls)]]
    return st
  if truthy r.modelOutput then
    Prog.unsupported "structured output after the model finished"
  Prog.spawn "foldAgentFinished" [r.hooks, toJson finalText, finishReason]
  pure st

/-- `onEnd`, up to the `await` that stores the response. -/
private def onEnd (r : Run) (st : St) (args : Json) : Prog (St × Option Resume) := do
  if r.deadlineRun then
    Prog.unsupported "a deadline run's test never settles its store of the response"
  let responseMessages := Twin.arg args 1
  let text := Twin.arg args 2
  let finishReason := Twin.arg args 3
  let steps := listOf (Twin.arg args 5)
  let toolCalls := listOf (Twin.arg args 6)
  if !toolCalls.isEmpty then
    Prog.unsupported "tool calls that onEnd adds to the summary map"
  let _ ← Prog.effect "taskTotals.finish" [Twin.arg args 7, toJson steps.length]
  let requests ← Prog.effect "extractApprovalRequests" [Twin.arg args 5]
  let approvals := (listOf requests).filter (fun request => !truthy (get request "isAutomatic")) |>.map
    fun request => obj
      [("approvalId", get request "approvalId"),
       ("toolCallId", get (get request "toolCall") "toolCallId"),
       ("toolName", get (get request "toolCall") "toolName"),
       ("input", get (get request "toolCall") "input")]
  let tools ← toolSummaries st
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "taskTotals.usage"
  let durationMs := elapsed now r.startedAt
  let unpersisted ←
    if lengthOf requests > 0 then
      Prog.effect "withApprovalToolCalls" [responseMessages, requests]
    else pure responseMessages
  let dedupeKeys := (List.range (lengthOf responseMessages)).map fun index =>
    toJson (textOf r.responseRunKey ++ ":" ++ toString index)
  let stored ← Prog.attempt "session.persistModelMessages"
    [unpersisted, obj [("dedupeKeys", Json.arr dedupeKeys.toArray)]]
  match stored with
  | .threw error true => onEndCaught r st error
  | .threw error false =>
    pure (st, some fun st => do
      let (next, _) ← onEndCaught r st error
      pure next)
  | _ =>
    pure (st, some (onEndStored r tools text finishReason steps.length toolCalls.length approvals
      durationMs))

/-- `onError`, up to where it waits on `onErrorText`. -/
private def onError (r : Run) (st : St) (args : Json) : Prog (St × Option Resume) := do
  let error := Twin.arg args 0
  let message ← Prog.effect "errorMessage" [error]
  let _ ← toolSummaries st
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "formatDuration" [elapsed now r.startedAt]
  let _ ← Prog.effect "Date.now"
  let _ ← Prog.effect "serializeError" [error]
  failedReply r { st with didFail := true } message

/-- `onStepStart`, which has no `await` of its own. -/
private def onStepStart (r : Run) (st : St) (args : Json) : Prog (St × Option Resume) := do
  let stepNumber := Twin.arg args 0
  let _ ← Prog.effect "startApprovalStep"
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "stepTiming.startStep" [stepNumber, now]
  let mediaFree ← Prog.effect "messagesWithoutMediaBytes" [Twin.arg args 1]
  let input ← trace r.c mediaFree
  let system ← systemAttributes r.c true
  let _ ← Prog.effect "spans.open"
    [toJson "model.step", stepNumber, now, undef,
     obj ([("agent.step_number", stepNumber), ("step.state", toJson "running"),
           ("model.input", input)] ++ entries system)]
  pure (st, none)

/-- `onStepEnd`, up to the `await` of its lifecycle event. -/
private def onStepEnd (r : Run) (st : St) (args : Json) : Prog (St × Option Resume) := do
  let stepNumber := Twin.arg args 0
  let finishReason := Twin.arg args 1
  let usage := Twin.arg args 3
  let toolCalls := Twin.arg args 4
  let toolResults := Twin.arg args 5
  let warnings := Twin.arg args 6
  let providerMetadata := Twin.arg args 8
  let startedAt ← Prog.effect "stepTiming.stepStartMs" [stepNumber]
  if !isUndefined startedAt then
    let _ ← Prog.effect "Date.now"
  if lengthOf toolCalls > 0 then
    Prog.unsupported "tool calls that onStepEnd adds to the summary map"
  if lengthOf warnings > 0 then
    Prog.unsupported "model call warnings"
  let stepText := (textOf (Twin.arg args 9)).trimAscii.toString
  let tokens ← Prog.effect "usageTokenTotals" [usage]
  let cacheWrite ← Prog.effect "extractCacheWriteTokens" [r.providerName, providerMetadata]
  let _ ← Prog.effect "taskTotals.addStep" [stepNumber, tokens, cacheWrite]
  let lifecycleUsage ← Prog.effect "toLifecycleValue" [usage]
  Prog.spawn "lifecycle.emit"
    [toJson "agent.step.finished",
     obj [("stepNumber", stepNumber), ("finishReason", finishReason), ("usage", lifecycleUsage),
          ("toolCallCount", toJson (lengthOf toolCalls)),
          ("toolResultCount", toJson (lengthOf toolResults)),
          ("warningCount", toJson (lengthOf warnings))]]
  let next := if stepText.isEmpty then st else { st with lastStepText := stepText }
  pure (next, some fun st => do
    if truthy (← Prog.effect "hooks.hasHooksFor" [toJson "agent.step.finished"]) then
      Prog.unsupported "an agent.step.finished hook"
    for result in listOf toolResults do
      let value ← Prog.effect "toLifecycleValue" [result]
      Prog.spawn "lifecycle.emit"
        [toJson "tool.result", obj [("stepNumber", stepNumber), ("toolResult", value)]]
    pure st)

/-- `onToolExecutionStart`, up to the `await` of its lifecycle event. -/
private def onToolStart (r : Run) (st : St) (args : Json) : Prog (St × Option Resume) := do
  let toolCall := Twin.arg args 0
  let toolCallId := get toolCall "toolCallId"
  let _ ← Prog.effect "reserveComputerTurn" [toolCall]
  let stepNumber ← Prog.effect "stepTiming.activeStep"
  let now ← Prog.effect "Date.now"
  let hasStep := !isUndefined stepNumber
  if hasStep then
    if isUndefined (← Prog.effect "stepTiming.stepStartMs" [stepNumber]) then
      let _ ← Prog.effect "stepTiming.startStep" [stepNumber, now]
  let parent ← if hasStep then Prog.effect "spans.get" [stepNumber] else pure undef
  let input ← trace r.c (get toolCall "input")
  let _ ← Prog.effect "spans.open"
    [toJson "tool.call", toolCallId, now, parent,
     obj ([("tool.name", get toolCall "toolName"), ("tool.call_id", toolCallId),
           ("tool.state", toJson "running"), ("tool.input", input)] ++
          (if hasStep then [("agent.step_number", stepNumber)] else []))]
  if st.summaries then
    Prog.unsupported "a tool summary map with entries"
  let _ ← Prog.effect "recordToolCallSummary"
    [emptyMap, toolCall, obj [("stepNumber", stepNumber)]]
  let lifecycleCall ← Prog.effect "toLifecycleValue" [toolCall]
  Prog.spawn "lifecycle.emit"
    [toJson "tool.call.started", obj [("stepNumber", stepNumber), ("toolCall", lifecycleCall)]]
  pure ({ st with summaries := true }, none)

/-- Runs one callback that the stream entered, up to its first suspension. -/
private def enterCallback (r : Run) (st : St) (label : String) (args : Json) :
    Prog (St × Option Resume) :=
  match label with
  | "onEnd" => onEnd r st args
  | "onError" => onError r st args
  | "onStepStart" => onStepStart r st args
  | "onStepEnd" => onStepEnd r st args
  | "onToolExecutionStart" => onToolStart r st args
  | "prepareStep" => Prog.unsupported "the only recorded prepareStep never settles its step boundary"
  | "abortRun" => Prog.unsupported "the abort signal's reason is not recorded"
  | other => Prog.unsupported s!"callback {other}"

/-- Enters callbacks until none is waiting, keeping what each resumes with. -/
private def enterAll (r : Run) : Nat → St → List Resume → Prog (St × List Resume)
  | 0, st, resumes => pure (st, resumes)
  | limit + 1, st, resumes =>
    .input fun
      | none => pure (st, resumes)
      | some (label, args) =>
        (enterCallback r st label args).bind fun (next, resume) =>
          enterAll r limit next (resumes ++ resume.toList)

/-- The `catch` around starting the stream: reports the failure and finalizes the run. -/
private def failStart (r : Run) (occupied : Bool) (error : Json) (dispose : Bool) : Prog Json := do
  if dispose then
    let _ ← Prog.effect "harnessTurn?.dispose"
  let message ← Prog.effect "errorMessage" [error]
  let terminal :=
    if isError error then error
    else Prog.errorJson "Error" (message.getStr?.toOption.getD "")
  if !nullish r.c.reply then
    Prog.spawn "reply?.onErrorText" [message]
  let event ← failureEvent {} message
  let _ ← Prog.effect "lifecycle.emit" [toJson "agent.failed", event]
  if truthy (← Prog.effect "hooks.hasHooksFor" [toJson "agent.failed"]) then
    Prog.unsupported "an agent.failed hook"
  let now ← Prog.effect "Date.now"
  let _ ← drainCallbacks r.c maxCallbacks occupied
  let _ ← Prog.effect "finalizer.finalize"
    [toJson "failed", toJson (0 : Nat), elapsed now r.startedAt, terminal]
  .fail terminal

/-- `runAgentLoop`, from entry to its second `publishSpan`. -/
def runAgentLoop (call : Json) : Prog Json := do
  let session := Twin.param call 0
  let turnContext := Twin.param call 1
  let agentConfig := Twin.param call 2
  let reply := Twin.param call 3
  let options := Twin.param call 4
  let accountId := sessionField session "accountId"
  let agentId := sessionField session "agentId"
  let endpointId := sessionField session "endpointId"
  let eventId := sessionField session "eventId"
  let conversationKey := sessionField session "conversationKey"
  let messages := get turnContext "messages"
  let modelId := get (get agentConfig "model") "modelId"
  let suppliedStop := get options "stopMessage"
  let stopMessage := if nullish suppliedStop then toJson userStopMessage else suppliedStop
  let configuredModel ← Prog.effect "resolveConfiguredModel" [agentConfig, accountId]
  let providerName := get configuredModel "providerName"
  let _ ← Prog.effect "createAgentLifecycleEmitter"
    [session, agentConfig, get options "webhookTransport"]
  let suppliedHooks := get options "hooks"
  let hooks ←
    if nullish suppliedHooks then
      Prog.effect "createAgentHookDispatcher" [accountId, agentConfig]
    else pure suppliedHooks
  let taskTotals ← Prog.effect "createTaskTotals"
  let sandboxCpu ← Prog.effect "createSandboxCpuLedger"
  let startedAt ← Prog.effect "Date.now"
  let scope ← Prog.effect "sessionObservabilityScope" [session]
  let workspaces ← Prog.effect "session.resolvedWorkspaces"
  let sandboxes ← Prog.effect "session.sandboxes"
  let subagentParent := get options "subagentParent"
  let trigger := sessionField session "trigger"
  let rootKind :=
    if truthy subagentParent then toJson "subtask"
    else if nullish trigger then toJson "task" else trigger
  let rootName := toJson ("agent." ++ (rootKind.getStr?.toOption.getD ""))
  let root ← Prog.effect "startRunRoot" [session, rootName, startedAt]
  let traceId := get root "traceId"
  let rootSpanId := get root "spanId"
  let spans := get root "spans"
  let sandboxMetadata := obj
    ([("traceId", traceId), ("taskId", eventId)] ++
     (if truthy agentId then [("agentId", agentId)] else []) ++
     [("conversationKey", conversationKey)])
  let secrets ← Prog.effect "collectSecretValues"
    [Json.arr #[agentConfig, sandboxes, workspaces]]
  let _ ← Prog.effect "setObservabilityContext"
    [obj (entries scope ++
      [("traceId", traceId), ("otelContext", get root "otelContext"), ("secretValues", secrets)])]
  let c : Ctx :=
    { session := session, turnContext := turnContext, agentConfig := agentConfig, reply := reply,
      options := options, secrets := secrets, parentContext := Twin.observabilityContext call }
  let usesHarness := !isUndefined (get agentConfig "harness")
  let firstSandbox := firstOf sandboxes
  let agentMachine ←
    if !usesHarness && lengthOf workspaces == 0 then
      Prog.effect "agentSandboxStatus" [firstSandbox, eventId]
    else pure undef
  let machineKey ← Prog.effect "configString"
    [get (get (get firstSandbox "sandbox") "options") "reservationKey"]
  if truthy agentMachine then
    Prog.unsupported "a live agent machine status"
  let environment ← Prog.effect "session.environmentText" [Json.arr #[]]
  let latest ← Prog.effect "latestUserText" [messages]
  let tracedLatest ← trace c latest
  let taskInput ← sliceText tracedLatest maxTaskInputChars
  let principal := sessionField session "principal"
  let principalChain ←
    if truthy principal then Prog.effect "principalChainLabel" [principal] else pure undef
  let tracedEnvironment ← trace c environment
  let mediaFree ← Prog.effect "messagesWithoutMediaBytes" [messages]
  let tracedMessages ← trace c mediaFree
  let system1 ← systemAttributes c
  let rootId ← Prog.effect "rootEventId" [eventId]
  let rootIdEntries ←
    if rootId.compress != eventId.compress then do
      let again ← Prog.effect "rootEventId" [eventId]
      pure [("task.root_id", again)]
    else pure []
  let delivery := get (sessionField session "delivery") "kind"
  let running := obj
    ([("agent.environment", tracedEnvironment)] ++
     (if truthy principal then [("principal.agentId", get principal "agentId")] else []) ++
     (if truthy principalChain then [("principal.chain", principalChain)] else []) ++
     [("task.id", eventId), ("task.state", toJson "running"),
      ("task.delivery", if nullish delivery then toJson "direct" else delivery),
      ("task.input", taskInput), ("agent.message_count", toJson (lengthOf messages)),
      ("model.provider", providerName),
      ("model.id", if nullish modelId then toJson "unknown" else modelId),
      ("model.input", tracedMessages)] ++
     entries system1 ++ rootIdEntries ++
     (if truthy subagentParent then
        [("parent.task_id", get subagentParent "parentTaskId"),
         ("parent.trace_id", get subagentParent "parentTraceId")]
      else []))
  let runningRow (attributes : Json) : Json := obj
    [("traceId", traceId), ("spanId", rootSpanId), ("name", rootName), ("kind", rootKind),
     ("startTimeMs", startedAt), ("endTimeMs", startedAt), ("durationMs", toJson (0 : Nat)),
     ("status", toJson "running"), ("endpointId", endpointId), ("agentId", agentId),
     ("conversationKey", conversationKey), ("attributes", attributes)]
  let _ ← Prog.effect "otelRootSpan.setAttributes" [running]
  Prog.spawn "publishSpan" [runningRow running]
  if truthy (get turnContext "timings") then
    Prog.unsupported "prepared context timings"
  let deliveryValue := sessionField session "delivery"
  let channelDelivery := (get deliveryValue "kind").compress == (toJson "channel").compress
  let channelActions := sessionField session "channelActions"
  let parentLink := get options "parentLink"
  let toolArgs := obj
    ([("accountId", accountId), ("conversationKey", conversationKey), ("workspaces", workspaces),
      ("sandboxes", sandboxes), ("modelProviderName", providerName),
      ("modelProvider", get configuredModel "provider"), ("session", session),
      ("dispatchSessionMessage", get options "dispatchSessionMessage"),
      ("onSandboxCpu", get sandboxCpu "record"), ("onToolRetry", get spans "retry"),
      ("onBlockingQuestion", fn "onBlockingQuestion"),
      ("onDetachedResult", fn "onDetachedResult"), ("approvalRequirements", emptyMap),
      ("sandboxStandIns", emptyMap), ("policyMcpIdsByName", emptyMap),
      ("sandboxMetadata", sandboxMetadata)] ++
     (if channelDelivery && truthy channelActions then
        [("channel", obj
          [("actions", channelActions), ("channelName", get deliveryValue "channelName"),
           ("transformText", fn "transformText")])]
      else []) ++
     (if truthy (get options "subagentWatch") then
        [("subagentWatch", get options "subagentWatch")] else []) ++
     (if truthy parentLink then
        [("parentLink", obj [("ask", fn "ask"), ("note", get parentLink "note")])] else []) ++
     (if truthy (get options "messageChild") then
        [("messageChild", get options "messageChild")] else []) ++
     (if truthy (get options "dispatchSubagents") then
        [("dispatchSubagents", fn "dispatchSubagents")] else []))
  let built ← Prog.effect "createTools" [toolArgs, agentConfig]
  let hooked ← Prog.effect "wrapToolsWithHooks" [obj (entries built), hooks, emptyMap]
  let fenced ← Prog.effect "wrapToolsWithOwnerFence" [hooked, session]
  let serialized ← Prog.effect "serializeToolCalls" [fenced, toJson computerToolName]
  let tools := get serialized "tools"
  let policyDelivery := sessionField session "policyDelivery"
  let policyKind := get policyDelivery "kind"
  let policyChannel := policyKind.compress == (toJson "channel").compress
  let identity ←
    if policyChannel then
      Prog.effect "channelPolicyIdentity" [get policyDelivery "identity"]
    else pure undef
  let policyTarget := obj
    ([("accountId", accountId), ("project", sessionField session "projectSlug"),
      ("stage", sessionField session "stageSlug"), ("endpointId", endpointId),
      ("agentId", agentId), ("principal", principal), ("conversationKey", conversationKey),
      ("delivery", if nullish policyKind then toJson "direct" else policyKind),
      ("channel", if policyChannel then get policyDelivery "channelName" else undef)] ++
     entries identity)
  let policyApproval ← Prog.effect "createPolicyToolApproval"
    [agentConfig, policyTarget, workspaces,
     obj [("mcpIdsByName", emptyMap), ("sandboxes", sandboxes)]]
  let runtimeApproval ← Prog.effect "createRuntimeToolApproval"
    [obj
      ([("configuredApprovals", emptyMap), ("workspaces", workspaces), ("sandboxes", sandboxes),
        ("sandboxStandIns", emptyMap)] ++
       (if truthy policyApproval then [("policyApproval", policyApproval)] else []))]
  let modelSettings ← Prog.effect "modelSettingsFromModelConfig" [agentConfig]
  let modelOutput ← Prog.effect "modelOutputFromModelConfig" [agentConfig]
  let providerOptions ← Prog.effect "providerOptionsFromModelConfig" [agentConfig, conversationKey]
  let cacheBreakpoint ← Prog.effect "cacheBreakpointFromProviderOptions"
    [agentConfig, providerOptions]
  let stepTiming ← Prog.effect "createStepTimingTracker" [fn "traceAttribute"]
  let responseRunKey ← Prog.effect "crypto.randomUUID"
  let abortSignal := get options "abortSignal"
  if truthy abortSignal then
    if (get abortSignal "$signal").compress == (toJson true).compress then
      Prog.unsupported "a signal already aborted at entry"
    let _ ← Prog.effect "options.abortSignal?.addEventListener"
      [toJson "abort", fn "abortRun",
       obj [("once", toJson true), ("signal", runSignal)]]
  let _ ← Prog.effect "createRunFinalizer"
    [obj
      [("session", session),
       ("root", obj
         [("span", get root "span"), ("traceId", traceId), ("spanId", rootSpanId),
          ("name", rootName), ("kind", rootKind), ("startTimeMs", startedAt)]),
       ("rootAttributes", fn "rootAttributes"), ("modelProvider", providerName),
       ("modelId", modelId), ("taskInput", taskInput), ("serialize", fn "traceAttribute"),
       ("spans", spans), ("stepTiming", stepTiming), ("taskTotals", taskTotals),
       ("sandboxCpu", sandboxCpu), ("openWork", fn "openWork"), ("publish", fn "publishSpan"),
       ("recordUsage", fn "recordTaskUsage"), ("release", fn "release"),
       ("restoreObservabilityContext", fn "restoreObservabilityContext")]]
  let _ ← Prog.effect "lifecycle.emit"
    [toJson "agent.started",
     obj [("modelProvider", providerName), ("modelId", modelId),
          ("messageCount", toJson (lengthOf messages))]]
  let startedHooks ← Prog.effect "hooks.hasHooksFor" [toJson "agent.started"]
  if truthy startedHooks then
    Prog.unsupported "an agent.started hook"
  let system2 ← systemAttributes c
  let toolNames := keysOf tools
  let tracedTools ← trace c (Json.arr toolNames.toArray)
  let runningWithTools := Json.mkObj
    (entries running ++ entries system2 ++
     [("agent.tools", tracedTools), ("agent.tool_count", toJson toolNames.length)])
  let _ ← Prog.effect "otelRootSpan.setAttributes" [runningWithTools]
  Prog.spawn "publishSpan" [runningRow runningWithTools]
  let middleware ← Prog.effect "attemptRecordingMiddleware" [get stepTiming "recordAttempt", fn ""]
  let wrapped ← Prog.effect "wrapLanguageModel"
    [obj [("model", get configuredModel "model"), ("middleware", middleware)]]
  let configuredTurns := get (get agentConfig "agent") "maxTurn"
  let maxTurn := if nullish configuredTurns then toJson maxAgentIterations else configuredTurns
  let _ ← Prog.effect "createDeadlinePolicy"
    [obj
      [("deadlineMs", get options "deadlineMs"),
       ("canYield", toJson ((get options "canYield").compress == (toJson true).compress)),
       ("windDownMs", toJson deadlineWindDownMs), ("maxTurn", maxTurn), ("now", fn "now")]]
  let stripped ← Prog.effect "stripEnvelopeFieldsFromMessages" [messages]
  let withEnv ← Prog.effect "withEnvironment" [stripped, environment, cacheBreakpoint]
  let unlimited := maxTurn.compress == (toJson (0 : Nat)).compress
  let stepCount ← if unlimited then pure [] else do
    let stop ← Prog.effect "isStepCount" [maxTurn]
    pure [stop]
  let run : Run :=
    { c := c, hooks := hooks, providerName := providerName, startedAt := startedAt,
      responseRunKey := responseRunKey, modelOutput := modelOutput,
      deadlineRun := !isUndefined (get options "deadlineMs") }
  if usesHarness then
    if truthy policyApproval then
      return ← failStart run false (Prog.errorJson "Error"
        "config.policy is not supported with config.harness because the upstream harness accepts only static host-tool approvals") false
    let harnessType := get (get agentConfig "harness") "type"
    let occupied ← drainCallbacks c 2 false
    let outcome ← Prog.attempt "prepareHarnessTurn"
      [obj
        [("abortController", Json.mkObj [("$opaque", toJson "AbortController")]),
         ("agentConfig", agentConfig), ("agentReservationKey", machineKey),
         ("applySteering", fn "applySteering"), ("configuredApprovals", emptyMap),
         ("createAgent", fn "createConfiguredHarnessAgent"),
         ("isolated", toJson ((get options "isolatedSandbox").compress == (toJson true).compress)),
         ("metadata", sandboxMetadata), ("onOccupied", fn "onOccupied"),
         ("openSession", fn "openAiSdkHarnessSession"), ("sandbox", firstSandbox),
         ("session", session), ("stopMessage", stopMessage), ("tools", tools),
         ("turnContext", turnContext)]]
    match outcome with
    | .threw error _ => return ← failStart run occupied error false
    | .pending => return ← Prog.unsupported "prepareHarnessTurn never finished"
    | .ok turn =>
      let tracedHarness ← trace c (get turn "environment")
      let _ ← Prog.effect "otelRootSpan.setAttributes"
        [Json.mkObj (entries runningWithTools ++ [("agent.environment", tracedHarness)])]
      let harnessStripped ← Prog.effect "stripEnvelopeFieldsFromMessages" [messages]
      let textFirst ← Prog.effect "harnessTextBeforeImages" [harnessType]
      let prompt ← Prog.effect "harnessPromptMessages"
        [harnessStripped, get turn "environment", textFirst]
      let steers ← Prog.effect "harnessSteersMidTurn" [harnessType]
      let streamed ← Prog.attempt "harnessTurn.runtime.agent.stream"
        [obj
          [("messages", prompt), ("session", get turn "nativeSession"),
           ("abortSignal", runSignal),
           ("onStepStart", if truthy steers then fn "" else fn "onStepStart"),
           ("onStepEnd", fn "onStepEnd"), ("onToolExecutionStart", fn "onToolExecutionStart"),
           ("onToolExecutionEnd", fn "onToolExecutionEnd")]]
      match streamed with
      | .threw error _ => return ← failStart run occupied error true
      | _ => return ← Prog.unsupported "a harness stream that starts"
  let deployment := Twin.env call "DEPLOYMENT_ENVIRONMENT"
  let streamArgs := obj
    ([("maxOutputTokens", toJson (16000 : Nat))] ++ entries modelSettings ++
     [("model", wrapped), ("instructions", get turnContext "system"), ("messages", withEnv)] ++
     (if truthy modelOutput then [("output", modelOutput)] else []) ++
     (if !toolNames.isEmpty then [("tools", tools)] else []) ++
     (if truthy (get runtimeApproval "approval") then
        [("toolApproval", get runtimeApproval "approval")] else []) ++
     (if truthy providerOptions then [("providerOptions", providerOptions)] else []) ++
     [("runtimeContext", obj
        [("traceName", rootName),
         ("properties",
          if truthy deployment then obj [("environment", deployment)] else Json.mkObj [])]),
      ("telemetry", obj
        [("functionId", toJson "harness.agent"),
         ("includeRuntimeContext",
          obj [("traceName", toJson true), ("properties", toJson true)]),
         ("recordInputs", toJson false), ("recordOutputs", toJson false)]),
      ("stopWhen", Json.arr (stepCount ++ [fn "", fn ""]).toArray),
      ("abortSignal", runSignal), ("prepareStep", fn "prepareStep"), ("onChunk", fn "onChunk"),
      ("onStepStart", fn "onStepStart"),
      ("onToolExecutionStart", fn "onToolExecutionStart"),
      ("onToolExecutionEnd", fn "onToolExecutionEnd"), ("onStepEnd", fn "onStepEnd"),
      ("onError", fn "onError"), ("onEnd", fn "onEnd")])
  let (entered, resumes) ← enterAll run maxCallbacks {} []
  let stream ←
    match ← Prog.attempt "streamText" [streamArgs] with
    | .threw error _ => return ← failStart run false error false
    | .pending => return ← Prog.unsupported "streamText never returned"
    | .ok value => pure value
  let isClass := !isUndefined (get stream "$opaque")
  let fullStream :=
    if isClass then Json.mkObj [("$opaque", toJson "ReadableStream")] else get stream "fullStream"
  Prog.spawn "watchModelStream" [fullStream, toJson false, fn ""]
  Prog.spawn "stream.consumeStream.bind" [stream]
  let resumed ← resumes.foldlM (fun st resume => resume st) entered
  let _ ← enterAll run maxCallbacks resumed []
  if isClass then
    return stream
  pure (Json.mkObj (entries stream ++
    ["ensureFinalized", "didFail", "yielded", "failureText",
     "questionSummaries", "parentQuestion", "hasStructuredOutput", "finalResponse",
     "traceId"].map (fun name => (name, fn name)) ++
    [("consumeStream", fn "wrappedConsumeStream")]))

/-- `errorMessage`: the redacted text, with advice for two AI SDK error classes. -/
def errorMessage (call : Json) : Prog Json := do
  let error := Twin.callArg call 0
  let raw ← Prog.effect "toErrorMessage" [error]
  let secrets := get (Twin.observabilityContext call) "secretValues"
  let message ← Prog.effect "redactSensitiveText" [raw, secrets]
  let text := message.getStr?.toOption.getD ""
  let noReference ← Prog.effect "NoSuchProviderReferenceError.isInstance" [error]
  if truthy noReference then
    let provider := (get (get (get error "$error") "fields") "provider").getStr?.toOption.getD ""
    return toJson (text ++ " The conversation references a file or skill uploaded to a different " ++
      "provider's storage. Re-upload it for the \"" ++ provider ++ "\" provider, switch " ++
      "config.model.provider back, or attach the content as workspace (S3) files instead.")
  let unsupportedError ← Prog.effect "UnsupportedFunctionalityError.isInstance" [error]
  if truthy unsupportedError then
    return toJson (text ++ " The configured model provider does not support this capability; " ++
      "use a provider that does, or attach the content as workspace (S3) files instead of " ++
      "provider uploads.")
  pure message

private def hasNonZero (value : Json) : Bool :=
  (value.getStr?.toOption.getD "").toList.any (· != '0')

/-- `observabilityAttributes` in `shared/otel.ts`, which the recording does not show as an effect. -/
private def scopeAttributes (scope : Json) : List (String × Json) :=
  [("account_id", get scope "accountId"), ("project", get scope "project"),
   ("stage", get scope "stage"), ("endpoint_id", get scope "endpointId"),
   ("agent_id", get scope "agentId"), ("conversation_key", get scope "conversationKey")]

/-- `recordFailedTurn`. -/
def recordFailedTurn (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let startedAt := Twin.callArg call 1
  let error := Twin.callArg call 2
  let context := Twin.observabilityContext call
  let contextTrace := get context "traceId"
  let traceId ← if nullish contextTrace then Prog.effect "mintTraceId" else pure contextTrace
  let scope ← Prog.effect "sessionObservabilityScope" [session]
  let trigger := sessionField session "trigger"
  let kind := if nullish trigger then toJson "task" else trigger
  let name := toJson ("agent." ++ (kind.getStr?.toOption.getD ""))
  let described ← Prog.effect "errorMessage" [error]
  let message ← Prog.effect "redactSensitiveText" [described, get context "secretValues"]
  let endTime ← Prog.effect "Date.now"
  let _ ← Prog.effect "getTracer"
  let active ← Prog.effect "otelContextApi.active"
  let minted ← Prog.effect "mintSpanId"
  let parent ← Prog.effect "otelTraceApi.setSpanContext"
    [active, obj [("traceId", traceId), ("spanId", minted), ("traceFlags", toJson (1 : Nat))]]
  let _ ← Prog.effect "getTracer().startSpan"
    [name,
     obj [("startTime", startedAt),
          ("attributes", obj (scopeAttributes scope ++ [("task.state", toJson "failed")]))],
     parent]
  let _ ← Prog.effect "otelSpan.setStatus" [obj [("code", toJson (2 : Nat)), ("message", message)]]
  let _ ← Prog.effect "otelSpan.end" [endTime]
  let spanContext ← Prog.effect "otelSpan.spanContext"
  let reported := get spanContext "spanId"
  let spanId ← if hasNonZero reported then pure reported else Prog.effect "mintSpanId"
  Prog.spawn "publishSpan"
    [obj
      [("traceId", traceId), ("spanId", spanId), ("name", name), ("kind", kind),
       ("startTimeMs", startedAt), ("endTimeMs", endTime),
       ("durationMs", elapsed endTime startedAt), ("status", toJson "error"),
       ("endpointId", sessionField session "endpointId"),
       ("agentId", sessionField session "agentId"),
       ("conversationKey", sessionField session "conversationKey"),
       ("attributes", obj [("task.state", toJson "failed")]), ("error", message)]]
  pure undef

private def finalizeLabel : String :=
  "createRunFinalizer({ session: session, root: { span: root.span, traceId: root.traceId, spanId: root.spanId, name: `agent.${kind}`, kind: kind, startTimeMs: startedAt, }, // The dashboard prices a trace by the model its root names (`runModel`). rootAttributes: (): Record<string, string> => ({ \"task.id\": session.eventId, \"task.delivery\": session.delivery?.kind ?? \"direct\", \"task.input\": taskInput, \"model.provider\": modelProvider, \"model.id\": modelId, }), modelProvider: modelProvider, modelId: modelId, taskInput: taskInput, serialize: serialize, spans: root.spans, stepTiming: createStepTimingTracker(serialize), taskTotals: taskTotals, sandboxCpu: createSandboxCpuLedger(), openWork: (): Promise<RunOpenWork> => Promise.resolve({ questions: [] }), publish: publishSpan, recordUsage: recordTaskUsage, release: (): void => {}, restoreObservabilityContext: (): void => {}, }).finalize"

/-- `recordCompactionTask`. The finalizer's callbacks have no effects of their own here. -/
def recordCompactionTask (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let input := Twin.callArg call 1
  let kind := Twin.callArg call 2
  let root := Twin.callArg call 3
  let startedAt := Twin.callArg call 4
  let outcome := Twin.callArg call 5
  let secrets := get (Twin.observabilityContext call) "secretValues"
  let secretList := if nullish secrets then Json.arr #[] else secrets
  let serialized ← (.input fun _ =>
    Prog.effect "redactSerialized" [input, secretList, toJson maxTraceAttributeChars] : Prog Json)
  let taskInput ← sliceText serialized maxTaskInputChars
  let endMs ← Prog.effect "Date.now"
  let result := get outcome "result"
  let failure := get outcome "error"
  let hasResult := !isUndefined result
  let failureBody := get failure "$error"
  let spent :=
    if hasResult then result
    else if (get failureBody "$class").compress == (toJson "CompactionError").compress then
      get (get failureBody "fields") "spent"
    else undef
  if hasResult then
    let attributes ← Prog.effect "compactionSpanAttributes" [result]
    let _ ← Prog.effect "root.spans.phase"
      [toJson "phase.compaction", toJson "Compaction", startedAt, endMs, attributes]
  let taskTotals ← Prog.effect "createTaskTotals"
  if truthy spent then
    let _ ← Prog.effect "taskTotals.addCompaction" [get spent "usage"]
  let spentProvider := get spent "modelProvider"
  let spentModel := get spent "modelId"
  let modelProvider := if nullish spentProvider then toJson "unknown" else spentProvider
  let modelId := if nullish spentModel then toJson "unknown" else spentModel
  let stepTiming ← Prog.effect "createStepTimingTracker" [fn "serialize"]
  let sandboxCpu ← Prog.effect "createSandboxCpuLedger"
  let name := toJson ("agent." ++ (kind.getStr?.toOption.getD ""))
  let _ ← Prog.effect "createRunFinalizer"
    [obj
      [("session", session),
       ("root", obj
         [("span", get root "span"), ("traceId", get root "traceId"),
          ("spanId", get root "spanId"), ("name", name), ("kind", kind),
          ("startTimeMs", startedAt)]),
       ("rootAttributes", fn "rootAttributes"), ("modelProvider", modelProvider),
       ("modelId", modelId), ("taskInput", taskInput), ("serialize", fn "serialize"),
       ("spans", get root "spans"), ("stepTiming", stepTiming), ("taskTotals", taskTotals),
       ("sandboxCpu", sandboxCpu), ("openWork", fn "openWork"), ("publish", fn "publishSpan"),
       ("recordUsage", fn "recordTaskUsage"), ("release", fn "release"),
       ("restoreObservabilityContext", fn "restoreObservabilityContext")]]
  Prog.drain (fun _ _ => pure ()) maxCallbacks
  let finalized ← Prog.effect finalizeLabel
    [toJson (if hasResult then "completed" else "failed"), toJson (0 : Nat),
     elapsed endMs startedAt, failure]
  pure finalized

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/harness.ts#runAgentLoop" runAgentLoop,
   Twin.traced "apps/core/src/harness/harness.ts#errorMessage" errorMessage,
   Twin.traced "apps/core/src/harness/harness.ts#recordFailedTurn" recordFailedTurn,
   Twin.traced "apps/core/src/harness/harness.ts#recordCompactionTask" recordCompactionTask]

end Spec.Agent.Waveagent6a
