import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign5/agent5a.tsv`.
-/

namespace Spec.Agent.Waveagent5a

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def asString (value : Json) : Option String :=
  (value.getStr?).toOption

private def isString (value : Json) : Bool :=
  (asString value).isSome

/-- A non-empty string, which is what `value ? ... : ...` accepts for a string. -/
private def truthyString (value : Json) : Option String :=
  (asString value).bind fun text => if text.isEmpty then none else some text

private def isTrue (value : Json) : Bool :=
  value.compress == (toJson true).compress

/-- `typeof value === "object"`, non-null, for a recorded value. Recorder tags are not objects. -/
private def isPlainObject (value : Json) : Bool :=
  match value with
  | .obj _ => !isUndef value
  | _ => false

private def isArray (value : Json) : Bool :=
  match value with
  | .arr _ => true
  | _ => false

private def items (value : Json) : List Json :=
  match value with
  | .arr entries => entries.toList
  | _ => []

/-- An object literal whose `undefined` values vanish, as they do in a recording. -/
private def objectOf (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

/-- An object's own keys in insertion order: `$keys` when recorded, otherwise alphabetical. -/
private def ownKeys (value : Json) : List String :=
  let recorded := match value.getObjVal? "$keys" with
    | .ok (.arr keys) => keys.toList.filterMap asString
    | _ =>
      match value with
      | .obj kvs => kvs.keys
      | _ => []
  if isUndef value then [] else recorded.filter fun key => key != "$keys" && key != "$fields"

private def takeChars (text : String) (count : Nat) : String :=
  String.ofList (text.toList.take count)

/-! ## `policy.ts` -/

/-- `POLICY_INPUT_PREVIEW_MAX` in `policy.ts:55`. -/
def policyInputPreviewMax : Nat := 160

/-- `formatPolicyInputPreview`: the first six entries, joined, then cut to the preview limit. -/
def formatPolicyInputPreview (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  if isString (field input "pattern") && isUndef (field input "path") then
    Prog.unsupported "a grep or glob input's undefined path is dropped from the recording"
  let keys := (ownKeys input).take 6
  let mut parts : List String := []
  for key in keys do
    let rendered ← Prog.effect "formatPolicyPreviewValue" [field input key]
    parts := parts ++ [s!"{key}={(asString rendered).getD ""}"]
  return toJson (takeChars (" ".intercalate parts) policyInputPreviewMax)

/-! ## Shared helpers -/

private def bareError {α : Type} (message : String) : Prog α :=
  Prog.throwError "Error" message

private def base64Value (char : Char) : Option Nat :=
  if 'A' ≤ char && char ≤ 'Z' then some (char.toNat - 'A'.toNat)
  else if 'a' ≤ char && char ≤ 'z' then some (char.toNat - 'a'.toNat + 26)
  else if '0' ≤ char && char ≤ '9' then some (char.toNat - '0'.toNat + 52)
  else if char == '+' then some 62
  else if char == '/' then some 63
  else none

/-- Decodes the recorder's `{"$bytes": base64}`. `none` for anything else, such as `$big`. -/
private def recordedBytes (value : Json) : Option (List UInt8) :=
  (asString (field value "$bytes")).map fun encoded =>
    let bits := encoded.toList.filterMap base64Value
    let rec go (fuel : Nat) (rest : List Nat) (out : List UInt8) : List UInt8 :=
      match fuel, rest with
      | fuel + 1, a :: b :: more =>
        let first := (a * 4 + b / 16) % 256
        match more with
        | c :: more2 =>
          let second := ((b % 16) * 16 + c / 4) % 256
          match more2 with
          | d :: more3 =>
            go fuel more3 (((c % 4) * 64 + d).toUInt8 :: second.toUInt8 :: first.toUInt8 :: out)
          | [] => (second.toUInt8 :: first.toUInt8 :: out).reverse
        | [] => (first.toUInt8 :: out).reverse
      | _, _ => out.reverse
    go (bits.length + 1) bits []

/-! ## `harness.ts` -/

/-- `toolOutputErrorText`: the text of a tool's `error-text` output. -/
def toolOutputErrorText (call : Json) : Prog Json := do
  let output := Twin.callArg call 0
  if !isPlainObject output then
    return undef
  let value := field output "value"
  if (asString (field output "type")) == some "error-text" && isString value then
    return value
  return undef

/-- `steeringModelMessages`: system events are dropped before media is rehydrated. -/
def steeringModelMessages (call : Json) : Prog Json := do
  let events := (items (Twin.callArg call 0)).filter fun event =>
    (asString (field event "role")) != some "system"
  let stripped ← Prog.effect "stripEnvelopeFieldsFromMessages" [.arr events.toArray]
  Prog.effect "rehydrateStoredMedia" [stripped, Twin.callArg call 1, Twin.callArg call 2]

/-! ## `log.ts` -/

private def setOf (value : Json) : Bool :=
  isPlainObject value || isArray value

private def addSecret (found : List String) (secret : String) : List String :=
  if found.contains secret then found else found ++ [secret]

/-- `entryName`: a string `key`, else a string `name`. -/
def entryName (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  if isString (field record "key") then
    return field record "key"
  if isString (field record "name") then
    return field record "name"
  return undef

/-- `PUBLIC_ENV_NAME_PATTERN`: an email address or a git author or committer name. -/
private def publicEnvName (name : String) : Bool :=
  let lowered := name.toLower.toList
  let suffix := "email".toList
  let endsInEmail :=
    lowered.length ≥ suffix.length &&
    lowered.drop (lowered.length - suffix.length) == suffix &&
    (match (lowered.take (lowered.length - suffix.length)).getLast? with
      | none => true
      | some before => !(before.isLower || before.isDigit))
  endsInEmail || name.toLower == "git_author_name" || name.toLower == "git_committer_name"

private def normalizeEnvKey (key : String) : String :=
  String.ofList (key.toLower.toList.filter fun char => char != '-' && char != '_')

private def envContainerKeys : List String :=
  ["env", "envvars", "environmentvariables", "runtimevariables"]

/-- The `[name, value]` pairs of an env block, asking `entryName` of each array entry. -/
private def envEntries (nested : Json) : Prog (List (Json × Json)) := do
  if isArray nested then
    let mut pairs : List (Json × Json) := []
    for entry in items nested do
      if isPlainObject entry && !isUndef (field entry "value") then
        let name ← Prog.effect "entryName" [entry]
        pairs := pairs ++ [(name, field entry "value")]
      else
        pairs := pairs ++ [(undef, undef)]
    return pairs
  return (ownKeys nested).map fun key => (toJson key, field nested key)

/-- Adds an env value unless its name marks it as public. -/
private def addEnvValue (found : List String) (name value : Json) : Prog (List String) := do
  let some text := asString value | return found
  match truthyString name with
  | none => return addSecret found text
  | some envName =>
    let secret ← Prog.effect "isSecretName" [toJson envName]
    if isTrue secret || !publicEnvName envName then
      return addSecret found text
    return found

/-- The `visit` closure inside `collectSecretValues`. -/
private def visitSecrets : Nat → Json → List String → Prog (List String)
  | 0, _, _ => Prog.unsupported "value nested deeper than the model walks"
  | fuel + 1, current, found => do
    if isArray current then
      let mut acc := found
      for item in items current do
        acc ← visitSecrets fuel item acc
      return acc
    if !isPlainObject current then
      return found
    let mut acc := found
    let namedKey ← Prog.effect "entryName" [current]
    if let some name := truthyString namedKey then
      let secret ← Prog.effect "isSecretName" [toJson name]
      if isTrue secret then
        if let some text := asString (field current "value") then
          acc := addSecret acc text
    for key in ownKeys current do
      let nested := field current key
      if envContainerKeys.contains (normalizeEnvKey key) && setOf nested then
        let pairs ← envEntries nested
        for (name, value) in pairs do
          acc ← addEnvValue acc name value
      let secretKey ← Prog.effect "isSecretName" [toJson key]
      if isTrue secretKey then
        if let some text := asString nested then
          acc := addSecret acc text
      acc ← visitSecrets fuel nested acc
    return acc

private def walkFuel : Nat := 64

/-- `collectSecretValues`: named secrets and env values, de-duplicated, at least four characters. -/
def collectSecretValues (call : Json) : Prog Json := do
  let found ← visitSecrets walkFuel (Twin.callArg call 0) []
  return toJson (found.filter (·.length ≥ 4))

private def jsWhitespace (char : Char) : Bool :=
  char == ' ' || char == '\t' || char == '\n' || char == '\r' || char.toNat == 12 ||
  char.toNat == 11 || char.toNat == 0xA0 || char.toNat == 0xFEFF || char.toNat == 0x2028 ||
  char.toNat == 0x2029 || char.toNat == 0x1680 || char.toNat == 0x202F || char.toNat == 0x205F ||
  char.toNat == 0x3000 || (0x2000 ≤ char.toNat && char.toNat ≤ 0x200A)

/-- The first whitespace at or after `from`, or the text's length. -/
private def whitespaceEnd (text : List Char) (start : Nat) : Nat :=
  match (text.drop start).findIdx? jsWhitespace with
  | some offset => start + offset
  | none => text.length

private def cycleSignal : Json :=
  Json.mkObj [("$cycle", toJson true)]

private def isCycleSignal (value : Json) : Bool :=
  value.compress == cycleSignal.compress

/-- `JSON.stringify` with the secret-hiding replacer. `none` is a value it leaves out. -/
private def stringifyMasked : Nat → List String → Prog (Option (String × String))
  | 0, _ => Prog.unsupported "value nested deeper than the model walks"
  | fuel + 1, ancestors =>
    .input fun
      | none => Prog.unsupported "the replacer was not entered"
      | some (_, entered) => do
        let key := (asString (Twin.arg entered 0)).getD ""
        let item := Twin.arg entered 1
        let secret ← Prog.effect "isSecretName" [toJson key]
        if isTrue secret then
          return some (key, (toJson "[redacted]").compress)
        if isUndef item then
          return none
        if !setOf item then
          return some (key, item.compress)
        if ancestors.contains item.compress then
          throw cycleSignal
        let trail := item.compress :: ancestors
        if isArray item then
          let mut parts : List String := []
          for _ in items item do
            match ← stringifyMasked fuel trail with
            | some (_, text) => parts := parts ++ [text]
            | none => parts := parts ++ ["null"]
          return some (key, "[" ++ ",".intercalate parts ++ "]")
        let mut parts : List String := []
        for _ in ownKeys item do
          if let some (name, text) ← stringifyMasked fuel trail then
            parts := parts ++ [(toJson name).compress ++ ":" ++ text]
        return some (key, "{" ++ ",".intercalate parts ++ "}")

/-- The text `redactSerialized` scrubs: a string as is, else its masked JSON. -/
private def serializedText (value : Json) : Prog String := do
  if let some text := asString value then
    return text
  Prog.catchFail
    (do
      match ← stringifyMasked walkFuel [] with
      | some (_, text) => pure text
      | none => pure "")
    (fun error =>
      if isCycleSignal error then pure "[object Object]" else throw error)

private def escapedForm (secret : Json) : Json :=
  let quoted := secret.compress.toList
  toJson (String.ofList ((quoted.drop 1).take (quoted.length - 2)))

private def truncatedAt (text : String) (limit : Nat) : Json :=
  toJson (takeChars text limit ++ "...[truncated]")

/-- The growing-window loop of `redactSerialized`. -/
private def scrubWindows (text : List Char) (secrets : Json) (limit overlap : Nat) :
    Nat → Nat → Prog Json
  | 0, _ => Prog.unsupported "more windows than the model allows"
  | fuel + 1, size => do
    let stop := whitespaceEnd text size
    if stop ≥ text.length then
      let scrubbed ← Prog.effect "scrubSecrets" [toJson (String.ofList text), secrets]
      let result := (asString scrubbed).getD ""
      return if result.length ≤ limit then scrubbed else truncatedAt result limit
    let scrubbed ← Prog.effect "scrubSecrets" [toJson (String.ofList (text.take stop)), secrets]
    let result := (asString scrubbed).getD ""
    let kept := takeChars result (result.length - overlap)
    if kept.length ≥ limit then
      return truncatedAt kept limit
    scrubWindows text secrets limit overlap fuel (size * 2)

/-- `redactSerialized`: never keeps the last `overlap` characters of a window, as a secret may
straddle its end. -/
def redactSerialized (call : Json) : Prog Json := do
  let text ← serializedText (Twin.callArg call 0)
  let values := items (Twin.callArg call 1)
  let expanded := values.flatMap fun secret => [secret, escapedForm secret]
  let secrets ← Prog.effect "matchableSecrets" [.arr expanded.toArray]
  let limit := ((Twin.callArg call 2).getNat?).toOption.getD 0
  let overlap := (((items secrets).head?).bind asString).map (·.length) |>.getD 0
  scrubWindows text.toList secrets limit overlap walkFuel (limit + overlap)

/-- `redactWithRunSecrets`. -/
def redactWithRunSecrets (call : Json) : Prog Json := do
  let secrets ← Prog.effect "matchableSecrets" [Twin.param call 1]
  Prog.effect "redactRunValue" [Twin.callArg call 0, secrets]

private def pad (width value : Nat) : String :=
  let digits := toString value
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `Date.prototype.toJSON` for a non-negative epoch in milliseconds. -/
private def isoFromEpochMs (ms : Nat) : String :=
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
  let year := yoe + era * 400 + (if month ≤ 2 then 1 else 0)
  s!"{pad 4 year}-{pad 2 month}-{pad 2 day}T{pad 2 (rest / 3600000)}:" ++
    s!"{pad 2 (rest % 3600000 / 60000)}:{pad 2 (rest % 60000 / 1000)}.{pad 3 (rest % 1000)}Z"

/-- `redactRunValue`: replaces secret text and keeps the shape, keys included. -/
def redactRunValue (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let secrets := Twin.callArg call 1
  if isString value then
    return ← Prog.effect "replaceSecretValues" [value, secrets]
  if let some ms := ((field value "$date").getNat?).toOption then
    return ← Prog.effect "redactRunValue" [toJson (isoFromEpochMs ms), secrets]
  if isArray value then
    let mut out : List Json := []
    for item in items value do
      out := out ++ [← Prog.effect "redactRunValue" [item, secrets]]
    return .arr out.toArray
  if !isPlainObject value then
    return value
  let mut out : List (String × Json) := []
  for key in ownKeys value do
    out := out ++ [(key, ← Prog.effect "redactRunValue" [field value key, secrets])]
  return Json.mkObj out

/-! ## `hook-dispatcher.ts` -/

private def sameText (left right : Json) : Bool :=
  left.compress == right.compress

/-- `buildEventIndex`: each active record under each event its ref lets through, in ref order. -/
def buildEventIndex (call : Json) : Prog Json := do
  let refs := items (Twin.callArg call 0)
  let records := items (Twin.callArg call 1)
  let mut index : List (Json × List Json) := []
  for ref in refs do
    let matching := records.reverse.find? fun record =>
      sameText (field record "hookId") (field ref "hookId")
    let some record := matching | continue
    if (asString (field record "status")) != some "active" then
      continue
    let wanted := field ref "events"
    let events :=
      if isArray wanted then
        (items (field record "events")).filter fun event =>
          (items wanted).any (sameText event)
      else items (field record "events")
    for event in events do
      if index.any (fun entry => sameText entry.1 event) then
        index := index.map fun entry =>
          if sameText entry.1 event then (entry.1, entry.2 ++ [record]) else entry
      else
        index := index ++ [(event, [record])]
  return Json.mkObj
    [("$map", .arr (index.map fun entry =>
      Json.arr #[entry.1, .arr entry.2.toArray]).toArray)]

private def distinctJson (values : List Json) : List Json :=
  values.foldl (fun seen value =>
    if seen.any (sameText value) then seen else seen ++ [value]) []

/-- `loadAgentHooks`: one read per distinct hook id, keeping the active records. -/
def loadAgentHooks (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let ids := distinctJson ((items (Twin.callArg call 1)).map (field · "hookId"))
  let _ ← Prog.effect "getStorage"
  let outcomes ← Prog.all (ids.map fun id => ("store.getById", [accountId, id]))
  let mut kept : List Json := []
  for outcome in outcomes do
    match outcome with
    | .threw error _ => throw error
    | .ok record =>
      if (asString (field record "status")) == some "active" then
        kept := kept ++ [record]
    | .pending => Prog.unsupported "a hook read never finished"
  return .arr kept.toArray

/-- `hookVisibleConfig`: what a hook may read of the agent's config. -/
def hookVisibleConfig (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let keysOf (name : String) : Json :=
    toJson (ownKeys (field config name)).toArray
  let orEmpty (value : Json) : Json :=
    if isUndef value || value == Json.null then .arr #[] else value
  return objectOf
    [("model", objectOf
      [("provider", field (field config "model") "provider"),
       ("modelId", field (field config "model") "modelId")]),
     ("harness", field (field config "harness") "type"),
     ("maxTurn", field (field config "agent") "maxTurn"),
     ("tools", keysOf "tools"),
     ("mcp", keysOf "mcp"),
     ("channels", keysOf "channels"),
     ("skills", orEmpty (field (field config "skills") "allowed")),
     ("subagents", orEmpty (field (field config "subagent") "allowed")),
     ("denyTools", orEmpty (field config "denyTools"))]

/-! ## `conversation-files.ts` -/

/-- The listing command in `readConversationFiles`. -/
private def listFilesCommand : String :=
  "find . -type f | while IFS= read -r f; do printf '%s\\t' \"$f\"; base64 -w0 \"$f\"; " ++
  "printf '\\n'; done | gzip -c | base64 -w0"

private def stderrThenStdout (result : Json) : String :=
  (((asString (field result "stderr")).getD "") ++ ((asString (field result "stdout")).getD
    "")).trimAscii.toString

private def stripDotSlash (path : String) : String :=
  if path.startsWith "./" then (path.drop 2).toString else path

private def listingEntry (line : String) : Json :=
  let chars := line.toList
  let name := String.ofList (chars.takeWhile (· != '\t'))
  let content := String.ofList ((chars.dropWhile (· != '\t')).drop 1)
  Json.mkObj [("path", toJson (stripDotSlash name)), ("contentBase64", toJson content)]

private def entryPath (entry : Json) : String :=
  (asString (field entry "path")).getD ""

/-- `readConversationFiles`: gunzips the listing, drops lines without a tab, sorts by path. -/
def readConversationFiles (call : Json) : Prog Json := do
  let ws := Twin.callArg call 0
  let result ← Prog.effect "runSandbox"
    [field ws "sandbox", field ws "namespace", toJson listFilesCommand]
  if !isTrue (field result "ok") then
    let message := stderrThenStdout result
    bareError (if message.isEmpty then "listing failed" else message)
  if isTrue (field result "truncated") then
    bareError "The folder is over the sandbox's output limit to list in one read."
  let stdout := ((asString (field result "stdout")).getD "").trimAscii.toString
  let unzipped ← Prog.effect "gunzipSync" [Json.mkObj [("$bytes", toJson stdout)]]
  let some bytes := recordedBytes unzipped | Prog.unsupported "listing bytes were not recorded"
  let some listing := String.fromUTF8? (ByteArray.mk bytes.toArray)
    | Prog.unsupported "Buffer#toString would substitute invalid UTF-8"
  let lines := (listing.splitOn "\n").filter fun line => line.toList.contains '\t'
  let sorted := (lines.map listingEntry).toArray.qsort fun a b => entryPath a < entryPath b
  return .arr sorted

/-- `writeConversationFiles`: clears the folder, then writes every file in one command. -/
def writeConversationFiles (call : Json) : Prog Json := do
  let ws := Twin.callArg call 0
  let mut writes : List String := []
  for file in items (Twin.callArg call 1) do
    let relative ← Prog.effect "toWorkspaceRelative" [field file "path"]
    let quoted ← Prog.effect "shellQuote" [toJson s!"./{(asString relative).getD ""}"]
    let q := (asString quoted).getD ""
    let content ← Prog.effect "shellQuote" [field file "contentBase64"]
    writes := writes ++
      [s!"mkdir -p \"$(dirname {q})\" && printf '%s' {(asString content).getD ""} | base64 -d > {q}"]
  let command := " && ".intercalate ("rm -rf ./* ./.[!.]* ./..?*" :: writes)
  let result ← Prog.effect "runSandbox" [field ws "sandbox", field ws "namespace", toJson command]
  if !isTrue (field result "ok") then
    let message := stderrThenStdout result
    bareError (if message.isEmpty then "write failed" else message)
  return undef

/-! ## `ai-sdk-harness` -/

/-- `createAiSdkHarnessAdapter`: an unlisted type falls through to Pi. -/
def createAiSdkHarnessAdapter (call : Json) : Prog Json :=
  let creator := match asString (Twin.callArg call 0) with
    | some "claude-code" => "createClaudeCodeAdapter"
    | some "codex" => "createCodexAdapter"
    | some "deepagents" => "createDeepAgentsAdapter"
    | some "opencode" => "createOpenCodeAdapter"
    | _ => "createPiAdapter"
  Prog.effect creator [Twin.callArg call 1]

/-- `createConfiguredAiSdkHarnessAdapter`: only Pi's adapter also takes the session. -/
def createConfiguredAiSdkHarnessAdapter (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  match truthyString (field (field config "harness") "type") with
  | none => bareError "config.harness is required"
  | some "claude-code" => Prog.effect "createConfiguredClaudeCodeAdapter" [config]
  | some "codex" => Prog.effect "createConfiguredCodexAdapter" [config]
  | some "deepagents" => Prog.effect "createConfiguredDeepAgentsAdapter" [config]
  | some "opencode" => Prog.effect "createConfiguredOpenCodeAdapter" [config]
  | some _ => Prog.effect "createConfiguredPiAdapter" [config, Twin.callArg call 1]

/-- `requireAiSdkHarnessCompute`: a harness needs a persistent sandbox or lambda machine. -/
def requireAiSdkHarnessCompute (call : Json) : Prog Json := do
  let compute := Twin.callArg call 0
  let provider := asString (field compute "provider")
  if (provider != some "sandbox" && provider != some "lambda") ||
      !isTrue (field compute "persistent") then
    bareError "config.harness requires a persistent sandbox using the sandbox or lambda provider"
  return compute

private def harness (name : String) : String :=
  s!"apps/core/src/harness/{name}"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (harness "policy.ts#formatPolicyInputPreview") formatPolicyInputPreview,
   Twin.traced (harness "harness.ts#toolOutputErrorText") toolOutputErrorText,
   Twin.traced (harness "harness.ts#steeringModelMessages") steeringModelMessages,
   Twin.traced "apps/core/src/shared/log.ts#entryName" entryName,
   Twin.traced "apps/core/src/shared/log.ts#collectSecretValues" collectSecretValues,
   Twin.traced "apps/core/src/shared/log.ts#redactSerialized" redactSerialized,
   Twin.traced "apps/core/src/shared/log.ts#redactWithRunSecrets" redactWithRunSecrets,
   Twin.traced "apps/core/src/shared/log.ts#redactRunValue" redactRunValue,
   Twin.traced (harness "hook-dispatcher.ts#buildEventIndex") buildEventIndex,
   Twin.traced (harness "hook-dispatcher.ts#loadAgentHooks") loadAgentHooks,
   Twin.traced (harness "hook-dispatcher.ts#hookVisibleConfig") hookVisibleConfig,
   Twin.traced (harness "conversation-files.ts#readConversationFiles") readConversationFiles,
   Twin.traced (harness "conversation-files.ts#writeConversationFiles") writeConversationFiles,
   Twin.traced (harness "ai-sdk-harness/adapters/index.ts#createAiSdkHarnessAdapter")
     createAiSdkHarnessAdapter,
   Twin.traced (harness "ai-sdk-harness/adapters/index.ts#createConfiguredAiSdkHarnessAdapter")
     createConfiguredAiSdkHarnessAdapter,
   Twin.traced (harness "ai-sdk-harness/sandbox.ts#requireAiSdkHarnessCompute")
     requireAiSdkHarnessCompute]

end Spec.Agent.Waveagent5a
