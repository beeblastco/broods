import Spec.Agent.Twins.Loop.Js

/-!
Twins of `apps/core/src/harness/policy.ts`, with the tool-path and secret-name rules it reads.
-/

namespace Spec.Agent

open Lean Js

private def alwaysSecretParts : List String :=
  ["secret", "password", "passwd", "passphrase", "kubeconfig"]

private def secretLastWords : List String :=
  ["secret", "secrets", "password", "passwords", "credential", "credentials", "cookie", "cookies",
    "certificate", "pem", "authorization", "authentication", "auth", "bearer", "token", "tokens",
    "key", "keys", "apikey", "accesskey", "privatekey"]

private def identifierKeyQualifiers : List String :=
  ["cache", "conversation", "destination", "embeddable", "event", "idempotency", "object",
    "partition", "preview", "public", "reservation", "resource", "scope", "sort", "source",
    "storage", "unscoped"]

private def tokenCountNames : List String :=
  ["cachecreationinputtokens", "cachedinputtokens", "cachereadtokens", "cachewritetokens",
    "inputtokens", "maxoutputtokens", "maxtokens", "nocachetokens", "outputtokens",
    "reasoningtokens", "texttokens", "totaltokens"]

private def secretWordEndings : List String :=
  ["apikey", "accesskey", "credential", "credentials", "privatekey", "token"]

private def asciiUpper (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'
private def asciiLower (c : Char) : Bool := 'a' ≤ c && c ≤ 'z'
private def asciiDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- `replace(/([a-z0-9])([A-Z])/g, "$1 $2")`. -/
private def camelBreaks : List Char → List Char
  | [] => []
  | a :: rest =>
    match rest with
    | b :: _ =>
      if (asciiLower a || asciiDigit a) && asciiUpper b then a :: ' ' :: camelBreaks rest
      else a :: camelBreaks rest
    | [] => [a]

/-- `replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")`. -/
private def acronymBreaks : List Char → List Char
  | [] => []
  | a :: rest =>
    match rest with
    | b :: c :: _ =>
      if asciiUpper a && asciiUpper b && asciiLower c then a :: ' ' :: acronymBreaks rest
      else a :: acronymBreaks rest
    | _ => a :: acronymBreaks rest

/-- `toLowerCase`, for the characters that can land in `[a-z0-9]`: ASCII, the Kelvin sign and İ. -/
private def lowerForWords (c : Char) : List Char :=
  if asciiUpper c then [c.toLower]
  else if c.toNat == 0x212A then ['k']
  else if c.toNat == 0x130 then ['i', ' ']
  else [c]

private def wordsOf (chars : List Char) : List String :=
  let step (state : List String × List Char) (c : Char) : List String × List Char :=
    if asciiLower c || asciiDigit c then (state.fst, c :: state.snd)
    else if state.snd.isEmpty then state
    else (String.ofList state.snd.reverse :: state.fst, [])
  let final := chars.foldl step ([], [])
  (if final.snd.isEmpty then final.fst else String.ofList final.snd.reverse :: final.fst).reverse

/-- `packages/convex/model/secretNames.ts#judgeName`. -/
def isSecretName (name : String) : Bool :=
  let words := wordsOf ((acronymBreaks (camelBreaks name.toList)).flatMap lowerForWords)
  match words.getLast? with
  | none => false
  | some last =>
    if tokenCountNames.contains (String.join words) then false
    else if words.any fun word => alwaysSecretParts.any fun part => includes word part then true
    else if !secretLastWords.contains last then
      secretWordEndings.any fun ending => endsWith last ending
    else if last != "key" && last != "keys" then true
    else
      match words.getLast? >>= fun _ => (words.dropLast).getLast? with
      | none => false
      | some qualifier => !identifierKeyQualifiers.contains qualifier

/-- `toWorkspaceRelative`, with none where it throws on a traversal. -/
def workspaceRelative (path : String) : Option String :=
  let trimmed := trim path
  if trimmed.isEmpty || trimmed == "." || trimmed == "/" then some "."
  else
    let unrooted := String.ofList (trimmed.toList.dropWhile (· == '/'))
    let parts := (unrooted.splitOn "/").filter fun part => !part.isEmpty && part != "."
    if parts.contains ".." then none
    else if parts.isEmpty then some "."
    else some (String.intercalate "/" parts)

/-- `policyFilePath`. A search root gains a trailing slash, and a traversal stays raw. -/
def policyFilePath (rawPath : String) (searchRoot : Bool) : String :=
  match workspaceRelative rawPath with
  | none => rawPath
  | some path =>
    if !searchRoot then path else if path == "." then "" else path ++ "/"

/-- `truncatePolicyString`, keeping 500 code units. -/
def truncatePolicyString (value : String) : String :=
  if length value > 500 then take value 500 ++ "..." else value

/-- `sanitizePolicyValue`, depth-capped at 4, with secrets redacted and arrays cut to 20 items.
An own `__proto__` key becomes the output's prototype, so it never appears as a key. -/
def sanitizePolicyValue (fuel : Nat) (value : Json) (depth : Nat) : Json :=
  match fuel, value with
  | _, .str text => .str (truncatePolicyString text)
  | fuel + 1, .arr values =>
    if depth ≥ 4 then .str s!"[array:{values.size}]"
    else .arr ((values.toList.take 20).map fun entry => sanitizePolicyValue fuel entry (depth + 1)).toArray
  | fuel + 1, .obj fields =>
    if depth ≥ 4 then .str "[object]"
    else
      Json.mkObj ((fields.toList.filter fun entry => entry.fst != "__proto__").map fun entry =>
        (entry.fst,
          if isSecretName entry.fst then .str "[redacted]"
          else sanitizePolicyValue fuel entry.snd (depth + 1)))
  | 0, .arr _ => .null
  | 0, .obj _ => .null
  | _, other => other

/-- `sanitizePolicyToolInput`: an object input sanitized, anything else absent. -/
def sanitizePolicyToolInput (value : Json) (depth : Nat) : Option Json :=
  if !isObj value then none
  else
    let result := sanitizePolicyValue 8 value depth
    if isObj result then some result else none

/-- `formatPolicyPreviewValue`, with `absent` the text of a value the recorder shows as null. -/
def policyPreviewValue (value : Json) (absent : String) : String :=
  match value with
  | .str text => quote (if length text > 80 then take text 80 ++ "..." else text)
  | .num number => numText number
  | .bool flag => if flag then "true" else "false"
  | .arr values => s!"[array:{values.size}]"
  | .obj _ => "{object}"
  | .null => absent

/-- `formatPolicyInputPreview`, or none when two keys make its text depend on their lost order. -/
def policyInputPreview (input : Json) : Option String :=
  match entries input with
  | [] => some ""
  | [(key, value)] => some (take (key ++ "=" ++ policyPreviewValue value "null") 160)
  | _ => none

/-- `toolContextForPolicy`, or none when the preview's text depends on lost key order. -/
def policyToolContext (input : Json) : Option Json :=
  match sanitizePolicyToolInput input 0 with
  | none => some (Json.mkObj [])
  | some sanitized =>
    (policyInputPreview sanitized).map fun preview =>
      Json.mkObj [("input", sanitized), ("inputKeys", toJson (keys sanitized)),
        ("inputPreview", toJson preview)]

/-- `isAgentOwnSandbox`: the workspace's sandbox config is the agent's first sandbox's. -/
private def isAgentOwn (workspace : Json) (sandboxes : List Json) : Bool :=
  let owned := get (get (get (sandboxes.headD .null) "sandbox") "controlPlane") "sandboxConfigId"
  truthy owned && get (get (get workspace "sandbox") "controlPlane") "sandboxConfigId" == owned

/-- `selectableSandboxes`: the first is reserved when a workspace owns it, or there is none. -/
private def selectableSandboxes (workspaces sandboxes : List Json) : List Json :=
  let standalone := !sandboxes.isEmpty && !workspaces.any fun workspace => isAgentOwn workspace sandboxes
  if standalone then sandboxes else sandboxes.drop 1

/-- `targetsAgentSandbox`. -/
private def targetsAgentSandbox (workspaces sandboxes : List Json) (sandbox : Option String) : Bool :=
  if workspaces.isEmpty then true
  else
    match sandbox with
    | none => false
    | some name =>
      (selectableSandboxes workspaces sandboxes).any fun entry => get entry "name" == .str name

/-- `resolveWorkspaceForPolicy`: the named workspace, the first when unnamed, none when unknown. -/
def workspaceForPolicy (workspaces : List Json) (name : Option String) : Option Json :=
  match name with
  | some requested =>
    if requested.isEmpty then workspaces.head?
    else workspaces.find? fun workspace => get workspace "name" == .str requested
  | none => workspaces.head?

/-- `memorySlug` for an ASCII title, where NFKD changes nothing; none for any other title. -/
def memorySlug (title : String) : Option String :=
  if title.toList.any fun c => c.toNat > 127 then none
  else
    let lower := title.toList.map Char.toLower
    let step (out : List Char) (c : Char) : List Char :=
      if asciiLower c || asciiDigit c then c :: out
      else match out with
        | '-' :: _ => out
        | _ => '-' :: out
    let dashed := (lower.foldl step []).reverse
    let kebab := ((dashed.dropWhile (· == '-')).reverse.dropWhile (· == '-')).reverse
    let slug := ((kebab.take 60).reverse.dropWhile (· == '-')).reverse
    if !slug.isEmpty && slug == kebab then some (String.ofList slug)
    else
      let hash := String.ofList ((sha256Hex title).toList.take 8)
      some (if slug.isEmpty then "memory-" ++ hash else String.ofList slug ++ "-" ++ hash)

/-- `policyInputForTool`, or none when its text depends on lost key order or a non-ASCII title. -/
def policyInputForTool (toolName : String) (input : Json) (workspaces sandboxes : List Json) :
    Option Json := do
  let sandboxTarget := str? (get input "sandbox")
  let workspaceTarget := str? (get input "workspace")
  let onAgentSandbox := toolName == "bash" && targetsAgentSandbox workspaces sandboxes sandboxTarget
  let workspace := if onAgentSandbox then none else workspaceForPolicy workspaces workspaceTarget
  let picked :=
    if !onAgentSandbox then none
    else
      match sandboxTarget with
      | none => sandboxes.head?
      | some name => sandboxes.find? fun entry => get entry "name" == .str name
  let searches := toolName == "grep" || toolName == "glob"
  let rawPath := get input (if searches then "path" else "file_path")
  let filePath :=
    match rawPath with
    | .str path => some (policyFilePath path searches)
    | _ => if searches then some "" else none
  let context ← policyToolContext input
  let pickedMode := (picked.map fun entry => get (get entry "sandbox") "permissionMode").getD .null
  let base : List (String × Json) :=
    [("toolName", toJson toolName), ("tool", context)] ++
    (match workspace with
      | some found =>
        copied found "workspaceId" ++ field "workspaceName" (found.getObjVal? "name").toOption ++
          field "sandboxPermissionMode" ((get found "sandbox").getObjVal? "permissionMode").toOption
      | none => []) ++
    (if truthy pickedMode then [("sandboxPermissionMode", pickedMode)] else []) ++
    field "filePath" (filePath.map toJson) ++
    (if searches then [("searchRoot", toJson true)] else [])
  let shaped (action : String) (extra : List (String × Json)) : Json :=
    Json.mkObj ([("action", toJson action)] ++ base ++ extra)
  if toolName == "read" || toolName == "glob" || toolName == "grep" then
    return shaped "workspace.read" []
  if toolName == "write" || toolName == "edit" then return shaped "workspace.write" []
  if toolName == "memory_save" then
    let slug ← memorySlug ((str? (get input "title")).getD "")
    return shaped "workspace.write" [("filePath", toJson ("memory/" ++ slug ++ ".md"))]
  if toolName == "bash" then return shaped "workspace.exec" []
  if toolName == "load_skill" then
    let skillPath := get input "path"
    return shaped "skill.load"
      (match skillPath with
        | .str path => if path.isEmpty then [] else [("skillPath", skillPath)]
        | _ => [])
  if toolName == "run_subagent" then
    let named := (items (get input "tasks")).find? fun task =>
      isObjectLike task && (str? (get task "agentId")).isSome
    let subagentId := (named.map fun task => get task "agentId").getD .null
    return shaped "subagent.run"
      (if truthy subagentId then [("subagentId", subagentId)] else [])
  return shaped "tool.call" []

/-- `policyDecisionLogMessage`. -/
def policyDecisionLog (input : Json) : String :=
  let decision := primitiveText (get input "decision")
  let action :=
    if decision == "denied" && !truthy (get input "enforced") then "would deny" else decision
  let actionPart :=
    if truthy (get input "action") then ["action " ++ primitiveText (get input "action")] else []
  let previewPart :=
    if truthy (get input "inputPreview") then ["input " ++ primitiveText (get input "inputPreview")]
    else []
  let details := String.intercalate ", " (actionPart ++ previewPart)
  let message :=
    s!"Agent policy {action} {primitiveText (get input "toolName")} ({primitiveText (get input "mode")})" ++
      (if details.isEmpty then "" else ": " ++ details)
  if truthy (get input "reason") then message ++ ": " ++ primitiveText (get input "reason")
  else message

/-- `channelPolicyIdentity`. Roles default to `[]` only when an identity exists. -/
def channelPolicyIdentity (identity : Json) : Json :=
  Json.mkObj (
    copiedIfTruthy identity "channelId" ++ copiedIfTruthy identity "threadId" ++
    copiedIfTruthy identity "userId" ++ copiedIfTruthy identity "userName" ++
    (if identity == .null then []
     else [("userRoles", match get identity "userRoles" with
        | .null => Json.arr #[]
        | roles => roles)]))

/-- The policy twins. -/
def policyTwinList : List Spec.Twin := [
  { source := "apps/core/src/harness/policy.ts#policyInputForTool"
    run := fun args =>
      match Twin.arg args 0 with
      | .str toolName =>
        match policyInputForTool toolName (Twin.arg args 1) (items (Twin.arg args 2))
            (items (get (Twin.arg args 3) "sandboxes")) with
        | some result => result
        | none => Twin.unsupported "text depends on lost key order or a non-ASCII title"
      | _ => Twin.unsupported "toolName is not a string" },
  { source := "apps/core/src/harness/policy.ts#toolContextForPolicy"
    run := fun args =>
      match policyToolContext (Twin.arg args 0) with
      | some result => result
      | none => Twin.unsupported "preview depends on lost key order" },
  { source := "apps/core/src/harness/policy.ts#sanitizePolicyToolInput"
    run := fun args =>
      match natOf? (Twin.arg args 1), Twin.arg args 1 with
      | some depth, _ => (sanitizePolicyToolInput (Twin.arg args 0) depth).getD .null
      | none, .null => (sanitizePolicyToolInput (Twin.arg args 0) 0).getD .null
      | none, _ => Twin.unsupported "depth is not a whole number" },
  { source := "apps/core/src/harness/policy.ts#sanitizePolicyValue"
    run := fun args =>
      match natOf? (Twin.arg args 1) with
      | some depth => sanitizePolicyValue 8 (Twin.arg args 0) depth
      | none => Twin.unsupported "depth is not a whole number" },
  { source := "apps/core/src/harness/policy.ts#truncatePolicyString"
    run := fun args =>
      match Twin.arg args 0 with
      | .str value => toJson (truncatePolicyString value)
      | _ => Twin.unsupported "value is not a string" },
  { source := "apps/core/src/harness/policy.ts#policyFilePath"
    run := fun args =>
      match Twin.arg args 0, Twin.arg args 1 with
      | .str path, .bool searchRoot => toJson (policyFilePath path searchRoot)
      | _, _ => Twin.unsupported "arguments are not a path and a flag" },
  { source := "apps/core/src/harness/policy.ts#formatPolicyPreviewValue"
    run := fun args => toJson (policyPreviewValue (Twin.arg args 0) "undefined") },
  { source := "apps/core/src/harness/policy.ts#formatPolicyInputPreview"
    run := fun args =>
      match policyInputPreview (Twin.arg args 0) with
      | some preview => toJson preview
      | none => Twin.unsupported "preview depends on lost key order" },
  { source := "apps/core/src/harness/policy.ts#resolveWorkspaceForPolicy"
    run := fun args =>
      (workspaceForPolicy (items (Twin.arg args 0)) (str? (Twin.arg args 1))).getD .null },
  { source := "apps/core/src/harness/policy.ts#policyDecisionLogMessage"
    run := fun args => toJson (policyDecisionLog (Twin.arg args 0)) },
  { source := "apps/core/src/harness/policy.ts#channelPolicyIdentity"
    run := fun args => channelPolicyIdentity (Twin.arg args 0) },
  { source := "apps/core/src/harness/policy.ts#enforcingMode"
    run := fun args =>
      toJson (if (items (Twin.arg args 0)).any fun document => get document "mode" == .str "enforce"
        then "enforce" else "audit") },
  { source := "apps/core/src/harness/policy.ts#approvalDecision"
    run := fun args =>
      match Twin.arg args 0 with
      | .obj fields => get (.obj fields) "type"
      | status => status },
  { source := "apps/core/src/harness/policy.ts#isPolicyEnabled"
    run := fun args => toJson (!(items (get (Twin.arg args 0) "policies")).isEmpty) },
  { source := "apps/core/src/harness/policy.ts#asSandboxToolCall"
    run := fun args =>
      match Twin.arg args 1 with
      | .null => Twin.arg args 0
      | _ => Twin.unsupported "stand-ins are a Map of callbacks" }]

end Spec.Agent
