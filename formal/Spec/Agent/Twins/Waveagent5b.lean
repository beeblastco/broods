import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign5/agent5b.tsv`.

-/

namespace Spec.Agent.Waveagent5b

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def isStr (value : Json) (expected : String) : Bool :=
  value == toJson expected

private def isTrue (value : Json) : Bool :=
  value == toJson true

private def items (value : Json) : List Json :=
  (value.getArr?.toOption.getD #[]).toList

private def text (value : Json) : String :=
  (value.getStr?).toOption.getD ""

private def arr (values : List Json) : Json :=
  .arr values.toArray

/-- JavaScript truthiness of a recorded value. -/
private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str content => !content.isEmpty
  | .num number => number != 0
  | other => !isUndef other

/-- An object literal: a key whose value is `undefined` is not recorded. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

/-- `{ ...base, ...extra }`. -/
private def spread (base : Json) (extra : List (String × Json)) : Json :=
  extra.foldl (fun acc entry => acc.setObjVal! entry.1 entry.2) base

private def thisField (call : Json) (name : String) : Json :=
  Twin.field (Twin.self call) name

/-- A member of a value recorded either as a plain object or as a class instance. -/
private def member (value : Json) (key : String) : Json :=
  let direct := field value key
  if isUndef direct then Twin.field value key else direct

private def parentSession (call : Json) : Json :=
  thisField call "parentSession"

private def mapPairs (value : Json) : List (Json × Json) :=
  (items (field value "$map")).map fun pair =>
    (Twin.arg pair 0, Twin.arg pair 1)

private def mapGet (value : Json) (key : Json) : Option Json :=
  ((mapPairs value).find? (·.1 == key)).map (·.2)

private def mapHas (value : Json) (key : Json) : Bool :=
  (mapGet value key).isSome

private def setHas (value : Json) (key : Json) : Bool :=
  (items (field value "$set")).contains key

/-- The recorder writes at most eight members of a set, so membership past that is unknown. -/
private def setCapped (value : Json) : Bool :=
  (items (field value "$set")).length ≥ 8

/-- Whether the recorder collapsed this value because it was too big. -/
private def isBig (value : Json) : Bool :=
  isTrue (field value "$big")

private def userStopMessage : String := "Stopped by user at the model boundary"

private def messageTurnBudget : Json := toJson (40 : Nat)

private def messageTurnsSpent : String :=
  "Agents in this run already started 40 turns by messaging each other. Finish with what you have."

private def subagentBudgetMs : Nat := 900000

private def deadlineWindDownMs : Nat := 180000

private def budgetInstruction : String :=
  "You are a subagent with a 15-minute budget for this task. Pace yourself: near the end your tools are turned off and you must answer with what you have."

private def lostSubagentError : String :=
  "Subagent stopped without a result: the runtime restarted while it was running."

private def coord (name : String) : String :=
  "apps/core/src/harness/subagents.ts#SubagentCoordinator." ++ name

private def sess (name : String) : String :=
  "apps/core/src/harness/session.ts#Session." ++ name

private def sub (name : String) : String :=
  "apps/core/src/harness/subagents.ts#" ++ name

private def fnNamed (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

/-- A promise passed as an argument, as the recorder writes it. -/
private def promiseValue : Json :=
  Json.mkObj [("$opaque", toJson "Promise")]

/-- `catchFail` that lets the model's own opt-out through. -/
private def guarded {α : Type} (body : Prog α) (handler : Json → Prog α) : Prog α :=
  Prog.catchFail body fun error =>
    if isUndef (field error "$unsupported") then handler error else throw error

/-- `Promise.all`: rethrows the first failure in argument order. -/
private def allOk (calls : List (String × List Json)) : Prog (List Json) := do
  let outcomes ← Prog.all calls
  let mut values : List Json := []
  for outcome in outcomes do
    match outcome with
    | .ok value => values := values ++ [value]
    | .threw error _ => throw error
    | .pending => return ← Prog.unsupported "unfinished effect"
  return values

/-- `SubagentCoordinator.runTurns`. `emittedError` is written by the publisher during the turn. -/
def runTurns (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let subagentParent := Twin.callArg call 1
  let preOwned := Twin.callArg call 2
  let publisher := field (Twin.callArg call 3) "publisher"
  let rec loop : Nat → Json → Bool → Prog Unit
    | 0, _, _ => Prog.unsupported "more turns than the model allows"
    | fuel + 1, current, first => do
      let failed (error : Json) : Prog Json := do
        let metadata ← Prog.effect "taskMetadata" [current]
        let message ← Prog.effect "toErrorMessage" [error]
        return spread metadata [("status", toJson "failed"), ("error", message)]
      let runOne : Prog Json := do
        match ← Prog.attempt "this.runTask"
            [current, subagentParent, publisher, if first then preOwned else undef] with
        | .ok value => return value
        | .threw error _ => failed error
        | .pending => Prog.unsupported "unfinished turn"
      let completion ←
        if first then runOne
        else
          match ← Prog.attempt "this.createChildResultRow" [current] with
          | .ok _ => runOne
          | .threw error _ => failed error
          | .pending => Prog.unsupported "unfinished row"
      let next ← Prog.effect "this.takeFollowUp" [current, completion]
      let payer := field current "payer"
      let _ ← Prog.effect "this.completeTask"
        [completion, if isUndef payer then Twin.self call else payer]
      if isStr (field completion "status") "failed" && !isUndef publisher then
        return ← Prog.unsupported "emittedError is set by the publisher during the turn"
      if truthy next then loop fuel next false
  loop 64 task true
  if !isUndef publisher then
    let _ ← Prog.effect "publisher?.publish" [Json.mkObj [("type", toJson "done")]]
  return undef

/-- `SubagentCoordinator.launch`. No observability scope is active in the recorded tests. -/
def launch (call : Json) : Prog Json := do
  let tasks := items (Twin.callArg call 0)
  let preOwned := Twin.callArg call 1
  let _ ← allOk (tasks.map fun task => ("this.createChildResultRow", [task]))
  let _ ← allOk (tasks.map fun task =>
    ("this.lifecycle.emit",
      [toJson "subagent.task.started",
       obj [("taskId", field task "taskId"), ("agentId", field task "agentId"),
            ("conversationKey", field task "publicConversationKey"),
            ("inheritedContext", field task "inheritedContext"),
            ("persistent", field task "persistent"), ("resuming", field task "resuming")]]))
  let mut dispatches : List Json := []
  for task in tasks do
    let _ ← Prog.effect "this.startTask" [task, undef, preOwned]
    dispatches := dispatches ++ [← Prog.effect "toDispatch" [task]]
  if isTrue (thisField call "closed") then
    let _ ← allOk (tasks.map fun task =>
      ("this.detachTask", [field task "taskId", toJson false]))
  return Json.mkObj [("tasks", arr dispatches)]

/-- `SubagentCoordinator.resolveTask` -/
def resolveTask (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let parentMessages := Twin.callArg call 1
  let parentEphemeralSystem := Twin.callArg call 2
  let given := field task "conversationKey"
  let accountId ← Prog.effect "requireParentAccountId" [parentSession call]
  let persistent := !isStr (field (field (thisField call "parentAgentConfig") "subagent") "mode") "ephemeral"
  if !persistent && !isUndef given then
    return ← Prog.throwError "Error" "Subagent conversationKey is only supported in persistent mode"
  if !isUndef given then
    if !isTrue (← Prog.effect "this.mintedChildKey" [accountId, given]) then
      return ← Prog.throwError "Error"
        "Subagent conversationKey must be one run_subagent returned to this agent"
  let taskId ← Prog.effect "createSubagentTaskId" [member (parentSession call) "eventId"]
  let publicKey ←
    if !isUndef given then pure given
    else if persistent then do
      let uuid ← Prog.effect "crypto.randomUUID"
      Prog.effect "this.mintChildKey" [accountId, uuid]
    else pure (toJson s!"subagent-{text taskId}")
  let child ← Prog.effect "this.resolveChild"
    [accountId, publicKey, field task "agentId", taskId]
  let resuming := persistent && !isUndef given
  Prog.effect "this.childTask"
    [child,
     obj [("taskId", taskId), ("prompt", field task "prompt"), ("resuming", toJson resuming),
          ("parentMessages", parentMessages), ("parentEphemeralSystem", parentEphemeralSystem),
          ("isolated", toJson (isTrue (field task "isolated"))), ("lastTurn", toJson false),
          ("payer", if resuming then Twin.self call else undef)]]

/-- `SubagentCoordinator.createChildTurnContext` -/
def createChildTurnContext (call : Json) : Prog Json := do
  let task := Twin.callArg call 1
  let incoming := items (Twin.callArg call 2)
  let inherited := isTrue (field task "inheritedContext")
  let parentMessages := items (field task "parentMessages")
  let ephemeral := arr (items (field task "parentEphemeralSystem") ++
    [Json.mkObj [("role", toJson "system"), ("content", toJson budgetInstruction)]])
  if !isTrue (field task "persistent") then
    return ← Prog.effect "childSession.createEphemeralTurnContext"
      [arr ((if inherited then parentMessages else []) ++ incoming), ephemeral]
  let _ ← Prog.effect "childSession.persistModelMessages" [arr incoming]
  if isTrue (field task "resuming") || !inherited then
    return ← Prog.effect "childSession.createTurnContext" [ephemeral]
  Prog.effect "childSession.createEphemeralTurnContext"
    [arr (parentMessages ++ incoming), ephemeral]

/-- `SubagentCoordinator.resumeChild` -/
def resumeChild (call : Json) : Prog Json := do
  let child := Twin.callArg call 0
  let prompt := Twin.callArg call 1
  let charged := isTrue (Twin.callArg call 2)
  let session := parentSession call
  let taskId ← Prog.effect "createSubagentTaskId" [member session "eventId"]
  let task ← Prog.effect "this.childTask"
    [child,
     Json.mkObj
       [("taskId", taskId), ("prompt", prompt), ("resuming", toJson true),
        ("parentMessages", arr []), ("parentEphemeralSystem", arr []),
        ("isolated", toJson false), ("lastTurn", toJson (!charged))]]
  let message ← Prog.effect "userText" [prompt]
  let events := arr [message]
  let key := field child "conversationKey"
  let reserved ←
    if mapHas (Twin.moduleValue call "liveChildren") key then pure undef
    else Prog.effect "reserveLive" [key, task]
  let finish (started : Bool) : Prog Unit := do
    if !isUndef reserved then
      let _ ← Prog.effect "settleLive" [key, reserved, toJson started]
    if charged && !started then
      let _ ← Prog.effect "this.parentSession.releaseMessageTurn"
  let body : Prog (Json × Bool) := do
    let admission ←
      if isUndef reserved then pure (Json.mkObj [("outcome", toJson "rejected")])
      else do
        let candidate ← Prog.effect "this.childCandidate" [task, events]
        Prog.effect "acceptIngress" [candidate]
    if !isStr (field admission "outcome") "owner" then
      let dispatch ← Prog.effect "toDispatch" [task]
      return (Json.mkObj [("outcome", field admission "outcome"), ("task", dispatch)], false)
    let generation ← Prog.effect "ownedGeneration" [admission]
    match ← Prog.attempt "this.launch"
        [arr [task], Json.mkObj [("ownerGeneration", generation), ("events", events)]] with
    | .threw error _ =>
      let accountId ← Prog.effect "requireParentAccountId" [session]
      let _ ← Prog.effect "new Session"
        [Json.mkObj
          [("eventId", field task "eventId"), ("conversationKey", field task "conversationKey"),
           ("accountId", accountId), ("agentId", field task "agentId"),
           ("ownerGeneration", generation)]]
      let message ← Prog.effect "toErrorMessage" [error]
      let _ ← Prog.attempt "owner .settleIngress"
        [toJson "failed", Json.mkObj [("error", message)]]
      let _ ← Prog.attempt "owner.releaseConversationLease"
      throw error
    | .pending => Prog.unsupported "unfinished launch"
    | .ok _ =>
      let dispatch ← Prog.effect "toDispatch" [task]
      return (Json.mkObj [("outcome", field admission "outcome"), ("task", dispatch)], true)
  let result ← guarded body (fun error => do
    finish false
    throw error)
  finish result.2
  return result.1

/-- `SubagentCoordinator.completeTask`. A coordinator too big to record is read as still waiting on
the task, which the comparison checks. -/
def completeTask (call : Json) : Prog Json := do
  let completion := Twin.callArg call 0
  let payer := Twin.param call 1
  let self := Twin.self call
  let taskId := field completion "taskId"
  let eventId := field completion "eventId"
  let status := field completion "status"
  let detached := thisField call "detached"
  if isUndef completion then
    return ← Prog.unsupported "a missing completion is a type error the compiler rules out"
  let pending := thisField call "pending"
  let shouldInject := isBig pending || mapHas pending taskId || mapHas detached taskId
  let recorded := thisField call "recorded"
  if isStr status "failed" && !isBig recorded && !setCapped recorded && !setHas recorded eventId then
    let error := field completion "error"
    let _ ← Prog.attempt "recordAsyncAgentResult"
      [eventId,
       Json.mkObj [("status", toJson "failed"),
                   ("error", if isUndef error then toJson "Subagent task failed" else error)]]
  if !shouldInject then return undef
  let results ← allOk
    [("this.getHooks", []),
     ("parentVisibleCompletion", [completion, thisField call "parentAgentConfig", promiseValue])]
  let visible := results.getD 1 undef
  let question := isStr (field visible "status") "awaiting_input"
  let runs : List Json := [self, payer]
  let live : Option Json :=
    if !mapHas detached taskId then some self
    else if question then runs.find? fun run => !isTrue (Twin.field run "closed")
    else none
  if truthy visible then
    match live with
    | some _ =>
      let _ ← Prog.effect "live.enqueue" [visible]
      let _ ← Prog.effect "live.notifyCompletion"
    | none =>
      let message ← Prog.effect "completionToParentMessage" [visible]
      let _ ← Prog.effect "payer.resumeParentWith" [message, visible]
  else
    let _ ← Prog.effect "markAsyncAgentHandback" [eventId, toJson "stored"]
  let _ ← Prog.effect "this.notifyCompletion"
  let _ ← Prog.effect "stoppedOnPurpose" [completion]
  let response := field completion "response"
  let lifecycle ←
    if isUndef response then pure undef
    else Prog.effect "toLifecycleValue" [response]
  let error := field completion "error"
  let _ ← Prog.effect "this.emitTaskFinished"
    [obj [("taskId", taskId), ("agentId", field completion "agentId"),
          ("conversationKey", field completion "conversationKey"), ("status", status),
          ("response", lifecycle), ("error", if truthy error then error else undef)]]
  return undef

/-- `resumeLostSubagentResult` -/
def resumeLostSubagentResult (call : Json) : Prog Json := do
  let row := Twin.callArg call 0
  let held := Twin.callArg call 3
  let eventId := field row "eventId"
  let task := field row "subagent"
  let giveUp (reason : String) : Prog Json := do
    let _ ← Prog.effect "giveUpLostSubagentResult" [eventId, toJson reason]
    return undef
  let child ← Prog.effect "parseAccountAgentScopedKey" [eventId]
  let taskId ← Prog.effect "rowTaskId" [eventId]
  let parentEventId ← Prog.effect "subagentParentEventId" [taskId]
  let scope ←
    if truthy parentEventId then Prog.effect "parseAccountAgentScopedKey" [parentEventId]
    else pure Json.null
  if !truthy task || !truthy child || !truthy parentEventId ||
      field scope "accountId" != field row "accountId" then
    return ← giveUp "no parent of the row's account to resume"
  let accountId := field scope "accountId"
  let agentId := field scope "agentId"
  let parentKey := field task "parentConversationKey"
  let target ← Prog.effect "loadParent" [accountId, agentId, parentKey]
  if !truthy target then return ← giveUp "parent agent is gone"
  let message ←
    if !isUndef held then pure held
    else do
      let publicKey ← Prog.effect "publicConversationKeyFromScoped"
        [field row "conversationKey", field child "accountId", field child "agentId"]
      let outcome ← Prog.effect "rowOutcome" [row]
      let description := field task "description"
      let base := obj
        [("taskId", taskId), ("eventId", eventId), ("agentId", field child "agentId"),
         ("description", if truthy description then description else undef),
         ("conversationKey", publicKey)]
      let completion := spread base
        (["status", "response", "error", "question"].filterMap fun key =>
          if isUndef (field outcome key) then none else some (key, field outcome key))
      let results ← allOk
        [("createAgentHookDispatcher", [accountId, field target "agentConfig"]),
         ("parentVisibleCompletion", [completion, field target "agentConfig", promiseValue])]
      let visible := results.getD 1 undef
      if truthy visible then Prog.effect "completionToParentMessage" [visible] else pure undef
  if !truthy message then return ← giveUp "hidden from the parent"
  let parent := obj
    [("accountId", accountId), ("agentId", agentId), ("eventId", parentEventId),
     ("conversationKey", parentKey), ("delivery", field task "parentDelivery")]
  match ← Prog.attempt "resumeParent" [parent, taskId, message, eventId, target] with
  | .threw _ _ => return message
  | .pending => Prog.unsupported "unfinished resume"
  | .ok outcome =>
    let name := text outcome
    if ["queued", "capacity", "duplicate"].contains name then return message
    if name != "owner" then
      let _ ← giveUp s!"resume {name}"
    return undef

/-- `resumeLostSubagentResults` -/
def resumeLostSubagentResults (call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  let windows ← Prog.effect "lostResultWindows" [now]
  let abandoned := field windows "abandonedBefore"
  let mut ranges : List (String × String × Json) := []
  for handback in ["detached", "pending"] do
    let settled ← Prog.effect "finishedBefore" [toJson handback]
    ranges := ranges ++
      [(handback, "completed", settled), (handback, "failed", settled),
       (handback, "awaiting_input", settled), (handback, "processing", abandoned)]
  let previous := Twin.moduleValue call "heldLostResults"
  let heldFor (eventId : Json) : Json := (mapGet previous eventId).getD undef
  let keep (held : List (Json × Json)) (eventId retry : Json) : List (Json × Json) :=
    if !truthy retry then held
    else if held.any (·.1 == eventId) then
      held.map fun entry => if entry.1 == eventId then (eventId, retry) else entry
    else held ++ [(eventId, retry)]
  let handleRow (handback : String) (held : List (Json × Json)) (row : Json) :
      Prog (List (Json × Json)) := do
    let eventId := field row "eventId"
    if isStr (field row "status") "processing" then
      let _ ← Prog.effect "recordAsyncAgentResult"
        [eventId,
         Json.mkObj [("status", toJson "failed"), ("error", toJson lostSubagentError)],
         obj [("onlyWhileProcessing", toJson true),
              ("handback", if handback == "pending" then toJson "detached" else undef)]]
      return held
    match ← Prog.attempt "resumeLostSubagentResult"
        [row, Twin.callArg call 0, Twin.callArg call 1, heldFor eventId] with
    | .threw error _ =>
      let _ ← Prog.effect "toErrorMessage" [error]
      return keep held eventId (heldFor eventId)
    | .ok retry => return keep held eventId retry
    | .pending => Prog.unsupported "unfinished resume"
  let rec pages (handback status : String) (updatedBefore : Json) :
      Nat → List (Json × Json) → Json → Prog (List (Json × Json))
    | 0, _, _ => Prog.unsupported "more pages than the model allows"
    | fuel + 1, held, cursor => do
      let result ← Prog.effect "listOwedAsyncAgentResults"
        [Json.mkObj
          [("handback", toJson handback), ("status", toJson status),
           ("updatedAfter", field windows "updatedAfter"),
           ("updatedBefore", updatedBefore), ("cursor", cursor)]]
      let mut held := held
      for row in items (field result "page") do
        held ← handleRow handback held row
      if isTrue (field result "isDone") then
        return held
      pages handback status updatedBefore fuel held (field result "cursor")
  let mut held : List (Json × Json) := []
  for (handback, status, updatedBefore) in ranges do
    held ← pages handback status updatedBefore 32 held Json.null
  let next := Json.mkObj
    [("$map", .arr (held.map fun entry => Json.arr #[entry.1, entry.2]).toArray)]
  if next.compress != previous.compress then
    Prog.setState "module.heldLostResults" next
  return undef

/-- `createConfiguredOpenCodeAdapter` -/
def createConfiguredOpenCodeAdapter (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let name ← Prog.effect "requireHarnessProviderName" [config]
  let provider ← Prog.effect "requireHarnessProviderSettings" [config, name]
  let auth ← match text name with
    | "anthropic" => Prog.effect "resolveAnthropicAuthEnv" [provider]
    | "openai" => Prog.effect "resolveOpenAiAuthEnv" [provider]
    | "vercel" => Prog.effect "resolveGatewayAuthEnv" [provider]
    | _ => pure undef
  if !truthy auth then
    return ← Prog.throwError "Error"
      "config.harness.type opencode requires the anthropic, openai, or vercel model provider"
  let variant ← Prog.effect "openCodeVariant" [field config "model"]
  let _ ← Prog.effect "warnReasoningChanged" [config, variant]
  Prog.effect "createOpenCode"
    [obj [("auth", auth), ("provider", name), ("reasoningVariant", variant),
          ("startupTimeoutMs", field (field config "harness") "startupTimeoutMs")]]

private def compactionPrompt : String :=
  "You compact conversation history for an agentic AI session.\n\nSummarize the older messages into durable context for future turns.\n\nPreserve user goals, decisions, constraints, important facts, tool outcomes, open tasks, and unresolved questions. Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.\n\nDo not invent new facts. Do not answer the user.\n"

/-- What the summary calls have spent so far. -/
private structure Spent where
  usage : Json
  modelCalls : Nat := 0

/-- One `requestSummary`: a failed model call goes back to `summarizeBlocks`, spending nothing. -/
private def requestSummary (call : Json) (configured providerOptions : Json) (suffix : String)
    (spent : Spent) (blocks : Json) : Prog Spent := do
  let input := Twin.callArg call 0
  let settings ← Prog.effect "modelSettingsFromModelConfig" [field input "agentConfig"]
  let environment := Twin.env call "DEPLOYMENT_ENVIRONMENT"
  let content := "\n\n".intercalate ((items blocks).map text) ++ suffix
  let request := spread settings
    [("model", field configured "model"), ("instructions", toJson compactionPrompt),
     ("runtimeContext", Json.mkObj
       [("traceName", toJson "harness.compaction"),
        ("properties", if truthy environment then
          Json.mkObj [("environment", environment)] else Json.mkObj [])]),
     ("telemetry", Json.mkObj
       [("functionId", toJson "harness.compaction"),
        ("includeRuntimeContext", Json.mkObj
          [("traceName", toJson true), ("properties", toJson true)]),
        ("recordInputs", toJson false), ("recordOutputs", toJson false)]),
     ("messages", arr [Json.mkObj [("role", toJson "user"), ("content", toJson content)]])]
  let withOptions := if truthy providerOptions
    then request.setObjVal! "providerOptions" providerOptions else request
  let result ← Prog.effect "generateText" [withOptions]
  let callUsage ← Prog.effect "usageTokenTotals" [field result "usage"]
  let written := field callUsage "cacheWriteTokens"
  let cacheWrite ←
    if truthy written then pure written
    else
      Prog.effect "extractCacheWriteTokens"
        [field configured "providerName", field result "providerMetadata"]
  let usage ← Prog.effect "addUsageTokenTotals"
    [spent.usage, spread callUsage [("cacheWriteTokens", cacheWrite)]]
  return { usage := usage, modelCalls := spent.modelCalls + 1 }

private def drainSummaries (call : Json) (configured providerOptions : Json) (suffix : String) :
    Nat → Spent → Prog Spent
  | 0, spent => pure spent
  | limit + 1, spent =>
    .input fun
      | none => pure spent
      | some ("requestSummary", args) =>
        Prog.bind
          (Prog.catchFail (requestSummary call configured providerOptions suffix spent (Twin.arg args 0))
            (fun error =>
              if isUndef (field error "$unsupported") then pure spent else throw error))
          (drainSummaries call configured providerOptions suffix limit)
      | some (other, _) => Prog.unsupported s!"callback {other}"

private def spentJson (configured : Json) (spent : Spent) : List (String × Json) :=
  [("usage", spent.usage), ("modelCalls", toJson spent.modelCalls),
   ("modelProvider", field configured "providerName"),
   ("modelId", member (field configured "model") "modelId")]

/-- `summarizeConversation` -/
def summarizeConversation (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let messages ← Prog.effect "stripReasoningFromMessages" [field input "messages"]
  let context := items (field input "priorSummaries") ++ items messages
  if context.isEmpty then return Json.null
  let config := field input "agentConfig"
  let configured ← Prog.effect "resolveConfiguredModel" [config, field input "accountId"]
  let providerOptions ← Prog.effect "providerOptionsFromModelConfig" [config]
  let _ ← Prog.effect "Date.now"
  let suffix ← Prog.effect "formatInstructions" [field input "instructions"]
  let initial ← Prog.effect "usageTokenTotals" [undef]
  let formatted ← Prog.effect "formatMessagesForCompaction" [arr context]
  let spent ← drainSummaries call configured providerOptions (text suffix) 32 { usage := initial }
  let summary ← Prog.attempt "summarizeBlocks" [formatted, fnNamed "requestSummary"]
  match summary with
  | .pending => Prog.unsupported "the summary never finished"
  | .threw error _ =>
    let wrapped ← Prog.effect "new CompactionError"
      [error, Json.mkObj (spentJson configured spent)]
    throw wrapped
  | .ok value =>
    let _ ← Prog.effect "Date.now"
    let message ← Prog.effect "createCompactionSummaryMessage" [value]
    return Json.mkObj (spentJson configured spent ++ [("message", message)])

private def requireAccount (call : Json) : Prog Json := do
  let accountId := thisField call "accountId"
  if !truthy accountId then
    return ← Prog.throwError "Error" "Account ID is required for runtime claims"
  return accountId

/-- `Session.claimMessageTurn` -/
def claimMessageTurn (call : Json) : Prog Json := do
  let accountId ← requireAccount call
  let key ← Prog.effect "messageTurnsKey" [thisField call "eventId"]
  Prog.effect "runtime.mutate"
    [toJson "claimEvent",
     Json.mkObj [("accountId", accountId), ("key", key), ("ttlSeconds", toJson (86400 : Nat)),
                 ("limit", Twin.callArg call 0)]]

/-- `Session.releaseMessageTurn` -/
def releaseMessageTurn (call : Json) : Prog Json := do
  let accountId ← requireAccount call
  let key ← Prog.effect "messageTurnsKey" [thisField call "eventId"]
  let _ ← Prog.effect "runtime.mutate"
    [toJson "releaseClaim", Json.mkObj [("accountId", accountId), ("key", key)]]
  return undef

/-- `Session.release` -/
def sessionRelease (call : Json) : Prog Json := do
  let accountId ← requireAccount call
  let _ ← Prog.effect "runtime.mutate"
    [toJson "releaseClaim",
     Json.mkObj [("accountId", accountId), ("key", thisField call "eventId")]]
  return undef

/-- `Session.appendIngressEvents` -/
def appendIngressEvents (call : Json) : Prog Json := do
  let split ← Prog.effect "splitIngressEvents" [Twin.callArg call 0]
  let _ ← Prog.effect "this.persistModelMessages" [field split "persisted"]
  return field split "ephemeralSystem"

/-- `optionalEnv` -/
def optionalEnv (call : Json) : Prog Json :=
  let value := Twin.env call (text (Twin.callArg call 0))
  pure (if truthy value then value else undef)

/-- `Number(raw)` for plain decimals: the sign, then `digits[.digits]`. Anything else is NaN here. -/
private def parseDecimal (raw : String) : Option (Bool × Nat) :=
  let negative := raw.startsWith "-"
  let body := if negative then (raw.drop 1).toString else raw
  match body.splitOn "." with
  | [whole] => if whole.isEmpty then none else whole.toNat?.map (negative, ·)
  | [whole, fraction] =>
    if whole.isEmpty || fraction.isEmpty || !fraction.all Char.isDigit then none
    else whole.toNat?.map (negative, ·)
  | _ => none

/-- `positiveIntegerEnv` -/
def positiveIntegerEnv (call : Json) : Prog Json := do
  let fallback := Twin.callArg call 1
  let raw ← Prog.effect "optionalEnv" [Twin.callArg call 0]
  if isUndef raw then return fallback
  match parseDecimal (text raw) with
  | some (false, floor) => return if floor ≥ 1 then toJson floor else fallback
  | _ => return fallback

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (coord "runTurns") runTurns,
   Twin.traced (sess "claimMessageTurn") claimMessageTurn,
   Twin.traced (sess "releaseMessageTurn") releaseMessageTurn,
   Twin.traced (sess "release") sessionRelease,
   Twin.traced (sess "appendIngressEvents") appendIngressEvents,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/opencode.ts#createConfiguredOpenCodeAdapter" createConfiguredOpenCodeAdapter,
   Twin.traced "apps/core/src/harness/compaction.ts#summarizeConversation" summarizeConversation,
   Twin.traced "apps/core/src/shared/env.ts#optionalEnv" optionalEnv,
   Twin.traced "apps/core/src/shared/env.ts#positiveIntegerEnv" positiveIntegerEnv,
   Twin.traced (coord "launch") launch,
   Twin.traced (coord "resolveTask") resolveTask,
   Twin.traced (coord "createChildTurnContext") createChildTurnContext,
   Twin.traced (coord "resumeChild") resumeChild,
   Twin.traced (coord "completeTask") completeTask,
   Twin.traced (sub "resumeLostSubagentResult") resumeLostSubagentResult,
   Twin.traced (sub "resumeLostSubagentResults") resumeLostSubagentResults]

end Spec.Agent.Waveagent5b
