import Spec.Twin

/-!
Ninth-wave twins for the access subsystem's uncredited roots.
-/

namespace Spec.Access.Waveroots9access

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def isTruthy (value : Json) : Bool :=
  match value with
  | .null | .bool false | .str "" => false
  | .num number => number.mantissa != 0
  | other => other != Twin.undefinedJson

private def undefinedResult : Json := Twin.undefinedJson

/-- State as `cleanupObservabilityStream` leaves it: subscription gone, run counter bumped. -/
private def afterCleanup (state : Json) (stream : String) : Json :=
  let run := ((field (field state "runs") stream).getNat?).toOption.getD 0
  let cleared := state
    |>.setObjVal! "subs" ((field state "subs").setObjVal! stream Json.null)
    |>.setObjVal! "runs" ((field state "runs").setObjVal! stream (toJson (run + 1)))
  if stream == "logs" then cleared.setObjVal! "logsSandboxId" Json.null else cleared

private def isPositiveNumber (value : Json) : Bool :=
  match value with
  | .num number => number.mantissa > 0
  | _ => false

/-- `handleObservabilitySubscribe`. A null `live` is either NATS being unavailable or this run being
superseded during the await; `state.runs` at that moment is not recorded, so that case is not modelled. -/
def handleObservabilitySubscribe (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let scope := Twin.callArg call 1
  let streamJson := Twin.callArg call 2
  let backfill := Twin.callArg call 3
  let minLevel := Twin.callArg call 5
  let sandboxId := Twin.callArg call 7
  let stream := streamJson.getStr?.toOption.getD ""
  let ready := Json.mkObj [("type", toJson "ready")]
  let state ← Prog.effect "obsState.get" [socket]
  if !isTruthy state then
    return undefinedResult
  if isTruthy sandboxId && isTruthy (field (field state "subs") "logs") &&
      field state "logsSandboxId" == sandboxId && field state "logsMinLevel" == minLevel then
    let _ ← Prog.effect "sendObs" [socket, ready]
    return undefinedResult
  let _ ← Prog.effect "cleanupObservabilityStream" [socket, streamJson]
  let cleaned := afterCleanup state stream
  let run := field (field cleaned "runs") stream
  let current :=
    if stream == "logs" then
      (cleaned.setObjVal! "logsMinLevel" minLevel).setObjVal! "logsSandboxId"
        (if sandboxId == Twin.undefinedJson then Json.null else sandboxId)
    else cleaned
  let live ←
    if isTruthy sandboxId then
      Prog.effect "startSandboxLogPoll"
        [socket, scope, sandboxId, minLevel,
         if backfill == Twin.undefinedJson then toJson (0 : Nat) else backfill]
    else if Twin.callArg call 8 == toJson true then
      pure (Json.mkObj [("unsubscribe", Json.mkObj [("$fn", toJson "unsubscribe")])])
    else
      Prog.effect "startLiveSubscription"
        [socket, scope, streamJson, current, run, Twin.callArg call 4, Twin.callArg call 6]
  if !isTruthy live then
    return ← Prog.unsupported "a null subscription may mean superseded, which is not recorded"
  let _ ← Prog.effect "sendObs" [socket, ready]
  if !isTruthy sandboxId && isPositiveNumber backfill then
    Prog.spawn "sendBackfill" [socket, scope, streamJson, backfill, minLevel, run]
  return undefinedResult

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/gateway/src/observability.ts#handleObservabilitySubscribe"
    handleObservabilitySubscribe]

end Spec.Access.Waveroots9access
