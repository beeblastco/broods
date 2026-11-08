import Spec.Channels.Twins.Wavechannels1.Base
import Spec.Channels.Twins.Wavechannels8a

namespace Spec.Channels.Wavechannels1.Socket

open Lean Spec Spec.Channels.Wavechannels1.Base Spec.Channels.Wavechannels8a

private def socketSource (name : String) : String :=
  "apps/discord-forwarder/src/socket.ts#GatewaySocket." ++ name

private def logSource (name : String) : String :=
  "apps/discord-forwarder/src/log.ts#" ++ name

private def gatewayUrl : String := "wss://gateway.discord.gg"

/-- A live timer is recorded as its opaque handle; a cleared one is `null`. -/
private def timerSet (self : Json) (name : String) : Bool :=
  !nullish (Twin.field self name)

private def timer : Json :=
  Json.mkObj [("$opaque", toJson "Timeout"), ("$fields", Json.mkObj [])]

private def jsonKey (key : String) : String := (toJson key).compress

private def orderedObject (keys : List String) (value : Json) (render : String → Json → String) :
    String :=
  let present := keys.filter fun key => !missing (get value key)
  "{" ++ ",".intercalate (present.map fun key =>
    jsonKey key ++ ":" ++ render key (get value key)) ++ "}"

/-- `JSON.stringify` of a gateway payload, in the key order its object literals are written. -/
private def stringifyPayload (payload : Json) : String :=
  let properties := fun (value : Json) =>
    orderedObject ["os", "browser", "device"] value fun _ item => item.compress
  let body := fun (value : Json) =>
    match value with
    | .obj _ =>
      orderedObject ["token", "intents", "properties", "session_id", "seq"] value fun key item =>
        if key == "properties" then properties item else item.compress
    | other => other.compress
  orderedObject ["op", "d"] payload fun key item => if key == "d" then body item else item.compress

private def clearTimers (call : Json) : Prog Json := do
  let self := Twin.self call
  if timerSet self "connectTimer" then let _ ← Prog.effect "clearTimeout" [timer]
  if timerSet self "heartbeatTimer" then let _ ← Prog.effect "clearInterval" [timer]
  if timerSet self "reconnectTimer" then let _ ← Prog.effect "clearTimeout" [timer]
  for name in ["connectTimer", "heartbeatTimer", "reconnectTimer"] do
    stateChange ("self." ++ name) (Twin.field self name) .null
  return undef

private def markReady (call : Json) : Prog Json := do
  let self := Twin.self call
  if timerSet self "connectTimer" then let _ ← Prog.effect "clearTimeout" [timer]
  stateChange "self.connectTimer" (Twin.field self "connectTimer") .null
  stateChange "self.attempt" (Twin.field self "attempt") (num 0)
  stateChange "self.state" (Twin.field self "state") (.str "ready")
  return undef

private def send (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  if Twin.field socket "readyState" == num 1 then
    let _ ← Prog.effect "socket.send" [.str (stringifyPayload (Twin.callArg call 1))]
  return undef

private def start (call : Json) : Prog Json := do
  if Twin.field (Twin.self call) "state" == .str "stopped" then
    let _ ← Prog.effect "this.dial"
  return undef

private def stop (call : Json) : Prog Json := do
  let _ ← Prog.effect "this.clearTimers"
  let self := Twin.self call
  if Twin.field self "socket" != .null then
    let _ ← Prog.effect "socket?.close" [num 1000, .str "forwarder shutting down"]
  socketFields self [("state", .str "stopped"), ("socket", .null)]
  return undef

private def abandon (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let reason := Twin.callArg call 1
  let minDelay := Twin.callArg call 2
  let _ ← Prog.effect "socket.close" [num 4000, reason]
  let _ ← Prog.effect "this.handleClose"
    [socket, num 4000, reason, if missing minDelay then num 0 else minDelay]
  return undef

private def dial (call : Json) : Prog Json := do
  let self := Twin.self call
  if Twin.field self "state" == .str "stopped" then return undef
  let stored := Twin.field self "resumeUrl"
  let resume ←
    if jsTruthy (Twin.field self "sessionId") && jsTruthy stored then
      Prog.effect "resumeGatewayUrl" [stored]
    else pure .null
  if !jsTruthy resume then
    let reserved ← Prog.effect "this.reserveIdentify"
    if !jsTruthy reserved then return undef
  let base := if nullish resume then gatewayUrl else text resume
  let socket ← Prog.effect "new WebSocket" [.str (base ++ "/?v=10&encoding=json")]
  let _ ← Prog.effect "socket.addEventListener" [.str "message", fnJson]
  let _ ← Prog.effect "socket.addEventListener" [.str "close", fnJson]
  let _ ← Prog.effect "socket.addEventListener" [.str "error", fnJson]
  let deadline ← Prog.effect "setTimeout" [fnJson, num 30000]
  socketFields self [("state", .str "connecting"), ("socket", socket),
    ("connectTimer", deadline)]
  return undef

private def heartbeat (call : Json) : Prog Json := do
  let self := Twin.self call
  let socket := Twin.callArg call 0
  if Twin.field self "awaitingAck" == .bool true then
    let _ ← Prog.effect "this.abandon" [socket, .str "heartbeat not acknowledged"]
    return undef
  let _ ← Prog.effect "this.send"
    [socket, Json.mkObj [("op", num 1), ("d", Twin.field self "sequence")]]
  stateChange "self.awaitingAck" (Twin.field self "awaitingAck") (.bool true)
  return undef

private def helloPath (self socket payload : Json) (resuming : Bool) : Prog Json := do
  let interval ← Prog.effect "heartbeatIntervalMs" [get (get payload "d") "heartbeat_interval"]
  if timerSet self "heartbeatTimer" then let _ ← Prog.effect "clearInterval" [timer]
  let random ← Prog.effect "Math.random"
  let heartbeatTimer ← Prog.effect "setTimeout" [fnJson, .num (mulNum (asNum interval) (asNum random))]
  let body ← Prog.effect (if resuming then "this.resumePayload" else "this.identifyPayload")
  let _ ← Prog.effect "this.send" [socket, body]
  socketFields self [("heartbeatTimer", heartbeatTimer), ("awaitingAck", .bool false)]
  return undef

private def invalidSession (self socket payload : Json) : Prog Json := do
  if get payload "d" != .bool true then let _ ← Prog.effect "this.forgetSession"
  let random ← Prog.effect "Math.random"
  let delay := addNum 1000 (mulNum (asNum random) 4000)
  let _ ← Prog.effect "this.abandon" [socket, .str "gateway invalidated the session", .num delay]
  return undef

private def dispatch (self payload : Json) : Prog Json := do
  let kind := get payload "t"
  let data := get payload "d"
  if kind == .str "READY" then
    let resume ← Prog.effect "resumeGatewayUrl" [get data "resume_gateway_url"]
    let _ ← Prog.effect "this.markReady"
      [.str "Discord gateway ready", get (get data "user") "username"]
    socketFields self [("botIdentity", get (get data "user") "id"),
      ("resumeUrl", resume), ("sessionId", get data "session_id")]
  else if kind == .str "RESUMED" then
    let _ ← Prog.effect "this.markReady" [.str "Discord gateway resumed"]
  else if kind == .str "MESSAGE_CREATE" then
    let _ ← Prog.effect "this.options.onMessageCreate" [data]
  return undef

/-- A recording cannot show which socket `this.socket` is, only whether one is set. -/
private def handlePayload (call : Json) : Prog Json := do
  let self := Twin.self call
  let socket := Twin.callArg call 0
  if Twin.field self "socket" == .null then return undef
  match Json.parse (text (Twin.callArg call 2)) with
  | .error _ => Prog.unsupported "a frame that is not JSON"
  | .ok payload =>
    let sequence := match get payload "s" with
      | .num n => Json.num n
      | _ => Twin.field self "sequence"
    let op := get payload "op"
    if !(op == num 9 && get payload "d" != .bool true) then
      stateChange "self.sequence" (Twin.field self "sequence") sequence
    if op == num 10 then
      helloPath self socket payload (Twin.callArg call 1 == .bool true)
    else if op == num 1 then
      let _ ← Prog.effect "this.send" [socket, Json.mkObj [("op", num 1), ("d", sequence)]]
      stateChange "self.awaitingAck" (Twin.field self "awaitingAck") (.bool true)
      return undef
    else if op == num 11 then
      stateChange "self.awaitingAck" (Twin.field self "awaitingAck") (.bool false)
      return undef
    else if op == num 7 then
      let _ ← Prog.effect "this.abandon" [socket, .str "gateway asked for a reconnect"]
      return undef
    else if op == num 9 then invalidSession self socket payload
    else dispatch self payload

private def logAt (level : String) (call : Json) : Prog Json := do
  let fields := Twin.callArg call 1
  let _ ← Prog.effect "emit"
    [.str level, Twin.callArg call 0, if missing fields then Json.mkObj [] else fields]
  return undef

/-- This file's twins. -/
def twins : List Twin :=
  [Twin.traced (socketSource "clearTimers") clearTimers,
   Twin.traced (socketSource "markReady") markReady,
   Twin.traced (socketSource "forgetSession") (fun call => do
     for name in ["resumeUrl", "sequence", "sessionId"] do
       stateChange ("self." ++ name) (Twin.field (Twin.self call) name) .null
     return undef),
   Twin.traced (socketSource "send") send,
   Twin.traced (socketSource "start") start,
   Twin.traced (socketSource "stop") stop,
   Twin.traced (socketSource "abandon") abandon,
   Twin.traced (socketSource "dial") dial,
   Twin.traced (socketSource "heartbeat") heartbeat,
   Twin.traced (socketSource "handlePayload") handlePayload,
   Twin.traced (logSource "emit") (fun _ => pure undef),
   Twin.traced (logSource "logError") (logAt "error"),
   Twin.traced (logSource "logInfo") (logAt "info"),
   Twin.traced (logSource "logWarn") (logAt "warn")]

end Spec.Channels.Wavechannels1.Socket
