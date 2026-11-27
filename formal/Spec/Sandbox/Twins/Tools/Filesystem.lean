import Spec.Sandbox.Twins.Tools.Js

/-!
Twins of `apps/core/src/harness/tools/filesystem-utils.ts`. The limits are the defaults: the
`WORKSPACE_SANDBOX_*` environment overrides are not in a call's arguments.
-/

namespace Spec.Sandbox.Tools

open Lean

private def file : String := "filesystem-utils.ts"

def defaultWorkspaceRoot : String := "/mnt/workspaces"

/-! ## Sandbox limits and numeric options -/

/-- `workspaceSandboxLimits`, shared/sandbox.ts:53 and convex/model/sandboxRules.ts:182. -/
structure Limits where
  defaultTimeout : Int := 30
  defaultOutput : Int := 64 * 1024
  maxTimeout : Int
  maxOutput : Int := 256 * 1024

def limitsFor (provider : Json) : Limits :=
  { maxTimeout := if provider == Json.str "worker" then 60 else 600 }

def boundedInteger (value : Json) (fallback max : Int) : R Int :=
  if value == Json.null then pure fallback
  else
    let refused : R Int := jsThrow s!"sandbox numeric option must be an integer from 1 to {max}"
    match intOf? value with
    | some n =>
      if n > 9007199254740991 || n < 1 || n > max then refused else pure n
    | none => refused

def sandboxTimeoutSeconds (config : Json) (defaultSeconds : Option Int := none) : R Int :=
  let limits := limitsFor (field config "provider")
  boundedInteger (field config "timeout")
    (min (defaultSeconds.getD limits.defaultTimeout) limits.maxTimeout) limits.maxTimeout

def workspaceRootFor (config : Json) : String :=
  match fieldAt config ["options", "workspaceRoot"] with
  | .str root => if jsTrim root != "" then jsTrim root else defaultWorkspaceRoot
  | _ => defaultWorkspaceRoot

def statelessReservationKeyFor (config : Json) : Option String :=
  match fieldAt config ["options", "reservationKey"] with
  | .str key => if jsTrim key != "" then some (jsTrim key) else none
  | _ => none

/-! ## Which sandbox and workspace a call lands on -/

def contextSandboxes (context : Json) : List Json := items (field context "sandboxes")

def contextWorkspaces (context : Json) : List Json := items (field context "workspaces")

def defaultSandbox (context : Json) : Json := (contextSandboxes context).headD Json.null

def isAgentOwnSandbox (workspace context : Json) : Bool :=
  let owned := fieldAt (defaultSandbox context) ["sandbox", "controlPlane", "sandboxConfigId"]
  truthy owned && fieldAt workspace ["sandbox", "controlPlane", "sandboxConfigId"] == owned

def agentOwnWorkspace (context : Json) : Option Json :=
  (contextWorkspaces context).find? fun workspace => isAgentOwnSandbox workspace context

def hasStandaloneSandbox (context : Json) : Bool :=
  truthy (defaultSandbox context) && (agentOwnWorkspace context).isNone

def selectableSandboxes (context : Json) : List Json :=
  let sandboxes := contextSandboxes context
  if hasStandaloneSandbox context then sandboxes else sandboxes.drop 1

def sandboxParamChoices (context : Json) : List Json :=
  let choices := selectableSandboxes context
  if choices.length == 1 && (contextWorkspaces context).isEmpty then [] else choices

def resolveAgentSandbox (context requested : Json) : R Json := do
  if requested == Json.null then return defaultSandbox context
  match (selectableSandboxes context).find? fun candidate => field candidate "name" == requested with
  | some entry => return entry
  | none =>
    let mountedBy :=
      if field (defaultSandbox context) "name" == requested then agentOwnWorkspace context else none
    match mountedBy with
    | some workspace =>
      let name := text (field workspace "name")
      jsThrow s!"sandbox \"{text requested}\" is mounted by workspace \"{name}\"; pass workspace \"{name}\" instead"
    | none => jsThrow s!"unknown sandbox {text requested}"

/-- `undefined` stands for no workspaces, and the function's `undefined` result is `none`. -/
def resolveWorkspace (workspaces : List Json) (requested : Json) : R (Option Json) :=
  match workspaces with
  | [] => pure none
  | firstWorkspace :: _ =>
    if !truthy requested then pure (some firstWorkspace)
    else
      match workspaces.find? fun workspace => field workspace "name" == requested with
      | some workspace => pure (some workspace)
      | none => jsThrow s!"unknown workspace {text requested}"

def targetsAgentSandbox (context selection : Json) : Bool :=
  if (contextWorkspaces context).isEmpty then true
  else if field selection "sandbox" == Json.null then false
  else (selectableSandboxes context).any fun entry =>
    field entry "name" == field selection "sandbox"

def permissionModeFor (workspace : Option Json) : Json :=
  orElse (fieldAt (workspace.getD Json.null) ["sandbox", "permissionMode"]) (Json.str "ask")

private def readOnly (workspace : Option Json) : Bool :=
  match workspace with
  | some found => !truthy (field found "sandbox")
  | none => false

/-- A thrown error asks for approval; a case outside the model stays outside it. -/
private def askOnThrow : R Bool → R Bool
  | .error (.threw _) => pure true
  | other => other

def editNeedsApproval (workspaces : List Json) (requested : Json) : R Bool :=
  askOnThrow do
    let workspace ← resolveWorkspace workspaces requested
    if readOnly workspace then return false
    return permissionModeFor workspace == Json.str "ask"

def bashNeedsApproval (context selection : Json) : R Bool :=
  askOnThrow do
    let picked ← resolveAgentSandbox context (field selection "sandbox")
    if targetsAgentSandbox context selection then
      return fieldAt picked ["sandbox", "permissionMode"] != Json.str "bypass"
    let workspace ← resolveWorkspace (contextWorkspaces context) (field selection "workspace")
    if readOnly workspace then return false
    return permissionModeFor workspace != Json.str "bypass"

def computerSandboxTarget (machines : List Json) (requested : Json) : Json :=
  match requested with
  | .str _ => (machines.find? fun machine => field machine "name" == requested).getD Json.null
  | _ => if machines.length ≤ 1 then machines.headD Json.null else Json.null

def isMachine (entry : Json) : Bool :=
  fieldAt entry ["sandbox", "provider"] == Json.str "machine"

/-- The registry of connected machines is memory outside the arguments, so only a non-machine has
a state here. -/
def machineState (entry : Json) : R String :=
  if isMachine entry then noModel "whether a machine is connected is in the registry, not the arguments"
  else pure ""

def bashTargetLines (context : Json) : R (List String) := do
  let workspaces := contextWorkspaces context
  let namesWorkspace := workspaces.length > 1
  let namesSandbox := !(sandboxParamChoices context).isEmpty
  let workspaceLines := workspaces.zipIdx.map fun (workspace, index) =>
    let name := text (field workspace "name")
    let target := if namesWorkspace then s!"workspace={name}" else s!"workspace {name}, omit workspace"
    let isDefault := if index == 0 then " (default)" else ""
    let readOnlyNote := if truthy (field workspace "sandbox") then "" else " (read-only, no bash)"
    s!"- {target}{isDefault}{readOnlyNote}"
  let sandboxLines ← (selectableSandboxes context).zipIdx.mapM fun (entry, index) => do
    let name := text (field entry "name")
    let target := if namesSandbox then s!"sandbox={name}" else s!"sandbox {name}, omit sandbox"
    let isDefault := if workspaces.isEmpty && index == 0 then " (default)" else ""
    let state ← machineState entry
    pure s!"- {target}{isDefault} ({text (fieldAt entry ["sandbox", "provider"])}, no workspace mounted{state})"
  pure (workspaceLines ++ sandboxLines)

/-! ## Schemas and metadata -/

def workspaceParamSchema (workspaces : List Json) : Json :=
  if workspaces.length ≤ 1 then Json.null
  else Json.mkObj [
    ("type", Json.str "string"),
    ("enum", Json.arr (workspaces.map fun workspace => field workspace "name").toArray),
    ("description", Json.str "Named workspace to operate in. Omit to use the default workspace.")]

/-- Adds the `workspace` property of a tool's input schema when there is more than one. -/
def withWorkspaceProp (workspaces : List Json) (properties : List (String × Json)) : Json :=
  let schema := workspaceParamSchema workspaces
  Json.mkObj (if schema == Json.null then properties else properties ++ [("workspace", schema)])

def sandboxRunMetadata (context workspace : Json) : Json :=
  let metadata := field context "sandboxMetadata"
  if !truthy metadata then Json.null
  else if truthy workspace then
    spread metadata (object [
      ("workspaceName", field workspace "name"),
      ("workspaceId", field workspace "workspaceId")])
  else metadata

/-! ## Runtimes -/

private def allRuntimes : List Json := [Json.str "bash", Json.str "python", Json.str "node"]

def runtimeList (config : Json) : List Json :=
  let runtimes := items (field config "runtimes")
  if runtimes.isEmpty then allRuntimes else runtimes

def runtimeDescription (config : Json) : String :=
  let runtimes := if truthy config then runtimeList config else allRuntimes
  s!"Allowed runtimes: {String.intercalate ", " (runtimes.map text)}."

private def invocationLead : Re :=
  .alt .bol (.chr fun c => jsWhitespace c || ";&|()".toList.contains c)

/-- The `(^|[\s;&|()])(name|...)(\s|$)` of `invokesCommand`. -/
def invokesCommand (command : String) (names : List String) : Bool :=
  Re.test (Re.seqs [invocationLead, Re.anyLit names, .alt Re.space .eol]) command

def disallowedRuntimeCommand (config : Json) (command : String) : Option String :=
  let runtimes := runtimeList config
  let allowed := fun runtime => runtimes.contains (Json.str runtime)
  if !allowed "bash" then some "Error: this sandbox does not allow bash commands"
  else if !allowed "python" && invokesCommand command ["python", "python3"] then
    some "Error: this sandbox does not allow python commands"
  else if !allowed "node" && invokesCommand command ["node", "npm", "npx"] then
    some "Error: this sandbox does not allow node commands"
  else none

/-! ## The workspace write guard -/

def stripHereDocBodies (command : String) : String :=
  let heredoc := Re.seqs [
    Re.lit "<<", Re.opt (Re.lit "-"), Re.star Re.space, Re.opt (Re.oneOf "\"'"),
    .group 1 (.seq
      (.chr fun c => ('A' ≤ c ∧ c ≤ 'Z') || ('a' ≤ c ∧ c ≤ 'z') || c == '_')
      (Re.star (.chr fun c =>
        ('A' ≤ c ∧ c ≤ 'Z') || ('a' ≤ c ∧ c ≤ 'z') || ('0' ≤ c ∧ c ≤ '9') || c == '_' || c == '-'))),
    Re.opt (Re.oneOf "\"'")]
  let step : (List String × Option String) → String → (List String × Option String) :=
    fun (kept, marker) line =>
      match marker with
      | some name => if jsTrim line == name then (kept, none) else (kept, marker)
      | none => (line :: kept, Re.firstGroup heredoc line)
  let (kept, _) := (split command "\n").foldl step ([], none)
  String.intercalate "\n" kept.reverse

private def isLineTerminator (c : Char) : Bool :=
  c == '\n' || c == '\r' || c.toNat == 0x2028 || c.toNat == 0x2029

private def unescapeChars : List Char → List Char
  | '\\' :: c :: rest =>
    if isLineTerminator c then '\\' :: unescapeChars (c :: rest) else c :: unescapeChars rest
  | c :: rest => c :: unescapeChars rest
  | [] => []

def unescapeShellChars (command : String) : String :=
  String.ofList (unescapeChars command.toList)

/-- `PARENT_TRAVERSAL`, filesystem-utils.ts:51. -/
private def parentTraversal : Re :=
  Re.seqs [
    .alt .bol (.chr fun c => jsWhitespace c || "\"'=:{([<>,/".toList.contains c),
    Re.lit "..",
    .ahead (.alt (.chr fun c => jsWhitespace c || "/;&|)\"']}>,".toList.contains c) .eol)]

private def writeLead : Re := invocationLead

private def writePath : Re :=
  .group 1 (.seq (Re.lit "/") (Re.star (.chr fun c =>
    !jsWhitespace c && !"\"'`;&|)<>".toList.contains c)))

private def notSeparator : Re := Re.noneOf ";&|"

private def flagRun : Re := Re.star (Re.seqs [Re.lit "-", Re.plus Re.nonSpace, Re.plus Re.space])

private def commandEnd : Re :=
  .ahead (.seq (Re.star Re.space) (.alt .eol (Re.oneOf ";&|")))

/-- `ABSOLUTE_WRITE_PATTERNS`, filesystem-utils.ts:53, in order. -/
private def absoluteWritePatterns : List Re := [
  Re.seqs [writeLead, Re.star Re.digit, Re.lit ">", Re.opt (Re.lit ">"), Re.opt (Re.lit "|"),
    Re.star Re.space, writePath],
  Re.seqs [writeLead, Re.lit "tee", Re.plus Re.space, flagRun, writePath],
  Re.seqs [writeLead, Re.lit "dd", Re.space, Re.star notSeparator, .wordBoundary, Re.lit "of=",
    writePath],
  Re.seqs [writeLead, Re.anyLit ["cp", "mv", "ln", "install", "rsync"], Re.space,
    Re.lazy notSeparator, Re.space, writePath, commandEnd],
  Re.seqs [writeLead, Re.anyLit ["mkdir", "touch", "rm", "rmdir", "truncate", "unlink"],
    Re.plus Re.space, flagRun, writePath],
  Re.seqs [writeLead, Re.lit "sed", Re.plus Re.space, Re.star notSeparator, Re.lit "-i",
    Re.lazy notSeparator, Re.space, writePath],
  Re.seqs [writeLead, Re.anyLit ["curl", "wget", "tar", "unzip"], Re.space,
    Re.opt (.seq (Re.lazy notSeparator) Re.space), Re.lit "-",
    Re.anyLit ["o", "O", "C", "d", "-output", "-directory", "-output-document"],
    Re.plus (.chr fun c => jsWhitespace c || c == '='), writePath],
  Re.seqs [writeLead, Re.lit "git", Re.plus Re.space, Re.lit "clone", Re.space,
    Re.lazy notSeparator, Re.space, writePath, commandEnd]]

def isEphemeralPath (path : String) : Bool :=
  ["/tmp/", "/var/tmp/", "/dev/"].any fun root =>
    path == String.ofList root.toList.dropLast || isPrefix path root

def absoluteWriteTarget (command : String) : Option String :=
  absoluteWritePatterns.findSome? fun pattern =>
    (Re.allGroups pattern command).findSome? fun path =>
      let trimmed := jsTrim path
      if trimmed != "" && !isEphemeralPath trimmed then some trimmed else none

def workspaceRelativeSuggestion (target : String) : String :=
  match ((split target "/").filter (· != "")).getLast? with
  | some basename => "./" ++ basename
  | none => "./output"

def outsideWorkspaceCommand (command : String) (persistentOwnSandbox : Json) : Option String :=
  let scanned := unescapeShellChars (stripHereDocBodies command)
  if Re.test parentTraversal scanned then
    some "Error: parent directory traversal is not allowed"
  else if persistentOwnSandbox == Json.bool true then none
  else (absoluteWriteTarget scanned).map fun target =>
    s!"Error: {target} is outside the workspace, so anything written there is lost when the sandbox stops. " ++
      s!"Write to a workspace-relative path instead (e.g. {workspaceRelativeSuggestion target}), " ++
      "or use /tmp when the file is genuinely throwaway."

def writesOutsideAllowed (workspace context : Json) : Bool :=
  fieldAt workspace ["sandbox", "persistent"] == Json.bool true && isAgentOwnSandbox workspace context

/-- `toWorkspaceRelative`, where a null path stands for `undefined`. -/
def workspaceRelative : Json → R String
  | .str path =>
    match lexicalPath path with
    | some relative => pure relative
    | none => jsThrow "Invalid path: directory traversal not allowed"
  | .null => pure "."
  | _ => noModel "path is not a string"

/-! ## Results -/

/-- `isFatalSandboxSetupError`, utils.ts:150. The pattern is ASCII, so `/i` folds ASCII only. -/
def isFatalSandboxSetupError (value : String) : Bool :=
  let lower := String.ofList (value.toList.map asciiLower)
  ["allocated memory limit", "resource limit", "quota exceeded", "invalid namespace: must match"].any
    (contains lower)

def formatRunText (result : Json) (timeoutSeconds : Json) : R String := do
  let stdout := text (field result "stdout")
  let stderr := text (field result "stderr")
  let output := stdout ++ stderr
  let separator := if output == "" || isSuffix output "\n" then "" else "\n"
  if truthy (field result "timedOut") then
    jsThrow s!"{output}{separator}[timed out after {text timeoutSeconds}s, the per-call limit; any output past it is lost]"
  let ok := truthy (field result "ok")
  let exitCode := field result "exitCode"
  let exitedClean := exitCode == Json.null || intOf? exitCode == some 0
  if ok && exitedClean then return output
  if !ok then
    let trimmed := jsTrim (stderr ++ stdout)
    let error := if trimmed != "" then trimmed else "sandbox command failed"
    if isFatalSandboxSetupError error then jsThrow error
  let status := if exitCode == Json.null then "command failed" else s!"exit code {text exitCode}"
  return s!"{output}{separator}[{status}]"

/-! ## The twins -/

private def optionJson : Option Json → Json
  | some value => value
  | none => Json.null

def filesystemTwins : List Spec.Twin := [
  tool file "workspaceRootFor" fun a => pure (Json.str (workspaceRootFor (arg a 0))),
  { tool file "sandboxTimeoutSeconds" (fun a => do
    let fallback ← match arg a 1 with
      | .null => pure none
      | value =>
        match intOf? value with
        | some n => pure (some n)
        | none => noModel "default is not an integer"
    return toJson (← sandboxTimeoutSeconds (arg a 0) fallback)) ["L12"] with
    -- Only a test that lowers the Lambda limit can disagree, and then only for Lambda.
    gapCovers := fun a => (Twin.arg (Twin.arg a 0) 0 |> fun _ =>
      ((Twin.arg a 0).getObjValAs? String "provider").toOption == some "lambda") },
  tool file "agentOwnWorkspace" fun a => pure (optionJson (agentOwnWorkspace (arg a 0))),
  tool file "hasStandaloneSandbox" fun a => pure (Json.bool (hasStandaloneSandbox (arg a 0))),
  tool file "isAgentOwnSandbox" fun a => pure (Json.bool (isAgentOwnSandbox (arg a 0) (arg a 1))),
  tool file "sandboxSupportsBackgroundJobs" fun a =>
    pure (Json.bool (field (arg a 0) "persistent" == Json.bool true)),
  tool file "sandboxSupportsJobControls" fun a =>
    pure (Json.bool (field (arg a 0) "persistent" == Json.bool true &&
      field (arg a 0) "provider" != Json.str "e2b")),
  tool file "resolveAgentSandbox" fun a => resolveAgentSandbox (arg a 0) (arg a 1),
  tool file "resolveWorkspace" fun a => do
    return optionJson (← resolveWorkspace (items (arg a 0)) (arg a 1)),
  tool file "workspaceParamSchema" fun a => pure (workspaceParamSchema (items (arg a 0))),
  tool file "sandboxRunMetadata" fun a => pure (sandboxRunMetadata (arg a 0) (arg a 1)),
  tool file "editNeedsApproval" fun a => do
    return Json.bool (← editNeedsApproval (items (arg a 0)) (arg a 1)),
  tool file "bashNeedsApproval" fun a => do
    return Json.bool (← bashNeedsApproval (arg a 0) (arg a 1)),
  tool file "bashSandboxTarget" fun a =>
    pure (if isStr (arg a 0) then arg a 0 else Json.null),
  tool file "computerSandboxTarget" fun a =>
    pure (computerSandboxTarget (items (arg a 0)) (arg a 1)),
  tool file "machineSandboxes" fun a =>
    pure (Json.arr ((items (arg a 0)).filter isMachine).toArray),
  tool file "bashTargetLines" fun a => do return strs (← bashTargetLines (arg a 0)),
  tool file "sandboxParamChoices" fun a => pure (Json.arr (sandboxParamChoices (arg a 0)).toArray),
  tool file "selectableSandboxes" fun a => pure (Json.arr (selectableSandboxes (arg a 0)).toArray),
  tool file "targetsAgentSandbox" fun a => pure (Json.bool (targetsAgentSandbox (arg a 0) (arg a 1))),
  tool file "formatRunText" fun a => do
    return Json.str (← formatRunText (arg a 0) (arg a 1)),
  tool file "runtimeDescription" fun a => pure (Json.str (runtimeDescription (arg a 0))),
  tool file "disallowedRuntimeCommand" (fun a =>
    match arg a 1 with
    | .str command =>
      pure (((disallowedRuntimeCommand (arg a 0) command).map Json.str).getD Json.null)
    | _ => noModel "command is not a string"),
  tool file "outsideWorkspaceCommand" (fun a =>
    match arg a 0 with
    | .str command =>
      pure (((outsideWorkspaceCommand command (field (arg a 1) "persistentOwnSandbox")).map Json.str).getD
        Json.null)
    | _ => noModel "command is not a string"),
  tool file "writesOutsideAllowed" fun a =>
    pure (Json.bool (writesOutsideAllowed (arg a 0) (arg a 1))),
  tool file "toWorkspaceRelative" fun a => do
    return Json.str (← workspaceRelative (arg a 0)),
  tool file "toBase64" (fun a =>
    match arg a 0 with
    | .str value => pure (Json.str (toBase64 value))
    | _ => noModel "value is not a string"),
  tool file "boundedInteger" (fun a =>
    match intOf? (arg a 1), intOf? (arg a 2) with
    | some fallback, some max => do return toJson (← boundedInteger (arg a 0) fallback max)
    | _, _ => noModel "default and max are not integers"),
  tool file "absoluteWriteTarget" (fun a =>
    match arg a 0 with
    | .str command => pure (((absoluteWriteTarget command).map Json.str).getD Json.null)
    | _ => noModel "command is not a string"),
  tool file "invokesCommand" (fun a =>
    match arg a 0 with
    | .str command =>
      pure (Json.bool (invokesCommand command ((items (arg a 1)).filterMap strOf?)))
    | _ => noModel "command is not a string"),
  tool file "isEphemeralPath" (fun a =>
    match arg a 0 with
    | .str path => pure (Json.bool (isEphemeralPath path))
    | _ => noModel "path is not a string"),
  tool file "machineState" fun a => do return Json.str (← machineState (arg a 0)),
  tool file "permissionModeFor" fun a =>
    pure (permissionModeFor (if arg a 0 == Json.null then none else some (arg a 0))),
  tool file "runtimeList" fun a => pure (Json.arr (runtimeList (arg a 0)).toArray),
  tool file "statelessReservationKeyFor" fun a =>
    pure (((statelessReservationKeyFor (arg a 0)).map Json.str).getD Json.null),
  tool file "stripHereDocBodies" (fun a =>
    match arg a 0 with
    | .str command => pure (Json.str (stripHereDocBodies command))
    | _ => noModel "command is not a string"),
  tool file "unescapeShellChars" (fun a =>
    match arg a 0 with
    | .str command => pure (Json.str (unescapeShellChars command))
    | _ => noModel "command is not a string"),
  tool file "workspaceRelativeSuggestion" (fun a =>
    match arg a 0 with
    | .str target => pure (Json.str (workspaceRelativeSuggestion target))
    | _ => noModel "target is not a string")]

end Spec.Sandbox.Tools
