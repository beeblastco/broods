import Spec.Twin
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

namespace Spec.Access.Waveaccess1
open Lean
open Spec.Access

private def f (v : Json) (k : String) : Json := (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def s (v : Json) : String := v.getStr?.toOption.getD ""
private def xs (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def u (v : Json) : Bool := v == Twin.undefinedJson
private def truth (v : Json) : Bool := !u v && Js.truthy v
private def n (v : Json) : Float := if u v then Js.nan else (Js.numberOf v).getD Js.nan
private def j (v : String) : Json := .str v
private def fn (v : String) : Json := Json.mkObj [("$fn", j v)]
private def bytes (v : List UInt8) : Json :=
  let b := Crypto.base64UrlEncode v |>.replace "-" "+" |>.replace "_" "/"
  Json.mkObj [("$bytes", j (b ++ String.ofList (List.replicate ((4 - b.length % 4) % 4) '=')))]
private def readBytes (v : Json) : List UInt8 := Crypto.base64Decode (s (f v "$bytes"))
private def header (req : Json) (key : String) : Json :=
  ((xs (f (f req "$request") "headers")).find? fun e => (s (Twin.arg e 0)).toLower == key.toLower).map
    (fun e => Twin.arg e 1) |>.getD Json.null
private def routeManage (args : Json) : Json :=
  let m := (s (Twin.arg args 0)).toUpper
  let p := s (Twin.arg args 1)
  toJson <| if p == "/v1/accounts" then m == "POST"
    else if p == "/v1/account" then m == "DELETE"
    else match p.splitOn "/" with
      | ["", "v1", "accounts", id] => id != "" && m == "DELETE"
      | ["", "v1", "sandboxes", id, a] => id != "" && m == "POST" &&
        ["suspend", "resume", "terminate", "snapshot", "refresh", "exec", "terminal"].contains a
      | ["", "v1", "mcp-service", "rpc"] => m == "POST"
      | _ => false
private def bearer (v : Json) : Json :=
  let chars := (s v).toList
  let after := chars.drop 6
  if (String.ofList (chars.take 6)).toLower != "bearer" || !(after.head?.any Js.isSpace) then Json.null
  else
    let token := String.ofList (after.dropWhile Js.isSpace)
    if token == "" || token.toList.any Js.isLineTerminator then Json.null
    else let token := Js.trim token
         if token == "" then Json.null else j token
private def extractBearer (args : Json) : Json :=
  match Js.splitSpaces (Js.trim (s (Twin.arg args 0))) with
  | [scheme, token] => if scheme.toLower == "bearer" && token != "" then j token else Json.null
  | _ => Json.null
private def normalizeBase (args : Json) : Json :=
  let v := Js.stripTrailingSlashes (Js.trim (s (Twin.arg args 0)))
  if v == "" then Twin.threw "Gateway requires BROODS_CORE_URL"
  else
    let scheme := (v.splitOn "://").head!
    let valid := Js.includes v "://" && scheme.toList.head?.any Char.isAlpha &&
      scheme.toList.all (fun c => c.toNat < 128 && (c.isAlphanum || "+.-".contains c))
    j (if valid then v else "https://" ++ v)
private def originAllowed (args : Json) : Json :=
  let origin := Js.trim (s (Twin.arg args 0))
  let patterns := (xs (Twin.arg args 1)).map s
  if origin == "" || patterns.contains "*" then toJson true
  else
    let split := origin.splitOn "://"
    if split.length != 2 then toJson false
    else
      let authority := ((split[1]!).splitOn "/").head!
      let host := (((authority.splitOn "@").getLast!).splitOn ":").head! |>.toLower
      toJson (patterns.any fun p =>
        let p := p.toLower
        if Js.startsWith p "*." then Js.endsWith host (Js.dropChars p 1) else host == p)
private def normalizeOtel (args : Json) : Json :=
  match Twin.arg args 0 with
  | .str v =>
    let len := (n (Twin.arg args 1)).toUInt64.toNat
    if v == "" then j ""
    else if v.length == len * 2 && v.toList.all (fun c => "0123456789abcdef".contains c) then j v
    else let decoded := Crypto.base64Decode v
         if decoded.length == len then j (Crypto.hex decoded) else j v
  | _ => j ""
private def claimWrite (args : Json) : Json :=
  let last := (xs (f (Twin.arg args 0) "$map")).find? (fun p => Twin.arg p 0 == Twin.arg args 1)
  let interval := if (xs args).length < 4 then 300000.0 else n (Twin.arg args 3)
  toJson (!(last.any fun p => n (Twin.arg args 2) - n (Twin.arg p 1) < interval))
/-- `claimLastUsedWrite`. A claim drops every stale stamp, then writes this key's at the end. -/
private def claimWriteProg (call : Json) : Prog Json := do
  let args := f call "args"
  let claimed := claimWrite args
  if claimed == toJson true then
    let interval := if (xs args).length < 4 then 300000.0 else n (Twin.arg args 3)
    let table := Twin.arg args 0
    let kept := (xs (f table "$map")).filter fun p =>
      n (Twin.arg args 2) - n (Twin.arg p 1) < interval
    Prog.setChanged "args.0.$map" (f table "$map")
      (Json.arr (kept ++ [Json.arr #[Twin.arg args 1, Twin.arg args 2]]).toArray)
  pure claimed
private def positiveInt (args : Json) : Json :=
  let v := Twin.arg args 0
  if v == Json.null || u v || (match v with | .str t => Js.trim t == "" | _ => false)
  then Twin.arg args 1
  else let parsed := n v
       if Js.isSafeInteger parsed && parsed > 0 then Js.floatJson parsed else Twin.arg args 1
private def parseTicket (args : Json) : Json :=
  let v := Twin.arg args 0
  let keys := ["accountId", "endpointId", "projectId", "projectSlug", "stageId", "stageSlug"]
  if !(keys.all fun k => (f v k).getStr?.isOk) || !(f v "expiresAt").getNum?.isOk then Json.null
  else Json.mkObj ((keys.map fun k => (k, f v k)) ++
    (if f v "sandboxWrite" == toJson true then [("sandboxWrite", toJson true)] else []) ++
    [("expiresAt", f v "expiresAt")])
private def ruleMatches (args : Json) : Json :=
  let rule := Twin.arg args 0
  let res := Twin.arg args 2
  let ids := f (f rule "resources") "resourceIds"
  toJson ((xs (f rule "actions")).contains (Twin.arg args 1) &&
    (u ids || (xs ids).contains (j "*") || (!u (f res "id") && (xs ids).contains (f res "id"))))
private def withinPin (args : Json) : Json :=
  toJson (["projectId", "stageId"].all fun k =>
    u (f (Twin.arg args 0) k) || f (Twin.arg args 0) k == f (Twin.arg args 1) k)
private def rolePrincipal (args : Json) : Json :=
  let v := Twin.arg args 0
  Json.mkObj ([("kind", j "role")] ++ (["accountId", "roleId", "policy"].map fun k => (k, f v k)) ++
    (["projectId", "stageId"].filterMap fun k => if truth (f v k) then some (k, f v k) else none))
private def deploymentMatches (args : Json) : Json :=
  let auth := Twin.arg args 0
  let dep := Twin.arg args 1
  toJson (f dep "accountId" == f (f auth "account") "accountId" &&
    ["endpointId", "projectSlug", "stageSlug"].all fun k => f auth k == f dep k)
private def optionalString (args : Json) : Json :=
  (xs args).find? (fun v => match v with | .str t => t != "" | _ => false) |>.getD Json.null
private def otelValue : Nat → Json → Json
  | 0, _ => Twin.unsupported "nested OTEL values exceed fuel"
  | fuel + 1, v =>
    if !u (f v "stringValue") then f v "stringValue"
    else if !u (f v "intValue") then Js.floatJson (n (f v "intValue"))
    else if !u (f v "doubleValue") then f v "doubleValue"
    else if !u (f v "boolValue") then f v "boolValue"
    else if truth (f v "arrayValue") then toJson ((xs (f (f v "arrayValue") "values")).map (otelValue fuel))
    else Json.null
private def spanKind (args : Json) : Json :=
  let v := s (Twin.arg args 0)
  j (if v == "model.step" || v == "tool.call" then v else if Js.startsWith v "phase." then "phase"
    else if v == "agent.subtask" then "subtask" else if v == "agent.cron" then "cron" else "task")
private def apiAction (args : Json) : Json :=
  let m := (s (Twin.arg args 0)).toUpper
  j (s (Twin.arg args 1) ++ ":" ++ (if m == "GET" || m == "HEAD" then "read" else "write"))
private def offered (args : Json) : Json :=
  toJson (((s (header (Twin.arg args 0) "sec-websocket-protocol")).splitOn ",").map Js.trim |>.filter (· != ""))
private def clientIp (args : Json) : Json :=
  let ips := ((s (header (Twin.arg args 0) "x-forwarded-for")).splitOn ",").map Js.trim
  match ips.reverse.find? (· != "") with
  | some ip => j ip
  | none => if truth (Twin.arg args 1) then Twin.arg args 1 else j "unknown"
private def defaultsOrigins (args : Json) : Json :=
  let raw := Js.trim (s (f (Twin.arg args 0) "GATEWAY_ALLOWED_ORIGINS"))
  toJson (if raw == "" then ["broods.app", "*.broods.app", "localhost", "127.0.0.1"]
    else (raw.splitOn ",").map Js.trim |>.filter (· != ""))
private def rowScope (args : Json) : Json :=
  let attrs := f (Twin.arg args 0) "attributes"
  toJson ([("account_id", "accountId"), ("project", "projectSlug"), ("stage", "stageSlug")].all
    fun (a, b) => f attrs a == f (Twin.arg args 1) b)
private def closeCode (args : Json) : Json :=
  let code := n (Twin.arg args 0)
  if code == 1000 || (code >= 4000 && code <= 4999) then Twin.arg args 0 else toJson (1011 : Nat)
private def sessionInit (args : Json) : Json :=
  let frame := s (Twin.arg args 0)
  toJson (Js.startsWith frame "{" && (Json.parse frame).toOption.any fun v => f v "type" == j "session_init")
private def hashDigest (v : Json) (label : String) (encoding : List Json := []) : Prog Json := do
  let _ ← Prog.effect "createHash" [j "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\").update" [v]
  Prog.effect label encoding
private def timingEqual (call : Json) : Prog Json := do
  let a ← hashDigest (Twin.callArg call 0) "createHash(\"sha256\").update(actual).digest"
  let b ← hashDigest (Twin.callArg call 1) "createHash(\"sha256\").update(expected).digest"
  Prog.effect "timingSafeEqual" [a, b]
private def stageKey (call : Json) : Prog Json := do
  let material ← Prog.effect "crypto.subtle.digest"
    [j "SHA-256", bytes (Crypto.utf8 (s (Twin.callArg call 0) ++ s (Twin.callArg call 1)))]
  Prog.effect "crypto.subtle.importKey" [j "raw", material,
    Json.mkObj [("name", j "HMAC"), ("hash", j "SHA-256")], toJson false, toJson ["sign", "verify"]]
private def randomToken (call : Json) : Prog Json := do
  let size := if u (Twin.callArg call 1) then 32 else (n (Twin.callArg call 1)).toUInt64.toNat
  let random ← Prog.effect "crypto.getRandomValues" [bytes (List.replicate size 0)]
  pure (j (s (Twin.callArg call 0) ++ Crypto.base64UrlEncode (readBytes random)))
private def nowNs (_call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  pure (Json.mkObj [("$bigint", j (toString (now.getInt?.toOption.getD 0 * 1000000)))])
private def createRunId (_call : Json) : Prog Json := do
  let uuid ← Prog.effect "crypto.randomUUID"
  pure (j ("run_" ++ (s uuid).replace "-" ""))

private def tracedPure (source : String) (body : Json → Json) : Twin :=
  Twin.traced source (fun call => pure (body (f call "args")))

private def pureTwins : List Twin :=
  [Js.jsonTwin "apps/gateway/src/utils.ts#isOriginAllowed" originAllowed,
   Js.jsonTwin "apps/core/src/server.ts#routesToAccountManage" routeManage,
   Js.jsonTwin "apps/gateway/src/observability.ts#normalizeOtelId" normalizeOtel,
   Js.jsonTwin "apps/gateway/src/observability.ts#spanKind" spanKind,
   Twin.traced "apps/core/src/shared/auth.ts#claimLastUsedWrite" claimWriteProg,
   Js.jsonTwin "apps/core/src/shared/auth.ts#extractBearerToken" extractBearer,
   Js.jsonTwin "apps/gateway/src/terminal.ts#isSessionInitFrame" sessionInit,
   Js.jsonTwin "packages/convex/model/stageSessionTicket.ts#parseTicket" parseTicket,
   Js.jsonTwin "packages/convex/model/apiAuthorization.ts#ruleMatches" ruleMatches,
   Js.jsonTwin "apps/gateway/src/utils.ts#allowedOriginPatternsFromEnv" defaultsOrigins,
   Js.jsonTwin "apps/gateway/src/utils.ts#positiveInt" positiveInt,
   tracedPure "packages/convex/model/stageSessionTicket.ts#bytesToBase64Url"
     (fun a => j (Crypto.base64UrlEncode (readBytes (Twin.arg a 0)))),
   Js.jsonTwin "apps/gateway/src/utils.ts#parseJson"
     (fun a => (Json.parse (s (Twin.arg a 0))).toOption.getD Json.null),
   Js.jsonTwin "apps/gateway/src/utils.ts#normalizeBaseUrl" normalizeBase,
   tracedPure "apps/gateway/src/utils.ts#clientIp" clientIp,
   Js.jsonTwin "packages/convex/model/apiAuthorization.ts#apiActionForRequest" apiAction,
   Js.jsonTwin "packages/convex/model/apiAuthorization.ts#withinPin" withinPin,
   Js.jsonTwin "apps/gateway/src/observability.ts#optionalString" optionalString,
   Js.jsonTwin "apps/gateway/src/utils.ts#bearerToken" (fun a => bearer (Twin.arg a 0)),
   tracedPure "apps/gateway/src/utils.ts#offeredSubprotocols" offered,
   tracedPure "packages/convex/model/accountSecrets.ts#hexFromBytes" (fun a => j (Crypto.hex (readBytes (Twin.arg a 0)))),
   Js.jsonTwin "apps/gateway/src/observability.ts#quoteLabel" (fun a =>
     j ("\"" ++ ((s (Twin.arg a 0)).replace "\\" "\\\\").replace "\"" "\\\"" ++ "\"")),
   Js.jsonTwin "apps/gateway/src/observability.ts#rowInScope" rowScope,
   Js.jsonTwin "apps/gateway/src/observability.ts#otelValue" (fun a => otelValue 64 (Twin.arg a 0)),
   Js.jsonTwin "apps/gateway/src/utils.ts#errorText" (fun a =>
     match Twin.arg a 0 with | .str v => j v | v => (v.getObjVal? "message").toOption.getD Json.null),
   tracedPure "apps/gateway/src/utils.ts#errorMessage" (fun a =>
     let v := Twin.arg a 0
     if !u (f v "$error") then f (f v "$error") "message"
     else match v with | .str t => j t | .null => j "null" | _ => j v.compress),
   tracedPure "apps/gateway/src/terminal.ts#natsSpentTickets" (fun _ =>
     Json.mkObj [("spend", fn "spend"), ("release", fn "release")]),
   Js.jsonTwin "apps/gateway/src/terminal.ts#relayCloseCode" closeCode,
   Js.jsonTwin "packages/convex/model/apiAuthorization.ts#rolePrincipal" rolePrincipal,
   Js.jsonTwin "apps/core/src/harness/status-access.ts#deploymentScopeMatches" deploymentMatches,
   Js.jsonTwin "apps/core/src/harness/status-access.ts#accessDenied" (fun _ => Json.mkObj
     [("code", j "status_access_denied"), ("message", j "Status is not accessible from this deployment.")]),
   Js.jsonTwin "apps/core/src/shared/media-ticket.ts#attachmentStoreKey" (fun a =>
     j ("attachments/" ++ Js.encodeURIComponent (s (f (Twin.arg a 0) "accountId")) ++ "/" ++ s (f (Twin.arg a 0) "path"))),
   tracedPure "apps/core/src/server.ts#createRoute" (fun _ => fn "")]

private def base64ToBytes (call : Json) : Prog Json := do
  let raw := (s (Twin.callArg call 0)).replace "-" "+" |>.replace "_" "/"
  let padded := raw ++ String.ofList (List.replicate ((4 - raw.length % 4) % 4) '=')
  let clean := String.ofList (padded.toList.filter fun c => !" \t\n\r\x0c".contains c)
  let data := clean.toList.takeWhile (· != '=')
  let tail := clean.toList.drop data.length
  if data.length % 4 == 1 || !data.all (fun c => (Crypto.base64Value c).isSome) ||
      tail.length > 2 || !tail.all (· == '=') || clean.length % 4 != 0 then
    Prog.throwError "InvalidCharacterError" "The string to be decoded is not correctly encoded."
  else pure (bytes (Crypto.base64Decode clean))

private def cleanupTerminal (call : Json) : Prog Json := do
  let sock := Twin.callArg call 0
  let state ← Prog.effect "terminalState.get" [sock]
  if !truth state then return Twin.undefinedJson
  let _ ← Prog.effect "terminalState.delete" [sock]
  let upstream := f state "upstream"
  if truth upstream then
    let ready := if !u (f upstream "$opaque") then Twin.field upstream "readyState" else f upstream "readyState"
    if u ready then return ← Prog.unsupported "upstream readyState was not recorded"
    if ready != toJson (3 : Nat) then
      let _ ← Prog.attempt "state.upstream.close" [toJson (1000 : Nat), j "client disconnected"]
  pure Twin.undefinedJson

private def cleanupStream (call : Json) : Prog Json := do
  let state ← Prog.effect "obsState.get" [Twin.callArg call 0]
  if !truth state then return Twin.undefinedJson
  if truth (f (f state "subs") (s (Twin.callArg call 1))) then
    let _ ← Prog.effect "state.subs[stream]?.unsubscribe"
  pure Twin.undefinedJson

private def cleanupObs (call : Json) : Prog Json := do
  let sock := Twin.callArg call 0
  let state ← Prog.effect "obsState.get" [sock]
  let _ ← Prog.effect "clearTimeout" [f state "lifetime"]
  let _ ← Prog.effect "cleanupObservabilityStream" [sock, j "logs"]
  let _ ← Prog.effect "cleanupObservabilityStream" [sock, j "traces"]
  let _ ← Prog.effect "obsState.delete" [sock]
  pure Twin.undefinedJson

private def authorizeRules (action resource : Json) : List Json → Option Json → Prog Json
  | [], allowing =>
    pure (Json.mkObj [("allow", toJson allowing.isSome),
      ("matchedRuleIds", toJson (allowing.toList.map fun r => f r "id")),
      ("reason", j (match allowing with
        | some r => "allowed by rule " ++ s (f r "id")
        | none => "no rule allows " ++ s action))])
  | rule :: rest, allowing => do
    let matched ← Prog.effect "ruleMatches" [rule, action, resource]
    if !truth matched then return ← authorizeRules action resource rest allowing
    if f rule "effect" == j "deny" then
      return Json.mkObj [("allow", toJson false), ("matchedRuleIds", toJson [f rule "id"]),
        ("reason", j ("denied by rule " ++ s (f rule "id")))]
    authorizeRules action resource rest (allowing.or (some rule))

private def authorize (call : Json) : Prog Json := do
  let principal := Twin.callArg call 0
  let resource := Twin.callArg call 2
  let pinned ← Prog.effect "withinPin" [principal, resource]
  if !truth pinned then
    return Json.mkObj [("allow", toJson false), ("matchedRuleIds", toJson ([] : List Json)),
      ("reason", j "resource is outside the role's pinned stage")]
  authorizeRules (Twin.callArg call 1) resource (xs (f (f principal "policy") "rules")) none

private def roleDenial (call : Json) : Prog Json := do
  let principal := Twin.callArg call 0
  let resource := Twin.callArg call 2
  let action ← Prog.effect "apiActionForRequest" [Twin.callArg call 1, f resource "type"]
  let decision ← Prog.effect "authorize" [principal, action, resource]
  if truth (f decision "allow") then return Json.null
  let pinned ← Prog.effect "withinPin" [principal, resource]
  pure (j (if truth pinned then "Role is not allowed to " ++ s action
    else "Role is pinned to one stage and may not " ++ s action ++ " outside it"))

private def subprotocol (call : Json) : Prog Json := do
  let offered ← Prog.effect "offeredSubprotocols" [Twin.callArg call 0]
  let pre := if u (Twin.callArg call 1) then "broods.token." else s (Twin.callArg call 1)
  pure ((xs offered).find? (fun v => Js.startsWith (s v) pre) |>.map
    (fun v => j (Js.dropChars (s v) pre.length)) |>.getD Json.null)

private def upgradeHeaders (call : Json) : Prog Json := do
  let offered ← Prog.effect "offeredSubprotocols" [Twin.callArg call 0]
  pure (if (xs offered).contains (j "broods.v1") then
    Json.mkObj [("Sec-WebSocket-Protocol", j "broods.v1")] else Twin.undefinedJson)

private def websocketToken (user : Bool) (call : Json) : Prog Json := do
  let req := Twin.callArg call 0
  let token ← if user then pure (header req "x-broods-user-token")
    else Prog.effect "bearerToken" [header req "authorization"]
  let token ← if token == Json.null || u token then
      if user then Prog.effect "subprotocolToken" [req, j "broods.user."]
      else Prog.effect "subprotocolToken" [req]
    else pure token
  let token := Js.trim (s token)
  pure (if user && token == "" then Twin.undefinedJson else j token)

private def otelAttributes (call : Json) : Prog Json := do
  let mut entries : List (String × Json) := []
  for attr in xs (Twin.callArg call 0) do
    if truth (f attr "key") then
      let value ← Prog.effect "otelValue" [f attr "value"]
      entries := entries.filter (fun e => e.1 != s (f attr "key")) ++
        (if u value then [] else [(s (f attr "key"), value)])
  pure (Json.mkObj entries)

private def stringValue (call : Json) : Prog Json := do
  let value ← Prog.effect "optionalString" (xs (f call "args"))
  pure (if u value || value == Json.null then j "" else value)

private def level (v : Json) : Nat :=
  if s v == "ERROR" then 3 else if s v == "WARN" then 2 else if s v == "INFO" then 1 else 0

private def meetsLevel (call : Json) : Prog Json := do
  let value := f (Twin.callArg call 0) "level"
  let valid ← Prog.effect "isLogLevel" [value]
  pure (toJson (truth valid && level value >= level (Twin.callArg call 1)))

private def accountSha (call : Json) : Prog Json := do
  let digest ← Prog.effect "crypto.subtle.digest" [j "SHA-256", bytes (Crypto.utf8 (s (Twin.callArg call 0)))]
  Prog.effect "hexFromBytes" [digest]

private def limits (call : Json) : Prog Json := do
  let env := Twin.param call 0
  let mut fields : List (String × Json) := []
  for (key, envKey, fallback) in
      [("maxConnections", "GATEWAY_MAX_CONNECTIONS", 10000),
       ("maxPayloadBytes", "GATEWAY_MAX_PAYLOAD_BYTES", 1048576),
       ("backpressureBytes", "GATEWAY_BACKPRESSURE_BYTES", 1048576),
       ("idleTimeoutSeconds", "GATEWAY_IDLE_TIMEOUT_SECONDS", 255),
       ("runStartTimeoutMs", "GATEWAY_RUN_START_TIMEOUT_MS", 15000)] do
    let value ← Prog.effect "positiveInt" [f env envKey, toJson (fallback : Nat)]
    let value := if key == "idleTimeoutSeconds" then Js.floatJson (min (n value) 255) else value
    fields := fields ++ [(key, value)]
  pure (Json.mkObj fields)

private def serviceToken (call : Json) : Prog Json := do
  if !u (f (Twin.callArg call 0) "x-broods-via-gateway") then return toJson false
  let secret ← Prog.effect "optionalEnv" [j "SERVICE_AUTH_SECRET"]
  if u secret then return toJson false
  Prog.effect "timingSafeStringEqual" [Twin.callArg call 1, secret]

private def roleSession (call : Json) : Prog Json := do
  let _ ← Prog.effect "getStorage"
  let hash ← Prog.effect "sha256Hex" [Twin.callArg call 0]
  let principal ← Prog.effect "getStorage().roleSessions.resolveByTokenHash" [hash]
  if !truth principal then return Json.null
  let _ ← Prog.effect "getStorage"
  let account ← Prog.effect "getStorage().accounts.getById" [f principal "accountId"]
  if !truth account || f account "status" != j "active" then return Json.null
  pure (Json.mkObj [("kind", j "role"), ("account", account), ("role", principal)])

private def openSigned (call : Json) : Prog Json := do
  let pre := s (Twin.callArg call 0)
  let token := s (Twin.callArg call 2)
  if !Js.startsWith token pre then return Json.null
  let parts := (Js.dropChars token pre.length).splitOn "."
  match parts with
  | [payload, signature] =>
    if payload == "" || signature == "" then return Json.null
    Prog.catchFail (do
      let key ← Prog.effect "ticketKey" [Twin.callArg call 1, Twin.callArg call 3]
      let signature ← Prog.effect "base64UrlToBytes" [j signature]
      let verified ← Prog.effect "crypto.subtle.verify"
        [Json.mkObj [("name", j "HMAC"), ("hash", j "SHA-256")], key, signature, bytes (Crypto.utf8 payload)]
      if !truth verified then return Json.null
      let raw ← Prog.effect "base64UrlToBytes" [j payload]
      pure ((Json.parse (String.fromUTF8! (ByteArray.mk (readBytes raw).toArray))).toOption.getD Json.null))
      (fun _ => pure Json.null)
  | _ => pure Json.null

private def openMediaSecret (call : Json) : Prog Json := do
  match (s (Twin.callArg call 0)).splitOn "." with
  | [version, iv, tag, ciphertext] =>
    if version != "ml2" || iv == "" || tag == "" || ciphertext == "" then return Json.null
    Prog.catchFail (do
      let key ← Prog.effect "ticketKey" [Twin.callArg call 1]
      let _ ← Prog.effect "createDecipheriv" [j "aes-256-gcm", key, bytes (Crypto.base64Decode iv)]
      let _ ← Prog.effect "decipher.setAuthTag" [bytes (Crypto.base64Decode tag)]
      let first ← Prog.effect "decipher.update" [bytes (Crypto.base64Decode ciphertext)]
      let last ← Prog.effect "decipher.final"
      let plaintext := String.fromUTF8! (ByteArray.mk (readBytes first ++ readBytes last).toArray)
      match Json.parse plaintext with
      | .error _ => pure Json.null
      | .ok decoded =>
        let parsed ← Prog.effect "ticketPayload.safeParse" [decoded]
        pure (if truth (f parsed "success") && n (f (f parsed "data") "exp") * 1000 > n (Twin.callArg call 2)
          then f parsed "data" else Json.null)) (fun _ => pure Json.null)
  | _ => pure Json.null

private def embeddableReaches (call : Json) : Prog Json := do
  if truth (Twin.callArg call 0) then
    Prog.effect "userOwnsConversation" [Twin.callArg call 0, Twin.callArg call 1]
  else pure (toJson (!Js.startsWith (s (Twin.callArg call 1)) "bsu:"))

private def embeddableDenial (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let agent := Twin.callArg call 1
  if truth (f auth "stageTicket") then return Json.null
  if f agent "requireUserToken" == toJson true && !truth (f auth "user") then
    return Json.mkObj [("code", j "user_token_required"),
      ("message", j ("Agent " ++ s (f agent "agentId") ++ " requires a signed user token with the runtime key."))]
  let key ← Prog.effect "publicConversationKeyFromScoped"
    [Twin.callArg call 2, f (f auth "account") "accountId", f agent "agentId"]
  let reaches ← Prog.effect "embeddableKeyReaches" [f auth "user", key]
  if truth reaches then return Json.null
  Prog.effect "accessDenied"

private def publicDenial (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let req := Twin.callArg call 1
  let agent ← Prog.effect "context.agentLoader" [f req "accountId", f req "agentId"]
  if !truth agent || (f (f agent "config") "publicAccess" != toJson true && !truth (f auth "stageTicket")) then
    return Json.mkObj [("code", j "public_access_disabled"),
      ("message", j ("Agent " ++ s (f req "agentId") ++ " is not publicly accessible."))]
  let deployment ← Prog.effect "context.deploymentLoader" [f req "accountId", f req "agentId"]
  let matched ← Prog.effect "deploymentScopeMatches" [auth, deployment]
  if !truth matched then return ← Prog.effect "accessDenied"
  let ingress := f (f req "ingress") "publicDeploymentIngress"
  let matched ← Prog.effect "deploymentScopeMatches" [auth, if u ingress then Json.null else ingress]
  if !truth matched then return ← Prog.effect "accessDenied"
  Prog.effect "embeddableUserDenial" [auth, agent, f (f req "ingress") "conversationKey"]

private def statusDenial (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let req := Twin.callArg call 1
  let context := Twin.callArg call 2
  let parent ← Prog.effect "subagentParentEventId" [f req "publicEventId"]
  if truth parent then Prog.effect "subagentDenial" [auth, req, parent, context]
  else Prog.effect "publicAgentDenial" [auth, req, context]

private def lokiQuery (call : Json) : Prog Json := do
  let scope := Twin.callArg call 0
  let account ← Prog.effect "quoteLabel" [f scope "accountId"]
  let project ← Prog.effect "quoteLabel" [f scope "projectSlug"]
  let stage ← Prog.effect "quoteLabel" [f scope "stageSlug"]
  let tenant := "account_id=" ++ s account ++ ",project=" ++ s project ++ ",stage=" ++ s stage
  let sandbox := Twin.callArg call 2
  let selector ← if truth sandbox then pure ("{" ++ tenant ++ "}") else do
    let service ← Prog.effect "quoteLabel" [j "broods-sandbox"]
    pure ("{" ++ tenant ++ ",service_name!=" ++ s service ++ "}")
  let filters ← if truth sandbox then do
      let sandbox ← Prog.effect "quoteLabel" [sandbox]
      pure ["sandbox_id=" ++ s sandbox]
    else pure []
  let below := (["DEBUG", "INFO", "WARN", "ERROR"].filter fun value => level (j value) < level (Twin.callArg call 1))
  let filters := filters ++ (if below.isEmpty then [] else ["level!~\"(?i)(" ++ String.intercalate "|" below ++ ")\""])
  pure (j (String.intercalate " | " (selector :: filters)))

private def subagentDenial (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let req := Twin.callArg call 1
  let parentEvent := Twin.callArg call 2
  let child ← Prog.effect "context.asyncAgentResultLoader" [f req "eventId"]
  let scope ← if truth child then Prog.effect "parseAccountAgentScopedKey" [f child "conversationKey"] else pure Json.null
  if !truth child || f child "accountId" != f req "accountId" || f child "eventId" != f req "eventId" ||
      f scope "accountId" != f req "accountId" || f scope "agentId" != f req "agentId" ||
      !Js.startsWith (s (f scope "key")) "api:" then return ← Prog.effect "accessDenied"
  let parent ← Prog.effect "parseAccountAgentScopedKey" [parentEvent]
  if !truth parent || f parent "accountId" != f req "accountId" then return ← Prog.effect "accessDenied"
  let answers ← Prog.all
    [("context.agentLoader", [f req "accountId", f parent "agentId"]),
     ("context.deploymentLoader", [f req "accountId", f parent "agentId"]),
     ("context.ingressStatusByEventIdLoader", [Json.mkObj [("accountId", f req "accountId"),
       ("agentId", f parent "agentId"), ("eventId", parentEvent)]])]
  let values ← answers.mapM fun answer => match answer with
    | .ok value => pure value
    | .threw error _ => Prog.fail error
    | .pending => Prog.unsupported "unfinished parent lookup"
  let agent := values[0]!
  let deployment := values[1]!
  let status := values[2]!
  if !truth agent || (f (f agent "config") "publicAccess" != toJson true && !truth (f auth "stageTicket")) then
    return ← Prog.effect "accessDenied"
  let matched ← Prog.effect "deploymentScopeMatches" [auth, deployment]
  if !truth matched || !truth status || f status "eventId" != parentEvent then return ← Prog.effect "accessDenied"
  let ingress := f status "publicDeploymentIngress"
  let matched ← Prog.effect "deploymentScopeMatches" [auth, if u ingress then Json.null else ingress]
  if !truth matched then return ← Prog.effect "accessDenied"
  Prog.effect "embeddableUserDenial" [auth, agent, f status "conversationKey"]

private def terminalSecrets (call : Json) : Prog Json := do
  let token := Twin.callArg call 0
  if Js.trim (s token) == "" then return Json.null
  for secret in xs (Twin.callArg call 1) do
    let ticket ← Prog.effect "openTerminalTicket" [token, secret]
    if truth ticket then return ticket
  pure Json.null

private def runTokenAuth (call : Json) : Prog Json := do
  let subject ← Prog.effect "openRunToken" [Twin.callArg call 0]
  if !truth subject then return Json.null
  let _ ← Prog.effect "getStorage"
  let account ← Prog.effect "getStorage().accounts.getById" [f subject "accountId"]
  if !truth account || f account "status" != j "active" then return Json.null
  pure (Json.mkObj [("kind", j "agent"), ("account", account), ("agentId", f subject "agentId")])

private def accountAuth (call : Json) : Prog Json := do
  let hash ← Prog.effect "hashAccountSecret" [Twin.callArg call 0]
  let _ ← Prog.effect "getStorage"
  let account ← Prog.effect "getStorage().accounts.getBySecretHash" [hash]
  if !truth account then return ← Prog.effect "resolveScopedKeyAuth" [hash]
  if f account "status" != j "active" && f (Twin.callArg call 1) "allowDisabledAccountSecret" != toJson true then
    return Json.null
  pure (Json.mkObj [("kind", j "account"), ("account", account)])

private def jsonResponse (call : Json) : Prog Json := do
  let init := Twin.callArg call 1
  let headers := f init "headers"
  let entries ← if u headers || headers == Json.null then pure [] else
    match headers with
    | .obj fields => pure (fields.toList.map fun (key, value) => (key.toLower, value))
    | .arr entries => pure (entries.toList.map fun pair => ((s (Twin.arg pair 0)).toLower, Twin.arg pair 1))
    | _ => Prog.unsupported "non-JSON Headers instance"
  let entries := if entries.any (fun e => e.1 == "content-type") then entries
    else entries ++ [("content-type", j "application/json")]
  let entries := entries.mergeSort (fun a b => a.1 <= b.1)
  let status := if u (f init "status") then toJson (200 : Nat) else f init "status"
  pure (Json.mkObj [("$response", Json.mkObj [("status", status),
    ("headers", toJson (entries.map fun (key, value) => toJson [j key, value])),
    ("body", if u (Twin.callArg call 0) then Json.mkObj [("$undefined", toJson true)]
      else toJson (Twin.jsonStringify 64 (Twin.callArg call 0)))])])

private def extraTwins : List Twin :=
  [Twin.traced "packages/convex/model/stageSessionTicket.ts#base64UrlToBytes" base64ToBytes,
   Twin.traced "apps/core/src/harness/status-access.ts#subagentDenial" subagentDenial,
   Twin.traced "apps/gateway/src/terminal.ts#openTerminalTicketWithSecrets" terminalSecrets,
   Twin.traced "apps/core/src/shared/auth.ts#resolveRunTokenAuth" runTokenAuth,
   Twin.traced "apps/core/src/shared/auth.ts#resolveAccountSecretAuth" accountAuth,
   Twin.traced "apps/gateway/src/utils.ts#json" jsonResponse,
   Twin.traced "packages/convex/model/stageSessionTicket.ts#openSignedTicket" openSigned,
   Twin.traced "apps/core/src/shared/media-ticket.ts#openWithSecret" openMediaSecret,
   Twin.traced "apps/core/src/harness/status-access.ts#embeddableKeyReaches" embeddableReaches,
   Twin.traced "apps/core/src/harness/status-access.ts#embeddableUserDenial" embeddableDenial,
   Twin.traced "apps/core/src/harness/status-access.ts#publicAgentDenial" publicDenial,
   Twin.traced "apps/core/src/harness/status-access.ts#statusAccessDenial" statusDenial,
   Twin.traced "apps/gateway/src/observability.ts#lokiBackfillQuery" lokiQuery,
   Twin.traced "packages/convex/model/stageSessionTicket.ts#sealStageSessionTicket" (fun c =>
     Prog.effect "sealSignedTicket" [j "bdts_", j "stage-session-ticket:", Twin.callArg c 0, Twin.callArg c 1]),
   Twin.traced "apps/gateway/src/terminal.ts#cleanupTerminalSocket" cleanupTerminal,
   Twin.traced "apps/gateway/src/observability.ts#cleanupObservabilityStream" cleanupStream,
   Twin.traced "apps/gateway/src/observability.ts#cleanupObservabilitySocket" cleanupObs,
   Twin.traced "packages/convex/model/apiAuthorization.ts#authorize" authorize,
   Twin.traced "packages/convex/model/apiAuthorization.ts#roleDenial" roleDenial,
   Twin.traced "apps/gateway/src/utils.ts#subprotocolToken" subprotocol,
   Twin.traced "apps/gateway/src/utils.ts#websocketUpgradeHeaders" upgradeHeaders,
   Twin.traced "apps/gateway/src/utils.ts#websocketToken" (websocketToken false),
   Twin.traced "apps/gateway/src/utils.ts#websocketUserToken" (websocketToken true),
   Twin.traced "apps/gateway/src/observability.ts#otelAttributes" otelAttributes,
   Twin.traced "apps/gateway/src/observability.ts#stringValue" stringValue,
   Twin.traced "apps/gateway/src/observability.ts#meetsMinLevel" meetsLevel,
   Twin.traced "packages/convex/model/accountSecrets.ts#sha256Hex" accountSha,
   Twin.traced "packages/convex/model/accountSecrets.ts#createAccountSecret"
     (fun _ => Prog.effect "randomToken" [j "bask_"]),
   Twin.traced "apps/gateway/src/utils.ts#gatewayLimitsFromEnv" limits,
   Twin.traced "apps/core/src/shared/auth.ts#isServiceToken" serviceToken,
   Twin.traced "apps/core/src/shared/auth.ts#resolveRoleSessionAuth" roleSession]

private def nullish (v : Json) : Bool := u v || v == Json.null
private def orElse (v other : Json) : Json := if nullish v then other else v
private def undef : Json := Twin.undefinedJson
private def num (v : Nat) : Json := toJson v
private def bigOf (v : Json) : Int := (s (f v "$bigint")).toInt?.getD 0
private def big (v : Int) : Json := Json.mkObj [("$bigint", j (toString v))]
private def optKey (key : String) (v : Json) : List (String × Json) := if u v then [] else [(key, v)]
/-- `socket.data`: a plain record, or the `$fields` of a recorded `ServerWebSocket`. -/
private def socketData (socket : Json) : Json :=
  if u (f socket "$opaque") then f socket "data" else Twin.field socket "data"
private def scopeOf (socket : Json) : Json :=
  f (socketData socket) "scope"
private def isOpaque (v : Json) : Bool := !u (f v "$opaque")
private def responseStatus (response : Json) : Nat :=
  (n (f (f response "$response") "status")).toUInt64.toNat
private def responseOk (response : Json) : Bool :=
  responseStatus response >= 200 && responseStatus response < 300

private def closeExpired (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let now ← Prog.effect "Date.now"
  if u (socketData socket) then
    return ← Prog.throwError "TypeError" "undefined is not an object (evaluating 'socket.data.scope')"
  if n now < n (f (scopeOf socket) "expiresAt") then return toJson false
  let _ ← Prog.effect "socket.close" [num 4419, j "Stage session expired"]
  pure (toJson true)

/-- `socket.readyState`: a plain record, or the `$fields` of a recorded `ServerWebSocket`. -/
private def socketReady (socket : Json) : Json :=
  if isOpaque socket then Twin.field socket "readyState" else f socket "readyState"

private def drainPolls (socket : Json) (limit deadline : Float) : Nat → Prog Json
  | 0 => Prog.unsupported "more drain polls than the model allows"
  | fuel + 1 => do
    if socketReady socket != num 1 then return undef
    let buffered ← Prog.effect "socket.getBufferedAmount"
    if n buffered <= limit then return undef
    let now ← Prog.effect "Date.now"
    if n now >= deadline then return undef
    Prog.input fun
      | none => Prog.unsupported "the promise executor was not entered"
      | some (_, entered) => do
        let _ ← Prog.effect "setTimeout" [Twin.arg entered 0, num 20]
        drainPolls socket limit deadline fuel

private def waitDrain (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let limit := if u (Twin.callArg call 1) then 524288.0 else n (Twin.callArg call 1)
  let now ← Prog.effect "Date.now"
  drainPolls socket limit (n now + 5000.0) 1024

private def openObsSocket (call : Json) : Prog Json := do
  let promise := Json.mkObj [("$opaque", j "Promise"), ("$fields", Json.mkObj [])]
  let streams (v : Json) := Json.mkObj [("logs", v), ("traces", v)]
  let _ ← Prog.effect "obsState.set" [Twin.callArg call 0, Json.mkObj
    [("subs", streams Json.null), ("runs", streams (num 0)), ("logsMinLevel", j "INFO"),
     ("logsSandboxId", Json.null), ("backfills", streams promise), ("fetchingTrace", toJson false)]]
  pure undef

private def requestTempo (call : Json) : Prog Json := do
  let traceId := Twin.callArg call 1
  let signal ← Prog.effect "AbortSignal.timeout" [num 5000]
  let response ← Prog.effect "fetch"
    [j (s (Twin.callArg call 0) ++ "/api/traces/" ++ Js.encodeURIComponent (s traceId)),
     Json.mkObj [("signal", signal)]]
  if responseStatus response == 404 then return toJson ([] : List Json)
  if !responseOk response then
    return ← Prog.throwError "Error" s!"Tempo trace query failed with HTTP {responseStatus response}"
  let body ← Prog.effect "response.json"
  Prog.effect "tempoTraceRowsFromResponse" [body, traceId]

private def lokiSteps : List (Int × Nat) :=
  [(3600000, 5000), (86400000, 10000), (2592000000, 15000)]

private def lokiBackfill (call : Json) : Prog Json := do
  let limit := Twin.callArg call 3
  let mut rows : Json := toJson ([] : List Json)
  for (window, timeout) in lokiSteps do
    let now ← Prog.effect "nowNs"
    rows ← Prog.effect "fetchLokiLogs"
      [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2, Json.mkObj
        [("startNs", big (bigOf now - window * 1000000)), ("limit", limit),
         ("direction", j "backward"), ("timeoutMs", num timeout)]]
    if Float.ofNat (xs rows).length >= n limit then break
  pure rows

/-- `URLSearchParams` serialisation of one value. -/
private def formEncode (text : String) : String :=
  String.join ((Crypto.utf8 text).map fun byte =>
    let c := Char.ofNat byte.toNat
    if byte.toNat < 128 && (c.isAlphanum || "*-._".contains c) then c.toString
    else if c == ' ' then "+"
    else "%" ++ Js.upperHexByte byte.toNat)

private def lokiLogs (call : Json) : Prog Json := do
  let scope := Twin.callArg call 1
  let range := Twin.callArg call 3
  let sandbox := truth (Twin.callArg call 4)
  let now ← Prog.effect "nowNs"
  let query := String.intercalate "&"
    ["query=" ++ formEncode (s (Twin.callArg call 2)), "limit=" ++ (f range "limit").compress,
     "direction=" ++ s (f range "direction"), "start=" ++ toString (bigOf (f range "startNs")),
     "end=" ++ toString (bigOf now)]
  let timeout := f range "timeoutMs"
  let signal ← Prog.effect "AbortSignal.timeout" [timeout]
  let answer ← Prog.attempt "fetch"
    [j (s (Twin.callArg call 0) ++ "/loki/api/v1/query_range?" ++ query), Json.mkObj [("signal", signal)]]
  let response ← match answer with
    | .ok value => pure value
    | .threw error _ =>
      if f (f error "$error") "$class" == j "DOMException" && u (f (f error "$error") "name") then
        Prog.unsupported "DOMException.name was not recorded"
      else if f (f error "$error") "name" == j "TimeoutError" then
        Prog.throwError "Error" s!"Loki query timed out after {timeout.compress}ms"
      else Prog.fail error
    | .pending => Prog.unsupported "unfinished fetch"
  if !responseOk response then
    return ← Prog.throwError "Error" s!"Loki query failed with HTTP {responseStatus response}"
  let body ← Prog.effect "response.json"
  let mut rows : List Json := []
  for stream in xs (f (f body "data") "result") do
    for value in xs (f stream "values") do
      let ns := (s (Twin.arg value 0)).toInt?.getD 0
      let line := Twin.arg value 1
      let ts := Js.floatJson (Float.ofInt (ns.tdiv 1000000))
      let entry ← if sandbox then
          pure (Json.mkObj [("ts", ts), ("level", j "INFO"), ("eventType", j "sandbox"),
            ("message", line), ("accountId", f scope "accountId")])
        else Prog.effect "lokiLogEntry" [f stream "stream", line, ts, f scope "accountId"]
      rows := rows ++ [Json.mkObj [("ns", big ns), ("entry", entry)]]
  pure (toJson rows)

private def lokiEntry (call : Json) : Prog Json := do
  let labels := Twin.callArg call 0
  let line := Twin.callArg call 1
  let parsed ← Prog.effect "parseJson" [line]
  let record := if truth parsed && Js.isObjectLike parsed then parsed else Json.mkObj []
  let rawLevel := orElse (f record "level") (orElse (f labels "level")
    (orElse (f labels "severity_text") (f labels "detected_level")))
  let normalized := match rawLevel with
    | .str text => j text.toUpper
    | _ => undef
  let valid ← Prog.effect "isLogLevel" [normalized]
  let level := if truth valid then s normalized else "INFO"
  let ts ← match f record "ts", f record "time" with
    | .num value, _ => pure (Json.num value)
    | _, .str _ => Prog.unsupported "Date.parse of a timestamp string"
    | _, _ => pure (Twin.callArg call 2)
  let eventType ← Prog.effect "stringValue" [f record "eventType", f labels "eventType", j level.toLower]
  let message ← Prog.effect "stringValue" [f record "message", f labels "message", line]
  let pick (key snake : String) : Prog Json :=
    Prog.effect "optionalString" [f record key, f labels key, f labels snake]
  let traceId ← pick "traceId" "trace_id"
  let accountId ← pick "accountId" "account_id"
  let endpointId ← pick "endpointId" "endpoint_id"
  let agentId ← pick "agentId" "agent_id"
  let conversationKey ← pick "conversationKey" "conversation_key"
  let service ← pick "service" "service_name"
  pure (Json.mkObj ([("ts", ts), ("level", j level), ("eventType", eventType), ("message", message)] ++
    optKey "traceId" traceId ++
    [("accountId", if u accountId then Twin.callArg call 3 else accountId)] ++
    optKey "endpointId" endpointId ++ optKey "agentId" agentId ++
    optKey "conversationKey" conversationKey ++ optKey "service" service ++
    [("data", if Js.keyCount record > 0 then record else labels)]))

private def stringKey (key : String) (out : String) (attributes : Json) : List (String × Json) :=
  match f attributes key with
  | .str text => [(out, j text)]
  | _ => []

private def spanRow (raw resource fallback : Json) : Prog (Option Json) := do
  let own ← Prog.effect "otelAttributes" [f raw "attributes"]
  let attributes := Json.mkObj (Js.entries resource ++ Js.entries own)
  let traceId ← Prog.effect "normalizeOtelId" [f raw "traceId", num 16]
  let spanId ← Prog.effect "normalizeOtelId" [f raw "spanId", num 8]
  let parent ← Prog.effect "normalizeOtelId" [f raw "parentSpanId", num 8]
  let traceId := if truth traceId then traceId else fallback
  if !truth traceId || !truth spanId then return none
  let start := orElse (f raw "startTimeUnixNano") (num 0)
  let startMs := Float.floor (n start / 1000000.0)
  let endMs := Float.floor (n (orElse (f raw "endTimeUnixNano") start) / 1000000.0)
  let name := match f raw "name" with
    | .str text => j text
    | _ => j "agent.task"
  let kind ← Prog.effect "spanKind" [name]
  let status := f raw "status"
  let isError := f status "code" == num 2 || f status "code" == j "STATUS_CODE_ERROR"
  let state := f attributes "task.state"
  let label := if isError then j "error"
    else if state == j "waiting" || state == j "needs_input" then state else j "ok"
  let error := match f status "message" with
    | .str text => if isError then [("error", j text)] else []
    | _ => []
  pure (some (Json.mkObj ([("traceId", traceId), ("spanId", spanId)] ++
    (if truth parent then [("parentSpanId", parent)] else []) ++
    [("name", name), ("kind", kind), ("startTimeMs", Js.floatJson startMs),
     ("endTimeMs", Js.floatJson endMs), ("durationMs", Js.floatJson (max 0.0 (endMs - startMs))),
     ("status", label)] ++
    stringKey "endpoint_id" "endpointId" attributes ++ stringKey "agent_id" "agentId" attributes ++
    stringKey "conversation_key" "conversationKey" attributes ++
    [("attributes", attributes)] ++ error)))

private def tempoRows (call : Json) : Prog Json := do
  let fallback := if u (Twin.callArg call 1) then j "" else Twin.callArg call 1
  let mut rows : List Json := []
  for batch in xs (f (Twin.callArg call 0) "batches") do
    let resource ← Prog.effect "otelAttributes" [f (f batch "resource") "attributes"]
    let groups := orElse (f batch "scopeSpans") (f batch "instrumentationLibrarySpans")
    for group in xs groups do
      for raw in xs (f group "spans") do
        if let some row ← spanRow raw resource fallback then
          rows := rows ++ [row]
  pure (toJson rows)

private def stageSessionAuth (call : Json) : Prog Json := do
  let secret ← Prog.effect "requireEnv" [j "STAGE_TICKET_SECRET"]
  let ticket ← Prog.effect "openStageSessionTicket" [Twin.callArg call 0, secret]
  if !truth ticket then return Json.null
  let _ ← Prog.effect "getStorage"
  let account ← Prog.effect "getStorage().accounts.getById" [f ticket "accountId"]
  if !truth account || f account "status" != j "active" then return Json.null
  pure (Json.mkObj [("kind", j "deployment"), ("account", account),
    ("endpointId", f ticket "endpointId"), ("projectSlug", f ticket "projectSlug"),
    ("stageSlug", f ticket "stageSlug"), ("stageTicket", Json.mkObj
      [("projectId", f ticket "projectId"), ("stageId", f ticket "stageId"),
       ("sandboxWrite", toJson (f ticket "sandboxWrite" == toJson true)),
       ("expiresAt", f ticket "expiresAt")])])

private def serviceAccount (headers : Json) : Prog Json := do
  let accountId := orElse (f headers "x-account-id") (f headers "X-Account-Id")
  if !truth accountId then return Json.null
  let _ ← Prog.effect "getStorage"
  let account ← Prog.effect "getStorage().accounts.getById" [accountId]
  if !truth account || f account "status" != j "active" then return Json.null
  pure (Json.mkObj [("kind", j "account"), ("account", account), ("viaServiceToken", toJson true)])

private def bearerAuth (call : Json) : Prog Json := do
  let headers := Twin.callArg call 0
  let options := if u (Twin.callArg call 1) then Json.mkObj [] else Twin.callArg call 1
  let token ← Prog.effect "extractBearerToken" [f headers "authorization"]
  if !truth token then return Json.null
  let prefixed (pre : String) : Bool := Js.startsWith (s token) pre
  if prefixed "bsts_" then return ← Prog.effect "resolveRoleSessionAuth" [token]
  if prefixed "bdts_" then return ← Prog.effect "resolveStageSessionAuth" [token]
  if prefixed "bdob_" then return Json.null
  if prefixed "brt_" then return ← Prog.effect "resolveRunTokenAuth" [token]
  let admin ← Prog.effect "optionalEnv" [j "ADMIN_ACCOUNT_SECRET"]
  if truth admin then
    let same ← Prog.effect "timingSafeStringEqual" [token, admin]
    if truth same then return Json.mkObj [("kind", j "admin")]
  let service ← Prog.effect "isServiceToken" [headers, token]
  if truth service then return ← serviceAccount headers
  if prefixed "bask_" then return ← Prog.effect "resolveAccountSecretAuth" [token, options]
  if prefixed "bsk_" then
    return ← Prog.effect "resolveRuntimeKeyAuth" [token, f headers "x-broods-user-token"]
  pure Json.null

private def observabilityMessage (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let raw := Twin.callArg call 1
  let expired ← Prog.effect "closeIfExpired" [socket]
  if truth expired then return undef
  let text := match raw with
    | .str value => value
    | other => String.fromUTF8! (ByteArray.mk (readBytes other).toArray)
  let parsed ← Prog.effect "parseJson" [j text]
  let valid ← Prog.effect "isObservabilityClientMessage" [parsed]
  if !truth valid then
    let _ ← Prog.effect "sendObs" [socket, Json.mkObj
      [("type", j "error"), ("error", j "Invalid observability message")]]
    return undef
  if f parsed "type" == j "unsubscribe" then
    let _ ← Prog.effect "cleanupObservabilityStream" [socket, f parsed "stream"]
    return undef
  if f parsed "type" == j "fetchTrace" then
    let state ← Prog.effect "obsState.get" [socket]
    if !truth state then return undef
    if truth (f state "fetchingTrace") then
      let _ ← Prog.effect "sendObs" [socket, Json.mkObj
        [("type", j "backfill"), ("stream", j "traces"), ("entries", toJson ([] : List Json)),
         ("error", j "A trace lookup is already running")]]
      return undef
    let _ ← Prog.effect "sendTrace" [socket, scopeOf socket, f parsed "traceId"]
    return undef
  let _ ← Prog.effect "handleObservabilitySubscribe"
    [socket, scopeOf socket, f parsed "stream", f parsed "backfill",
     toJson (f parsed "liveOnly" == toJson true), orElse (f parsed "minLevel") (j "INFO"),
     Twin.callArg call 2, f parsed "sandboxId", toJson (f parsed "historyOnly" == toJson true)]
  pure undef

private def queryParams (search : String) : Json :=
  let decode (text : String) : String :=
    let spaced := text.replace "+" " "
    (Js.decodeURIComponent spaced).getD spaced
  toJson ((search.splitOn "&").filter (· != "") |>.map fun pair =>
    match pair.splitOn "=" with
    | [] => toJson ["", ""]
    | key :: rest => toJson [decode key, decode (String.intercalate "=" rest)])

private def toCore (call : Json) : Prog Json := do
  let request := f (Twin.callArg call 0) "$request"
  let href := s (f (Twin.callArg call 1) "$url")
  let headers := (xs (f request "headers")).map fun pair => ((s (Twin.arg pair 0)).toLower, Twin.arg pair 1)
  let lookup (key : String) : Json := ((headers.find? (·.1 == key)).map (·.2)).getD undef
  let withoutHash := (href.splitOn "#").head!
  let beforeQuery := (withoutHash.splitOn "?").head!
  let search := Js.dropChars withoutHash (min withoutHash.length (beforeQuery.length + 1))
  let path := "/" ++ String.intercalate "/" (((beforeQuery.splitOn "://").getLast!).splitOn "/" |>.drop 1)
  let body ← Prog.effect "request.text"
  let forwarded := lookup "x-forwarded-for"
  let clientIp := if truth forwarded then
      j (((s forwarded).splitOn ",").map Js.trim |>.reverse |>.find? (· != "") |>.getD "")
    else orElse (Twin.callArg call 2) (j "")
  pure (Json.mkObj [("method", f request "method"), ("path", j path), ("search", j search),
    ("query", Json.mkObj [("$params", queryParams search)]), ("headers", Json.mkObj headers),
    ("body", body), ("clientIp", clientIp)])

/-- Workers share the cursor; every item starts once, and overlapping calls settle independently. -/
private def mapConcurrent (call : Json) : Prog Json := do
  let items := xs (Twin.callArg call 0)
  let workers := min items.length (n (Twin.callArg call 1)).toUInt64.toNat
  Prog.drain (fun _ _ => pure ()) workers
  let outcomes ← if workers == 0 then pure []
    else Prog.all (items.map fun item => ("mapper", [item]))
  let settled ← outcomes.mapM fun outcome => match outcome with
    | .ok value => pure (Json.mkObj [("status", j "fulfilled"), ("value", value)])
    | .threw error _ => pure (Json.mkObj [("status", j "rejected"), ("reason", error)])
    | .pending => Prog.unsupported "unfinished mapper"
  pure (toJson settled)

private def sendObservability (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let payload := Twin.callArg call 1
  let readyState := if isOpaque socket then Twin.field socket "readyState" else f socket "readyState"
  if readyState != num 1 then return toJson false
  let expired ← Prog.effect "closeIfExpired" [socket]
  if truth expired then return toJson false
  if f payload "type" == j "log" || f payload "type" == j "span" then
    let buffered ← Prog.effect "socket.getBufferedAmount"
    if n buffered > 524288.0 then return toJson false
  match ← Prog.attempt "socket.send" [j (Twin.jsonStringify 16 payload)] with
  | .threw _ _ => pure (toJson false)
  | _ => pure (toJson true)

private def waveTwins : List Twin :=
  [Twin.traced "apps/gateway/src/utils.ts#mapWithConcurrency" mapConcurrent,
   Twin.traced "apps/gateway/src/observability.ts#sendObs" sendObservability,
   Twin.traced "apps/gateway/src/observability.ts#closeIfExpired" closeExpired,
   Twin.traced "apps/gateway/src/observability.ts#waitForObsDrain" waitDrain,
   Twin.traced "apps/gateway/src/observability.ts#openObservabilitySocket" openObsSocket,
   Twin.traced "apps/gateway/src/observability.ts#requestTempoTrace" requestTempo,
   Twin.traced "apps/gateway/src/observability.ts#fetchLokiBackfill" lokiBackfill,
   Twin.traced "apps/gateway/src/observability.ts#fetchLokiLogs" lokiLogs,
   Twin.traced "apps/gateway/src/observability.ts#lokiLogEntry" lokiEntry,
   Twin.traced "apps/gateway/src/observability.ts#tempoTraceRowsFromResponse" tempoRows,
   Twin.traced "apps/gateway/src/observability.ts#handleObservabilityMessage" observabilityMessage,
   Twin.traced "apps/core/src/shared/auth.ts#resolveStageSessionAuth" stageSessionAuth,
   Twin.traced "apps/core/src/shared/auth.ts#resolveBearerAuth" bearerAuth,
   Twin.traced "apps/core/src/server.ts#toCoreRequest" toCore]

/-- Computed counterparts for this assignment. -/
def twins : List Twin := pureTwins ++ extraTwins ++ waveTwins ++
  [Twin.traced "packages/convex/model/accountSecrets.ts#randomToken" randomToken,
   Twin.traced "packages/convex/model/stageSessionTicket.ts#ticketKey" stageKey,
   Twin.traced "apps/core/src/shared/auth.ts#timingSafeStringEqual" timingEqual,
   Twin.traced "apps/core/src/shared/auth.ts#sha256Hex" (fun c =>
     hashDigest (Twin.callArg c 0) "createHash(\"sha256\").update(value).digest" [j "hex"]),
   Twin.traced "apps/core/src/shared/media-ticket.ts#ticketKey" (fun c =>
     hashDigest (j ("workspace-media-link:" ++ s (Twin.callArg c 0)))
       "createHash(\"sha256\").update(`workspace-media-link:${secret}`).digest"),
   Twin.traced "apps/gateway/src/observability.ts#nowNs" nowNs,
   Twin.traced "apps/core/src/shared/runtime-keys.ts#createRunId" createRunId]

end Spec.Access.Waveaccess1
