import Spec.Twin
import Spec.Access.Twins.Waveaccess8a
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

/-!
Twins for the functions listed in `.lake/worklist/assign3/access3a.tsv`.
-/

namespace Spec.Access.Waveaccess3a

open Lean Spec Js

private def field (v : Json) (k : String) : Json := (prop v k).getD Twin.undefinedJson

private def isUndef (v : Json) : Bool := v == Twin.undefinedJson

private def truth (v : Json) : Bool := !isUndef v && truthy v

private def text (v : Json) : String :=
  match v with
  | .str s => s
  | _ => ""

private def items (v : Json) : List Json :=
  match v with
  | .arr xs => xs.toList
  | _ => []

private def str (s : String) : Json := .str s

/-- Standard base64 with padding, the way the recorder writes bytes. -/
private def bytesJson (bytes : List UInt8) : Json :=
  let url := Crypto.base64UrlEncode bytes
  let standard := (url.replace "-" "+").replace "_" "/"
  let padding := String.ofList (List.replicate ((4 - standard.length % 4) % 4) '=')
  Json.mkObj [("$bytes", .str (standard ++ padding))]

private def recordedBytes (v : Json) : List UInt8 :=
  Crypto.base64Decode (text (field v "$bytes"))

private def isUnsupported (error : Json) : Bool :=
  (error.getObjVal? "$unsupported").isOk

/-- A TypeScript `catch` around `body`. An opt-out from the model is not a throw. -/
private def catching (body : Prog Json) (handler : Prog Json) : Prog Json :=
  Prog.catchFail body fun error => if isUnsupported error then .fail error else handler

private def undefinedResult : Prog Json := pure Twin.undefinedJson

/-- An integer JSON number, which every clock and TTL here is. -/
private def natOf : Json → Option Nat
  | .num n => if n.exponent == 0 && n.mantissa >= 0 then some n.mantissa.toNat else none
  | _ => none

private def lessOrEqual (left right : Json) : Bool :=
  match left, right with
  | .num a, .num b => numLe a b
  | _, _ => false

private def utf8Text (bytes : List UInt8) : Option String :=
  String.fromUTF8? (ByteArray.mk bytes.toArray)

private def withoutKey (value : Json) (key : String) : Json :=
  Json.mkObj ((entries value).filter (·.1 != key))

/-- `value`'s keys in insertion order, from the recorded `$keys` when it has them. -/
private def keyOrder (value : Json) : List String :=
  match value.getObjVal? "$keys" with
  | .ok (.arr keys) => keys.toList.filterMap fun key => key.getStr?.toOption
  | _ => (entries value).map Prod.fst

private def stringify (value : Json) : String := Twin.jsonStringify 16 value

/-- The AES-GCM steps every sealed ticket ends with: tag, iv and ciphertext from the cipher. -/
private def sealedParts (version : String) (iv : Json) (plaintext : String) : Prog String := do
  let body ← Prog.effect "cipher.update" [str plaintext, str "utf-8"]
  let final ← Prog.effect "cipher.final"
  let tag ← Prog.effect "cipher.getAuthTag"
  let encode (bytes : List UInt8) := Crypto.base64UrlEncode bytes
  return ".".intercalate
    [version, encode (recordedBytes iv), encode (recordedBytes tag),
     encode (recordedBytes body ++ recordedBytes final)]

/-- The destructuring tickets open with: a version and exactly three non-empty fields. -/
private def tokenFields (version token : String) : Option (String × String × String) :=
  match token.splitOn "." with
  | [first, iv, tag, ciphertext] =>
    if first == version && iv != "" && tag != "" && ciphertext != "" then
      some (iv, tag, ciphertext)
    else none
  | _ => none

private def openTerminalTicket (call : Json) : Prog Json := do
  let token := text (Twin.callArg call 0)
  let secret := Twin.callArg call 1
  match tokenFields "st1" token with
  | none => return Json.null
  | some (iv, tag, ciphertext) =>
    let ivBytes := Crypto.base64Decode iv
    let tagBytes := Crypto.base64Decode tag
    let cipherBytes := Crypto.base64Decode ciphertext
    if Crypto.base64UrlEncode ivBytes != iv || Crypto.base64UrlEncode tagBytes != tag ||
        Crypto.base64UrlEncode cipherBytes != ciphertext then
      return Json.null
    catching (handler := pure Json.null) do
      let key ← Prog.effect "ticketKey" [secret]
      let _ ← Prog.effect "createDecipheriv"
        [str "aes-256-gcm", key, bytesJson ivBytes,
         Json.mkObj [("authTagLength", toJson (16 : Nat))]]
      let _ ← Prog.effect "decipher.setAuthTag" [bytesJson tagBytes]
      let body ← Prog.effect "decipher.update" [bytesJson cipherBytes]
      let final ← Prog.effect "decipher.final"
      let some plaintext := utf8Text (recordedBytes body ++ recordedBytes final)
        | Prog.unsupported "authenticated plaintext that is not UTF-8"
      let .ok parsed := Json.parse plaintext
        | Prog.throwError "SyntaxError" "JSON Parse error"
      let sealed ← Prog.effect "SEALED_TICKET.safeParse" [parsed]
      let data := field sealed "data"
      if !truth (field sealed "success") || lessOrEqual (field data "expiresAt") (Twin.param call 2) then
        return Json.null
      if truth (field data "authorizationHeader") then
        return data
      return withoutKey data "authorizationHeader"

private def openRunToken (call : Json) : Prog Json := do
  let some body := Js.afterPrefix (text (Twin.callArg call 0)) "brt_"
    | return Json.null
  let (payload, signature) ← match body.splitOn "." with
    | [payload, signature] =>
      if payload == "" || signature == "" then return Json.null else pure (payload, signature)
    | _ => return Json.null
  let expected ← Prog.effect "sign" [str payload]
  let given := Crypto.base64Decode signature
  if given.length != (recordedBytes expected).length then
    return Json.null
  let equal ← Prog.effect "timingSafeEqual" [bytesJson given, expected]
  if !truth equal then
    return Json.null
  let decoded := (utf8Text (Crypto.base64Decode payload)).bind fun text => (Json.parse text).toOption
  let some claims := decoded
    | return Json.null
  if claims == Json.null then
    Prog.unsupported "signed claims of null, where reading exp throws"
  let exp := field claims "exp"
  match exp with
  | .num _ =>
    if lessOrEqual exp (Twin.param call 1) then
      return Json.null
    return Json.mkObj
      (optField "accountId" (prop claims "accountId") ++ optField "agentId" (prop claims "agentId"))
  | _ => return Json.null

private def derivedKey (call : Json) : Prog Json := do
  let info := Twin.callArg call 0
  let secret ← Prog.effect "requireEnv" [str "STAGE_TICKET_SECRET"]
  let cached := (items (field (Twin.moduleValue call "derivedKeys") "$map")).find? fun entry =>
    Twin.arg entry 0 == info
  if let some entry := cached then
    if field (Twin.arg entry 1) "secret" == secret then
      return field (Twin.arg entry 1) "key"
  let key ← Prog.effect "hkdfSync" [str "sha256", secret, str "", info, toJson (32 : Nat)]
  let old := items (field (Twin.moduleValue call "derivedKeys") "$map")
  let pair := toJson [info, Json.mkObj [("secret", secret), ("key", key)]]
  let next := if cached.isSome then old.map (fun entry => if Twin.arg entry 0 == info then pair else entry)
    else old ++ [pair]
  Waveaccess8a.setModule call "derivedKeys" (Json.mkObj [("$map", toJson next)])
  return key

private def sealRunToken (call : Json) : Prog Json := do
  let subject := Twin.param call 0
  let (some now, some ttl) := (natOf (Twin.param call 1), natOf (Twin.param call 2))
    | Prog.unsupported "a clock or TTL that is not an integer"
  let claims := Json.mkObj
    (optField "accountId" (prop subject "accountId") ++ optField "agentId" (prop subject "agentId") ++
      [("exp", toJson (now + ttl)), ("$keys", toJson ["accountId", "agentId", "exp"])])
  let payload := Crypto.base64UrlEncode (Crypto.utf8 (stringify claims))
  let signature ← Prog.effect "sign" [str payload]
  return str s!"brt_{payload}.{Crypto.base64UrlEncode (recordedBytes signature)}"

private def openMediaTicket (call : Json) : Prog Json := do
  let token := Twin.param call 0
  let now := Twin.param call 2
  let rec attempt : List Json → Prog Json
    | [] => pure Json.null
    | secret :: rest => do
      let ticket ← Prog.effect "openWithSecret" [token, secret, now]
      if truth ticket then
        return ticket
      attempt rest
  attempt (items (Twin.param call 1))

private def sealMediaTicket (call : Json) : Prog Json := do
  let ticket := Twin.param call 0
  let secret := Twin.param call 1
  let ttl ← Prog.effect "positiveIntegerEnv" [str "MEDIA_TICKET_TTL_SECONDS", toJson (2592000 : Nat)]
  let (some now, some seconds) := (natOf (Twin.param call 2), natOf ttl)
    | Prog.unsupported "a clock or TTL that is not an integer"
  let iv ← Prog.effect "randomBytes" [toJson (12 : Nat)]
  let key ← Prog.effect "ticketKey" [secret]
  let _ ← Prog.effect "createCipheriv" [str "aes-256-gcm", key, iv]
  let payload := Json.mkObj
    ((entries ticket).filter (·.1 != "$keys") ++
      [("exp", toJson (now / 1000 + seconds)),
       ("$keys", toJson (keyOrder ticket ++ ["exp"]))])
  str <$> sealedParts "ml2" iv (stringify payload)

private def hmacAlgorithm : Json :=
  Json.mkObj [("name", str "HMAC"), ("hash", str "SHA-256")]

private def sealSignedTicket (call : Json) : Prog Json := do
  let prefix_ := text (Twin.callArg call 0)
  let encoded := Crypto.utf8 (stringify (Twin.callArg call 2))
  let payload ← Prog.effect "bytesToBase64Url" [bytesJson encoded]
  let key ← Prog.effect "ticketKey" [Twin.callArg call 1, Twin.callArg call 3]
  let signature ← Prog.effect "crypto.subtle.sign"
    [hmacAlgorithm, key, bytesJson (Crypto.utf8 (text payload))]
  let tail ← Prog.effect "bytesToBase64Url" [signature]
  return str s!"{prefix_}{text payload}.{text tail}"

private def openStageSessionTicket (call : Json) : Prog Json := do
  let decoded ← Prog.effect "openSignedTicket"
    [str "bdts_", str "stage-session-ticket:", Twin.param call 0, Twin.param call 1]
  let ticket ← Prog.effect "parseTicket" [decoded]
  if !truth ticket || lessOrEqual (field ticket "expiresAt") (Twin.param call 2) then
    return Json.null
  return ticket

private def userTokenPrefix : String := "buat_"

private def userTokenContext : String := "broods-user-token:"

private def openUserToken (call : Json) : Prog Json := do
  let secret := Twin.param call 1
  let now := Twin.param call 2
  let decoded ← Prog.effect "openSignedTicket"
    [str userTokenPrefix, str userTokenContext, Twin.param call 0, secret]
  match decoded with
  | .arr _ => Prog.unsupported "a signed array, whose rest spread the model does not cover"
  | .obj _ =>
    let fields := withoutKey decoded "credentialSealed"
    match prop decoded "credentialSealed" with
    | none => Prog.effect "parseUserToken" [withoutKey fields "credential", now]
    | some sealed =>
      let credential ← Prog.effect "openCredential" [sealed, secret]
      if credential == Json.null then
        return Json.null
      Prog.effect "parseUserToken"
        [Json.mkObj ((entries fields) ++ [("credential", credential)]), now]
  | _ => return Json.null

private def invalidUserToken : String :=
  "Invalid user token: userId must match ^[A-Za-z0-9._@+=-]{1,128}$, conversations must be at most 100 non-empty keys, credential must be 1 to 512 printable ASCII characters without spaces, and expiresAt must be in the next 60 minutes."

private def sealUserToken (call : Json) : Prog Json := do
  let token := Twin.param call 0
  let secret := Twin.param call 1
  let now := Twin.param call 2
  if !Js.startsWith (text secret) "bsig_" then
    Prog.throwError "Error"
      "The user token signing secret must start with bsig_. It is not the bsk_ runtime key."
  let checked ← Prog.effect "parseUserToken" [token, now]
  let tooLate := match now, field token "expiresAt" with
    | .num clock, .num expiresAt => !numLe expiresAt (numAdd clock (natNum 3600000))
    | _, _ => false
  if !truth checked || tooLate then
    Prog.throwError "Error" invalidUserToken
  let fields := withoutKey checked "credential"
  let payload ← match prop checked "credential" with
    | none => pure fields
    | some credential => do
      let sealed ← Prog.effect "sealCredential" [credential, secret]
      pure (Json.mkObj (entries fields ++ [("credentialSealed", sealed)]))
  Prog.effect "sealSignedTicket" [str userTokenPrefix, str userTokenContext, payload, secret]

/-- An `http(s)` URL as `new URL` normalises it. Anything needing more of WHATWG is `none`. -/
private structure HttpUrl where
  scheme : String
  hostname : String
  port : String
  rest : String

private def HttpUrl.host (url : HttpUrl) : String :=
  if url.port == "" then url.hostname else s!"{url.hostname}:{url.port}"

private def HttpUrl.hrefAt (url : HttpUrl) (hostname : String) : String :=
  let authority := if url.port == "" then hostname else s!"{hostname}:{url.port}"
  s!"{url.scheme}://{authority}{url.rest}"

private def ambiguousHost (hostname : String) : Bool :=
  let labels := hostname.splitOn "."
  let numeric (label : String) : Bool := label != "" && label.all Char.isDigit
  match labels.getLast? with
  | some last => numeric last && !(labels.length == 4 && labels.all numeric)
  | none => true

private def parseHttpUrl (input : String) : Option HttpUrl := do
  let (scheme, after) ← match input.splitOn "://" with
    | first :: second :: more => some (first.toLower, "://".intercalate (second :: more))
    | _ => none
  if scheme != "http" && scheme != "https" then none
  let isEnd (c : Char) : Bool := c == '/' || c == '?' || c == '#'
  let authority := String.ofList (after.toList.takeWhile (!isEnd ·))
  let tail := String.ofList (after.toList.dropWhile (!isEnd ·))
  if authority.contains '@' || authority == "" || authority.contains '%' then none
  if !isAscii input || input.any (fun c => c == ' ' || c == '\\' || c == '\t' || c == '\n') then none
  if includes tail "/./" || includes tail "/../" || endsWith tail "/." || endsWith tail "/.." then none
  let (hostname, port) ← if authority.startsWith "[" then
      match authority.splitOn "]" with
      | [address, ""] => some (address ++ "]", "")
      | [address, suffix] => (afterPrefix suffix ":").map fun port => (address ++ "]", port)
      | _ => none
    else
      match authority.splitOn ":" with
      | [name] => some (name, "")
      | [name, port] => some (name, port)
      | _ => none
  if !authority.startsWith "[" && ambiguousHost hostname then none
  let defaultPort := (scheme == "http" && port == "80") || (scheme == "https" && port == "443")
  let rest := if tail == "" || tail.startsWith "?" || tail.startsWith "#" then "/" ++ tail else tail
  some { scheme := scheme, hostname := hostname.toLower, port := if defaultPort then "" else port,
         rest := rest }

/-- `new Headers(source)` then `set("host", host)`: lowercased and sorted. -/
private def pinnedHeaders (source : Json) (host : String) : Option Json := do
  let given : List (String × Json) ← match source with
    | .obj _ =>
      if isUndef source then some []
      else match prop source "$headers" with
        | some (.arr pairs) => some (pairs.toList.map fun pair => (text (Twin.arg pair 0), Twin.arg pair 1))
        | some _ => none
        | none => some ((entries source).filter (·.1 != "$keys"))
    | .null => some []
    | _ => none
  let names := given.map fun entry => entry.1.toLower
  if names.eraseDups.length != names.length then none
  let kept := given.filterMap fun entry =>
    if entry.1.toLower == "host" then none else some (entry.1.toLower, entry.2)
  let sorted := ((("host", str host) :: kept).toArray.qsort fun a b => a.1 < b.1).toList
  some (Json.mkObj [("$headers", Json.arr (sorted.map fun entry =>
    Json.arr #[str entry.1, entry.2]).toArray)])

private def anyDenied (addresses : List Json) : Prog Bool := do
  for entry in addresses do
    let denied ← Prog.effect "isDeniedAddress" [field entry "address"]
    if truth denied then
      return true
  return false

/-- The pinned address: the cached one if live, otherwise a fresh checked lookup. -/
private def pinnedAddress (hostname : String) (cached : Option Json) (signal : Json) : Prog (String × Option Json) := do
  let live ← match cached with
    | none => pure none
    | some entry => do
      let now ← Prog.effect "Date.now"
      pure (if lessOrEqual (field entry "expiresAt") now then none else some entry)
  match live with
  | some entry => return (text (field entry "address"), none)
  | none =>
    let addresses := items (← Prog.effect "lookupUntilAborted" [str hostname, signal])
    let some pinned := addresses.head?
      | Prog.throwError "Error" s!"{hostname} did not resolve"
    if ← anyDenied addresses then
      Prog.throwError "Error" s!"{hostname} resolves to a private address"
    let now ← Prog.effect "Date.now"
    let raw := text (field pinned "address")
    let address := if field pinned "family" == toJson (6 : Nat) then s!"[{raw}]" else raw
    let expires := match now with
      | .num n => Json.num (numAdd n (natNum 30000))
      | _ => Json.null
    return (address, some (Json.mkObj [("address", str address), ("expiresAt", expires)]))

private def publicHostFetch (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let init := Twin.callArg call 1
  let href ← match input with
    | .str value => pure value
    | .obj _ =>
      match prop input "$url" with
      | some (.str value) => pure value
      | _ => Prog.unsupported "a Request input"
    | _ => Prog.unsupported "an input that is not a URL"
  let some url := parseHttpUrl href
    | Prog.unsupported "a URL outside the modelled http(s) forms"
  let hostname := url.hostname
  let isPrivate ← Prog.effect "isPrivateHostname" [str hostname]
  if truth isPrivate then
    Prog.throwError "Error" s!"Refusing to reach private address {hostname}"
  let signal := match field init "signal" with
    | .null => Twin.undefinedJson
    | value => value
  let cached := (items (field (Twin.moduleValue call "publicHosts") "$map")).find? fun entry =>
    Twin.arg entry 0 == str hostname
  let (address, validated) ← pinnedAddress hostname (cached.map fun entry => Twin.arg entry 1) signal
  let old := items (field (Twin.moduleValue call "publicHosts") "$map")
  let next := match validated with
    | none => old
    | some value =>
      let old := if old.length >= 1024 then [] else old
      let pair := toJson [str hostname, value]
      if old.any (fun entry => Twin.arg entry 0 == str hostname) then
        old.map (fun entry => if Twin.arg entry 0 == str hostname then pair else entry)
      else old ++ [pair]
  let some headers := pinnedHeaders (field init "headers") url.host
    | Prog.unsupported "headers in a form the model does not cover"
  let overridden := ["headers", "redirect", "tls", "$keys", "$undefined"]
  let passed := (entries init).filter fun entry => !overridden.contains entry.1
  let outcome ← Prog.attempt "fetch"
    [Json.mkObj [("$url", str (url.hrefAt address))],
     Json.mkObj (passed ++
       [("headers", headers), ("redirect", str "error"),
        ("tls", Json.mkObj [("serverName", str hostname)])])]
  match outcome with
  | .ok response =>
    Waveaccess8a.setModule call "publicHosts" (Json.mkObj [("$map", toJson next)])
    return response
  | .threw error _ =>
    let next := next.filter (fun entry => Twin.arg entry 0 != str hostname)
    Waveaccess8a.setModule call "publicHosts" (Json.mkObj [("$map", toJson next)])
    throw error
  | .pending => Prog.unsupported "fetch has not resolved"

/-- Entries are only appended and share one lifetime, so expired ones lead and are dropped. -/
private def fetchTempoTrace (call : Json) : Prog Json := do
  let traceId := Twin.callArg call 1
  let now ← Prog.effect "Date.now"
  let entries := items (field (Twin.moduleValue call "tempoTraces") "$map")
  let live := entries.dropWhile fun entry => lessOrEqual (field (Twin.arg entry 1) "expiresAtMs") now
  if let some cached := live.find? (fun entry => Twin.arg entry 0 == traceId) then
    let rows := Twin.field (field (Twin.arg cached 1) "rows") "$resolved"
    if isUndef rows then return ← Prog.unsupported "cached promise has not resolved"
    Waveaccess8a.setModule call "tempoTraces" (Json.mkObj [("$map", toJson live)])
    return rows
  Prog.unsupported "cache-miss completion snapshots include unrecorded concurrent cache writes"

private def sendAgentTest (call : Json) : Prog Json := do
  let _ ← Prog.effect "socket.send" [str (stringify (Twin.callArg call 1))]
  undefinedResult

/-- A plain `Error` as the recorder writes it, class name included. -/
private def classedError (message : String) : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("$class", str "Error"), ("name", str "Error"), ("message", str message),
     ("fields", Json.mkObj [])])]

private def backfillFailure (socket : Json) (error : Json) : Prog Json := do
  let message ← Prog.effect "errorMessage" [error]
  let _ ← Prog.effect "sendObs"
    [socket, Json.mkObj [("type", str "backfill"), ("stream", str "traces"),
      ("entries", Json.arr #[]), ("error", message)]]
  undefinedResult

private def inScope (scope : Json) (rows : List Json) : Prog (List Json) := do
  let mut kept : List Json := []
  for row in rows do
    if truth (← Prog.effect "rowInScope" [row, scope]) then
      kept := kept ++ [row]
  return kept

private def sendTrace (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let body : Prog Json := do
    let tempoUrl := match Twin.env call "TEMPO_URL" with
      | .str value => trim value
      | _ => ""
    if tempoUrl == "" then
      throw (classedError "Trace history is not configured (TEMPO_URL)")
    let rows ← Prog.effect "fetchTempoTrace" [str tempoUrl, Twin.callArg call 2]
    let kept ← inScope (Twin.callArg call 1) (items rows)
    if kept.isEmpty then
      throw (classedError "Trace not found in this stage. Traces are kept 30 days")
    let _ ← Prog.effect "sendObs"
      [socket, Json.mkObj [("type", str "backfill"), ("stream", str "traces"),
        ("entries", Json.arr kept.toArray)]]
    undefinedResult
  Prog.catchFail body fun error =>
    if isUnsupported error then .fail error else backfillFailure socket error

private def pendingPromise : Json := Json.mkObj [("$opaque", str "Promise")]

/-- Schedules a last-used stamp when `claimLastUsedWrite` grants one. -/
private def stampIfClaimed (call : Json) (hash now : Json) (touch : String) (touchArg : Json) :
    Prog Unit := do
  let claimed ← Prog.effect "claimLastUsedWrite"
    [Twin.moduleValue call "keyLastUsedWrites", hash, now]
  if truth claimed then
    let old := items (field (Twin.moduleValue call "keyLastUsedWrites") "$map")
    let live := old.filter fun entry =>
      match now, Twin.arg entry 1 with
      | .num current, .num stamp => current.toFloat - stamp.toFloat < 300000
      | _, _ => true
    let pair := toJson [hash, now]
    let next := if live.any (fun entry => Twin.arg entry 0 == hash) then
      live.map (fun entry => if Twin.arg entry 0 == hash then pair else entry)
      else live ++ [pair]
    Waveaccess8a.setModule call "keyLastUsedWrites" (Json.mkObj [("$map", toJson next)])
    let _ ← Prog.effect "getStorage"
    Prog.spawn touch [touchArg, now]
    let _ ← Prog.effect "waitUntil" [pendingPromise]

private def resolveScopedKeyAuth (call : Json) : Prog Json := do
  let hash := Twin.callArg call 0
  let _ ← Prog.effect "getStorage"
  let key ← Prog.effect "getStorage().accountApiKeys.resolveByKeyHash" [hash]
  if !truth key then
    return Json.null
  let now ← Prog.effect "Date.now"
  if truth (field key "stampDue") then
    stampIfClaimed call hash now "getStorage().accountApiKeys.touchLastUsed" (field key "keyId")
  return Json.mkObj
    [("kind", str "role"), ("account", field key "account"), ("role", field key "principal")]

/-- The user token a runtime key carries: `none` refuses the whole credential. -/
private def openHeaderToken (deployment header : Json) : Prog (Option Json) := do
  let sealed := field deployment "userTokenSecret"
  let secret ← if truth sealed then do
      let blob ← Prog.effect "decryptAccountBlob"
        [field deployment "accountId", str "agentDeployments:userTokenSecretCiphertext", sealed]
      pure (field blob "value")
    else pure Twin.undefinedJson
  match secret with
  | .str _ =>
    let opened ← Prog.effect "openUserToken" [str (trim (text header)), secret]
    return if truth opened then some opened else none
  | _ => return none

private def resolveRuntimeKeyAuth (call : Json) : Prog Json := do
  let header := Twin.callArg call 1
  let hash ← Prog.effect "sha256Hex" [Twin.callArg call 0]
  let _ ← Prog.effect "getStorage"
  let deployment ← Prog.effect "getStorage().agentDeployments.getByApiKeyHash" [hash]
  if !truth deployment || field (field deployment "account") "status" != str "active" then
    return Json.null
  let user ← if isUndef header then pure none else do
    match ← openHeaderToken deployment header with
    | none => return Json.null
    | some opened => pure (some opened)
  let now ← Prog.effect "Date.now"
  stampIfClaimed call hash now "getStorage().agentDeployments.touchLastUsed" hash
  return Json.mkObj
    ([("kind", str "deployment"), ("account", field deployment "account"),
      ("endpointId", field deployment "endpointId"), ("projectSlug", field deployment "projectSlug"),
      ("stageSlug", field deployment "stageSlug")] ++
     (match user with
      | some value => [("user", value)]
      | none => []))

private def envOr (call : Json) (name fallback : String) : String :=
  match Twin.env call name with
  | .str value => value
  | _ => fallback

private def gatewayConfigFromEnv (call : Json) : Prog Json := do
  let origins ← Prog.effect "allowedOriginPatternsFromEnv"
  let parsed := numberOfString (envOr call "GATEWAY_AUTH_FAILURES_PER_MINUTE" "")
  let perMinute := if parsed.isNaN || parsed == 0.0 then toJson (20 : Nat) else floatJson parsed
  let limiter ← Prog.effect "new RateLimiter" [perMinute, toJson (60000 : Nat)]
  let core ← Prog.effect "normalizeBaseUrl" [str (envOr call "BROODS_CORE_URL" "")]
  let limits ← Prog.effect "gatewayLimitsFromEnv"
  let spent ← Prog.effect "natsSpentTickets" [Json.mkObj [("$fn", str "getNatsConnection")]]
  let secrets ← Prog.effect "requireSecretsEnv" [str "TERMINAL_TICKET_SECRET"]
  return Json.mkObj
    [("allowedOrigins", origins), ("authFailureLimiter", limiter), ("coreBaseUrl", core),
     ("limits", limits), ("spentTickets", spent), ("terminalTicketSecrets", secrets)]

private def randomRoleToken (args : List Json) (_call : Json) : Prog Json :=
  Prog.effect "randomToken" args

private def zodSchema (name : String) : Json := Json.mkObj [("$opaque", str name)]

private def parseRoleInput (call : Json) : Prog Json :=
  Prog.effect "parseInput" [zodSchema "ZodMiniObject", Twin.callArg call 0, str ""]

private def apiPolicyActions : Json :=
  toJson
    ["account:read", "account:write", "agents:read", "agents:write", "audit:read", "audit:write",
     "channels:read", "channels:write", "crons:read", "crons:write", "env:read", "env:write",
     "hooks:read", "hooks:write", "mcp:read", "mcp:write", "policies:read", "policies:write",
     "sandboxes:read", "sandboxes:write", "skills:read", "skills:write", "workspaces:read",
     "workspaces:write"]

private def normalizeAssumeRoleInput (call : Json) : Prog Json := do
  let input ← parseRoleInput call
  let ttl := match field input "ttlSeconds" with
    | .null => toJson (3600 : Nat)
    | value => if isUndef value then toJson (3600 : Nat) else value
  return Json.mkObj [("roleId", str (trim (text (field input "roleId")))), ("ttlSeconds", ttl)]

/-- `value?.trim() || undefined`, as an object entry only when something is left. -/
private def trimmedEntry (input : Json) (key : String) : List (String × Json) :=
  let trimmed := trim (text (field input key))
  if trimmed == "" then [] else [(key, str trimmed)]

private def normalizeCreateRoleInput (call : Json) : Prog Json := do
  let input ← parseRoleInput call
  let policy ← Prog.effect "normalizePolicyDocument" [field input "policy", apiPolicyActions]
  return Json.mkObj
    ([("name", str (trim (text (field input "name")))), ("policy", policy)] ++
      trimmedEntry input "projectId" ++ trimmedEntry input "stageId")

private def normalizeUpdateRoleInput (call : Json) : Prog Json := do
  let input ← parseRoleInput call
  let policy ← if isUndef (field input "policy") then pure [] else do
    let normalized ← Prog.effect "normalizePolicyDocument" [field input "policy", apiPolicyActions]
    pure [("policy", normalized)]
  let name := if isUndef (field input "name") then []
    else [("name", str (trim (text (field input "name"))))]
  let status := if isUndef (field input "status") then [] else [("status", field input "status")]
  let patch := name ++ policy ++ status
  if patch.isEmpty then
    let error ← Prog.effect "new ClientError" [str "Request body must include name, policy, or status"]
    .fail error
  return Json.mkObj patch

private def serviceEnv (call : Json) : Prog Json := do
  let url := envOr call "BROODS_ACCOUNT_MANAGE_URL" ""
  let secret := envOr call "SERVICE_AUTH_SECRET" ""
  if url == "" || secret == "" then
    Prog.throwError "Error" "BROODS_ACCOUNT_MANAGE_URL or SERVICE_AUTH_SECRET missing"
  return Json.mkObj [("url", str (stripTrailingSlashes url)), ("secret", str secret)]

private def serviceHeaders (call : Json) : Prog Json :=
  pure (Json.mkObj
    [("Authorization", str s!"Bearer {text (Twin.callArg call 1)}"),
     ("X-Account-Id", Twin.callArg call 0),
     ("Content-Type", str "application/json")])

private def keyHint (call : Json) : Prog Json :=
  let token := (text (Twin.callArg call 1)).toList
  pure (str s!"{text (Twin.callArg call 0)}…{String.ofList (token.drop (token.length - 4))}")

private def attachmentStorePrefix (call : Json) : Prog Json :=
  pure (str s!"attachments/{encodeURIComponent (text (Twin.callArg call 0))}/")

private def spentTicketKey (call : Json) : Prog Json := do
  let _ ← Prog.effect "createHash" [str "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\").update" [Twin.callArg call 0]
  Prog.effect "createHash(\"sha256\").update(token).digest" [str "hex"]

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/shared/terminal-ticket.ts#openTerminalTicket" openTerminalTicket,
   Twin.traced "apps/core/src/shared/run-token.ts#openRunToken" openRunToken,
   Twin.traced "apps/core/src/shared/run-token.ts#derivedKey" derivedKey,
   Twin.traced "apps/core/src/shared/run-token.ts#sealRunToken" sealRunToken,
   Twin.traced "apps/core/src/shared/media-ticket.ts#openMediaTicket" openMediaTicket,
   Twin.traced "apps/core/src/shared/media-ticket.ts#sealMediaTicket" sealMediaTicket,
   Twin.traced "packages/convex/model/stageSessionTicket.ts#sealSignedTicket" sealSignedTicket,
   Twin.traced "packages/convex/model/stageSessionTicket.ts#openStageSessionTicket" openStageSessionTicket,
   Twin.traced "packages/convex/model/userToken.ts#openUserToken" openUserToken,
   Twin.traced "packages/convex/model/userToken.ts#sealUserToken" sealUserToken,
   Twin.traced "apps/core/src/shared/http.ts#publicHostFetch" publicHostFetch,
   Twin.traced "apps/gateway/src/observability.ts#fetchTempoTrace" fetchTempoTrace,
   Twin.traced "apps/gateway/src/observability.ts#sendTrace" sendTrace,
   Twin.traced "apps/gateway/src/agent.ts#sendAgentTest" sendAgentTest,
   Twin.traced "apps/core/src/shared/auth.ts#resolveScopedKeyAuth" resolveScopedKeyAuth,
   Twin.traced "apps/core/src/shared/auth.ts#resolveRuntimeKeyAuth" resolveRuntimeKeyAuth,
   Twin.traced "apps/gateway/src/main.ts#gatewayConfigFromEnv" gatewayConfigFromEnv,
   Twin.traced "packages/convex/model/roleRules.ts#createRoleId"
     (randomRoleToken [str "brole_", toJson (16 : Nat)]),
   Twin.traced "packages/convex/model/roleRules.ts#createRoleSessionToken"
     (randomRoleToken [str "bsts_"]),
   Twin.traced "packages/convex/model/roleRules.ts#normalizeAssumeRoleInput" normalizeAssumeRoleInput,
   Twin.traced "packages/convex/model/roleRules.ts#normalizeCreateRoleInput" normalizeCreateRoleInput,
   Twin.traced "packages/convex/model/roleRules.ts#normalizeUpdateRoleInput" normalizeUpdateRoleInput,
   Twin.traced "packages/convex/model/serviceBridge.ts#serviceEnv" serviceEnv,
   Twin.traced "packages/convex/model/serviceBridge.ts#serviceHeaders" serviceHeaders,
   Twin.traced "packages/convex/model/accountSecrets.ts#keyHint" keyHint,
   Twin.traced "apps/core/src/shared/media-ticket.ts#attachmentStorePrefix" attachmentStorePrefix,
   Twin.traced "apps/gateway/src/terminal.ts#spentTicketKey" spentTicketKey]

end Spec.Access.Waveaccess3a
