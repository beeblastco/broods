import Spec.Twin
import Spec.Access.Twins.Waveaccess8a
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

namespace Spec.Access.Waveaccess2
open Lean Spec Js

private def field (v : Json) (k : String) : Json := (prop v k).getD Twin.undefinedJson
private def text (v : Json) : String :=
  match v with
  | .str s => s
  | .null => "null"
  | _ => if v == Twin.undefinedJson then "undefined" else v.compress
private def truth (v : Json) : Bool := v != Twin.undefinedJson && truthy v
private def items (v : Json) : List Json :=
  match v with | .arr xs => xs.toList | _ => []
private def obj : List (String × Json) → Json := Json.mkObj
private def plain (source : String) (run : Json → Json) : Twin := { source := source, run := run }
private def optional (v : Json) (keys : List String) : List (String × Json) :=
  keys.filterMap fun k => if field v k == Twin.undefinedJson then none else some (k, field v k)

private def cleanupFields : List String :=
  ["conversationsDeleted", "processedEventsDeleted", "asyncAgentResultDeleted", "asyncToolResultDeleted", "sandboxReservationDeleted"]
private def cleanupBatches (account : Json) : Nat → Json → Prog Json
  | 0, _ => Prog.throwError "Error" "Account runtime cleanup exceeded 100 Convex batches; retry deletion to continue"
  | fuel + 1, totals => do
    let batch ← Prog.effect "runtime.mutate" [.str "deleteAccountRuntimeData", obj [("accountId", account)]]
    let next := obj (cleanupFields.map fun k => (k, match field totals k, field batch k with
      | .num a, .num b => .num (numAdd a b) | _, _ => .null))
    if field batch "totalDeleted" == toJson (0 : Nat) then return next
    cleanupBatches account fuel next
private def deleteConvexRuntimeRows (call : Json) : Prog Json :=
  cleanupBatches (Twin.callArg call 0) 100 (obj (cleanupFields.map fun k => (k, toJson (0 : Nat))))

private def matchAgentPath (args : Json) : Json := Id.run do
  let parts := (text (Twin.arg args 0)).splitOn "/"
  let keys : List (String × String) := match parts with
    | ["", "v1", "projects", p, "stages", s, "agents", e, "ws"] => [("projectSlug", p), ("stageSlug", s), ("endpointId", e)]
    | ["", "v1", "agents", e, "ws"] => [("endpointId", e)]
    | _ => []
  if keys.isEmpty || keys.any (fun pair => pair.2.isEmpty) then return .null
  let mut result := []
  for (key, raw) in keys do
    match decodeURIComponent raw with
    | none => return Twin.threw "URI error"
    | some value => result := result ++ [(key, .str value)]
  return obj result

private def resolveSocketScope (call : Json) : Prog Json :=
  Prog.catchFail (do
    let socket := text (Twin.callArg call 0)
    let token := text (Twin.callArg call 1)
    let base := text (Twin.callArg call 2)
    let userToken := Twin.callArg call 4
    let signal ← Prog.effect "AbortSignal.timeout" [toJson (5000 : Nat)]
    let response ← Prog.effect "fetchImpl"
      [.str (base ++ "/v1/internal/" ++ (if socket == "agent" then "agent-socket-scope" else "observability-scope")),
       obj [("method", .str "POST"), ("headers", obj
         ([("Authorization", .str ("Bearer " ++ token)), ("Content-Type", .str "application/json"), ("x-broods-via-gateway", .str "1")] ++
          if truth userToken then [("x-broods-user-token", userToken)] else [])), ("signal", signal)]]
    let status := (field (field response "$response") "status").getNat?.toOption.getD 0
    if status ≥ 200 && status < 300 then
      let scope ← Prog.effect "response.json"
      return obj [("kind", .str "resolved"), ("scope", scope)]
    return obj [("kind", .str (if status == 401 || status == 403 then "invalid" else "unavailable"))])
    (fun _ => pure (obj [("kind", .str "unavailable")]))
private def stopActiveRun (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let active ← Prog.effect "activeRuns.get" [socket]
  if !truth active then return Twin.undefinedJson
  if truth (Twin.callArg call 1) && Twin.callArg call 1 != active then return Twin.undefinedJson
  let _ ← Prog.effect "clearTimeout" [field active "startTimeout"]
  let _ ← Prog.effect "activeRun.abort.abort"
  let _ ← Prog.effect "activeRuns.delete" [socket]
  return Twin.undefinedJson
private def ruleMatcher (rule : Json) : Json :=
  let path := "PathRegexp(`^" ++ text (field rule "path") ++ "/*$`)"
  let methods := field rule "methods"
  .str (if !truth methods then path else "(" ++ " || ".intercalate ((items methods).map fun m => "Method(`" ++ text m ++ "`)") ++ ") && " ++ path)
private def boundedInteger (args : Json) : Json :=
  let value := Twin.arg args 0
  let fallback := Twin.arg args 1
  if value == .null || value == Twin.undefinedJson then fallback else
  match numberOf value, numberOf (Twin.arg args 2) with
  | some parsed, some limit => if isSafeInteger parsed && parsed ≥ 1.0 && parsed ≤ limit then floatJson parsed else fallback
  | _, _ => Twin.unsupported "array numeric conversion"
private def requireAccountAuth (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let kind := text (field auth "kind")
  if ["deployment", "role", "agent"].contains kind then
    let error ← Prog.effect "new AccountEndpointUnauthorizedError"
    return ← Prog.fail error
  if kind != "account" then return ← Prog.throwError "Error" "Admin must use account-specific endpoints"
  if truth (field auth "viaServiceToken") && field (Twin.callArg call 1) "allowServiceToken" != .bool true then
    return ← Prog.throwError "Error" "Service token is not allowed for this account endpoint"
  return field auth "account"
private def originRegex (hostname : String) : String :=
  if hostname == "*" then "^https?://.+$" else
  let subdomains := startsWith hostname "*."
  let host := if subdomains then dropChars hostname 2 else hostname
  let escaped := String.join (host.toList.map fun c => (if ".*+?^${}()|[]\\".toList.contains c then "\\" else "") ++ c.toString)
  "^https?://" ++ (if subdomains then "(?:[a-z0-9-]+\\.)+" else "") ++ escaped ++ "(?::\\d+)?$"
private def responseJson (call : Json) : Prog Json := do
  if field (field (Twin.callArg call 0) "$response") "status" == toJson (404 : Nat) then return obj [("status", .str "not_found")]
  let payload ← Prog.catchFail (Prog.effect "response.json") (fun _ => pure (obj []))
  return if isObjectLike payload then payload else obj []
private def parseJsonBody (args : Json) : Json :=
  let body := text (field (Twin.arg args 0) "body")
  if (trim body).isEmpty then obj [] else
  match Json.parse body with | .ok value => value | .error _ => Twin.unsupported "engine-specific JSON parser error text"
private def channelPrincipalChain (args : Json) : Json :=
  let identity := Twin.arg args 0
  if !truth (field identity "userId") then .null else
  .arr #[obj ([("kind", .str "user"), ("id", field identity "userId"), ("channel", Twin.arg args 1)] ++
    if truth (field identity "userName") then [("name", field identity "userName")] else [])]
private def runPrincipal (args : Json) : Json :=
  let run := Twin.arg args 0
  if !truth (field run "accountId") || !truth (field run "agentId") then .null else
  obj ([("kind", .str "agent"), ("accountId", field run "accountId"), ("agentId", field run "agentId")] ++
    if truth (Twin.arg args 1) then [("chain", Twin.arg args 1)] else [])
private def principalLinkLabel (args : Json) : Json :=
  let link := Twin.arg args 0
  .str (match text (field link "kind") with
    | "user" => "user:" ++ text (field link "id")
    | "api" => "api:" ++ text (field link "keyKind")
    | _ => "agent:" ++ text (field link "agentId"))
private def hasAnswerInput (v : Json) : Bool := !(items (field v "answers")).isEmpty
private def hasEventInput (v : Json) : Bool := (field v "input").getStr?.isOk || !(items (field v "events")).isEmpty
private def nonemptyString (v : Json) : Bool := match v with | .str s => !s.isEmpty | _ => false
private def subjectToken (v : Json) : Bool :=
  match v with | .str s => !s.isEmpty && s.toList.all (fun c => !isSpace c && !['.', '*', '>'].contains c) | _ => false
private def isAttachMessage (args : Json) : Json :=
  let v := Twin.arg args 0
  toJson (field v "type" == .str "attach" &&
    ["requestId", "conversationKey", "eventId", "runId"].all (fun k => nonemptyString (field v k)) &&
    subjectToken (field v "agentId") && (field v "afterCursor" == Twin.undefinedJson || (field v "afterCursor").getStr?.isOk))
private def coreHeaders (args : Json) : Json :=
  let data := field (Twin.arg args 0) "data"
  obj ([("Accept", .str "application/json"), ("Authorization", .str ("Bearer " ++ text (field data "token"))),
    ("Content-Type", .str "application/json"), ("x-broods-via-gateway", .str "1")] ++
    if truth (field data "userToken") then [("x-broods-user-token", field data "userToken")] else [])
private def userScoped (args : Json) : Json :=
  let pre := field (field (Twin.arg args 0) "data") "conversationPrefix"
  let value := text (Twin.arg args 1)
  .str (if truth pre && !startsWith value (text pre) then text pre ++ value else value)
private def routerMiddlewares (args : Json) : Json :=
  let limit := text (field (Twin.arg args 0) "limit")
  toJson (["headers"] ++ (if !truth (Twin.arg args 1) || limit == "none" then [] else ["limit-" ++ limit]) ++ ["strip-trailing-slash"])
private def errorText (args : Json) : Json :=
  let v := Twin.arg args 0
  if (prop v "$error").isSome then field (field v "$error") "message" else .str (text v)
private def toCreateAccountResponse (args : Json) : Json :=
  let account := Twin.arg args 0
  obj ([("accountId", field account "accountId"), ("username", field account "username")] ++
    if truth (field account "description") then [("description", field account "description")] else [])
private def delegatedChain (args : Json) : Json :=
  let principal := Twin.arg args 0
  let chain := field principal "chain"
  if !truth chain then .null else .arr ((items chain ++ [obj [("kind", .str "agent"), ("agentId", field principal "agentId")]]).toArray)
private def deleteAccountAttachments (call : Json) : Prog Json := do
  let bucket ← Prog.effect "optionalEnv" [.str "FILESYSTEM_BUCKET_NAME"]
  if !truth bucket then return toJson (0 : Nat)
  let pre ← Prog.effect "attachmentStorePrefix" [Twin.callArg call 0]
  Prog.effect "deleteS3Prefix" [bucket, pre]
private def deleteWorkspaceFilesystems (call : Json) : Prog Json := do
  let mut total : JsonNumber := natNum 0
  for workspace in items (Twin.callArg call 1) do
    let deleted ← Prog.effect "deleteWorkspaceFilesystem" [Twin.callArg call 0, field workspace "workspaceId", field (field workspace "config") "storage"]
    match deleted with | .num n => total := numAdd total n | _ => return ← Prog.unsupported "non-numeric deletion count"
  return .num total
private def handleMcpServiceRoute (call : Json) : Prog Json := do
  if Twin.callArg call 1 != .str "POST" || Twin.callArg call 2 != .str "/v1/mcp-service/rpc" then return .null
  let request := Twin.callArg call 3
  let token ← Prog.effect "extractBearerToken" [field (field request "headers") "authorization"]
  if field (Twin.callArg call 0) "kind" != .str "account" || !truth token then
    return ← Prog.effect "errorResponse" [toJson (403 : Nat), .str "Forbidden"]
  let service ← Prog.effect "isServiceToken" [field request "headers", token]
  if !truth service then return ← Prog.effect "errorResponse" [toJson (403 : Nat), .str "Forbidden"]
  Prog.effect "handleMcpServiceRpc" [field (field (Twin.callArg call 0) "account") "accountId", request]
private def buildCoreRunBody (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let supplied := field message "eventId"
  let eventId ← if supplied.getStr?.isOk && !(trim (text supplied)).isEmpty then pure (.str (trim (text supplied))) else do
    let now ← Prog.effect "Date.now"
    let uuid ← Prog.effect "crypto.randomUUID"
    pure (.str ("ws-" ++ text now ++ "-" ++ text uuid))
  let session := field message "sessionId"
  let conversation := if session.getStr?.isOk && !(trim (text session)).isEmpty then .str (trim (text session)) else eventId
  let connection ← Prog.effect "crypto.randomUUID"
  let input ← if truth (field message "answers") then pure [("answers", field message "answers")] else do
    let events ← Prog.effect "resolveRunEvents" [message]
    pure [("events", events)]
  return obj ([("agentId", .str (trim (text (field message "agentId")))), ("eventId", eventId),
    ("conversationKey", conversation), ("connectionId", .str ("ws-" ++ text connection))] ++ input ++ optional message ["mode", "idempotencyKey", "system", "model"])
private def headersMiddleware (args : Json) : Json :=
  obj [("headers", obj [("customRequestHeaders", obj [("x-broods-via-gateway", .str "1"), ("X-Account-Id", .str "")]),
    ("accessControlAllowMethods", toJson (["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] : List String)),
    ("accessControlAllowHeaders", toJson (["authorization", "content-type", "x-request-id", "x-broods-user-token"] : List String)),
    ("accessControlAllowOriginListRegex", toJson ((items (Twin.arg args 0)).map (originRegex ∘ text))),
    ("accessControlMaxAge", toJson (600 : Nat)), ("addVaryHeader", .bool true)])]


private def watchUserTokenLifetime (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let expiry := field (field socket "data") "userTokenExpiresAt"
  if expiry == Twin.undefinedJson then return Twin.undefinedJson
  let now ← Prog.effect "Date.now"
  let delay := match numberOf expiry, numberOf now with
    | some a, some b => floatJson (max (a - b) 0.0)
    | _, _ => .null
  let timer ← Prog.effect "setTimeout" [obj [("$fn", .str "")], delay]
  let _ ← Prog.effect "tokenLifetimes.set" [socket, timer]
  return Twin.undefinedJson

private def cursorEventKey (call : Json) : Prog Json := do
  let _ ← Prog.effect "createHash" [.str "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\").update" [Twin.callArg call 0]
  let digest ← Prog.effect "createHash(\"sha256\").update(eventId).digest" [.str "base64url"]
  return .str (String.ofList ((text digest).toList.take 16))

private def ticketKey (call : Json) : Prog Json := do
  let _ ← Prog.effect "createHash" [.str "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\") .update" [.str ("sandbox-terminal-ticket:" ++ text (Twin.callArg call 0))]
  Prog.effect "createHash(\"sha256\") .update(`sandbox-terminal-ticket:${secret}`) .digest"

private def credentialKey (call : Json) : Prog Json := do
  let bytes := Crypto.utf8 (text (Twin.callArg call 0))
  let base64 (xs : List UInt8) : Json :=
    let encoded := Crypto.base64UrlEncode xs
    let standard := encoded.replace "-" "+" |>.replace "_" "/"
    obj [("$bytes", .str (standard ++ String.ofList (List.replicate ((4 - standard.length % 4) % 4) '=')))]
  let material ← Prog.effect "crypto.subtle.importKey"
    [.str "raw", base64 bytes, .str "HKDF", .bool false, toJson (["deriveKey"] : List String)]
  Prog.effect "crypto.subtle.deriveKey"
    [obj [("name", .str "HKDF"), ("hash", .str "SHA-256"), ("salt", base64 []),
      ("info", base64 (Crypto.utf8 "broods-user-token-credential"))], material,
      obj [("name", .str "AES-GCM"), ("length", toJson (256 : Nat))], .bool false,
      toJson (["encrypt", "decrypt"] : List String)]

private def directPrincipalChain (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  if truth (field event "principalChain") then return field event "principalChain"
  if truth (field event "cronRun") then return .arr #[obj [("kind", .str "api"), ("keyKind", .str "cron")]]
  let target := field event "replyTarget"
  if !truth target then return target
  Prog.effect "channelPrincipalChain" [field target "identity", field target "channelName"]

private def routerRule (call : Json) : Prog Json := do
  let rules := items (field (Twin.callArg call 0) "rules")
  if rules.length == 1 then return ← Prog.effect "ruleMatcher" [rules.head!]
  let mut results := []
  for rule in rules do
    let matched ← Prog.effect "ruleMatcher" [rule]
    results := results ++ ["(" ++ text matched ++ ")"]
  return .str (" || ".intercalate results)

private def responseErrorText (_call : Json) : Prog Json := do
  let body ← Prog.effect "response.text"
  Prog.catchFail (do
    match Json.parse (text body) with
    | .error _ => return body
    | .ok parsed =>
      let result ← Prog.effect "errorText" [field parsed "error"]
      return if result == .null || result == Twin.undefinedJson then body else result)
    (fun _ => pure body)

private def cleanupAgentSocket (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let timer ← Prog.effect "tokenLifetimes.get" [socket]
  let _ ← Prog.effect "clearTimeout" [timer]
  let _ ← Prog.effect "stopActiveRun" [socket]
  return Twin.undefinedJson

private def sendTerminalFrame (call : Json) : Prog Json := do
  let status := Twin.callArg call 2
  let error := Twin.callArg call 3
  let payload := if status == .str "completed" then obj [("type", .str "done")] else
    obj [("type", .str "error"), ("error", if error == .null || error == Twin.undefinedJson then
      .str (text (Twin.callArg call 1) ++ " run ended with status " ++ text status) else error)]
  let _ ← Prog.effect "sendAgentTest" [Twin.callArg call 0, payload]
  return Twin.undefinedJson

private def isControlMessage (call : Json) : Prog Json := do
  let v := Twin.callArg call 0
  if field v "type" != .str "control" || !nonemptyString (field v "requestId") || !nonemptyString (field v "eventId") then return .bool false
  if field v "mode" != Twin.undefinedJson then
    let valid ← Prog.effect "isIngressMode" [field v "mode"]
    if !truth valid then return .bool false
  Prog.effect "hasEventInput" [v]

private def isExecuteMessage (call : Json) : Prog Json := do
  let v := Twin.callArg call 0
  if field v "type" != .str "execute" || !(field v "agentId").getStr?.isOk || !subjectToken (.str (trim (text (field v "agentId")))) then return .bool false
  if field v "mode" != Twin.undefinedJson then
    let valid ← Prog.effect "isIngressMode" [field v "mode"]
    if !truth valid then return .bool false
  let events ← Prog.effect "hasEventInput" [v]
  if truth events then return .bool true
  Prog.effect "hasAnswerInput" [v]

private def auditedSandboxCall (call : Json) : Prog Json :=
  Prog.catchFail (Prog.effect "call") fun err => do
    let message ← Prog.effect "errorText" [err]
    let _ ← Prog.effect "context.audit" [.str "error", obj [("errorMessage", message)]]
    let unreachable ← Prog.effect "isUnreachableError" [err]
    if truth unreachable then
      let error ← Prog.effect "new SandboxProviderUnreachableError" [field (Twin.callArg call 0) "provider", err]
      return ← Prog.fail error
    Prog.fail err

/-- `sandboxAuditActor`: only an account on the service token may name the user it acts for. -/
private def sandboxAuditActor (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  if field auth "kind" == .str "role" then
    return obj [("source", .str "service"), ("id", field (field auth "role") "roleId")]
  if field auth "kind" != .str "account" || !truth (field auth "viaServiceToken") then
    return obj [("source", .str "service")]
  let schema := obj [("$opaque", .str "ZodMiniRecord"), ("$fields", obj [("type", .str "record")])]
  let v ← Prog.effect "parseOr" [schema, Twin.callArg call 1]
  if !truth v then return obj [("source", .str "unknown")]
  let source := field v "source"
  let extra := ["id", "email", "name"].filterMap fun key =>
    if (field v key).getStr?.isOk && !(trim (text (field v key))).isEmpty then some (key, .str (trim (text (field v key)))) else none
  return obj ([("source", if ["dashboard", "agent", "service"].contains (text source) then source else .str "unknown")] ++ extra)

private def unsupportedSandboxAction (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let message := .str ("provider " ++ text (field context "provider") ++ " does not support " ++ text (Twin.callArg call 1))
  let _ ← Prog.effect "context.audit" [.str "error", obj [("errorMessage", message)]]
  Prog.effect "errorResponse" [toJson (409 : Nat), message]

private def principalChainLabel (call : Json) : Prog Json := do
  let chain ← Prog.effect "delegatedChain" [Twin.callArg call 0]
  if chain == Twin.undefinedJson || chain == .null then return Twin.undefinedJson
  return .str (">".intercalate ((items chain).map fun link => text (principalLinkLabel (.arr #[link]))))

private def middlewares (call : Json) : Prog Json := do
  let headers ← Prog.effect "headersMiddleware" [Twin.callArg call 0]
  return obj [("headers", headers),
    ("limit-http", obj [("rateLimit", obj [("average", toJson (20 : Nat)), ("period", .str "1s"), ("burst", toJson (200 : Nat))])]),
    ("limit-upgrade", obj [("rateLimit", obj [("average", toJson (2 : Nat)), ("period", .str "1s"), ("burst", toJson (60 : Nat))])]),
    ("strip-trailing-slash", obj [("replacePathRegex", obj [("regex", .str "^(/.*?)/+$"), ("replacement", .str "$1")])])]

private def jsonResponse (args : Json) : Json :=
  let headers := obj ([("content-type", .str "application/json")] ++
    (entries (Twin.arg args 2)).filter (·.1 != "$keys"))
  let normalized := (entries headers).map fun (k, v) => (k.toLower, .str (trim (text v)))
  let pairs := (entries (obj normalized)).map fun (k, v) => Json.arr #[.str k, v]
  obj [("$response", obj [("status", Twin.arg args 0), ("headers", .arr pairs.toArray),
    ("body", if Twin.arg args 1 == Twin.undefinedJson then obj [("$undefined", .bool true)]
      else .str (Twin.jsonStringify 64 (Twin.arg args 1)))])]

private def bytesOf (v : Json) : List UInt8 := Crypto.base64Decode (text (field v "$bytes"))
private def bytesJson (xs : List UInt8) : Json :=
  let standard := (Crypto.base64UrlEncode xs).replace "-" "+" |>.replace "_" "/"
  obj [("$bytes", .str (standard ++ String.ofList (List.replicate ((4 - standard.length % 4) % 4) '=')))]
private def urlOf (v : Json) : String := Crypto.base64UrlEncode (bytesOf v)

private def utf8Text (xs : List UInt8) : Option String := String.fromUTF8? ⟨xs.toArray⟩

/-- `$`-less JSON text for a scalar field of a fixed-order object. -/
private def jsonScalar (v : Json) : String :=
  match v with
  | .str s => quoteJson s
  | _ => v.compress

private def lookupUntilAborted (call : Json) : Prog Json := do
  let host := Twin.callArg call 0
  let signal := Twin.callArg call 1
  if !truth signal then return ← Prog.effect "dns.lookup" [host]
  let _ ← Prog.effect "signal.throwIfAborted"
  let onAbort := obj [("$fn", .str "onAbort")]
  let _ ← Prog.effect "signal.addEventListener" [.str "abort", onAbort, obj [("once", .bool true)]]
  let outcome ← Prog.attempt "dns.lookup" [host]
  let _ ← Prog.drain (fun _ _ => Prog.unsupported "AbortSignal.reason was not recorded") 1
  let _ ← Prog.effect "signal.removeEventListener" [.str "abort", onAbort]
  match outcome with
  | .ok value => return value
  | .threw error _ => Prog.fail error
  | .pending => Prog.unsupported "lookup never settled"

private def matchObservabilityPath (args : Json) : Json :=
  let path := text (Twin.arg args 0)
  match path.splitOn "/" with
  | ["", "v1", "projects", p, "stages", s, "observability", "ws"] =>
    if p.isEmpty || s.isEmpty then .null else toJson [path, p, s]
  | _ => .null

private def sign (call : Json) : Prog Json := do
  let key ← Prog.effect "derivedKey" [.str "broods-run-token"]
  let _ ← Prog.effect "createHmac" [.str "sha256", key]
  let _ ← Prog.effect "createHmac(\"sha256\", derivedKey(HKDF_INFO)).update" [Twin.callArg call 0]
  Prog.effect "createHmac(\"sha256\", derivedKey(HKDF_INFO)).update(payload).digest"

private def subagentKeyTag (call : Json) : Prog Json := do
  let key ← Prog.effect "derivedKey" [.str "broods-subagent-key"]
  let _ ← Prog.effect "createHmac" [.str "sha256", key]
  let _ ← Prog.effect "createHmac(\"sha256\", derivedKey(SUBAGENT_KEY_HKDF_INFO)) .update" [Twin.callArg call 0]
  let hex ← Prog.effect "createHmac(\"sha256\", derivedKey(SUBAGENT_KEY_HKDF_INFO)) .update(scope) .digest" [.str "hex"]
  return .str (String.ofList ((text hex).toList.take 32))

private def sealTerminalTicket (call : Json) : Prog Json := do
  let iv ← Prog.effect "randomBytes" [toJson (12 : Nat)]
  let key ← Prog.effect "ticketKey" [Twin.callArg call 1]
  let _ ← Prog.effect "createCipheriv" [.str "aes-256-gcm", key, iv, obj [("authTagLength", toJson (16 : Nat))]]
  let head ← Prog.effect "cipher.update" [.str (Twin.jsonStringify 4 (Twin.callArg call 0)), .str "utf-8"]
  let tail ← Prog.effect "cipher.final"
  let tag ← Prog.effect "cipher.getAuthTag"
  return .str (".".intercalate ["st1", urlOf iv, urlOf tag, Crypto.base64UrlEncode (bytesOf head ++ bytesOf tail)])

private def sealCredential (call : Json) : Prog Json := do
  let iv ← Prog.effect "crypto.getRandomValues" [bytesJson (List.replicate 12 0)]
  let key ← Prog.effect "credentialKey" [Twin.callArg call 1]
  let ciphertext ← Prog.effect "crypto.subtle.encrypt"
    [obj [("name", .str "AES-GCM"), ("iv", iv)], key, bytesJson (Crypto.utf8 (text (Twin.callArg call 0)))]
  Prog.effect "bytesToBase64Url" [bytesJson (bytesOf iv ++ bytesOf ciphertext)]

private def openCredential (call : Json) : Prog Json := do
  let sealed := Twin.callArg call 0
  if !sealed.getStr?.isOk then return .null
  Prog.catchFail (do
    let raw ← Prog.effect "base64UrlToBytes" [sealed]
    let bytes := bytesOf raw
    let key ← Prog.effect "credentialKey" [Twin.callArg call 1]
    let plain ← Prog.effect "crypto.subtle.decrypt"
      [obj [("name", .str "AES-GCM"), ("iv", bytesJson (bytes.take 12))], key, bytesJson (bytes.drop 12)]
    match utf8Text (bytesOf plain) with
    | some value => return .str value
    | none => Prog.unsupported "TextDecoder replacement characters")
    (fun err => if (prop err "$unsupported").isSome then Prog.fail err else pure .null)

/-- The first `/v1/runs/<id>` in `statusUrl`, where `<id>` runs up to `/`, `?` or `#`. -/
private def runsPath (url : String) : Option String :=
  let marker := "/v1/runs/"
  let rec scan (fuel : Nat) (rest : List Char) : Option String :=
    match fuel, rest with
    | 0, _ | _, [] => none
    | fuel + 1, chars@(_ :: tail) =>
      if chars.take marker.length == marker.toList then
        let id := (chars.drop marker.length).takeWhile fun c => !['/', '?', '#'].contains c
        if id.isEmpty then scan fuel tail else some (marker ++ String.ofList id)
      else scan fuel tail
  scan (url.length + 1) url.toList

private def fetchStatus (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let runId := Twin.callArg call 1
  let path :=
    if truth runId then some ("/v1/runs/" ++ encodeURIComponent (text runId))
    else if truth (Twin.callArg call 3) then runsPath (text (Twin.callArg call 3)) else none
  match path with
  | none => return obj []
  | some value =>
    let headers ← Prog.effect "coreHeaders" [socket]
    let response ← Prog.effect "fetch"
      [.str (text (field (field socket "data") "coreBaseUrl") ++ value),
       obj [("headers", headers), ("signal", Twin.callArg call 2)]]
    Prog.effect "responseJson" [response]

private def decodeNatsStreamEvent (call : Json) : Prog Json := do
  match utf8Text (bytesOf (Twin.callArg call 0)) with
  | none => Prog.unsupported "TextDecoder replacement characters"
  | some decoded =>
    let parsed ← Prog.effect "parseJson" [.str decoded]
    return if isObjectLike parsed && field parsed "type" == .str "stream" then parsed else .null

private def statusFingerprint (call : Json) : Prog Json := do
  let status := Twin.callArg call 0
  let error ← Prog.effect "errorText" [field status "error"]
  let cell (v : Json) : String := if v == Twin.undefinedJson then "null" else jsonScalar v
  return .str ("[" ++ ",".intercalate
    [cell (field status "status"), cell (field status "appliedMode"), cell (field status "appliedToEventId"), cell error] ++ "]")

private def orEmpty (v : Json) : Json := if v == Twin.undefinedJson then obj [] else v

private def errorResponse (call : Json) : Prog Json := do
  let status := Twin.callArg call 0
  let body ← Prog.effect "apiErrorBody" [status, Twin.callArg call 1, orEmpty (Twin.callArg call 2)]
  Prog.effect "jsonResponse" [status, body, orEmpty (Twin.callArg call 3)]

private def parseGatewayMessage (call : Json) : Prog Json := do
  let raw := Twin.callArg call 0
  let decoded ← match raw with
    | .str value => pure value
    | _ => match utf8Text (bytesOf raw) with
      | some value => pure value
      | none => Prog.unsupported "TextDecoder replacement characters"
  let parsed ← Prog.effect "parseJson" [.str decoded]
  if !truth parsed || !isObjectLike parsed then return .null
  let check (label : String) : Prog Json := do
    let valid ← Prog.effect label [parsed]
    return if truth valid then parsed else .null
  match field parsed "type" with
  | .str "cancel" => return obj [("type", .str "cancel")]
  | .str "control" => check "isControlMessage"
  | .str "attach" => check "isAttachMessage"
  | _ => check "isExecuteMessage"

/-- The recording erases the class, so `instanceof` is read off the message only these two classes build. -/
private def accountErrorStatus (message : String) : Nat :=
  if message == "Unauthorized" then 401
  else if startsWith message "Sandbox provider \"" && endsWith message "\" is unreachable" then 502
  else 400

private def errorResponseForError (call : Json) : Prog Json := do
  let err := Twin.callArg call 0
  match prop err "$error" with
  | none => Prog.effect "errorResponse" [toJson (400 : Nat), .str "Invalid request"]
  | some detail =>
    if detail.getObjValD "name" != .str "Error" then return ← Prog.unsupported "error subclass"
    let message := text (field detail "message")
    Prog.effect "errorResponse" [toJson (accountErrorStatus message), .str message]

private def retiredImageOptionsRefusal (call : Json) : Prog Json := do
  let config := Twin.callArg call 2
  let options := field config "options"
  let outcome ← Prog.attempt "assertNoRetiredImageOptions"
    [field config "provider", if options == .null || options == Twin.undefinedJson then obj [] else options]
  match outcome with
  | .ok _ => return .null
  | .pending => Prog.unsupported "check never settled"
  | .threw err _ =>
    let refusal ← Prog.effect "clientErrorData" [err]
    if !truth refusal then discard <| Prog.effect "errorText" [err]
    Prog.effect "errorResponse" [toJson (400 : Nat),
      if truth refusal then field refusal "message" else .str "Invalid sandbox configuration"]

private def deleteAccountBundles (call : Json) : Prog Json := do
  let bucket ← Prog.effect "requireEnv" [.str "TOOL_BUNDLES_BUCKET_NAME"]
  let encoded := encodeURIComponent (text (Twin.callArg call 0))
  let outcomes ← Prog.all
    [("deleteS3Prefix", [bucket, .str ("account-hooks/" ++ encoded ++ "/")]),
     ("deleteS3Prefix", [bucket, .str ("account-mcp/" ++ encoded ++ "/")])]
  match outcomes with
  | [.ok (.num hooks), .ok (.num mcp)] => return .num (numAdd hooks mcp)
  | [.threw err _, _] | [_, .threw err _] => Prog.fail err
  | _ => Prog.unsupported "non-numeric deletion count"

private def deleteAccountSkills (call : Json) : Prog Json := do
  let bucket ← Prog.effect "skillsBucketName"
  Prog.effect "deleteS3Prefix" [bucket, .str (text (Twin.callArg call 0) ++ "/")]

private def isDottedQuad (host : String) : Bool :=
  match host.splitOn "." with
  | [a, b, c, d] => [a, b, c, d].all fun part => !part.isEmpty && part.length ≤ 3 && part.toList.all Char.isDigit
  | _ => false

private def isPrivateHostname (call : Json) : Prog Json := do
  let lowered := (text (Twin.callArg call 0)).toLower
  let unopened := if startsWith lowered "[" then dropChars lowered 1 else lowered
  let bare := if endsWith unopened "]" then String.ofList unopened.toList.dropLast else unopened
  let host := if endsWith bare "." then String.ofList bare.toList.dropLast else bare
  if host == "localhost" || [".localhost", ".local", ".internal"].any (endsWith host) then
    return .bool true
  if isDottedQuad host || includes host ":" then
    if startsWith host "::ffff:" then return .bool true
    return ← Prog.effect "isDeniedAddress" [.str host]
  return .bool false

/-- The values of settled `Promise.all` work, or its rejection. Two rejections have no fixed winner. -/
private def settled (outcomes : List Outcome) : Prog (List Json) := do
  let errors := outcomes.filterMap fun | .threw e _ => some e | _ => none
  match errors with
  | [e] => Prog.fail e
  | _ :: _ :: _ => Prog.unsupported "several rejections race"
  | [] => pure (outcomes.filterMap fun | .ok v => some v | _ => none)

private def dedupe (values : List Json) : List Json :=
  values.foldl (fun seen v => if seen.contains v then seen else seen ++ [v]) []

private def reservationKeys (account : Json) : Nat → Json → List Json → Prog (List Json)
  | 0, _, _ => Prog.unsupported "more reservation pages than the model allows"
  | fuel + 1, cursor, keys => do
    let page ← Prog.effect "runtime.query"
      [.str "listAccountSandboxReservations", obj [("accountId", account), ("cursor", cursor)]]
    let keys := keys ++ (items (field page "page")).map (field · "reservationKey")
    let next := if truth (field page "isDone") then Json.null else field page "cursor"
    if next == .null then return keys
    reservationKeys account fuel next keys

private def deleteAccountRuntimeData (call : Json) : Prog Json := do
  let account := field (Twin.callArg call 0) "accountId"
  let _ ← Prog.effect "getStorage"
  let workspaces ← Prog.effect "getStorage().workspaceConfigs.list" [account]
  let keys ← reservationKeys account 256 .null []
  let released ← Prog.effect "releaseReservedSandboxes" [account, .arr (dedupe keys).toArray]
  let results ← settled (← Prog.all
    [("deleteConvexRuntimeRows", [account]), ("deleteWorkspaceFilesystems", [account, workspaces])])
  let _ ← Prog.effect "getStorage"
  let _ ← settled (← Prog.all
    [("getStorage().sandboxConfigs.removeAllForAccount", [account]), ("getStorage", []),
     ("getStorage().workspaceConfigs.removeAllForAccount", [account])])
  match results with
  | [runtime, deleted] =>
    return obj (entries runtime ++ [("filesystemObjectsDeleted", deleted), ("reservedSandboxesReleased", released)])
  | _ => Prog.unsupported "unfinished cleanup"

private def deleteAccountResponse (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let id := field account "accountId"
  let disabled ←
    if field account "status" == .str "disabled" then pure account else do
      let _ ← Prog.effect "getStorage"
      Prog.effect "getStorage().accounts.disable" [id]
  if !truth disabled then
    return ← Prog.effect "errorResponse" [toJson (404 : Nat), .str "Account not found", obj [("code", .str "account_not_found")]]
  let store := ("getStorage", ([] : List Json))
  let results ← settled (← Prog.all
    [("deleteAccountRuntimeData", [disabled]), store, ("getStorage().agents.removeAllForAccount", [id]),
     ("deleteAccountSkills", [id]), ("deleteAccountBundles", [id]), ("deleteAccountAttachments", [id]),
     store, ("getStorage().accountHooks.removeAllForAccount", [id]),
     store, ("getStorage().mcp.removeAllForAccount", [id]),
     store, ("getStorage().channelRecords.removeAllForAccount", [id])])
  let _ ← Prog.effect "getStorage"
  let _ ← Prog.effect "getStorage().accounts.remove" [id]
  match results with
  | [runtime, _, agents, skills, bundles, attachments, _, hooks, _, mcp, _, channels] =>
    Prog.effect "jsonResponse" [toJson (200 : Nat), obj [("deleted", .bool true), ("cleanup", obj (entries runtime ++
      [("agentsDeleted", agents), ("skillObjectsDeleted", skills), ("bundleObjectsDeleted", bundles),
       ("attachmentObjectsDeleted", attachments), ("accountHooksDeleted", hooks), ("mcpDeleted", mcp),
       ("channelRecordsDeleted", channels)]))]]
  | _ => Prog.unsupported "unfinished cleanup"

/-- The `::ffff:a.b.c.d` spelling the URL parser rewrites into two hex groups. -/
private def compressMappedIpv4 (host : String) : Option String :=
  match (host.splitOn ":").reverse with
  | last :: rest =>
    match last.splitOn "." |>.map String.toNat? with
    | [some a, some b, some c, some d] =>
      let group (hi lo : Nat) : String := String.ofList (Nat.toDigits 16 (hi * 256 + lo))
      some (":".intercalate ((group a b :: rest).reverse ++ [group c d]))
    | _ => some host
  | [] => none

private def urlSafe (c : Char) : Bool :=
  c.isAlphanum || "-._~/:%".toList.contains c

/-- `new URL(value)` over the shapes the model covers: `scheme://host[:port][/path]`. -/
private inductive ParsedUrl where
  | invalid
  | other (reason : String)
  | ok (protocol hostname href : String)

private def parseUrl (value : String) : ParsedUrl :=
  match value.splitOn "://" with
  | [scheme, rest] =>
    if scheme.isEmpty || !(scheme.toList.all Char.isAlphanum) then .invalid else
    let protocol := scheme.toLower ++ ":"
    let authority := String.ofList (rest.toList.takeWhile (· != '/'))
    let path := dropChars rest authority.length
    if !path.toList.all urlSafe || authority.isEmpty then .other "URL outside the modelled shape" else
    let lower := authority.toLower
    let (hostRaw, port) : String × String :=
      if startsWith lower "[" then
        match lower.splitOn "]" with
        | [h, p] => (h ++ "]", p)
        | _ => (lower, "")
      else
        match lower.splitOn ":" with
        | [h, p] => (h, ":" ++ p)
        | _ => (lower, "")
    if port == ":443" || port == ":80" || port == ":21" then .other "default port" else
    let hostname :=
      if startsWith hostRaw "[" then
        match compressMappedIpv4 (String.ofList (hostRaw.toList.drop 1).dropLast) with
        | some inner => "[" ++ inner ++ "]"
        | none => hostRaw
      else hostRaw
    .ok protocol hostname (protocol ++ "//" ++ hostname ++ port ++ (if path.isEmpty then "/" else path))
  | _ => if value.toList.contains ' ' || !value.toList.contains ':' then .invalid else .other "URL outside the modelled shape"

private def assertPublicHttpsUrl (call : Json) : Prog Json := do
  let label := text (Twin.callArg call 1)
  match parseUrl (text (Twin.callArg call 0)) with
  | .invalid => Prog.throwError "Error" (label ++ " must be a valid URL")
  | .other reason => Prog.unsupported reason
  | .ok protocol hostname href =>
    if protocol != "https:" then return ← Prog.throwError "Error" (label ++ " must use https")
    let privateHost ← Prog.effect "isPrivateHostname" [.str hostname]
    if truth privateHost then
      return ← Prog.throwError "Error" (label ++ " must not point to a private or internal address")
    return obj [("$url", .str href)]

private def segment : String := "[^/]+"
private def rule (path : String) (methods : List String := []) : Json :=
  obj ([("path", .str path)] ++ if methods.isEmpty then [] else [("methods", toJson methods)])
private def router (name upstream limit : String) (rules : List Json) (secretPath : Bool := false) : Json :=
  obj ([("name", .str name), ("upstream", .str upstream), ("limit", .str limit), ("rules", .arr rules.toArray)] ++
    if secretPath then [("secretPath", .bool true)] else [])

/-- `ROUTERS` in `apps/edge/src/routes.ts`. First match wins. -/
private def routers : List Json :=
  [router "health" "gateway" "none" [rule "/(?:healthz)?" ["GET"]],
   router "sockets" "gateway" "upgrade"
    [rule "/v1/sandboxes/terminal/ws", rule "/v1/machines/ws",
     rule s!"/v1/projects/{segment}/stages/{segment}/observability/ws",
     rule s!"/v1/(?:projects/{segment}/stages/{segment}/)?agents/{segment}/ws"],
   router "downloads" "config" "http" [rule s!"/v1/downloads/{segment}" ["GET", "HEAD"]] true,
   router "config" "config" "http"
    [rule "/v1/account" ["GET", "PATCH"], rule "/v1/account/.*[^/]", rule "/v1/accounts" ["GET"],
     rule s!"/v1/accounts/{segment}" ["GET", "PATCH"],
     rule s!"/v1/accounts/{segment}/rotate-secret" ["POST"],
     rule "/v1/agents" ["GET", "POST"], rule s!"/v1/agents/{segment}" ["GET", "PATCH", "DELETE"],
     rule s!"/v1/agents/{segment}/channels/{segment}/directory" ["GET"],
     rule "/v1/env" ["GET"], rule s!"/v1/env/{segment}" ["PUT", "DELETE"],
     rule s!"/v1/workspaces/{segment}/download-links" ["POST"],
     rule "/v1/audit(?:/verify)?" ["GET"], rule "/v1/usage" ["GET"],
     rule "/v1/audit/sink" ["GET", "PUT", "DELETE"],
     rule s!"/v1/(?:skills|mcp|hooks|workspaces|sandboxes|policies|roles|channels|crons)(?:/{segment})?",
     rule s!"/v1/workspaces/{segment}/files", rule s!"/v1/crons/{segment}/runs"],
   router "secret-webhooks" "core" "none"
    [rule s!"/v1/webhooks/{segment}(?:/dev/{segment})?/pancake",
     rule "/v1/webhooks/.*[^/]" ["GET"]] true,
   router "webhooks" "core" "none" [rule "/v1/webhooks/.*[^/]"],
   router "media" "core" "none" [rule "/v1/media/.*[^/]" ["GET", "HEAD"], rule "/v1/mcp-connections/callback" ["GET"]] true,
   router "core" "core" "http"
    [rule "/v1(?:/.*)?", rule "/mcp", rule "/\\.well-known/oauth-protected-resource(?:/mcp)?"]]

private inductive CharClass where
  | lit (c : Char)
  | notSlash
  | notLineEnd

private def CharClass.accepts : CharClass → Char → Bool
  | .lit expected, c => c == expected
  | .notSlash, c => c != '/'
  | .notLineEnd, c => !isLineTerminator c

/-- The regular expressions `ROUTERS` uses: literals, `.`, `[^/]`, `*`, `+`, and `(?:a|b)` with `?`. -/
private inductive Node where
  | one (cls : CharClass)
  | star (cls : CharClass)
  | group (alternatives : List (List Node)) (optional : Bool)

mutual
  private def parseAlternatives : Nat → List Char → List (List Node) × List Char
    | 0, rest => ([], rest)
    | fuel + 1, chars =>
      let (first, rest) := parseSequence fuel chars
      match rest with
      | '|' :: more =>
        let (others, after) := parseAlternatives fuel more
        (first :: others, after)
      | _ => ([first], rest)

  private def parseSequence : Nat → List Char → List Node × List Char
    | 0, rest => ([], rest)
    | _, [] => ([], [])
    | fuel + 1, chars@(c :: tail) =>
      match chars with
      | ')' :: _ | '|' :: _ => ([], chars)
      | '(' :: '?' :: ':' :: inner =>
        let (alternatives, after) := parseAlternatives fuel inner
        let afterClose := after.drop 1
        let (optional, rest) := match afterClose with
          | '?' :: more => (true, more)
          | _ => (false, afterClose)
        let (nodes, final) := parseSequence fuel rest
        (.group alternatives optional :: nodes, final)
      | '\\' :: escaped :: more => parseQuantified fuel (.lit escaped) more
      | '[' :: '^' :: '/' :: ']' :: more => parseQuantified fuel .notSlash more
      | '.' :: more => parseQuantified fuel .notLineEnd more
      | _ => parseQuantified fuel (.lit c) tail

  private def parseQuantified : Nat → CharClass → List Char → List Node × List Char
    | 0, _, rest => ([], rest)
    | fuel + 1, cls, chars =>
      match chars with
      | '*' :: more =>
        let (nodes, rest) := parseSequence fuel more
        (.star cls :: nodes, rest)
      | '+' :: more =>
        let (nodes, rest) := parseSequence fuel more
        (.one cls :: .star cls :: nodes, rest)
      | _ =>
        let (nodes, rest) := parseSequence fuel chars
        (.one cls :: nodes, rest)
end

/-- Whether `nodes` match all of `chars`, trying every backtrack. `fuel` bounds the search depth. -/
private def matchNodes : Nat → List Node → List Char → Bool
  | 0, _, _ => false
  | _ + 1, [], chars => chars.isEmpty
  | fuel + 1, .one cls :: rest, chars =>
    match chars with
    | c :: tail => cls.accepts c && matchNodes fuel rest tail
    | [] => false
  | fuel + 1, .star cls :: rest, chars =>
    (match chars with
      | c :: tail => cls.accepts c && matchNodes fuel (.star cls :: rest) tail
      | [] => false) || matchNodes fuel rest chars
  | fuel + 1, .group alternatives optional :: rest, chars =>
    alternatives.any (fun alt => matchNodes fuel (alt ++ rest) chars) || (optional && matchNodes fuel rest chars)

private def pathMatches (pattern path : String) : Bool :=
  let (nodes, _) := parseSequence (pattern.length * 3 + 8) pattern.toList
  matchNodes ((path.length + pattern.length) * 4 + 8) nodes path.toList

private def resolveRouter (call : Json) : Prog Json := do
  let stripped ← Prog.effect "stripTrailingSlashes" [Twin.callArg call 1]
  let path := if truth stripped then text stripped else "/"
  let upper := (text (Twin.callArg call 0)).toUpper
  let ruleHits (r : Json) : Bool :=
    (!truth (field r "methods") || (items (field r "methods")).contains (.str upper)) &&
      pathMatches (text (field r "path")) path
  return (routers.find? fun r => (items (field r "rules")).any ruleHits).getD .null

private def defaultOrigins : Json :=
  toJson (["broods.app", "*.broods.app", "localhost", "127.0.0.1"] : List String)

private def edgeName (name : String) : String := "broods-edge-" ++ name

private def indexed (values : List Json) : List (Nat × Json) :=
  (List.range values.length).zip values

private def renderFileConfig (call : Json) : Prog Json := do
  let origins := if Twin.callArg call 1 == Twin.undefinedJson then defaultOrigins else Twin.callArg call 1
  let mut rendered : List (String × Json) := []
  for (index, r) in indexed routers do
    let ruleText ← Prog.effect "routerRule" [r]
    let order ← Prog.effect "priority" [toJson index]
    let names ← Prog.effect "routerMiddlewares" [r, .bool false]
    let extra ← Prog.effect "observability" [r]
    rendered := rendered ++ [(edgeName (text (field r "name")), obj
      ([("rule", ruleText), ("priority", order), ("entryPoints", toJson ["web"]),
        ("middlewares", .arr ((items names).map (fun n => Json.str (edgeName (text n)))).toArray),
        ("service", .str (edgeName (text (field r "upstream"))))] ++ entries extra))]
  let services := (entries (Twin.callArg call 0)).map fun (name, url) =>
    (edgeName name, obj [("loadBalancer", obj
      [("servers", .arr #[obj [("url", url)]]), ("passHostHeader", .bool false)])])
  let bodies ← Prog.effect "middlewares" [origins]
  let mut renamed : List (String × Json) := []
  for (name, body) in entries bodies do
    let full ← Prog.effect "middlewareName" [.str name]
    renamed := renamed ++ [(text full, body)]
  return obj [("http", obj [("routers", obj rendered), ("middlewares", obj renamed), ("services", obj services)])]

private def renderKubernetes (call : Json) : Prog Json := do
  let ns := Twin.callArg call 1
  let apiVersion := Json.str "traefik.io/v1alpha1"
  let bodies ← Prog.effect "middlewares" [defaultOrigins]
  let mut resources : List Json := []
  for (name, body) in entries bodies do
    let full ← Prog.effect "middlewareName" [.str name]
    resources := resources ++ [obj [("apiVersion", apiVersion), ("kind", .str "Middleware"),
      ("metadata", obj [("name", full), ("namespace", ns)]), ("spec", body)]]
  for stage in items (Twin.callArg call 0) do
    let mut routes : List Json := []
    for (index, r) in indexed routers do
      let service := field (field stage "upstreams") (text (field r "upstream"))
      let ruleText ← Prog.effect "routerRule" [r]
      let order ← Prog.effect "priority" [toJson index]
      let names ← Prog.effect "routerMiddlewares" [r, .bool true]
      let mut refs : List Json := []
      for n in items names do
        let full ← Prog.effect "middlewareName" [n]
        refs := refs ++ [obj [("name", full)]]
      let extra ← Prog.effect "observability" [r]
      routes := routes ++ [obj ([("kind", .str "Rule"),
        ("match", .str ("Host(`" ++ text (field stage "host") ++ "`) && (" ++ text ruleText ++ ")")),
        ("priority", order), ("middlewares", .arr refs.toArray),
        ("services", .arr #[obj ([("name", field service "name")] ++
          (if truth (field service "namespace") then [("namespace", field service "namespace")] else []) ++
          [("port", field service "port"), ("passHostHeader", .bool false)])])] ++ entries extra)]
    resources := resources ++ [obj [("apiVersion", apiVersion), ("kind", .str "IngressRoute"),
      ("metadata", obj [("name", .str (edgeName (text (field stage "name")))), ("namespace", ns)]),
      ("spec", obj [("entryPoints", toJson ["websecure"]), ("routes", .arr routes.toArray),
        ("tls", obj [("secretName", field stage "tlsSecret")])])]]
  return .arr resources.toArray

private def isUnsupportedError (err : Json) : Bool := (prop err "$unsupported").isSome

private def accountHandler (call : Json) : Prog Json := do
  let _ ← Prog.drain (fun _ _ => pure ()) 1
  Prog.effect "handleAccountRequest" [Twin.callArg call 0]

private def handleSandboxLifecycleRoute (call : Json) : Prog Json := do
  let auth := Twin.callArg call 0
  let isRole := field auth "kind" == .str "role"
  let accountId ← if isRole then pure (field (field auth "account") "accountId") else do
    let account ← Prog.effect "requireAccountAuth" [auth, obj [("allowServiceToken", .bool true)]]
    pure (field account "accountId")
  let method := Twin.callArg call 1
  if method != .str "POST" then
    return ← Prog.effect "methodNotAllowed" [toJson ["POST"]]
  let sandboxId ← match decodeURIComponent (text (Twin.callArg call 2)) with
    | some value => pure (Json.str value)
    | none => Prog.unsupported "URIError text is engine-specific"
  let _ ← Prog.effect "getStorage"
  let record ← Prog.effect "getStorage().sandboxConfigs.getById" [accountId, sandboxId]
  let denial ← if !isRole then pure Json.null else do
    let principal ← Prog.effect "rolePrincipal" [field auth "role"]
    Prog.effect "roleDenial" [principal, method, obj
      ([("type", .str "sandboxes"), ("id", sandboxId)] ++ optional record ["projectId", "stageId"])]
  if truth denial then return ← Prog.effect "errorResponse" [toJson (403 : Nat), denial]
  if !truth record then return ← Prog.effect "errorResponse" [toJson (404 : Nat), .str "Sandbox not found"]
  Prog.effect "handleSandboxLifecycle" [auth, accountId, record, Twin.callArg call 3, Twin.callArg call 4]

private def lifecycleActions : List String :=
  ["suspend", "resume", "terminate", "snapshot", "refresh", "exec", "terminal"]

private def accountRoutes (request auth : Json) (method rawPath : String) : Prog Json := do
  let mcp ← Prog.effect "handleMcpServiceRoute" [auth, .str method, .str rawPath, request]
  if truth mcp then return mcp
  match rawPath.splitOn "/" with
  | ["", "v1", "sandboxes", id, action] =>
    if !id.isEmpty && lifecycleActions.contains action then
      return ← Prog.effect "handleSandboxLifecycleRoute" [auth, .str method, .str id, .str action, request]
  | _ => pure ()
  if field auth "kind" != .str "admin" then
    return ← Prog.effect "errorResponse" [toJson (403 : Nat), .str "Forbidden"]
  if method == "POST" && rawPath == "/v1/accounts" then
    let body ← Prog.effect "parseJsonBody" [request]
    let _ ← Prog.effect "getStorage"
    let input ← Prog.effect "normalizeCreateAccountInput" [body]
    let created ← Prog.effect "getStorage().accounts.create" [input]
    let account ← Prog.effect "toCreateAccountResponse" [field created "account"]
    return ← Prog.effect "jsonResponse" [toJson (201 : Nat), obj [("account", account), ("secret", field created "secret")]]
  match rawPath.splitOn "/" with
  | ["", "v1", "accounts", raw] =>
    if !raw.isEmpty && method == "DELETE" then
      let accountId ← match decodeURIComponent raw with
        | some value => pure (Json.str value)
        | none => Prog.unsupported "URIError text is engine-specific"
      let _ ← Prog.effect "getStorage"
      let account ← Prog.effect "getStorage().accounts.getById" [accountId]
      if !truth account then
        return ← Prog.effect "errorResponse" [toJson (404 : Nat), .str "Account not found"]
      return ← Prog.effect "deleteAccountResponse" [account]
  | _ => pure ()
  Prog.effect "errorResponse" [toJson (404 : Nat), .str "Not found"]

private def handleAccountRequest (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let method := text (field request "method")
  let rawPath ← Prog.effect "normalizePath" [field request "path"]
  let path := text rawPath
  Prog.catchFail (do
    let selfDelete := method == "DELETE" && path == "/v1/account"
    let auth ← Prog.effect "resolveBearerAuth" [field request "headers", obj [("allowDisabledAccountSecret", .bool selfDelete)]]
    if !truth auth then
      return ← Prog.effect "errorResponse" [toJson (401 : Nat), .str "Unauthorized"]
    if selfDelete then
      let account ← Prog.effect "requireAccountAuth" [auth]
      return ← Prog.effect "deleteAccountResponse" [account]
    accountRoutes request auth method path)
    (fun err => do
      if isUnsupportedError err then return ← Prog.fail err
      let _ ← Prog.effect "errorText" [err]
      Prog.effect "errorResponseForError" [err])

private def isNullish (v : Json) : Bool := v == .null || v == Twin.undefinedJson
private def coalesce (a b : Json) : Json := if isNullish a then b else a
private def defined (pairs : List (String × Json)) : Json :=
  obj (pairs.filter fun pair => pair.2 != Twin.undefinedJson)
private def trimmedField (v : Json) (key : String) : String :=
  match field v key with | .str s => trim s | _ => ""

/-- Whether the sandbox executor has an optional method. Provider classes are recorded opaquely. -/
private def executorHas (executor : Json) (method : String) : Bool :=
  match field executor "$opaque" with
  | .str "CloudflareSandboxExecutor" => ["getInstanceInfo", "release"].contains method
  | .str _ => true
  | _ => truth (field executor method)

/-- `auditedSandboxCall`, the callback it enters, and the executor call made inside that callback. -/
private def callThrough (context : Json) (label : String) (argument : Json) : Prog Json := do
  let _ ← Prog.drain (fun _ _ => pure ()) 1
  let _ ← Prog.attempt label [argument]
  let outer ← Prog.attempt "auditedSandboxCall" [context, obj [("$fn", .str "")]]
  match outer with
  | .ok value => return value
  | .threw error _ => Prog.fail error
  | .pending => Prog.unsupported "audited call never settled"

/-- `auditedSandboxCall(context, () => context.executor.<method>(ref))`. -/
private def audited (context : Json) (label : String) : Prog Json := do
  callThrough context label (field context "ref")

private def auditThen (context : Json) (result : String) (details : List (String × Json)) : Prog Unit := do
  let _ ← Prog.effect "context.audit" [.str result, defined details]
  let _ := context
  return ()

private def refuse (context : Json) (status : Nat) (message : String) : Prog Json := do
  auditThen context "error" [("errorMessage", .str message)]
  Prog.effect "errorResponse" [toJson status, .str message]

private def clientErrorStatus (code : String) : Nat :=
  match code with
  | "invalid_request" => 400 | "unauthorized" => 401 | "payment_required" => 402
  | "forbidden" => 403 | "not_found" => 404 | _ => 409

private def snapshotSandbox (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  if !executorHas (field context "executor") "snapshot" then
    return ← Prog.effect "unsupportedSandboxAction" [context, .str "snapshot"]
  let name := trimmedField (field context "body") "name"
  if name.isEmpty then return ← refuse context 400 "name is required"
  let result ← audited context "context.executor.snapshot"
  let externalImageId := coalesce (field result "externalImageId") (field result "snapshotId")
  let status := coalesce (field result "status") (.str "active")
  let provider := field context "provider"
  let baseImage ← if provider == .str "lambda" then Prog.effect "lambdaBaseImage" [context] else pure provider
  let upsert ← Prog.attempt "upsertSandboxSnapshot" [obj
    [("accountId", field context "accountId"), ("scope", field context "scope"), ("name", .str name),
     ("provider", provider), ("baseImage", baseImage), ("externalImageId", externalImageId), ("status", status)]]
  match upsert with
  | .pending => Prog.unsupported "upsert never settled"
  | .threw err _ =>
    let refusal ← Prog.effect "clientErrorData" [err]
    if !truth refusal then return ← Prog.fail err
    let message := text (field refusal "message")
    auditThen context "error" [("errorMessage", .str message)]
    Prog.effect "errorResponse" [toJson (clientErrorStatus (text (field refusal "code"))), .str message]
  | .ok _ =>
    auditThen context "ok" [("status", .str "running")]
    Prog.effect "jsonResponse" [toJson (200 : Nat), defined
      [("status", status), ("snapshotId", field result "snapshotId"), ("externalImageId", externalImageId)]]

/-- `queueMirrorStatus`: the status write runs inside the queued callback, on the row's lane. -/
private def queueMirrorStatus (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let changed ← Prog.input fun
    | none => pure (Json.bool false)
    | some _ => Prog.effect "setSandboxInstanceStatus"
        [field context "accountId", field context "reservationKey", Twin.callArg call 1,
         Twin.callArg call 2]
  let _ ← Prog.effect "queueMirrorWrite"
    [field context "accountId", field context "reservationKey",
     obj [("kind", .str "status"), ("send", obj [("$fn", .str "send")])]]
  return changed

private def refreshSandboxStatus (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  if !executorHas (field context "executor") "getInstanceInfo" then
    return ← Prog.effect "unsupportedSandboxAction" [context, .str "instance status refresh"]
  let account := field context "accountId"
  let key := field context "reservationKey"
  let reserved ← Prog.effect "getSandboxExternalId" [field context "provider", key]
  let info ← audited context "context.executor.getInstanceInfo"
  let state := field info "state"
  if !truth info || state == .str "terminating" then
    let removedId := coalesce (field info "externalId") (coalesce reserved Twin.undefinedJson)
    let _ ← Prog.effect "queueMirrorRemove" [account, key, removedId]
    auditThen context "ok" [("status", .str "terminating")]
    return ← Prog.effect "jsonResponse" [toJson (200 : Nat), obj [("status", .str "terminated")]]
  let status := if state == .str "unknown" then Json.str "error" else state
  let errorMessage := coalesce (field info "errorMessage")
    (if state == .str "unknown" then .str "provider reported an unrecognised state" else Twin.undefinedJson)
  let changed ← Prog.effect "queueMirrorStatus"
    [context, status, defined [("observed", .bool true), ("errorMessage", errorMessage)]]
  if truth changed then
    auditThen context (if status == .str "error" then "error" else "ok") [("status", status), ("errorMessage", errorMessage)]
  Prog.effect "jsonResponse" [toJson (200 : Nat), defined [("status", status), ("externalId", field info "externalId")]]

private def terminateSandbox (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  if !executorHas (field context "executor") "release" then
    return ← Prog.effect "unsupportedSandboxAction" [context, .str "terminate"]
  let account := field context "accountId"
  let key := field context "reservationKey"
  let provider := field context "provider"
  let _ ← audited context "context.executor.release"
  let _ ← Prog.effect "deleteSandboxInstance" [provider, key, account]
  let _ ← Prog.effect "queueMirrorRemove" [account, key]
  auditThen context "ok" [("status", .str "terminating")]
  Prog.effect "jsonResponse" [toJson (200 : Nat), obj [("status", .str "terminated")]]

private def execSandbox (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let body := field context "body"
  let config := field context "config"
  let code := match field body "code" with | .str s => s | _ => ""
  if (trim code).isEmpty then return ← refuse context 400 "code is required"
  if utf16Length code > 20000 then return ← refuse context 400 "code must be 20000 characters or less"
  let limits ← Prog.effect "workspaceSandboxLimits" [field context "provider"]
  let timeoutSeconds ← Prog.effect "boundedInteger"
    [field body "timeoutSeconds", coalesce (field config "timeout") (field limits "defaultTimeoutSeconds"), field limits "maxTimeoutSeconds"]
  let outputLimit ← Prog.effect "boundedInteger"
    [field body "outputLimitBytes", coalesce (field config "outputLimitBytes") (field limits "defaultOutputLimitBytes"), field limits "maxOutputLimitBytes"]
  let key := field context "reservationKey"
  let result ← callThrough context "context.executor.run"
    (obj [("code", .str code), ("reservationKey", key), ("timeoutSeconds", timeoutSeconds), ("outputLimitBytes", outputLimit)])
  let _ ← Prog.effect "queueMirrorStatus" [context, .str "running"]
  let truncated := Json.bool (field result "truncated" == .bool true)
  auditThen context (if truth (field result "ok") then "ok" else "error")
    [("status", .str "running"), ("exitCode", field result "exitCode"), ("durationMs", field result "durationMs"), ("truncated", truncated)]
  Prog.effect "jsonResponse" [toJson (200 : Nat), defined
    [("ok", field result "ok"), ("runtime", field result "runtime"), ("exitCode", field result "exitCode"),
     ("stdout", field result "stdout"), ("stderr", field result "stderr"), ("durationMs", field result "durationMs"),
     ("truncated", truncated), ("provider", field result "provider")]]

private def ticketTtl : Nat := 120000

private def laterThan (now : Json) (delta : Nat) : Json :=
  match now with
  | .num n => .num (numAdd n (natNum delta))
  | _ => .null

private def replaceHttpPrefix (url : String) : String :=
  if startsWith url "http" then "ws" ++ dropChars url 4 else url

private def openSandboxTerminal (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let provider := field context "provider"
  let name := text provider
  if !["sandbox", "lambda", "cloudflare"].contains name then
    return ← Prog.effect "unsupportedSandboxAction" [context, .str "a live terminal"]
  let account := field context "accountId"
  let key := field context "reservationKey"
  let externalId ← Prog.effect "getSandboxExternalId" [provider, key]
  if !truth externalId then
    return ← refuse context 404 "No reserved sandbox instance for this reservation key"
  let executor := field context "executor"
  if executorHas executor "getInstanceInfo" && executorHas executor "resume" then
    let info ← Prog.effect "context.executor.getInstanceInfo" [field context "ref"]
    if field info "state" == .str "suspended" then
      let _ ← audited context "context.executor.resume"
      let _ ← Prog.effect "queueMirrorStatus" [context, .str "running"]
  let mut bearerExpiresAt : Option Json := none
  let mut target : List (String × Json) := []
  if name == "lambda" then
    match ← Prog.attempt "microvmShellConnection" [externalId] with
    | .ok shell => target := entries shell ++ [("authorizationHeader", .str "X-aws-proxy-auth")]
    | .pending => return ← Prog.unsupported "connection never settled"
    | .threw error _ =>
      let message ← Prog.effect "errorText" [error]
      auditThen context "error" [("errorMessage", message)]
      return ← Prog.effect "errorResponse" [toJson (409 : Nat), .str
        ("MicroVM shell access unavailable (" ++ text message ++ "); terminate and re-reserve the instance to enable the live terminal")]
  else if name == "cloudflare" then
    let info ← audited context "context.executor.getInstanceInfo"
    if !truth info then
      auditThen context "error" [("errorMessage", .str "Container is not running")]
      return ← Prog.effect "errorResponse" [toJson (409 : Nat), .str "The Cloudflare container is not running; run a command to start it"]
    let connection ← Prog.effect "cloudflareConnection"
    let now ← Prog.effect "Date.now"
    let expires := laterThan now ticketTtl
    bearerExpiresAt := some expires
    let signed ← Prog.effect "signTerminalToken" [field connection "apiKey", externalId, expires]
    target :=
      [("url", .str (replaceHttpPrefix (text (field connection "baseURL")) ++ "/v1/sandboxes/" ++ text externalId ++
        "/terminal?name=" ++ encodeURIComponent (text (field context "name")))),
       ("authorization", .str ("Bearer " ++ text signed))]
  else
    let connection ← Prog.effect "workdirConnection" [field context "config"]
    let url ← Prog.effect "workdirPtyUrl" [field connection "baseUrl", externalId]
    target := [("url", url), ("authorization", .str ("Bearer " ++ text (field connection "apiKey")))]
  let expiresAt ← match bearerExpiresAt with
    | some value => pure value
    | none => do
      let now ← Prog.effect "Date.now"
      pure (laterThan now ticketTtl)
  let secrets ← Prog.effect "requireSecretsEnv" [.str "TERMINAL_TICKET_SECRET"]
  let token ← Prog.effect "sealTerminalTicket"
    [obj (target ++ [("accountId", account), ("expiresAt", expiresAt)]), (items secrets).headD Twin.undefinedJson]
  auditThen context "ok" [("status", .str "running")]
  Prog.effect "jsonResponse" [toJson (200 : Nat), obj
    [("token", token), ("expiresAt", expiresAt), ("websocketPath", .str "/v1/sandboxes/terminal/ws")]]

private def followAttachedExecution (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let active := Twin.callArg call 1
  let message := Twin.callArg call 2
  let snapshot := Twin.callArg call 6
  let replayFrom := Twin.callArg call 7
  let lastSequence := (field snapshot "lastSequence").getNat?.toOption.getD 0
  let buffered := (field snapshot "bufferedCount").getNat?.toOption.getD 0 > 0
  let (start, consumed) : Option Nat × Nat :=
    if buffered then
      match replayFrom.getNat?.toOption with
      | some from_ => (some (max 1 from_), max 1 from_ - 1)
      | none => (none, 0)
    else (some (lastSequence + 1), lastSequence)
  let _ ← Prog.drain (fun _ _ => pure ()) 4096
  let outcome ← Prog.attempt "followExecution"
    [socket, obj [("$signal", .bool false)], obj
      ([("connection", Twin.callArg call 5),
        ("scope", obj [("accountId", field (field socket "data") "accountId"), ("agentId", field message "agentId"),
          ("conversationKey", field active "publicConversationKey")]),
        ("eventId", field active "publicEventId"), ("eventKey", Twin.callArg call 8), ("snapshot", snapshot)] ++
       (match start with | some value => [("startSequence", toJson value)] | none => []) ++
       [("initialConsumedSequence", toJson consumed), ("isReplay", obj [("$fn", .str "isReplay")]),
        ("statusRequestId", field message "requestId"), ("runId", field message "runId"),
        ("statusUrl", Twin.callArg call 3), ("seedStatus", Twin.callArg call 4), ("terminalLabel", .str "Attached")])]
  match outcome with
  | .ok _ => return Twin.undefinedJson
  | .threw error _ => Prog.fail error
  | .pending => Prog.unsupported "follow never settled"

private def attachBody (call socket message active timer statusUrl : Json) : Prog Unit := do
  let unavailable (status : Json) : Prog Unit := do
    let _ ← Prog.effect "sendAgentTest" [socket, obj
      [("type", .str "replay_unavailable"), ("requestId", field message "requestId"),
       ("eventId", field message "eventId"), ("status", status), ("statusUrl", statusUrl)]]
    return ()
  let status ← Prog.effect "fetchStatus" [socket, field message "runId", obj [("$signal", .bool false)]]
  let state := field status "status"
  if !truth state || state == .str "not_found" then return ← unavailable (.str "not_found")
  let conversation := field active "publicConversationKey"
  let eventId := field active "publicEventId"
  if field status "agentId" != field message "agentId" || field status "conversationKey" != conversation ||
      field status "eventId" != eventId then
    return ← unavailable state
  let _ ← Prog.drain (fun _ _ => do
    let _ ← Prog.effect "sendAgentTest" [socket, obj [("type", .str "error"), ("error", .str "Attach timed out")]]
    let _ ← Prog.effect "stopActiveRun" [socket, active]
    pure ()) 1
  let connected ← Prog.attempt "getNatsConnection"
  let connection ← match connected with
    | .ok value => pure value
    | .threw error _ => Prog.fail error
    | .pending => Prog.unsupported "the connection never settled"
  if Twin.abortedRead call 0 then return ()
  let snapshot ← Prog.effect "conversationReplaySnapshot" [obj
    [("connection", connection), ("accountId", field (field socket "data") "accountId"),
     ("agentId", field message "agentId"), ("conversationKey", conversation)]]
  if Twin.abortedRead call 1 then return ()
  let afterCursor := field message "afterCursor"
  let cursor ← if truth afterCursor then Prog.effect "parseCursor" [afterCursor] else pure Json.null
  let eventKey ← Prog.effect "cursorEventKey" [eventId]
  let hasCursor := truth cursor
  let cursorKey := field cursor "eventKey"
  if (truth afterCursor && !hasCursor) ||
      (hasCursor && field cursor "generation" != field snapshot "generation") ||
      (hasCursor && cursorKey != eventKey) then
    return ← unavailable state
  let scope := [("accountId", field (field socket "data") "accountId"),
    ("agentId", field message "agentId"), ("conversationKey", conversation)]
  let sequence := (field cursor "sequence").getNat?.toOption.getD 0
  if hasCursor then
    let last ← Prog.effect "conversationLastSequence" [obj ([("connection", connection)] ++ scope)]
    if last == .null || sequence > last.getNat?.toOption.getD 0 then return ← unavailable state
    let subject ← Prog.effect "retainedMessageSubject" [connection, toJson sequence]
    let wanted ← Prog.effect "streamResponseSubject"
      [field (field socket "data") "accountId", field message "agentId", conversation]
    if subject != wanted then return ← unavailable state
  if Twin.abortedRead call 2 then return ()
  let replayFrom : Json := if hasCursor then toJson (sequence + 1) else .null
  let buffered := (field snapshot "bufferedCount").getNat?.toOption.getD 0 > 0
  let from_ ← if buffered && hasCursor then do
      let cursorText ← Prog.effect "formatCursor" [field snapshot "generation", replayFrom, eventKey]
      pure [("replayFromCursor", cursorText)]
    else pure []
  let through ← if buffered then do
      let cursorText ← Prog.effect "formatCursor" [field snapshot "generation", field snapshot "lastSequence", eventKey]
      pure [("replayThroughCursor", cursorText)]
    else pure []
  let _ ← Prog.effect "sendAgentTest" [socket, obj
    ([("type", .str "attached"), ("requestId", field message "requestId"), ("eventId", field message "eventId"),
      ("status", state), ("statusUrl", statusUrl)] ++ from_ ++ through)]
  let _ ← Prog.effect "clearTimeout" [timer]
  let _ ← Prog.effect "followAttachedExecution"
    [socket, active, message, statusUrl, status, connection, snapshot, replayFrom, eventKey]
  return ()

/-- The catch's read of `abort.signal.aborted`, the last one the call made. -/
private def lastAbortedRead (call : Json) : Bool :=
  match call.getObjVal? "aborted" with
  | .ok (.arr items) => match items.back? with
    | some (.bool value) => value
    | _ => false
  | _ => false

private def attachCoreStream (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let message := Twin.callArg call 1
  let timer ← Prog.effect "setTimeout" [obj [("$fn", .str "")], field (Twin.callArg call 2) "runStartTimeoutMs"]
  let conversation ← Prog.effect "userScoped" [socket, field message "conversationKey"]
  let eventId ← Prog.effect "userScoped" [socket, field message "eventId"]
  let active := obj
    [("abort", obj [("$opaque", .str "AbortController"), ("$fields", obj [])]), ("startTimeout", timer),
     ("agentId", field message "agentId"), ("publicConversationKey", conversation),
     ("publicEventId", eventId), ("controls", toJson (0 : Nat))]
  let _ ← Prog.effect "activeRuns.set" [socket, active]
  let statusUrl := Json.str ("/v1/runs/" ++ encodeURIComponent (text (field message "runId")))
  Prog.catchFail (attachBody call socket message active timer statusUrl) fun err =>
    if isUnsupportedError err then Prog.fail err
    else if lastAbortedRead call then pure ()
    else do
      let text ← Prog.effect "errorMessage" [err]
      let _ ← Prog.effect "sendAgentTest" [socket, obj [("type", .str "error"), ("error", text)]]
      pure ()
  let _ ← Prog.effect "stopActiveRun" [socket, active]
  return Twin.undefinedJson

private def gateway : String := "apps/gateway/src/agent.ts#"
private def http : String := "apps/core/src/shared/http.ts#"
private def principal : String := "apps/core/src/shared/domain/principal.ts#"
private def handler : String := "apps/core/src/accounts/handler.ts#"
private def edge : String := "apps/edge/src/traefik.ts#"
private def cleanup : String := "apps/core/src/accounts/cleanup.ts#"

def twins : List Spec.Twin :=
  [Twin.traced (handler ++ "unsupportedSandboxAction") unsupportedSandboxAction,
   Twin.traced (gateway ++ "watchUserTokenLifetime") watchUserTokenLifetime,
   Twin.traced (gateway ++ "cursorEventKey") cursorEventKey,
   Twin.traced "apps/core/src/shared/terminal-ticket.ts#ticketKey" ticketKey,
   Twin.traced "packages/convex/model/userToken.ts#credentialKey" credentialKey,
   Twin.traced (principal ++ "directPrincipalChain") directPrincipalChain,
   Twin.traced (principal ++ "principalChainLabel") principalChainLabel,
   Twin.traced (edge ++ "routerRule") routerRule,
   Twin.traced (edge ++ "middlewares") middlewares,
   Twin.traced (gateway ++ "responseErrorText") responseErrorText,
   Twin.traced (gateway ++ "cleanupAgentSocket") cleanupAgentSocket,
   Twin.traced (gateway ++ "sendTerminalFrame") sendTerminalFrame,
   Twin.traced (gateway ++ "isControlMessage") isControlMessage,
   Twin.traced (gateway ++ "isExecuteMessage") isExecuteMessage,
   Twin.traced (handler ++ "auditedSandboxCall") auditedSandboxCall,
   Twin.traced (handler ++ "sandboxAuditActor") sandboxAuditActor,
   Twin.traced (http ++ "jsonResponse") (fun c => pure (jsonResponse (field c "args"))),
   Twin.traced (http ++ "lookupUntilAborted") lookupUntilAborted,
   plain "apps/gateway/src/routes.ts#matchObservabilityWebSocketPath" matchObservabilityPath,
   Twin.traced "apps/core/src/shared/run-token.ts#sign" sign,
   Twin.traced "apps/core/src/shared/run-token.ts#subagentKeyTag" subagentKeyTag,
   Twin.traced "apps/core/src/shared/terminal-ticket.ts#sealTerminalTicket" sealTerminalTicket,
   Twin.traced "packages/convex/model/userToken.ts#sealCredential" sealCredential,
   Twin.traced "packages/convex/model/userToken.ts#openCredential" openCredential,
   Twin.traced (gateway ++ "fetchStatus") fetchStatus,
   Twin.traced (gateway ++ "decodeNatsStreamEvent") decodeNatsStreamEvent,
   Twin.traced (gateway ++ "statusFingerprint") statusFingerprint,
   Twin.traced (gateway ++ "parseGatewayMessage") parseGatewayMessage,
   Twin.traced (http ++ "errorResponse") errorResponse,
   Twin.traced (http ++ "isPrivateHostname") isPrivateHostname,
   Twin.traced (handler ++ "errorResponseForError") errorResponseForError,
   Twin.traced (handler ++ "retiredImageOptionsRefusal") retiredImageOptionsRefusal,
   Twin.traced (cleanup ++ "deleteAccountBundles") deleteAccountBundles,
   Twin.traced (cleanup ++ "deleteAccountSkills") deleteAccountSkills,
   Twin.traced (cleanup ++ "deleteAccountRuntimeData") deleteAccountRuntimeData,
   Twin.traced (handler ++ "deleteAccountResponse") deleteAccountResponse,
   Twin.traced (http ++ "assertPublicHttpsUrl") assertPublicHttpsUrl,
   Twin.traced "apps/edge/src/routes.ts#resolveRouter" resolveRouter,
   Twin.traced (edge ++ "renderFileConfig") renderFileConfig,
   Twin.traced (edge ++ "renderKubernetes") renderKubernetes,
   Twin.traced (handler ++ "handler") accountHandler,
   Twin.traced (gateway ++ "followAttachedExecution") followAttachedExecution,
   Twin.traced (gateway ++ "attachCoreStream") attachCoreStream,
   Twin.traced (handler ++ "snapshotSandbox") snapshotSandbox,
   Twin.traced (handler ++ "queueMirrorStatus") queueMirrorStatus,
   Twin.traced (handler ++ "refreshSandboxStatus") refreshSandboxStatus,
   Twin.traced (handler ++ "terminateSandbox") terminateSandbox,
   Twin.traced (handler ++ "execSandbox") execSandbox,
   Twin.traced (handler ++ "openSandboxTerminal") openSandboxTerminal,
   Twin.traced (handler ++ "handleAccountRequest") handleAccountRequest,
   Twin.traced (handler ++ "handleSandboxLifecycleRoute") handleSandboxLifecycleRoute,
   Twin.traced (cleanup ++ "deleteConvexRuntimeRows") deleteConvexRuntimeRows,
   plain "apps/gateway/src/routes.ts#matchAgentWebSocketPath" matchAgentPath,
   Twin.traced "apps/gateway/src/upstream.ts#resolveSocketScope" resolveSocketScope,
   Twin.traced (gateway ++ "stopActiveRun") stopActiveRun,
   plain (edge ++ "ruleMatcher") (fun a => ruleMatcher (Twin.arg a 0)),
   plain (handler ++ "boundedInteger") boundedInteger,
   Twin.traced (handler ++ "requireAccountAuth") requireAccountAuth,
   plain (edge ++ "originRegex") (fun a => .str (originRegex (text (Twin.arg a 0)))),
   Twin.traced (gateway ++ "buildCoreRunBody") buildCoreRunBody,
   Twin.traced (gateway ++ "responseJson") responseJson,
   plain (http ++ "parseJsonBody") parseJsonBody,
   Twin.traced (cleanup ++ "deleteAccountAttachments") deleteAccountAttachments,
   Twin.traced (cleanup ++ "deleteWorkspaceFilesystems") deleteWorkspaceFilesystems,
   plain (principal ++ "channelPrincipalChain") channelPrincipalChain,
   plain (principal ++ "runPrincipal") runPrincipal,
   plain (principal ++ "principalLinkLabel") principalLinkLabel,
   Twin.traced (gateway ++ "userScoped") (fun c => pure (userScoped (field c "args"))),
   plain (gateway ++ "hasAnswerInput") (fun a => toJson (hasAnswerInput (Twin.arg a 0))),
   plain (gateway ++ "hasEventInput") (fun a => toJson (hasEventInput (Twin.arg a 0))),
   plain (gateway ++ "isAttachMessage") isAttachMessage,
   Twin.traced (handler ++ "handleMcpServiceRoute") handleMcpServiceRoute,
   plain (edge ++ "routerMiddlewares") routerMiddlewares,
   Twin.traced (gateway ++ "coreHeaders") (fun c => pure (coreHeaders (field c "args"))),
   plain (gateway ++ "formatCursor") (fun a => .str ("ws-responses:" ++ text (Twin.arg a 0) ++ ":" ++ text (Twin.arg a 1) ++ ":" ++ text (Twin.arg a 2))),
   plain (gateway ++ "isIngressMode") (fun a => toJson (["reject", "followup", "collect", "steer"].contains (text (Twin.arg a 0)))),
   plain (gateway ++ "isIngressStatus") (fun a => toJson (["accepted", "queued", "applied", "processing", "awaiting_approval", "completed", "failed", "expired"].contains (text (Twin.arg a 0)))),
   Twin.traced (handler ++ "errorText") (fun c => pure (errorText (field c "args"))),
   plain (handler ++ "toCreateAccountResponse") toCreateAccountResponse,
   plain (http ++ "normalizePath") (fun a => let s := text (Twin.arg a 0); .str (if s.length > 1 then stripTrailingSlashes s else s)),
   Twin.traced (http ++ "channelApiFetch") (fun _ => pure (obj [("$fn", .str "")])),
   Twin.traced (http ++ "resetPublicHostsForTests") (fun call => do
     Waveaccess8a.setModule call "publicHosts" (obj [("$map", .arr #[])])
     pure Twin.undefinedJson),
   plain (edge ++ "headersMiddleware") headersMiddleware,
   plain (edge ++ "middlewareName") (fun a => .str ("broods-edge-" ++ text (Twin.arg a 0))),
   plain (edge ++ "observability") (fun a => if truth (field (Twin.arg a 0) "secretPath") then obj [("observability", obj [("accessLogs", .bool false)])] else obj []),
   plain (edge ++ "priority") (fun a => match Twin.arg a 0 with | .num n => .num (numAdd (natNum 1008) ⟨-n.mantissa, n.exponent⟩) | _ => .null),
   plain (principal ++ "delegatedChain") delegatedChain]
end Spec.Access.Waveaccess2
