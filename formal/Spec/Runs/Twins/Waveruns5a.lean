import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign5/runs5a.tsv`.
-/

namespace Spec.Runs.Waveruns5a

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def truthy (value : Json) : Bool := !undef value && Access.Js.truthy value
private def nullish (value : Json) : Bool := undef value || value == Json.null
private def anon : Json := Json.mkObj [("$fn", .str "")]
private def named (name : String) : Json := Json.mkObj [("$fn", .str name)]
private def items (value : Json) : List Json := value.getArr?.toOption.getD #[] |>.toList

/-- An object literal. The recorder drops `undefined` values from plain objects. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

/-- `{...base, ...entries}`, leaving out the recorder's own bookkeeping keys. -/
private def spread (base : Json) (entries : List (String × Json)) : Json :=
  let source := if undef base then [] else Access.Js.entries base
  let kept := source.filter fun entry =>
    entry.1 != "$keys" && !entries.any (·.1 == entry.1)
  obj (kept ++ entries)

/-- `...(value ? { key: value } : {})`. -/
private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if truthy value then [(key, value)] else []

/-- `err instanceof Error ? err.message : fallback`. -/
private def errorMessageOr (error : Json) (fallback : String) : String :=
  match ((error.getObjVal? "$error").toOption.bind fun inner =>
      (inner.getObjValAs? String "message").toOption) with
  | some message => message
  | none => fallback

private def response (status : Nat) (headers : List (String × String)) (body : Json) : Json :=
  Json.mkObj [("$response", Json.mkObj
    [("status", toJson status),
     ("headers", .arr (headers.map fun (name, value) =>
       Json.arr #[.str name, .str value]).toArray),
     ("body", body)])]

private def noContent : Json := response 204 [] Json.null

/-- `WORKER_QUEUE_FULL` in `worker-queue.ts`. -/
private def workerQueueFull : String := "In-process worker queue is full"

/-- `INGRESS_RETRY_HEADERS` in `ingress.ts`. -/
private def retryHeaders : Json := Json.mkObj [("Retry-After", .str "5")]

/-- The most callbacks one `routeIncomingEvent` call enters. -/
private def callbackLimit : Nat := 16

/-- The refusal `handleRequest` builds when a direct request finds the queue full. -/
private def directQueueFull (event : Json) : Prog Json :=
  if truthy (field event "connectionId") ||
      Access.Js.truthy (Json.num (items (field event "answers")).length) ||
      truthy (field event "continuation") then
    Prog.effect "errorResponse" [toJson (503 : Nat), .str workerQueueFull, Json.mkObj [], retryHeaders]
  else
    Prog.effect "errorSseResponse" [.str workerQueueFull, toJson (503 : Nat), retryHeaders]

/-- The refusal `handleRequest` builds when an async request finds the queue full. -/
private def asyncQueueFull : Prog Json :=
  Prog.effect "errorResponse" [toJson (503 : Nat), .str workerQueueFull, Json.mkObj [], retryHeaders]

/-- Waits for the outside to enter one named callback, then runs it. -/
private def whenEntered (expected : String) (body : Prog Unit) : Prog Unit :=
  .input fun
    | some (label, _) =>
      if label == expected then body else Prog.unsupported s!"callback {label}"
    | none => pure ()

/-- The body of the `handleDirectRequest` and `handleAsyncRequest` routes in `handleRequest`. -/
private def queuedRoute (handlerLabel : String) (event : Json) (full : Prog Json) : Prog Unit := do
  let placed ← Prog.effect "withQueuePlace" [anon]
  if nullish placed then
    let _ ← Prog.effect "queueFullResponse" [field event "accountId", anon]
    whenEntered "arg1" (do let _ ← full)
  else
    whenEntered "arg0" (do let _ ← Prog.effect handlerLabel [event])

/-- Runs one route callback. Its own failure goes back to `routeIncomingEvent`. -/
private def handleRouteCallback (label : String) (args : Json) : Prog Unit :=
  let event := Twin.arg args 0
  match label with
  | "handleDirectRequest" => queuedRoute "handleDirectRequest" event (directQueueFull event)
  | "handleAsyncRequest" => queuedRoute "handleAsyncRequest" event asyncQueueFull
  | other => Prog.unsupported s!"route callback {other}"

private def drainRoute : Nat → Prog Unit
  | 0 => pure ()
  | limit + 1 =>
    .input fun
      | none => pure ()
      | some (label, args) =>
        Prog.catchFail (handleRouteCallback label args) (fun _ => pure ()) |>.bind
          fun _ => drainRoute limit

/-- `handleRequest`: picks a worker, an internal path, an MCP path, or the public router. -/
def handleRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let context := Twin.callArg call 1
  if truthy (← Prog.effect "isAsyncWorkerInvocation" [event]) then
    let _ ← Prog.effect "handleAsyncWorkerRequest" [field event "event", context]
    return noContent
  if truthy (← Prog.effect "isNatsWorkerInvocation" [event]) then
    let _ ← Prog.effect "handleNatsWorkerRequest" [field event "event", context]
    return noContent
  if truthy (← Prog.effect "isCronInvocation" [event]) then
    let _ ← Prog.effect "handleScheduledCron" [event]
    return noContent
  let path := field event "path"
  if path == .str "/v1/cron-runs" then
    return ← Prog.effect "handleCronHttpRequest" [event]
  if path == .str "/v1/apply-runs" then
    return ← Prog.effect "handleApplyRunRequest" [event]
  if truthy (← Prog.effect "routesToMcpConnection" [path]) then
    return ← Prog.effect "handleMcpConnectionRequest" [event]
  if truthy (← Prog.effect "routesToProtectedResource" [← Prog.effect "normalizePath" [path]]) then
    return ← Prog.effect "handleProtectedResourceRequest"
  if (← Prog.effect "normalizePath" [path]) == .str "/mcp" then
    return ← Prog.effect "handleMcpRequest" [event, anon]
  Prog.effect "routeCoreRequest" [event, context]

/-- `routeCoreRequest`: hands the request to the public router with the route handlers. -/
def routeCoreRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let context := Twin.callArg call 1
  let authResolver := Twin.callArg call 2
  let waitUntil := field context "waitUntil"
  let bound ←
    if truthy waitUntil then
      pure [("waitUntil", ← Prog.effect "context.waitUntil.bind" [context])]
    else
      pure []
  let handlers := Json.mkObj
    [("handleDirectRequest", named "handleDirectRequest"),
     ("handleAsyncRequest", named "handleAsyncRequest"),
     ("handleStatusRequest", named "handleStatusRequest"),
     ("handleSandboxJobCompletionRequest", named "handleSandboxJobCompletionRequest"),
     ("handleChannelRequest", named "handleChannelRequest"),
     ("handleChannelContext", named "handleChannelContext")]
  let options := Json.mkObj
    ([("directApiEnabled", toJson true), ("cacheAgentLists", toJson true)] ++
      (if truthy authResolver then [("authResolver", anon)] else []) ++ bound)
  drainRoute callbackLimit
  let routed ← Prog.attempt "routeIncomingEvent" [event, handlers, options]
  match routed with
  | .ok value => pure value
  | .threw error _ => Prog.fail error
  | .pending => Prog.unsupported "route never finished"

/-- `handleScheduledCron`. A missing or paused job ends with no run. -/
def handleScheduledCron (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let _ ← Prog.effect "getStorage"
  let job ← Prog.effect "crons.getById" [field event "accountId", field event "cronId"]
  if !truthy job || field job "status" != .str "active" then
    return Json.null
  let firedAt ← Prog.effect "scheduledFireTime" [field event "scheduledTime"]
  let accountId := field job "accountId"
  let cronId := field job "cronId"
  let refusal := field (← Prog.effect "admitRun" [accountId]) "refusal"
  let removeIfOneShot : Prog Unit := do
    if truthy (← Prog.effect "isOneTimeSchedule" [field job "scheduleExpression"]) then
      let _ ← Prog.effect "removeOneShotCron" [accountId, cronId]
  if truthy refusal then
    let _ ← Prog.effect "crons.markFailed" [accountId, cronId, field refusal "message", firedAt]
    removeIfOneShot
    return refusal
  match ← Prog.attempt "startScheduledAgentRun" [job, firedAt] with
  | .ok _ => return Json.null
  | .threw error _ =>
    removeIfOneShot
    Prog.fail error
  | .pending => Prog.unsupported "scheduled run never finished"

private def utf8Bytes (text : String) : List Nat := text.toUTF8.toList.map UInt8.toNat

private def base64Alphabet : List Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList

/-- How the recorder carries a `Uint8Array`: standard padded base64. -/
private def base64Encode (bytes : List Nat) : String :=
  let sym (n : Nat) := base64Alphabet.getD (n % 64) 'A'
  let rec go : List Nat → List Char
    | [] => []
    | [a] => [sym (a / 4), sym (a % 4 * 16), '=', '=']
    | [a, b] => [sym (a / 4), sym (a % 4 * 16 + b / 16), sym (b % 16 * 4), '=']
    | a :: b :: c :: rest =>
      [sym (a / 4), sym (a % 4 * 16 + b / 16), sym (b % 16 * 4 + c / 64), sym c] ++ go rest
  String.ofList (go bytes)

/-- `SSE_KEEPALIVE_INTERVAL_MS` in `handler.ts`. -/
private def keepaliveMs : Nat := 30000

/-- `directTurnResponse`, up to handing the turn to the worker queue. -/
def directTurnResponse (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let generation := field event "ownerGeneration"
  let lease :=
    if undef generation then Twin.undefinedJson
    else Json.mkObj
      [("conversationKey", field event "conversationKey"),
       ("ownerEventId", field event "eventId"),
       ("ownerGeneration", generation)]
  whenEntered "start" (do
    let keepalive ← Prog.effect "setInterval" [anon, toJson keepaliveMs]
    match ← Prog.attempt "dispatchInProcessWorker" [.str "direct-sse", anon, lease] with
    | .ok _ => pure ()
    | .pending => Prog.unsupported "dispatch never finished"
    | .threw error _ =>
      let some message := ((field error "$error").getObjValAs? String "message").toOption
        | Prog.unsupported "a thrown non-Error"
      let _ ← Prog.effect "clearInterval" [keepalive]
      let errorFrame := "{\"type\":\"error\",\"error\":" ++ (Json.str message).compress ++ "}"
      let _ ← Prog.effect "controller.enqueue"
        [Json.mkObj [("$bytes", .str (base64Encode (utf8Bytes s!"data: {errorFrame}\n\n")))]]
      let _ ← Prog.effect "controller.close" []
      Prog.spawn "failOwnedIngress" [event, .str message])
  whenEntered "arg1" (whenEntered "arg0" (do
    let command ← Prog.effect "queuedCommand" [field event "events"]
    if !nullish command then
      return ← Prog.unsupported "a queued command ran before the response returned"
    Prog.spawn "prepareDirectTurn" [event]))
  let _ ← Prog.effect "new ReadableStream"
    [Json.mkObj [("start", named "start"), ("cancel", named "cancel")]]
  return response 200 [("content-type", "text/event-stream")]
    (Json.mkObj [("$opaque", "ReadableStream")])

/-- The channel reply a refused admission sends, or none. -/
private def refusalReply (outcome : Json) : Option String :=
  match outcome with
  | .str "rejected" =>
    some "Conversation is already processing another turn. Try again when the current turn finishes."
  | .str "capacity" => some "The conversation queue is full. Please try again later."
  | .str "conflict" => some "This message conflicts with an earlier delivery identity."
  | _ => none

/-- `NO_RUN_OUTCOMES` in `handler.ts`. -/
private def noRunOutcome (outcome : Json) : Bool :=
  [Json.str "duplicate", .str "rejected", .str "capacity", .str "conflict"].contains outcome

/-- The `reply` arm of `admitChannelMessage`: a command answered without a turn. -/
private def channelCommandReply (event token : Json) : Prog Json := do
  let accountId := field event "accountId"
  if truthy accountId then
    let session ← Prog.effect "new Session"
      [obj [("eventId", field event "eventId"),
            ("conversationKey", field event "conversationKey"),
            ("accountId", accountId)]]
    if !truthy (← Prog.effect "claimSession" [session]) then
      return Twin.undefinedJson
  let extracted ← Prog.effect "extractText" [field event "content"]
  let text ← Prog.effect "commandText" [token, extracted]
  let _ ← Prog.effect "executeCommand"
    [token,
     obj [("conversationKey", field event "conversationKey"),
          ("channel", field event "channel"),
          ("accountId", accountId),
          ("agentId", field event "agentId"),
          ("eventId", field event "eventId"),
          ("text", text)]]
  return Twin.undefinedJson

/-- Starts the admitted turn. A queue refusal settles the run and is raised again. -/
private def startChannelWorker (event scope session turnEvents generation : Json) : Prog Json := do
  let lease := Json.mkObj
    [("conversationKey", field event "conversationKey"),
     ("ownerEventId", field event "eventId"),
     ("ownerGeneration", generation)]
  match ← Prog.attempt "dispatchInProcessWorker" [.str "channel-worker", anon, lease] with
  | .ok _ =>
    .input fun
      | none => return Twin.undefinedJson
      | some ("arg1", args) => do
        whenEntered "arg0" (Prog.spawn "runChannelTurns"
          [event, scope, session, turnEvents, Twin.arg args 0])
        return Twin.undefinedJson
      | some (label, _) => Prog.unsupported s!"callback {label}"
  | .threw error _ =>
    let message := errorMessageOr error "Failed to start channel turn"
    let _ ← Prog.effect "settleFailedIngressAndDrain" [session, .str message, anon]
    Prog.fail error
  | .pending => Prog.unsupported "dispatch never finished"

/-- `admitChannelMessage`: everything from a channel message to a queued or started turn. -/
def admitChannelMessage (call : Json) : Prog Json := do
  let original := Twin.callArg call 0
  let outcome ← Prog.effect "resolveChannelCommand" [original]
  let kind := field outcome "kind"
  if kind == .str "reply" then
    return ← channelCommandReply original (field outcome "commandToken")
  let rewrite := kind == .str "rewrite"
  let event ←
    if rewrite then do
      let events ← Prog.effect "rewriteLatestUserIngressText"
        [field original "events", field outcome "text"]
      pure (spread original [("content", field outcome "text"), ("events", events)])
    else
      pure original
  let accountId := field event "accountId"
  let agentId := field event "agentId"
  if !truthy accountId || !truthy agentId then
    return ← Prog.throwError "Error" "Channel ingress requires account and agent scope"
  let channelName := field event "channelName"
  let eventId := field event "eventId"
  let conversationKey := field event "conversationKey"
  let identity := field event "identity"
  let source := field event "source"
  let channelTarget := field event "channelTarget"
  let command ← Prog.effect "queuedCommand" [field event "events", channelName]
  if !truthy command then
    if truthy (← Prog.effect "settleChannelQuestion" [event]) then
      return Twin.undefinedJson
  let requestedMode := if rewrite then field outcome "requestedMode" else .str "steer"
  let attachments := field event "attachments"
  if !(items attachments).isEmpty then
    let known ← Prog.effect "getIngressStatusByEventId"
      [obj [("accountId", accountId), ("agentId", agentId), ("eventId", eventId)]]
    if truthy known then
      return Twin.undefinedJson
  let plan ← Prog.effect "admitRun" [accountId, Json.mkObj [("claimWarning", toJson true)]]
  let refusal := field plan "refusal"
  if truthy refusal then
    let text ← Prog.effect "planRefusalText" [refusal]
    let _ ← Prog.effect "event.channel.sendText" [text]
    return Twin.undefinedJson
  let warning := field plan "warning"
  if truthy warning then
    let _ ← Prog.attempt "event.channel.sendText" [warning]
  let agentConfig :=
    if nullish (field event "agentConfig") then Json.mkObj [] else field event "agentConfig"
  let ingested ← Prog.effect "ingestChannelAttachments"
    [field event "events", attachments,
     obj [("accountId", accountId),
          ("agentId", agentId),
          ("agentConfig", agentConfig),
          ("channelName", channelName),
          ("conversationKey", conversationKey),
          ("eventId", eventId)]]
  let runId ← Prog.effect "createRunId"
  let admission ← Prog.effect "acceptIngress"
    [obj [("accountId", accountId),
          ("agentId", agentId),
          ("eventId", eventId),
          ("runId", runId),
          ("conversationKey", conversationKey),
          ("events", field ingested "events"),
          ("requestedMode", requestedMode),
          ("idempotencyKey", eventId),
          ("delivery", obj ([("kind", .str "channel"), ("channel", channelName)] ++
            whenTruthy "identity" identity ++ [("source", source)])),
          ("configRef", Json.mkObj
            [("channel", spread channelTarget [("channelName", channelName)])]),
          ("channelTarget", channelTarget)]]
  let publicKey ← Prog.effect "publicConversationKeyFromScoped" [conversationKey, accountId, agentId]
  let scope := obj
    [("accountId", accountId),
     ("agentId", agentId),
     ("conversationKey", conversationKey),
     ("publicConversationKey", publicKey),
     ("endpointId", field event "endpointId"),
     ("projectSlug", field event "projectSlug"),
     ("stageSlug", field event "stageSlug")]
  let _ ← Prog.effect "dispatchRecoveredIngress" [scope, admission]
  let verdict := field admission "outcome"
  if noRunOutcome verdict then
    let _ ← Prog.effect "refundRun" [plan, accountId]
  if let some text := refusalReply verdict then
    let _ ← Prog.effect "event.channel.sendText" [.str text]
    return Twin.undefinedJson
  if verdict == .str "queued" && truthy command then
    let token := (field command "commandToken").getStr?.toOption.getD ""
    let _ ← Prog.effect "event.channel.sendText"
      [.str s!"{token} queued. It runs when the current turn finishes."]
  if verdict == .str "duplicate" || verdict == .str "queued" then
    return Twin.undefinedJson
  let generation := field admission "ownerGeneration"
  if undef generation then
    return ← Prog.throwError "Error" "Channel admission did not return an owner generation"
  let chain ← Prog.effect "channelPrincipalChain" [identity, channelName]
  let principal ← Prog.effect "runPrincipal" [event, chain]
  let session ← Prog.effect "new Session"
    [obj [("eventId", eventId),
          ("conversationKey", conversationKey),
          ("accountId", accountId),
          ("agentId", agentId),
          ("agentConfig", agentConfig),
          ("delivery", obj ([("kind", .str "channel"), ("channelName", channelName)] ++
            whenTruthy "identity" identity ++ [("source", source)])),
          ("endpointId", field event "endpointId"),
          ("projectSlug", field event "projectSlug"),
          ("stageSlug", field event "stageSlug"),
          ("ownerGeneration", generation),
          ("channelActions", field event "channel"),
          ("principal", principal)]]
  startChannelWorker event scope session (field ingested "turnEvents") generation

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/handler.ts#handleRequest" handleRequest,
   Twin.traced "apps/core/src/harness/handler.ts#routeCoreRequest" routeCoreRequest,
   Twin.traced "apps/core/src/harness/handler.ts#handleScheduledCron" handleScheduledCron,
   Twin.traced "apps/core/src/harness/handler.ts#directTurnResponse" directTurnResponse,
   Twin.traced "apps/core/src/harness/handler.ts#admitChannelMessage" admitChannelMessage]

end Spec.Runs.Waveruns5a
