import Spec.Twin
import Spec.Config.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign3/hosted3a.tsv`.
-/

namespace Spec.Hosted.Wavehosted3a

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def nil (value : Json) : Bool := value == .null || undef value
private def truthy (value : Json) : Bool := !undef value && Js.truthy value
private def fn (name : String) : Json := Json.mkObj [("$fn", toJson name)]
private def text (value : Json) : String := (Js.str? value).getD ""

/-- `String.length`: UTF-16 code units. -/
private def jsLength (s : String) : Nat :=
  s.foldl (fun n c => n + (if c.val > 0xFFFF then 2 else 1)) 0

private def contains (s sub : String) : Bool := (s.splitOn sub).length > 1

private def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'
private def isLower (c : Char) : Bool := 'a' ≤ c && c ≤ 'z'
private def isUpper (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'
private def isAlnum (c : Char) : Bool := isDigit c || isLower c || isUpper c
private def isHex (c : Char) : Bool :=
  isDigit c || ('a' ≤ c && c ≤ 'f') || ('A' ≤ c && c ≤ 'F')

/-- `/<[^>]*>/.test`: some `<` has a `>` after it, and the first `<` sees the most. -/
private def hasXmlTag (s : String) : Bool :=
  match s.toList.dropWhile (· != '<') with
  | [] => false
  | _ :: rest => rest.contains '>'

private def failClient {α : Type} (message : String) : Prog α := do
  let error ← Prog.effect "new ClientError" [toJson message]
  .fail error

private def refuseIf (bad : Bool) (message : String) : Prog Unit :=
  if bad then failClient message else pure ()

/-! ### `new URL`, for the parts these functions read -/

private structure ParsedUrl where
  protocol : String
  hostname : String
  pathname : String
  credentials : Bool

private inductive UrlParse where
  | invalid
  | outside
  | ok (url : ParsedUrl)

private def lower (chars : List Char) : String := String.ofList (chars.map Char.toLower)

/-- The WHATWG parser for plain absolute URLs. `outside` is anything it would rewrite. -/
private def parseUrl (s : String) : UrlParse :=
  let chars := s.toList
  if !chars.all (fun c => '!' ≤ c && c ≤ '~' && c != '\\') then .outside else
  let scheme := chars.takeWhile (· != ':')
  if scheme.length == chars.length then .invalid else
  let validScheme := match scheme with
    | first :: rest =>
      (isLower first || isUpper first) &&
        rest.all (fun c => isAlnum c || c == '+' || c == '-' || c == '.')
    | [] => false
  if !validScheme then .invalid else
  match chars.drop (scheme.length + 1) with
  | '/' :: '/' :: afterSlashes =>
    let authority := afterSlashes.takeWhile (fun c => c != '/' && c != '?' && c != '#')
    let after := afterSlashes.drop authority.length
    let path := after.takeWhile (fun c => c != '?' && c != '#')
    let hostPort := (authority.reverse.takeWhile (· != '@')).reverse
    let userinfo := authority.take (authority.length - hostPort.length - 1)
    let host := hostPort.takeWhile (· != ':')
    let segments := (String.ofList path).splitOn "/"
    if host.isEmpty || host.head? == some '[' || host.contains '%' || segments.contains "." then
      .outside
    else
      .ok { protocol := lower scheme ++ ":"
            hostname := lower host
            pathname := if path.isEmpty then "/" else String.ofList path
            credentials := !(userinfo.erase ':').isEmpty }
  | _ => .outside

/-- `encodeURIComponent`. -/
private def encodeUriComponent (s : String) : String :=
  let hexDigit (n : Nat) : Char := "0123456789ABCDEF".toList.getD n '0'
  let unreserved (c : Char) : Bool := isAlnum c || "-_.!~*'()".toList.contains c
  String.join (s.toList.map fun c =>
    if unreserved c then c.toString else
      String.join ((c.toString.toUTF8.toList).map fun byte =>
        String.ofList ['%', hexDigit (byte.toNat / 16), hexDigit (byte.toNat % 16)]))

private def base64UrlAlphabet : List Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toList

/-- `Buffer.toString("base64url")`: no padding. -/
private def base64Url (bytes : List Nat) : String :=
  let digit (n : Nat) : Char := base64UrlAlphabet.getD (n % 64) 'A'
  let rec go (fuel : Nat) (rest : List Nat) (out : List Char) : List Char :=
    match fuel, rest with
    | 0, _ => out.reverse
    | _, [] => out.reverse
    | _ + 1, [a] => (digit (a / 4) :: digit (a * 16) :: []).reverse.append out |>.reverse
    | _ + 1, [a, b] =>
      (digit (a / 4) :: digit (a * 16 + b / 16) :: digit (b * 4) :: []).reverse.append out |>.reverse
    | fuel + 1, a :: b :: c :: more =>
      go fuel more
        (digit c :: digit (b * 4 + c / 64) :: digit (a * 16 + b / 16) :: digit (a / 4) :: out)
  String.ofList (go (bytes.length + 1) bytes [])

/-! ### `skillRules.ts` -/

private def skillNameMessage : String :=
  "Skill name must be lowercase letters, numbers, and hyphens only, max 64 chars, without reserved words"

private def validateSkillName (call : Json) : Prog Json := do
  let good := match Twin.callArg call 0 with
    | .str s =>
      !s.isEmpty && jsLength s <= 64 &&
        s.all (fun c => isLower c || isDigit c || c == '-') &&
        !contains s "anthropic" && !contains s "claude" && !hasXmlTag s
    | _ => false
  refuseIf (!good) skillNameMessage
  return Twin.undefinedJson

private def validateSkillDescription (call : Json) : Prog Json := do
  let good := match Twin.callArg call 0 with
    | .str s => !(Js.trim s).isEmpty && jsLength s <= 1024 && !hasXmlTag s
    | _ => false
  refuseIf (!good) "Skill description must be non-empty, max 1024 chars, and cannot contain XML tags"
  return Twin.undefinedJson

private def normalizeBundlePath (call : Json) : Prog Json := do
  match Twin.callArg call 0 with
  | .str value =>
    let trimmed := Js.trim value
    refuseIf
      (trimmed.isEmpty || trimmed.startsWith "/" || contains trimmed "\\" ||
        contains trimmed "\x00" ||
        (trimmed.splitOn "/").any (fun part => part == ".." || part == ""))
      s!"Invalid skill file path: {value}"
    return toJson trimmed
  | _ => failClient "Skill file path must be a string"

private def contentTypeForSkillPath (call : Json) : Prog Json :=
  let path := lower (text (Twin.callArg call 0)).toList
  pure (toJson (if path.endsWith ".json" then "application/json" else "text/plain; charset=utf-8"))

private def stripYamlScalarQuotes (call : Json) : Prog Json :=
  let trimmed := Js.trim (text (Twin.callArg call 0))
  let quoted (q : String) : Bool := trimmed.startsWith q && trimmed.endsWith q
  pure (toJson (if quoted "\"" || quoted "'" then
    String.ofList (trimmed.toList.drop 1).dropLast else trimmed))

private def assertSafeGitHubSegment (call : Json) : Prog Json := do
  let good := (text (Twin.callArg call 0)) |>.toList |> fun chars =>
    !chars.isEmpty && chars.all (fun c => isAlnum c || c == '_' || c == '.' || c == '-')
  refuseIf (!good) s!"GitHub {text (Twin.callArg call 1)} contains unsupported characters"
  return Twin.undefinedJson

/-- `split(/\r?\n/)`: only a `\r` right before a newline goes with it. -/
private def splitLines (s : String) : List String :=
  let rec strip : List String → List String
    | [] => []
    | [last] => [last]
    | line :: rest =>
      (if line.endsWith "\r" then String.ofList line.toList.dropLast else line) :: strip rest
  strip (s.splitOn "\n")

/-- `/^([A-Za-z0-9_-]+):\s*(.*)$/`. `.` stops at a line terminator, so one in the value is no match. -/
private def yamlLine (line : String) : Option (String × String) :=
  let chars := line.toList
  let key := chars.takeWhile (fun c => isAlnum c || c == '_' || c == '-')
  match chars.drop key.length with
  | ':' :: rest =>
    let value := rest.dropWhile Js.isSpace
    let terminator (c : Char) : Bool :=
      c == '\n' || c == '\r' || c == ' ' || c == ' '
    if key.isEmpty || value.any terminator then none
    else some (String.ofList key, String.ofList value)
  | _ => none

private def parseSimpleYamlFrontmatter (call : Json) : Prog Json := do
  let mut result := Js.empty
  for line in splitLines (text (Twin.callArg call 0)) do
    if let some (key, value) := yamlLine line then
      let stripped ← Prog.effect "stripYamlScalarQuotes" [toJson value]
      result := Js.set result key (toJson (Js.trim (text stripped)))
  return result

private def eatNewline : List Char → Option (List Char)
  | '\r' :: '\n' :: rest => some rest
  | '\n' :: rest => some rest
  | _ => none

private def closesFrontmatter (rest : List Char) : Bool :=
  match eatNewline rest with
  | some ('-' :: '-' :: '-' :: tail) => tail.isEmpty || (eatNewline tail).isSome
  | _ => false

private def scanFrontmatter (taken : List Char) : List Char → Option (List Char)
  | [] => none
  | c :: rest =>
    if closesFrontmatter (c :: rest) then some taken.reverse
    else scanFrontmatter (c :: taken) rest

/-- Group 1 of `/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/`. -/
private def frontmatterOf (markdown : String) : Option String :=
  match markdown.toList with
  | '-' :: '-' :: '-' :: rest =>
    (eatNewline rest).bind (scanFrontmatter []) |>.map String.ofList
  | _ => none

private def parseSkillMarkdown (call : Json) : Prog Json := do
  match frontmatterOf (text (Twin.callArg call 0)) with
  | some body =>
    if body.isEmpty then failClient "SKILL.md must start with YAML frontmatter" else
    let frontmatter ← Prog.effect "parseSimpleYamlFrontmatter" [toJson body]
    let name := field frontmatter "name"
    let description := field frontmatter "description"
    let _ ← Prog.effect "validateSkillName" [name]
    let _ ← Prog.effect "validateSkillDescription" [description]
    return Json.mkObj [("name", name), ("description", description)]
  | none => failClient "SKILL.md must start with YAML frontmatter"

private def parseGitHubSkillUrl (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let trimmed := match value with
    | .str s => Js.trim s
    | _ => ""
  refuseIf trimmed.isEmpty "url must be a non-empty string"
  match parseUrl trimmed with
  | .invalid => Prog.unsupported "new URL throws a platform TypeError"
  | .outside => Prog.unsupported "a URL the parser would rewrite"
  | .ok url =>
    refuseIf (url.protocol != "https:" || url.hostname != "github.com")
      "GitHub skill URL must use https://github.com"
    refuseIf (contains (lower trimmed.toList) "%2e" || contains trimmed "..")
      "Invalid skill file path: GitHub URL must not contain path traversal"
    match url.pathname.splitOn "/" |>.filter (!·.isEmpty) with
    | owner :: repo :: "tree" :: ref :: subdirParts =>
      let _ ← Prog.effect "assertSafeGitHubSegment" [toJson owner, toJson "owner"]
      let _ ← Prog.effect "assertSafeGitHubSegment" [toJson repo, toJson "repo"]
      let _ ← Prog.effect "assertSafeGitHubSegment" [toJson ref, toJson "ref"]
      let mut parts : List String := []
      for part in subdirParts do
        let normalized ← Prog.effect "normalizeBundlePath" [toJson part]
        parts := parts ++ [text normalized]
      return Json.mkObj
        [("owner", toJson owner), ("repo", toJson repo), ("ref", toJson ref),
         ("subdir", toJson ("/".intercalate parts)),
         ("archiveUrl", toJson
           s!"https://codeload.github.com/{owner}/{repo}/tar.gz/{encodeUriComponent ref}")]
    | _ =>
      failClient "GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}"

/-! ### `objects.ts` -/

/-- An object's keys in insertion order, leaving out what the recorder added. -/
private def orderedKeys (value : Json) : List String :=
  match value.getObjVal? "$keys" with
  | .ok (.arr keys) => keys.toList.filterMap (fun key => (Json.getStr? key).toOption)
  | _ => (Js.entries value).map (·.1) |>.filter (fun key => key != "$keys" && key != "$fields")

private def remapKeys (call : Json) : Prog Json :=
  let record := Twin.callArg call 0
  let keyMap := Twin.callArg call 1
  pure ((orderedKeys record).foldl
    (fun out key =>
      let mapped := field keyMap key
      Js.set out (if nil mapped then key else text mapped) (field record key))
    Js.empty)

/-! ### `mcp.ts` -/

private def toolNamePattern : String := "/^[A-Za-z0-9_.-]{1,128}$/"

private def assertMcpRow (call : Json) : Prog Json := do
  let row := Twin.callArg call 0
  let transport := field row "transport"
  let transportText := text transport
  let isMachine := transportText == "machine"
  refuseIf (isMachine && !truthy (field row "sandbox"))
    "a machine MCP server needs the sandbox that serves it"
  refuseIf (!isMachine && !undef (field row "command"))
    "command applies to a server on a sandbox"
  refuseIf (isMachine && !undef (field row "headers"))
    "headers do not apply to a machine server"
  refuseIf (!undef (field row "runtime") && transportText != "hosted")
    s!"runtime applies to hosted (bundle) servers, not {transportText}"
  if undef (field row "oauth") then return Twin.undefinedJson
  refuseIf (transportText != "http")
    s!"oauth applies to external (url) servers, not {transportText}"
  let url := field row "url"
  if !undef url then
    match parseUrl (text url) with
    | .ok parsed =>
      refuseIf (parsed.protocol != "https:")
        "oauth needs an https url; the minted token rides every request"
    | _ => let _ : Unit ← Prog.unsupported "a URL the model does not parse"
  let authorization ← Prog.effect "authorizationHeaderName" [field row "headers"]
  refuseIf (!undef authorization)
    s!"oauth mints the Authorization header itself; drop the explicit {text authorization} header"
  return Twin.undefinedJson

private def mcpBundleStorageKey (call : Json) : Prog Json :=
  pure (toJson
    s!"account-mcp/{encodeUriComponent (text (Twin.callArg call 0))}/bundles/{text (Twin.callArg call 1)}.mjs")

private def normalizeAllowedTools (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  match value with
  | .arr items =>
    refuseIf (items.any (!Js.isStr ·)) "allowedTools must be an array of tool names"
    refuseIf (items.size > 256) "allowedTools must list at most 256 tools"
    for item in items.toList do
      let name := text item
      let good := !name.isEmpty && jsLength name <= 128 &&
        name.all (fun c => isAlnum c || c == '_' || c == '.' || c == '-')
      refuseIf (!good) s!"allowedTools entries must match {toolNamePattern}: {name}"
    return value
  | _ => failClient "allowedTools must be an array of tool names"

private def normalizeBundle (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  match value with
  | .str s =>
    refuseIf s.isEmpty "bundle must be a non-empty string of module source"
    refuseIf (s.utf8ByteSize > 10000000)
      "inline bundle must be at most 10000000 bytes; upload larger bundles (up to 50000000) to an upload URL and pass bundleStorageId"
    return value
  | _ => failClient "bundle must be a non-empty string of module source"

private def normalizeCommand (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let good := match value with
    | .arr items =>
      !items.isEmpty && items.size <= 32 && items.all fun item =>
        match item with
        | .str arg => !arg.isEmpty && jsLength arg <= 4096
        | _ => false
    | _ => false
  refuseIf (!good)
    "command must be 1-32 non-empty strings of at most 4096 characters, like [\"obscura\", \"mcp\"]"
  return value

private def normalizeDescription (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let good := match value with
    | .str s => jsLength s <= 2000
    | _ => false
  refuseIf (!good) "description must be a string of at most 2000 characters"
  return value

private def normalizeName (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let good := match value with
    | .str s =>
      match s.toList with
      | first :: rest =>
        isLower first && rest.length <= 31 && rest.all (fun c => isLower c || isDigit c || c == '-')
      | [] => false
    | _ => false
  refuseIf (!good) "name must be 1-32 lowercase letters, digits or hyphens, starting with a letter"
  return value

private def normalizeRuntime (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  refuseIf (value != toJson "auto" && value != toJson "lambda")
    "runtime must be \"auto\" or \"lambda\""
  return value

private def normalizeUrl (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  match value with
  | .str s =>
    refuseIf (jsLength s > 2048) "url must be a string of at most 2048 characters"
    match parseUrl s with
    | .invalid => failClient s!"url must be a valid absolute URL: {s}"
    | .outside => Prog.unsupported "a URL the model does not parse"
    | .ok url =>
      refuseIf (url.protocol != "https:" && url.protocol != "http:") "url must use http or https"
      refuseIf url.credentials
        "url must not embed credentials; put them in headers as ${NAME} refs"
      return value
  | _ => failClient "url must be a string of at most 2048 characters"

private def isSha256Hex (s : String) : Bool :=
  s.length == 64 && s.all (fun c => isDigit c || ('a' ≤ c && c ≤ 'f'))

private def normalizeConnection (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let input := Twin.callArg call 1
  let write (name : String) (value : Json) : Prog Unit :=
    Prog.setChanged s!"args.1.{name}" (field input name) value
  let url ← if undef (field record "url") then pure (field input "url")
    else Prog.effect "normalizeUrl" [field record "url"]
  write "url" url
  let bundle ← if undef (field record "bundle") then pure (field input "bundle")
    else Prog.effect "normalizeBundle" [field record "bundle"]
  write "bundle" bundle
  let storageId := field record "bundleStorageId"
  if !undef storageId then
    let good := match storageId with
      | .str s => !s.isEmpty
      | _ => false
    refuseIf (!good) "bundleStorageId must be a non-empty storage id"
    let sha := match field record "sha256" with
      | .str s => isSha256Hex s
      | _ => false
    refuseIf (!sha) "bundleStorageId needs sha256, the hex digest of the uploaded bytes"
    write "bundleStorageId" storageId
    write "sha256" (field record "sha256")
  let sandbox := field record "sandbox"
  if !undef sandbox then
    let good := match sandbox with
      | .str s => !s.isEmpty
      | _ => false
    refuseIf (!good) "sandbox must be the name of the sandbox that serves it"
    write "sandbox" sandbox
  if !undef (field record "runtime") then
    write "runtime" (← Prog.effect "normalizeRuntime" [field record "runtime"])
  let finalStorage := if undef storageId then field input "bundleStorageId" else storageId
  let finalSandbox := if undef sandbox then field input "sandbox" else sandbox
  let connections := [url, bundle, finalStorage, finalSandbox].filter (!undef ·)
  refuseIf (connections.length > 1)
    "url, bundle, bundleStorageId and sandbox are mutually exclusive"
  if !undef finalSandbox then write "transport" (toJson "machine")
  else if !undef bundle || !undef finalStorage then write "transport" (toJson "hosted")
  else if !undef url then write "transport" (toJson "http")
  -- The array stored here was handed to `normalizeCommand`, so the recording leaves it to that effect.
  if !nil (field record "command") then
    let _ ← Prog.effect "normalizeCommand" [field record "command"]
  return Twin.undefinedJson

/-- `/^(?:\$\{[A-Z][A-Z0-9_]*\})+$/`. -/
private def isEnvRefsOnly (s : String) : Bool :=
  let rec go (fuel : Nat) (rest : List Char) : Bool :=
    match fuel, rest with
    | fuel + 1, '$' :: '{' :: first :: tail =>
      let name := tail.takeWhile (fun c => isUpper c || isDigit c || c == '_')
      match tail.drop name.length with
      | '}' :: more => isUpper first && (more.isEmpty || go fuel more)
      | _ => false
    | _, _ => false
  go (s.length + 1) s.toList

private def oauthField (oauth : Json) (name : String) (secret : Bool) : Prog Json := do
  let value := field oauth name
  let good := match value with
    | .str s => !s.isEmpty && jsLength s <= 2048 && !s.contains '\r' && !s.contains '\n'
    | _ => false
  refuseIf (!good) s!"oauth.{name} must be a single-line string of at most 2048 characters"
  refuseIf (secret && !isEnvRefsOnly (text value))
    s!"oauth.{name} must reference an account env var like $\{NAME}, not an inline secret"
  return value

private def normalizeOauth (call : Json) : Prog Json := do
  let value := field (Twin.callArg call 0) "oauth"
  if nil value then return Twin.undefinedJson
  refuseIf (!Js.isObj value)
    "oauth must be an object with clientId, clientSecret and refreshToken"
  let tokenUrl := field value "tokenUrl"
  let normalizedUrl ← if nil tokenUrl then pure Twin.undefinedJson
    else Prog.effect "normalizeUrl" [tokenUrl]
  if !nil tokenUrl then
    match parseUrl (text normalizedUrl) with
    | .ok url => refuseIf (url.protocol != "https:") "oauth.tokenUrl must use https"
    | _ => let _ : Unit ← Prog.unsupported "a URL the model does not parse"
  let clientId ← oauthField value "clientId" false
  let clientSecret ← oauthField value "clientSecret" true
  let refreshToken ← oauthField value "refreshToken" true
  Prog.setState "args.1.oauth" (Json.mkObj
    ([("clientId", clientId), ("clientSecret", clientSecret), ("refreshToken", refreshToken)] ++
      (if nil tokenUrl then [] else [("tokenUrl", normalizedUrl)])))
  return Twin.undefinedJson

/-! ### Recorded helpers -/

private def otlpAttributes (call : Json) : Prog Json :=
  let record := Twin.callArg call 0
  pure (.arr ((orderedKeys record).map fun key =>
    Json.mkObj [("key", toJson key),
      ("value", Json.mkObj [("stringValue", field record key)])]).toArray)

private def principalHeaders (call : Json) : Prog Json := do
  let principal := Twin.callArg call 0
  let chain ← Prog.effect "delegatedChain" [principal]
  let agent : List (String × Json) := [("X-Broods-Agent-Id", field principal "agentId")]
  if !truthy chain then return Json.mkObj agent
  let stripped ← Prog.effect "chainWithoutNames" [chain]
  let encoded := base64Url ((Twin.jsonStringify 64 stripped).toUTF8.toList.map (·.toNat))
  return Json.mkObj (agent ++ [("X-Broods-Principal", toJson encoded)])

private def hostedMcpFetch (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let _ ← Prog.effect "hostedMcpTenantId"
    [field (field connection "record") "accountId", field connection "agentId"]
  return fn ""

private def mapLookup (map : Json) (key : String) : Option Json :=
  match field map "$map" with
  | .arr entries =>
    (entries.toList.find? (fun entry => Twin.arg entry 0 == toJson key)).map (Twin.arg · 1)
  | _ => none

private def workersUrl (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let key ← Prog.effect "bundleKey" [record]
  if let some until_ := mapLookup (Twin.moduleValue call "unloadableOnWorker") (text key) then
    let now ← Prog.effect "Date.now"
    match Js.int? until_, Js.int? now with
    | some limit, some current =>
      if limit > current then return Twin.undefinedJson
      let _ ← Prog.effect "bundleKey" [record]
    | _, _ => let _ : Unit ← Prog.unsupported "a non-integer clock"
  if field record "runtime" == toJson "lambda" || !truthy (field record "workersCompatible") then
    return Twin.undefinedJson
  let apiKey ← Prog.effect "optionalEnv" [toJson "CLOUDFLARE_MCP_API_KEY"]
  if !truthy apiKey then return Twin.undefinedJson
  Prog.effect "optionalEnv" [toJson "CLOUDFLARE_MCP_URL"]

private def webKey (call : Json) : Prog Json := do
  let key := Twin.callArg call 0
  let cached ← Prog.effect "cache.get" [key]
  if truthy cached then return cached
  let buffer ← Prog.effect "toArrayBuffer" [key]
  let hmac := Twin.callArg call 1 == toJson "hmac"
  let algorithm := if hmac then
    Json.mkObj [("name", toJson "HMAC"), ("hash", toJson "SHA-256")]
    else Json.mkObj [("name", toJson "AES-GCM")]
  let usages : Json := if hmac then toJson ["sign"] else toJson ["encrypt", "decrypt"]
  let pendingKey := Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [])]
  let outcome ← Prog.attempt "crypto.subtle.importKey"
    [toJson "raw", buffer, algorithm, toJson false, usages]
  if let .threw error true := outcome then .fail error
  let _ ← Prog.effect "cache.set" [key, pendingKey]
  match outcome with
  | .ok imported => return imported
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "the import never finished"

private def sleep (call : Json) : Prog Json :=
  if !undef (Twin.callArg call 1) then
    Prog.unsupported "an abort signal: no recording covers it"
  else
    .input fun _ => do
      let _ ← Prog.effect "setTimeout" [fn "", Twin.callArg call 0]
      .input fun _ => do
        let _ ← Prog.effect "resolve"
        return Twin.undefinedJson

private def runRequest (call : Json) : Prog Json :=
  let request := field (Twin.callArg call 0) "request"
  let body := Twin.callArg call 3
  let fields : List (String × Json) :=
    [("method", Twin.callArg call 1), ("path", Twin.callArg call 2), ("search", toJson ""),
     ("query", Json.mkObj [("$params", .arr #[])]),
     ("headers", Js.set (field request "headers") "content-type" (toJson "application/json")),
     ("body", toJson (if undef body then "" else Twin.jsonStringify 64 body))]
  pure (fields.foldl (fun out (key, value) => Js.set out key value) request)

private def releaseWorker (call : Json) : Prog Json := do
  let worker := Twin.callArg call 0
  let now ← Prog.effect "Date.now"
  Prog.setChanged "args.0.busy" (Twin.field worker "busy") (toJson false)
  Prog.setChanged "args.0.idleSince" (Twin.field worker "idleSince") now
  if truthy (Twin.field worker "alive") then
    let tenants := (Js.arr? (field (Twin.field worker "tenants") "$set")).getD []
    if !tenants.contains (Twin.callArg call 1) then
      Prog.setState "args.0.tenants.$set" (.arr (tenants ++ [Twin.callArg call 1]).toArray)
  match Js.arr? (Twin.moduleValue call "poolWaiters") with
  | some (_ :: rest) =>
    Prog.setState "module.poolWaiters" (.arr rest.toArray)
    let _ ← Prog.effect "next"
  | _ => pure ()
  return Twin.undefinedJson

private def spawnWorker (call : Json) : Prog Json := do
  let worker ← Prog.effect "new IsolateWorker"
  Prog.setState "module.pool" (.arr (((Js.arr? (Twin.moduleValue call "pool")).getD []) ++ [worker]).toArray)
  if !truthy (Twin.moduleValue call "reaper") then
    let timer ← Prog.effect "setInterval" [fn "reapIdleWorkers", toJson (30000 : Nat)]
    Prog.setState "module.reaper" timer
    let _ ← Prog.effect "reaper.unref"
  return worker

private def acquireIsolateSlot (call : Json) : Prog Json := do
  let limit ← Prog.effect "positiveIntegerEnv"
    [toJson "ISOLATE_RUNNER_CONCURRENCY", toJson (8 : Nat)]
  match Js.int? (Twin.moduleValue call "activeIsolateRuns"), Js.int? limit with
  | some active, some max =>
    if active < max then
      Prog.setState "module.activeIsolateRuns" (toJson (active + 1))
      return fn "releaseIsolateSlot"
    Prog.unsupported "waiting for a slot: no recording covers it"
  | _, _ => Prog.unsupported "a non-integer counter"

private def releaseIsolateSlot (call : Json) : Prog Json := do
  match Js.arr? (Twin.moduleValue call "isolateWaiters") with
  | some (_ :: rest) =>
    Prog.setState "module.isolateWaiters" (.arr rest.toArray)
    let _ ← Prog.effect "next"
  | _ =>
    let active := (Js.int? (Twin.moduleValue call "activeIsolateRuns")).getD 0
    if active != 0 then
      Prog.setState "module.activeIsolateRuns" (toJson (max 0 (active - 1)))
  return Twin.undefinedJson

/-! ### `redact` -/

private def lowerChars (chars : List Char) : List Char := chars.map Char.toLower

/-- Replaces every match left to right. `matcher` sees the text already passed, newest first, so a
lookbehind reads the original even where an earlier match was replaced. -/
private def replaceEach (matcher : List Char → List Char → Option (Nat × List Char))
    (input : List Char) : List Char :=
  let rec go (fuel : Nat) (before rest out : List Char) : List Char :=
    match fuel, rest with
    | 0, _ => out.reverse ++ rest
    | _, [] => out.reverse
    | fuel + 1, c :: tail =>
      match matcher before rest with
      | some (length, replacement) =>
        go fuel ((rest.take length).reverse ++ before) (rest.drop length)
          (replacement.reverse ++ out)
      | none => go fuel (c :: before) tail (c :: out)
  go (input.length + 1) [] input []

private def isWord (c : Char) : Bool := isAlnum c || c == '_'

private def secretChar (c : Char) : Bool := !Js.isSpace c && c != ',' && c != ';'

/-- `/\b<word>\s+[^\s,;]+/gi`, replaced by `<word> [redacted]`. -/
private def schemeSecret (word : String) (before rest : List Char) : Option (Nat × List Char) :=
  let wordChars := word.toList
  let boundary := match before with
    | prev :: _ => !isWord prev
    | [] => true
  if !boundary || lowerChars (rest.take wordChars.length) != lowerChars wordChars then none else
  let after := rest.drop wordChars.length
  let spaces := after.takeWhile Js.isSpace
  let secret := (after.drop spaces.length).takeWhile secretChar
  if spaces.isEmpty || secret.isEmpty then none
  else some (wordChars.length + spaces.length + secret.length,
    (word ++ " [redacted]").toList)

private def queryNames : List String :=
  ["access_token", "api_key", "apikey", "key", "secret", "token"]

/-- `/([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&#\s]+/gi`. -/
private def querySecret (_before rest : List Char) : Option (Nat × List Char) :=
  match rest with
  | mark :: after =>
    if mark != '?' && mark != '&' then none else
    queryNames.findSome? fun name =>
      let nameLength := name.length
      if lowerChars (after.take nameLength) != name.toList then none else
      match after.drop nameLength with
      | '=' :: value =>
        let secret := value.takeWhile (fun c => c != '&' && c != '#' && !Js.isSpace c)
        if secret.isEmpty then none
        else some (nameLength + 2 + secret.length,
          rest.take (nameLength + 2) ++ "[redacted]".toList)
      | _ => none
  | [] => none

/-- The escape alternatives shared by the credential lookbehinds: `\\[nrt]` and `%HH`. -/
private def afterEscape (before : List Char) : Bool :=
  match before with
  | c :: '\\' :: _ => c == 'n' || c == 'r' || c == 't'
  | a :: b :: '%' :: _ => isHex a && isHex b
  | _ => false

private def boundaryWhere (allowed : Char → Bool) (before : List Char) : Bool :=
  match before with
  | [] => true
  | prev :: _ => allowed prev || afterEscape before

/-- A literal prefix, then at least `least` characters of a class, taken greedily. -/
private def prefixRun (literal : String) (cls : Char → Bool) (least : Nat) (rest : List Char) :
    Option Nat :=
  let chars := literal.toList
  if rest.take chars.length != chars then none else
  let run := (rest.drop chars.length).takeWhile cls
  if run.length < least then none else some (chars.length + run.length)

private def broodsPrefixes : List String :=
  ["bsk_", "bask_", "bpdk_", "bcli_", "bcode_", "bsts_", "bdts_", "brt_", "bsig_", "buat_",
   "bdap_", "bdob_"]

private def broodsCredential (before rest : List Char) : Option (Nat × List Char) :=
  if !boundaryWhere (fun c => !isWord c) before then none else
  (broodsPrefixes.findSome? fun literal =>
    prefixRun literal (fun c => isWord c || c == '.' || c == '-') 20 rest).map
      (·, "[redacted]".toList)

private def tokenChar (c : Char) : Bool := isWord c || c == '-'

private def awsKey (rest : List Char) : Option Nat :=
  match rest with
  | 'A' :: kind :: 'I' :: 'A' :: tail =>
    let body := tail.takeWhile (fun c => isUpper c || isDigit c)
    if (kind == 'K' || kind == 'S') && body.length ≥ 16 &&
        !((tail.drop 16).head?.map isAlnum |>.getD false) && body.length == 16 then
      some 20
    else none
  | _ => none

private def githubToken (rest : List Char) : Option Nat :=
  match rest with
  | 'g' :: 'h' :: kind :: '_' :: tail =>
    let run := tail.takeWhile isAlnum
    if "oprsu".toList.contains kind && run.length ≥ 36 then some (4 + run.length) else none
  | _ => none

private def slackToken (rest : List Char) : Option Nat :=
  match rest with
  | 'x' :: 'o' :: 'x' :: kind :: '-' :: tail =>
    let run := tail.takeWhile (fun c => isAlnum c || c == '-')
    if "abcdeoprs".toList.contains kind && run.length ≥ 10 then some (5 + run.length) else none
  | _ => none

private def googleApiKey (rest : List Char) : Option Nat :=
  if rest.take 4 != "AIza".toList then none else
  let run := (rest.drop 4).takeWhile tokenChar
  if run.length ≥ 35 then some 39 else none

private def jsonWebToken (rest : List Char) : Option Nat :=
  let part (chars : List Char) : Option Nat :=
    prefixRun "eyJ" tokenChar 8 chars
  (part rest).bind fun first =>
    match rest.drop first with
    | '.' :: second =>
      (part second).bind fun middle =>
        match second.drop middle with
        | '.' :: third =>
          let run := third.takeWhile tokenChar
          if run.length ≥ 8 then some (first + 1 + middle + 1 + run.length) else none
        | _ => none
    | _ => none

private def providerCredential (before rest : List Char) : Option (Nat × List Char) :=
  let lookbehindOk := boundaryWhere isAlnumNot before
  let first : Option Nat :=
    if !lookbehindOk then none else
    [githubToken rest,
     prefixRun "github_pat_" isWord 22 rest,
     prefixRun "sk-" tokenChar 32 rest,
     awsKey rest,
     slackToken rest,
     prefixRun "xapp-" (fun c => isAlnum c || c == '-') 10 rest,
     googleApiKey rest,
     prefixRun "ya29." tokenChar 20 rest].findSome? id
  let chosen := first <|>
    (if boundaryWhere (fun c => !tokenChar c) before then jsonWebToken rest else none)
  chosen.map (·, "[redacted]".toList)
where
  isAlnumNot (c : Char) : Bool := !isAlnum c

private def redact (call : Json) : Prog Json :=
  let steps : List (List Char → List Char → Option (Nat × List Char)) :=
    [schemeSecret "Bearer", schemeSecret "Basic", querySecret, broodsCredential,
     providerCredential]
  pure (toJson (String.ofList
    (steps.foldl (fun chars step => replaceEach step chars) (text (Twin.callArg call 0)).toList)))

/-! ### Agent config helpers -/

private def agentCanvasBadge (call : Json) : Prog Json :=
  let config := Twin.callArg call 0
  let extra := field config "extraConfig"
  let skills := field extra "skills"
  let outputFormat := field config "outputFormat"
  let allowed := if field skills "enabled" == toJson true then field skills "allowed" else .arr #[]
  let names := ((Js.arr? allowed).getD []).filter Js.isStr
  let structured := !undef outputFormat &&
    ((Js.arr? (field (Twin.moduleValue call "STRUCTURED_OUTPUT_TYPES") "$set")).getD []).contains
      (field outputFormat "type")
  let chat := field config "provider"
  let chosen := field (field extra "transcription") "provider"
  let transcriber := if Js.isStr chosen then chosen else chat
  let voice :=
    if Js.isStr chat && ["google", "vertex"].contains (text chat) then
      Json.mkObj [("provider", chat), ("native", toJson true)]
    else if Js.isStr transcriber &&
        ["fishaudio", "groq", "mistral", "openai"].contains (text transcriber) then
      Json.mkObj [("provider", transcriber), ("native", toJson false)]
    else .null
  pure (Json.mkObj
    [("publicAccess", toJson (field extra "publicAccess" == toJson true)),
     ("skills", .arr names.toArray),
     ("structuredOutput", toJson structured),
     ("voice", voice)])

private def assertEnvVarName (call : Json) : Prog Json := do
  let name := text (Twin.callArg call 0)
  let good := match name.toList with
    | first :: rest =>
      isUpper first && rest.all (fun c => isUpper c || isDigit c || c == '_')
    | [] => false
  refuseIf (!good || jsLength name > 64)
    "env name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters"
  return Twin.undefinedJson

private def isEntirelyEnvPlaceholders (call : Json) : Prog Json :=
  pure (toJson (isEnvRefsOnly (text (Twin.callArg call 0))))

private def substituteEnvPlaceholders (call : Json) : Prog Json :=
  Prog.effect "substitutePlaceholders"
    [Twin.callArg call 0, Twin.callArg call 1,
     Json.mkObj [("$regexp", toJson "/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g")]]

private def defaultSandboxOf (call : Json) : Prog Json :=
  let first := match field (Twin.callArg call 0) "sandboxes" with
    | .arr items => items.getD 0 Twin.undefinedJson
    | _ => Twin.undefinedJson
  pure (if Js.isStr first then first else Twin.undefinedJson)

private def findLaterSandboxMount (call : Json) : Prog Json := do
  let sandboxes := Twin.callArg call 0
  let items := (Js.arr? sandboxes).getD []
  let mut index := 0
  for sandboxId in items do
    let workspace ← Prog.effect "workspaceOnLaterSandbox"
      [sandboxes, toJson index, Twin.callArg call 1]
    if truthy workspace then
      return Json.mkObj
        [("index", toJson index), ("sandboxId", sandboxId), ("workspace", workspace)]
    index := index + 1
  return Twin.undefinedJson

/-- `CLIENT_ERROR_STATUS`. -/
private def clientErrorStatus (code : String) : Option Nat :=
  match code with
  | "invalid_request" => some 400
  | "unauthorized" => some 401
  | "payment_required" => some 402
  | "forbidden" => some 403
  | "not_found" => some 404
  | "conflict" => some 409
  | "manifest_conflict" => some 409
  | _ => none

private def clientErrorResponse (call : Json) : Prog Json := do
  let data ← Prog.effect "clientErrorData" [Twin.callArg call 0]
  if !truthy data then return .null
  let code := field data "code"
  match clientErrorStatus (text code) with
  | some status =>
    Prog.effect "jsonError"
      [toJson status, field data "message", Json.mkObj [("code", code)]]
  | none => Prog.unsupported "a code clientErrorData never returns"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  let skill := "packages/convex/model/skillRules.ts#"
  let mcp := "packages/convex/model/mcp.ts#"
  let hosted := "apps/core/src/harness/mcp/hosted.ts#"
  let executor := "apps/core/src/harness/isolate/executor.ts#"
  let forwarder := "apps/lambda/sandbox-log-forwarder.mjs#"
  [Twin.traced (skill ++ "validateSkillName") validateSkillName,
   Twin.traced (skill ++ "validateSkillDescription") validateSkillDescription,
   Twin.traced (skill ++ "normalizeBundlePath") normalizeBundlePath,
   Twin.traced (skill ++ "contentTypeForSkillPath") contentTypeForSkillPath,
   Twin.traced (skill ++ "stripYamlScalarQuotes") stripYamlScalarQuotes,
   Twin.traced (skill ++ "assertSafeGitHubSegment") assertSafeGitHubSegment,
   Twin.traced (skill ++ "parseSimpleYamlFrontmatter") parseSimpleYamlFrontmatter,
   Twin.traced (skill ++ "parseSkillMarkdown") parseSkillMarkdown,
   Twin.traced (skill ++ "parseGitHubSkillUrl") parseGitHubSkillUrl,
   Twin.traced "packages/convex/model/objects.ts#remapKeys" remapKeys,
   Twin.traced (mcp ++ "assertMcpRow") assertMcpRow,
   Twin.traced (mcp ++ "mcpBundleStorageKey") mcpBundleStorageKey,
   Twin.traced (mcp ++ "normalizeAllowedTools") normalizeAllowedTools,
   Twin.traced (mcp ++ "normalizeBundle") normalizeBundle,
   Twin.traced (mcp ++ "normalizeCommand") normalizeCommand,
   Twin.traced (mcp ++ "normalizeDescription") normalizeDescription,
   Twin.traced (mcp ++ "normalizeName") normalizeName,
   Twin.traced (mcp ++ "normalizeRuntime") normalizeRuntime,
   Twin.traced (mcp ++ "normalizeUrl") normalizeUrl,
   Twin.traced (mcp ++ "normalizeConnection") normalizeConnection,
   Twin.traced (mcp ++ "normalizeOauth") normalizeOauth,
   Twin.traced (forwarder ++ "otlpAttributes") otlpAttributes,
   Twin.traced (forwarder ++ "redact") redact,
   Twin.traced "apps/core/src/harness/mcp/client.ts#principalHeaders" principalHeaders,
   Twin.traced "apps/core/src/harness/mcp/client.ts#sleep" sleep,
   Twin.traced (hosted ++ "hostedMcpFetch") hostedMcpFetch,
   Twin.traced (hosted ++ "workersUrl") workersUrl,
   Twin.traced "packages/convex/model/envelope.ts#webKey" webKey,
   Twin.traced "apps/core/src/harness/mcp-tasks.ts#runRequest" runRequest,
   Twin.traced (executor ++ "releaseWorker") releaseWorker,
   Twin.traced (executor ++ "spawnWorker") spawnWorker,
   Twin.traced (executor ++ "acquireIsolateSlot") acquireIsolateSlot,
   Twin.traced (executor ++ "releaseIsolateSlot") releaseIsolateSlot,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#agentCanvasBadge" agentCanvasBadge,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#assertEnvVarName" assertEnvVarName,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#isEntirelyEnvPlaceholders"
     isEntirelyEnvPlaceholders,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#substituteEnvPlaceholders"
     substituteEnvPlaceholders,
   Twin.traced "packages/convex/model/agentRules.ts#defaultSandboxOf" defaultSandboxOf,
   Twin.traced "packages/convex/model/sandboxMounts.ts#findLaterSandboxMount" findLaterSandboxMount,
   Twin.traced "packages/convex/model/clientError.ts#clientErrorResponse" clientErrorResponse]

end Spec.Hosted.Wavehosted3a
