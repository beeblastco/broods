import Spec.Twin
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto
import Spec.Access.Twins.Keys

/-!
Twins for the functions listed in `.lake/worklist/assign4/access4a.tsv`.
-/

namespace Spec.Access.Waveaccess4a

open Lean Spec Js

private def field (v : Json) (k : String) : Json := (prop v k).getD Twin.undefinedJson

private def fnJson (name : String) : Json := Json.mkObj [("$fn", .str name)]

private def intOf : Json → Option Int
  | .num n => if n.exponent == 0 then some n.mantissa else none
  | _ => none

private def intJson (value : Int) : Json := .num { mantissa := value, exponent := 0 }

/-- The recorded entry for `key` in a `Map` the recorder wrote as `{"$map": [[key, value], ...]}`. -/
private def mapGet (map : Json) (key : Json) : Option Json :=
  match field map "$map" with
  | .arr pairs =>
    (pairs.toList.find? fun pair => Twin.arg pair 0 == key).map fun pair => Twin.arg pair 1
  | _ => none

/-- A rate-limit window and the limiter's settings, as integers. -/
private structure Window where
  start : Int
  count : Int
  limit : Int
  windowMs : Int

private def windowOf (call : Json) : Option (Option Window) :=
  let self := Twin.self call
  match intOf (Twin.field self "#limit"), intOf (Twin.field self "#windowMs") with
  | some limit, some windowMs =>
    match mapGet (Twin.field self "#windows") (Twin.callArg call 0) with
    | none => some none
    | some window =>
      match intOf (field window "start"), intOf (field window "count") with
      | some start, some count =>
        some (some { start := start, count := count, limit := limit, windowMs := windowMs })
      | _, _ => none
  | _, _ => none

private def windowMissing : Prog Json := Prog.unsupported "rate-limit window is not integers"

private def clock : Prog Int := do
  match intOf (← Prog.effect "Date.now") with
  | some now => pure now
  | none => Prog.unsupported "clock is not an integer"

/-- `RateLimiter.allow`: a missing or finished window starts over and always admits. -/
private def rateAllow (call : Json) : Prog Json := do
  let now ← clock
  let self := Twin.self call
  let key := Twin.callArg call 0
  let old := (field (Twin.field self "#windows") "$map").getArr?.toOption.getD #[] |>.toList
  let some current := windowOf call | windowMissing
  let reset := current.all (fun w => now - w.start >= w.windowMs)
  let nextWindow := match current with
    | some w => if reset then Json.mkObj [("start", intJson now), ("count", intJson 1)]
      else Json.mkObj [("start", intJson w.start), ("count", intJson (w.count + 1))]
    | none => Json.mkObj [("start", intJson now), ("count", intJson 1)]
  let old ← if reset && old.length > 10000 then do
      let _ ← Prog.effect "this.#removeExpiredWindows" [intJson now]
      let duration := (intOf (Twin.field self "#windowMs")).getD 0
      pure (old.filter fun pair => now - (intOf (field (Twin.arg pair 1) "start")).getD 0 < duration)
    else pure old
  let pair := toJson [key, nextWindow]
  let next := if old.any (fun entry => Twin.arg entry 0 == key) then
      old.map (fun entry => if Twin.arg entry 0 == key then pair else entry)
    else old ++ [pair]
  Prog.setState "self.#windows" (Json.mkObj [("$map", toJson next)])
  return .bool (current.all fun w => reset || w.count + 1 <= w.limit)

/-- `RateLimiter.blocked`: reads the clock only when the key has a window. -/
private def rateBlocked (call : Json) : Prog Json := do
  match windowOf call with
  | none => windowMissing
  | some none => pure (.bool false)
  | some (some w) =>
    let now ← clock
    if now - w.start >= w.windowMs then pure (.bool false)
    else pure (.bool (w.count >= w.limit))

/-- `RateLimiter.retryAfterSeconds`: whole seconds left, rounded up. -/
private def rateRetryAfter (call : Json) : Prog Json := do
  match windowOf call with
  | none => windowMissing
  | some none => pure (intJson 0)
  | some (some w) =>
    let now ← clock
    let remaining := w.windowMs - (now - w.start)
    pure (intJson (if remaining > 0 then (remaining + 999) / 1000 else 0))

/-- `MACHINE_MAX_FRAME_BYTES` in `apps/core/src/shared/machine-socket.ts:45`. -/
private def machineMaxFrameBytes : Int := 4 * 1024 * 1024

/-- `createGateway`: the runtime it hands to `Bun.serve`, sized from the config's limits. -/
private def createGateway (call : Json) : Prog Json := do
  let limits := field (Twin.callArg call 0) "limits"
  match intOf (field limits "maxPayloadBytes") with
  | none => Prog.unsupported "maxPayloadBytes is not an integer"
  | some maxPayload =>
    pure <| Json.mkObj
      [("closeSockets", fnJson "closeSockets"),
       ("fetch", fnJson "handleRequest"),
       ("websocket", Json.mkObj
         [("maxPayloadLength", intJson (max maxPayload machineMaxFrameBytes)),
          ("backpressureLimit", field limits "backpressureBytes"),
          ("closeOnBackpressureLimit", .bool true),
          ("idleTimeout", field limits "idleTimeoutSeconds"),
          ("open", fnJson "open"),
          ("message", fnJson "message"),
          ("close", fnJson "close")])]

/-- A plain `Error` as the recorder writes it, class name included. -/
private def plainError (message : String) : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("$class", .str "Error"), ("name", .str "Error"), ("message", .str message),
     ("fields", Json.mkObj [])])]

/-- `createSubagentTaskId`, with the nonce after its `crypto.randomUUID()` default ran. -/
private def createSubagentTaskId (call : Json) : Prog Json := do
  let parent := Twin.callArg call 0
  let scope ← Prog.effect "parseAccountAgentScopedKey" [parent]
  if !truthy scope then
    throw (plainError "Subagent parent event must be account and agent scoped")
  match parent, Twin.param call 1 with
  | .str text, .str nonce =>
    if !Keys.isUuid nonce then
      throw (plainError "Subagent task nonce must be a UUID")
    pure (.str ("subagent~" ++ Crypto.base64UrlEncode (Crypto.utf8 text) ++ "~" ++ nonce))
  | _, _ => Prog.unsupported "parent or nonce is not a string"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/gateway/src/rate-limiter.ts#RateLimiter.allow" rateAllow,
   Twin.traced "apps/gateway/src/rate-limiter.ts#RateLimiter.blocked" rateBlocked,
   Twin.traced "apps/gateway/src/rate-limiter.ts#RateLimiter.retryAfterSeconds" rateRetryAfter,
   Twin.traced "apps/gateway/src/main.ts#createGateway" createGateway,
   Twin.traced "apps/core/src/shared/runtime-keys.ts#createSubagentTaskId" createSubagentTaskId]

end Spec.Access.Waveaccess4a
