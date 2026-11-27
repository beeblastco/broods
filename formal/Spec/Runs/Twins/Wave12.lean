import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of the connection and subject helpers in `apps/core/src/shared/nats.ts`, recorded under
`replay/extra/core/runs13-nats.test.ts`.
-/

namespace Spec.Runs.Wave12

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def text (value : Json) : String := value.getStr?.toOption.getD ""

private def undef (value : Json) : Bool := value == Twin.undefinedJson

private def truthy (value : Json) : Bool := !undef value && Access.Js.truthy value

/-- An object literal whose `undefined` properties are absent, as the recorder writes it. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

/-- `value?.trim()`, with an absent value reading as empty. -/
private def trimmed (value : Json) : String := Access.Js.trim (text value)

/-- `/^wss?:\/\//i`. -/
private def isWebSocketUrl (url : String) : Bool :=
  let lower := url.toLower
  Access.Js.startsWith lower "ws://" || Access.Js.startsWith lower "wss://"

/-- `value ?? fallback`. -/
private def orElse (value fallback : Json) : Json :=
  if undef value || value == Json.null then fallback else value

/-- The body `logsSubject` and `tracesSubject` share: the stage is encoded, the endpoint is not. -/
private def endpointSubject (kind : String) (call : Json) : Prog Json := do
  let token ← Prog.effect "subjectToken" [Twin.callArg call 2]
  let account := text (Twin.callArg call 0)
  let project := text (Twin.callArg call 1)
  let endpoint := text (Twin.callArg call 3)
  return .str s!"v1.{account}.{project}.{text token}.{kind}.{endpoint}"

/-- `connectNats`: a `ws://` or `wss://` url goes through nats.ws, any other over tcp. -/
def connectNats (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let reconnect := field options "maxReconnectAttempts"
  let connectOptions := obj
    [("servers", field options "servers"), ("token", field options "token"),
     ("timeout", orElse (field options "timeout") (toJson (5000 : Nat))),
     ("maxReconnectAttempts", reconnect)]
  if isWebSocketUrl (text (field options "servers")) then
    Prog.effect "connectWebSocket" [connectOptions]
  else
    Prog.effect "connectTcp" [connectOptions]

/-- `conversationLastSequence`: the sequence of the newest message on the conversation's subject,
null when any step fails. -/
def conversationLastSequence (call : Json) : Prog Json :=
  let options := Twin.callArg call 0
  Prog.catchFail
    (do
      let _ ← Prog.effect "jetstreamManagerFor" [field options "connection"]
      let subject ← Prog.effect "streamResponseSubject"
        [field options "accountId", field options "agentId", field options "conversationKey"]
      let message ← Prog.effect "jsm.streams.getMessage"
        [toJson "WS_RESPONSES", obj [("last_by_subj", subject)]]
      return field message "seq")
    (fun _ => pure Json.null)

/-- `flushObservabilityNats`: flushes the shared connection if there is one, ignoring a failure. -/
def flushObservabilityNats (call : Json) : Prog Json := do
  if !truthy (Twin.moduleValue call "_natsConn") then
    return Twin.undefinedJson
  let _ ← Prog.attempt "_natsConn.flush"
  return Twin.undefinedJson

/-- `getSharedNatsConn`: nothing without `NATS_URL`, the open connection when there is one, else one
dial that is remembered once it succeeds. A caller that arrives mid-dial shares the pending promise,
which the recordings do not settle apart from the dialler's, so it opts out. -/
def getSharedNatsConn (call : Json) : Prog Json := do
  let url := trimmed (Twin.env call "NATS_URL")
  if url.isEmpty then
    return Json.null
  let token := trimmed (Twin.env call "NATS_TOKEN")
  let open_ := Twin.moduleValue call "_natsConn"
  if truthy open_ then
    return open_
  if truthy (Twin.moduleValue call "_natsConnPromise") then
    Prog.unsupported "another caller is already dialling"
  let connection ← Prog.effect "connectNats"
    [obj [("servers", toJson url),
          ("token", if token.isEmpty then Twin.undefinedJson else toJson token),
          ("timeout", toJson (3000 : Nat)), ("maxReconnectAttempts", toJson (-1 : Int))]]
  Prog.spawn "connection.closed"
  Prog.setState "module._natsConn" connection
  return connection

/-- `logsSubject`. -/
def logsSubject (call : Json) : Prog Json := endpointSubject "logs" call

/-- `retainedMessageSubject`: the subject of the message at a sequence, null once it is evicted. -/
def retainedMessageSubject (call : Json) : Prog Json :=
  Prog.catchFail
    (do
      let _ ← Prog.effect "jetstreamManagerFor" [Twin.callArg call 0]
      let message ← Prog.effect "jsm.streams.getMessage"
        [toJson "WS_RESPONSES", obj [("seq", Twin.callArg call 1)]]
      return field message "subject")
    (fun _ => pure Json.null)

/-- `tracesSubject`. -/
def tracesSubject (call : Json) : Prog Json := endpointSubject "traces" call

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/shared/nats.ts#connectNats" connectNats,
   Twin.traced "apps/core/src/shared/nats.ts#conversationLastSequence" conversationLastSequence,
   Twin.traced "apps/core/src/shared/nats.ts#flushObservabilityNats" flushObservabilityNats,
   Twin.traced "apps/core/src/shared/nats.ts#getSharedNatsConn" getSharedNatsConn,
   Twin.traced "apps/core/src/shared/nats.ts#logsSubject" logsSubject,
   Twin.traced "apps/core/src/shared/nats.ts#retainedMessageSubject" retainedMessageSubject,
   Twin.traced "apps/core/src/shared/nats.ts#tracesSubject" tracesSubject]

end Spec.Runs.Wave12
