import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign4/agent4b.tsv`.
-/

namespace Spec.Agent.Waveagent4b

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def isNullish (value : Json) : Bool :=
  isUndef value || value == Json.null

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def items (value : Json) : List Json :=
  (value.getArr?.toOption.getD #[]).toList

private def arr (values : List Json) : Json :=
  .arr values.toArray

private def text (value : Json) : String :=
  (value.getStr?).toOption.getD ""

private def thisField (call : Json) (name : String) : Json :=
  Twin.field (Twin.self call) name

/-- JavaScript truthiness of a recorded value. -/
private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str s => !s.isEmpty
  | .num n => n.mantissa != 0
  | other => !isUndef other

/-- True when the recorder cut this value off at its depth limit, so a twin cannot rebuild it. -/
private def truncated (value : Json) : Bool :=
  (value.compress.splitOn "too-deep").length > 1

/-- `{...base, ...over}`. -/
private def spread (base over : Json) : Json :=
  match over with
  | .obj kvs => kvs.foldl (fun acc key value => acc.setObjVal! key value) base
  | _ => base

/-- Drops `undefined` as `JSON.stringify` does: gone from objects, `null` in arrays. -/
private def jsonVisible : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .arr list => .arr (list.map fun item =>
        if isUndef item then Json.null else jsonVisible fuel item)
    | .obj kvs =>
      kvs.foldl (fun acc key item =>
        if isUndef item then acc else acc.setObjVal! key (jsonVisible fuel item)) (Json.mkObj [])
    | other => other

private def stored (name : String) : String :=
  s!"apps/core/src/harness/session.ts#{name}"

/-- `fireWebhook` -/
def fireWebhook (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let transport := Twin.callArg call 2
  let url := field config "url"
  let _ ← Prog.effect "assertPublicHttpsUrl" [url, toJson "webhook url"]
  let body := toJson (Twin.jsonStringify 64 (jsonVisible 64 (Twin.callArg call 1)))
  let signature ← Prog.effect "createWebhookSignature" [field config "secret", body]
  let init := Json.mkObj
    [("method", toJson "POST"),
     ("headers", Json.mkObj
       [("Content-Type", toJson "application/json"), ("X-Webhook-Signature", signature)]),
     ("body", body)]
  let response ← Prog.effect "guardedFetch"
    [url, init, (spread (Json.mkObj []) transport).setObjVal! "redirectLimit" (toJson (0 : Nat))]
  let status := field response "status"
  let inRange := match status.getNat? with
    | .ok code => 200 <= code && code < 300
    | _ => false
  if inRange then return undef
  Prog.throwError "Error" s!"Webhook delivery failed with HTTP {status.compress}"

/-- `Session.environmentText` -/
def environmentText (call : Json) : Prog Json := do
  let workspaces ← Prog.effect "this.resolvedWorkspaces"
  let sandboxes ← Prog.effect "this.sandboxes"
  let canBash := !(items sandboxes).isEmpty ||
    (items workspaces).any (fun workspace => truthy (field workspace "sandbox"))
  let now ← Prog.effect "new Date"
  let channel ← Prog.effect "this.channelLabel"
  let bashTargets ←
    if canBash then
      Prog.effect "bashTargetLines"
        [Json.mkObj [("workspaces", workspaces), ("sandboxes", sandboxes)]]
    else pure (arr [])
  Prog.effect "formatEnvironmentPrompt"
    [Json.mkObj
      [("now", Json.mkObj [("$date", now)]),
       ("channel", channel),
       ("bashTargets", bashTargets),
       ("machine", Twin.param call 0)]]

/-- `Session.secretValues` -/
def secretValues (call : Json) : Prog Json := do
  let config := thisField call "agentConfig"
  if truncated config then return ← Prog.unsupported "agentConfig is cut off in the recording"
  let sandboxes ← Prog.effect "this.sandboxes"
  let workspaces ← Prog.effect "this.resolvedWorkspaces"
  let secrets ← Prog.effect "collectSecretValues" [arr [config, sandboxes, workspaces]]
  let credential := thisField call "#userCredential"
  return if truthy credential then arr (items secrets ++ [credential]) else secrets

/-- `Session.loadMemoryFile` -/
def loadMemoryFile (call : Json) : Prog Json := do
  let workspace := Twin.callArg call 0
  let storage := field (field workspace "config") "storage"
  if field storage "provider" == toJson "disk" then return Json.null
  let context ← Prog.effect "workspaceReadContext" [storage, field workspace "namespace"]
  let target ← Prog.effect "resolveS3ReadTarget" [context]
  let key := toJson (text (field target "prefix") ++ "memory/MEMORY.md")
  let access := field target "access"
  let args := if truthy access then [field target "bucket", key, access]
    else [field target "bucket", key]
  match ← Prog.attempt "readS3Text" args with
  | .ok value => return value
  | .pending => Prog.unsupported "the read never finished"
  | .threw error _ =>
    let missing ← Prog.effect "isMissingS3Error" [error]
    if truthy missing then return Json.null
    throw error

private def memoryEnabled : List Json → Prog (List Json)
  | [] => pure []
  | workspace :: rest => do
    let enabled ← Prog.effect "workspaceMemoryHarnessEnabled" [field workspace "config"]
    let tail ← memoryEnabled rest
    return if truthy enabled then workspace :: tail else tail

/-- `Session.loadMemoryFiles` -/
def loadMemoryFiles (call : Json) : Prog Json := do
  let _ ← Prog.effect "this.ensureResolvedRuntime"
  let enabled ← Prog.effect "this.isWorkspaceEnabled"
  if !truthy enabled then return arr []
  if !isUndef (thisField call "memoryFilesPromise") then
    return ← Prog.unsupported "a memoized promise's value is not recorded"
  let workspaces ← Prog.effect "this.resolvedWorkspaces"
  let selected ← memoryEnabled (items workspaces)
  let outcomes ← Prog.all (selected.map fun workspace => ("this.loadMemoryFile", [workspace]))
  let mut files : List Json := []
  for (workspace, outcome) in selected.zip outcomes do
    match outcome with
    | .ok content =>
      if !isNullish content then
        files := files ++ [Json.mkObj [("content", content), ("workspace", workspace)]]
    | .threw error _ => throw error
    | .pending => return ← Prog.unsupported "a read never finished"
  return arr files

/-- `Session.saveHarnessSession` -/
def saveHarnessSession (call : Json) : Prog Json := do
  let state := Twin.callArg call 0
  let batches ← Prog.effect "harnessEntryBatches" [thisField call "pendingHarnessEntries"]
  if !truthy (thisField call "persist") then return undef
  let generation := thisField call "ownerGeneration"
  if isUndef generation then
    return ← Prog.throwError "Error" "Harness checkpoint needs a conversation owner"
  if isUndef (field state "resumeState") then
    return ← Prog.throwError "Error" "Harness resume state must be JSON serializable"
  let owner := Json.mkObj
    [("conversationKey", thisField call "conversationKey"),
     ("ownerEventId", thisField call "eventId"),
     ("ownerGeneration", generation)]
  let startedAt ← Prog.effect "performance.now"
  let all := items batches
  let mut afterSequence := undef
  for entries in all.dropLast do
    let body := (owner.setObjVal! "sessionId" (field state "sessionId")).setObjVal! "entries" entries
    let body := if isUndef afterSequence then body else body.setObjVal! "afterSequence" afterSequence
    afterSequence ← Prog.effect "runtime.mutate" [toJson "appendHarnessSessionEntries", body]
  let body := (spread owner state).setObjVal! "entries" (all.getLast?.getD undef)
  let body := if isUndef afterSequence then body else body.setObjVal! "afterSequence" afterSequence
  let _ ← Prog.effect "runtime.mutate" [toJson "saveHarnessSession", body]
  let _ ← Prog.effect "this.confirmOwner" [startedAt]
  return undef

/-- Rows from a stored conversation read, as `withUnwrittenRows` takes them. -/
private def asAppended (row : Json) : Json :=
  Json.mkObj [("cursor", field row "createdAt"), ("event", field row "event")]

private def firstRole (rows : Json) : Json :=
  field (field (field ((items rows).headD undef) "event") "message") "role"

private def olderRows (config unwritten : Json) : Nat → Json → Prog Json
  | 0, _ => Prog.unsupported "more pages than the model allows"
  | fuel + 1, tail => do
    let role := firstRole tail
    if !(role == toJson "assistant" || role == toJson "user") then return tail
    let merged ← Prog.effect "withUnwrittenRows" [tail, unwritten]
    let stopAtRole ← Prog.effect "missingHarnessRole" [merged, config]
    if !truthy stopAtRole then return tail
    let before := field ((items tail).headD undef) "createdAt"
    let older ← Prog.effect "this.loadConversationEntries"
      [Json.mkObj [("beforeCreatedAt", before), ("stopAtRole", stopAtRole)]]
    if (items older).isEmpty then return tail
    olderRows config unwritten fuel (arr (items older ++ items tail))

/-- `Session.loadHarnessTurnEntries` -/
def loadHarnessTurnEntries (call : Json) : Prog Json := do
  let config := thisField call "agentConfig"
  if truncated config then return ← Prog.unsupported "agentConfig is cut off in the recording"
  let outcomes ← Prog.all
    [("this.loadConversationEntries", [Json.mkObj [("role", toJson "system")]]),
     ("this.loadConversationEntries", [Json.mkObj [("stopAtRole", toJson "assistant")]])]
  match outcomes with
  | [.ok systemRows, .ok newest] =>
    let tail ← olderRows config (Twin.callArg call 0) 256 newest
    Prog.effect "withUnwrittenRows" [tail, arr ((items systemRows).map asAppended)]
  | [.threw error _, _] | [_, .threw error _] => throw error
  | _ => Prog.unsupported "a read never finished"

private def appendedEvent (self : Json) (dedupeKeys : Json) (producer : Json) (source : Json)
    (index : Nat) (message : Json) : Prog (List Json) := do
  let event ← Prog.effect "createStoredEventFromModelMessage"
    [message, field self "eventId", producer]
  let fromKeys := if isUndef dedupeKeys then undef else (items dedupeKeys).getD index undef
  let dedupeKey := if !isNullish fromKeys then fromKeys
    else if field source "role" == toJson "user" then field source "dedupeKey" else undef
  let toolResultIds ← Prog.effect "this.toolResultIdsOf" [message]
  if !truthy event then return []
  let cursor ← Prog.effect "this.nextCreatedAt"
  let row := Json.mkObj [("cursor", cursor), ("event", event)]
  let row := if isUndef dedupeKey then row else row.setObjVal! "dedupeKey" dedupeKey
  let row := if (items toolResultIds).isEmpty then row
    else row.setObjVal! "toolResultIds" toolResultIds
  return [row]

/-- `Session.storedEvents` -/
def storedEvents (call : Json) : Prog Json := do
  let self := (Twin.self call).getObjValD "$fields"
  let messages := Twin.callArg call 0
  let dedupeKeys := Twin.callArg call 1
  if !truthy (field self "persist") then
    for message in items messages do
      let _ ← Prog.effect "this.toolResultIdsOf" [message]
    return arr []
  let config := field self "agentConfig"
  if truncated config then return ← Prog.unsupported "agentConfig is cut off in the recording"
  let model ← Prog.effect "modelIdentityFromModelConfig" [config]
  let retains ← Prog.effect "retainsReasoningParts" [config]
  let producer := Json.mkObj [("retainsReasoning", retains)]
  let producer := if isUndef model then producer else producer.setObjVal! "model" model
  let accountId := field self "accountId"
  let sealedMessages ←
    if isUndef accountId then pure messages
    else Prog.effect "sealConversationMedia" [messages, accountId]
  let sources := items messages
  let mut rows : List Json := []
  let mut index := 0
  for message in items sealedMessages do
    let row ← appendedEvent self dedupeKeys producer (sources.getD index undef) index message
    rows := rows ++ row
    index := index + 1
  return arr rows

/-- An object literal: an `undefined` value is left out, as the recorder writes it. -/
private def objDefined (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

/-- `COMPACTION_MARKER` in `compaction.ts`. -/
private def compactionMarker : String := "<session-compaction-summary>"

private def isCompactionSummary (message : Json) : Bool :=
  match (field message "content").getStr? with
  | .ok content => content.startsWith compactionMarker
  | _ => false

private def systemMessage (content : Json) : Json :=
  Json.mkObj [("role", toJson "system"), ("content", content)]

/-- `Session.buildSystemPromptParts` -/
def buildSystemPromptParts (call : Json) : Prog Json := do
  let config := thisField call "agentConfig"
  let agentSystem := field (field config "agent") "system"
  if truncated agentSystem then
    return ← Prog.unsupported "agent.system is cut off in the recording"
  let outcomes ← Prog.all
    [("this.loadMemoryFiles", []), ("this.loadSkillMetadata", []), ("this.loadSubagentMetadata", [])]
  let (memoryFiles, skills, subagents) ← match outcomes with
    | [.ok a, .ok b, .ok c] => pure (a, b, c)
    | [.threw error _, _, _] | [_, .threw error _, _] | [_, _, .threw error _] => throw error
    | _ => Prog.unsupported "a load never finished"
  let memorySystem ←
    if (items memoryFiles).isEmpty then pure []
    else pure [systemMessage (← Prog.effect "formatMemorySystemPrompt" [memoryFiles])]
  let memoryTool ← Prog.effect "this.isMemoryToolEnabled"
  let harness ← Prog.effect "this.enableDefaultHarness"
  let workspaceSystem ←
    if truthy harness then do
      let workspaces ← Prog.effect "this.resolvedWorkspaces"
      pure [systemMessage (← Prog.effect "formatWorkspaceHarnessSystemPrompt" [workspaces, memoryTool])]
    else pure []
  let memoryHarnessSystem ←
    if truthy memoryTool then do
      let scope ← Prog.effect "channelScopeKeyFromConversation" [thisField call "conversationKey"]
      pure [systemMessage (← Prog.effect "formatMemoryHarnessSystemPrompt" [scope])]
    else pure []
  let schedulerSystem ←
    if field (field config "scheduler") "enabled" == toJson true then
      pure [systemMessage (← Prog.effect "formatSchedulerSystemPrompt")]
    else pure []
  let skillsSystem ←
    if (items skills).isEmpty then pure []
    else pure [systemMessage (← Prog.effect "formatSkillsSystemPrompt" [skills])]
  let subagentSystem ←
    if field (field config "subagent") "enabled" == toJson true then
      pure [systemMessage (← Prog.effect "formatSubagentSystemPrompt" [subagents])]
    else pure []
  let agentMessages ← Prog.effect "agentSystemMessages" [agentSystem]
  let stored := items agentMessages ++ memorySystem ++ workspaceSystem ++ memoryHarnessSystem ++
    schedulerSystem ++ skillsSystem ++ subagentSystem ++
    items (thisField call "loadedSkillPrompts") ++ items (Twin.param call 0)
  return Json.mkObj
    [("system", arr (stored ++ items (Twin.param call 1))),
     ("storedSystemEnd", toJson ((stored.length : Int) - 1))]

/-- `Session.loadRefreshedSystemPromptParts` -/
def loadRefreshedSystemPromptParts (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let snapshot := field options "systemContextSnapshot"
  let cursor := field snapshot "cursor"
  let last := thisField call "lastSystemCursor"
  let upToDate := last == Json.null ||
    (cursor != Json.null && decide (text last ≤ text cursor))
  let entries ←
    if upToDate then pure (arr [])
    else
      Prog.effect "this.loadConversationEntries" [Json.mkObj [("afterCreatedAt", cursor)]]
  let refreshed ←
    if (items entries).isEmpty then pure snapshot
    else do
      let projected ← Prog.effect "projectSystemContextMessages" [entries]
      let lastCreatedAt := field ((items entries).getLast?.getD undef) "createdAt"
      pure (Json.mkObj
        [("cursor", if isNullish lastCreatedAt then cursor else lastCreatedAt),
         ("messages", arr (items (field snapshot "messages") ++ items projected))])
  let ephemeral := field options "ephemeralSystem"
  let parts ← Prog.effect "this.buildSystemPromptParts"
    [field refreshed "messages", if isNullish ephemeral then arr [] else ephemeral]
  return spread (Json.mkObj [("systemContextSnapshot", refreshed)]) parts

/-- `Session.compactConversation` -/
def compactConversation (call : Json) : Prog Json := do
  let config := thisField call "agentConfig"
  if truncated config then return ← Prog.unsupported "agentConfig is cut off in the recording"
  let entries ← Prog.effect "this.loadConversationEntries"
  let active ← Prog.effect "projectActiveConversationEntries" [entries]
  let snapshot ← Prog.effect "createSystemContextSnapshot" [entries]
  let identity ← Prog.effect "modelIdentityFromModelConfig" [config]
  let messages ← Prog.effect "projectEntriesToMessages" [active, identity]
  if (items messages).isEmpty then return Json.null
  let pending ← Prog.effect "hasPendingToolApprovalResponse" [messages]
  if truthy pending then return Json.null
  let stripped ← Prog.effect "stripEnvelopeFieldsFromMessages" [messages]
  let summary ← Prog.effect "summarizeConversation"
    [objDefined
      [("accountId", thisField call "accountId"),
       ("conversationKey", thisField call "conversationKey"),
       ("priorSummaries", arr ((items (field snapshot "messages")).filter isCompactionSummary)),
       ("messages", stripped),
       ("agentConfig", config),
       ("instructions", Twin.callArg call 0)]]
  if !truthy summary then return Json.null
  let _ ← Prog.effect "this.persistModelMessages" [arr [field summary "message"]]
  let cost := match summary with
    | .obj kvs => kvs.foldl (fun (acc : Json) key value =>
        if key == "message" then acc else acc.setObjVal! key value) (Json.mkObj [])
    | _ => Json.mkObj []
  return cost.setObjVal! "messageCount" (toJson (items messages).length)

/-- The callback `stepBoundary` hands to `writeFenced`. -/
private def stepBoundaryWrite (call : Json) (options : Json) (generation : Json) (args : Json) :
    Prog Unit := do
  let inline := Twin.arg args 0
  let startedAt ← Prog.effect "performance.now"
  let body := Json.mkObj
    [("conversationKey", thisField call "conversationKey"),
     ("ownerEventId", thisField call "eventId"),
     ("ownerGeneration", generation),
     ("leaseTtlMs", toJson (900000 : Nat)),
     ("claimSteering", field options "claimSteering")]
  let body := if (items inline).isEmpty then body else body.setObjVal! "events" inline
  let boundary ← Prog.effect "runtime.mutate" [toJson "stepIngressBoundary", body]
  let renewal := field boundary "renewal"
  if renewal != toJson "stale" then
    let _ ← Prog.effect "this.trackSystemCursor" [Twin.arg args 1]
  if renewal == toJson "renewed" then
    let _ ← Prog.effect "this.confirmOwner" [startedAt]

/-- `Session.stepBoundary` -/
def stepBoundary (call : Json) : Prog Json := do
  let options := Twin.param call 1
  let events ← Prog.effect "this.storedEvents" [Twin.callArg call 0, field options "dedupeKeys"]
  let generation := thisField call "ownerGeneration"
  if isUndef generation then
    let _ ← Prog.effect "this.appendStoredEvents" [events]
    return Json.mkObj [("renewal", toJson "renewed"), ("steering", Json.null)]
  Prog.drain (fun label args =>
    if label == "arg1" then
      Prog.catchFail (stepBoundaryWrite call options generation args) (fun _ => pure ())
    else Prog.unsupported s!"callback {label}") 8
  let written ← Prog.attempt "this.writeFenced" [events, Json.mkObj [("$fn", toJson "")]]
  match written with
  | .ok value => return value
  | .threw error _ => throw error
  | .pending => Prog.unsupported "the write never finished"

/-- `ingestChannelAttachments` -/
def ingestChannelAttachments (call : Json) : Prog Json := do
  let events := Twin.callArg call 0
  let attachments := Twin.callArg call 1
  let context := Twin.callArg call 2
  if (items attachments).isEmpty then
    return Json.mkObj [("events", events), ("turnEvents", events)]
  let config := field context "agentConfig"
  let channel := field context "channelName"
  let key := field context "conversationKey"
  let channelScope ← Prog.effect "channelScopeKeyFromConversation" [key]
  let conversationScope ← Prog.effect "channelScopeKeyFromConversation" [key, toJson "conversation"]
  let partition ← Prog.effect "channelPartitionOf" [config, channel]
  let runtime ← Prog.effect "resolveAgentRuntime"
    [config,
     objDefined [("accountId", field context "accountId"), ("agentId", field context "agentId")],
     objDefined
       [("channelName", channel), ("channelScopeKey", channelScope),
        ("conversationKey", conversationScope), ("partition", partition)]]
  let parts ← Prog.effect "ingestInboundAttachments"
    [attachments,
     objDefined
       [("accountId", field context "accountId"), ("agentId", field context "agentId"),
        ("channelName", channel), ("eventId", field context "eventId"), ("agentConfig", config),
        ("workspace", (items (field runtime "workspaces")).headD undef)]]
  let appendTo (key : String) : Prog Json :=
    if (items (field parts key)).isEmpty then pure events
    else Prog.effect "appendToLatestUserEvent" [events, field parts key]
  let storedEvents ← appendTo "stored"
  let turnEvents ← appendTo "turn"
  return Json.mkObj [("events", storedEvents), ("turnEvents", turnEvents)]

/-- `createConfiguredCodexAdapter` -/
def createConfiguredCodexAdapter (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let providerName ← Prog.effect "requireHarnessProviderName" [config]
  let name := text providerName
  if name != "custom" && name != "openai" && name != "vercel" then
    return ← Prog.throwError "Error"
      "config.harness.type codex requires the custom, openai, or vercel model provider"
  let provider ← Prog.effect "requireHarnessProviderSettings" [config, providerName]
  let auth ← Prog.effect
    (if name == "vercel" then "resolveGatewayAuthEnv" else "resolveOpenAiAuthEnv") [provider]
  let effort ← Prog.effect "harnessEffort" [field (field config "model") "reasoning"]
  let _ ← Prog.effect "warnReasoningChanged" [config, effort]
  let harness := field config "harness"
  Prog.effect "createCodex"
    [objDefined
      [("auth", auth), ("reasoningEffort", effort),
       ("startupTimeoutMs", field harness "startupTimeoutMs"),
       ("webSearch", field harness "webSearch")]]

/-- `/[^0]/.test(id)`. -/
private def hasNonZero (value : Json) : Bool :=
  (text value).any (· != '0')

/-- `observabilityAttributes` in `otel.ts`. -/
private def observabilityAttributes (scope : Json) : Json :=
  Json.mkObj
    [("account_id", field scope "accountId"), ("project", field scope "project"),
     ("stage", field scope "stage"), ("endpoint_id", field scope "endpointId"),
     ("agent_id", field scope "agentId"), ("conversation_key", field scope "conversationKey")]

/-- `startRunRoot` -/
def startRunRoot (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let parent := Twin.param call 3
  let tracer ← Prog.effect "getTracer"
  let scope ← Prog.effect "sessionObservabilityScope" [session]
  let span ← Prog.effect "tracer.startSpan"
    [Twin.callArg call 1,
     Json.mkObj
       [("startTime", Twin.callArg call 2), ("attributes", observabilityAttributes scope)],
     parent]
  let ids ← Prog.effect "span.spanContext"
  let traceId ←
    if hasNonZero (field ids "traceId") then pure (field ids "traceId")
    else Prog.effect "mintTraceId"
  let spanId ←
    if hasNonZero (field ids "spanId") then pure (field ids "spanId")
    else Prog.effect "mintSpanId"
  let otelContext ← Prog.effect "otelTraceApi.setSpan" [parent, span]
  let spans ← Prog.effect "createRunSpanTracker"
    [Json.mkObj
      [("tracer", tracer), ("scope", scope), ("traceId", traceId), ("rootSpanId", spanId),
       ("rootOtelContext", otelContext),
       ("session", objDefined
         [("endpointId", Twin.field session "endpointId" |> fun v =>
            if isUndef v then field session "endpointId" else v),
          ("agentId", Twin.field session "agentId" |> fun v =>
            if isUndef v then field session "agentId" else v),
          ("conversationKey", Twin.field session "conversationKey" |> fun v =>
            if isUndef v then field session "conversationKey" else v)]),
       ("publish", Json.mkObj [("$fn", toJson "publishSpan")])]]
  return Json.mkObj
    [("span", span), ("traceId", traceId), ("spanId", spanId), ("otelContext", otelContext),
     ("spans", spans)]

/-- Reads a property of an options bag, or of a real `Session` instance. -/
private def prop (value : Json) (name : String) : Json :=
  let direct := field value name
  if isUndef direct then Twin.field value name else direct

private def base64Value (c : Char) : Option Nat :=
  if 'A' ≤ c && c ≤ 'Z' then some (c.toNat - 'A'.toNat)
  else if 'a' ≤ c && c ≤ 'z' then some (c.toNat - 'a'.toNat + 26)
  else if '0' ≤ c && c ≤ '9' then some (c.toNat - '0'.toNat + 52)
  else if c == '+' then some 62
  else if c == '/' then some 63
  else none

/-- Decodes the recorder's `$bytes` base64. -/
private def base64Bytes (encoded : String) : List UInt8 :=
  let step := fun (state : Nat × Nat × List UInt8) (c : Char) =>
    match base64Value c with
    | none => state
    | some value =>
      let (bits, count, out) := state
      let bits := bits * 64 + value
      let count := count + 6
      if count >= 8 then
        let rest := count - 8
        ((bits % 2 ^ rest), rest, UInt8.ofNat (bits / 2 ^ rest) :: out)
      else (bits, count, out)
  let (_, _, out) := encoded.toList.foldl step (0, 0, [])
  out.reverse

private def fileBytes (file : Json) : List UInt8 :=
  base64Bytes (text (field (field file "bytes") "$bytes"))

private def maxSkillBundleBytes : Nat := 30 * 1024 * 1024
private def maxSkillFileBytes : Nat := 5 * 1024 * 1024
private def maxSkillMetadataBytes : Nat := 65536

private def normalizeFiles : List Json → Prog (List Json)
  | [] => pure []
  | file :: rest => do
    let path ← Prog.effect "normalizeBundlePath" [field file "path"]
    let tail ← normalizeFiles rest
    return file.setObjVal! "path" path :: tail

private def checkFiles : List Json → List Json → Nat → Prog Nat
  | [], _, total => pure total
  | file :: rest, seen, total => do
    let path := field file "path"
    if seen.contains path then
      return ← Prog.throwError "Error" s!"Duplicate skill file path: {text path}"
    let size := (fileBytes file).length
    if size > maxSkillFileBytes then
      return ← Prog.throwError "Error" s!"Skill file is too large: {text path}"
    let supported ← Prog.effect "isSupportedTextFile" [path, field file "bytes"]
    if !truthy supported then
      return ← Prog.throwError "Error" s!"Skill file must be a supported text file: {text path}"
    checkFiles rest (path :: seen) (total + size)

/-- `validateSkillBundle` -/
def validateSkillBundle (call : Json) : Prog Json := do
  let files ← normalizeFiles (items (Twin.callArg call 0))
  let total ← checkFiles files [] 0
  if total > maxSkillBundleBytes then
    return ← Prog.throwError "Error" "Skill bundle exceeds 30 MB"
  match files.find? (fun file => field file "path" == toJson "SKILL.md") with
  | none => Prog.throwError "Error" "Skill bundle must include SKILL.md at the root"
  | some skillFile =>
    let head := (fileBytes skillFile).take maxSkillMetadataBytes
    match String.fromUTF8? (ByteArray.mk head.toArray) with
    | none => Prog.unsupported "the head of SKILL.md is not valid UTF-8"
    | some decoded =>
      let metadata ← Prog.effect "parseSkillMarkdown" [toJson decoded]
      return Json.mkObj [("metadata", metadata), ("files", arr files)]

/-- The `/compact` body inside `runWithObservabilityScope`. -/
private def compactBody (session input kindValue root startedAt instructions : Json) :
    Prog Json := do
  let outcome : Option Json ←
    match ← Prog.attempt "session.compactConversation" [instructions] with
    | .ok result =>
      pure (if truthy result then some (Json.mkObj [("result", result)]) else none)
    | .pending => Prog.unsupported "compaction never finished"
    | .threw error _ =>
      if isUndef (field error "$error") then do
        let message ← Prog.effect "errorMessage" [error]
        pure (some (Json.mkObj [("error", Prog.errorJson "Error" (text message))]))
      else pure (some (Json.mkObj [("error", error)]))
  match outcome with
  | none => return toJson (0 : Nat)
  | some value =>
    match ← Prog.attempt "recordCompactionTask"
        [session, input, kindValue, root, startedAt, value] with
    | .threw error _ =>
      let _ ← Prog.effect "errorMessage" [error]
    | _ => pure ()
    if !isUndef (field value "error") then throw (field value "error")
    let count := field (field value "result") "messageCount"
    return if isNullish count then toJson (0 : Nat) else count

/-- `runCompactCommand` -/
def runCompactCommand (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let input := Twin.callArg call 1
  let startedAt ← Prog.effect "Date.now"
  let trigger := prop session "trigger"
  let kind := if isNullish trigger then toJson "task" else trigger
  let root ← Prog.effect "startRunRoot" [session, toJson s!"agent.{text kind}", startedAt]
  let _ ← Prog.effect "sessionObservabilityScope" [session]
  let _ ← Prog.effect "session.secretValues"
  .input fun
    | some ("arg0", _) => compactBody session input kind root startedAt (Twin.callArg call 2)
    | _ => Prog.unsupported "the scope did not enter its callback"

private def isolatedSandboxReleaseSeconds : Nat := 24 * 60 * 60

/-- `compute` with the isolated sandbox's release time, unless it is shared. -/
private def turnCompute (compute : Json) (shared : Bool) : Json :=
  let plane := field compute "controlPlane"
  if shared || !truthy plane then compute
  else compute.setObjVal! "controlPlane"
    (plane.setObjVal! "releaseAfterIdleSeconds" (toJson isolatedSandboxReleaseSeconds))

private def toolApproval (approvals : Json) : Json :=
  match (field approvals "$map").getArr? with
  | .ok pairs =>
    if pairs.isEmpty then undef
    else pairs.foldl (fun (acc : Json) pair =>
      match (Twin.arg pair 0).getStr? with
      | .ok name => acc.setObjVal! name (toJson "user-approval")
      | _ => acc) (Json.mkObj [])
  | _ => undef

private def instructionsOf (system : Json) : String :=
  "\n\n".intercalate ((items system).map fun message => text (field message "content"))

/-- Status and environment text, which `dispose` must clean up after if either fails. -/
private def turnEnvironment (session sandbox compute runtime : Json) (shared : Bool) : Prog Json := do
  let specs ← Prog.effect "configuredSandboxSpecs" [compute]
  let neighbours ← Prog.effect "sandboxNeighbours"
    [field runtime "reservationKey", prop session "eventId"]
  let lines ← Prog.effect "formatSandboxStatus"
    [objDefined
      [("name", field sandbox "name"), ("provider", field compute "provider"), ("specs", specs),
       ("state", toJson "running"), ("shared", toJson shared), ("neighbours", neighbours)]]
  Prog.effect "session.environmentText" [lines]

/-- `prepareHarnessTurn` -/
def prepareHarnessTurn (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let config := field options "agentConfig"
  let session := field options "session"
  let harness := field config "harness"
  if !truthy harness then
    return ← Prog.throwError "Error" "a native harness turn needs config.harness"
  let type := field harness "type"
  let conversationKey := prop session "conversationKey"
  let _ ← Prog.effect "session.flushPendingStoredEvents"
  let _ ← Prog.effect "options.applySteering"
  let storedSession ← Prog.effect "session.loadHarnessSession"
  let reservationKey ← Prog.effect "harnessReservationKey"
    [objDefined
      [("agentReservationKey", field options "agentReservationKey"),
       ("conversationKey", conversationKey),
       ("isolated", field options "isolated"), ("stored", storedSession), ("type", type)]]
  let shared := reservationKey != conversationKey
  let sandbox ← Prog.effect "requireHarnessSandbox" [field options "sandbox"]
  let compute := field sandbox "sandbox"
  let skills ← Prog.effect "session.loadHarnessSkills"
  let runtime ← Prog.effect "options.createAgent"
    [objDefined
      [("agentConfig", config), ("compute", turnCompute compute shared),
       ("id", prop session "agentId"),
       ("instructions", toJson (instructionsOf (field (field options "turnContext") "system"))),
       ("metadata", field options "metadata"), ("onUsage", Json.mkObj [("$fn", toJson "onUsage")]),
       ("reservationKey", reservationKey), ("session", session), ("shared", toJson shared),
       ("skills", skills), ("toolApproval", toolApproval (field options "configuredApprovals")),
       ("tools", field options "tools")]]
  let runtimeKey := field runtime "reservationKey"
  let occupied ← Prog.effect "occupySandbox"
    [runtimeKey, prop session "eventId",
     objDefined [("agentId", prop session "agentId"), ("conversationKey", conversationKey)]]
  let _ ← Prog.effect "options.onOccupied" [occupied]
  let signal := Json.mkObj [("$signal", toJson false)]
  let stop ← Prog.effect "startHarnessLeaseMonitor"
    [session, signal, field options "stopMessage", Json.mkObj [("$fn", toJson "")]]
  let lost ← (.input fun entered => pure (entered.map fun (_, args) => Twin.arg args 0) :
    Prog (Option Json))
  let opened ← Prog.attempt "options .openSession"
    [objDefined
      [("abortSignal", signal), ("agent", field runtime "agent"),
       ("sandbox", field runtime "sandbox"), ("stored", storedSession), ("type", type)]]
  let harnessSession ← match opened with
    | .ok value => pure value
    | .pending => Prog.unsupported "opening never finished"
    | .threw error _ => do
      let _ ← Prog.effect "stopLeaseMonitor"
      throw error
  if let some reason := lost then
    let _ ← Prog.effect "options.abortController.abort" [reason]
  let environment ← Prog.catchFail (turnEnvironment session sandbox compute runtime shared)
    (fun error => do
      let _ ← Prog.effect "stopLeaseMonitor"
      let _ ← Prog.effect "destroyHarnessSession" [harnessSession]
      throw error)
  let extras := [
    ("dispose", Json.mkObj [("$fn", toJson "dispose")]), ("environment", environment),
    ("reservationKey", reservationKey), ("runtime", runtime), ("stopLeaseMonitor", stop)]
  return extras.foldl (fun (acc : Json) entry => acc.setObjVal! entry.1 entry.2) harnessSession

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [ Twin.traced "apps/core/src/shared/webhook.ts#fireWebhook" fireWebhook
  , Twin.traced (stored "Session.environmentText") environmentText
  , Twin.traced (stored "Session.secretValues") secretValues
  , Twin.traced (stored "Session.loadMemoryFile") loadMemoryFile
  , Twin.traced (stored "Session.loadMemoryFiles") loadMemoryFiles
  , Twin.traced (stored "Session.saveHarnessSession") saveHarnessSession
  , Twin.traced (stored "Session.loadHarnessTurnEntries") loadHarnessTurnEntries
  , Twin.traced (stored "Session.storedEvents") storedEvents
  , Twin.traced (stored "Session.buildSystemPromptParts") buildSystemPromptParts
  , Twin.traced (stored "Session.loadRefreshedSystemPromptParts") loadRefreshedSystemPromptParts
  , Twin.traced (stored "Session.compactConversation") compactConversation
  , Twin.traced (stored "Session.stepBoundary") stepBoundary
  , Twin.traced (stored "ingestChannelAttachments") ingestChannelAttachments
  , Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/codex.ts#createConfiguredCodexAdapter"
      createConfiguredCodexAdapter
  , Twin.traced "apps/core/src/harness/harness.ts#startRunRoot" startRunRoot
  , Twin.traced "apps/core/src/shared/skills.ts#validateSkillBundle" validateSkillBundle
  , Twin.traced "apps/core/src/harness/harness.ts#runCompactCommand" runCompactCommand
  , Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#prepareHarnessTurn" prepareHarnessTurn
  ]

end Spec.Agent.Waveagent4b
