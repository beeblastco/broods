import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign4/agent4a.tsv`.
-/

namespace Spec.Agent.Waveagent4a

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def str (value : String) : Json := toJson value

private def text (value : Json) : String :=
  (value.getStr?).toOption.getD ""

private def isString (value : Json) : Bool :=
  (value.getStr?).toOption.isSome

private def items (value : Json) : List Json :=
  (value.getArr?.toOption.getD #[]).toList

private def isArray (value : Json) : Bool :=
  (value.getArr?).toOption.isSome

private def arr (values : List Json) : Json := .arr values.toArray

private def fnRef (name : String) : Json := Json.mkObj [("$fn", str name)]

private def truthy : Json → Bool
  | .null => false
  | .bool value => value
  | .num value => value.mantissa != 0
  | .str value => value != ""
  | other => !isUndef other

private def isObject (value : Json) : Bool :=
  match value with
  | .obj _ => !isUndef value
  | _ => false

/-- `Object.keys`, in the recorded order when the recorder kept one. -/
private def keysOf (value : Json) : List String :=
  match value.getObjVal? "$keys", value with
  | .ok (.arr keys), _ => keys.toList.filterMap fun key => (key.getStr?).toOption
  | _, .obj entries => entries.keys.filter (· != "$keys")
  | _, _ => []

private def setKey (value : Json) (key : String) (next : Json) : Json :=
  value.setObjVal! key next

/-- `??`: the fallback when the value is null or undefined. -/
private def orElse (value fallback : Json) : Json :=
  if isUndef value || value == Json.null then fallback else value

private def classError (cls message : String) (name : String := "Error") : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("$class", str cls), ("name", str name), ("message", str message),
     ("fields", Json.mkObj [])])]

private def throwClass {α : Type} (cls message : String) : Prog α :=
  .fail (classError cls message)

/-- Whether the recorder saw a value `JSON.stringify` cannot render as data. -/
private def hasMarker : Nat → Json → Bool
  | 0, _ => true
  | fuel + 1, value =>
    match value with
    | .arr values => values.toList.any (hasMarker fuel)
    | .obj entries =>
      entries.keys.any (fun key => key == "$ref" || key == "$undefined" || key == "$fn") ||
        (entries.keys.filter (· != "$keys")).any fun key =>
          hasMarker fuel (field value key)
    | _ => false

private def stringify (value : Json) : String := Twin.jsonStringify 128 value

/-- UTF-16 length, as `String.length` in JavaScript counts. -/
private def jsLength (value : String) : Nat :=
  value.toList.foldl (fun total char => total + if char.toNat > 0xFFFF then 2 else 1) 0

private def replaceAll (value secret : String) : String :=
  "[redacted]".intercalate (value.splitOn secret)

private def lowerContains (value needle : String) : Bool :=
  (value.toLower.splitOn needle).length > 1

private def containsText (value needle : String) : Bool :=
  (value.splitOn needle).length > 1

/-- Text one of the credential regexes in `log.ts` could match: the twin does not model them. -/
private def mayMatchCredential (value : String) : Bool :=
  lowerContains value "bearer" || lowerContains value "basic" ||
    ["access_token=", "api_key=", "apikey=", "key=", "secret=", "token="].any
      (lowerContains value) ||
    ["sk_", "ask_", "pdk_", "cli_", "code_", "sts_", "dts_", "rt_"].any
      (fun tag => containsText value ("b" ++ tag)) ||
    ["gho_", "ghp_", "ghr_", "ghs_", "ghu_", "github_pat_", "sk-", "AKIA", "ASIA", "xox", "xapp-",
     "AIza", "ya29.", "eyJ"].any (containsText value)

/-- `requireEnv` -/
def requireEnv (call : Json) : Prog Json := do
  let name := Twin.callArg call 0
  let value := Twin.env call (text name)
  if !truthy value then
    throwClass "Error" s!"Missing required environment variable: {text name}"
  return value

/-- `isSensitiveEnvName` -/
def isSensitiveEnvName (call : Json) : Prog Json := do
  let name := text (Twin.callArg call 0)
  let normalized := String.ofList (name.toLower.toList.filter fun char =>
    ('a' ≤ char && char ≤ 'z') || ('0' ≤ char && char ≤ '9'))
  let secret ← Prog.effect "isSecretName" [str name]
  return toJson (truthy secret ||
    containsText normalized "credential" ||
    containsText normalized "authorization" ||
    normalized.endsWith "headers" ||
    normalized.endsWith "providerconfigjson" ||
    normalized.endsWith "toolsjson")

private def dedupe (values : List String) : List String :=
  (values.foldl (fun seen value => if seen.contains value then seen else seen ++ [value]) [])

/-- `matchableSecrets`: stable, longest first. -/
def matchableSecrets (call : Json) : Prog Json := do
  let secrets := (items (Twin.callArg call 0)).map text
  let unique := dedupe (secrets.filter fun secret => jsLength secret >= 4)
  let sorted := unique.toArray.insertionSort fun a b => jsLength a > jsLength b
  return toJson sorted.toList

/-- `replaceSecretValues` -/
def replaceSecretValues (call : Json) : Prog Json := do
  let secrets := (items (Twin.callArg call 1)).map text
  if secrets.any (· == "") then
    return ← Prog.unsupported "splitting on an empty secret"
  let replaced := secrets.foldl replaceAll (text (Twin.callArg call 0))
  if ["sk_", "ask_", "pdk_", "cli_", "code_", "sts_", "dts_", "rt_"].any
      (fun tag => containsText replaced ("b" ++ tag)) then
    return ← Prog.unsupported "text a broods credential pattern could match"
  return str replaced

/-- `scrubSecrets` -/
def scrubSecrets (call : Json) : Prog Json := do
  let value ← Prog.effect "replaceSecretValues" [Twin.callArg call 0, Twin.callArg call 1]
  if mayMatchCredential (text value) then
    return ← Prog.unsupported "text a credential pattern could match"
  return value

/-- `redactValue` -/
def redactValue (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let secrets := Twin.callArg call 1
  if isString value then
    return ← Prog.effect "scrubSecrets" [value, secrets]
  if value == Json.null || isUndef value || !(isObject value || isArray value) then
    return value
  if isArray value then
    let mut out : List Json := []
    for item in items value do
      out := out ++ [← Prog.effect "redactValue" [item, secrets]]
    return arr out
  let mut out : Json := Json.mkObj []
  for key in keysOf value do
    let secret ← Prog.effect "isSecretName" [str key]
    let next ←
      if truthy secret then pure (str "[redacted]")
      else Prog.effect "redactValue" [field value key, secrets]
    out := setKey out key next
  return out

/-- `redactString` -/
def redactString (call : Json) : Prog Json := do
  let secrets ← Prog.effect "matchableSecrets" [Twin.callArg call 1]
  Prog.effect "scrubSecrets" [Twin.callArg call 0, secrets]

/-- `redact` -/
def redact (call : Json) : Prog Json := do
  let secrets ← Prog.effect "matchableSecrets" [Twin.param call 1]
  Prog.effect "redactValue" [Twin.callArg call 0, secrets]

/-- `logError` -/
def logError (call : Json) : Prog Json := do
  let _ ← Prog.effect "emit" [str "ERROR", Twin.callArg call 0, Twin.callArg call 1]
  return undef

/-- `toolContextForPolicy` -/
def toolContextForPolicy (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let sanitized ← Prog.effect "sanitizePolicyToolInput" [input]
  if !truthy sanitized then
    return Json.mkObj []
  let keys := ((keysOf sanitized).toArray.qsort (· < ·)).toList
  let preview ← Prog.effect "formatPolicyInputPreview" [sanitized]
  -- The recorder drops a key whose value is undefined, yet the preview still names it.
  if containsText (text preview) "=undefined" then
    return ← Prog.unsupported "a key with an undefined value is not in the recording"
  return Json.mkObj [("input", sanitized), ("inputKeys", toJson keys), ("inputPreview", preview)]

/-- The recorder leaves out a key whose value is undefined. -/
private def present (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

private def mapGet (value : Json) (key : Json) : Json :=
  match (items (field value "$map")).find? (fun pair => Twin.arg pair 0 == key) with
  | some pair => Twin.arg pair 1
  | none => undef

/-- `policyInputForTool` -/
def policyInputForTool (call : Json) : Prog Json := do
  let toolName := Twin.callArg call 0
  let input := Twin.callArg call 1
  let workspaces := Twin.callArg call 2
  let options := Twin.param call 3
  let record := if truthy input && (isObject input || isArray input) then input else Json.mkObj []
  let sandboxTarget ← Prog.effect "bashSandboxTarget" [field record "sandbox"]
  let workspaceField := field record "workspace"
  let workspaceTarget := if isString workspaceField then workspaceField else undef
  let isBash := toolName == str "bash"
  let onAgentSandbox ←
    if isBash then
      Prog.effect "targetsAgentSandbox"
        [present [("workspaces", workspaces), ("sandboxes", field options "sandboxes")],
         present [("workspace", workspaceTarget), ("sandbox", sandboxTarget)]]
    else pure (toJson false)
  let workspace ←
    if truthy onAgentSandbox then pure undef
    else Prog.effect "resolveWorkspaceForPolicy" [workspaces, workspaceTarget]
  let sandboxes := items (field options "sandboxes")
  let picked : Json :=
    if !truthy onAgentSandbox then undef
    else if isUndef sandboxTarget then (sandboxes.head?).getD undef
    else (sandboxes.find? (fun entry => field entry "name" == sandboxTarget)).getD undef
  let searches := toolName == str "grep" || toolName == str "glob"
  let rawPath := field record (if searches then "path" else "file_path")
  let filePath ←
    if isString rawPath then Prog.effect "policyFilePath" [rawPath, toJson searches]
    else pure (if searches then str "" else undef)
  let tool ← Prog.effect "toolContextForPolicy" [input]
  let mcpId := mapGet (field options "mcpIdsByName") toolName
  let pickedMode := field (field picked "sandbox") "permissionMode"
  let base : List (String × Json) :=
    [("toolName", toolName)] ++
    (if truthy mcpId then [("mcpId", mcpId)] else []) ++
    [("tool", tool)] ++
    (if truthy workspace then
      [("workspaceId", field workspace "workspaceId"), ("workspaceName", field workspace "name"),
       ("sandboxPermissionMode", field (field workspace "sandbox") "permissionMode")]
     else []) ++
    (if truthy pickedMode then [("sandboxPermissionMode", pickedMode)] else []) ++
    (if !isUndef filePath then [("filePath", filePath)] else []) ++
    (if searches then [("searchRoot", toJson true)] else [])
  let build := fun (action : String) (extra : List (String × Json)) =>
    present ([("action", str action)] ++
      (base.filter fun entry => !(extra.any (·.1 == entry.1))) ++ extra)
  let name := text toolName
  if name == "read" || name == "glob" || name == "grep" then
    return build "workspace.read" []
  if name == "write" || name == "edit" then
    return build "workspace.write" []
  if name == "memory_save" then
    let title := field record "title"
    let slug ← Prog.effect "memorySlug" [if isString title then title else str ""]
    return build "workspace.write" [("filePath", str s!"memory/{text slug}.md")]
  if name == "bash" then
    return build "workspace.exec" []
  if name == "load_skill" then
    let skillPath := field record "path"
    return build "skill.load"
      (if isString skillPath && truthy skillPath then [("skillPath", skillPath)] else [])
  if name == "run_subagent" then
    let found := (items (field record "tasks")).find? fun task => isString (field task "agentId")
    let subagentId := (found.map (field · "agentId")).getD undef
    return build "subagent.run" (if truthy subagentId then [("subagentId", subagentId)] else [])
  return build "tool.call" []

private def skillFile : String := "SKILL.md"

/-- `normalizeBundlePath`, which `loadSkillContent` passes by reference so it records no effect. -/
private def normalizeBundlePath (value : Json) : Prog Json := do
  let raw := text value
  let trimmed := raw.trimAscii.toString
  if trimmed == "" || trimmed.startsWith "/" || containsText trimmed "\\" ||
      containsText trimmed "\x00" ||
      (trimmed.splitOn "/").any (fun part => part == ".." || part == "") then
    throwClass "Error" s!"Invalid skill file path: {raw}"
  return str trimmed

private def attemptUnit (fn : String) (args : List Json := []) : Prog Unit := do
  let _ ← Prog.attempt fn args

private def valueOf : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "a pending effect"

/-- `loadSkillContent` -/
def loadSkillContent (call : Json) : Prog Json := do
  let skillPath := Twin.callArg call 0
  let parsed ← Prog.effect "parseSkillPath" [skillPath]
  if !truthy parsed then
    throwClass "Error" s!"Invalid skill path: {text skillPath}"
  let skillText ← Prog.effect "readSkillText" [skillPath, str skillFile]
  let skill ← Prog.effect "parseSkillMarkdown" [skillText]
  let mut paths : List Json := []
  for resource in items (Twin.param call 1) do
    let normalized ← normalizeBundlePath resource
    if !paths.contains normalized && normalized != str skillFile then
      paths := paths ++ [normalized]
  let _ ← Prog.effect "skillReadLimit"
  for path in paths do
    Prog.drain (fun _ _ => attemptUnit "readSkillText" [skillPath, path]) 1
  let outcomes ← Prog.all (paths.map fun _ => ("limit", [fnRef ""]))
  let mut resources : List Json := []
  for (path, outcome) in paths.zip outcomes do
    let body ← valueOf outcome
    resources := resources ++ [Json.mkObj [("path", path), ("text", body)]]
  let instructions ← Prog.effect "skillInstructionsFromMarkdown" [skillText]
  let parts := Json.mkObj [("path", str skillFile), ("text", instructions)] :: resources
  let bytes := parts.foldl (fun total part => total + (text (field part "text")).utf8ByteSize) 0
  return Json.mkObj
    [("path", skillPath),
     ("skill", setKey skill "path" skillPath),
     ("parts", arr parts),
     ("bytes", toJson bytes)]

/-- The read one skill's `limit` slot runs: bucket name, then the capped read of its head. -/
private def readSkillHead (path : Json) : Prog Outcome := do
  Prog.drain (fun _ _ => pure ()) 1
  let bucket ← Prog.effect "skillsBucketName"
  Prog.attempt "readS3TextHead"
    [bucket, str s!"{text path}/{skillFile}", toJson (65536 : Nat)]

/-- `listSkillMetadataForConfig`. Each skill's `readSkillOrSkip` starts on the same tick as the next
skill's `limit`, and the `.then`s that parse the heads overlap the last skill's read. -/
def listSkillMetadataForConfig (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let _ ← Prog.effect "skillReadLimit"
  let paths := items (← Prog.effect "ownedSkillPaths" [accountId, Twin.param call 1])
  let promise := Json.mkObj [("$opaque", str "Promise"), ("$fields", Json.mkObj [])]
  let readOf := fun (path : Json) => ("readSkillOrSkip", [path, promise])
  if paths.isEmpty then return arr []
  let mut heads : List Outcome := []
  for path in paths do
    heads := heads ++ [← readSkillHead path]
  let parses := heads.filterMap fun
    | .ok value => some ("parseSkillMarkdown", [value])
    | _ => none
  let completed ← Prog.all
    ((paths.flatMap fun path => [("limit", [fnRef ""]), readOf path]) ++ parses)
  let reads := (List.range paths.length).map fun index => completed[index * 2 + 1]?.getD .pending
  let mut out : List Json := []
  for read in reads do
    let value ← valueOf read
    if value != Json.null then
      out := out ++ [value]
  return arr out

/-- `createPolicyToolApproval`: its logic past this point lives in the closures it hands over. -/
def createPolicyToolApproval (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let accountId := field (Twin.callArg call 1) "accountId"
  let enabled ← Prog.effect "isPolicyEnabled" [config]
  if !truthy enabled || !truthy accountId then
    return undef
  let documents ← Prog.effect "loadPolicyDocuments"
    [accountId, orElse (field config "policies") (arr [])]
  let mode ← Prog.effect "enforcingMode" [documents]
  let client ← Prog.effect "policyClient"
  let approval ← Prog.effect "opaPolicy"
    [Json.mkObj [("client", client), ("path", str "broods/authz/decision"),
                 ("toInput", fnRef "toInput")]]
  Prog.effect "shadow"
    [approval, Json.mkObj [("enforce", toJson (mode == str "enforce")),
                           ("onDecision", fnRef "onDecision")]]

private def ignoreCallbacks : Prog Unit :=
  Prog.drain (fun _ _ => pure ()) 256

/-- `wrapToolsWithOwnerFence` -/
def wrapToolsWithOwnerFence (call : Json) : Prog Json := do
  ignoreCallbacks
  let wrapped ← Prog.effect "wrapToolExecute" [Twin.callArg call 0, fnRef ""]
  return wrapped

/-- `wrapToolsWithHooks` -/
def wrapToolsWithHooks (call : Json) : Prog Json := do
  let wantsStart ← Prog.effect "hooks.hasHooksFor" [str "tool.call.started"]
  let wantsResult ← Prog.effect "hooks.hasHooksFor" [str "tool.result"]
  if !truthy wantsStart && !truthy wantsResult then
    return Twin.callArg call 0
  ignoreCallbacks
  let wrapped ← Prog.effect "wrapToolExecute" [Twin.callArg call 0, fnRef ""]
  return wrapped

private def containsBig : Nat → Json → Bool
  | 0, _ => false
  | fuel + 1, value =>
    match value with
    | .arr values => values.toList.any (containsBig fuel)
    | .obj entries =>
      entries.keys.contains "$big" ||
        entries.keys.any fun key => containsBig fuel (field value key)
    | _ => false

/-- `fitPiEntry`: `MAX_HARNESS_SESSION_ENTRY_BYTES` is 512 KiB. The recorder writes `$big` for a
serialization holding a value it already cut. -/
def fitPiEntry (call : Json) : Prog Json := do
  let data := Twin.callArg call 0
  let big := containsBig 64 data
  let serialized := stringify data
  let bytes ← Prog.effect "harnessEntryBytes"
    [if big then Json.mkObj [("$big", toJson true)] else str serialized]
  if (bytes.getNat?).toOption.getD 0 <= 524288 then
    return str serialized
  let trimmed ← Prog.effect "trimEntry" [data]
  return str (stringify trimmed)

/-- `runSecretValues`. The observability context is not recorded, so its secrets are taken as none. -/
def runSecretValues (_ : Json) : Prog Json :=
  Prog.effect "sensitiveEnvValues"

private def pad (width value : Nat) : String :=
  let digits := toString value
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `Date.prototype.toISOString`, by the days-to-civil calendar algorithm. -/
private def isoFromMs (ms : Nat) : String :=
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
  s!"{pad 4 year}-{pad 2 month}-{pad 2 day}T{pad 2 (rest / 3600000)}:{pad 2 (rest / 60000 % 60)}:{pad 2 (rest / 1000 % 60)}.{pad 3 (rest % 1000)}Z"

/-- `emit`. The observability context is not recorded, so the twin covers a call outside any run. -/
def emit (call : Json) : Prog Json := do
  let level := Twin.callArg call 0
  let data := Twin.callArg call 2
  let ts ← Prog.effect "Date.now"
  let service := orElse (Twin.env call "SERVICE_NAME") (str "broods-core")
  let secrets ← Prog.effect "runSecretValues"
  let message ← Prog.effect "redactString" [Twin.callArg call 1, secrets]
  let redacted ← if truthy data then Prog.effect "redact" [data, secrets] else pure undef
  let added : List (String × Json) :=
    [("time", str (isoFromMs ((ts.getNat?).toOption.getD 0))), ("level", level),
     ("message", message), ("service", service), ("service.name", service)]
  let dataKeys := (keysOf redacted).filter fun key => !(added.any (·.1 == key))
  let keys := dataKeys ++ added.map (·.1)
  let entry := Json.mkObj
    ((dataKeys.map fun key => (key, field redacted key)) ++ added ++
      [("$keys", toJson keys)])
  let _ ← Prog.effect "process.stdout.write" [str (stringify entry ++ "\n")]
  let _ ← Prog.effect "emitOtelLog" [level, entry]
  return undef

/-- `loadConfiguredSkillPrompt` -/
def loadConfiguredSkillPrompt (call : Json) : Prog Json := do
  let accountId := Twin.param call 0
  let skillPath := Twin.param call 2
  if !(items (Twin.param call 1)).contains skillPath then
    throwClass "Error" s!"Skill is not configured for this agent: {text skillPath}"
  if !truthy accountId then
    throwClass "Error" "Skills require an account-scoped run"
  let _ ← Prog.effect "parseOwnedSkillPath" [accountId, skillPath]
  let loaded ← Prog.effect "loadSkillContent" [skillPath, Twin.param call 3]
  let workspace := Twin.param call 4
  let staged ←
    if truthy workspace then Prog.effect "stageSkillBundleForSandbox" [skillPath, workspace]
    else pure Json.null
  let content ← Prog.effect "formatLoadedSkillPrompt" [loaded, staged]
  let stagedFields : List (String × Json) :=
    if truthy staged then [("stagedPath", field staged "stagedPath")] else []
  return Json.mkObj
    ([("path", skillPath),
      ("loadedPaths", arr ((items (field loaded "parts")).map (field · "path")))] ++
     stagedFields ++
     [("stagedFiles", if truthy staged then field staged "files" else arr []),
      ("bytes", field loaded "bytes"),
      ("prompt", Json.mkObj [("role", str "system"), ("content", content)])])

/-- `SKILL.md` first, then by path. `localeCompare` is taken as code-point order. -/
private def bundleOrder (paths : List String) : List String :=
  let sorted := (paths.filter (· != skillFile)).toArray.qsort (· < ·)
  (paths.filter (· == skillFile)) ++ sorted.toList

/-- `stageSkillBundleForSandbox` -/
def stageSkillBundleForSandbox (call : Json) : Prog Json := do
  let skillPath := Twin.callArg call 0
  let workspace := Twin.callArg call 1
  let config := field workspace "config"
  if isUndef config || config == Json.null then
    let shown := if config == Json.null then "null" else "undefined"
    return ← .fail (classError "TypeError"
      s!"{shown} is not an object (evaluating 'workspace.config.storage')" "TypeError")
  let storage := field config "storage"
  if field storage "provider" == str "disk" then
    return Json.null
  let parsed ← Prog.effect "parseSkillPath" [skillPath]
  if !truthy parsed then
    throwClass "Error" s!"Invalid skill path: {text skillPath}"
  let skillName := text (field parsed "skillName")
  let context ← Prog.effect "workspaceReadContext" [storage, field workspace "namespace"]
  let target ← Prog.effect "resolveS3ReadTarget" [context]
  let sources ← Prog.effect "listSkillSourceFiles" [skillPath]
  let paths := (items sources).map (field · "path")
  let pathSet := Json.mkObj [("$set", arr (dedupe (paths.map text) |>.map str))]
  let dirs := ".claude/skills" :: (items (Twin.moduleValue call "SKILL_MIRROR_DIRS")).map text
  let prefixes := dirs.map fun dir => str s!"{text (field target "prefix")}{dir}/{skillName}/"
  let _ ← Prog.all (prefixes.map fun prefix_ =>
    ("stageSkillFiles", [target, prefix_, sources, pathSet]))
  let stagedPath ← Prog.effect "canonicalStagedPath" [str skillName]
  let mirrorPaths ← Prog.effect "mirrorStagedPaths" [str skillName]
  return Json.mkObj
    [("stagedPath", stagedPath), ("mirrorPaths", mirrorPaths),
     ("files", toJson (bundleOrder (paths.map text)))]

/-- This author's twins. -/
def twins : List Spec.Twin :=
  let harness := "apps/core/src/harness/"
  let shared := "apps/core/src/shared/"
  let pi := harness ++ "ai-sdk-harness/adapters/pi.ts#"
  [ Twin.traced (shared ++ "env.ts#requireEnv") requireEnv
  , Twin.traced (shared ++ "log.ts#isSensitiveEnvName") isSensitiveEnvName
  , Twin.traced (shared ++ "log.ts#matchableSecrets") matchableSecrets
  , Twin.traced (shared ++ "log.ts#replaceSecretValues") replaceSecretValues
  , Twin.traced (shared ++ "log.ts#scrubSecrets") scrubSecrets
  , Twin.traced (shared ++ "log.ts#redactValue") redactValue
  , Twin.traced (shared ++ "log.ts#redactString") redactString
  , Twin.traced (shared ++ "log.ts#redact") redact
  , Twin.traced (shared ++ "log.ts#logError") logError
  , Twin.traced (harness ++ "policy.ts#toolContextForPolicy") toolContextForPolicy
  , Twin.traced (harness ++ "policy.ts#policyInputForTool") policyInputForTool
  , Twin.traced (harness ++ "skills.ts#loadSkillContent") loadSkillContent
  , Twin.traced (harness ++ "skills.ts#listSkillMetadataForConfig") listSkillMetadataForConfig
  , Twin.traced (harness ++ "policy.ts#createPolicyToolApproval") createPolicyToolApproval
  , Twin.traced (harness ++ "tool-execute.ts#wrapToolsWithOwnerFence") wrapToolsWithOwnerFence
  , Twin.traced (harness ++ "hook-dispatcher.ts#wrapToolsWithHooks") wrapToolsWithHooks
  , Twin.traced (pi ++ "fitPiEntry") fitPiEntry
  , Twin.traced (shared ++ "log.ts#runSecretValues") runSecretValues
  , Twin.traced (shared ++ "log.ts#emit") emit
  , Twin.traced (harness ++ "skills.ts#loadConfiguredSkillPrompt") loadConfiguredSkillPrompt
  , Twin.traced (harness ++ "skills.ts#stageSkillBundleForSandbox") stageSkillBundleForSandbox
  ]

end Spec.Agent.Waveagent4a
