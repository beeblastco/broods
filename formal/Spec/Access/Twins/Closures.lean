import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of closures that outlive their maker in core's router and the gateway. See `AUTHORING.md`.
-/

namespace Spec.Access.Closures

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

/-- A property of a plain record or of a recorded class instance. -/
private def prop (value : Json) (key : String) : Json :=
  match (value.getObjVal? "$fields").toOption with
  | some fields => field fields key
  | none => field value key

private def text (value : Json) : String := value.getStr?.toOption.getD ""
private def named (name : String) : Json := Json.mkObj [("$fn", toJson name)]

/-- An object literal. The recorder drops `undefined` values from plain objects. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => entry.2 != Twin.undefinedJson)

/-- The path of a request URL, `new URL(url).pathname`, for `scheme://host[/path][?query]`. -/
private def pathname (url : String) : String :=
  let rest := (url.splitOn "://").getLast?.getD url
  let afterHost := String.ofList (rest.toList.dropWhile (· != '/'))
  let path := String.ofList (afterHost.toList.takeWhile fun c => c != '?' && c != '#')
  if path.isEmpty then "/" else path

/-- `request.headers.get(name)`: the value or null, names compared in lower case. -/
private def headerValue (request : Json) (name : String) : Json :=
  let headers := field (field request "$request") "headers"
  match headers with
  | .arr pairs =>
    match pairs.toList.find? (fun pair => (text (Twin.arg pair 0)).toLower == name) with
    | some pair => Twin.arg pair 1
    | none => Json.null
  | _ => Json.null

/-- `createRoute`'s returned handler: health check, then media, account and harness routes. -/
def createRouteReturn (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let method := field (field request "$request") "method"
  let url := text (field (field request "$request") "url")
  let path := pathname url
  if path == "/healthz" && method == toJson "GET" then
    let id ← Prog.effect "resolveRequestId" [headerValue request "x-request-id"]
    let health := Json.mkObj [("$response", Json.mkObj
      [("status", toJson 200),
       ("headers", toJson [toJson ["content-type", "application/json;charset=utf-8"]]),
       ("body", toJson "{\"status\":\"ok\"}")])]
    return ← Prog.effect "withRequestId" [health, id]
  let coreRequest ← Prog.effect "toCoreRequest"
    [request, Json.mkObj [("$url", toJson url)], Twin.callArg call 1]
  let requestId ← Prog.effect "resolveRequestId"
    [field (field coreRequest "headers") "x-request-id"]
  let now ← Prog.effect "Date.now" []
  let deadline := match now, Twin.moduleValue call "requestBudgetMs" with
    | .num a, .num b => Access.Js.floatJson (Access.Js.numFloat a + Access.Js.numFloat b)
    | _, _ => Json.null
  let context := Json.mkObj [("requestId", requestId), ("deadlineMs", deadline),
    ("waitUntil", named "waitUntil")]
  Prog.catchFail
    (do
      let toMedia ← Prog.effect "handlers.routesToMedia" [method, toJson path]
      let response ← if toMedia == toJson true then
          Prog.effect "handlers.handleMediaRequest" [coreRequest]
        else
          let toAccount ← Prog.effect "routesToAccountManage" [method, toJson path]
          if toAccount == toJson true then Prog.effect "handlers.accountHandler" [coreRequest]
          else Prog.effect "handlers.harnessHandler" [coreRequest, context]
      Prog.effect "withRequestId" [response, requestId])
    (fun error =>
      if error.getObjVal? "$unsupported" |>.toOption |>.isSome then Prog.fail error
      else do
        let failure ← Prog.effect "errorResponse" [toJson 500, toJson "Internal server error"]
        Prog.effect "withRequestId" [failure, requestId])

/-- `watchObservabilityLifetime`'s timer: revalidates the socket's token, closing it on a refusal. -/
def lifetimeTick (call : Json) : Prog Json := do
  let socket := Twin.moduleValue call "socket"
  let base := Twin.moduleValue call "coreBaseUrl"
  let expired ← Prog.effect "closeIfExpired" [socket]
  if expired == toJson true then return Twin.undefinedJson
  let resolved ← Prog.effect "resolveSocketScope"
    [toJson "observability", prop (prop socket "data") "token", base]
  let known ← Prog.effect "obsState.has" [socket]
  if known != toJson true then return Twin.undefinedJson
  let lapsed ← Prog.effect "closeIfExpired" [socket]
  if lapsed == toJson true then return Twin.undefinedJson
  if field resolved "kind" == toJson "invalid" then
    let revoked := Twin.moduleValue call "OBS_REVOKED_CLOSE"
    let _ ← Prog.effect "socket.close" [field revoked "code", field revoked "reason"]
    return Twin.undefinedJson
  let _ ← Prog.effect "watchObservabilityLifetime" [socket, base]
  return Twin.undefinedJson

/-- The gateway's `open`: tracks the socket and starts what its kind needs. -/
def gatewayOpen (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let sockets := Twin.moduleValue call "sockets"
  let known := ((field sockets "$set").getArr?.toOption.getD #[]).toList
  if !known.contains socket then
    Prog.setState "module.sockets" (Json.mkObj [("$set", .arr (known ++ [socket]).toArray)])
  let kind := prop (prop socket "data") "kind"
  if kind == toJson "observability" then
    let _ ← Prog.effect "openObservabilitySocket" [socket]
    let _ ← Prog.effect "watchObservabilityLifetime"
      [socket, field (Twin.moduleValue call "config") "coreBaseUrl"]
  if kind == toJson "terminal" || kind == toJson "machine" then
    let _ ← Prog.effect "openTerminalUpstream" [socket]
  if kind == toJson "agent-test" then
    let _ ← Prog.effect "watchUserTokenLifetime" [socket]
  return Twin.undefinedJson

/-- The gateway's `message`: too big closes the socket, otherwise the kind's handler gets it. -/
def gatewayMessage (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let raw := Twin.callArg call 1
  let config := Twin.moduleValue call "config"
  let kind := prop (prop socket "data") "kind"
  let limit := field (field config "limits") "maxPayloadBytes"
  let tooBig := match raw, limit with
    | .str message, .num cap => Access.Js.numFloat (Access.Js.natNum message.utf8ByteSize) >
        Access.Js.numFloat cap
    | _, _ => false
  if kind != toJson "machine" && tooBig then
    let _ ← Prog.effect "socket.close" [toJson 1009, toJson "message too big"]
    return Twin.undefinedJson
  if kind == toJson "terminal" || kind == toJson "machine" then
    let _ ← Prog.effect "relayTerminalInput" [socket, raw]
    return Twin.undefinedJson
  if kind == toJson "observability" then
    let _ ← Prog.effect "handleObservabilityMessage" [socket, raw, named "getNatsConnection"]
    return Twin.undefinedJson
  let _ ← Prog.effect "handleAgentMessage"
    [socket, raw, field config "limits", named "getNatsConnection"]
  return Twin.undefinedJson

/-- The gateway's `close`: forgets the socket and cleans up what its kind opened. -/
def gatewayClose (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let sockets := Twin.moduleValue call "sockets"
  let known := ((field sockets "$set").getArr?.toOption.getD #[]).toList
  if known.contains socket then
    Prog.setState "module.sockets"
      (Json.mkObj [("$set", .arr (known.filter (· != socket)).toArray)])
  let kind := prop (prop socket "data") "kind"
  if kind == toJson "terminal" || kind == toJson "machine" then
    let _ ← Prog.effect "cleanupTerminalSocket" [socket]
  else if kind == toJson "observability" then
    let _ ← Prog.effect "cleanupObservabilitySocket" [socket]
  else
    let _ ← Prog.effect "cleanupAgentSocket" [socket]
  return Twin.undefinedJson

/-- The `connection`, `jetstream` and `kv` calls `bucket` makes, ending in the spent-ticket bucket. -/
private def spentBucket : Prog Json := do
  let _ ← Prog.effect "connection" []
  let _ ← Prog.effect "(await connection()).jetstream" []
  Prog.effect "(await connection()).jetstream().views.kv"
    [toJson "TERMINAL_TICKETS_SPENT",
     Json.mkObj [("history", toJson 1), ("storage", toJson "file"), ("ttl", toJson 120000)]]

/-- Whether a thrown error is a NATS error saying the key already exists (`KV_KEY_EXISTS`). -/
private def keyExists (error : Json) : Bool :=
  let body := field error "$error"
  let isNats := field body "$class" == toJson "NatsError" || field body "$class" == toJson "NatsTcpError"
  isNats && field (field (field body "fields") "api_error") "err_code" == toJson 10071

/-- `natsSpentTickets`'s `spend`: true for the first spender of a ticket, false for a later one. -/
def spendTicket (call : Json) : Prog Json :=
  Prog.catchFail
    (do
      let _ ← spentBucket
      let key ← Prog.effect "spentTicketKey" [Twin.callArg call 0]
      let _ ← Prog.effect "(await bucket()).create" [key, Json.mkObj [("$bytes", toJson "")]]
      return toJson true)
    (fun error => if keyExists error then pure (toJson false) else Prog.fail error)

/-- `natsSpentTickets`'s `release`: deletes the ticket's spent mark. -/
def releaseTicket (call : Json) : Prog Json := do
  let _ ← spentBucket
  let key ← Prog.effect "spentTicketKey" [Twin.callArg call 0]
  let _ ← Prog.effect "(await bucket()).delete" [key]
  return Twin.undefinedJson

/-- `startSandboxLogPoll`'s `unsubscribe`: stops the poll and clears its timer. -/
def stopLogPoll (call : Json) : Prog Json := do
  Prog.setChanged "module.stopped" (Twin.moduleValue call "stopped") (toJson true)
  let _ ← Prog.effect "clearInterval" [Twin.moduleValue call "timer"]
  return Twin.undefinedJson

/-- `startLiveSubscription`'s `unsubscribe`: stops the NATS message stream. -/
def stopLiveStream (_call : Json) : Prog Json := do
  let _ ← Prog.effect "messages.stop" []
  return Twin.undefinedJson

/-- `watchUserTokenLifetime`'s timer: closes the socket when the user token has expired. -/
def userTokenExpired (call : Json) : Prog Json := do
  let closing := Twin.moduleValue call "USER_TOKEN_EXPIRED_CLOSE"
  let _ ← Prog.effect "socket.close" [field closing "code", field closing "reason"]
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/server.ts#createRoute/return" createRouteReturn,
   Twin.traced "apps/gateway/src/observability.ts#watchObservabilityLifetime/arg0" lifetimeTick,
   Twin.traced "apps/gateway/src/main.ts#createGateway/open" gatewayOpen,
   Twin.traced "apps/gateway/src/main.ts#createGateway/message" gatewayMessage,
   Twin.traced "apps/gateway/src/main.ts#createGateway/close" gatewayClose,
   Twin.traced "apps/gateway/src/terminal.ts#natsSpentTickets/spend" spendTicket,
   Twin.traced "apps/gateway/src/terminal.ts#natsSpentTickets/release" releaseTicket,
   Twin.traced "apps/gateway/src/observability.ts#startSandboxLogPoll/unsubscribe" stopLogPoll,
   Twin.traced "apps/gateway/src/observability.ts#startLiveSubscription/unsubscribe" stopLiveStream,
   Twin.traced "apps/gateway/src/agent.ts#watchUserTokenLifetime/arg0" userTokenExpired]

end Spec.Access.Closures
