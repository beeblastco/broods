import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign6/access6a.tsv`.
-/

namespace Spec.Access.Waveaccess6a

open Lean Spec Js

private def agent : String := "apps/gateway/src/agent.ts#"
private def observability : String := "apps/gateway/src/observability.ts#"
private def terminal : String := "apps/gateway/src/terminal.ts#"

private def undef : Json := Twin.undefinedJson

private def field (value : Json) (key : String) : Json :=
  (prop value key).getD undef

private def isUndef (value : Json) : Bool := value == undef

private def truth (value : Json) : Bool := !isUndef value && truthy value

private def str (text : String) : Json := .str text

private def fnRef (name : String) : Json := Json.mkObj [("$fn", str name)]

/-- A property of something that may be a recorded class instance, whose properties sit in `$fields`. -/
private def member (value : Json) (key : String) : Json :=
  if isUndef (field value "$opaque") then field value key else Twin.field value key

private def intOf (value : Json) : Option Int :=
  value.getInt?.toOption

/-- Keeps `key: value` only when `value` is not `undefined`, which the recorder drops from objects. -/
private def whenDefined (key : String) (value : Json) : List (String × Json) :=
  if isUndef value then [] else [(key, value)]

/-- `handleAgentMessage`: every run starts unawaited, so only its start is observable. -/
private def handleAgentMessage (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let raw := Twin.callArg call 1
  let limits := Twin.callArg call 2
  let getNats := Twin.callArg call 3
  let message ← Prog.effect "parseGatewayMessage" [raw]
  let sendError (text : String) : Prog Unit := do
    let _ ← Prog.effect "sendAgentTest"
      [socket, Json.mkObj [("type", str "error"), ("error", str text)]]
  if !truth message then
    sendError "Invalid WebSocket message"
    let _ ← Prog.effect "socket.close" [toJson (1003 : Nat), str "invalid message"]
    return undef
  let kind := field message "type"
  if kind == str "cancel" then
    let _ ← Prog.effect "stopActiveRun" [socket]
    return undef
  if kind == str "control" then
    let active ← Prog.effect "activeRuns.get" [socket]
    if !truth active then
      sendError "No active run to control"
      return undef
    if ((intOf (field active "controls")).getD 0) >= 8 then
      let _ ← Prog.effect "sendAgentTest"
        [socket, Json.mkObj
          (whenDefined "requestId" (field message "requestId") ++
           whenDefined "eventId" (field message "eventId") ++
           [("type", str "status"), ("status", str "failed"),
            ("error", str "Too many control inputs in flight on this WebSocket (max 8)")])]
      return undef
    Prog.spawn "submitControl" [socket, active, message]
    return undef
  if truth (← Prog.effect "activeRuns.has" [socket]) then
    sendError "A run is already active on this WebSocket"
    return undef
  if kind == str "attach" then
    Prog.spawn "attachCoreStream" [socket, message, limits, getNats]
    return undef
  Prog.spawn "runCoreStream" [socket, message, limits, getNats]
  return undef

/-- The first timer tick is all a call can show; the tick itself runs later, outside it. -/
private def watchObservabilityLifetime (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  if !truth (← Prog.effect "obsState.get" [socket]) then return undef
  let now := (intOf (← Prog.effect "Date.now")).getD 0
  let expiresAt := (intOf (field (field (member socket "data") "scope") "expiresAt")).getD 0
  let _ ← Prog.effect "setTimeout" [fnRef "", toJson (min (expiresAt - now) 60000)]
  return undef

/-- The byte length of base64 text, as a `Uint8Array`'s `byteLength`. -/
private def base64ByteLength (text : String) : Nat :=
  let chars := text.toList
  let padding := (chars.filter (· == '=')).length
  chars.length * 3 / 4 - padding

private def relayTerminalInput (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let chunk := Twin.callArg call 1
  let state ← Prog.effect "terminalState.get" [socket]
  if !truth state then return undef
  let upstream := field state "upstream"
  if truth upstream && member upstream "readyState" == toJson (1 : Nat) then
    if ((intOf (member upstream "bufferedAmount")).getD 0) > 2 * 4194304 then
      let _ ← Prog.effect "socket.close"
        [toJson (1009 : Nat), str "terminal upstream is not draining"]
      return undef
    let _ ← Prog.effect "state.upstream.send" [chunk]
    return undef
  let added : Nat := match chunk with
    | .str text => utf16Length text
    | other => base64ByteLength ((field other "$bytes").getStr?.toOption.getD "")
  if ((intOf (field state "pendingBytes")).getD 0) + added > 65536 then
    let _ ← Prog.effect "socket.close"
      [toJson (1009 : Nat), str "terminal input buffer exceeded"]
  return undef

/-- Only the socket's construction: the handlers it installs run later, outside this call. -/
private def openTerminalUpstream (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let data := member socket "data"
  let ticket := field data "ticket"
  if !truth ticket then
    let _ ← Prog.effect "socket.close"
      [toJson (4401 : Nat), str "Invalid, expired or already used terminal ticket"]
    return undef
  let _ ← Prog.effect "terminalState.set"
    [socket, Json.mkObj
      [("upstream", Json.null), ("pending", .arr #[]), ("pendingBytes", toJson (0 : Nat))]]
  let headerName := match field ticket "authorizationHeader" with
    | .str name => name
    | _ => "authorization"
  let headers := [(headerName, field ticket "authorization")] ++
    (if field data "kind" == str "machine" then [("x-broods-via-gateway", str "1")] else [])
  match ← Prog.attempt "new WebSocket"
      [field ticket "url", Json.mkObj [("headers", Json.mkObj headers)]] with
  | .ok _ => return undef
  | _ =>
    let _ ← Prog.effect "socket.close"
      [toJson (1011 : Nat), str "failed to reach the sandbox terminal"]
    return undef

/-- Up to the backfill's start; `start()` runs unawaited, and later polls fall outside the call. -/
private def startSandboxLogPoll (call : Json) : Prog Json := do
  let scope := Twin.callArg call 1
  let sandboxId := Twin.callArg call 2
  let minLevel := Twin.callArg call 3
  let backfill := Twin.callArg call 4
  let lokiUrl := match Twin.env call "LOKI_URL" with
    | .str text => trim text
    | _ => ""
  if lokiUrl.isEmpty then return Json.null
  let query ← Prog.effect "lokiBackfillQuery" [scope, minLevel, sandboxId]
  if ((intOf backfill).getD 0) > 0 then
    let now ← Prog.effect "nowNs"
    let nowText := (field now "$bigint").getStr?.toOption.getD "0"
    let floorNs : Nat := nowText.toNat! - 86400000000000
    Prog.spawn "fetchLokiLogs"
      [str lokiUrl, scope, query, Json.mkObj
        [("startNs", Json.mkObj [("$bigint", str (toString floorNs))]), ("limit", backfill),
         ("direction", str "backward"), ("timeoutMs", toJson (15000 : Nat))], toJson true]
  else
    let _ ← Prog.effect "setInterval" [fnRef "", toJson (2000 : Nat)]
  return Json.mkObj [("unsubscribe", fnRef "unsubscribe")]

/-- What `{ ...record.config, controlPlane }` holds. -/
private def withControlPlane (config plane : Json) : Json :=
  match config with
  | .obj entries => .obj (entries.insert "controlPlane" plane)
  | _ => Json.mkObj [("controlPlane", plane)]

/-- An object without the keys whose value is `undefined`, which the recorder drops. -/
private def defined (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun (_, value) => !isUndef value)

/-- The audit callback's event: fixed fields first, then whatever details the action passed. -/
private def auditEvent (fixed : List (String × Json)) (args : Json) : Json :=
  let result := Twin.arg args 0
  let base := defined (fixed ++ [("result", result)])
  match Twin.arg args 1, base with
  | .obj details, .obj entries =>
    .obj (details.foldl (fun merged key value => merged.insert key value) entries)
  | _, _ => base

private def lifecycleAction (action context : Json) : String × List Json :=
  match action with
  | .str "exec" => ("execSandbox", [context])
  | .str "refresh" => ("refreshSandboxStatus", [context])
  | .str "resume" => ("suspendOrResumeSandbox", [context, str "resume"])
  | .str "snapshot" => ("snapshotSandbox", [context])
  | .str "suspend" => ("suspendOrResumeSandbox", [context, str "suspend"])
  | .str "terminal" => ("openSandboxTerminal", [context])
  | _ => ("terminateSandbox", [context])

private def isComputeAction (call action : Json) : Bool :=
  match (Twin.moduleValue call "COMPUTE_ACTIONS").getObjVal? "$set" with
  | .ok (.arr names) => names.contains action
  | _ => false

/-- The sandbox budget gate: `some` is the plan refusal to answer with. -/
private def budgetRefusal (config accountId : Json) : Prog (Option Json) := do
  if truth (← Prog.effect "runsOnOwnCredentials" [config]) then return none
  match ← Prog.attempt "assertSandboxBudget" [accountId] with
  | .ok _ => return none
  | .threw error _ =>
    let thrown := field error "$error"
    if field thrown "$class" != str "BudgetExhaustedError" then throw error
    let refusal ← Prog.effect "planRefusalResponse"
      [Json.mkObj [("kind", str "budget"), ("message", field thrown "message")]]
    return some refusal
  | .pending => Prog.unsupported "budget check never settled"

private def handleSandboxLifecycle (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let accountId := Twin.callArg call 1
  let record := Twin.callArg call 2
  let action := Twin.callArg call 3
  let config := field record "config"
  let sandboxId := field record "sandboxId"
  if action != str "terminate" then
    let refusal ← Prog.effect "retiredImageOptionsRefusal" [accountId, sandboxId, config]
    if truth refusal then return refusal
  let parsed ← Prog.effect "parseJsonBody" [Twin.callArg call 4]
  let body ← Prog.effect "parseOr"
    [Json.mkObj [("$opaque", str "ZodMiniRecord")], parsed, Json.mkObj []]
  let reservationKey := match field body "reservationKey" with
    | .str value => Js.trim value
    | _ => ""
  if reservationKey.isEmpty then
    return ← Prog.effect "errorResponse" [toJson (400 : Nat), str "reservationKey is required"]
  let controllable ← Prog.effect "sandboxInstanceIsControllable"
    [accountId, sandboxId, str reservationKey]
  if !truth controllable then
    return ← Prog.effect "errorResponse"
      [toJson (403 : Nat), str "reservationKey does not belong to this account or sandbox config"]
  if isComputeAction call action then
    if let some refusal ← budgetRefusal config accountId then return refusal
  let actor ← Prog.effect "sandboxAuditActor" [auth, field body "actor"]
  let plane ← Prog.effect "sandboxControlPlane" [accountId, record]
  let executor ← Prog.effect "createSandboxExecutor" [withControlPlane config plane]
  let scope ← Prog.effect "sandboxScope" [record]
  let provider := field config "provider"
  let context := defined
    [("accountId", accountId), ("audit", fnRef "audit"), ("body", body), ("config", config),
     ("name", field record "name"), ("executor", executor), ("provider", provider),
     ("ref", Json.mkObj [("reservationKey", str reservationKey)]),
     ("reservationKey", str reservationKey), ("scope", scope)]
  let (label, args) := lifecycleAction action context
  let fixed :=
    [("accountId", accountId), ("sandboxConfigId", sandboxId),
     ("reservationKey", str reservationKey), ("provider", provider), ("action", action),
     ("actor", actor)]
  Prog.drain (fun entered args =>
    if entered == "audit" then do
      let _ ← Prog.attempt "recordSandboxAuditEvent" [auditEvent fixed args]
    else pure ()) 64
  let outcome ← Prog.attempt label args
  match outcome with
  | .ok response => return response
  | .threw error _ => throw error
  | .pending => Prog.unsupported "the action never settled"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (agent ++ "handleAgentMessage") handleAgentMessage,
   Twin.traced (observability ++ "watchObservabilityLifetime") watchObservabilityLifetime,
   Twin.traced (observability ++ "startSandboxLogPoll") startSandboxLogPoll,
   Twin.traced (terminal ++ "relayTerminalInput") relayTerminalInput,
   Twin.traced (terminal ++ "openTerminalUpstream") openTerminalUpstream,
   Twin.traced "apps/core/src/accounts/handler.ts#handleSandboxLifecycle" handleSandboxLifecycle]

end Spec.Access.Waveaccess6a
