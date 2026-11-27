import Spec.Twin
import Spec.Hosted.Twins.Wavehosted8a
import Spec.Config.Twins.Js
import Spec.Channels.Twins.Wavechannels8a

namespace Spec.Hosted.Wavehosted1

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def nil (value : Json) : Bool := value == .null || undef value
private def text (value : Json) : String :=
  if undef value then "undefined" else (Js.string? (some value)).getD "[object Object]"
private def items (value : Json) : List Json := (Js.arr? value).getD []
private def truthy (value : Json) : Bool := !undef value && Js.truthy value
private def obj (entries : List (String × Json)) : Json := Json.mkObj entries
private def fn (name : String) : Json := obj [("$fn", toJson name)]
private def failClient (message : String) : Prog Json := do
  let error ← Prog.effect "new ClientError" [toJson message]
  .fail error

private def defaultMessage (call : Json) : Prog Json := do
  let issue := Twin.callArg call 0
  let code := text (field issue "code")
  let message :=
    if code == "invalid_value" then
      "must be one of: " ++ ", ".intercalate ((items (field issue "values")).map fun v => if nil v then "" else text v)
    else if code == "invalid_key" then
      let message := field ((items (field issue "issues")).headD .null) "message"
      if nil message then "is invalid" else text message
    else if code == "unrecognized_keys" then
      "has unknown option \"" ++ text ((items (field issue "keys")).headD Twin.undefinedJson) ++ "\""
    else if code != "invalid_type" then "is invalid"
    else
      let expected := text (field issue "expected")
      if expected == "object" || expected == "record" then "must be an object"
      else if expected == "array" then "must be an array"
      else if expected == "int" then "must be an integer"
      else "must be a " ++ expected
  return toJson message

private def assertMetaCredentials (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let path := text (Twin.callArg call 1)
  let fields := (items (Twin.callArg call 2)).map text
  match fields.find? (fun key => !undef (field config key)) with
  | none => return Twin.undefinedJson
  | some present =>
    match fields.find? (fun key => Js.isStr (field config key) && (Js.trim (text (field config key))).isEmpty) with
    | some empty => return ← failClient s!"{path}.{empty} must be a non-empty string"
    | none =>
      match fields.find? (fun key => undef (field config key)) with
      | some missing => return ← failClient s!"{path}.{missing} is required when {path}.{present} is set"
      | none => return Twin.undefinedJson

private def sanitizeFetchInit (call : Json) : Prog Json := do
  let init := Twin.callArg call 0
  if nil init then return obj []
  if !Js.isObj init then return ← Prog.throwError "Error" "init must be an object"
  return obj ((["method", "headers", "body"].filterMap fun key =>
    let value := field init key
    if undef value then none else some (key, if key == "method" then toJson (text value) else value)))

private def resolveOauth (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let base := field record "oauth"
  let override := Twin.callArg call 1
  if undef base && undef override then return Twin.undefinedJson
  let merged := Js.spread base override
  let mut result := obj []
  for key in ["clientId", "clientSecret", "refreshToken"] do
    let value := field merged key
    if undef value || value == toJson "" then
      return ← Prog.throwError "Error" s!"config.mcp.{text (field record "serverId")} oauth is missing {key}"
    let placeholder := Js.Re.seqs [.lit "${", .any (fun c => 'A' ≤ c && c ≤ 'Z'),
      .star (.any (fun c => ('A' ≤ c && c ≤ 'Z') || Js.isAsciiDigit c || c == '_')) true, .lit "}"]
    if Js.Re.test placeholder (text value) then
      return ← Prog.throwError "Error"
        ("config.mcp." ++ text (field record "serverId") ++ " oauth " ++ key ++
         " still carries a ${NAME} ref; set it in the agent config so it resolves at sync")
    result := Js.set result key value
  let tokenUrl := field base "tokenUrl"
  return Js.set result "tokenUrl" (if nil tokenUrl then toJson "https://oauth2.googleapis.com/token" else tokenUrl)

private def normalizeRequestHeaders (call : Json) : Prog Json := do
  let headers := Twin.callArg call 0
  if nil headers then return obj []
  let headers := if undef (field headers "$headers") then headers else field headers "$headers"
  let mut result := obj []
  if Js.isArr headers then
    for entry in items headers do
      if Js.isArr entry && (items entry).length == 2 then
        let key := text (Twin.arg entry 0)
        if key.toLower != "host" then result := Js.set result key (toJson (text (Twin.arg entry 1)))
  else if Js.isObj headers then
    for (key, value) in Js.entries headers do
      if key.toLower != "host" && !undef value then result := Js.set result key (toJson (text value))
  else return ← Prog.throwError "Error" "init headers must be an object, array, or Headers"
  return result

private def publicHttpsUrlProblem (call : Json) : Prog Json := do
  match Url.parse (text (Twin.callArg call 0)) with
  | .invalid => return toJson "must be a valid URL"
  | .unknown reason => Prog.unsupported reason
  | .ok url =>
    if url.protocol != "https:" then return toJson "must use https"
    let privateHost ← Prog.effect "isPrivateHostname" [toJson url.hostname]
    return if truthy privateHost then toJson "must not point to a private or internal address" else Twin.undefinedJson

private def parseRunnerFrame (call : Json) : Prog Json := do
  match Json.parse (Js.trim (text (Twin.callArg call 0))) with
  | .error _ => return .null
  | .ok parsed =>
    return if ["chunk", "final", "end", "error", "log"].contains (text (field parsed "t")) then parsed else .null

private def ipv4ToInt (call : Json) : Prog Json := do
  let parts := (text (Twin.callArg call 0)).splitOn "."
  if parts.length != 4 then return .null
  let mut value := 0
  for part in parts do
    let part := Js.trim part
    let number := if part.isEmpty then some 0 else part.toNat?
    match number with
    | none => return ← Prog.unsupported "nondecimal Number conversion in IPv4 octet"
    | some octet =>
      if octet > 255 then return .null
      value := value * 256 + octet
  return toJson value

private def assertHarnessSupports (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  if !(items (Twin.callArg call 1)).isEmpty then
    return ← failClient "config.policies is not supported with config.harness"
  for (model, label) in [(field config "model", "config.model"),
      (field (field config "subagent") "model", "config.subagent.model")] do
    if truthy (field model "output") && field (field model "output") "type" != toJson "text" then
      return ← failClient s!"{label}.output structured output is not supported with config.harness"
    if !undef (field model "providerOptions") then
      return ← failClient s!"{label}.providerOptions is not supported with config.harness; set {label}.reasoning"
  return Twin.undefinedJson

private def validateHttpUrl (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if !Js.isStr value && undef (field value "$url") then
    return ← Prog.throwError "Error" "url must be a string or URL"
  let input := if Js.isStr value then text value else text (field value "$url")
  match Url.parse input with
  | .invalid => Prog.unsupported "URL constructor exception fields depend on runtime"
  | .unknown reason => Prog.unsupported reason
  | .ok url =>
    if url.protocol != "http:" && url.protocol != "https:" then
      return ← Prog.throwError "Error" "only http(s) URLs are supported"
    if url.hostname.isEmpty then return ← Prog.throwError "Error" "URL must include a hostname"
    if !Url.plainHref url then return ← Prog.unsupported "URL path encoding"
    return obj [("$url", toJson (Url.href url))]

private def writeRequestBody (call : Json) : Prog Json := do
  let body := Twin.callArg call 1
  if nil body then
    let _ ← Prog.effect "request.end"
  else if Js.isStr body || !undef (field body "$bytes") then
    let _ ← Prog.effect "request.end" [body]
  else return ← Prog.throwError "Error" "init body must be a string or bytes"
  return Twin.undefinedJson

private def forwardAbortSignal (call : Json) : Prog Json := do
  let signal := Twin.callArg call 1
  if !truthy signal then return Twin.undefinedJson
  if truthy (field signal "$signal") then
    let _ ← Prog.attempt "child.kill" [toJson "SIGUSR2"]
    return Twin.undefinedJson
  let _ ← Prog.effect "abortSignal.addEventListener"
    [toJson "abort", fn "onAbort", obj [("once", toJson true)]]
  return fn ""

private def otlpHeaders (call : Json) : Prog Json := do
  let mut result := obj []
  let raw := Twin.callArg call 0
  for part in (if nil raw then "" else text raw).splitOn "," do
    let split := part.splitOn "="
    if split.length > 1 then
      let key := Js.trim (split.headD "")
      let value := Js.trim ("=".intercalate split.tail)
      if !key.isEmpty then result := Js.set result key (toJson value)
  return result

private def chainWithoutNames (call : Json) : Prog Json :=
  pure (.arr ((items (Twin.callArg call 0)).map fun link => if field link "kind" == toJson "user" then Js.del link "name" else link).toArray)

private def responseHeadersToRecord (call : Json) : Prog Json :=
  pure (obj ((Js.entries (Twin.callArg call 0)).filterMap fun (key, value) =>
    if undef value then none else some (key, toJson (if Js.isArr value then
      ", ".intercalate ((items value).map text) else text value))))

private def questionRequest (call : Json) : Prog Json := do
  let questions := items (field (Twin.callArg call 0) "questions")
  let properties := obj (questions.map fun q => (text (field q "id"), obj
    [("type", toJson "string"), ("title", field q "header"), ("description", field q "question"),
     ("enum", .arr ((items (field q "options")).map (fun o => field o "label")).toArray)]))
  return obj [("method", toJson "elicitation/create"), ("params", obj
    [("mode", toJson "form"), ("message", toJson ("\n".intercalate (questions.map fun q => text (field q "question")))),
     ("requestedSchema", obj [("type", toJson "object"), ("properties", properties),
       ("required", .arr (questions.map fun q => field q "id").toArray)])])]

private def renderContent (call : Json) : Prog Json := do
  let rendered := (items (Twin.callArg call 0)).map fun block =>
    let kind := text (field block "type")
    if kind == "text" then text (field block "text")
    else if kind == "image" || kind == "audio" then s!"[{kind} content ({text (field block "mimeType")}) omitted]"
    else if kind == "resource_link" then s!"[resource link: {text (field block "uri")}]"
    else if kind == "resource" then s!"[embedded resource: {text (field (field block "resource") "uri")}]"
    else s!"[unsupported {kind} content omitted]"
  return toJson ("\n".intercalate rendered)

private def finalHostedResponse (call : Json) : Prog Json := do
  let response := Twin.callArg call 1
  if !truthy response || !Js.isNum (field response "status") || !Js.isStr (field response "body") then
    return ← Prog.throwError "Error" s!"hosted MCP server {text (Twin.callArg call 0)} returned a malformed response"
  return response

private def withRequestId (call : Json) : Prog Json := do
  let response := Twin.callArg call 0
  let data := field response "$response"
  let headers := items (field data "headers")
  if headers.any (fun entry => (text (Twin.arg entry 0)).toLower == "x-request-id" && truthy (Twin.arg entry 1)) then
    return response
  let headers := headers.filter (fun entry => (text (Twin.arg entry 0)).toLower != "x-request-id")
  let headers := headers ++ [.arr #[toJson "x-request-id", Twin.callArg call 1]]
  let headers := headers.mergeSort (fun a b => text (Twin.arg a 0) ≤ text (Twin.arg b 0))
  -- `response.body` is a stream, or null when the response has no body.
  let body := if field data "body" == Json.null then Json.null else obj [("$opaque", toJson "ReadableStream")]
  return Js.set response "$response" (Js.set (Js.set data "headers" (.arr headers.toArray)) "body" body)

private def normalizeHeaders (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let stored := Twin.callArg call 1
  if !Js.isObj value || undef value then
    return ← failClient "headers must be an object of header name to value"
  let entries := Js.entries value
  if entries.length > 16 then return ← failClient "headers must contain at most 16 entries"
  let mut result := obj []
  for (name, headerValue) in entries do
    if name.isEmpty || name.length > 128 || !(name.toList.all fun c =>
      Js.isAsciiAlnum c || "!#$%&'*+.^_`|~-".toList.contains c) then
      return ← failClient s!"headers names must be RFC 9110 tokens: {name}"
    if !Js.isStr headerValue || (text headerValue).length > 2048 ||
        (text headerValue).contains '\r' || (text headerValue).contains '\n' then
      return ← failClient "headers values must be single-line strings of at most 2048 characters"
    let lower := name.toLower
    let secret ← Prog.effect "isSecretName" [toJson lower]
    let ref := Js.Re.seqs [.lit "${", .any (fun c => 'A' ≤ c && c ≤ 'Z'),
      .star (.any (fun c => ('A' ≤ c && c ≤ 'Z') || Js.isAsciiDigit c || c == '_')) true, .lit "}"]
    let credential := Js.Re.seqs [
      .opt (.seq (.plus (.any Js.isAsciiAlpha)) (.lit " ")), .plus ref]
    if (truthy secret || lower == "key" || lower == "keys") &&
        !Js.Re.full credential (text headerValue) && field stored name != headerValue then
      return ← failClient ("headers values for " ++ name ++
        " must reference an account env var like ${NAME}, not an inline secret")
    result := Js.set result name headerValue
  return result

private def sandboxMcpTarget (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let runtime := Twin.callArg call 1
  let hosts := items (field runtime "sandboxes")
  let host := (hosts.find? fun entry => field entry "name" == field record "sandbox").getD Twin.undefinedJson
  if field record "transport" != toJson "machine" || field (field host "sandbox") "provider" != toJson "lambda" then
    return Twin.undefinedJson
  let name := text (field host "name")
  let server := text (field record "serverId")
  if !truthy (field record "command") then
    return ← Prog.throwError "Error" s!"config.mcp.{server} runs on lambda sandbox \"{name}\" and needs command"
  let workspace ← if hosts.head? == some host then
      Prog.effect "agentOwnWorkspace" [obj
        [("workspaces", if nil (field runtime "workspaces") then .arr #[] else field runtime "workspaces"),
         ("sandboxes", field runtime "sandboxes")]]
    else pure Twin.undefinedJson
  let config := if nil (field workspace "sandbox") then field host "sandbox" else field workspace "sandbox"
  let reservation ← if truthy workspace then do
      let root ← Prog.effect "workspaceRootFor" [config]
      pure (obj [("namespace", field workspace "namespace"), ("workspaceRoot", root)])
    else do
      let key ← Prog.effect "statelessReservationKeyFor" [field host "sandbox"]
      pure (obj [("reservationKey", key)])
  let scopeName := field reservation "namespace"
  let key := if nil scopeName then field reservation "reservationKey" else scopeName
  if field config "persistent" != toJson true || !truthy key then
    return ← Prog.throwError "Error" s!"config.mcp.{server} runs on lambda sandbox \"{name}\", which must be persistent"
  return obj [("config", config), ("reservation", reservation), ("command", field record "command")]

private def blobKeyId (call : Json) : Prog Json := do
  let ciphertext := text (field (Twin.callArg call 0) "ciphertext")
  if !ciphertext.startsWith "v2:" then return .null
  match (ciphertext.splitOn ":").drop 1 with
  | key :: _ :: _ => return toJson key
  | _ => return .null

private def base64Value (c : Char) : Option Nat :=
  let alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toList
  (alphabet.zipIdx.find? fun item => item.1 == (if c == '+' then '-' else if c == '/' then '_' else c)).map (·.2)

private def decodeBytes (value : Json) : Option (List Nat) := do
  let chars := (text (field value "$bytes")).toList.takeWhile (· != '=')
  let values ← chars.mapM base64Value
  let (_, _, bytes) := values.foldl (fun (acc, bits, bytes) n =>
    let acc := acc * 64 + n
    let bits := bits + 6
    if bits ≥ 8 then
      let remaining := bits - 8
      (acc % (2 ^ remaining), remaining, bytes ++ [acc / (2 ^ remaining)])
    else (acc, bits, bytes)) (0, 0, [])
  return bytes

private def encodeBytes (bytes : List Nat) : Json :=
  let raw := (String.ofList (Js.base64UrlEncode bytes)).replace "-" "+" |>.replace "_" "/"
  let padding := String.ofList (List.replicate ((4 - raw.length % 4) % 4) '=')
  obj [("$bytes", toJson (raw ++ padding))]

private def concatBytes (call : Json) : Prog Json := do
  match decodeBytes (Twin.callArg call 0), decodeBytes (Twin.callArg call 1) with
  | some left, some right => return encodeBytes (left ++ right)
  | _, _ => Prog.unsupported "unrepresented byte input"

private def concatChunks (call : Json) : Prog Json := do
  match (items (Twin.callArg call 0)).mapM decodeBytes with
  | none => Prog.unsupported "unrepresented chunk bytes"
  | some chunks =>
    let total := (Js.nat? (Twin.callArg call 1)).getD 0
    let bytes := chunks.flatten
    if bytes.length > total then return ← Prog.throwError "RangeError" "offset is out of bounds"
    return encodeBytes (bytes ++ List.replicate (total - bytes.length) 0)

private def base64UrlToBytes (call : Json) : Prog Json :=
  Prog.effect "Uint8Array.fromBase64" [Twin.callArg call 0, obj [("alphabet", toJson "base64url")]]

private def bytesToBase64Url (call : Json) : Prog Json :=
  pure (toJson ((text (field (Twin.callArg call 0) "$bytes")).replace "+" "-" |>.replace "/" "_" |>.replace "=" ""))

private def toArrayBuffer (call : Json) : Prog Json := pure (Twin.callArg call 0)

private def mergeCanvasSandboxes (call : Json) : Prog Json := do
  let canvas := items (Twin.callArg call 0)
  let stored := items (Twin.callArg call 1)
  let drawn := items (field (Twin.callArg call 2) "$set")
  return .arr (Js.dedupe (canvas ++ stored.filter (fun id => !drawn.contains id))).toArray

private def errorText (call : Json) : Prog Json := do
  let body ← Prog.catchFail (Prog.effect "response .json") (fun _ => pure (obj []))
  let message := field (field body "error") "message"
  return if nil message then toJson s!"The run request failed ({text (field (field (Twin.callArg call 0) "$response") "status")})." else message

private def requireCurrentKeyId (call : Json) : Prog Json := do
  let key := Twin.field (Twin.self call) "currentKeyId"
  if key == .null then
    return ← Prog.throwError "Error" s!"Account {text (Twin.field (Twin.self call) "accountId")} has no live encryption key"
  return key

private def isolateLogRecord (call : Json) : Prog Json := do
  let frame := Twin.callArg call 2
  let level := field frame "level"
  let level := if ["error", "warn", "debug"].contains (text level) then level else toJson "info"
  let account := Twin.callArg call 0
  let tool := Twin.callArg call 1
  let data := obj ([("source", toJson "user-code")] ++
    (if undef account then [] else [("accountId", account)]) ++
    (if Js.isStr tool then [("toolName", tool)] else []))
  return obj [("level", level), ("message", if nil (field frame "message") then toJson "" else field frame "message"), ("data", data)]

private def providerBaseURL (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let raw := if Js.isStr (field config "base_url") then field config "base_url" else field config "baseURL"
  if nil raw then return Twin.undefinedJson
  let trimmed := Js.trim (text raw)
  return if trimmed.isEmpty then Twin.undefinedJson else toJson trimmed

private def authorizationHeaderName (call : Json) : Prog Json :=
  pure (((Js.entries (Twin.callArg call 0)).find? fun item => item.1.toLower == "authorization").map
    (fun item => toJson item.1) |>.getD Twin.undefinedJson)

private def workspaceOnLaterSandbox (call : Json) : Prog Json := do
  if Twin.callArg call 1 == toJson (0 : Nat) then return Twin.undefinedJson
  let index := (Js.nat? (Twin.callArg call 1)).getD 0
  let sandbox := (items (Twin.callArg call 0)).getD index Twin.undefinedJson
  return ((items (Twin.callArg call 2)).find? fun ref => field ref "sandbox" == sandbox).getD Twin.undefinedJson

private def mcpRequestHeaders (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let headers := field connection "headers"
  let principal := field connection "principalHeaders"
  let result := Js.spread (if undef headers then obj [] else headers) (if undef principal then obj [] else principal)
  if truthy (field connection "oauth") then
    let token ← Prog.effect "mcpAccessToken" [field (field connection "record") "name", field connection "oauth"]
    return Js.set result "Authorization" (toJson ("Bearer " ++ text token))
  return result

private def isImageLink (call : Json) : Prog Json := do
  let block := Twin.callArg call 0
  let uri := (text (field block "uri")).toLower
  return toJson (field block "type" == toJson "resource_link" &&
    (text (field block "mimeType")).startsWith "image/" && (uri.startsWith "https://" || uri.startsWith "http://"))

private def isRedirect (call : Json) : Prog Json :=
  pure (toJson ([301, 302, 303, 307, 308].contains ((Js.nat? (Twin.callArg call 0)).getD 0)))

private def bodyLimitMessage (call : Json) : Prog Json := do
  match Twin.callArg call 0 with
  | .num n =>
    let denominator : Int := (10 ^ n.exponent) * 1048576
    let rounded := (2 * n.mantissa + denominator) / (2 * denominator)
    return toJson s!"response body exceeded {rounded}MB"
  | _ => Prog.unsupported "nonnumeric body limit"

private def throwIfAborted (call : Json) : Prog Json := do
  let signal := Twin.callArg call 0
  if truthy (field signal "$signal") || truthy (field signal "aborted") then
    return ← Prog.throwError "Error" "timed out"
  return Twin.undefinedJson

private def bundleKey (call : Json) : Prog Json :=
  pure (toJson s!"{text (field (Twin.callArg call 0) "accountId")}:{text (field (Twin.callArg call 0) "sha256")}")

private def hasBundle (call : Json) : Prog Json :=
  pure (toJson (truthy (field (Twin.callArg call 0) "bundleStorageKey") && truthy (field (Twin.callArg call 0) "sha256")))

private def hostedMcpTenantId (call : Json) : Prog Json :=
  pure (if truthy (Twin.callArg call 1) then toJson s!"{text (Twin.callArg call 0)}:{text (Twin.callArg call 1)}" else Twin.callArg call 0)

private def toolResult (call : Json) : Prog Json :=
  pure (obj [("resultType", toJson "complete"),
    ("content", .arr #[obj [("type", toJson "text"), ("text", Twin.callArg call 0)]]),
    ("isError", Twin.callArg call 1)])

private def unknownTask (call : Json) : Prog Json :=
  Prog.effect "new ProtocolError" [toJson (-32602 : Int), toJson ("No task " ++ text (Twin.callArg call 0))]

private def aad (call : Json) : Prog Json :=
  pure (toJson s!"{text (Twin.field (Twin.self call) "accountId")}:{text (Twin.callArg call 0)}")

private def scopedSegment (call : Json) : Prog Json :=
  pure (if Twin.callArg call 0 == toJson "-" || Twin.callArg call 0 == toJson "" then Twin.undefinedJson else Twin.callArg call 0)

private def toolBundlesBucket (_ : Json) : Prog Json := Prog.effect "requireEnv" [toJson "TOOL_BUNDLES_BUCKET_NAME"]

private def mcpToolName (call : Json) : Prog Json :=
  pure (toJson (text (Twin.callArg call 0) ++ "__" ++ String.ofList
    ((text (Twin.callArg call 1)).toList.map fun c => if Js.isAsciiAlnum c || c == '_' || c == '-' then c else '_')))

private def resolveRequestId (call : Json) : Prog Json := do
  let inbound := Twin.callArg call 0
  let value := text inbound
  if Js.isStr inbound && !value.isEmpty && value.length ≤ 128 &&
      value.toList.all (fun c => Js.isAsciiAlnum c || "._-".toList.contains c) then return inbound
  Prog.effect "crypto.randomUUID"


private def clampTtlMs (call : Json) : Prog Json := do
  match Twin.callArg call 0 with
  | .num n =>
    if n.mantissa > 0 then
      return if Js.numGe n 3600000 then toJson (3600000 : Nat) else .num n
    return toJson (300000 : Nat)
  | _ => return toJson (300000 : Nat)

private def requireTaskCapability (call : Json) : Prog Json := do
  let ctx := Twin.callArg call 0
  let allowed ← Prog.effect "hasTaskClientCapabilityV2" [obj [("_meta", field (field ctx "mcpReq") "envelope")]]
  if !truthy allowed then
    let error ← Prog.effect "new MissingRequiredClientCapabilityError"
      [obj [("requiredCapabilities", obj [("extensions", obj [("io.modelcontextprotocol/tasks", obj [])])])]]
    return ← .fail error
  return Twin.undefinedJson

private def assertNoUnsupportedKeys (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  for key in items (Twin.callArg call 1) do
    if !undef (field value (text key)) then
      return ← failClient s!"{text (Twin.callArg call 2)}.{text key} is not supported"
  return Twin.undefinedJson

private def killWorker (call : Json) : Prog Json := do
  let self := Twin.self call
  let reason := Twin.callArg call 0
  if truthy reason && !nil (Twin.field self "#sink") then
    let _ ← Prog.effect "this.#sink?.fail" [reason]
  if Twin.field self "alive" != toJson false then
    Prog.setState "self.alive" (toJson false)
  let sent ← Prog.attempt "this.child.kill" [toJson "SIGKILL"]
  -- A signal that went out marks the child process object as killed.
  let child := Twin.field self "child"
  if let .ok (.bool true) := sent then
    if Twin.field child "killed" != toJson true then
      let fields := (child.getObjVal? "$fields").toOption.getD (obj [])
      Prog.setState "self.child" (child.setObjVal! "$fields" (fields.setObjVal! "killed" (toJson true)))
  return Twin.undefinedJson

private def isolatePoolEnabled (_ : Json) : Prog Json := do
  let value ← Prog.effect "optionalEnv" [toJson "ISOLATE_POOL"]
  return toJson (value != toJson "0")

private def isolateRunnerNode (_ : Json) : Prog Json := do
  let value ← Prog.effect "optionalEnv" [toJson "ISOLATE_RUNNER_NODE"]
  return if nil value then toJson "node" else value

private def isolateRunnerPath (_ : Json) : Prog Json := do
  let value ← Prog.effect "optionalEnv" [toJson "ISOLATE_RUNNER_PATH"]
  if nil value then return ← Prog.unsupported "module URL is not included in recorded arguments"
  return value

private def poolSize (_ : Json) : Prog Json :=
  Prog.effect "positiveIntegerEnv" [toJson "ISOLATE_WORKER_POOL_SIZE", toJson (4 : Nat)]

private def runnerTimeoutMs (_ : Json) : Prog Json := do
  let seconds ← Prog.effect "positiveIntegerEnv" [toJson "ISOLATE_RUNNER_TIMEOUT_SECONDS", toJson (30 : Nat)]
  return toJson ((Js.nat? seconds).getD 0 * 1000)

private def workerReadyTimeoutMs (_ : Json) : Prog Json := do
  let ready ← Prog.effect "positiveIntegerEnv" [toJson "ISOLATE_WORKER_READY_TIMEOUT_MS", toJson (5000 : Nat)]
  let runner ← Prog.effect "runnerTimeoutMs"
  return toJson (min ((Js.nat? ready).getD 0) ((Js.nat? runner).getD 0))

private def sha256 (call : Json) : Prog Json :=
  Prog.effect "crypto.subtle.digest" [toJson "SHA-256", encodeBytes (Js.utf8 (text (Twin.callArg call 0)))]

private def keyEncryptionKey (call : Json) : Prog Json :=
  Prog.effect "sha256" [toJson ("broods-kek:" ++ text (Twin.callArg call 0))]

private def needsRewrite (call : Json) : Prog Json := do
  let key ← Prog.effect "blobKeyId" [Twin.callArg call 0]
  return toJson (key != Twin.field (Twin.self call) "currentKeyId")

private def assertCompleteChannels (call : Json) : Prog Json := do
  let channels := Twin.callArg call 0
  let gchat := field channels "gchat"
  if !undef (field gchat "credentials") && undef (field gchat "endpointUrl") && undef (field gchat "googleChatProjectNumber") then
    return ← failClient "config.channels.gchat needs endpointUrl or googleChatProjectNumber to verify webhooks"
  let linear := field channels "linear"
  if !undef (field linear "apiKey") then
    if nil (field linear "userName") || (Js.trim (text (field linear "userName"))).isEmpty then
      return ← failClient "config.channels.linear.userName is required: the display name of the member the API key belongs to"
    if !truthy (field linear "webhookSecret") then
      return ← failClient "config.channels.linear.webhookSecret is required when config.channels.linear.apiKey is set"
  let teams := field channels "teams"
  if !undef (field teams "appId") && field teams "appType" != toJson "MultiTenant" &&
      (nil (field teams "appTenantId") || (Js.trim (text (field teams "appTenantId"))).isEmpty) then
    return ← failClient "config.channels.teams.appTenantId is required unless appType is \"MultiTenant\""
  for (name, fields) in [("instagram", ["accessToken", "accountId", "appSecret", "verifyToken"]),
      ("messenger", ["appSecret", "pageAccessToken", "verifyToken"])] do
    let config := field channels name
    if truthy config then
      let _ ← Prog.effect "assertMetaCredentials" [config, toJson ("config.channels." ++ name), toJson fields]
  return Twin.undefinedJson

private def assertRuntimeRefs (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let options := Twin.callArg call 1
  if !undef (field config "sandbox") then
    return ← failClient "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default"
  let sandboxes := if nil (field config "sandboxes") then .arr #[] else field config "sandboxes"
  let mut seen : List Json := []
  for (sandbox, index) in (items sandboxes).zipIdx do
    if seen.contains sandbox then
      return ← failClient s!"config.sandboxes[{index}] \"{text sandbox}\" is listed more than once"
    let args := [sandboxes, toJson index, field config "workspaces"]
    let mounted ← Prog.effect "workspaceOnLaterSandbox" args
    if truthy mounted then
      return ← failClient s!"config.sandboxes[{index}] \"{text sandbox}\" also backs workspace \"{text (field mounted "name")}\"; only the first sandbox can back a workspace"
    seen := seen ++ [sandbox]
  if truthy (field options "patch") || !(items sandboxes).isEmpty || nil (field config "harness") then
    return Twin.undefinedJson
  let harness ← Prog.effect "HARNESS_TYPE.safeParse" [field config "harness"]
  if truthy (field harness "success") then
    return ← failClient s!"config.sandboxes needs at least one sandbox for the {text (field (field harness "data") "type")} harness; the first runs it"
  return Twin.undefinedJson

private def ipv4InCidr (call : Json) : Prog Json := do
  let parts := (text (Twin.callArg call 1)).splitOn "/"
  let base ← Prog.effect "ipv4ToInt" [toJson (parts.headD "")]
  let bits := (Js.trim (parts.getD 1 "undefined")).toNat?
  match base, bits with
  | .num _, some bits =>
    let bits := bits % 32
    let shift := if bits == 0 then 0 else 32 - bits
    let divisor := 2 ^ shift
    let address := (Js.nat? (Twin.callArg call 0)).getD 0
    let base := (Js.nat? base).getD 0
    return toJson (if parts.getD 1 "" == "0" then true else address / divisor == base / divisor)
  | _, _ => return toJson false

private def jsonResponse (call : Json) : Prog Json := do
  let status := if undef (Twin.callArg call 1) then toJson (200 : Nat) else Twin.callArg call 1
  if [101, 204, 205, 304].contains ((Js.nat? status).getD 0) then
    return ← Prog.unsupported "Response constructor rejects body at null-body status"
  let headers := Js.spread (obj [("Content-Type", toJson "application/json")])
    (if undef (Twin.callArg call 2) then obj [] else Twin.callArg call 2)
  let mut normalized := obj []
  for (key, value) in (Js.entries headers).filter (·.1 != "$keys") do
    let key := key.toLower
    let value := Js.trim (text value)
    let existing := field normalized key
    normalized := Js.set normalized key (toJson (if undef existing then value else text existing ++ ", " ++ value))
  return obj [("$response", obj [("status", status), ("headers", .arr
    ((Js.entries normalized).map fun (key, value) => .arr #[toJson key, value]).toArray),
    ("body", if undef (Twin.callArg call 0) then obj [("$undefined", .bool true)]
      else toJson (Twin.jsonStringify 64 (Twin.callArg call 0)))])]

private def jsonError (call : Json) : Prog Json := do
  let init := if undef (Twin.callArg call 2) then obj [] else Twin.callArg call 2
  let headers := if undef (Twin.callArg call 3) then obj [] else Twin.callArg call 3
  let body ← Prog.effect "apiErrorBody" [Twin.callArg call 0, Twin.callArg call 1, init]
  Prog.effect "json" [body, Twin.callArg call 0, headers]

private def methodNotAllowed (call : Json) : Prog Json := do
  let allowed := ", ".intercalate ((items (Twin.callArg call 0)).map text)
  Prog.effect "jsonError" [toJson (405 : Nat), toJson s!"Method not allowed. Allowed: {allowed}.", obj [], obj [("Allow", toJson allowed)]]

private def failedTask (call : Json) : Prog Json := do
  let error := Twin.callArg call 1
  let result ← Prog.effect "toolResult" [error, toJson true]
  return Js.spread (Twin.callArg call 0) (obj [("status", toJson "completed"), ("statusMessage", error), ("result", result)])

private def readRun (call : Json) : Prog Json := do
  let runId := text (Twin.callArg call 1)
  if !(runId.toList.all fun c => Js.isAsciiAlnum c || "-_.!~*'()".toList.contains c) then
    return ← Prog.unsupported "run ID needs URI encoding"
  let request ← Prog.effect "runRequest" [Twin.callArg call 0, toJson "GET", toJson ("/v1/runs/" ++ runId)]
  let response ← Prog.effect "caller.replay" [request]
  let status := (Js.nat? (field (field response "$response") "status")).getD 0
  if status ≥ 200 && status < 300 then return ← Prog.effect "response.json"
  if status == 400 || status == 404 then return .null
  let message ← Prog.effect "errorText" [response]
  let error ← Prog.effect "new ProtocolError" [toJson (-32603 : Int), message]
  .fail error

private def resolveTaskLoop (caller : Json) : Nat → Json → Prog Json
  | 0, _ => Prog.unsupported "task continuation exceeds traversal fuel"
  | fuel + 1, current => do
    let status := text (field current "status")
    if status != "awaiting_approval" && status != "awaiting_input" then return current
    let next ← Prog.effect "nextRun" [caller, current]
    if !truthy next then return current
    resolveTaskLoop caller fuel next

private def resolveTask (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let taskId := Twin.callArg call 1
  let root ← Prog.effect "readRun" [caller, taskId]
  if !truthy root then
    let error ← Prog.effect "unknownTask" [taskId]
    return ← .fail error
  let current ← resolveTaskLoop caller 256 root
  return obj [("root", root), ("current", current)]

private def lowerChars (value : String) : List Char := (value.toLower).toList

private def isWordChar (c : Char) : Bool := Js.isAsciiAlnum c || c == '_'

/-- `/\b429\b|rate limit/i` over lowered text. -/
private def rateLimited : Option Char → List Char → Bool
  | _, [] => false
  | before, rest@(c :: tail) =>
    (rest.take 10 == "rate limit".toList) ||
    (rest.take 3 == "429".toList && !(before.any isWordChar) && !((rest.drop 3).head?.any isWordChar)) ||
    rateLimited (some c) tail

/-- The longest unit alternative in pattern order that ends at a word boundary. -/
private def waitUnit (rest : List Char) : Option Bool :=
  let fits (unit : String) : Bool :=
    rest.take unit.length == unit.toList && !((rest.drop unit.length).head?.any isWordChar)
  if fits "ms" || fits "milliseconds" || fits "millisecond" then some true
  else if fits "s" || fits "seconds" || fits "second" then some false
  else none

/-- `(\d+(?:\.\d+)?)\s*(unit)\b` at the start of `rest`: mantissa, decimals, and whether in ms. -/
private def waitAt (rest : List Char) : Option (Nat × Nat × Bool) :=
  let digits := rest.takeWhile Js.isAsciiDigit
  if digits.isEmpty then none else
  let after := rest.drop digits.length
  let fraction := match after with
    | '.' :: more => more.takeWhile Js.isAsciiDigit
    | _ => []
  let tail := if fraction.isEmpty then after else after.drop (fraction.length + 1)
  let number := (String.ofList (digits ++ fraction)).toNat!
  (waitUnit (tail.dropWhile Js.isSpace)).map fun ms => (number, fraction.length, ms)

private def findWait : List Char → Option (Nat × Nat × Bool)
  | [] => none
  | rest@(_ :: tail) =>
    let afterPhrase :=
      if rest.take 12 == "retry after ".toList then some (rest.drop 12)
      else if rest.take 13 == "try again in ".toList then some (rest.drop 13)
      else none
    match afterPhrase.bind waitAt with
    | some found => some found
    | none => findWait tail

private def rateLimitWaitMs (call : Json) : Prog Json := do
  let chars := lowerChars (text (Twin.callArg call 0))
  if !rateLimited none chars then return .null
  let attempt := (Js.nat? (Twin.callArg call 1)).getD 1
  let asked : Float := match findWait chars with
    | some (number, decimals, ms) => Float.ofScientific number true decimals * (if ms then 1 else 1000)
    | none => Float.ofNat (2000 * 2 ^ (attempt - 1))
  return toJson (min asked.ceil.toUInt64.toNat 60000)

private def verifyLogStream (call : Json) : Prog Json := do
  let parts := items (Twin.callArg call 0)
  let key := Twin.callArg call 1
  let _ ← Prog.effect "createHmac" [toJson "sha256", key]
  let _ ← Prog.effect "createHmac(\"sha256\", key) .update" [toJson ("/".intercalate ((parts.take 4).map text))]
  let digest ← Prog.effect "createHmac(\"sha256\", key) .update(parts.slice(0, 4).join(\"/\")) .digest" [toJson "hex"]
  let expected := Js.utf8 (String.ofList ((text digest).toList.take 16))
  let given := Js.utf8 (text (parts.getD 4 Twin.undefinedJson))
  if given.length != expected.length then return toJson false
  Prog.effect "timingSafeEqual" [encodeBytes given, encodeBytes expected]

private def decodeCloudWatchEvent (call : Json) : Prog Json := do
  let data := field (field (Twin.callArg call 0) "awslogs") "data"
  let raw ← Prog.effect "gunzipSync" [obj [("$bytes", data)]]
  match decodeBytes raw with
  | none => Prog.unsupported "unrepresented gunzip output"
  | some bytes =>
    match String.fromUTF8? (ByteArray.mk (bytes.map (·.toUInt8)).toArray) with
    | none => Prog.unsupported "gunzip output is not UTF-8"
    | some decoded =>
      match Json.parse decoded with
      | .ok parsed => return parsed
      | .error _ => Prog.unsupported "JSON.parse error text depends on the engine"

private def parseLogStream (call : Json) : Prog Json := do
  let logStream := text (Twin.callArg call 0)
  let parts := logStream.splitOn "/"
  let unverified := obj [("sandboxId", toJson logStream)]
  if parts.length != 5 then return unverified
  let verified ← Prog.effect "verifyLogStream" [.arr (parts.map toJson).toArray, Twin.callArg call 1]
  if !truthy verified then return unverified
  let mut result := obj [("sandboxId", toJson (parts.getD 3 ""))]
  for (key, index) in [("accountId", 0), ("project", 1), ("stage", 2)] do
    let value ← Prog.effect "scoped" [toJson (parts.getD index "")]
    if !undef value then result := Js.set result key value
  return result

private def sendRunRequest (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let request ← Prog.effect "runRequest" [caller, toJson "POST", toJson "/v1/runs", Twin.callArg call 1]
  let response ← Prog.effect "caller.replay" [request]
  let status := (Js.nat? (field (field response "$response") "status")).getD 0
  if !(status ≥ 200 && status < 300) && !(truthy (Twin.callArg call 2) && status == 409) then
    let message ← Prog.effect "errorText" [response]
    let error ← Prog.effect "new ProtocolError" [toJson (-32603 : Int), message]
    return ← .fail error
  return Twin.undefinedJson

/-- `new Date(ms).toISOString()` for instants from 1970 on, by the civil-from-days algorithm. -/
private def isoOfMillis (ms : Nat) : String :=
  let pad := fun (width value : Nat) =>
    let digits := toString value
    String.ofList (List.replicate (width - digits.length) '0') ++ digits
  let days := ms / 86400000
  let rest := ms % 86400000
  let z := days + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let day := doy - (153 * mp + 2) / 5 + 1
  let month := if mp < 10 then mp + 3 else mp - 9
  let year := yoe + era * 400 + (if month <= 2 then 1 else 0)
  pad 4 year ++ "-" ++ pad 2 month ++ "-" ++ pad 2 day ++ "T" ++ pad 2 (rest / 3600000) ++ ":" ++
    pad 2 (rest % 3600000 / 60000) ++ ":" ++ pad 2 (rest % 60000 / 1000) ++ "." ++ pad 3 (rest % 1000) ++ "Z"

private def probeRecord (call : Json) : Prog Json := do
  let probe := Twin.callArg call 1
  let now ← Prog.effect "new Date"
  let uuid ← Prog.effect "crypto.randomUUID"
  let stamp := toJson (isoOfMillis ((Js.nat? now).getD 0))
  let optional := ["workersCompatible", "url", "headers", "bundleStorageKey", "sha256"].filterMap fun key =>
    if undef (field probe key) then none else some (key, field probe key)
  return obj ([("accountId", Twin.callArg call 0), ("serverId", toJson ("probe-" ++ text uuid)),
    ("projectId", toJson "probe"), ("stageId", toJson "probe"), ("name", field probe "name"),
    ("transport", field probe "transport"), ("status", toJson "active"),
    ("createdAt", stamp), ("updatedAt", stamp)] ++ optional)

/-- `this.keys.has(keyId)`, read off the recorded `$map` of the cipher's keyring. -/
private def hasKey (call : Json) : Prog Json := do
  let key ← Prog.effect "blobKeyId" [Twin.callArg call 0]
  if key == .null then return toJson false
  let entries := match (Twin.field (Twin.self call) "keys").getObjVal? "$map" with
    | .ok (.arr items) => items.toList
    | _ => []
  return toJson (entries.any fun entry => Twin.arg entry 0 == key)

private def mcpOauthTokenCacheKey (call : Json) : Prog Json := do
  let oauth := Twin.callArg call 0
  let parts := ["tokenUrl", "clientId", "clientSecret", "refreshToken"].map fun key =>
    let value := field oauth key
    if undef value then Json.null else value
  Prog.effect "cacheDigest" [toJson (Js.stringify (.arr parts.toArray))]

private def emitIsolateLog (call : Json) : Prog Json := do
  let record ← Prog.effect "isolateLogRecord" [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2]
  let _ ← Prog.effect "emit" [field record "message", field record "data"]
  return Twin.undefinedJson

/-- `withoutHeaders`: the init with every header whose lower-cased name is in the set dropped. -/
private def withoutHeaders (call : Json) : Prog Json := do
  let init := Twin.callArg call 0
  let names := items (field (Twin.callArg call 1) "$set")
  let headers ← Prog.effect "normalizeRequestHeaders" [field init "headers"]
  let kept := (Js.entries headers).filter fun (key, _) => !names.contains (toJson key.toLower)
  return Js.set init "headers" (obj kept)

/-- `redirectInit`: fetch's redirect rules. A cross-origin hop drops credentials; a 303 (but a
HEAD), or a 301/302 after a POST, becomes a GET with no body and no body headers. -/
private def redirectInit (call : Json) : Prog Json := do
  let status := (Js.nat? (Twin.callArg call 0)).getD 0
  let init := Twin.callArg call 1
  let next ← if truthy (Twin.callArg call 2) then
      Prog.effect "withoutHeaders" [init, Twin.moduleValue call "CREDENTIAL_HEADERS"]
    else pure init
  let method := if nil (field next "method") then "GET" else (text (field next "method")).toUpper
  let asGet := if status == 303 then method != "HEAD"
    else (status == 301 || status == 302) && method == "POST"
  if !asGet then return next
  let stripped ← Prog.effect "withoutHeaders" [next, Twin.moduleValue call "BODY_HEADERS"]
  let kept := (Js.entries stripped).filter fun (key, _) => key != "method" && key != "body"
  return obj (kept ++ [("method", toJson "GET")])

private def denyCidrs : List String :=
  ["0.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8",
   "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"]

/-- `Number.parseInt(text, 16)`, or none for NaN. Text is already lower case. -/
private def parseHexPrefix (value : String) : Option Nat :=
  let chars := if value.startsWith "0x" then value.toList.drop 2 else value.toList
  let digits := chars.takeWhile Js.isHexDigit
  if digits.isEmpty then none else
  some (digits.foldl (fun acc c =>
    acc * 16 + (if Js.isAsciiDigit c then c.toNat - 48 else c.toNat - 87)) 0)

private def isDeniedAddress (call : Json) : Prog Json := do
  let address := text (Twin.callArg call 0)
  if address.contains ':' then
    let normalized := address.toLower
    let inRange := match parseHexPrefix normalized with
      | some group => group > 0 && group < 0xfc00
      | none => false
    return toJson (!inRange || normalized.startsWith "64:ff9b:" || normalized.startsWith "2002:")
  let numeric ← Prog.effect "ipv4ToInt" [toJson address]
  if numeric == .null then return toJson true
  for cidr in denyCidrs do
    let hit ← Prog.effect "ipv4InCidr" [numeric, toJson cidr]
    if truthy hit then return toJson true
  return toJson false

private def mcpTools (call : Json) : Prog Json := do
  let recordName := field (field (Twin.callArg call 0) "record") "name"
  let mut tools := obj []
  for remote in items (Twin.callArg call 1) do
    let name ← Prog.effect "mcpToolName" [recordName, field remote "name"]
    let schema ← Prog.effect "jsonSchema" [field remote "inputSchema"]
    let description := field remote "description"
    let built ← Prog.effect "tool" [obj
      [("description", if nil description then toJson "" else description), ("inputSchema", schema),
       ("toModelOutput", fn "toModelOutput"), ("execute", fn "execute")]]
    tools := Js.set tools (text name) built
  return tools

private def resolveAllowedAddress (call : Json) : Prog Json := do
  let hostname := text (Twin.callArg call 0)
  let state := Twin.callArg call 1
  let allowed := items (field state "allowAddresses")
  let addresses ← Prog.effect "resolver" [toJson hostname, obj [("all", toJson true), ("verbatim", toJson false)]]
  let normalized := if Js.isArr addresses then items addresses else [addresses]
  if normalized.isEmpty then return ← Prog.throwError "Error" s!"hostname {hostname} did not resolve"
  let blocked : Prog Json := Prog.throwError "Error" s!"blocked private or metadata address for {hostname}"
  for address in normalized do
    if !truthy address || !Js.isStr (field address "address") then return ← blocked
    if !allowed.contains (field address "address") then
      let denied ← Prog.effect "isDeniedAddress" [field address "address"]
      if truthy denied then return ← blocked
  return normalized.headD Twin.undefinedJson

private def placeholderPattern : Json :=
  obj [("$regexp", toJson "/\\$\\{([A-Z][A-Z0-9_]*)\\}/g")]

/-- `ENV_PLACEHOLDER_PATTERN_G`, which also takes lowercase names. -/
private def anyCasePlaceholderPattern : Json :=
  obj [("$regexp", toJson "/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g")]

/-- The name of a `${NAME}` at the start of `rest`, with what follows it. -/
private def placeholderAt (anyCase : Bool) (rest : List Char) : Option (String × List Char) :=
  let lower (c : Char) : Bool := anyCase && 'a' ≤ c && c ≤ 'z'
  match rest with
  | '$' :: '{' :: first :: tail =>
    if ('A' ≤ first && first ≤ 'Z') || lower first || (anyCase && first == '_') then
      let more := tail.takeWhile fun c =>
        ('A' ≤ c && c ≤ 'Z') || lower c || Js.isAsciiDigit c || c == '_'
      match tail.drop more.length with
      | '}' :: after => some (String.ofList (first :: more), after)
      | _ => none
    else none
  | _ => none

/-- `String.replace` of every placeholder that names an own variable. -/
private def substituteText (anyCase : Bool) (variables : Json) : Nat → List Char → List Char
  | 0, rest => rest
  | _, [] => []
  | fuel + 1, rest@(c :: tail) =>
    match placeholderAt anyCase rest with
    | some (name, after) =>
      let value := field variables name
      (if nil value then ("${" ++ name ++ "}").toList else (text value).toList) ++
        substituteText anyCase variables fuel after
    | none => c :: substituteText anyCase variables fuel tail

/-- An object's entries in insertion order. The recorder writes `$keys` unless keys were sorted. -/
private def insertionEntries (value : Json) : List (String × Json) :=
  match value.getObjVal? "$keys" with
  | .ok (.arr names) =>
    names.toList.filterMap fun name =>
      match name with
      | .str key => (value.getObjVal? key).toOption.map (key, ·)
      | _ => none
  | _ => Js.entries value

private def substitutePlaceholders (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let variables := Twin.callArg call 1
  let pattern := Twin.callArg call 2
  let anyCase := pattern == anyCasePlaceholderPattern
  if pattern != placeholderPattern && !anyCase then
    return ← Prog.unsupported "only the two env patterns are modelled"
  if undef config then return config
  if Js.isStr config then
    let chars := (text config).toList
    return toJson (String.ofList (substituteText anyCase variables (chars.length + 1) chars))
  if Js.isArr config then
    let mut result : List Json := []
    for item in items config do
      let value ← Prog.effect "substitutePlaceholders" [item, variables, pattern]
      result := result ++ [value]
    return .arr result.toArray
  if Js.isObj config then
    let mut result := obj []
    for (key, value) in insertionEntries config do
      if !["__proto__", "constructor", "prototype"].contains key then
        let replaced ← Prog.effect "substitutePlaceholders" [value, variables, pattern]
        result := Js.set result key replaced
    return result
  return config

private def placeholderNames : Nat → List Char → List String
  | 0, _ => []
  | _, [] => []
  | fuel + 1, rest@(_ :: tail) =>
    match placeholderAt false rest with
    | some (name, after) => name :: placeholderNames fuel after
    | none => placeholderNames fuel tail

private def collectEnvPlaceholderNames (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let supplied := Twin.callArg call 1
  let names := if undef supplied then obj [("$set", .arr #[])] else supplied
  if undef value then return names
  if Js.isStr value then
    let chars := (text value).toList
    let found := placeholderNames (chars.length + 1) chars
    let added := found.foldl (fun seen name =>
      if seen.contains (toJson name) then seen else seen ++ [toJson name]) (items (field names "$set"))
    if !undef supplied then
      Prog.setChanged "args.1.$set" (field names "$set") (.arr added.toArray)
    return obj [("$set", .arr added.toArray)]
  let children := if Js.isArr value then items value
    else if Js.isObj value then (insertionEntries value).map (·.2) else []
  let mut current := names
  for item in children do
    current ← Prog.effect "collectEnvPlaceholderNames" [item, current]
  return current

private def taskFromRuns (call : Json) : Prog Json := do
  let runs := Twin.callArg call 0
  let root := field runs "root"
  let current := field runs "current"
  let base := obj ([("taskId", field root "runId"), ("createdAt", field root "createdAt"),
    ("lastUpdatedAt", field current "lastUpdatedAt"), ("ttlMs", .null), ("pollIntervalMs", toJson (2000 : Nat))].filter
      fun entry => !undef entry.2)
  let status := text (field current "status")
  let withStatus (value : String) : Json := Js.set base "status" (toJson value)
  if status == "awaiting_input" || status == "awaiting_approval" then
    let mut requests := obj []
    for prompt in items (field current "questions") do
      let request ← Prog.effect "questionRequest" [prompt]
      requests := Js.set requests ("question-" ++ text (field prompt "statusId")) request
    let approvals := field current "approvals"
    if !(items approvals).isEmpty then
      let request ← Prog.effect "approvalRequest" [approvals]
      requests := Js.set requests ("approval-" ++ text (field current "runId")) request
    return Js.set (withStatus "input_required") "inputRequests" requests
  if status == "completed" then
    let response := field current "response"
    if undef response && truthy (field current "error") then
      return ← Prog.effect "failedTask" [base, field current "error"]
    let result ← Prog.effect "answerResult" [current, field root "conversationKey"]
    return Js.set (withStatus "completed") "result" result
  if status == "failed" then
    if truthy (field current "stoppedByUser") then return withStatus "cancelled"
    let error := field current "error"
    return ← Prog.effect "failedTask" [base, if nil error then toJson "The run failed." else error]
  if status == "expired" then
    return ← Prog.effect "failedTask" [base, toJson "The run expired before it finished."]
  return withStatus "working"

private def nextRun (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let waiting := Twin.callArg call 1
  let accountId := field (field (field caller "auth") "account") "accountId"
  let eventId := field waiting "eventId"
  let eventIds ←
    if field waiting "status" == toJson "awaiting_approval" then
      pure [toJson (text eventId ++ ":approval")]
    else do
      let mut found : List Json := []
      for prompt in items (field waiting "questions") do
        let id ← Prog.effect "asyncToolContinuationEventId"
          [obj [("parentEventId", eventId), ("resultId", field prompt "statusId")]]
        found := found ++ [id]
      pure found
  let agentId := field waiting "agentId"
  for id in eventIds do
    let scopedId ← Prog.effect "scopedDirectEventId" [accountId, agentId, id]
    let next ← Prog.effect "getIngressStatusByEventId"
      [obj [("accountId", accountId), ("agentId", agentId), ("eventId", scopedId)]]
    if truthy (field next "runId") then
      return ← Prog.effect "readRun" [caller, field next "runId"]
  return .null

private def answerApprovals (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let run := Twin.callArg call 1
  let responses := Twin.callArg call 2
  let parsed ← Prog.effect "ElicitResultV2Schema.safeParse"
    [field responses ("approval-" ++ text (field run "runId"))]
  let decision := field parsed "data"
  if !truthy decision then return Twin.undefinedJson
  let accepted := field decision "action" == toJson "accept"
  let parts := (items (field run "approvals")).map fun approval =>
    let id := field approval "approvalId"
    obj [("type", toJson "tool-approval-response"), ("approvalId", id),
      ("approved", toJson (accepted && field (field decision "content") (text id) == toJson true))]
  let body := obj [("agentId", field run "agentId"), ("conversationKey", field run "conversationKey"),
    ("eventId", toJson (text (field run "eventId") ++ ":approval")), ("background", toJson true),
    ("events", .arr #[obj [("role", toJson "tool"), ("content", .arr parts.toArray)]])]
  let _ ← Prog.effect "sendRunRequest" [caller, body, toJson false]
  return Twin.undefinedJson

private def encodeText (value : String) : Json := encodeBytes (Js.utf8 value)

private def wrapAccountKey (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let secret := (items (Twin.callArg call 1)).headD Twin.undefinedJson
  let keyId := Twin.callArg call 2
  let iv ← Prog.effect "crypto.getRandomValues" [encodeBytes (List.replicate 12 0)]
  let kek ← Prog.effect "keyEncryptionKey" [secret]
  let aadText ← Prog.effect "wrapAad" [accountId, keyId]
  let sealed ← Prog.effect "WEB_CRYPTO.seal" [kek, iv, encodeText (text aadText), Twin.callArg call 3]
  let kekId ← Prog.effect "kekIdOf" [secret]
  let ivText ← Prog.effect "bytesToBase64Url" [iv]
  let sealedText ← Prog.effect "bytesToBase64Url" [sealed]
  return obj [("keyId", keyId), ("kekId", kekId), ("wrappedKey", toJson (text ivText ++ "." ++ text sealedText))]

private def unwrapLoop (accountId wrapped : Json) : List Json → Prog Json
  | [] => Prog.throwError "Error"
      s!"No ACCOUNT_CONFIG_ENCRYPTION_SECRET entry derives KEK {text (field wrapped "kekId")}"
  | secret :: rest => do
    let kekId ← Prog.effect "kekIdOf" [secret]
    if kekId != field wrapped "kekId" then return ← unwrapLoop accountId wrapped rest
    let parts := (text (field wrapped "wrappedKey")).splitOn "."
    let iv := parts.getD 0 ""
    let sealed := parts.getD 1 ""
    if iv.isEmpty || sealed.isEmpty then return ← Prog.throwError "Error" "Malformed wrapped account key"
    let kek ← Prog.effect "keyEncryptionKey" [secret]
    let ivBytes ← Prog.effect "base64UrlToBytes" [toJson iv]
    let aadText ← Prog.effect "wrapAad" [accountId, field wrapped "keyId"]
    let sealedBytes ← Prog.effect "base64UrlToBytes" [toJson sealed]
    Prog.effect "primitive.open" [kek, ivBytes, encodeText (text aadText), sealedBytes]

private def unwrapAccountKey (call : Json) : Prog Json :=
  unwrapLoop (Twin.callArg call 0) (Twin.callArg call 2) (items (Twin.callArg call 1))

private def webCryptoFns : Json :=
  obj [("hmac", fn "hmac"), ("open", fn "open"), ("seal", fn "seal")]

private def rewrapAccountKey (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let secrets := Twin.callArg call 1
  let wrapped := Twin.callArg call 2
  let current ← Prog.effect "kekIdOf" [(items secrets).headD Twin.undefinedJson]
  if field wrapped "kekId" == current then return .null
  let dek ← Prog.effect "unwrapAccountKey" [accountId, secrets, wrapped, webCryptoFns]
  let next ← Prog.effect "wrapAccountKey" [accountId, secrets, field wrapped "keyId", dek]
  return obj [("kekId", field next "kekId"), ("wrappedKey", field next "wrappedKey")]

private def createWrappedAccountKey (call : Json) : Prog Json := do
  let raw ← Prog.effect "crypto.getRandomValues" [encodeBytes (List.replicate 6 0)]
  let keyId ← Prog.effect "hexFromBytes" [raw]
  let dek ← Prog.effect "crypto.getRandomValues" [encodeBytes (List.replicate 32 0)]
  Prog.effect "wrapAccountKey" [Twin.callArg call 0, Twin.callArg call 1, keyId, dek]

/-- Whether `JSON.stringify` of this value cannot depend on key insertion order. -/
private def encrypt (call : Json) : Prog Json := do
  let scope := Twin.callArg call 0
  let value := Twin.callArg call 1
  let keyId ← Prog.effect "this.requireCurrentKeyId"
  let iv ← Prog.effect "crypto.getRandomValues" [encodeBytes (List.replicate 12 0)]
  let dataKey ← Prog.effect "this.dataKey" [keyId]
  let aadText ← Prog.effect "this.aad" [scope]
  let sealed ← Prog.effect "this.primitive.seal"
    [dataKey, iv, encodeText (text aadText), encodeText (Twin.jsonStringify 64 value)]
  match decodeBytes sealed with
  | none => Prog.unsupported "unrepresented sealed bytes"
  | some bytes =>
    let split := bytes.length - 16
    let body ← Prog.effect "bytesToBase64Url" [encodeBytes (bytes.take split)]
    let ivText ← Prog.effect "bytesToBase64Url" [iv]
    let tag ← Prog.effect "bytesToBase64Url" [encodeBytes (bytes.drop split)]
    return obj [("ciphertext", toJson ("v2:" ++ text keyId ++ ":" ++ text body)), ("iv", ivText), ("tag", tag)]

private def digest (call : Json) : Prog Json := do
  let keyId ← Prog.effect "this.requireCurrentKeyId"
  let dataKey ← Prog.effect "this.dataKey" [keyId]
  let mac ← Prog.effect "this.primitive.hmac" [dataKey, encodeText (text (Twin.callArg call 0))]
  Prog.effect "hexFromBytes" [mac]

private def decryptEnvelope (call : Json) : Prog Json := do
  let keyId := Twin.callArg call 0
  let blob := Twin.callArg call 2
  let dataKey ← Prog.effect "this.dataKey" [keyId]
  let iv ← Prog.effect "base64UrlToBytes" [field blob "iv"]
  let aadText ← Prog.effect "this.aad" [Twin.callArg call 1]
  let body := String.ofList ((text (field blob "ciphertext")).toList.drop (3 + (text keyId).length + 1))
  let bodyBytes ← Prog.effect "base64UrlToBytes" [toJson body]
  let tag ← Prog.effect "base64UrlToBytes" [field blob "tag"]
  let joined ← Prog.effect "concatBytes" [bodyBytes, tag]
  let plaintext ← Prog.effect "this.primitive.open" [dataKey, iv, encodeText (text aadText), joined]
  match decodeBytes plaintext with
  | none => Prog.unsupported "unrepresented plaintext bytes"
  | some bytes =>
    match String.fromUTF8? (ByteArray.mk (bytes.map (·.toUInt8)).toArray) with
    | some decoded => return toJson decoded
    | none => Prog.unsupported "TextDecoder replacement characters are not modelled"

private def decrypt (call : Json) : Prog Json := do
  let blob := Twin.callArg call 1
  let keyId ← Prog.effect "blobKeyId" [blob]
  if keyId == .null then return .null
  Prog.catchFail
    (do
      let plaintext ← Prog.effect "this.decryptEnvelope" [keyId, Twin.callArg call 0, blob]
      match Json.parse (text plaintext) with
      | .error _ => return .null
      | .ok parsed =>
        let value ← Prog.effect "parseOr" [obj [("$opaque", toJson "ZodMiniRecord")], parsed]
        return if nil value then .null else value)
    (fun error =>
      if (error.getObjVal? "$unsupported").toOption.isSome then .fail error else pure .null)

/-- `URLSearchParams` serialisation of one name or value. -/
private def formEncode (value : String) : String :=
  String.join ((Js.utf8 value).map fun byte =>
    let c := Char.ofNat byte
    if byte < 128 && (Js.isAsciiAlnum c || "*-._".toList.contains c) then c.toString
    else if byte == 32 then "+"
    else "%" ++ (Js.hex [byte]).toUpper)

private def responseStatus (response : Json) : Nat :=
  (Js.nat? (field (field response "$response") "status")).getD 0

private def responseOk (response : Json) : Bool :=
  let status := responseStatus response
  status ≥ 200 && status < 300

private def tokenGrant (call : Json) : Prog Json := do
  let given := (insertionEntries (Twin.callArg call 1)).filter (·.1 != "$keys")
  let grant := ((given.find? (·.1 == "grant_type")).map (·.2)).getD (toJson "refresh_token")
  let pairs := ("grant_type", grant) :: given.filter (·.1 != "grant_type")
  let form := pairs.map fun (key, value) => formEncode key ++ "=" ++ formEncode (text value)
  let response ← Prog.effect "fetchToken" [Twin.callArg call 0, obj [("method", toJson "POST"),
    ("headers", obj [("Content-Type", toJson "application/x-www-form-urlencoded")]),
    ("body", toJson ("&".intercalate form))]]
  let body ← Prog.effect "response.text"
  if !responseOk response then
    let head := String.ofList ((text body).toList.take 512)
    return ← Prog.throwError "Error" s!"status {responseStatus response} {head}"
  match Json.parse (text body) with
  | .error _ => Prog.throwError "Error" "token endpoint returned non-JSON"
  | .ok parsed =>
    if parsed == .null then return ← Prog.unsupported "property read on a null token response"
    let access := field parsed "access_token"
    if !Js.isStr access || access == toJson "" then
      return ← Prog.throwError "Error" "token response carries no access_token"
    let expires := field parsed "expires_in"
    let seconds ← match expires with
      | .num n =>
        if n.mantissa > 0 then
          match Js.nat? expires with
          | some whole => pure whole
          | none => Prog.unsupported "fractional expires_in"
        else pure 3600
      | _ => pure 3600
    let now ← Prog.effect "Date.now"
    let refresh := field parsed "refresh_token"
    let base := [("accessToken", access), ("expiresAt", toJson ((Js.nat? now).getD 0 + seconds * 1000))]
    return obj (if Js.isStr refresh && truthy refresh then ("refreshToken", refresh) :: base else base)

/-- `MAX_TOKEN_CACHE_ENTRIES` in `oauth.ts`. -/
private def maxTokenCacheEntries : Nat := 256

private def mintAccessToken (call : Json) : Prog Json := do
  let name := text (Twin.callArg call 0)
  let oauth := Twin.callArg call 1
  let key := Twin.callArg call 2
  let rotatedMap := Twin.moduleValue call "rotatedRefreshTokens"
  let rotated := (Spec.Channels.Wavechannels8a.mapEntries rotatedMap).find? fun entry => Twin.arg entry 0 == key
  let outcome ← Prog.attempt "tokenGrant" [field oauth "tokenUrl", obj
    [("client_id", field oauth "clientId"), ("client_secret", field oauth "clientSecret"),
     ("refresh_token", match rotated with
       | some entry => Twin.arg entry 1
       | none => field oauth "refreshToken")], fn "publicHostFetch"]
  match outcome with
  | .ok token =>
    if truthy (field token "refreshToken") then
      let entries := Spec.Channels.Wavechannels8a.mapEntries rotatedMap
      let known := rotated.isSome
      let trimmed := if !known && entries.length >= maxTokenCacheEntries then entries.drop 1 else entries
      let next := Spec.Channels.Wavechannels8a.mapSet (Spec.Channels.Wavechannels8a.mapValue trimmed) key
        (field token "refreshToken")
      if next != rotatedMap then Prog.setState "module.rotatedRefreshTokens" next
    match Js.int? (field token "expiresAt") with
    | some expiresAt =>
      return obj [("accessToken", field token "accessToken"), ("expiresAt", toJson (expiresAt - 60000))]
    | none => Prog.unsupported "non-integer token expiry"
  | .threw error _ =>
    let message ← Prog.effect "toErrorMessage" [error]
    Prog.throwError "Error"
      s!"MCP server {name}: OAuth token refresh against {text (field oauth "tokenUrl")} failed: {text message}"
  | .pending => Prog.unsupported "the token refresh never finished"

private def principalHeaderNames : List String :=
  ["x-broods-agent-id", "x-broods-principal", "x-broods-user-credential"]

private def mcpConnection (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let config := Twin.callArg call 1
  let principal := Twin.callArg call 3
  let credentialValue := Twin.callArg call 4
  let configEntries := if nil config then [] else Js.entries config
  let overridden := configEntries.map (·.1.toLower)
  let stored := field record "headers"
  let rowEntries := (if nil stored then [] else Js.entries stored).filter fun entry =>
    !overridden.contains entry.1.toLower
  let headers := obj ((rowEntries ++ configEntries).filter fun entry =>
    !principalHeaderNames.contains entry.1.toLower)
  let placeholder := Js.Re.seqs [.lit "${", .any (fun c => 'A' ≤ c && c ≤ 'Z'),
    .star (.any (fun c => ('A' ≤ c && c ≤ 'Z') || Js.isAsciiDigit c || c == '_')) true, .lit "}"]
  let server := text (field record "serverId")
  match (Js.entries headers).find? (fun entry => Js.Re.test placeholder (text entry.2)) with
  | some (name, _) =>
    return ← Prog.throwError "Error"
      ("config.mcp." ++ server ++ " header " ++ name ++
       " still carries a ${NAME} ref; set it in the agent config so it resolves at sync")
  | none => pure ()
  let oauth ← Prog.effect "resolveOauth" [record, Twin.callArg call 2]
  if truthy oauth then
    let authorization ← Prog.effect "authorizationHeaderName" [headers]
    if !undef authorization then
      return ← Prog.throwError "Error"
        s!"config.mcp.{server} sets both an {text authorization} header and oauth; oauth mints that header itself"
  let credential :=
    if field record "transport" == toJson "hosted" && !undef credentialValue then
      some (obj [("X-Broods-User-Credential", credentialValue)])
    else none
  let identity ← if truthy principal then Prog.effect "principalHeaders" [principal] else pure (obj [])
  let result := obj [("record", record), ("headers", headers)]
  let result := if undef (field principal "agentId") then result else Js.set result "agentId" (field principal "agentId")
  let result := if truthy oauth then Js.set result "oauth" oauth else result
  if truthy principal || credential.isSome then
    return Js.set result "principalHeaders" (Js.spread identity (credential.getD (obj [])))
  return result

private def cacheKeyFor (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let record := field connection "record"
  let headers := .arr ((Js.entries (field connection "headers")).map fun (key, value) =>
    Json.arr #[toJson key, value]).toArray
  let sandbox := field (field connection "sandbox") "config"
  let orNull := fun (value : Json) => if nil value then Json.null else value
  let server ← if truthy sandbox then do
      let env ← Prog.effect "mergeSandboxEnv" [field sandbox "envVars"]
      pure (Json.arr #[orNull (field sandbox "image"), orNull (field sandbox "snapshot"),
        orNull (field sandbox "onCreate"), orNull (field sandbox "onResume"), env])
    else pure .null
  let payload := Json.arr #[headers, orNull (field connection "oauth"), server]
  let identity ← Prog.effect "cacheDigest" [toJson (Twin.jsonStringify 64 payload)]
  let agent := if field record "transport" == toJson "hosted" && !nil (field connection "agentId")
    then text (field connection "agentId") else ""
  return toJson s!"{text (field record "serverId")}:{text (field record "updatedAt")}:{text identity}:{agent}"

private def cancelTask (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let taskId := Twin.callArg call 1
  let auth := field caller "auth"
  if field auth "kind" != toJson "account" && field auth "kind" != toJson "deployment" then
    let error ← Prog.effect "unknownTask" [taskId]
    return ← .fail error
  let runs ← Prog.effect "resolveTask" [caller, taskId]
  if ["completed", "failed", "expired"].contains (text (field (field runs "current") "status")) then return Twin.undefinedJson
  let accountId := field (field auth "account") "accountId"
  let root := field runs "root"
  let key ← Prog.effect "scopedDirectConversationKey" [accountId, field root "agentId", field root "conversationKey"]
  let current := field runs "current"
  let owner ← Prog.effect "scopedDirectEventId"
    [accountId, field current "agentId", field current "eventId"]
  let _ ← Prog.effect "runtime.mutate" [toJson "stopIngressOwner", obj
    [("accountId", accountId), ("agentId", field root "agentId"), ("conversationKey", key),
     ("expectedOwnerEventId", owner)]]
  return Twin.undefinedJson

private def updateTask (call : Json) : Prog Json := do
  let caller := Twin.callArg call 0
  let runs ← Prog.effect "resolveTask" [caller, Twin.callArg call 1]
  let current := field runs "current"
  let status := field current "status"
  if status == toJson "awaiting_input" then
    let _ ← Prog.effect "answerQuestions" [caller, current, Twin.callArg call 2]
  else if status == toJson "awaiting_approval" then
    let _ ← Prog.effect "answerApprovals" [caller, current, Twin.callArg call 2]
  return Twin.undefinedJson

private def guardedFetchWithDeadline (call : Json) : Prog Json := do
  let init := Twin.callArg call 1
  let state := Twin.callArg call 2
  let redirects := (Js.nat? (field state "redirects")).getD 0
  if redirects > (Js.nat? (field state "redirectLimit")).getD 0 then
    return ← Prog.throwError "Error" "redirect limit exceeded"
  let _ ← Prog.effect "throwIfAborted" [field state "signal"]
  let target ← Prog.effect "validateHttpUrl" [Twin.callArg call 0]
  match Url.parse (text (field target "$url")) with
  | .invalid => Prog.unsupported "validated URL failed to parse"
  | .unknown reason => Prog.unsupported reason
  | .ok parsed =>
    let pinned ← Prog.effect "resolveAllowedAddress" [toJson parsed.hostname, state]
    let response ← Prog.effect "requestPinned" [target, pinned, init, state]
    let redirect ← Prog.effect "isRedirect" [field response "status"]
    if !truthy redirect then return response
    let location := field (field response "headers") "location"
    if !truthy location then return ← Prog.throwError "Error" "redirect missing location"
    match Url.parse (text location) with
    | .ok next =>
      if !Url.plainHref next then return ← Prog.unsupported "URL path encoding"
      let nextInit ← Prog.effect "redirectInit"
        [field response "status", init, toJson (Url.origin next != Url.origin parsed)]
      Prog.effect "guardedFetchWithDeadline"
        [toJson (Url.href next), nextInit, Js.set state "redirects" (toJson (redirects + 1))]
    | _ => Prog.unsupported "a relative redirect needs URL base resolution"

private def guardedFetch (call : Json) : Prog Json := do
  let init := Twin.callArg call 1
  let supplied := Twin.callArg call 2
  let opts := if undef supplied then obj [] else supplied
  let timeoutMs ← match field opts "timeoutMs" with
    | .num n =>
      if n.mantissa ≤ 0 then pure 0
      else match Js.nat? (.num n) with
        | some whole => pure whole
        | none => Prog.unsupported "fractional timeout"
    | _ => pure 30000
  let entered : Prog (Option (String × Json)) := .input .done
  match ← entered with
  | some ("arg0", _) => pure ()
  | _ => return ← Prog.unsupported "the promise executor did not run first"
  let timer ← Prog.effect "setTimeout" [fn "", toJson timeoutMs]
  let sanitized ← match ← Prog.attempt "sanitizeFetchInit" [init] with
    | .ok value => pure value
    | .threw error _ =>
      let _ ← Prog.effect "clearTimeout" [timer]
      return ← .fail error
    | .pending => return ← Prog.unsupported "sanitizeFetchInit never finished"
  let now ← Prog.effect "Date.now"
  let limit := match field opts "redirectLimit" with
    | .num n => match Js.int? (.num n) with
      | some value => (max value 0).toNat
      | none => 5
    | _ => 5
  let state := Js.spread opts (obj [("signal", obj [("$signal", toJson false)]),
    ("deadlineAt", toJson ((Js.nat? now).getD 0 + timeoutMs)),
    ("redirectLimit", toJson limit), ("redirects", toJson (0 : Nat))])
  match ← entered with
  | some _ => return ← Prog.unsupported "the timeout fired, which is decided by the race"
  | none => pure ()
  let outcome ← Prog.attempt "guardedFetchWithDeadline" [Twin.callArg call 0, sanitized, state]
  let _ ← Prog.effect "clearTimeout" [timer]
  match outcome with
  | .ok value => return value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "the fetch never finished"

private def recordSchema : Json := obj [("$opaque", toJson "ZodMiniRecord")]

private def parseProbe (call : Json) : Prog Json := do
  let probe ← Prog.effect "parseOr" [recordSchema, Twin.callArg call 0]
  if !truthy probe then return toJson "rpc needs a serverId or a probe object"
  let name := field probe "name"
  if !Js.isStr name || !truthy name then return toJson "probe needs a name"
  let rawHeaders := field probe "headers"
  let headers ← if undef rawHeaders then pure Twin.undefinedJson
    else Prog.effect "parseOr" [recordSchema, rawHeaders]
  if !undef rawHeaders && !truthy headers then return toJson "probe headers must be a string record"
  let shared := if truthy headers then [("name", name), ("headers", headers)] else [("name", name)]
  let transport := field probe "transport"
  if transport == toJson "http" then
    let url := field probe "url"
    if !Js.isStr url || !truthy url then return toJson "an http probe needs a url"
    return obj (shared ++ [("transport", transport), ("url", url)])
  if transport == toJson "hosted" then
    let key := field probe "bundleStorageKey"
    let sha := field probe "sha256"
    if !Js.isStr key || !Js.isStr sha then return toJson "a hosted probe needs bundleStorageKey and sha256"
    let workers := field probe "workersCompatible"
    if !undef workers && !Js.isBool workers then return toJson "probe workersCompatible must be a boolean"
    let optional := if undef workers then [] else [("workersCompatible", workers)]
    return obj (shared ++ [("transport", transport), ("bundleStorageKey", key), ("sha256", sha)] ++ optional)
  return toJson "probe transport must be http or hosted"

private def signalAborted (signal : Json) : Bool :=
  truthy (field signal "$signal") || truthy (field signal "aborted")

/-- The `for` loop of `callMcpTool`: at most `RATE_LIMIT_RETRIES` retries. -/
private def retryRateLimited (callResult : Prog Json) (options : Json) : Nat → Nat → Json → Prog Json
  | 0, _, result => pure result
  | fuel + 1, attempt, result => do
    if !truthy (field result "isError") then return result
    let message ← Prog.effect "renderContent" [field result "content"]
    let waitMs ← Prog.effect "rateLimitWaitMs" [message, toJson attempt]
    if waitMs == .null then return result
    let _ ← Prog.effect "sleep" [waitMs, field options "abortSignal"]
    if signalAborted (field options "abortSignal") then return result
    if !undef (field options "onRetry") then
      let _ ← Prog.effect "options.onRetry" [waitMs]
    let next ← callResult
    retryRateLimited callResult options fuel (attempt + 1) next

/-- `Array.prototype.some` over the content blocks: stops at the first image. -/
private def anyImage : List Json → Prog Bool
  | [] => pure false
  | block :: rest => do
    if field block "type" == toJson "image" then return true
    let linked ← Prog.effect "isImageLink" [block]
    if truthy linked then return true
    anyImage rest

private def callMcpTool (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let toolName := Twin.callArg call 1
  let supplied := Twin.callArg call 3
  let options := if undef supplied then obj [] else supplied
  let callResult := Prog.effect "callMcpToolResult" [connection, toolName, Twin.callArg call 2, options]
  let first ← callResult
  let result ← retryRateLimited callResult options 3 1 first
  let content := field result "content"
  if truthy (field result "isError") then
    let message ← Prog.effect "renderContent" [content]
    return ← Prog.throwError "Error"
      s!"MCP tool {text (field (field connection "record") "name")}.{text toolName} failed: {text message}"
  let structured := field result "structuredContent"
  if ← anyImage (items content) then
    return ← Prog.effect "imageContentOutput" [content, structured]
  if !nil structured then return structured
  Prog.effect "renderContent" [content]

private def linkedImage (call : Json) : Prog Json := do
  let outcome ← Prog.attempt "guardedFetch" [Twin.callArg call 0, Twin.undefinedJson, obj
    [("binary", toJson true), ("bodyLimitBytes", toJson (6291456 : Nat)), ("timeoutMs", toJson (30000 : Nat))]]
  match outcome with
  | .ok response =>
    let status := (Js.nat? (field response "status")).getD 0
    if status < 200 || status ≥ 300 then return Twin.undefinedJson
    let bytes := field (field response "bodyBytes") "$bytes"
    if undef bytes then return ← Prog.unsupported "body bytes were not recorded as bytes"
    return obj [("type", toJson "image-data"), ("data", bytes), ("mediaType", Twin.callArg call 1)]
  | .threw _ _ => return Twin.undefinedJson
  | .pending => Prog.unsupported "the image fetch never finished"

private def sandboxMcpRequest (call : Json) : Prog Json := do
  let target := Twin.callArg call 0
  let serverName := text (Twin.callArg call 1)
  let message := Twin.callArg call 2
  let abortSignal := Twin.callArg call 3
  let executor := Twin.callArg call 4
  if undef executor then return ← Prog.unsupported "the default executor is built from module state"
  let config := field target "config"
  if undef (field executor "postReserved") then
    return ← Prog.throwError "Error"
      s!"MCP server {serverName} needs a lambda sandbox; {text (field config "provider")} has no MCP host"
  let seconds ← Prog.effect "sandboxTimeoutSeconds" [config, toJson (120 : Nat)]
  let timeoutMs := (Js.nat? seconds).getD 0 * 1000
  let env ← Prog.effect "mergeSandboxEnv" [field config "envVars"]
  let uuid ← Prog.effect "randomUUID"
  let rpc := obj ([("jsonrpc", toJson "2.0"), ("id", uuid), ("method", field message "method")] ++
    (if undef (field message "params") then [] else [("params", field message "params")]))
  let body := obj [("server", toJson serverName), ("command", field target "command"), ("env", env),
    ("message", rpc), ("timeout_ms", toJson timeoutMs)]
  let extra := [("path", toJson "/mcp"), ("body", body), ("timeoutMs", toJson (timeoutMs + 30000))] ++
    (if undef abortSignal then [] else [("abortSignal", abortSignal)])
  let outcome ← Prog.attempt "executor .postReserved" [Js.spread (field target "reservation") (obj extra)]
  match outcome with
  | .pending => Prog.unsupported "the sandbox request never finished"
  | .threw error _ =>
    let text' ← Prog.effect "toErrorMessage" [error]
    Prog.throwError "Error" s!"MCP server {serverName} on its sandbox failed: {text text'}"
  | .ok reply =>
    let failed ← Prog.effect "isJSONRPCErrorResponse" [reply]
    if truthy failed then
      return ← Prog.throwError "Error" s!"MCP server {serverName}: {text (field (field reply "error") "message")}"
    let good ← Prog.effect "isJSONRPCResultResponse" [reply]
    if !truthy good then
      return ← Prog.throwError "Error" s!"MCP server {serverName} answered with no JSON-RPC result"
    return field reply "result"

private def agentSandboxCandidate (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let record := Twin.callArg call 1
  let agent := Twin.callArg call 2
  let hostId := field (Twin.callArg call 3) "sandboxId"
  let agentConfig := field agent "config"
  let ownsHost := (items (field agentConfig "sandboxes")).head? == some hostId
  let refs := if ownsHost then (items (field agentConfig "workspaces")).filter fun ref =>
      undef (field ref "sandbox") || field ref "sandbox" == hostId
    else []
  let outcome ← Prog.attempt "resolveAgentRuntime"
    [obj [("sandboxes", .arr #[hostId]), ("workspaces", .arr refs.toArray)],
     obj [("accountId", accountId), ("agentId", field agent "agentId")]]
  let runtime := match outcome with
    | .ok value => value
    | _ => Twin.undefinedJson
  if !truthy runtime then return Twin.undefinedJson
  let own ← Prog.effect "agentOwnWorkspace" [runtime]
  if field (field own "config") "isolation" == toJson "conversation" then return Twin.undefinedJson
  let target ← Prog.effect "sandboxMcpTarget" [record, runtime]
  if !truthy target then return Twin.undefinedJson
  let key ← Prog.effect "sandboxReservationKey" [field target "reservation"]
  if !truthy key then return Twin.undefinedJson
  let reservation ← Prog.effect "getSandboxReservationRecord" [field (field target "config") "provider", key]
  if reservation == .null then return obj [("target", target)]
  let now ← Prog.effect "Date.now"
  let live := (Js.int? (field reservation "expiresAt")).getD 0 ≥ (((Js.nat? now).getD 0) / 1000 : Nat)
  return obj ([("target", target)] ++ (if live then [("liveSince", field reservation "claimedAt")] else []))

private def otlpLogsRequest (call : Json) : Prog Json := do
  let payload := Twin.callArg call 0
  let stream ← Prog.effect "parseLogStream" [field payload "logStream", Twin.callArg call 1]
  let mut records : List Json := []
  for event in items (field payload "logEvents") do
    let body ← Prog.effect "redact" [field event "message"]
    let attributes ← Prog.effect "otlpAttributes" [obj
      [("sandbox_id", field stream "sandboxId"), ("source", toJson "sandbox"), ("provider", toJson "lambda"),
       ("aws.cloudwatch.log_group", field payload "logGroup"),
       ("aws.cloudwatch.log_stream", field payload "logStream")]]
    let nanos := (Js.nat? (field event "timestamp")).getD 0 * 1000000
    records := records ++ [obj [("timeUnixNano", toJson (toString nanos)), ("severityText", toJson "INFO"),
      ("body", obj [("stringValue", body)]), ("attributes", attributes)]]
  let optional := [("account_id", "accountId"), ("project", "project"), ("stage", "stage")].filterMap fun (key, name) =>
    if truthy (field stream name) then some (key, field stream name) else none
  let attributes ← Prog.effect "otlpAttributes" [obj (("service.name", toJson "broods-sandbox") :: optional)]
  return obj [("resourceLogs", .arr #[obj [("resource", obj [("attributes", attributes)]),
    ("scopeLogs", .arr #[obj [("scope", obj [("name", toJson "broods-sandbox")]),
      ("logRecords", .arr records.toArray)]])]])]

/-- These functions compute their answers from call arguments and explicit effect responses. -/
def twins : List Spec.Twin :=
  [Twin.traced "packages/convex/model/inputSchema.ts#defaultMessage" defaultMessage,
   Twin.traced "packages/convex/model/agentRules.ts#assertMetaCredentials" assertMetaCredentials,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#sanitizeFetchInit" sanitizeFetchInit,
   Twin.traced "apps/core/src/harness/mcp/client.ts#resolveOauth" resolveOauth,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#normalizeRequestHeaders" normalizeRequestHeaders,
   Twin.traced "packages/convex/model/agentRules.ts#publicHttpsUrlProblem" publicHttpsUrlProblem,
   Twin.traced "apps/core/src/harness/frames.ts#parseRunnerFrame" parseRunnerFrame,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#ipv4ToInt" ipv4ToInt,
   Twin.traced "packages/convex/model/agentRules.ts#assertHarnessSupports" assertHarnessSupports,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#validateHttpUrl" validateHttpUrl,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#writeRequestBody" writeRequestBody,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#forwardAbortSignal" forwardAbortSignal,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#otlpHeaders" otlpHeaders,
   Twin.traced "apps/core/src/harness/mcp/client.ts#chainWithoutNames" chainWithoutNames,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#responseHeadersToRecord" responseHeadersToRecord,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#questionRequest" questionRequest,
   Twin.traced "apps/core/src/harness/mcp/client.ts#renderContent" renderContent,
   Twin.traced "apps/core/src/harness/mcp/hosted.ts#finalHostedResponse" finalHostedResponse,
   Twin.traced "packages/convex/model/requestId.ts#withRequestId" withRequestId,
   Twin.traced "packages/convex/model/mcp.ts#normalizeHeaders" normalizeHeaders,
   Twin.traced "packages/convex/model/mcp.ts#authorizationHeaderName" authorizationHeaderName,
   Twin.traced "apps/core/src/harness/mcp/sandbox.ts#sandboxMcpTarget" sandboxMcpTarget,
   Twin.traced "packages/convex/model/envelope.ts#blobKeyId" blobKeyId,
   Twin.traced "packages/convex/model/envelope.ts#concatBytes" concatBytes,
   Twin.traced "packages/convex/model/envelope.ts#base64UrlToBytes" base64UrlToBytes,
   Twin.traced "packages/convex/model/envelope.ts#bytesToBase64Url" bytesToBase64Url,
   Twin.traced "packages/convex/model/envelope.ts#toArrayBuffer" toArrayBuffer,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.requireCurrentKeyId" requireCurrentKeyId,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.aad" aad,
   Twin.traced "packages/convex/model/agentRules.ts#mergeCanvasSandboxes" mergeCanvasSandboxes,
   Twin.traced "packages/convex/model/agentRules.ts#providerBaseURL" providerBaseURL,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#errorText" errorText,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#toolResult" toolResult,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#unknownTask" unknownTask,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#isolateLogRecord" isolateLogRecord,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#scoped" scopedSegment,
   Twin.traced "packages/convex/model/sandboxMounts.ts#workspaceOnLaterSandbox" workspaceOnLaterSandbox,
   Twin.traced "apps/core/src/harness/mcp/client.ts#mcpRequestHeaders" mcpRequestHeaders,
   Twin.traced "apps/core/src/harness/mcp/client.ts#isImageLink" isImageLink,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#isRedirect" isRedirect,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#bodyLimitMessage" bodyLimitMessage,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#throwIfAborted" throwIfAborted,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#concatBytes" concatChunks,
   Twin.traced "apps/core/src/harness/mcp/hosted.ts#bundleKey" bundleKey,
   Twin.traced "apps/core/src/harness/mcp/hosted.ts#hasBundle" hasBundle,
   Twin.traced "apps/core/src/harness/mcp/hosted.ts#hostedMcpTenantId" hostedMcpTenantId,
   Twin.traced "apps/core/src/harness/frames.ts#toolBundlesBucket" toolBundlesBucket,
   Twin.traced "apps/core/src/harness/mcp/mcp.tool.ts#mcpToolName" mcpToolName,
   Twin.traced "packages/convex/model/requestId.ts#resolveRequestId" resolveRequestId,
   Twin.traced "apps/core/src/harness/mcp/client.ts#clampTtlMs" clampTtlMs,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#requireTaskCapability" requireTaskCapability,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#failedTask" failedTask,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#readRun" readRun,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#resolveTask" resolveTask,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#assertNoUnsupportedKeys" assertNoUnsupportedKeys,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#IsolateWorker.kill" killWorker,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#isolatePoolEnabled" isolatePoolEnabled,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#isolateRunnerNode" isolateRunnerNode,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#isolateRunnerPath" isolateRunnerPath,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#poolSize" poolSize,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#runnerTimeoutMs" runnerTimeoutMs,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#workerReadyTimeoutMs" workerReadyTimeoutMs,
   Twin.traced "packages/convex/model/envelope.ts#sha256" sha256,
   Twin.traced "packages/convex/model/envelope.ts#keyEncryptionKey" keyEncryptionKey,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.needsRewrite" needsRewrite,
   Twin.traced "packages/convex/model/agentRules.ts#assertCompleteChannels" assertCompleteChannels,
   Twin.traced "packages/convex/model/agentRules.ts#assertRuntimeRefs" assertRuntimeRefs,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#ipv4InCidr" ipv4InCidr,
   Twin.traced "packages/convex/model/httpJson.ts#json" jsonResponse,
   Twin.traced "packages/convex/model/httpJson.ts#jsonError" jsonError,
   Twin.traced "packages/convex/model/httpJson.ts#methodNotAllowed" methodNotAllowed,
   Twin.traced "apps/core/src/harness/mcp/client.ts#rateLimitWaitMs" rateLimitWaitMs,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#verifyLogStream" verifyLogStream,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#decodeCloudWatchEvent" decodeCloudWatchEvent,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#parseLogStream" parseLogStream,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#sendRunRequest" sendRunRequest,
   Twin.traced "apps/core/src/accounts/mcp-service.ts#probeRecord" probeRecord,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.hasKey" hasKey,
   Twin.traced "apps/core/src/harness/mcp/oauth.ts#mcpOauthTokenCacheKey" mcpOauthTokenCacheKey,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#emitIsolateLog" emitIsolateLog,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#withoutHeaders" withoutHeaders,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#redirectInit" redirectInit,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#isDeniedAddress" isDeniedAddress,
   Twin.traced "apps/core/src/harness/mcp/mcp.tool.ts#mcpTools" mcpTools,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#resolveAllowedAddress" resolveAllowedAddress,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#substitutePlaceholders" substitutePlaceholders,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#collectEnvPlaceholderNames" collectEnvPlaceholderNames,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#taskFromRuns" taskFromRuns,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#nextRun" nextRun,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#answerApprovals" answerApprovals,
   Twin.traced "packages/convex/model/envelope.ts#wrapAccountKey" wrapAccountKey,
   Twin.traced "packages/convex/model/envelope.ts#unwrapAccountKey" unwrapAccountKey,
   Twin.traced "packages/convex/model/envelope.ts#rewrapAccountKey" rewrapAccountKey,
   Twin.traced "packages/convex/model/envelope.ts#createWrappedAccountKey" createWrappedAccountKey,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.encrypt" encrypt,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.digest" digest,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.decryptEnvelope" decryptEnvelope,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.decrypt" decrypt,
   Twin.traced "apps/core/src/harness/mcp/oauth.ts#tokenGrant" tokenGrant,
   Twin.traced "apps/core/src/harness/mcp/oauth.ts#mintAccessToken" mintAccessToken,
   Twin.traced "apps/core/src/harness/mcp/client.ts#mcpConnection" mcpConnection,
   Twin.traced "apps/core/src/harness/mcp/client.ts#cacheKeyFor" cacheKeyFor,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#cancelTask" cancelTask,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#updateTask" updateTask,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#guardedFetchWithDeadline" guardedFetchWithDeadline,
   Twin.traced "apps/core/src/harness/isolate/runner/pinned-fetch.mjs#guardedFetch" guardedFetch,
   Twin.traced "apps/core/src/accounts/mcp-service.ts#parseProbe" parseProbe,
   Twin.traced "apps/core/src/harness/mcp/client.ts#callMcpTool" callMcpTool,
   Twin.traced "apps/core/src/harness/mcp/client.ts#linkedImage" linkedImage,
   Twin.traced "apps/core/src/harness/mcp/sandbox.ts#sandboxMcpRequest" sandboxMcpRequest,
   Twin.traced "apps/core/src/accounts/mcp-service.ts#agentSandboxCandidate" agentSandboxCandidate,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#otlpLogsRequest" otlpLogsRequest]

end Spec.Hosted.Wavehosted1
