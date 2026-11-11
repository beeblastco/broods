import Spec.Twin
import Spec.Access.Twins.Crypto

namespace Spec.Agent.Waveagent1

open Lean Spec

private def field (v : Json) (k : String) : Json :=
  (v.getObjVal? k).toOption.getD Twin.undefinedJson

private def str (v : Json) : String := v.getStr?.toOption.getD ""
private def arr (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def undef (v : Json) : Bool := v == Twin.undefinedJson
private def truth (v : Json) : Bool :=
  !(undef v || v == Json.null || v == toJson false || v == toJson (0 : Nat) || v == toJson "")
private def obj (xs : List (String × Json)) : Json :=
  Json.mkObj (xs.filter fun p => !undef p.2)
private def fields (v : Json) : List (String × Json) :=
  if undef v then [] else v.getObj?.toOption.map (·.toList) |>.getD []
private def merge (a b : Json) : Json :=
  obj ((fields a).filter (fun p => !(fields b).any (·.1 == p.1)) ++ fields b)
private def fn (s : String) : Json := Json.mkObj [("$fn", toJson s)]
private def contains (s needle : String) : Bool := (s.splitOn needle).length > 1
private def result (v : Json) : Json := Json.mkObj [("returned", if undef v then Json.null else v)]
private def plain (source : String) (f : Json → Json) : Twin :=
  { source := source, run := f }

private def compatibilityApprovalStatus (call : Json) : Prog Json := do
  let name := str (Twin.callArg call 0)
  let input := Twin.callArg call 1
  let opts := Twin.callArg call 2
  let workspace := match field input "workspace" with | .str s => toJson s | _ => Twin.undefinedJson
  let target ← Prog.effect "bashSandboxTarget" [field input "sandbox"]
  let approval := toJson "user-approval"
  if name == "bash" then
    if !undef (field input "sandbox") && undef target then return approval
    let needed ← Prog.effect "bashNeedsApproval"
      [obj [("workspaces", field opts "workspaces"), ("sandboxes", field opts "sandboxes")],
       obj [("workspace", workspace), ("sandbox", target)]]
    return if truth needed then approval else Twin.undefinedJson
  if name == "computer" then
    if ["cursor_position", "screenshot", "wait", "zoom"].contains (str (field input "action")) then
      return Twin.undefinedJson
    let machines ← Prog.effect "machineSandboxes" [field opts "sandboxes"]
    let machine ← Prog.effect "computerSandboxTarget" [machines, field input "sandbox"]
    return if field (field machine "sandbox") "permissionMode" != toJson "bypass" then approval else Twin.undefinedJson
  if name == "browse" then
    let first := (arr (field opts "sandboxes")).headD Twin.undefinedJson
    return if field input "mode" == toJson "eval" && field (field first "sandbox") "permissionMode" != toJson "bypass" then approval else Twin.undefinedJson
  if ["write", "edit", "memory_save"].contains name then
    let needed ← Prog.effect "editNeedsApproval" [field opts "workspaces", workspace]
    return if truth needed then approval else Twin.undefinedJson
  let configured := arr (field (field opts "configuredApprovals") "$map")
  return if configured.any (fun p => Twin.arg p 0 == toJson name) then approval else Twin.undefinedJson

private def loadPages (key opts : Json) (backward : Bool) : Nat → Json → List (List Json) → Prog Json
  | 0, _, _ => Prog.unsupported "pagination exceeds 256 pages"
  | fuel + 1, cursor, pages => do
    let args := if backward then
        obj [("conversationKey", key), ("beforeCursor", cursor),
          ("fromSystemPrefix", toJson "<session-compaction-summary>"),
          ("role", field opts "role"), ("stopAtRole", field opts "stopAtRole")]
      else obj [("conversationKey", key), ("afterCursor", cursor)]
    let page ← Prog.effect "runtime.query" [toJson "listConversationEvents", args]
    let entries := (arr (field page "page")).map fun row =>
      obj [("createdAt", field row "cursor"), ("event", field row "event")]
    let pages := pages ++ [entries]
    if truth (field page "isDone") then
      return toJson ((if backward then pages.reverse else pages).flatten)
    let next := field page "continueCursor"
    if !truth next || next == cursor then
      return ← Prog.throwError "Error" "Conversation event pagination did not advance"
    loadPages key opts backward fuel next pages

private def loadConversationEntries (call : Json) : Prog Json := do
  if !truth (Twin.field (Twin.self call) "persist") then return toJson ([] : List Json)
  let opts := Twin.callArg call 0
  let after := field opts "afterCreatedAt"
  let backward := undef after || after == Json.null
  loadPages (Twin.field (Twin.self call) "conversationKey") opts backward 256
    (if backward then field opts "beforeCreatedAt" else after) []

private def readHarnessPages (call : Json) : Nat → Json → List Json → Prog Json
  | 0, _, _ => Prog.unsupported "pagination exceeds 256 pages"
  | fuel + 1, after, entries => do
    let page ← Prog.effect "runtime.query" [toJson "readHarnessSessionEntries",
      obj [("conversationKey", Twin.field (Twin.self call) "conversationKey"),
        ("sessionId", Twin.callArg call 0), ("leafEntryId", Twin.callArg call 1),
        ("afterSequence", after)]]
    let entries := entries ++ arr (field page "entries")
    if field page "nextSequence" == Json.null then return toJson entries
    readHarnessPages call fuel (field page "nextSequence") entries

private def storedEventBatches (args : Json) : Json := Id.run do
  let mut batches : List Json := []
  let mut batch : List Json := []
  let mut bytes := 0
  for entry in arr (Twin.arg args 0) do
    let size := entry.compress.toUTF8.size
    if !batch.isEmpty && (bytes + size > 8 * 1024 * 1024 || batch.length >= 8000) then
      batches := batches ++ [toJson batch]
      batch := []
      bytes := 0
    batch := batch ++ [entry]
    bytes := bytes + size
  if !batch.isEmpty then batches := batches ++ [toJson batch]
  return toJson batches

/-- `Response.json(value, { status })`, given the text `JSON.stringify(value)` gives. -/
private def jsonBodyResponse (body : String) (status : Nat) : Json :=
  obj [("$response", obj [("status", toJson status),
    ("headers", toJson [toJson [toJson "content-type", toJson "application/json;charset=utf-8"]]),
    ("body", toJson body)])]

/-- A token of JSON text; `open_ true` starts an object, `open_ false` an array. -/
private inductive JsonToken where
  | open_ : Bool → JsonToken
  | close : JsonToken
  | text : String → JsonToken
  | literal : Json → JsonToken

/-- The raw characters of a string literal up to its closing quote, and what follows. -/
private def stringChars : List Char → List Char → Option (List Char × List Char)
  | '"' :: rest, acc => some (acc.reverse, rest)
  | '\\' :: c :: rest, acc => stringChars rest (c :: '\\' :: acc)
  | c :: rest, acc => stringChars rest (c :: acc)
  | [], _ => none

/-- The characters of a bare literal (number, `true`, `null`), and what follows. -/
private def wordChars : List Char → List Char × List Char
  | c :: rest =>
    if c.isWhitespace || ",:]}".toList.contains c then ([], c :: rest)
    else let (word, after) := wordChars rest; (c :: word, after)
  | [] => ([], [])

/-- One token per step; each step consumes a character, so the length is enough fuel. -/
private def tokenize : Nat → List Char → List JsonToken → Option (List JsonToken)
  | 0, [], acc => some acc.reverse
  | 0, _, _ => none
  | _ + 1, [], acc => some acc.reverse
  | fuel + 1, '{' :: rest, acc => tokenize fuel rest (.open_ true :: acc)
  | fuel + 1, '[' :: rest, acc => tokenize fuel rest (.open_ false :: acc)
  | fuel + 1, '}' :: rest, acc => tokenize fuel rest (.close :: acc)
  | fuel + 1, ']' :: rest, acc => tokenize fuel rest (.close :: acc)
  | fuel + 1, ',' :: rest, acc => tokenize fuel rest acc
  | fuel + 1, ':' :: rest, acc => tokenize fuel rest acc
  | fuel + 1, '"' :: rest, acc => do
    let (raw, after) ← stringChars rest []
    match Json.parse ("\"" ++ String.ofList raw ++ "\"") with
    | .ok (.str decoded) => tokenize fuel after (.text decoded :: acc)
    | _ => none
  | fuel + 1, c :: rest, acc =>
    if c.isWhitespace then tokenize fuel rest acc
    else
      let (word, after) := wordChars (c :: rest)
      match Json.parse (String.ofList word) with
      | .ok value => tokenize fuel after (.literal value :: acc)
      | .error _ => none

/-- An object or array being read: keys so far in source order, and the key awaiting its value. -/
private inductive JsonFrame where
  | items : List Json → JsonFrame
  | fields : List (String × Json) → Option String → JsonFrame

private def placeValue (stack : List JsonFrame) (value : Json) : Option (List JsonFrame × Option Json) :=
  match stack with
  | [] => some ([], some value)
  | .items list :: rest => some (.items (list ++ [value]) :: rest, none)
  | .fields entries (some key) :: rest => some (.fields (entries ++ [(key, value)]) none :: rest, none)
  | .fields _ none :: _ => none

private def closeFrame (stack : List JsonFrame) : Option (List JsonFrame × Option Json) :=
  match stack with
  | .items list :: rest => placeValue rest (.arr list.toArray)
  | .fields entries none :: rest =>
    placeValue rest (Json.mkObj (entries ++ [("$keys", toJson (entries.map (·.1)).eraseDups)]))
  | _ => none

private def readTokens (tokens : List JsonToken) : Option Json :=
  let step (state : Option (List JsonFrame × Option Json)) (token : JsonToken) :
      Option (List JsonFrame × Option Json) := do
    let (stack, done) ← state
    if done.isSome then none else
    match token, stack with
    | .open_ true, _ => some (.fields [] none :: stack, none)
    | .open_ false, _ => some (.items [] :: stack, none)
    | .close, _ => closeFrame stack
    | .text key, .fields entries none :: rest => some (.fields entries (some key) :: rest, none)
    | .text decoded, _ => placeValue stack (toJson decoded)
    | .literal value, _ => placeValue stack value
  (tokens.foldl step (some ([], none))).bind (·.2)

/-- `JSON.parse`, keeping each object's key order in `$keys` so `Twin.jsonStringify` can restore it.
`Json.parse` decides what is valid: the tokenizer only recovers key order. -/
private def parseOrdered (text : String) : Option Json :=
  match Json.parse text with
  | .error _ => none
  | .ok _ => (tokenize (text.length + 1) text.toList []).bind readTokens

private def completedResponse (call : Json) : Prog Json := do
  let text ← Prog.effect "response.text"
  for line in (str text).splitOn "\n" do
    if !line.startsWith "data:" then continue
    let data := (line.drop 5).toString.trimAscii.toString
    if data.isEmpty || data == "[DONE]" then continue
    match parseOrdered data with
    | none => continue
    | some event =>
      let kind := str (field event "type")
      if kind == "response.completed" || kind == "response.incomplete" then
        if undef (field event "response") then
          return ← Prog.unsupported "Response.json of undefined"
        return jsonBodyResponse (Twin.jsonStringify 64 (field event "response")) 200
      if kind == "response.failed" || kind == "error" then
        let err := field (field event "response") "error"
        let error := if undef err || err == Json.null then field event "error" else err
        -- `{ error: undefined }` stringifies to `{}`.
        return jsonBodyResponse
          (if undef error then "{}" else "{\"error\":" ++ Twin.jsonStringify 64 error ++ "}") 400
  let _ := call
  pure (jsonBodyResponse
    "{\"error\":{\"message\":\"ChatGPT stream ended before response.completed\"}}" 502)

private def splitIngressEvents (call : Json) : Prog Json := do
  let mut ephemeral : List Json := []
  let mut persisted : List Json := []
  for event in arr (Twin.callArg call 0) do
    if field event "role" != toJson "system" then persisted := persisted ++ [event]
    else
      let message ← Prog.effect "systemModelMessageSchema.parse" [event]
      if field event "persist" == toJson false then ephemeral := ephemeral ++ [message]
      else persisted := persisted ++ [message]
  return obj [("ephemeralSystem", toJson ephemeral), ("persisted", toJson persisted)]

private def withUnwrittenRows (args : Json) : Json :=
  let entries := arr (Twin.arg args 0)
  let missing := (arr (Twin.arg args 1)).filter fun row =>
    !entries.any (fun entry => field entry "createdAt" == field row "cursor")
  if missing.isEmpty then toJson entries else
    toJson ((entries ++ missing.map (fun row => obj [("createdAt", field row "cursor"), ("event", field row "event")])).mergeSort
      (fun a b => str (field a "createdAt") < str (field b "createdAt")))

private def normalizeBundlePath (args : Json) : Json :=
  match Twin.arg args 0 with
  | .str value =>
    let trimmed := value.trimAscii.toString
    if trimmed.isEmpty || trimmed.startsWith "/" || contains trimmed "\\" ||
        trimmed.toList.contains '\x00' || (trimmed.splitOn "/").any (fun p => p == ".." || p == "") then
      Twin.threw s!"Invalid skill file path: {value}"
    else toJson trimmed
  | _ => Twin.threw "Skill file path must be a string"

private def startHarnessLeaseMonitor (_ : Json) : Prog Json := do
  let _ ← Prog.effect "setInterval" [fn "", toJson (1000 : Nat)]
  let _ ← Prog.effect "timer.unref"
  pure (fn "stop")

private def formatLoadedSkillPrompt (args : Json) : Json :=
  let loaded := Twin.arg args 0
  let staged := Twin.arg args 1
  let parts := String.intercalate "\n\n" ((arr (field loaded "parts")).map fun part =>
    s!"## {str (field part "path")}\n\n{(str (field part "text")).trimAscii.toString}")
  let mirrors := arr (field staged "mirrorPaths")
  let mirrorText := if mirrors.isEmpty then "" else
    " It is also mirrored at " ++ String.intercalate ", " (mirrors.map fun p => s!"`{str p}`") ++ " for tools that expect those locations."
  let path := str (field staged "stagedPath")
  let sandbox := if truth staged then
    s!"\n\n## Sandbox files\n\nThis skill's helper files are staged in the workspace at `{path}`, relative to the directory `bash` starts in. Run scripts from that path, for example `bash {path}/script.sh`, `python3 {path}/script.py`, or `./{path}/script.sh` when the file has a shebang.{mirrorText}"
    else "\n\n## Sandbox files\n\nThe skill instructions are loaded. No sandbox staging path is available for bundled helper files in this turn, so bundled scripts are not available to execute."
  toJson s!"<loaded-skill path=\"{str (field loaded "path")}\" name=\"{str (field (field loaded "skill") "name")}\">\n{parts}{sandbox}\n</loaded-skill>"

private def openCodeOpenAiVariants (args : Json) : Json :=
  let id := str (Twin.arg args 0)
  let gateway := truth (Twin.arg args 1)
  let suffix := ((id.splitOn "/").findSome? fun p =>
    if p.startsWith "gpt-5" then some ((p.drop 5).toString) else none).getD "!"
  let gpt5 := suffix == "" || suffix.startsWith "." || suffix.startsWith "-"
  let digits := suffix.toList.drop 1 |>.takeWhile Char.isDigit
  let rest := suffix.toList.drop (digits.length + 1) |> String.ofList
  let version := if gpt5 && (rest == "" || rest.startsWith "." || rest.startsWith "-") then
      (String.ofList digits).toNat?.getD 0 else 0
  let codex := gpt5 && contains id "codex"
  let pro := fun s => s == "pro" || s.startsWith "pro-" || s.startsWith "pro."
  let barePro := pro suffix || ((suffix.startsWith "." || suffix.startsWith "-") && pro ((suffix.drop 1).toString))
  let numericPro := !digits.isEmpty && (suffix.startsWith "." || suffix.startsWith "-") &&
    (rest.startsWith "." || rest.startsWith "-") && pro ((rest.drop 1).toString)
  let levels := ["none", "minimal", "low", "medium", "high", "xhigh"]
  toJson (if !gateway && contains id "deep-research" then ["medium"]
    else if gpt5 && contains id "-chat" then if version > 0 then ["medium"] else []
    else if barePro then ["high"]
    else if !codex && numericPro then ["medium", "high", "xhigh"]
    else if gateway && !codex && version == 0 then levels
    else levels.filter fun level =>
      if level == "none" then if codex then version >= 3 else version >= 1
      else if level == "minimal" then version == 0 && !codex && gpt5
      else if level == "xhigh" then version >= 2 || (codex && contains id "codex-max") else true)

private def anthropicVersion (id : String) : Option (Nat × Nat) :=
  ((id.toLower.splitOn "claude-").drop 1).findSome? fun rest =>
    let cs := rest.toList
    let cs := if cs.head?.any Char.isAlpha then
        let tail := cs.dropWhile Char.isAlpha
        if tail.head? == some '-' then tail.drop 1 else []
      else cs
    let digits := cs.takeWhile Char.isDigit
    let tail := cs.drop digits.length
    let minor := if tail.head? == some '.' || tail.head? == some '-' then
        tail.drop 1 |>.takeWhile Char.isDigit |>.take 2 else []
    let tail := if minor.isEmpty then tail else tail.drop (minor.length + 1)
    if !digits.isEmpty && (tail.isEmpty || tail.head?.any (fun c => ['.', '@', '-'].contains c)) then
      some ((String.ofList digits).toNat?.getD 0, (String.ofList minor).toNat?.getD 0)
    else none

private def openCodeAnthropicVariants (args : Json) : Json :=
  let id := str (Twin.arg args 0)
  let gateway := truth (Twin.arg args 1)
  let version := anthropicVersion id
  let modern := version.isNone || version.any (fun v => v.1 > 4 || (v.1 == 4 && v.2 >= 7))
  let middle := ["opus-4.6", "opus-4-6", "sonnet-4.6", "sonnet-4-6",
    "4.6-opus", "4-6-opus", "4.6-sonnet", "4-6-sonnet"].any (contains id)
  let oldOpus := ["opus-4.5", "opus-4-5"].any (contains id)
  toJson (if contains id "claude-" && modern then ["low", "medium", "high", "xhigh"]
    else if middle || (!gateway && oldOpus) then ["low", "medium", "high"] else ["high"])

private def startHarnessSession (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let start := Twin.callArg call 2
  let sandbox ← Prog.effect "openSandbox" [obj [("sessionId", field start "sessionId"),
    ("abortSignal", field options "abortSignal")]]
  let outcome ← Prog.attempt "options.agent.createSession"
    [merge start (obj [("sandboxSession", sandbox), ("abortSignal", field options "abortSignal")])]
  match outcome with
  | .ok native => pure (obj [("nativeSession", native), ("sandboxSession", sandbox)])
  | .threw err _ =>
    let _ ← Prog.attempt "sandboxSession.stop"
    .fail err
  | .pending => Prog.unsupported "session creation pending"

private def timePhase (call : Json) : Prog Json := do
  let started ← Prog.effect "Date.now"
  let value ← Prog.effect "load"
  let finished ← Prog.effect "Date.now"
  match Twin.callArg call 1, started.getInt?, finished.getInt? with
  | .str key, .ok startedAt, .ok finishedAt =>
    Prog.setChanged s!"args.0.{key}" (field (Twin.callArg call 0) key)
      (toJson (finishedAt - startedAt))
  | _, _, _ => Prog.unsupported "a phase key or clock that is not recorded as a whole number"
  pure value

private def applyRunOverrides (args : Json) : Json :=
  let config := Twin.arg args 0
  let overrides := Twin.arg args 1
  let model := field overrides "model"
  if !truth overrides || !truth model || (fields model).isEmpty then config
  else if truth (field config "harness") && !undef (field model "providerOptions") then
    Twin.threw "model.providerOptions is not supported with config.harness; set model.reasoning"
  else merge config (obj [("model", merge (field config "model") model)])

private def agentSystemMessages (args : Json) : Json :=
  let system := Twin.arg args 0
  if system == Json.null || undef system then toJson ([] : List Json) else
  match system with
  | .str _ => toJson [obj [("role", toJson "system"), ("content", system)]]
  | .arr _ => system
  | _ => toJson [system]

private def stripEnvelopeFieldsFromMessages (args : Json) : Json :=
  toJson ((arr (Twin.arg args 0)).map fun message =>
    obj ((fields message).filter fun p => !["metadata", "createdAt", "dedupeKey"].contains p.1))

private def createRuntimeToolApproval (args : Json) : Json :=
  let opts := Twin.arg args 0
  let compatible := !(arr (field (field opts "configuredApprovals") "$map")).isEmpty ||
    (arr (field opts "workspaces")).any (fun w => truth (field w "sandbox")) ||
    !(arr (field opts "sandboxes")).isEmpty
  obj ([("startStep", fn "startStep")] ++
    if compatible || truth (field opts "policyApproval") then [("approval", fn "approval")] else [])

private def stripYamlScalarQuotes (args : Json) : Json :=
  let trimmed := (str (Twin.arg args 0)).trimAscii.toString
  toJson (if (trimmed.startsWith "\"" && trimmed.endsWith "\"") ||
      (trimmed.startsWith "'" && trimmed.endsWith "'") then
    String.ofList (trimmed.toList.drop 1 |>.take (trimmed.length - 2)) else trimmed)

private def isStorableMediaReference : Nat → Json → Bool
  | 0, _ => false
  | fuel + 1, v =>
    if field v "type" == toJson "url" then isStorableMediaReference fuel (field v "url")
    else
      let value := if undef (field v "$url") then str v else str (field v "$url")
      value.toLower.startsWith "http://" || value.toLower.startsWith "https://" || value.startsWith "broods-media:"

private def pureTraced (source : String) (f : Json → Json) : Twin :=
  Twin.traced source (fun call => pure (f (field call "args")))

private def validateSkillName (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let s := str value
  if !(value.getStr?).isOk || s.isEmpty || s.length > 64 ||
      !s.toList.all (fun c => (c >= 'a' && c <= 'z') || c.isDigit || c == '-') ||
      contains s "anthropic" || contains s "claude" then
    return ← Prog.throwError "Error" "Skill name must be lowercase letters, numbers, and hyphens only, max 64 chars, without reserved words"
  pure Twin.undefinedJson

private def validateSkillDescription (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let s := str value
  let hasTag := (s.splitOn "<").drop 1 |>.any (contains · ">")
  if !(value.getStr?).isOk || s.trimAscii.toString.isEmpty || s.length > 1024 || hasTag then
    return ← Prog.throwError "Error" "Skill description must be non-empty, max 1024 chars, and cannot contain XML tags"
  pure Twin.undefinedJson

private def assertSafeGitHubSegment (call : Json) : Prog Json := do
  let s := str (Twin.callArg call 0)
  if s.isEmpty || !s.toList.all (fun c => c.isAlphanum && c.toNat < 128 || ['_', '.', '-'].contains c) then
    return ← Prog.throwError "Error" s!"GitHub {str (Twin.callArg call 1)} contains unsupported characters"
  pure Twin.undefinedJson

private def destroyHarnessSession (_ : Json) : Prog Json := do
  let _ ← Prog.attempt "session.nativeSession.destroy"
  let _ ← Prog.attempt "session.sandboxSession.destroy"
  pure Twin.undefinedJson

private def requireHarnessSandbox (call : Json) : Prog Json := do
  let sandbox := Twin.callArg call 0
  if !truth sandbox then
    return ← Prog.throwError "Error" "config.harness needs a sandbox to run on; list one first in config.sandboxes"
  pure sandbox

private def recoveryFor (call : Json) : Prog Json := do
  let err := Twin.callArg call 0
  let isApi ← Prog.effect "APICallError.isInstance" [err]
  if !truth isApi then return toJson "unavailable"
  let data := field (field err "$error") "fields"
  return toJson (if truth (field data "isRetryable") then "retry"
    else if field data "statusCode" == toJson (400 : Nat) then "unsupported" else "unavailable")

private def appendToLatestUserEvent (args : Json) : Json := Id.run do
  let events := arr (Twin.arg args 0)
  let parts := arr (Twin.arg args 1)
  let mut found := false
  let mut result : List Json := []
  for event in events.reverse do
    if !found && field event "role" == toJson "user" then
      found := true
      let content := field event "content"
      let old := match content with
        | .str s => [obj [("type", toJson "text"), ("text", toJson s)]]
        | _ => arr content
      result := merge event (obj [("content", toJson ((old.filter (fun p => field p "type" != toJson "text" || str (field p "text") != "")) ++ parts))]) :: result
    else result := event :: result
  if !found then result := result ++ [obj [("role", toJson "user"), ("content", toJson parts)]]
  return toJson result

private def toStoredConversationEvent (args : Json) : Json :=
  let message := Twin.arg args 0
  if !truth message then Json.null else
    obj [("version", toJson (1 : Nat)), ("sourceEventId", Twin.arg args 1),
      ("metadata", (arr args).getD 2 Twin.undefinedJson),
      ("model", (arr args).getD 3 Twin.undefinedJson), ("message", message)]

private def skillInstructionsFromMarkdown (args : Json) : Json :=
  let text := str (Twin.arg args 0)
  let lines := text.splitOn "\n"
  let first := lines.headD ""
  let after := if first == "---" || first == "---\r" then
      let tail := lines.drop 1
      let index := tail.findIdx? (fun line => line == "---" || line == "---\r")
      match index with
      | some i => String.intercalate "\n" (tail.drop (i + 1))
      | none => text
    else text
  toJson after.trimAscii.toString

private def extensionEffect (call : Json) : Prog String := do
  let ext ← Prog.effect "path.extname" [Twin.callArg call 0]
  pure (str ext).toLower

private def supportedTextFile (call : Json) : Prog Json := do
  let ext ← extensionEffect call
  if ![".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".py", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"].contains ext then
    return toJson false
  let bytes := Spec.Access.Crypto.base64Decode (str (field (Twin.callArg call 1) "$bytes"))
  return toJson (!bytes.contains 0)

private def hook (label : String) (call : Json) : Prog Json := do
  if truth (Twin.callArg call 0) then Prog.effect label [Twin.callArg call 1]
  else pure (Twin.callArg call 1)

private def formatMemorySystemPrompt (args : Json) : Json :=
  let files := arr (Twin.arg args 0)
  let normalized := fun file =>
    let text := (str (field file "content")).trimAsciiEnd.toString
    if text.isEmpty then "(the index exists but is empty)" else text
  toJson (if files.length == 1 && field (field (files.headD Json.null) "workspace") "name" == toJson "default" then
    "Current memory index (memory/MEMORY.md) for this conversation:\n\n" ++ normalized (files.headD Json.null)
    else "Current workspace memory index (memory/MEMORY.md) content:\n\n" ++
      String.intercalate "\n\n" (files.map fun file => s!"## {str (field (field file "workspace") "name")}\n\n{normalized file}"))

private def extraTwins : List Twin :=
  [Twin.traced "apps/core/src/shared/skills.ts#validateSkillName" validateSkillName,
   Twin.traced "apps/core/src/shared/skills.ts#validateSkillDescription" validateSkillDescription,
   Twin.traced "apps/core/src/shared/skills.ts#assertSafeGitHubSegment" assertSafeGitHubSegment,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#destroyHarnessSession" destroyHarnessSession,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#requireHarnessSandbox" requireHarnessSandbox,
   Twin.traced "apps/core/src/harness/transcribe.ts#recoveryFor" recoveryFor,
   plain "apps/core/src/harness/session.ts#appendToLatestUserEvent" appendToLatestUserEvent,
   pureTraced "apps/core/src/harness/session.ts#toStoredConversationEvent" toStoredConversationEvent,
   plain "apps/core/src/shared/skills.ts#skillInstructionsFromMarkdown" skillInstructionsFromMarkdown,
   plain "apps/core/src/harness/session.ts#formatMemorySystemPrompt" formatMemorySystemPrompt,
   plain "apps/core/src/harness/session.ts#isToolApprovalResponseMessage" (fun args =>
     let m := Twin.arg args 0
     let parts := arr (field m "content")
     toJson (field m "role" == toJson "tool" && !parts.isEmpty && parts.all (fun p => field p "type" == toJson "tool-approval-response"))),
   plain "apps/core/src/harness/session.ts#isPersistedAssistantContentPart" (fun args => toJson
     (["reasoning", "text", "tool-call", "tool-approval-request", "tool-result"].contains (str (field (Twin.arg args 0) "type")))),
   plain "apps/core/src/harness/session.ts#isPersistedToolContentPart" (fun args => toJson
     (["tool-approval-response", "tool-result"].contains (str (field (Twin.arg args 0) "type")))),
   plain "apps/core/src/harness/skills.ts#canonicalStagedPath" (fun args => toJson s!".claude/skills/{str (Twin.arg args 0)}"),
   plain "apps/core/src/harness/skills.ts#mirrorStagedPaths" (fun args => toJson [s!".agents/skills/{str (Twin.arg args 0)}"]),
   plain "apps/core/src/shared/domain/agent-config.ts#configuredMaxTurn" (fun args =>
     let value := field (field (Twin.arg args 0) "agent") "maxTurn"
     if value == toJson (0 : Nat) then toJson (9007199254740991 : Nat) else if undef value then Json.null else value),
   plain "apps/core/src/shared/domain/workspace-config.ts#workspaceGuidanceEnabled" (fun args =>
     toJson (field (field (field (Twin.arg args 0) "harness") "workspace") "enabled" != toJson false)),
   plain "apps/core/src/shared/domain/workspace-config.ts#workspaceMemoryHarnessEnabled" (fun args =>
     toJson (field (field (Twin.arg args 0) "storage") "provider" != toJson "disk" &&
       field (field (field (Twin.arg args 0) "harness") "memory") "enabled" != toJson false)),
   Twin.traced "packages/convex/model/harnessSessionEntries.ts#harnessEntryBytes" (fun c => Prog.effect "getConvexSize" [Twin.callArg c 0]),
   Twin.traced "apps/core/src/harness/tool-execute.ts#runBefore" (hook "before"),
   Twin.traced "apps/core/src/harness/tool-execute.ts#runAfter" (hook "after"),
   Twin.traced "apps/core/src/shared/skills.ts#contentTypeForSkillPath" (fun c => do
     let ext ← extensionEffect c
     pure (toJson (if ext == ".json" then "application/json" else "text/plain; charset=utf-8"))),
   Twin.traced "apps/core/src/shared/skills.ts#isExecutableSkillPath" (fun c => do
     let ext ← extensionEffect c
     pure (toJson ([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".ts"].contains ext))),
   pureTraced "apps/core/src/harness/deadline-policy.ts#createDeadlinePolicy" (fun _ =>
     obj (["shouldStop", "isWindingDown", "hasYielded", "withdrawYield"].map fun s => (s, fn s))),
   pureTraced "apps/core/src/harness/skills.ts#skillReadLimit" (fun _ => fn "")]

private def encodeUriComponent (s : String) : String :=
  String.join (s.toUTF8.toList.map fun b =>
    let c := Char.ofNat b.toNat
    if c.isAlphanum && b.toNat < 128 || ['-', '_', '.', '!', '~', '*', '\'', '(', ')'].contains c then
      String.singleton c
    else
      let hex := "0123456789ABCDEF".toList.toArray
      "%" ++ String.singleton (hex[b.toNat / 16]!) ++ String.singleton (hex[b.toNat % 16]!))

private def createCloudflare (call : Json) : Prog Json := do
  let settings := Twin.callArg call 0
  let gateway := (str (field settings "gatewayId")).trimAscii.toString
  let rest := obj ((fields settings).filter fun p => !["gatewayId", "headers"].contains p.1)
  if gateway == "" then
    let _ ← Prog.effect "createWorkersAI" [rest]
    return fn ""
  let auth := obj [("cf-aig-authorization", toJson s!"Bearer {str (field rest "apiKey")}")]
  let _ ← Prog.effect "createWorkersAI" [merge rest (obj [("gateway", merge (field rest "gateway") (obj [("id", toJson gateway)]))])]
  let path := encodeUriComponent (str (field rest "accountId")) ++ "/" ++ encodeUriComponent gateway
  let _ ← Prog.effect "createOpenAICompatible" [obj [("name", toJson "cloudflare"),
    ("baseURL", toJson s!"https://gateway.ai.cloudflare.com/v1/{path}/compat"),
    ("headers", merge (field settings "headers") auth), ("fetch", field rest "fetch"),
    ("includeUsage", toJson true)]]
  pure (fn "")

private def retryWait (text : String) : Option Nat :=
  ((List.range text.length).map fun i => (text.drop i).toString.toLower).findSome? fun tail =>
    let rest := if tail.startsWith "try again in " then some ((tail.drop 13).toString)
      else if tail.startsWith "\"retrydelay\":" then
        let rest := (tail.drop 13).toString.trimAsciiStart.toString
        if rest.startsWith "\"" then some ((rest.drop 1).toString) else none
      else none
    rest.bind fun rest =>
      let whole := rest.toList.takeWhile Char.isDigit
      let rest := rest.toList.drop whole.length
      let frac := if rest.head? == some '.' then rest.drop 1 |>.takeWhile Char.isDigit else []
      let unit := if frac.isEmpty then rest else rest.drop (frac.length + 1)
      let unit := unit.dropWhile Char.isWhitespace |> String.ofList
      let unitSize := if unit.startsWith "ms" then 2 else if unit.startsWith "s" then 1 else 0
      let boundary := unit.toList[unitSize]?
      if whole.isEmpty || unitSize == 0 || boundary.any (fun c => c.isAlphanum || c == '_') then none
      else
        let scale := 10 ^ frac.length
        let amount := (String.ofList whole).toNat?.getD 0 * scale + (String.ofList frac).toNat?.getD 0
        let multiplier := if unitSize == 1 then 1000 else 1
        some (min 59999 ((amount * multiplier + scale - 1) / scale))

private def withRateLimitRetryHeader (call : Json) : Prog Json := do
  let response := Twin.callArg call 0
  let data := field response "$response"
  let headers := arr (field data "headers")
  if field data "status" != toJson (429 : Nat) ||
      headers.any (fun h => ["retry-after-ms", "retry-after"].contains ((str (Twin.arg h 0)).toLower)) then
    return response
  let body ← Prog.effect "response.text"
  let headers := match retryWait (str body) with
    | none => headers
    | some ms => (headers ++ [toJson [toJson "retry-after-ms", toJson (toString ms)]]).mergeSort
      (fun a b => str (Twin.arg a 0) <= str (Twin.arg b 0))
  pure (obj [("$response", merge data (obj [("headers", toJson headers), ("body", toJson body)]))])

private def discordForwarderToken (call : Json) : Prog Json := do
  let bytes ← Prog.effect "hkdfSync" [toJson "sha256", Twin.callArg call 0, toJson "",
    toJson "broods-discord-forwarder", toJson (32 : Nat)]
  pure (toJson (Spec.Access.Crypto.base64UrlEncode (Spec.Access.Crypto.base64Decode (str (field bytes "$bytes")))))

private def leafTwins : List Twin :=
  [Twin.traced "apps/core/src/harness/provider.ts#createCloudflare" createCloudflare,
   Twin.traced "apps/core/src/harness/provider.ts#withRateLimitRetryHeader" withRateLimitRetryHeader,
   Twin.traced "apps/core/src/shared/skills.ts#isSupportedTextFile" supportedTextFile,
   Twin.traced "apps/core/src/shared/discord-wire.ts#discordForwarderToken" discordForwarderToken,
   plain "apps/core/src/shared/domain/agent-config.ts#resolveSubagentMode" (fun a =>
     toJson (if field (field (Twin.arg a 0) "subagent") "mode" == toJson "ephemeral" then "ephemeral" else "persistent")),
   plain "apps/core/src/shared/media-types.ts#unreadableMediaNote" (fun a =>
     let name := Twin.arg a 0
     let name := if name == Json.null || undef name then "attachment" else str name
     toJson s!"[{name} ({str (Twin.arg a 1)}) was not shown to you: this model does not accept the type. Open it with read if it was saved to a workspace.]")]

private def parseSkillPath (call : Json) : Prog Json := do
  let parts := (str (Twin.callArg call 0)).splitOn "/"
  if parts.length != 2 || parts.any (· == "") then return Json.null
  let name := parts[1]!
  match ← Prog.attempt "validateSkillName" [toJson name] with
  | .ok _ => pure (obj [("accountId", toJson parts[0]!), ("skillName", toJson name)])
  | .threw _ _ => pure Json.null
  | .pending => Prog.unsupported "name validation pending"

private def parseSimpleYamlFrontmatter (call : Json) : Prog Json := do
  let mut output := obj []
  for line in (str (Twin.callArg call 0)).splitOn "\n" do
    let key := line.toList.takeWhile fun c => c.isAlphanum && c.toNat < 128 || ['_', '-'].contains c
    let rest := line.toList.drop key.length
    if key.isEmpty || rest.head? != some ':' then continue
    let text := rest.drop 1 |>.dropWhile Char.isWhitespace |> String.ofList
    let text := text.trimAsciiEnd.toString
    let value ← Prog.effect "stripYamlScalarQuotes" [toJson text]
    output := merge output (obj [(String.ofList key, toJson (str value).trimAscii.toString)])
  pure output

private def sanitizeAssistantMessage (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let original := field message "content"
  if original.getStr?.isOk then return message
  let mut content : List Json := []
  for part in arr original do
    let accepted ← Prog.effect "isPersistedAssistantContentPart" [part]
    if truth accepted && (truth (Twin.callArg call 1) || field part "type" != toJson "reasoning") then
      content := content ++ [part]
  pure (if content.isEmpty then Json.null else merge message (obj [("content", toJson content)]))

private def sanitizeUserMessage (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let original := field message "content"
  if original.getStr?.isOk then return message
  let mut content : List Json := []
  for part in arr original do
    let kind := str (field part "type")
    let accepted ← if kind == "text" then pure (toJson true)
      else if kind == "image" then Prog.effect "isStorableMediaReference" [field part "image"]
      else if kind == "file" then Prog.effect "isStorableMediaReference" [field part "data"]
      else pure (toJson false)
    if truth accepted then content := content ++ [part]
  if !content.isEmpty then return merge message (obj [("content", toJson content)])
  pure (if (arr original).isEmpty then Json.null else merge message (obj [("content", toJson
    [obj [("type", toJson "text"), ("text", toJson "[attachment not retained]")]])]))

private def harnessReservationKey (call : Json) : Prog Json := do
  let opts := Twin.callArg call 0
  let key := field opts "conversationKey"
  let stored := field opts "stored"
  let fallback := fun v => if undef v || v == Json.null then key else v
  if truth stored then return fallback (field stored "reservationKey")
  if truth (field opts "isolated") then return key
  let shared ← Prog.effect "harnessSharesSandbox" [field opts "type"]
  if !truth shared then return key
  pure (fallback (field opts "agentReservationKey"))

private def harnessEntryBatches (call : Json) : Prog Json := do
  let mut batches : List Json := []
  let mut batch : List Json := []
  let mut bytes := 0
  for entry in arr (Twin.callArg call 0) do
    let size ← Prog.effect "harnessEntryBytes" [field entry "entry"]
    let size := size.getNat?.toOption.getD 0
    if batch.length >= 100 || (bytes > 0 && bytes + size > 4 * 1024 * 1024) then
      batches := batches ++ [toJson batch]
      batch := []
      bytes := 0
    batch := batch ++ [entry]
    bytes := bytes + size
  pure (toJson (batches ++ [toJson batch]))

private def openCodeVariants (call : Json) : Prog Json := do
  let provider := str (Twin.callArg call 0)
  let id := (str (Twin.callArg call 1)).toLower
  if ["deepseek-chat", "deepseek-reasoner", "deepseek-r1", "deepseek-v3", "minimax", "kimi", "k2p", "qwen", "big-pickle"].any (contains id) ||
      (contains id "glm" && !["glm-5.2", "glm-5p2", "glm-5-2"].any (contains id)) then
    return toJson ([] : List String)
  if contains id "grok-3-mini" then return toJson ["low", "high"]
  let gateway := provider == "vercel"
  if provider == "anthropic" || (gateway && contains id "anthropic") then
    return ← Prog.effect "openCodeAnthropicVariants" [toJson id, toJson gateway]
  if gateway && contains id "google" then
    let old := ((id.splitOn "gemini-2").drop 1).any fun suffix =>
      [".5", "-5"].any fun prefixText => suffix == prefixText || suffix.startsWith (prefixText ++ ".") || suffix.startsWith (prefixText ++ "-")
    return toJson (if old then ["high"] else ["low", "high"])
  Prog.effect "openCodeOpenAiVariants" [toJson id, toJson gateway]

private def findCompaction (entries : List Json) : Prog Json := do
  for (index, entry) in entries.zipIdx |>.reverse do
    let message := field (field index "event") "message"
    if field message "role" == toJson "system" then
      let found ← Prog.effect "isCompactionSummaryMessage" [message]
      if truth found then return toJson entry
  pure (toJson (-1 : Int))

private def toRuntimeAgentConfig (call : Json) : Prog Json := do
  let keys := ["agent", "harness", "model", "policy", "provider", "sandbox", "sandboxes", "workspaces", "session", "hooks", "tools", "mcp", "denyTools", "skills", "subagent", "scheduler", "browser", "policies", "publicAccess", "allowRunOverrides"]
  let config := Twin.callArg call 0
  let selected := obj (keys.map fun k => (k, field config k))
  Prog.effect "normalizeAgentConfig" [selected, obj [], Json.mkObj [("$opaque", toJson "ZodMiniObject"), ("$fields", obj [("type", toJson "object")])]]

private def steerHarnessTurn (call : Json) : Prog Json := do
  let steering ← Prog.effect "session.applySteeringIngress" [obj [("textOnly", toJson true)]]
  if !truth steering then return Twin.undefinedJson
  let events := field steering "events"
  let mut texts : List String := []
  for event in arr events do
    if field event "role" == toJson "user" then
      let text ← Prog.effect "extractText" [field event "content"]
      let text := (str text).trimAscii.toString
      if text != "" then texts := texts ++ [text]
  let _ ← Prog.effect "session.appendIngressEvents" [events]
  let text := String.intercalate "\n\n" texts
  if text != "" then
    let _ ← Prog.effect "harnessSession .experimental_steerTurn" [toJson text]
  pure Twin.undefinedJson

private def transcribeWithModel (call : Json) : Prog Json := do
  let signal ← Prog.effect "AbortSignal.timeout" [toJson (60000 : Nat)]
  let outcome ← Prog.attempt "transcribe" [obj [("model", Twin.callArg call 0),
    ("audio", Twin.callArg call 1), ("maxRetries", Twin.callArg call 2), ("abortSignal", signal),
    ("telemetry", obj [("functionId", toJson "harness.transcribe"),
      ("recordInputs", toJson false), ("recordOutputs", toJson false)])]]
  match outcome with
  | .ok value =>
    let text := if undef (field value "text") then Twin.field value "text" else field value "text"
    pure (obj [("status", toJson "transcribed"), ("text", toJson (str text).trimAscii.toString)])
  | .threw err _ =>
    let reason ← Prog.effect "toErrorMessage" [err]
    let recovery ← Prog.effect "recoveryFor" [err]
    pure (obj [("status", toJson "failed"), ("reason", reason), ("recovery", recovery)])
  | .pending => Prog.unsupported "transcription pending"

private def callerTwins : List Twin :=
  [Twin.traced "apps/core/src/shared/skills.ts#parseSkillPath" parseSkillPath,
   Twin.traced "apps/core/src/shared/skills.ts#parseSimpleYamlFrontmatter" parseSimpleYamlFrontmatter,
   Twin.traced "apps/core/src/harness/session.ts#sanitizeAssistantMessage" sanitizeAssistantMessage,
   Twin.traced "apps/core/src/harness/session.ts#sanitizeUserMessage" sanitizeUserMessage,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#harnessReservationKey" harnessReservationKey,
   Twin.traced "packages/convex/model/harnessSessionEntries.ts#harnessEntryBatches" harnessEntryBatches,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/opencode.ts#openCodeVariants" openCodeVariants,
   Twin.traced "apps/core/src/harness/session.ts#findLatestCompactionSummaryIndex" (fun c => findCompaction (arr (Twin.callArg c 0))),
   Twin.traced "apps/core/src/shared/domain/agent-config.ts#toRuntimeAgentConfig" toRuntimeAgentConfig,
   Twin.traced "apps/core/src/shared/domain/agent-config.ts#toChannelRuntimeAgentConfig" (fun c => do
     let config := Twin.callArg c 0
     let runtime ← Prog.effect "toRuntimeAgentConfig" [config]
     pure (if truth (field (field config "channels") (str (Twin.callArg c 1))) then
       merge runtime (obj [("channels", field config "channels")]) else runtime)),
   Twin.traced "apps/core/src/shared/skills.ts#formatSkillPath" (fun c => do
     let _ ← Prog.effect "validateSkillName" [Twin.callArg c 1]
     pure (toJson s!"{str (Twin.callArg c 0)}/{str (Twin.callArg c 1)}")),
   Twin.traced "apps/core/src/shared/skills.ts#readSkillText" (fun c => do
     let bucket ← Prog.effect "skillsBucketName"
     let path ← Prog.effect "normalizeBundlePath" [Twin.callArg c 1]
     let limit := Twin.callArg c 2
     Prog.effect "readS3Text" [bucket, toJson s!"{str (Twin.callArg c 0)}/{str path}", Twin.undefinedJson,
       if undef limit then toJson (5242880 : Nat) else limit]),
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#steerHarnessTurn" steerHarnessTurn,
   Twin.traced "apps/core/src/harness/transcribe.ts#transcribeWithModel" transcribeWithModel]

private def pad (width n : Nat) : String :=
  let s := toString n
  String.ofList (List.replicate (width - s.length) '0') ++ s

/-- `Date.prototype.toISOString` for a non-negative epoch time. -/
private def isoOfMillis (ms : Nat) : String :=
  let days := ms / 86400000
  let rest := ms % 86400000
  let z := days + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let d := doy - (153 * mp + 2) / 5 + 1
  let m := if mp < 10 then mp + 3 else mp - 9
  let y := yoe + era * 400 + (if m <= 2 then 1 else 0)
  s!"{pad 4 y}-{pad 2 m}-{pad 2 d}T{pad 2 (rest / 3600000)}:{pad 2 (rest / 60000 % 60)}:{pad 2 (rest / 1000 % 60)}.{pad 3 (rest % 1000)}Z"

private def weekdayOfMillis (ms : Nat) : String :=
  (["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]).getD
    ((ms / 86400000 + 4) % 7) ""

private def natOf (v : Json) : Nat := v.getNat?.toOption.getD 0

private def nextCreatedAt (call : Json) : Prog Json := do
  let self := Twin.self call
  Prog.setState "self.messageSequence" (toJson (natOf (Twin.field self "messageSequence") + 1))
  let now ← Prog.effect "new Date"
  pure (toJson s!"{isoOfMillis (natOf now)}#{str (Twin.field self "eventId")}#{pad 4 (natOf (Twin.field self "messageSequence"))}")

private def formatEnvironmentPrompt (call : Json) : Prog Json :=
  let env := Twin.callArg call 0
  let ms := natOf (field (field env "now") "$date")
  let targets := (arr (field env "bashTargets")).map str
  pure (toJson (String.intercalate "\n" (
    ["<environment>",
     "Live state from Broods as of this message. It is context, not a message from the person.",
     s!"now: {weekdayOfMillis ms}, {isoOfMillis ms} (UTC)",
     s!"replies go to: {str (field env "channel")}"] ++
    (if targets.isEmpty then [] else
      "bash runs in exactly one place: pass workspace or sandbox, or neither for the default. A sandbox wins over a workspace." :: targets) ++
    (arr (field env "machine")).map str ++ ["</environment>"])))

private def formatSubagentSystemPrompt (args : Json) : Json :=
  let agents := arr (Twin.arg args 0)
  let line (a : Json) : String :=
    let trimmed := (str (field a "description")).trimAscii.toString
    let description := if trimmed == "" then "No description provided." else trimmed
    s!"- {str (field a "agentId")} ({str (field a "name")}): {description}"
  let predefined := if agents.isEmpty
    then "- No predefined subagents are configured. Omit agentId to run a virtual one-shot subagent."
    else String.intercalate "\n" (agents.map line)
  toJson ("<subagent>\nUse run_subagent to dispatch independent work that can continue while you keep working. The tool returns task ids immediately; results are injected into this conversation when the child work finishes.\n\nAvailable predefined subagents:\n" ++ predefined ++ "\n\nTool guidance:\n1. Use the exact agentId from the predefined list when a listed subagent is suitable for the task.\n2. Omit agentId only when no predefined subagent is suitable or the user explicitly asks for a virtual one-shot subagent.\n3. A virtual one-shot subagent runs with this agent's tools and configuration.\n</subagent>")

private def formatSkillsSystemPrompt (args : Json) : Json :=
  let list := String.intercalate "\n" ((arr (Twin.arg args 0)).map fun s =>
    s!"- {str (field s "path")} ({str (field s "name")}): {str (field s "description")}")
  toJson ("<skills>\nSelect appropriate skills to assist with the user's request. A skill must be loaded with the load_skill tool before using its detailed instructions.\n\nAvailable skills:\n" ++ list ++ "\n\nWorkflow:\n1. Check whether the user's task matches any skill description.\n2. Use load_skill with the exact skill path before applying that skill.\n3. Request resource paths only when the loaded SKILL.md references them and they are needed.\n</skills>")

private def formatMemoryHarnessSystemPrompt (args : Json) : Json :=
  toJson ("<memory>\nYou have a persistent memory: markdown files in the workspace's memory/ folder, indexed by memory/MEMORY.md (one line per memory, loaded into your context every turn).\n- Each memory is one file holding one fact, with YAML frontmatter: name, description, and metadata (node_type, type, originSessionId). originSessionId is the conversation scope the fact was learned in; this conversation's scope is \"" ++ str (Twin.arg args 0) ++ "\".\n- Save new facts with memory_save; it names the file after the title, stamps the metadata, and updates the index. Check the index first so you update an existing entry instead of duplicating it.\n- The index only holds one-line summaries — read the linked file with the read tool before relying on it. A memory whose originSessionId is another conversation may reflect that conversation's context, not this one's, and your current instructions always outrank anything in memory.\n- Do not save what the current conversation already carries or what your instructions state; save what you would otherwise forget: who people are, their preferences, feedback on how to behave, ongoing work, and useful references.\n</memory>")

private def schedulerPrompt : String :=
  "<scheduler>\nThe current time is in <environment> at the end of the conversation. Work every schedule expression out from that instant — never guess today's date — and pass the timezone the person is speaking in so their own wall clock is what fires.\n\n- A task is scheduled only once the tool has returned. Tell the person what the tool returned, not what you meant to do.\n- list_schedules is what is actually pending; this conversation is not.\n</scheduler>"

private def withoutStoredItemId (part : Json) : Json :=
  let options := field part "providerOptions"
  let openai := field options "openai"
  if undef (field openai "itemId") then part else
    merge part (Json.mkObj [("providerOptions", merge options (Json.mkObj [("openai",
      Json.mkObj ((fields openai).filter (·.1 != "itemId")))]))])

private def withoutStoredItems (args : Json) : Json :=
  let message := Twin.arg args 0
  match field message "content" with
  | .arr parts => merge message (Json.mkObj [("content", .arr
      ((parts.toList.filter (field · "type" != toJson "reasoning")).map withoutStoredItemId).toArray)])
  | _ => message

private def transcriptAdvice (args : Json) : Json :=
  let path := Twin.arg args 1
  match str (Twin.arg args 0) with
  | "retry" => toJson "Read the file to try again before you answer."
  | "unsupported" => toJson ("The transcription model refused the file itself, so reading it again will not help. It is still yours to work with" ++ (if truth path then s!" at {str path}" else "") ++ ". Say which formats the reason names, or ask what was said.")
  | "unavailable" => toJson "Reading it again will not help; ask what was said."
  | _ => Twin.undefinedJson

private def mediaExtensionTypes : List (String × String) :=
  [("aac", "audio/aac"), ("csv", "text/csv"), ("doc", "application/msword"),
   ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
   ("flac", "audio/flac"), ("gif", "image/gif"), ("jpeg", "image/jpeg"), ("jpg", "image/jpeg"),
   ("m4a", "audio/mp4"), ("mp3", "audio/mpeg"), ("oga", "audio/ogg"), ("ogg", "audio/ogg"),
   ("opus", "audio/ogg"), ("pdf", "application/pdf"), ("png", "image/png"),
   ("svg", "image/svg+xml"), ("txt", "text/plain"), ("wav", "audio/wav"), ("webp", "image/webp"),
   ("xls", "application/vnd.ms-excel"),
   ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")]

private def contentTypeForPath (args : Json) : Json :=
  let extension := (((str (Twin.arg args 0)).splitOn ".").getLast?.getD "").toLower
  toJson ((mediaExtensionTypes.lookup extension).getD "application/octet-stream")

/-- ASCII punctuation and digits in the order ICU's root collation ranks them, below every letter. -/
private def icuSymbolOrder : List Char := " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789".toList

/-- The primary weight of an ASCII character under ICU root collation, letters ignoring case. -/
private def icuPrimary (c : Char) : Option Nat :=
  if c.isAlpha && c.toNat < 128 then some (icuSymbolOrder.length + c.toLower.toNat - 97)
  else (icuSymbolOrder.idxOf? c)

/-- `a.localeCompare(b)` on ASCII text: primary weights first, then lowercase before uppercase. -/
private def localeCompareAscii (a b : String) : Json :=
  let weights := fun (text : String) => text.toList.map icuPrimary
  let rec go : List Nat → List Nat → Int
    | [], [] => 0
    | [], _ => -1
    | _, [] => 1
    | x :: xs, y :: ys => if x < y then -1 else if y < x then 1 else go xs ys
  if (weights a ++ weights b).any Option.isNone then
    Twin.unsupported "localeCompare on characters outside ASCII collation"
  else
    let primary := go ((weights a).filterMap id) ((weights b).filterMap id)
    if primary != 0 then toJson primary
    else
      match (a.toList.zip b.toList).find? fun (x, y) => x != y with
      | some (x, _) => toJson (if x.isLower then (-1 : Int) else 1)
      | none => toJson (0 : Int)

/-- `compareSkillBundlePath`: `SKILL.md` first, then `localeCompare`. -/
private def compareSkillBundlePath (args : Json) : Json :=
  let a := str (Twin.arg args 0)
  let b := str (Twin.arg args 1)
  if a == "SKILL.md" then (if b == "SKILL.md" then toJson (0 : Nat) else toJson (-1 : Int))
  else if b == "SKILL.md" then toJson (1 : Nat)
  else localeCompareAscii a b

private def closures (names : List String) : Json :=
  Json.mkObj (names.map fun name => (name, fn name))

/-- The `findLast` in `trackSystemCursor`: enters the predicate from the end until a system entry. -/
private def findLastSystem : List Json → Prog Unit
  | [] => pure ()
  | entry :: earlier =>
    .input fun
      | none => Prog.throwError "Error" "findLast predicate was not entered"
      | some _ =>
        if field (field (field entry "event") "message") "role" == toJson "system" then pure ()
        else findLastSystem earlier

private def trackSystemCursor (call : Json) : Prog Json := do
  let events := (arr (Twin.callArg call 0)).reverse
  findLastSystem events
  match events.find? (fun entry => field (field (field entry "event") "message") "role" == toJson "system") with
  | some entry =>
    let cursor := field entry "cursor"
    let old := Twin.field (Twin.self call) "lastSystemCursor"
    if !undef cursor && (old == Json.null || str old < str cursor) then
      Prog.setState "self.lastSystemCursor" cursor
  | none => pure ()
  pure Twin.undefinedJson

private def claim (call : Json) : Prog Json := do
  let self := Twin.self call
  let account := Twin.field self "accountId"
  if !truth account then
    Prog.throwError "Error" "Account ID is required for runtime claims"
  Prog.effect "runtime.mutate" [toJson "claimEvent",
    obj [("accountId", account), ("key", Twin.field self "eventId"), ("ttlSeconds", toJson (86400 : Nat))]]

private def transcribeAudio (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let model ← Prog.effect "resolveTranscriptionModel" [config]
  if !truth model then
    let provider := field (field config "model") "provider"
    let name := if provider == Json.null || undef provider then "this provider" else str provider
    return obj [("status", toJson "failed"), ("reason", toJson s!"{name} has no transcription model"),
      ("recovery", toJson "unavailable")]
  Prog.effect "transcribeWithModel" [model, Twin.callArg call 1, Twin.callArg call 2]

private def createModelOutput (call : Json) : Prog Json := do
  let output := Twin.callArg call 0
  let optional (name : String) : List (String × Json) :=
    if truth (field output name) then [(name, field output name)] else []
  let named := optional "name" ++ optional "description"
  match str (field output "type") with
  | "object" =>
    let schema ← Prog.effect "jsonSchema" [field output "schema"]
    Prog.effect "Output.object" [obj (("schema", schema) :: named)]
  | "array" =>
    let element ← Prog.effect "jsonSchema" [field output "element"]
    Prog.effect "Output.array" [obj (("element", element) :: named)]
  | "choice" => Prog.effect "Output.choice" [obj (("options", field output "options") :: named)]
  | "json" => Prog.effect "Output.json" [obj named]
  | _ => pure Twin.undefinedJson

private def isRefusedRequest (call : Json) : Prog Json := do
  let error := Twin.callArg call 0
  let known ← Prog.effect "APICallError.isInstance" [error]
  let details := field error "$error"
  if !truth known || field (field details "fields") "statusCode" != toJson (400 : Nat) then
    return toJson false
  let tooLong ← Prog.effect "isContextLengthError" [field details "message"]
  pure (toJson (!truth tooLong))

private def batch1Twins : List Twin :=
  let session := "apps/core/src/harness/session.ts#"
  let metering := "apps/core/src/harness/usage-metering.ts#"
  [Twin.traced (session ++ "Session.nextCreatedAt") nextCreatedAt,
   Twin.traced (session ++ "formatEnvironmentPrompt") formatEnvironmentPrompt,
   plain (session ++ "formatSubagentSystemPrompt") formatSubagentSystemPrompt,
   plain (session ++ "formatSkillsSystemPrompt") formatSkillsSystemPrompt,
   plain (session ++ "formatMemoryHarnessSystemPrompt") formatMemoryHarnessSystemPrompt,
   plain (session ++ "formatSchedulerSystemPrompt") (fun _ => toJson schedulerPrompt),
   plain (session ++ "withoutStoredItems") withoutStoredItems,
   plain "apps/core/src/harness/transcribe.ts#transcriptAdvice" transcriptAdvice,
   plain "apps/core/src/shared/media-types.ts#contentTypeForPath" contentTypeForPath,
   plain "apps/core/src/harness/skills.ts#compareSkillBundlePath" compareSkillBundlePath,
   pureTraced (metering ++ "createTaskTotals") (fun _ =>
     closures ["addStep", "addCompaction", "finish", "steps", "usage", "cacheWriteTokens"]),
   pureTraced (metering ++ "createStepTimingTracker") (fun _ =>
     closures ["startStep", "activeStep", "endActiveStep", "stepStartMs", "recordChunk",
       "recordAttempt", "attemptAttributes", "closeStep", "clear"]),
   pureTraced (metering ++ "createSandboxCpuLedger") (fun _ =>
     closures ["record", "takeToolCompute", "roleAttributes", "typeAttributes", "usage"]),
   Twin.traced (session ++ "Session.trackSystemCursor") trackSystemCursor,
   Twin.traced (session ++ "Session.claim") claim,
   Twin.traced "apps/core/src/harness/transcribe.ts#transcribeAudio" transcribeAudio,
   Twin.traced "apps/core/src/harness/provider.ts#createModelOutput" createModelOutput,
   Twin.traced "apps/core/src/harness/provider.ts#isRefusedRequest" isRefusedRequest,
   Twin.traced "apps/core/src/shared/skills.ts#skillsBucketName" (fun _ =>
     Prog.effect "requireEnv" [toJson "SKILLS_BUCKET_NAME"])]

private def isFn (v : Json) : Bool := !undef (field v "$fn")
private def nullish (v : Json) : Bool := undef v || v == Json.null
private def dropChars (s : String) (n : Nat) : String := String.ofList (s.toList.drop n)
private def jsTrim (s : String) : String := s.trimAscii.toString

private def withoutUnresolvedToolCalls (call : Json) : Prog Json := do
  let messages := arr (Twin.callArg call 0)
  let last := messages.getLast?.getD Twin.undefinedJson
  let isResponse ← Prog.effect "isToolApprovalResponseMessage" [last]
  let pending : List Json := if truth isResponse then
      (arr (field last "content")).filterMap fun p =>
        if field p "type" == toJson "tool-approval-response" then some (field p "approvalId") else none
    else []
  let parts (m : Json) : List Json := arr (field m "content")
  let resolved := messages.flatMap fun m => (parts m).filterMap fun p =>
    let kind := field p "type"
    if kind == toJson "tool-result" ||
        (kind == toJson "tool-approval-request" && pending.contains (field p "approvalId"))
    then some (field p "toolCallId") else none
  let mut out : List Json := []
  for m in messages do
    if field m "role" != toJson "assistant" || (field m "content").getStr?.toOption.isSome then
      out := out ++ [m]
    else
      let kept := (parts m).filter fun p =>
        let kind := field p "type"
        (kind != toJson "tool-call" && kind != toJson "tool-approval-request") ||
        (kind == toJson "tool-call" && field p "providerExecuted" == toJson true) ||
        resolved.contains (field p "toolCallId")
      if kept.length == (parts m).length then
        out := out ++ [m]
      else
        let repaired ← Prog.effect "withoutStoredItems"
          [merge m (Json.mkObj [("content", .arr kept.toArray)])]
        if !(arr (field repaired "content")).isEmpty then out := out ++ [repaired]
  pure (.arr out.toArray)

/-- `new URL` for the plain `scheme://host/path` shape. Anything else is not modelled. -/
private def parsePlainUrl (value : String) : Option (String × String × String) :=
  match value.splitOn "://" with
  | [scheme, rest] =>
    match rest.splitOn "/" with
    | host :: segments =>
      if contains rest "?" || contains rest "#" || contains host "@" || contains host ":" then none
      else some (scheme.toLower ++ ":", host.toLower, String.intercalate "/" segments)
    | [] => none
  | _ => none

private def parseGitHubSkillUrl (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let text := jsTrim (str value)
  if value.getStr?.toOption.isNone || text == "" then
    Prog.throwError "Error" "url must be a non-empty string"
  let some (protocol, host, path) := parsePlainUrl text
    | Prog.unsupported "URL outside the scheme://host/path shape"
  if protocol != "https:" || host != "github.com" then
    Prog.throwError "Error" "GitHub skill URL must use https://github.com"
  if contains text.toLower "%2e" || contains text ".." then
    Prog.throwError "Error" "Invalid skill file path: GitHub URL must not contain path traversal"
  match (path.splitOn "/").filter (· != "") with
  | owner :: repo :: "tree" :: ref :: subdirParts =>
    let _ ← Prog.effect "assertSafeGitHubSegment" [toJson owner, toJson "owner"]
    let _ ← Prog.effect "assertSafeGitHubSegment" [toJson repo, toJson "repo"]
    let _ ← Prog.effect "assertSafeGitHubSegment" [toJson ref, toJson "ref"]
    let mut parts : List String := []
    for part in subdirParts do
      let normal ← Prog.effect "normalizeBundlePath" [toJson part]
      parts := parts ++ [str normal]
    pure (obj [("owner", toJson owner), ("repo", toJson repo), ("ref", toJson ref),
      ("subdir", toJson (String.intercalate "/" parts)),
      ("archiveUrl", toJson s!"https://codeload.github.com/{owner}/{repo}/tar.gz/{encodeUriComponent ref}")])
  | _ =>
    Prog.throwError "Error" "GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}"

private def formatWorkspaceHarnessSystemPrompt (call : Json) : Prog Json := do
  let workspaces := arr (Twin.callArg call 0)
  let memoryTool := truth (Twin.callArg call 1)
  let writable (w : Json) : Bool := !nullish (field w "sandbox")
  let hasWritable := workspaces.any writable
  let hasReadOnly := workspaces.any (!writable ·)
  let line (index : Nat) (w : Json) : String :=
    let description := field w "description"
    "- " ++ str (field w "name") ++ (if index == 0 then " (default)" else "") ++
      (if writable w then "" else " [read-only: read, glob]") ++ ": " ++ str (field w "namespace") ++
      (if truth description then " - " ++ str description else "")
  let list := String.intercalate "\n" (workspaces.zipIdx.map fun (w, i) => line i w)
  let tools :=
    if hasWritable && hasReadOnly then
      "Use the file tools (read, glob) on all workspaces; write, edit, grep, and bash are available only on writable workspaces."
    else if hasWritable then
      "Use the file tools (read, write, edit, glob, grep) and bash to work with the mounted filesystem; bash starts in the current workspace directory."
    else
      "Use the file tools (read, glob) to read the mounted filesystem. These workspaces are read-only, attempt to modify will get error."
  let mut indexEnabled := false
  for w in workspaces do
    if !indexEnabled then
      let enabled ← Prog.effect "workspaceMemoryHarnessEnabled" [field w "config"]
      indexEnabled := truth enabled
  let memory :=
    if memoryTool then "3. Durable memory is managed through the memory_save tool and the memory/MEMORY.md index — see <memory>."
    else if indexEnabled then "3. Keep durable project facts, decisions, conventions, and context that should survive long-running work as markdown files under memory/, indexed in memory/MEMORY.md."
    else "3. Structured memory is disabled for this agent — do not create memory files unless explicitly asked."
  let guidance :=
    if hasWritable then
      "1. Use read/write/edit to inspect and change files, glob/grep to find files and content, and bash to run commands and programs (python3, node, and the usual tools are on PATH).\n2. When more than one workspace is configured, pass the workspace field to select one; omitted means the default workspace.\n" ++ memory ++ "\n4. Use TASKS.md or focused task markdown files for plans and progress tracking when that helps the work stay aligned.\n5. Treat memory and task files as normal workspace files: read them before relying on them, update them when useful, and keep them concise."
    else
      "1. Use read to inspect files and glob to find files by pattern.\n2. When more than one workspace is configured, pass the workspace field to select one; omitted means the default workspace."
  pure (toJson ("<workspace>\nA persistent workspace is attached. " ++ tools ++ "\n\nConfigured workspaces:\n" ++ list ++ "\n\nGuidance:\n" ++ guidance ++ "\n</workspace>"))

/-- A recorded `URL` serialises as its string under `JSON.stringify`. -/
private def urlsAsText : Nat → Json → Json
  | 0, value => value
  | fuel + 1, .arr items => .arr (items.map (urlsAsText fuel))
  | fuel + 1, .obj fields =>
    match fields.toList with
    | [("$url", .str href)] => .str href
    | entries => Json.mkObj (entries.map fun entry => (entry.1, urlsAsText fuel entry.2))
  | _, value => value

private def storableToolResultOutput (call : Json) : Prog Json := do
  let output := Twin.callArg call 0
  let limit := Twin.callArg call 1
  let kind := field output "type"
  if kind == toJson "execution-denied" then return output
  let mut stored := output
  if kind == toJson "content" then
    let mut kept : List Json := []
    for part in arr (field output "value") do
      let partKind := str (field part "type")
      let keep ←
        if partKind == "file-data" || partKind == "image-data" then pure false
        else if partKind == "file" then
          let data := field part "data"
          if field data "type" == toJson "url" then
            pure (truth (← Prog.effect "isStorableMediaReference" [data]))
          else pure (field data "type" != toJson "data")
        else if partKind == "file-url" || partKind == "image-url" then
          pure (truth (← Prog.effect "isStorableMediaReference" [field part "url"]))
        else pure true
      if keep then kept := kept ++ [part]
    let value := if kept.isEmpty
      then [obj [("type", toJson "text"), ("text", toJson "[attachment not retained]"),
        ("$keys", toJson ["type", "text"])]]
      else kept
    stored := merge output (Json.mkObj [("value", .arr value.toArray)])
  let value := field stored "value"
  let serialized := match value with
    | .str text => text
    | _ => Twin.jsonStringify 64 (urlsAsText 64 value)
  let text ← Prog.effect "truncateText" [toJson serialized, limit]
  if !truth (field text "truncated") then return stored
  pure (obj [("type", toJson (if kind == toJson "error-text" || kind == toJson "error-json" then "error-text" else "text")),
    ("value", field text "value")])

private def policyActions : List String :=
  ["agent.invoke", "tool.call", "workspace.read", "workspace.write", "workspace.exec", "subagent.run", "skill.load"]

private def unresolvedPolicy : Json :=
  obj [("version", toJson (1 : Nat)), ("mode", toJson "enforce"), ("rules", toJson [
    obj [("id", toJson "unresolved-policy"), ("effect", toJson "deny"), ("actions", toJson policyActions)]])]

private def loadPolicyDocuments (call : Json) : Prog Json := do
  let requested := (arr (Twin.callArg call 1)).foldl
    (fun seen id => if seen.contains id then seen else seen ++ [id]) []
  match requested with
  | [] => pure (.arr #[])
  | [policyId] =>
    let _ ← Prog.effect "getStorage"
    let record ← Prog.effect "getStorage().agentPolicies.getById" [Twin.callArg call 0, policyId]
    let document := field record "document"
    pure (toJson [if nullish document then unresolvedPolicy else document])
  | _ => Prog.unsupported "several policies load concurrently and no recording has them"

private def assertCurrentOwner (call : Json) : Prog Json := do
  let self := Twin.self call
  let generation := Twin.field self "ownerGeneration"
  if undef generation then return Twin.undefinedJson
  let started ← Prog.effect "performance.now"
  let current ← Prog.effect "runtime.query" [toJson "isCurrentIngressOwner",
    obj [("conversationKey", Twin.field self "conversationKey"),
      ("ownerEventId", Twin.field self "eventId"), ("ownerGeneration", generation)]]
  if !truth current then Prog.throwError "Error" "Stale conversation owner generation"
  let _ ← Prog.effect "this.confirmOwner" [started]
  pure Twin.undefinedJson

private def appendConversationEvents (call : Json) : Prog Json := do
  let self := Twin.self call
  let events := Twin.callArg call 0
  let key := Twin.field self "conversationKey"
  let generation := Twin.field self "ownerGeneration"
  if undef generation then
    let _ ← Prog.effect "runtime.mutate" [toJson "appendConversationEvent",
      obj [("conversationKey", key), ("events", events)]]
    return Twin.undefinedJson
  let started ← Prog.effect "performance.now"
  let _ ← Prog.effect "runtime.mutate" [toJson "appendFencedConversationEvent",
    obj [("conversationKey", key), ("ownerEventId", Twin.field self "eventId"),
      ("ownerGeneration", generation), ("events", events)]]
  let _ ← Prog.effect "this.confirmOwner" [started]
  pure Twin.undefinedJson

/-- Normalizes each staged object in turn. The first stale one is deleted without waiting, so the
callbacks after it, and their deletes, overlap that delete and start in one group. -/
private def deleteStaleFrom (bucket access : Json) (prefixText : String) (keep : List Json) :
    List Json → Prog Unit
  | [] => pure ()
  | object :: rest => do
    let key := str (field object "key")
    let relative ← Prog.effect "normalizeBundlePath" [toJson (dropChars key prefixText.length)]
    if keep.contains relative then deleteStaleFrom bucket access prefixText keep rest
    else
      let later := rest.map fun next =>
        let nextKey := str (field next "key")
        let nextRelative := normalizeBundlePath (.arr #[toJson (dropChars nextKey prefixText.length)])
        (nextKey, nextRelative)
      if later.any fun (_, relative) => relative.getStr?.toOption.isNone then
        Prog.unsupported "a staged path that fails to normalize inside concurrent callbacks"
      else
        let calls : List (String × List Json) :=
          [("deleteS3Object", [bucket, toJson key, access])] ++ later.flatMap fun (nextKey, nextRelative) =>
            [("normalizeBundlePath", [toJson (dropChars nextKey prefixText.length)])] ++
              (if keep.contains nextRelative then []
               else [("deleteS3Object", [bucket, toJson nextKey, access])])
        let outcomes ← Prog.all calls
        for outcome in outcomes do
          match outcome with
          | .threw error _ => Prog.fail error
          | _ => pure ()

private def deleteStaleStagedSkillFiles (call : Json) : Prog Json := do
  let target := Twin.callArg call 0
  let bucket := field target "bucket"
  let access := field target "access"
  let prefixText := str (Twin.callArg call 1)
  let keep := arr (field (Twin.callArg call 2) "$set")
  let objects ← Prog.effect "listS3Prefix" [bucket, toJson prefixText, access]
  deleteStaleFrom bucket access prefixText keep ((arr objects).filter fun o => !(str (field o "key")).endsWith "/")
  pure Twin.undefinedJson

/-- Whether `a` sorts before `b`: the sort's comparator, which only its sign matters to. -/
private def bundleLess (a b : Json) : Prog Bool := do
  let order ← Prog.effect "compareSkillBundlePath" [field a "path", field b "path"]
  return match order.getInt? with | .ok n => decide (n < 0) | _ => false

/-- Binary search for where `pivot` goes among the first `right` sorted entries. -/
private def bundleInsertAt (files : List Json) (pivot : Json) (left right fuel : Nat) : Prog Nat :=
  match fuel with
  | 0 => pure left
  | fuel + 1 =>
    if left >= right then pure left
    else do
      let middle := left + (right - left) / 2
      let less ← bundleLess pivot files[middle]!
      if less then bundleInsertAt files pivot left middle fuel
      else bundleInsertAt files pivot (middle + 1) right fuel

/-- Binary insertion sort from `start` on, the order Bun's engine compares in. -/
private def bundleInsertionSort (files : List Json) (start fuel : Nat) : Prog (List Json) :=
  match fuel with
  | 0 => pure files
  | fuel + 1 =>
    if start >= files.length then pure files
    else do
      let pivot := files[start]!
      let position ← bundleInsertAt files pivot 0 start files.length
      let moved := files.take position ++ pivot :: (files.drop position).take (start - position)
        ++ files.drop (start + 1)
      bundleInsertionSort moved (start + 1) fuel

/-- `files.sort(compareSkillBundlePath)`. Recordings show binary insertion from the second entry
for up to three entries; a longer sort's comparison order was not observed. -/
private def sortBundleFiles (files : List Json) : Prog (List Json) := do
  if files.length > 3 then Prog.unsupported "the comparison order of a sort over three entries"
  bundleInsertionSort files 1 files.length

private def listSkillSourceFiles (call : Json) : Prog Json := do
  let sourcePrefix := str (Twin.callArg call 0) ++ "/"
  let bucket ← Prog.effect "skillsBucketName"
  let objects ← Prog.effect "listS3Prefix" [bucket, toJson sourcePrefix]
  let mut files : List Json := []
  for object in arr objects do
    let key := str (field object "key")
    if !key.endsWith "/" then
      let path ← Prog.effect "normalizeBundlePath" [toJson (dropChars key sourcePrefix.length)]
      let size := field object "size"
      files := files ++ [obj [("key", toJson key), ("path", path),
        ("size", if nullish size then toJson (5242880 : Nat) else size)]]
  return .arr (← sortBundleFiles files).toArray

private def parkAiSdkHarnessSession (call : Json) : Prog Json := do
  let opts := Twin.callArg call 0
  let native := field opts "nativeSession"
  let kind := field opts "type"
  let detach ←
    if truth (field opts "successful") then
      pure ((← Prog.effect "harnessSessionParking" [kind]) == toJson "detach")
    else pure false
  let resumeState ←
    if detach then
      match ← Prog.attempt "nativeSession .detach" with
      | .ok value => pure value
      | .threw error _ =>
        let _ ← Prog.effect "destroyHarnessSession" [opts]
        (.fail error : Prog Json)
      | .pending => Prog.unsupported "detach never settled"
    else
      let stopped ← Prog.attempt "nativeSession .stop"
      match ← Prog.attempt "sandboxSession.stop" with
      | .threw error true => (.fail error : Prog Unit)
      | _ => pure ()
      match stopped with
      | .ok value => pure value
      | .threw error _ => (.fail error : Prog Json)
      | .pending => Prog.unsupported "stop never settled"
  let _ ← Prog.effect "options.broodsSession.saveHarnessSession"
    [obj [("harnessType", kind), ("sessionId", field native "sessionId"),
      ("resumeState", resumeState), ("reservationKey", field opts "reservationKey")]]
  pure Twin.undefinedJson

private def withToolImagesMoved (call : Json) : Prog Json := do
  let params := Twin.callArg call 1
  let refused ← Prog.effect "isRefusedRequest" [Twin.callArg call 0]
  if !truth refused then return Twin.undefinedJson
  let prompt ← Prog.effect "toolImagesAsUserMessages" [field params "prompt"]
  if (arr prompt).length == (arr (field params "prompt")).length then return Twin.undefinedJson
  pure (merge params (Json.mkObj [("prompt", prompt)]))

private def requireSecretsEnv (call : Json) : Prog Json := do
  let name := str (Twin.callArg call 0)
  let raw ← Prog.effect "requireEnv" [toJson name]
  let unique := (((str raw).splitOn ",").map jsTrim |>.filter (· != "")).foldl
    (fun seen v => if seen.contains v then seen else seen ++ [v]) []
  if unique.isEmpty then
    Prog.throwError "Error" s!"Missing required environment variable: {name}"
  pure (toJson unique)

private def withoutUserMedia (call : Json) : Prog Json := do
  let params := Twin.callArg call 0
  let mut prompt : List Json := []
  for message in arr (field params "prompt") do
    if field message "role" != toJson "user" then
      prompt := prompt ++ [message]
    else
      let mut content : List Json := []
      for part in arr (field message "content") do
        if truth (← Prog.effect "drop" [part]) then
          let note ← Prog.effect "unreadableMediaNote" [field part "filename", field part "mediaType"]
          content := content ++ [obj [("type", toJson "text"), ("text", note)]]
        else
          content := content ++ [part]
      prompt := prompt ++ [merge message (Json.mkObj [("content", .arr content.toArray)])]
  pure (merge params (Json.mkObj [("prompt", .arr prompt.toArray)]))

/-- `.replace(/[^A-Za-z0-9]+/g, "_")`. -/
private def underscoreRuns (text : String) : String :=
  let keep (c : Char) : Bool := c.isAlphanum && c.toNat < 128
  let step (acc : List Char) (c : Char) : List Char :=
    if keep c then c :: acc
    else match acc with
      | '_' :: _ => acc
      | _ => '_' :: acc
  String.ofList (text.toList.foldl step []).reverse

private def resolvePrefixedAuthEnv (call : Json) : Prog Json := do
  let name := str (Twin.callArg call 0)
  let provider := Twin.callArg call 1
  let base ← Prog.effect "resolveHarnessProviderBaseUrl" [provider]
  let label := field provider "name"
  let prefix_ := if name == "custom"
    then (underscoreRuns (if nullish label then "custom" else str label)).toUpper
    else name.toUpper
  pure (obj ([(prefix_ ++ "_API_KEY", field provider "apiKey")] ++
    (if truth base then [(prefix_ ++ "_BASE_URL", base)] else [])))

private def isMemoryToolEnabled (_call : Json) : Prog Json := do
  let workspaces ← Prog.effect "this.resolvedWorkspaces"
  for workspace in arr workspaces do
    if truth (field workspace "sandbox") then
      if truth (← Prog.effect "workspaceMemoryHarnessEnabled" [field workspace "config"]) then
        return toJson true
  pure (toJson false)

private def policyClient (_call : Json) : Prog Json := do
  let token ← Prog.effect "optionalEnv" [toJson "OPA_API_TOKEN"]
  let url ← Prog.effect "optionalEnv" [toJson "OPA_BASE_URL"]
  let client ← Prog.effect "httpPolicyClient" [obj ([("url", if nullish url then toJson "http://127.0.0.1:8181" else url)] ++
    (if truth token then [("headers", obj [("authorization", toJson s!"Bearer {str token}")])] else []))]
  Prog.effect "withEvaluationDeadline" [client, toJson (3000 : Nat)]

private def moveRefusedToolImagesMiddleware (_call : Json) : Prog Json := do
  let retrying ← Prog.effect "retryingMiddleware" [fn "withToolImagesMoved", fn ""]
  pure (merge retrying (Json.mkObj [("transformParams", fn "transformParams")]))

private def resolveChatGPTModel (call : Json) : Prog Json := do
  let wrapped ← Prog.effect "withModelFetch" [Json.mkObj []]
  let fetchFn ← Prog.effect "chatgptFetch" [Twin.callArg call 1, field wrapped "fetch"]
  let provider ← Prog.effect "createOpenAI"
    [obj [("apiKey", toJson "chatgpt-connection"), ("fetch", fetchFn)]]
  let base ← Prog.effect "provider" [Twin.callArg call 0]
  let model ← Prog.effect "wrapLanguageModel" [obj [("model", base), ("middleware", toJson [
    closures ["wrapGenerate", "wrapStream"], closures ["transformParams"]])]]
  pure (obj [("providerName", toJson "chatgpt"), ("provider", provider), ("model", model)])

private def channelPartitionOf (call : Json) : Prog Json := do
  let channel := field (field (Twin.callArg call 0) "channels") (str (Twin.callArg call 1))
  let parsed ← Prog.effect "parseOr"
    [Json.mkObj [("$opaque", toJson "ZodMiniObject"), ("$fields", obj [("type", toJson "object")])], channel]
  pure (field parsed "partition")

private def wrapToolExecute (call : Json) : Prog Json := do
  match fields (Twin.callArg call 0) with
  | [] => pure (Json.mkObj [])
  | [(name, tool)] =>
    if !isFn (field tool "execute") then return Json.mkObj [(name, tool)]
    let _ ← Prog.effect "hooks" [toJson name]
    let _ ← Prog.effect "isStreamingExecute" [field tool "execute"]
    pure (Json.mkObj [(name, merge tool (Json.mkObj [("execute", fn "")]))])
  | _ => Prog.unsupported "several tools: the recording keeps insertion order, Json does not"

private def serializeToolCalls (call : Json) : Prog Json := do
  let tools := Twin.callArg call 0
  let name := str (Twin.callArg call 1)
  let tool := field tools name
  let unchanged := obj [("tools", tools), ("reserve", fn "reserve")]
  if !isFn (field tool "execute") then return unchanged
  if truth (← Prog.effect "isStreamingExecute" [field tool "execute"]) then return unchanged
  pure (obj [("tools", merge tools (Json.mkObj [(name,
    merge tool (Json.mkObj [("execute", fn "execute")]))])), ("reserve", fn "reserve")])

private def batch2Twins : List Twin :=
  let session := "apps/core/src/harness/session.ts#"
  let provider := "apps/core/src/harness/provider.ts#"
  let pi := "apps/core/src/harness/ai-sdk-harness/adapters/pi.ts#"
  let tool := "apps/core/src/harness/tool-execute.ts#"
  [pureTraced "apps/core/src/harness/policy.ts#withEvaluationDeadline" (fun _ => closures ["evaluate"]),
   pureTraced (provider ++ "attemptRecordingMiddleware") (fun _ => closures ["wrapStream"]),
   pureTraced (provider ++ "retryingMiddleware") (fun _ => closures ["wrapGenerate", "wrapStream"]),
   pureTraced (pi ++ "createPiSessionStorage") (fun _ => closures ["append", "appendMany", "read"]),
   pureTraced "apps/core/src/harness/chatgpt.ts#chatgptFetch" (fun _ => fn "request"),
   Twin.traced (pi ++ "trimMediaPart") (fun c => do
     let part := Twin.callArg c 0
     if field part "type" == toJson "image" then
       return obj [("type", toJson "text"), ("text", toJson "[attachment not retained]")]
     let text ← Prog.effect "trim" [field part "text"]
     pure (merge part (Json.mkObj [("text", text)]))),
   Twin.traced (pi ++ "trim") (fun c => do
     let result ← Prog.effect "truncateText" [Twin.callArg c 0, toJson (32768 : Nat)]
     pure (field result "value")),
   Twin.traced (session ++ "withoutUnresolvedToolCalls") withoutUnresolvedToolCalls,
   Twin.traced "apps/core/src/shared/skills.ts#parseGitHubSkillUrl" parseGitHubSkillUrl,
   Twin.traced (session ++ "formatWorkspaceHarnessSystemPrompt") formatWorkspaceHarnessSystemPrompt,
   Twin.traced (session ++ "storableToolResultOutput") storableToolResultOutput,
   Twin.traced "apps/core/src/harness/policy.ts#loadPolicyDocuments" loadPolicyDocuments,
   Twin.traced (session ++ "Session.assertCurrentOwner") assertCurrentOwner,
   Twin.traced (session ++ "Session.appendConversationEvents") appendConversationEvents,
   Twin.traced "apps/core/src/harness/skills.ts#deleteStaleStagedSkillFiles" deleteStaleStagedSkillFiles,
   Twin.traced "apps/core/src/harness/skills.ts#listSkillSourceFiles" listSkillSourceFiles,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#parkAiSdkHarnessSession" parkAiSdkHarnessSession,
   Twin.traced (provider ++ "withToolImagesMoved") withToolImagesMoved,
   Twin.traced "apps/core/src/shared/env.ts#requireSecretsEnv" requireSecretsEnv,
   Twin.traced (provider ++ "withoutUserMedia") withoutUserMedia,
   Twin.traced (pi ++ "resolvePrefixedAuthEnv") resolvePrefixedAuthEnv,
   Twin.traced (session ++ "Session.isMemoryToolEnabled") isMemoryToolEnabled,
   Twin.traced "apps/core/src/harness/policy.ts#policyClient" policyClient,
   Twin.traced (provider ++ "moveRefusedToolImagesMiddleware") moveRefusedToolImagesMiddleware,
   Twin.traced (provider ++ "resolveChatGPTModel") resolveChatGPTModel,
   Twin.traced "apps/core/src/shared/domain/agent-config.ts#channelPartitionOf" channelPartitionOf,
   Twin.traced (tool ++ "wrapToolExecute") wrapToolExecute,
   Twin.traced (tool ++ "serializeToolCalls") serializeToolCalls]

private def openCodeLevels : List String := ["none", "minimal", "low", "medium", "high", "xhigh"]

private def levelIndex (level : String) : Nat := openCodeLevels.idxOf level

private def openCodeVariant (call : Json) : Prog Json := do
  let model := Twin.callArg call 0
  let reasoning := field model "reasoning"
  if !truth reasoning || reasoning == toJson "provider-default" then return Twin.undefinedJson
  let modelId := field model "modelId"
  let variants := (arr (← Prog.effect "openCodeVariants"
    [field model "provider", if nullish modelId then toJson "" else modelId])).map str
  if reasoning == toJson "none" then
    return if variants.contains "none" then toJson "none" else Twin.undefinedJson
  let rank := levelIndex (if reasoning == toJson "max" then "xhigh" else str reasoning)
  let distance (level : String) : Nat :=
    let index := levelIndex level
    if index >= rank then index - rank else rank - index
  let best := variants.foldl (fun (best : Option String) variant =>
    if variant != "none" && (best.isNone || distance variant <= distance (best.getD "")) then some variant
    else best) none
  pure (match best with | some level => toJson level | none => Twin.undefinedJson)

private def openAiSdkHarnessSession (call : Json) : Prog Json := do
  let opts := Twin.callArg call 0
  let stored := field opts "stored"
  let kind := field opts "type"
  let hasStored := truth stored
  if hasStored && field stored "harnessType" != kind then
    Prog.throwError "Error" s!"Conversation is already bound to the {str (field stored "harnessType")} harness; clear it before switching to {str kind}"
  let sandbox := field opts "sandbox"
  let create := field sandbox "createSession"
  let fresh : Prog Json := do
    let id ← Prog.effect "crypto.randomUUID"
    Prog.effect "startHarnessSession" [opts, create, obj [("sessionId", id)]]
  if !hasStored then
    return ← fresh
  let resume := field sandbox "resumeSession"
  if !truth resume then
    return ← Prog.unsupported "HarnessCapabilityUnsupportedError has no recording"
  let resumed := obj [("sessionId", field stored "sessionId"), ("resumeFrom", field stored "resumeState")]
  match ← Prog.attempt "startHarnessSession" [opts, resume, resumed] with
  | .ok value => pure value
  | .pending => Prog.unsupported "resume never settled"
  | .threw error _ =>
    if !truth (← Prog.effect "isSandboxGoneError" [error]) then
      return ← (.fail error : Prog Json)
    if kind == toJson "pi" then
      Prog.effect "startHarnessSession" [opts, create, resumed]
    else
      fresh

private def evaluateChannelInvoke (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let input := Twin.callArg call 1
  let enabled ← Prog.effect "isPolicyEnabled" [config]
  if !truth enabled || !truth (field input "accountId") then return Twin.undefinedJson
  let failure (mode : Json) : Json :=
    obj [("allowed", toJson (mode == toJson "audit")),
      ("mode", if undef mode then toJson "enforce" else mode),
      ("reason", toJson "Policy evaluation failed"),
      ("matchedRuleIds", .arr #[]), ("auditedRuleIds", .arr #[])]
  let configured := field config "policies"
  match ← Prog.attempt "loadPolicyDocuments"
      [field input "accountId", if nullish configured then .arr #[] else configured] with
  | .threw _ _ => pure (failure Twin.undefinedJson)
  | .pending => Prog.unsupported "policy load never settled"
  | .ok policies =>
    match ← Prog.attempt "enforcingMode" [policies] with
    | .threw _ _ => pure (failure Twin.undefinedJson)
    | .pending => Prog.unsupported "enforcingMode never settled"
    | .ok mode =>
      Prog.catchFail
        (do
          let _ ← Prog.effect "policyClient"
          let decision ← Prog.effect "policyClient().evaluate" [toJson "broods/authz/decision",
            merge input (Json.mkObj [("action", toJson "agent.invoke"), ("policies", policies)])]
          let reason := field decision "reason"
          let matched := field decision "matchedRuleIds"
          let audited := field decision "auditedRuleIds"
          pure (obj [
            ("allowed", toJson (if truth decision then field decision "allowed" == toJson true
              else mode == toJson "audit")),
            ("mode", mode),
            ("reason", if nullish reason then toJson "No allow policy rule matched" else reason),
            ("matchedRuleIds", if nullish matched then .arr #[] else matched),
            ("auditedRuleIds", if nullish audited then .arr #[] else audited)]))
        (fun _ => pure (failure mode))

/-- Whether the text after a closing `---` ends the fence: `\r?\n` or the end of input. -/
private def fenceCloses : List Char → Bool
  | [] | '\n' :: _ | '\r' :: '\n' :: _ => true
  | _ => false

/-- The lazy `([\s\S]*?)\r?\n---(?:\r?\n|$)` scan: everything before the first closing fence. -/
private def captureFrontmatter : List Char → List Char → Option (List Char)
  | [], _ => none
  | c :: rest, seen =>
    let after := match c :: rest with
      | '\n' :: '-' :: '-' :: '-' :: tail => some tail
      | '\r' :: '\n' :: '-' :: '-' :: '-' :: tail => some tail
      | _ => none
    match after with
    | some tail => if fenceCloses tail then some seen.reverse else captureFrontmatter rest (c :: seen)
    | none => captureFrontmatter rest (c :: seen)

private def openingFence : List Char → Option (List Char)
  | '-' :: '-' :: '-' :: '\n' :: rest => some rest
  | '-' :: '-' :: '-' :: '\r' :: '\n' :: rest => some rest
  | _ => none

private def parseSkillMarkdown (call : Json) : Prog Json := do
  let chars := (str (Twin.callArg call 0)).toList
  let captured := (openingFence chars).bind (captureFrontmatter · [])
  match captured with
  | none | some [] => Prog.throwError "Error" "SKILL.md must start with YAML frontmatter"
  | some body =>
    let frontmatter ← Prog.effect "parseSimpleYamlFrontmatter" [toJson (String.ofList body)]
    let name := field frontmatter "name"
    let description := field frontmatter "description"
    let _ ← Prog.effect "validateSkillName" [name]
    let _ ← Prog.effect "validateSkillDescription" [description]
    pure (obj [("name", name), ("description", description)])

private def appendStoredEvents (call : Json) : Prog Json := do
  let events := Twin.callArg call 0
  let onSaved := Twin.callArg call 1
  if (arr events).isEmpty then return Twin.undefinedJson
  let batches ← Prog.effect "storedEventBatches" [events]
  let mut saved : Nat := 0
  for batch in arr batches do
    let _ ← Prog.effect "this.appendConversationEvents" [batch]
    saved := saved + (arr batch).length
    if isFn onSaved then
      let _ ← Prog.effect "onSaved" [toJson saved]
  let _ ← Prog.effect "this.trackSystemCursor" [events]
  pure Twin.undefinedJson

private def settleIngress (call : Json) : Prog Json := do
  let self := Twin.self call
  let generation := Twin.field self "ownerGeneration"
  if undef generation then return toJson false
  let settle (rows : Json) : Prog Unit := do
    let started ← Prog.effect "performance.now"
    let extra := if (arr rows).isEmpty then [] else [("events", rows)]
    match ← Prog.attempt "settleIngress" [merge (obj ([("conversationKey", Twin.field self "conversationKey"),
        ("ownerEventId", Twin.field self "eventId"), ("ownerGeneration", generation),
        ("status", Twin.callArg call 0)] ++ fields (Twin.callArg call 1))) (Json.mkObj extra)] with
    | .ok _ =>
      let _ ← Prog.effect "this.confirmOwner" [started]
    | _ => pure ()
  let inline : Json ← .input fun
    | none => pure (.arr #[])
    | some (_, args) => do
      let rows := Twin.arg args 0
      settle rows
      pure rows
  let fenced ← Prog.attempt "this.writeFenced" [.arr #[], fn "settle"]
  match fenced with
  | .ok _ => pure (toJson true)
  | .pending => Prog.unsupported "writeFenced never settled"
  | .threw error _ =>
    if (arr inline).isEmpty then (.fail error : Prog Json)
    else Prog.unsupported "the retry after a failed fenced write is not modelled"

private def batch3Twins : List Twin :=
  [Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/opencode.ts#openCodeVariant" openCodeVariant,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#openAiSdkHarnessSession" openAiSdkHarnessSession,
   Twin.traced "apps/core/src/harness/policy.ts#evaluateChannelInvoke" evaluateChannelInvoke,
   Twin.traced "apps/core/src/shared/skills.ts#parseSkillMarkdown" parseSkillMarkdown,
   Twin.traced "apps/core/src/harness/session.ts#Session.appendStoredEvents" appendStoredEvents,
   Twin.traced "apps/core/src/harness/session.ts#Session.settleIngress" settleIngress]

private def projectSystemContextMessages (call : Json) : Prog Json := do
  let entries := Twin.callArg call 0
  let latest ← Prog.effect "findLatestCompactionSummaryIndex" [entries]
  let latestIndex : Option Nat := latest.getNat?.toOption
  let mut out : List Json := []
  for (entry, index) in (arr entries).zipIdx do
    let message := field (field entry "event") "message"
    if field message "role" == toJson "system" then
      let isSummary ← Prog.effect "isCompactionSummaryMessage" [message]
      let keep := if truth isSummary then latestIndex == some index
        else match latestIndex with
          | none => true
          | some at_ => index > at_
      if keep then out := out ++ [message]
  pure (.arr out.toArray)

private def projectEntriesToMessages (call : Json) : Prog Json := do
  let model := Twin.callArg call 1
  let mut messages : List Json := []
  for entry in arr (Twin.callArg call 0) do
    let event := field entry "event"
    let message := field event "message"
    match str (field message "role") with
    | "system" => pure ()
    | "user" =>
      messages := messages ++ [merge message (obj [("metadata", field event "metadata"),
        ("createdAt", field entry "createdAt")])]
    | "assistant" =>
      if field event "model" == model then
        messages := messages ++ [message]
      else
        let stripped ← Prog.effect "withoutStoredItems" [message]
        messages := messages ++ [stripped]
    | "tool" => messages := messages ++ [message]
    | role => Prog.throwError "Error" s!"Unsupported conversation message role: {role}"
  Prog.effect "withoutUnresolvedToolCalls" [.arr messages.toArray]

private def sanitizeToolMessage (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let parts := (arr (field message "content")).filter fun p =>
    field p "type" == toJson "tool-approval-response" || field p "type" == toJson "tool-result"
  let results := (parts.filter (field · "type" == toJson "tool-result")).length
  let limit := (768 * 1024) / max results 1
  let mut content : List Json := []
  for part in parts do
    if field part "type" == toJson "tool-result" then
      let output ← Prog.effect "storableToolResultOutput" [field part "output", toJson limit]
      content := content ++ [merge part (Json.mkObj [("output", output)])]
    else
      content := content ++ [part]
  pure (if content.isEmpty then Json.null
    else merge message (Json.mkObj [("content", .arr content.toArray)]))

private def parseOwnedSkillPath (call : Json) : Prog Json := do
  let path := Twin.callArg call 1
  let parsed ← Prog.effect "parseSkillPath" [path]
  if !truth parsed then Prog.throwError "Error" s!"Invalid skill path: {str path}"
  if field parsed "accountId" != Twin.callArg call 0 then
    let error ← Prog.effect "new SkillAuthorizationError" [path]
    return ← (.fail error : Prog Json)
  pure parsed

private def createConfiguredPiAdapter (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let session := Twin.callArg call 1
  let name ← Prog.effect "requireHarnessProviderName" [config]
  let provider ← Prog.effect "requireHarnessProviderSettings" [config, name]
  let reasoning := str (field (field config "model") "reasoning")
  let level :=
    if reasoning == "none" then "off"
    else if ["minimal", "low", "medium", "high", "xhigh"].contains reasoning then reasoning
    else "medium"
  let auth ←
    if name == toJson "vercel" then Prog.effect "resolveGatewayAuthEnv" [provider]
    else Prog.effect "resolvePrefixedAuthEnv" [name, provider]
  let storage ←
    if truth session then
      pure [("sessionStorage", ← Prog.effect "createPiSessionStorage" [session])]
    else pure []
  Prog.effect "createPi" [obj ([("auth", auth), ("thinkingLevel", toJson level)] ++ storage)]

private def batch4Twins : List Twin :=
  let session := "apps/core/src/harness/session.ts#"
  [Twin.traced (session ++ "projectSystemContextMessages") projectSystemContextMessages,
   Twin.traced (session ++ "projectEntriesToMessages") projectEntriesToMessages,
   Twin.traced (session ++ "sanitizeToolMessage") sanitizeToolMessage,
   Twin.traced "apps/core/src/shared/skills.ts#parseOwnedSkillPath" parseOwnedSkillPath,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/pi.ts#createConfiguredPiAdapter" createConfiguredPiAdapter]

def twins : List Twin :=
  batch4Twins ++ batch3Twins ++ batch2Twins ++ batch1Twins ++ extraTwins ++ leafTwins ++ callerTwins ++ [Twin.traced "apps/core/src/harness/policy.ts#compatibilityApprovalStatus" compatibilityApprovalStatus,
   Twin.traced "apps/core/src/harness/session.ts#Session.loadConversationEntries" loadConversationEntries,
   plain "apps/core/src/harness/session.ts#storedEventBatches" storedEventBatches,
   Twin.traced "apps/core/src/harness/chatgpt.ts#completedResponse" completedResponse,
   Twin.traced "apps/core/src/harness/session.ts#splitIngressEvents" splitIngressEvents,
   Twin.traced "apps/core/src/harness/session.ts#withUnwrittenRows"
     (fun call => pure (withUnwrittenRows (call.getObjValD "args"))),
   Twin.traced "apps/core/src/harness/session.ts#Session.readHarnessSessionEntries" (fun c => readHarnessPages c 256 Twin.undefinedJson []),
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#startHarnessLeaseMonitor" startHarnessLeaseMonitor,
   plain "apps/core/src/harness/skills.ts#formatLoadedSkillPrompt" formatLoadedSkillPrompt,
   { source := "apps/core/src/shared/skills.ts#normalizeBundlePath", run := normalizeBundlePath },
   plain "apps/core/src/harness/ai-sdk-harness/adapters/opencode.ts#openCodeOpenAiVariants" openCodeOpenAiVariants,
   plain "apps/core/src/harness/ai-sdk-harness/adapters/opencode.ts#openCodeAnthropicVariants" openCodeAnthropicVariants,
   pureTraced "apps/core/src/harness/policy.ts#createRuntimeToolApproval" createRuntimeToolApproval,
   plain "apps/core/src/harness/session.ts#stripEnvelopeFieldsFromMessages" stripEnvelopeFieldsFromMessages,
   plain "apps/core/src/harness/session.ts#agentSystemMessages" agentSystemMessages,
   Twin.traced "apps/core/src/harness/ai-sdk-harness/session.ts#startHarnessSession" startHarnessSession,
   { source := "apps/core/src/shared/domain/agent-config.ts#applyRunOverrides", run := applyRunOverrides },
   Twin.traced "apps/core/src/harness/session.ts#timePhase" timePhase,
   pureTraced "apps/core/src/harness/provider.ts#withModelFetch" (fun args => merge (Twin.arg args 0) (obj [("fetch", fn "modelFetch")])),
   plain "apps/core/src/shared/domain/agent-config.ts#isChannelTraceEnabled" (fun args =>
     let name := str (Twin.arg args 1)
     toJson (name != "" && field (field (field (Twin.arg args 0) "channels") name) "trace" == toJson "enabled")),
   plain "apps/core/src/shared/paths.ts#stripTrailingSlashes" (fun args =>
     toJson (String.ofList ((str (Twin.arg args 0)).toList.reverse.dropWhile (· == '/') |>.reverse))),
   plain "apps/core/src/shared/skills.ts#stripYamlScalarQuotes" stripYamlScalarQuotes,
   plain "apps/core/src/harness/session.ts#isStorableMediaReference" (fun args => toJson (isStorableMediaReference 64 (Twin.arg args 0)))]

end Spec.Agent.Waveagent1
