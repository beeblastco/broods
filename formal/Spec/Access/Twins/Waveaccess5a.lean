import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign5/access5a.tsv`.

`AbortSignal.aborted` is read from a closure and never recorded, so a path that branches on it is
out of the model. Signals handed to effects are expected to be live, and replay checks that.
-/

namespace Spec.Access.Waveaccess5a

open Lean Spec Js

private def field (value : Json) (key : String) : Json :=
  (prop value key).getD Twin.undefinedJson

private def isUndef (value : Json) : Bool := value == Twin.undefinedJson

private def truth (value : Json) : Bool := !isUndef value && truthy value

private def str (text : String) : Json := .str text

private def undefinedResult : Prog Json := pure Twin.undefinedJson

private def isUnsupported (error : Json) : Bool :=
  (error.getObjVal? "$unsupported").isOk

private def natOf : Json → Option Nat
  | .num number =>
    if number.exponent == 0 && number.mantissa >= 0 then some number.mantissa.toNat else none
  | _ => none

/-- `value ?? fallback`. -/
private def orElse (value fallback : Json) : Json :=
  if isUndef value || value == Json.null then fallback else value

/-- Spreads `key: value` only when `value` is truthy, as `...(value ? { key: value } : {})` does. -/
private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if truth value then [(key, value)] else []

private def liveSignal : Json := Json.mkObj [("$signal", .bool false)]

private def timerCallback : Json := Json.mkObj [("$fn", str "")]

private def abortController : Json :=
  Json.mkObj [("$opaque", str "AbortController"), ("$fields", Json.mkObj [])]

private def terminalStatus (status : Json) : Bool :=
  status == str "completed" || status == str "failed" || status == str "expired"

/-- Marks a failure that happened after the start timer fired, where `startTimedOut` was set. -/
private def timedOutError (error : Json) : Json :=
  Json.mkObj [("$startTimedOut", .bool true), ("error", error)]

private def isTimedOut (error : Json) : Bool :=
  (error.getObjVal? "$startTimedOut").isOk

/-- The start timer's callback, if it ran while a request was in flight: it aborts the run.
The recording orders it before the request's own settlement. -/
private def timerFired : Prog Bool :=
  .input fun
    | none => pure false
    | some _ => do
      let _ ← Prog.effect "abort.abort"
      pure true

private def corePost (socket headers body : Json) : Prog Json := do
  let data := field socket "data"
  let url := match field data "coreBaseUrl", field data "corePath" with
    | .str base, .str path => base ++ path
    | _, _ => ""
  let fired ← timerFired
  let outcome ← Prog.attempt "fetch"
    [str url, Json.mkObj
      [("method", str "POST"), ("headers", headers), ("body", body), ("signal", liveSignal)]]
  match outcome with
  | .ok response => pure response
  | .threw error _ => Prog.fail (if fired then timedOutError error else error)
  | .pending => Prog.unsupported "the request never settled"

private def responseOk (response : Json) : Bool :=
  match natOf (field (field response "$response") "status") with
  | some status => 200 <= status && status <= 299
  | none => false

/-- `response.headers.get("content-type")`, whose names the recorder writes in lower case. -/
private def contentType (response : Json) : String :=
  let headers := match field (field response "$response") "headers" with
    | .arr items => items.toList
    | _ => []
  let found := headers.find? fun pair => Twin.arg pair 0 == str "content-type"
  match found.map (Twin.arg · 1) with
  | some (.str value) => value
  | _ => ""

private def sendFrame (socket : Json) (frame : List (String × Json)) : Prog Unit := do
  let _ ← Prog.effect "sendAgentTest" [socket, Json.mkObj frame]

private def sendError (socket : Json) (message : String) : Prog Unit :=
  sendFrame socket [("type", str "error"), ("error", str message)]

/-- The part of `runCoreStream` after the run is registered, up to its `catch`. -/
private def startRun (socket : Json) (body : Json) (active scope : Json)
    (getNats : Prog Json) : Prog Unit := do
  let connection ← getNats
  let snapshot ← Prog.effect "conversationReplaySnapshot"
    [Json.mkObj (("connection", connection) :: entries scope)]
  let headers ← Prog.effect "coreHeaders" [socket]
  let response ← corePost socket headers (str (Twin.jsonStringify 64 body))
  if !responseOk response then
    let _ ← Prog.effect "clearTimeout" [field active "startTimeout"]
    let text ← Prog.effect "responseErrorText" [response]
    sendFrame socket
      [("type", str "error"), ("status", field (field response "$response") "status"),
       ("error", text)]
    return
  if !includes (contentType response) "application/json" then
    sendError socket "Core WebSocket start did not return JSON"
    return
  let payload ← Prog.effect "response.json"
  let _ ← Prog.effect "clearTimeout" [field active "startTimeout"]
  let eventId := field payload "eventId"
  let status := field payload "status"
  let validStatus ←
    if truth eventId then
      pure (truth (← Prog.effect "isIngressStatus" [status]))
    else
      pure false
  if !validStatus then
    sendError socket "Core did not return a WebSocket stream or ingress status"
    return
  let nats := field payload "nats"
  let direct := truth nats
  if !direct then
    sendFrame socket
      ([("type", str "ack"), ("requestId", eventId), ("eventId", eventId), ("status", status)] ++
        whenTruthy "statusUrl" (field payload "statusUrl"))
    if terminalStatus status then
      let _ ← Prog.effect "sendTerminalFrame" [socket, str "Queued", status]
      return
  let eventKey ← Prog.effect "cursorEventKey" [eventId]
  let lastSequence ← match natOf (field snapshot "lastSequence") with
    | some value => pure value
    | none => Prog.unsupported "a replay snapshot with no sequence"
  let _ ← Prog.drain
    (fun label _ => if label == "isReplay" then pure () else Prog.unsupported s!"callback {label}") 4096
  let _ ← Prog.effect "followExecution"
    [socket, liveSignal, Json.mkObj
      ([("connection", connection),
        ("scope", orElse nats scope),
        ("eventId", eventId),
        ("eventKey", eventKey),
        ("snapshot", snapshot),
        ("startSequence", toJson (lastSequence + 1)),
        ("initialConsumedSequence", toJson lastSequence),
        ("isReplay", Json.mkObj [("$fn", str "isReplay")]),
        ("statusRequestId", eventId),
        ("seedStatus", if direct then payload else Json.null),
        ("terminalLabel", str (if direct then "Direct" else "Queued"))] ++
        whenTruthy "runId" (field payload "runId") ++
        whenTruthy "statusUrl" (field payload "statusUrl"))]

/-- `runCoreStream`. Its `catch` reads the abort signal once; a timer that fired mid-request means a
start timeout. Only a timer firing during the POST is modelled: one that fires later, while the
response is read or the stream is followed, is a call this twin does not match. -/
private def runCoreStream (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let message := Twin.callArg call 1
  let built ← Prog.attempt "buildCoreRunBody" [message]
  match built with
  | .threw error _ =>
    let text ← Prog.effect "errorMessage" [error]
    let _ ← Prog.effect "sendAgentTest" [socket, Json.mkObj [("type", str "error"), ("error", text)]]
    undefinedResult
  | .pending => Prog.unsupported "an unfinished body"
  | .ok body =>
    let timer ← Prog.effect "setTimeout"
      [timerCallback, field (Twin.callArg call 2) "runStartTimeoutMs"]
    let conversationKey ← Prog.effect "userScoped" [socket, field body "conversationKey"]
    let eventId ← Prog.effect "userScoped" [socket, field body "eventId"]
    let agentId := field body "agentId"
    let active := Json.mkObj
      [("abort", abortController), ("startTimeout", timer), ("agentId", agentId),
       ("publicConversationKey", conversationKey), ("publicEventId", eventId),
       ("controls", toJson (0 : Nat))]
    let _ ← Prog.effect "activeRuns.set" [socket, active]
    sendFrame socket [("type", str "meta"), ("sessionId", conversationKey), ("taskId", eventId)]
    let scope := Json.mkObj
      [("accountId", field (field socket "data") "accountId"), ("agentId", agentId),
       ("conversationKey", conversationKey)]
    let run := startRun socket body active scope (Prog.effect "getNatsConnection")
    Prog.catchFail run fun error =>
      if isUnsupported error then .fail error
      else if !Twin.abortedRead call 0 then do
        let text ← Prog.effect "errorMessage" [error]
        sendFrame socket [("type", str "error"), ("error", text)]
      else if isTimedOut error then sendError socket "Run start timed out"
      else pure ()
    let _ ← Prog.effect "stopActiveRun" [socket, active]
    undefinedResult

/-- The JSON text of the control POST, in the order `submitControl` writes its keys. -/
private def controlBody (active message uuid events : Json) : String :=
  let mode := field message "mode"
  let keys := ["agentId", "eventId", "conversationKey", "connectionId", "events"] ++
    (if isUndef mode then [] else ["mode"]) ++ ["idempotencyKey"]
  Twin.jsonStringify 64 <| Json.mkObj
    ([("$keys", toJson keys),
      ("agentId", field active "agentId"),
      ("eventId", field message "eventId"),
      ("conversationKey", field active "publicConversationKey"),
      ("connectionId", str ("ws-" ++ match uuid with | .str text => text | _ => "")),
      ("events", events),
      ("idempotencyKey", orElse (field message "idempotencyKey") (field message "eventId"))] ++
      (if isUndef mode then [] else [("mode", mode)]))

private def withControls (active : Json) (count : Nat) : Json :=
  Json.mkObj ((entries active).filter (·.1 != "controls") ++ [("controls", toJson count)])

private def controlSteps (socket active message : Json) (controls : Nat) : Prog Unit := do
  let headers ← Prog.effect "coreHeaders" [socket]
  let uuid ← Prog.effect "crypto.randomUUID"
  let events ← Prog.effect "resolveRunEvents" [message]
  let response ← corePost socket headers (str (controlBody active message uuid events))
  let payload ← Prog.effect "responseJson" [response]
  let httpStatus := field (field response "$response") "status"
  let requestId := field message "requestId"
  let eventId := field payload "eventId"
  let status := field payload "status"
  let accepted ←
    if httpStatus == toJson (202 : Nat) && truth eventId then
      pure (truth (← Prog.effect "isIngressStatus" [status]))
    else
      pure false
  if !accepted then
    let reason ← Prog.effect "errorText" [field payload "error"]
    let fallback := s!"Control input was rejected with HTTP {httpStatus.compress}"
    sendFrame socket
      [("type", str "status"), ("requestId", requestId), ("eventId", field message "eventId"),
       ("status", orElse status (str "not_found")), ("error", orElse reason (str fallback))]
    return
  sendFrame socket
    ([("type", str "ack"), ("requestId", requestId), ("eventId", eventId), ("status", status)] ++
      whenTruthy "statusUrl" (field payload "statusUrl"))
  let _ ← Prog.effect "pollControlStatus"
    [socket, withControls active controls, requestId, eventId, field payload "runId",
     field payload "statusUrl"]

/-- `submitControl`. Like `runCoreStream`, its `catch` depends on the unrecorded abort state. -/
private def submitControl (call : Json) : Prog Json := do
  let active := Twin.callArg call 1
  let controls := (natOf (field active "controls")).getD 0 + 1
  let steps := controlSteps (Twin.callArg call 0) active (Twin.callArg call 2) controls
  Prog.catchFail steps fun error =>
    if isUnsupported error then .fail error
    else Prog.unsupported "the catch branches on abort.signal.aborted, which is not recorded"
  undefinedResult

/-- The most sleeps one recorded poll takes. The TypeScript loop runs until the run ends. -/
private def maxPollSleeps : Nat := 256

private def controlPollDone (status : Json) : Prog Bool := do
  if status == str "not_found" || status == str "applied" then
    return true
  let known ← Prog.effect "isIngressStatus" [status]
  return truth known && terminalStatus status

/-- The `while` of `pollControlStatus`, for as long as the abort signal stays clear. -/
private def pollLoop (socket requestId eventId runId statusUrl : Json) :
    Nat → String → Nat → Nat → Prog Unit
  | 0, _, _, _ => Prog.unsupported "more polls than the model allows"
  | fuel + 1, previous, gap, nextPollAt => do
    let again := pollLoop socket requestId eventId runId statusUrl fuel
    let _ ← Prog.effect "Bun.sleep" [toJson (500 : Nat)]
    let now := (natOf (← Prog.effect "Date.now")).getD 0
    if now < nextPollAt then
      return ← again previous gap nextPollAt
    let widened := min (gap * 2) 2000
    let stamp := (natOf (← Prog.effect "Date.now")).getD 0
    let next := stamp + widened
    let answer ← Prog.attempt "fetchStatus" [socket, runId, liveSignal, statusUrl]
    let payload := match answer with
      | .ok value => value
      | _ => Json.null
    let status := field payload "status"
    if !truth status then
      return ← again previous widened next
    let statusError ← Prog.effect "errorText" [field payload "error"]
    let fingerprint ← Prog.effect "statusFingerprint" [payload]
    let printed := match fingerprint with
      | .str text => text
      | other => other.compress
    if printed != previous then
      sendFrame socket
        ([("type", str "status"), ("requestId", requestId), ("eventId", eventId),
          ("status", status)] ++
          whenTruthy "requestedMode" (field payload "requestedMode") ++
          whenTruthy "appliedMode" (field payload "appliedMode") ++
          whenTruthy "appliedToEventId" (field payload "appliedToEventId") ++
          whenTruthy "statusUrl" statusUrl ++
          whenTruthy "error" statusError)
    if ← controlPollDone status then
      return
    again printed widened next

/-- `pollControlStatus`. The signal must stay clear while it polls: replay catches it if not. -/
private def pollControlStatus (call : Json) : Prog Json := do
  pollLoop (Twin.callArg call 0) (Twin.callArg call 2) (Twin.callArg call 3)
    (Twin.callArg call 4) (Twin.callArg call 5) maxPollSleeps "" 500 0
  undefinedResult

/-- `auditedSandboxCall` around one executor method, then the callback it enters. -/
private def auditedVerb (context : Json) (label : String) : Prog Unit := do
  let _ ← Prog.drain (fun _ _ => pure ()) 1
  let _ ← Prog.attempt label [field context "ref"]
  let outer ← Prog.attempt "auditedSandboxCall" [context, Json.mkObj [("$fn", str "")]]
  match outer with
  | .ok _ => pure ()
  | .threw error _ => Prog.fail error
  | .pending => Prog.unsupported "audited call never settled"

/-- `suspendOrResumeSandbox`. -/
private def suspendOrResumeSandbox (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let action := Twin.callArg call 1
  let suspending := action == str "suspend"
  let executor := field context "executor"
  if !truth (field executor (if suspending then "suspend" else "resume")) then
    return ← Prog.effect "unsupportedSandboxAction" [context, action]
  auditedVerb context
    (if suspending then "context.executor.suspend" else "context.executor.resume")
  let status := str (if suspending then "suspended" else "running")
  let _ ← Prog.effect "queueMirrorStatus" [context, status]
  let _ ← Prog.effect "context.audit" [str "ok", Json.mkObj [("status", status)]]
  Prog.effect "jsonResponse" [toJson (200 : Nat), Json.mkObj [("status", status)]]

/-- `lambdaBaseImage`: the image, else a pinned snapshot's own, but only from this account. -/
private def lambdaBaseImage (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let config := field context "config"
  let image := field config "image"
  if truth image then
    return image
  let snapshot := field config "snapshot"
  let pinned ←
    if truth snapshot then
      Prog.effect "findSandboxSnapshot" [field context "accountId", snapshot]
    else
      pure Json.null
  if field pinned "accountId" == field context "accountId" then
    return field pinned "baseImage"
  return str "default"

private def agent (name : String) : String := "apps/gateway/src/agent.ts#" ++ name

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (agent "runCoreStream") runCoreStream,
   Twin.traced (agent "submitControl") submitControl,
   Twin.traced (agent "pollControlStatus") pollControlStatus,
   Twin.traced "apps/core/src/accounts/handler.ts#suspendOrResumeSandbox" suspendOrResumeSandbox,
   Twin.traced "apps/core/src/accounts/handler.ts#lambdaBaseImage" lambdaBaseImage]

end Spec.Access.Waveaccess5a
