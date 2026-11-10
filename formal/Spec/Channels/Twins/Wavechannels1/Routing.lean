import Spec.Channels.Twins.Wavechannels8a
import Spec.Channels.Twins.Wavechannels1.Base

namespace Spec.Channels.Wavechannels1.Routing

open Lean Spec Spec.Channels.Wavechannels1.Base

private def integrations (name : String) : String := "apps/core/src/harness/integrations.ts#" ++ name

private def candidateLimit : Nat := 25

private def kind (name : String) : Json := Json.mkObj [("kind", .str name)]

private def toResponse (call : Json) : Prog Json := do
  let response := Twin.callArg call 0
  let status := get response "statusCode"
  let supplied := get response "headers"
  let pairs := if missing supplied then [] else entries supplied
  let headers := jarr (pairs.map fun (name, value) => jarr [.str name.toLower, value])
  let body := get response "body"
  return Json.mkObj [("$response", Json.mkObj
    [("status", if nullish status then num 200 else status), ("headers", headers),
     ("body", if nullish body then .str "" else body)])]

private def drainList (context accountId endpointId : Json) : Nat → Prog Unit
  | 0 => pure ()
  | fuel + 1 =>
    .input fun
      | none => pure ()
      | some (_, _) => do
        let _ ← listerCall context accountId endpointId
        drainList context accountId endpointId fuel
where
  /-- A failing lister is attempted, not required: the cached lookup it ran under reports the error. -/
  listerCall (context accountId endpointId : Json) : Prog Unit := do
    let _ ←
      if jsTruthy endpointId then Prog.attempt "context.stageAgentLister" [accountId, endpointId]
      else Prog.attempt "context.agentLister" [accountId]
    pure ()

private def listNow (context accountId endpointId : Json) : Prog Json :=
  .input fun
    | none => Prog.unsupported "the list callback did not run"
    | some (_, _) =>
      if jsTruthy endpointId then Prog.effect "context.stageAgentLister" [accountId, endpointId]
      else Prog.effect "context.agentLister" [accountId]

private def listWebhookAgents (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let accountId := Twin.callArg call 1
  let endpointId := Twin.callArg call 2
  if jsTruthy (Twin.callArg call 3) || !jsTruthy (get context "cacheAgentLists") then
    return ← listNow context accountId endpointId
  let key ← Prog.effect "channelAgentListKey" [accountId, endpointId]
  drainList context accountId endpointId 2
  let cached ← Prog.attempt "cachedChannelAgentList" [key, fnJson "list"]
  match cached with
  | .ok value => return value
  | .threw error _ => Prog.fail error
  | .pending => Prog.unsupported "an unfinished cached list"

/-- `webhookChannels.find`: stops at the first channel of this name that can handle the request. -/
private def findAdapter (name request : Json) : List Json → Prog (Option Json)
  | [] => pure none
  | head :: rest => do
    if get head "name" != name then return ← findAdapter name request rest
    let handles ← Prog.effect "channel.canHandle" [request]
    if jsTruthy handles then return some head
    findAdapter name request rest

private def sortKey (agent : Json) : String := text (get agent "agentId")

private def insertAgent (item : Json) : List Json → List Json
  | [] => [item]
  | head :: rest =>
    if sortKey item < sortKey head then item :: head :: rest else head :: insertAgent item rest

private def configured (agent name : Json) : Bool :=
  jsTruthy (get (get (get agent "config") "channels") (text name))

private def receiver (agent adapter : Json) : Json :=
  Json.mkObj [("agent", agent), ("adapter", adapter)]

private structure Scan where
  candidates : List Json := []
  configured : Bool := false

private def collect (name request : Json) : Scan → List Json → Prog Scan
  | state, [] => pure state
  | state, agent :: rest => do
    if !configured agent name then return ← collect name request state rest
    let registry ← Prog.effect "createChannelRegistry" [get agent "config"]
    match ← findAdapter name request (items (get registry "webhookChannels")) with
    | none => collect name request { state with configured := true } rest
    | some adapter =>
      if state.candidates.length ≥ candidateLimit then
        return { state with configured := true }
      collect name request
        { configured := true, candidates := state.candidates ++ [receiver agent adapter] } rest

private def authenticated (request : Json) : List Json → Prog (List Json)
  | [] => pure []
  | head :: rest => do
    let adapter := get head "adapter"
    let ok ← Prog.effect "candidate.adapter.authenticate" [request]
    if !jsTruthy ok then return ← authenticated request rest
    if !jsTruthy (get adapter "routesEachEntry") then return [head]
    return head :: (← authenticated request rest)

private def scanHolder (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let accountId := Twin.callArg call 1
  let name := Twin.callArg call 2
  let request := Twin.callArg call 3
  let endpointId := Twin.callArg call 4
  let listedOutcome ← Prog.attempt "listWebhookAgents" [context, accountId, endpointId]
  let listed ← match listedOutcome with
    | .ok value => pure (some value)
    | .threw _ _ => pure none
    | .pending => Prog.unsupported "an unfinished agent list"
  match listed with
  | none => return kind "unavailable"
  | some agents =>
    if jsTruthy endpointId && (items agents).isEmpty then return kind "unknown-stage"
    let sorted := (items agents).foldl (fun acc item => insertAgent item acc) []
    let scan ← collect name request {} sorted
    let receivers ← authenticated request scan.candidates
    if !receivers.isEmpty then
      if jsTruthy (get context "cacheAgentLists") then
        return ← Prog.effect "reverifyReceivers"
          [context,
           Json.mkObj ([("accountId", accountId), ("channelName", name)] ++
             if missing endpointId then [] else [("endpointId", endpointId)]),
           request, jarr receivers]
      return Json.mkObj [("kind", .str "holder"), ("receivers", jarr receivers)]
    if !scan.candidates.isEmpty then return kind "unverified"
    return Json.mkObj [("kind", .str "unconfigured"), ("configured", .bool scan.configured)]

private def findHolder (call : Json) : Prog Json := do
  let args := [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2, Twin.callArg call 3,
    Twin.callArg call 4]
  let holder ← Prog.effect "scanChannelCredentialHolder" args
  let holderKind := get holder "kind"
  if !jsTruthy (get (Twin.callArg call 0) "cacheAgentLists") || holderKind == .str "holder" ||
      holderKind == .str "unavailable" then
    return holder
  let key ← Prog.effect "channelAgentListKey" [Twin.callArg call 1, Twin.callArg call 4]
  let dropped ← Prog.effect "dropAgedChannelAgentList" [key]
  if !jsTruthy dropped then return holder
  Prog.effect "scanChannelCredentialHolder" args

/-- Later duplicates win, as they do in the `Map` built from the list. -/
private def lookup (listed : List Json) (agentId : Json) : Json :=
  (listed.reverse.find? fun agent => get agent "agentId" == agentId).getD undef

private def reverifyEach (listed : List Json) (name request : Json) :
    List Json → Prog (List Json)
  | [] => pure []
  | head :: rest => do
    let agent := lookup listed (get (get head "agent") "agentId")
    if !configured agent name then return ← reverifyEach listed name request rest
    let registry ← Prog.effect "createChannelRegistry" [get agent "config"]
    match ← findAdapter name request (items (get registry "webhookChannels")) with
    | none => reverifyEach listed name request rest
    | some adapter =>
      let ok ← Prog.effect "adapter.authenticate" [request]
      let tail ← reverifyEach listed name request rest
      return if jsTruthy ok then receiver agent adapter :: tail else tail

private def reverifyReceivers (call : Json) : Prog Json := do
  let route := Twin.callArg call 1
  Prog.catchFail
    (do
      let listed ← Prog.effect "listWebhookAgents"
        [Twin.callArg call 0, get route "accountId", get route "endpointId", .bool true]
      let current ← reverifyEach (items listed) (get route "channelName") (Twin.callArg call 2)
        (items (Twin.callArg call 3))
      return if current.isEmpty then kind "unverified"
        else Json.mkObj [("kind", .str "holder"), ("receivers", jarr current)])
    (fun _ => pure (kind "unavailable"))

private def refuseInvoke (call : Json) : Prog Json := do
  let policy ← Prog.effect "channelPolicyIdentity" [Twin.callArg call 4]
  let decision ← Prog.effect "evaluateChannelInvoke"
    [Twin.callArg call 0,
     spread (Json.mkObj [("accountId", get (Twin.callArg call 1) "accountId"),
       ("agentId", Twin.callArg call 2), ("channel", Twin.callArg call 3)]) policy]
  if !jsTruthy decision || jsTruthy (get decision "allowed") then return .null
  return get decision "reason"

private def sendReply (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let name := get options "channelName"
  let registry ← Prog.effect "createChannelRegistry" [get options "config"]
  let adapter := (items (get registry "webhookChannels")).find? fun channel => get channel "name" == name
  if adapter.isNone then
    return ← Prog.throwError "Error" s!"Channel {text name} is not configured for this agent"
  let hooks ← Prog.effect "createAgentHookDispatcher" [get options "accountId", get options "config"]
  let reply ← Prog.effect "applyMessageSendingHook" [hooks, name, get options "text"]
  if reply == .null then return undef
  let _ ← Prog.effect "adapter.actions" [Json.mkObj
    [("eventId", .str ""), ("conversationKey", .str ""), ("channelName", name), ("content", reply),
     ("source", get options "source")]]
  let _ ← Prog.effect "adapter.actions(message).sendText" [reply]
  return undef

private def listRunnable (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let _ ← Prog.effect "getStorage"
  let accountId := get (get auth "account") "accountId"
  if get auth "kind" == .str "account" then
    return ← Prog.effect "agents.listForAccount" [accountId]
  if get auth "kind" != .str "deployment" then return Json.arr #[]
  let ticket := jsTruthy (get auth "stageTicket")
  let user := get auth "user"
  if !ticket && !missing (get user "conversations") then return Json.arr #[]
  let stage ← Prog.effect "agents.listForEndpoint" [accountId, get auth "endpointId"]
  if ticket then return stage
  return jarr ((items stage).filter fun agent =>
    get (get agent "config") "publicAccess" == .bool true &&
    (get agent "requireUserToken" != .bool true || !missing user))

/-- `parsed.attachments` is an array the recorder drops, so a message carrying any is not modelled. -/
private def parseMetaEvent (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let found := Twin.callArg call 1
  let event := get found "event"
  let senderId := get (get event "sender") "id"
  let recipient := get found "recipientId"
  let channels ← Prog.effect "isAllowedId" [get options "allowedChannelIds", senderId]
  if !jsTruthy channels then
    return Json.mkObj [("kind", .str "ignore"), ("reason", .str "not allowed")]
  let users ← Prog.effect "isAllowedId" [get options "allowedUserIds", senderId]
  if !jsTruthy users then
    return Json.mkObj [("kind", .str "ignore"), ("reason", .str "not allowed")]
  if !missing (get (get event "message") "attachments") then
    return ← Prog.unsupported "message attachments are not recorded on the parsed message"
  let parsed ← Prog.effect "options.transport.parseMessage" [event]
  let attachments ← Prog.effect "urlAttachments" [Json.arr #[]]
  let body := Twin.field parsed "text"
  if jsTrim (text body) == "" && (items attachments).isEmpty then
    return Json.mkObj [("kind", .str "ignore"), ("reason", .str "empty message")]
  let idPrefix := text (get options "prefix")
  let id := Twin.field parsed "id"
  return Json.mkObj [("kind", .str "message"), ("redelivers", .bool true), ("message", Json.mkObj (
    [("eventId", .str (idPrefix ++ text senderId ++ ":" ++ text id)),
     ("conversationKey", .str (idPrefix ++ text recipient ++ ":" ++ text senderId)),
     ("channelName", get options "name"), ("content", body)] ++
    (if (items attachments).isEmpty then [] else [("attachments", attachments)]) ++
    [("identity", Json.mkObj [("workspaceRef", recipient), ("channelId", senderId),
       ("userId", senderId)]),
     ("source", Json.mkObj [("messageId", id), ("recipientId", recipient), ("senderId", senderId),
       ("threadId", Twin.field parsed "threadId")])]))]

private def recordSchema : Json := Json.mkObj [("$opaque", toJson "ZodMiniRecord")]

private def isString (value : Json) : Bool := (str? value).isSome

private def nonBlank (value : Json) : Bool := isString value && jsTrim (text value) != ""

/-- The final object once every check has passed. -/
private def directResult (account agent conversation events answers overrides config : Json)
    (eventId rawEventId runId background continuation mode idempotency connection : Json) : Json :=
  let model := get overrides "model"
  let system := get overrides "system"
  spread
    (Json.mkObj
      ([("accountId", get account "accountId"), ("agentId", get agent "agentId"),
        ("agentConfig", config),
        ("configRef", Json.mkObj (if missing model then [] else [("model", model)])),
        ("eventId", eventId), ("publicEventId", rawEventId), ("runId", runId)]))
    (spread conversation (Json.mkObj
      ([("events", events), ("background", background), ("continuation", continuation),
        ("requestedMode", mode), ("idempotencyKey", idempotency)] ++
       (if jsTruthy connection then [("connectionId", connection)] else []) ++
       (if jsTruthy system then [("ephemeralSystem", system)] else []) ++
       (if (items answers).isEmpty then [] else [("answers", answers)]))))

private def loadAgent (context accountId agentId deploymentAuth : Json) : Prog (Json × Json) := do
  let loaders : List (String × List Json) :=
    [("context.agentLoader", [accountId, agentId])] ++
    (if jsTruthy deploymentAuth then [("context.deploymentLoader", [accountId, agentId])] else [])
  let outcomes ← Prog.all loaders
  let unwrap := fun (outcome : Outcome) =>
    match outcome with
    | .ok value => (pure value : Prog Json)
    | .threw error _ => Prog.fail error
    | .pending => Prog.unsupported "an unfinished loader"
  match outcomes with
  | [agent] => return (← unwrap agent, .null)
  | [agent, deployment] =>
    let loaded ← unwrap agent
    return (loaded, ← unwrap deployment)
  | _ => Prog.unsupported "unexpected loader outcomes"

private def finishDirect (record headers account agent : Json) (embeddable : Bool)
    (rawEventId conversation background continuation : Json) : Prog Json := do
  let events ← Prog.effect "parseDirectIngressEvents" [record]
  let answers ← Prog.effect "parseDirectQuestionAnswers" [get record "answers"]
  if !missing (get record "webhookUrl") || !missing (get headers "x-webhook-secret") then
    return ← Prog.throwError "Error"
      "Per-request webhook callbacks are no longer supported; configure config.hooks.webhook on the agent"
  let overrides ← Prog.effect "parseRunOverrides" [record]
  let _ ← Prog.effect "assertRunOverridesAllowed" [.bool embeddable, agent, overrides, events]
  let _ ← Prog.effect "assertOneDirectPayloadShape" [continuation, Json.mkObj
    [("eventCount", num (items events).length), ("answerCount", num (items answers).length),
     ("hasOverrides", .bool (!missing overrides))]]
  let connection := get record "connectionId"
  let trimmedConnection := if nonBlank connection then Json.str (jsTrim (text connection)) else undef
  let parsedMode ← Prog.effect "parseIngressMode" [get record "mode"]
  let mode := if nullish parsedMode then Json.str "steer" else parsedMode
  let rawKey := get record "idempotencyKey"
  if !missing rawKey && !isString rawKey then
    return ← Prog.throwError "Error" "idempotencyKey must be a string"
  let idempotency ←
    if missing rawKey then pure rawEventId
    else Prog.effect "normalizeDirectIdentifier" [.str "idempotencyKey", rawKey]
  let runtime ← Prog.effect "toRuntimeAgentConfig" [get agent "config"]
  let config ← Prog.effect "applyRunOverrides" [runtime, overrides]
  let eventId ← Prog.effect "scopedDirectEventId"
    [get account "accountId", get agent "agentId", rawEventId]
  let runId ← Prog.effect "createRunId"
  return directResult account agent conversation events answers overrides config eventId rawEventId
    runId background continuation mode idempotency trimmedConnection

private def parseDirectPayload (call : Json) : Prog Json := do
  let headers := Twin.callArg call 1
  let account := Twin.callArg call 2
  let context := Twin.callArg call 3
  let deploymentAuth := Twin.callArg call 4
  match Json.parse (text (Twin.callArg call 0)) with
  | .error _ => Prog.unsupported "the error text of an invalid JSON body comes from the engine"
  | .ok parsed =>
    let record ← Prog.effect "parseOr" [recordSchema, parsed]
    if !jsTruthy record then
      return ← Prog.throwError "Error" "Request body must be a JSON object"
    if !isString (get record "eventId") || !isString (get record "conversationKey") then
      return ← Prog.throwError "Error" "Request body must include eventId and conversationKey"
    let background ← Prog.effect "parseBooleanField" [get record "background", .str "background"]
    let continuation ← Prog.effect "parseBooleanField" [get record "continue", .str "continue"]
    if !nonBlank (get record "agentId") then
      return ← Prog.throwError "Error" "Request body must include agentId"
    let agentId ← Prog.effect "normalizeDirectIdentifier" [.str "agentId", get record "agentId"]
    let (agent, deployment) ← loadAgent context (get account "accountId") agentId deploymentAuth
    if !jsTruthy agent then
      let error ← Prog.effect "new DirectNotFoundError" [.str "Agent not found"]
      return ← Prog.fail error
    let embeddable ← Prog.effect "admitStageCredential" [deploymentAuth, agent, deployment]
    let isEmbeddable := jsTruthy embeddable
    let user := if isEmbeddable then get deploymentAuth "user" else undef
    if isEmbeddable && !jsTruthy user && get agent "requireUserToken" == .bool true then
      let message ← Prog.effect "userTokenRequiredMessage" [get agent "agentId"]
      let error ← Prog.effect "new DirectForbiddenError"
        [message, Json.mkObj [("code", .str "user_token_required")]]
      return ← Prog.fail error
    let rawEventId ←
      if jsTruthy user then Prog.effect "userScopedEventId" [user, get record "eventId"]
      else Prog.effect "assertValidPublicEventId" [get record "eventId"]
    let scope := if isEmbeddable then
        Json.mkObj (if missing user then [] else [("user", user)])
      else .null
    let conversation ← Prog.effect "directConversationKeys"
      [get record "conversationKey", continuation, get account "accountId", get agent "agentId", scope]
    finishDirect record headers account agent isEmbeddable rawEventId conversation background
      continuation

/-- This file's twins. -/
def twins : List Twin :=
  [Twin.traced (integrations "createIncomingEventRouter") (fun _ => pure fnJson),
   Twin.traced (integrations "resetChannelAgentListsForTests") (fun call => do
     Spec.Channels.Wavechannels8a.stateChange "module.channelAgentLists"
       (Twin.moduleValue call "channelAgentLists")
       (Spec.Channels.Wavechannels8a.mapValue [])
     return undef),
   Twin.traced (integrations "toResponse") toResponse,
   Twin.traced (integrations "listWebhookAgents") listWebhookAgents,
   Twin.traced (integrations "scanChannelCredentialHolder") scanHolder,
   Twin.traced (integrations "findChannelCredentialHolder") findHolder,
   Twin.traced (integrations "reverifyReceivers") reverifyReceivers,
   Twin.traced (integrations "refuseChannelInvoke") refuseInvoke,
   Twin.traced (integrations "sendChannelReply") sendReply,
   Twin.traced (integrations "listRunnableAgents") listRunnable,
   Twin.traced (integrations "parseDirectPayload") parseDirectPayload,
   Twin.traced "apps/core/src/shared/meta-channel.ts#parseEvent" parseMetaEvent]

end Spec.Channels.Wavechannels1.Routing
