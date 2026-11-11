import Spec.Config.Twins.AgentRules

/-!
Twins of the rest of `packages/convex/model`: the agent config codec, the secret redaction, the input
schema's messages, and the small helpers around them.
-/

namespace Spec.Config

open Lean Spec.Js Spec.Zod

private def model (file name : String) : String :=
  s!"packages/convex/model/{file}.ts#{name}"

/-- `{...value}` when a config object, as `parseOr(configObject, value)`: `__proto__` is dropped. -/
def configObject? (value : Json) : Option Json :=
  match value with
  | .obj kvs => some (del (.obj kvs) "__proto__")
  | _ => none

private def spaceBeforeCaps : List Char → List Char
  | a :: b :: rest =>
    if (('a' ≤ a && a ≤ 'z') || isAsciiDigit a) && 'A' ≤ b && b ≤ 'Z' then
      a :: ' ' :: spaceBeforeCaps (b :: rest)
    else a :: spaceBeforeCaps (b :: rest)
  | other => other

private def spaceBeforeLastCap : List Char → List Char
  | a :: b :: c :: rest =>
    if 'A' ≤ a && a ≤ 'Z' && 'A' ≤ b && b ≤ 'Z' && 'a' ≤ c && c ≤ 'z' then
      a :: ' ' :: spaceBeforeLastCap (b :: c :: rest)
    else a :: spaceBeforeLastCap (b :: c :: rest)
  | other => other

/-- The words `judgeName` splits a name into. -/
def nameWords (name : String) : List String :=
  let spaced := String.ofList (spaceBeforeLastCap (spaceBeforeCaps name.toList))
  let chars := (lower spaced).toList.map fun c =>
    if ('a' ≤ c && c ≤ 'z') || isAsciiDigit c then c else ' '
  (String.ofList chars).splitOn " " |>.filter (!·.isEmpty)

/-- `secretNames.ts:judgeName`. -/
def isSecretName (name : String) : Bool :=
  let alwaysSecret := ["secret", "password", "passwd", "passphrase", "kubeconfig"]
  let lastWords := ["secret", "secrets", "password", "passwords", "credential", "credentials", "cookie",
    "cookies", "certificate", "pem", "authorization", "authentication", "auth", "bearer", "token", "tokens",
    "key", "keys", "apikey", "accesskey", "privatekey"]
  let qualifiers := ["cache", "conversation", "destination", "embeddable", "event", "idempotency", "object",
    "partition", "preview", "public", "reservation", "resource", "scope", "sort", "source", "storage",
    "unscoped"]
  let tokenCounts := ["cachecreationinputtokens", "cachedinputtokens", "cachereadtokens", "cachewritetokens",
    "inputtokens", "maxoutputtokens", "maxtokens", "nocachetokens", "outputtokens", "reasoningtokens",
    "texttokens", "totaltokens"]
  let endings := ["apikey", "accesskey", "credential", "credentials", "privatekey", "token"]
  let words := nameWords name
  match words.getLast? with
  | none => false
  | some last =>
    if tokenCounts.contains (String.join words) then false
    else if words.any (fun word => alwaysSecret.any fun part => (word.splitOn part).length > 1) then true
    else if !lastWords.contains last then endings.any (fun ending => last.endsWith ending)
    else if last != "key" && last != "keys" then true
    else match words.dropLast.getLast? with
      | some qualifier => !qualifiers.contains qualifier
      | none => false

/-- `redactSecrets`. -/
def redactSecrets : Nat → Json → Bool → Json
  | 0, value, _ => value
  | fuel + 1, value, inHeaders =>
    match value with
    | .arr items => .arr (items.map fun entry => redactSecrets fuel entry false)
    | .obj _ =>
      let object := del value "__proto__"
      let mapped := (Spec.Js.entries object).map fun (key, entry) =>
        if inHeaders then
          match entry with
          | .str s => (key, if headerRefs s then entry else .str "********")
          | _ => (key, entry)
        else if !isSecretName key then
          (key, redactSecrets fuel entry (key == "headers"))
        else
          let items := match entry with
            | .arr list => list.toList
            | single => [single]
          let exposed := items.any fun item =>
            match item with
            | .str s => !refsOnly s
            | _ => false
          (key, if exposed then .str "********" else redactSecrets fuel entry false)
      Json.mkObj mapped
    | other => other

/-- `/\$\{(name)\}/g` replaced by `variables`, where `valid` is the name rule. -/
def substituteString (valid : String → Bool) (variables : Json) (text : String) : Json :=
  let rec go : Nat → List Char → List Char → List Char
    | 0, rest, acc => acc.reverse ++ rest
    | _ + 1, [], acc => acc.reverse
    | fuel + 1, '$' :: '{' :: rest, acc =>
      let name := rest.takeWhile (· != '}')
      if rest[name.length]? == some '}' && valid (String.ofList name) then
        let key := String.ofList name
        let replaced := match field? variables key with
          | some .null | none => s!"$\{{key}}"
          | some item => (string? (some item)).getD s!"$\{{key}}"
        go fuel (rest.drop (name.length + 1)) (replaced.toList.reverse ++ acc)
      else go fuel ('{' :: rest) ('$' :: acc)
    | fuel + 1, c :: rest, acc => go fuel rest (c :: acc)
  .str (String.ofList (go (text.length + 1) text.toList []))

/-- `/[A-Z][A-Z0-9_]*/`. -/
def isAccountEnvName (name : String) : Bool :=
  envName name

/-- `/[A-Za-z_][A-Za-z0-9_]*/`. -/
def isEnvName (name : String) : Bool :=
  match name.toList with
  | first :: rest =>
    (isAsciiAlpha first || first == '_') && rest.all fun c => isAsciiAlnum c || c == '_'
  | [] => false

/-- `substitutePlaceholders`, with the regex as its name rule. -/
def substitute (valid : String → Bool) (variables : Json) : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .str s => substituteString valid variables s
    | .arr items => .arr (items.map (substitute valid variables fuel))
    | .obj kvs =>
      Json.mkObj (kvs.toList.filterMap fun (key, item) =>
        if key == "__proto__" || key == "constructor" || key == "prototype" then none
        else some (key, substitute valid variables fuel item))
    | other => other

/-- `pruneEmpty`. -/
def pruneEmpty : Nat → Json → Option Json
  | 0, value => some value
  | fuel + 1, value =>
    let cleaned := (Spec.Js.entries value).filterMap fun (key, raw) =>
      match configObject? raw with
      | some branch => (pruneEmpty fuel branch).map fun child => (key, child)
      | none => some (key, raw)
    if cleaned.isEmpty then none else some (Json.mkObj cleaned)

/-- `mergeProviderOptions`. -/
def mergeProviderOptions (base overlay : Json) : Json :=
  let start := (configObject? base).getD empty
  let over := (configObject? overlay).getD empty
  (Spec.Js.entries over).foldl (fun result (key, value) =>
    match (field? result key).bind configObject?, configObject? value with
    | some existing, some next => set result key (spread existing next)
    | _, _ => set result key value) start

/-- `buildNestedAgentBranch`. -/
def nestedAgentBranch (flat extra : Json) : Json :=
  let agent := spread empty (get extra "agent")
  let agent := setOpt agent "maxTurn" (field? flat "maxTurns")
  if truthy (get flat "systemPrompt") && !has agent "system" then
    set agent "system" (get flat "systemPrompt")
  else agent

/-- `buildNestedModelBranch`: a stored `model.options` is refused. -/
def nestedModelBranch (flat extra : Json) : Out :=
  let extraModel := get extra "model"
  let options := mergeProviderOptions (get extraModel "providerOptions") (get flat "providerOptions")
  let options := setOpt options "temperature" (field? flat "temperature")
  let options := setOpt options "maxTokens" (field? flat "maxTokens")
  let result := spread empty extraModel
  let result := if truthy (get flat "provider") then set result "provider" (get flat "provider") else result
  let result := if truthy (get flat "modelId") then set result "modelId" (get flat "modelId") else result
  if has result "options" then .threw "config.model.options is not supported" else
  let result := if (Spec.Js.entries options).isEmpty then result else set result "providerOptions" options
  .ok (setOpt result "output" (field? flat "outputFormat"))

/-- `buildNestedToolsBranch`. -/
def nestedToolsBranch (flat extra : Json) : Json :=
  let tools := spread empty (get extra "tools")
  match field? flat "searchToolEnabled" with
  | some enabled =>
    if has tools "googleSearch" then tools
    else set tools "googleSearch"
      (spread (Json.mkObj [("enabled", enabled)]) (get flat "searchToolConfig"))
  | none => tools

/-- `assembleNestedConfig`. -/
def assembleNested (extra agent model tools : Json) : Json :=
  let copyTruthy (acc : Json) (key : String) : Json :=
    if truthy (get extra key) then set acc key (get extra key) else acc
  let copyPruned (acc : Json) (key : String) (branch : Json) : Json :=
    setOpt acc key (pruneEmpty depth branch)
  let copyBool (acc : Json) (key : String) : Json :=
    if isBool (get extra key) then set acc key (get extra key) else acc
  let acc := copyPruned empty "agent" agent
  let acc := copyTruthy acc "harness"
  let acc := copyPruned acc "model" model
  let acc := ["provider", "sandboxes", "workspaces", "session", "hooks", "channels"].foldl copyTruthy acc
  let acc := copyPruned acc "tools" tools
  let acc := ["mcp", "denyTools", "skills", "subagent", "scheduler", "browser", "policies"].foldl copyTruthy acc
  copyBool (copyBool acc "publicAccess") "allowRunOverrides"

/-- `toNestedAgentConfig`. -/
def toNested (flat : Json) : Out :=
  let extra := orElse (get flat "extraConfig") empty
  (nestedModelBranch flat extra).bind fun model =>
    .ok (assembleNested extra (nestedAgentBranch flat extra) model (nestedToolsBranch flat extra))

/-- `collectExtraConfig`. -/
def collectExtra (nested agent model tools : Json) : Json :=
  let nonEmpty (branch : Json) : Bool :=
    truthy branch && match branch with
      | .obj kvs => !kvs.toList.isEmpty
      | _ => false
  let extra := if nonEmpty agent then set empty "agent" agent else empty
  let extra := if nonEmpty model then set extra "model" model else extra
  let extra := setOpt extra "workspaces" (field? nested "workspaces")
  let extra := if nonEmpty tools then set extra "tools" tools else extra
  let branches := ["harness", "provider", "sandboxes", "session", "hooks", "channels", "mcp", "denyTools",
    "skills", "subagent", "scheduler", "browser", "policies"]
  let extra := branches.foldl (fun acc branch => setOpt acc branch (field? nested branch)) extra
  let boolean (acc : Json) (key : String) : Json :=
    if isBool (get nested key) then set acc key (get nested key) else acc
  boolean (boolean extra "publicAccess") "allowRunOverrides"

/-- `REMOVED_BRANCH_HINTS`, in its order. -/
def removedBranchHints : List (String × String) :=
  [("policy", policyRemovedMessage), ("sandbox", sandboxRemovedMessage),
   ("workspace", "config.workspace is no longer supported; reference workspace records instead with " ++
     "config.workspaces: [{ name, workspaceId }] and set the agent machine with config.sandboxes: [\"sb_…\"]")]

/-- `fromNestedAgentConfig`, with the extract helpers' edits as returned values. -/
def fromNested (nested : Json) : Out :=
  let agent? := configObject? (get nested "agent")
  let model? := configObject? (get nested "model")
  let options? := model?.bind fun model => configObject? (get model "providerOptions")
  let tools? := configObject? (get nested "tools")
  match removedBranchHints.find? (fun hint => has nested hint.1) with
  | some (_, hint) => .threw hint
  | none =>
    let patch := empty
    let (patch, agent?) := match agent? with
      | none => (patch, agent?)
      | some agent =>
        let (patch, agent) := if isNum (get agent "maxTurn")
          then (set patch "maxTurns" (get agent "maxTurn"), del agent "maxTurn") else (patch, agent)
        let (patch, agent) := if isStr (get agent "system")
          then (set patch "systemPrompt" (get agent "system"), del agent "system") else (patch, agent)
        (patch, some agent)
    let (patch, model?) := match model? with
      | none => (patch, model?)
      | some model =>
        let (patch, model) := if isStr (get model "provider")
          then (set patch "provider" (get model "provider"), del model "provider") else (patch, model)
        let (patch, model) := if isStr (get model "modelId")
          then (set patch "modelId" (get model "modelId"), del model "modelId") else (patch, model)
        let (patch, model) := match field? model "output" with
          | none => (patch, model)
          | some .null => (patch, del model "output")
          | some output => (set patch "outputFormat" output, del model "output")
        match options? with
        | none => (patch, some model)
        | some options =>
          let (patch, options) := if isNum (get options "temperature")
            then (set patch "temperature" (get options "temperature"), del options "temperature")
            else (patch, options)
          let (patch, options) := if isNum (get options "maxTokens")
            then (set patch "maxTokens" (get options "maxTokens"), del options "maxTokens")
            else (patch, options)
          let patch := if (Spec.Js.entries options).isEmpty then patch else set patch "providerOptions" options
          (patch, some (del model "providerOptions"))
    let google? := tools?.bind fun tools => configObject? (get tools "googleSearch")
    let patch := match google? with
      | none => patch
      | some search =>
        let (patch, search) := if isBool (get search "enabled")
          then (set patch "searchToolEnabled" (get search "enabled"), del search "enabled") else (patch, search)
        if (Spec.Js.entries search).isEmpty then patch else set patch "searchToolConfig" search
    .ok (set patch "extraConfig"
      (collectExtra nested (agent?.getD .null) (model?.getD .null) (tools?.getD .null)))

/-- A recorded zod schema's `def`, translated when it holds only what the JSON keeps. -/
def schemaOfDef : Nat → Json → Option Schema
  | 0, _ => none
  | fuel + 1, schema =>
    let definition := get schema "def"
    if has definition "checks" then none else
    match get definition "type" with
    | .str "unknown" => some .unknown
    | .str "string" => some (.string none)
    | .str "boolean" => some .bool
    | .str "number" => some (.number none)
    | .str "optional" => (schemaOfDef fuel (get definition "innerType")).map .optional
    | .str "nullable" => (schemaOfDef fuel (get definition "innerType")).map .nullable
    | .str "array" => (schemaOfDef fuel (get definition "element")).map .array
    | .str "record" =>
      match schemaOfDef fuel (get definition "keyType"), schemaOfDef fuel (get definition "valueType") with
      | some key, some value => some (.record key value none)
      | _, _ => none
    | .str "object" =>
      let shape := (Spec.Js.entries (get definition "shape")).mapM fun (key, inner) =>
        (schemaOfDef fuel inner).map fun parsed => (key, parsed)
      match shape, get (get (get definition "catchall") "def") "type" with
      | some fields, .str "unknown" => some (.object false fields none)
      | some fields, .str "never" => some (.object true fields none)
      | _, _ => none
    | _ => none

/-- `parseOr`: the recorded value, or the fallback. An `Error` records as `{}`, so object schemas
cannot tell it from an empty object and leave that case uncompared. -/
def parseOrTwin : Spec.Twin where
  source := model "storedJson" "parseOr"
  run := fun args =>
    let schema := Spec.Twin.arg args 0
    let value := Spec.Twin.arg args 1
    match schemaOfDef 16 schema with
    | none => Spec.Twin.unsupported "schema is not expressible from its recorded def"
    | some parsed =>
      if value == empty && get (get schema "def") "type" == .str "object" then
        Spec.Twin.unsupported "an Error records as an empty object"
      else match run 64 parsed (some value) with
        | .ok output => output.getD .null
        | .bad _ => Spec.Twin.arg args 2
        | .unknown reason => Spec.Twin.unsupported reason

def parseInputTwin : Spec.Twin where
  source := model "inputSchema" "parseInput"
  run := fun args =>
    match schemaOfDef 16 (Spec.Twin.arg args 0), Spec.Twin.arg args 2 with
    | some parsed, .str root => (parseInput parsed (present (Spec.Twin.arg args 1)) root).json
    | _, _ => Spec.Twin.unsupported "schema is not expressible from its recorded def"

/-- The recorded path as `Spec.Zod` steps. -/
def pathOfJson (path : Json) : Option (List Seg) :=
  (arr? path).bind fun items =>
    items.mapM fun item =>
      match item with
      | .str name => some (.key name)
      | other => (nat? other).map .index

def renderPathTwin : Spec.Twin where
  source := model "inputSchema" "renderPath"
  run := fun args =>
    match Spec.Twin.arg args 0, pathOfJson (Spec.Twin.arg args 1) with
    | .str root, some path => .str (renderPath root path)
    | _, _ => Spec.Twin.unsupported "path holds a symbol or root is not a string"

/-- `issueSentence` on a recorded issue. -/
def issueSentenceOf : Nat → Json → String → Option String
  | 0, _, _ => none
  | fuel + 1, issue, root =>
    let branch :=
      if get issue "code" == .str "invalid_union" then
        ((arr? (get issue "errors")).getD []).findSome? fun errors =>
          ((arr? errors).getD []).head?.bind fun first =>
            let rootType := get first "code" == .str "invalid_type" &&
              ((arr? (get first "path")).getD []).isEmpty
            if rootType then none else some first
      else none
    match branch with
    | some first =>
      let path := ((arr? (get issue "path")).getD []) ++ ((arr? (get first "path")).getD [])
      issueSentenceOf fuel (set first "path" (.arr path.toArray)) root
    | none =>
      let path := (pathOfJson (orElse (get issue "path") (.arr #[]))).getD []
      let message := match get issue "message" with
        | .str text => text
        | _ => "is invalid"
      some (sentence { code := "", path := path, message := message } root)

def issueSentenceTwin : Spec.Twin where
  source := model "inputSchema" "issueSentence"
  run := fun args =>
    match Spec.Twin.arg args 1 with
    | .str root =>
      match issueSentenceOf 16 (Spec.Twin.arg args 0) root with
      | some text => .str text
      | none => Spec.Twin.unsupported "issue nests too deep"
    | _ => Spec.Twin.unsupported "root is not a string"

/-- `Array.prototype.join` of JSON values. -/
def joinValues (items : List Json) (separator : String) : Option String :=
  (items.mapM fun (item : Json) =>
    match item with
    | Json.null => some ""
    | other => string? (some other)).map (separator.intercalate ·)

def defaultMessageTwin : Spec.Twin where
  source := model "inputSchema" "defaultMessage"
  run := fun args =>
    let issue := Spec.Twin.arg args 0
    match get issue "code" with
    | .str "invalid_value" =>
      match joinValues ((arr? (get issue "values")).getD []) ", " with
      | some values => .str s!"must be one of: {values}"
      | none => Spec.Twin.unsupported "value has no plain string form"
    | .str "invalid_key" =>
      match ((arr? (get issue "issues")).getD []).head?.bind (field? · "message") with
      | some (.str message) => .str message
      | _ => .str "is invalid"
    | .str "unrecognized_keys" =>
      match (arr? (get issue "keys")).bind List.head? with
      | some (.str key) => .str s!"has unknown option \"{key}\""
      | _ => Spec.Twin.unsupported "keys is empty"
    | .str "invalid_type" =>
      match get issue "expected" with
      | .str expected => .str (typeMessage expected)
      | _ => Spec.Twin.unsupported "expected is not a string"
    | _ => .str "is invalid"

def mergeConfigValueTwin : Spec.Twin where
  source := model "configValues" "mergeConfigValue"
  run := fun args =>
    let existing := present (Spec.Twin.arg args 0)
    (mergeConfigValue depth existing (some (Spec.Twin.arg args 1))).getD .null

def mergeConfigObjectsTwin : Spec.Twin where
  source := model "configValues" "mergeConfigObjects"
  run := fun args => mergeConfigObjects (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)

def redactSecretsTwin : Spec.Twin where
  source := model "configValues" "redactSecrets"
  run := fun args => redactSecrets depth (Spec.Twin.arg args 0) (truthy (Spec.Twin.arg args 1))

def redactConfigSecretsTwin : Spec.Twin where
  source := model "configValues" "redactConfigSecrets"
  run := fun args => redactSecrets depth (Spec.Twin.arg args 0) false

def assembleNestedConfigTwin : Spec.Twin where
  source := model "agentConfigCodec" "assembleNestedConfig"
  run := fun args =>
    assembleNested (Spec.Twin.arg args 0) (Spec.Twin.arg args 1) (Spec.Twin.arg args 2) (Spec.Twin.arg args 3)

def collectExtraConfigTwin : Spec.Twin where
  source := model "agentConfigCodec" "collectExtraConfig"
  run := fun args =>
    collectExtra (Spec.Twin.arg args 0) (Spec.Twin.arg args 1) (Spec.Twin.arg args 2) (Spec.Twin.arg args 3)

/-- The recorded `RegExp` is `{}`, so the answer is given only when both of the code's patterns agree. -/
def substitutePlaceholdersTwin : Spec.Twin where
  source := model "agentConfigCodec" "substitutePlaceholders"
  run := fun args =>
    let config := Spec.Twin.arg args 0
    let variables := Spec.Twin.arg args 1
    let account := substitute isAccountEnvName variables depth config
    let general := substitute isEnvName variables depth config
    if account == general then account
    else Spec.Twin.unsupported "the two patterns differ here and the recorded RegExp is empty"

def substituteAccountEnvPlaceholdersTwin : Spec.Twin where
  source := model "agentConfigCodec" "substituteAccountEnvPlaceholders"
  run := fun args => substitute isAccountEnvName (Spec.Twin.arg args 1) depth (Spec.Twin.arg args 0)

def pruneEmptyTwin : Spec.Twin where
  source := model "agentConfigCodec" "pruneEmpty"
  run := fun args => (pruneEmpty depth (Spec.Twin.arg args 0)).getD .null

def mergeProviderOptionsTwin : Spec.Twin where
  source := model "agentConfigCodec" "mergeProviderOptions"
  run := fun args => mergeProviderOptions (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)

def buildNestedAgentBranchTwin : Spec.Twin where
  source := model "agentConfigCodec" "buildNestedAgentBranch"
  run := fun args => nestedAgentBranch (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)

def buildNestedModelBranchTwin : Spec.Twin where
  source := model "agentConfigCodec" "buildNestedModelBranch"
  run := fun args => (nestedModelBranch (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)).json

def buildNestedToolsBranchTwin : Spec.Twin where
  source := model "agentConfigCodec" "buildNestedToolsBranch"
  run := fun args => nestedToolsBranch (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)

def toNestedAgentConfigTwin : Spec.Twin where
  source := model "agentConfigCodec" "toNestedAgentConfig"
  run := fun args => (toNested (Spec.Twin.arg args 0)).json

def fromNestedAgentConfigTwin : Spec.Twin where
  source := model "agentConfigCodec" "fromNestedAgentConfig"
  run := fun args => (fromNested (Spec.Twin.arg args 0)).json

def assertNoUnsupportedKeysTwin : Spec.Twin where
  source := model "agentConfigCodec" "assertNoUnsupportedKeys"
  run := fun args =>
    match arr? (Spec.Twin.arg args 1), Spec.Twin.arg args 2 with
    | some keys, .str path =>
      match (keys.filterMap str?).find? (has (Spec.Twin.arg args 0)) with
      | some key => Spec.Twin.threw s!"{path}.{key} is not supported"
      | none => .null
    | _, _ => Spec.Twin.unsupported "keys or path missing"

def sortJson : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .arr items => .arr (items.map (sortJson fuel))
    | .obj kvs => Json.mkObj (kvs.toList.map fun (key, item) => (key, sortJson fuel item))
    | other => other

def sortJsonTwin : Spec.Twin where
  source := model "objects" "sortJson"
  run := fun args => sortJson depth (Spec.Twin.arg args 0)

/-- `stableJson`. A recorded null can be undefined, whose answer is undefined, not `"null"`. -/
def stableJsonTwin : Spec.Twin where
  source := model "objects" "stableJson"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .null => Spec.Twin.unsupported "null and undefined record alike"
    | value => .str (stringify (sortJson depth value))

def stripUndefinedTwin : Spec.Twin where
  source := model "objects" "stripUndefined"
  run := fun args => Json.mkObj (Spec.Js.entries (Spec.Twin.arg args 0))

def apiErrorBodyTwin : Spec.Twin where
  source := model "apiError" "apiErrorBody"
  run := fun args =>
    match int? (Spec.Twin.arg args 0), Spec.Twin.arg args 1 with
    | some status, .str message =>
      let init := Spec.Twin.arg args 2
      let (code, kind) := apiStatus status
      let error := Json.mkObj
        [("message", .str message), ("type", .str kind), ("code", orElse (get init "code") (.str code))]
      Json.mkObj [("error", setOpt error "param" (field? init "param"))]
    | _, _ => Spec.Twin.unsupported "status is not an integer or message is not a string"

def byStatusTwin : Spec.Twin where
  source := model "apiError" "byStatus"
  run := fun args =>
    match int? (Spec.Twin.arg args 0) with
    | some status =>
      let (code, kind) := apiStatus status
      Json.mkObj [("code", .str code), ("type", .str kind)]
    | none => Spec.Twin.unsupported "status is not an integer"

def rateLimitHeadersTwin : Spec.Twin where
  source := model "httpJson" "rateLimitHeaders"
  run := fun args =>
    match int? (Spec.Twin.arg args 0), Spec.Twin.arg args 1 with
    | some limit, .num reset => (rateHeaders limit (ceil reset)).json
    | _, _ => Spec.Twin.unsupported "limit or reset is not a number"

/-- `clientErrorData`. A recorded error keeps its `name` and `data`, and only a `ConvexError` passes. -/
def clientErrorDataTwin : Spec.Twin where
  source := model "clientError" "clientErrorData"
  run := fun args =>
    let error := Spec.Twin.arg args 0
    let data := get error "data"
    if get error "name" != .str "ConvexError" then .null
    else match field? data "code", field? data "message" with
      | some (.str code), some (.str message) =>
        if (clientStatus code).isSome then
          Json.mkObj [("code", .str code), ("message", .str message)]
        else .null
      | _, _ => .null

def isClientErrorCodeTwin : Spec.Twin where
  source := model "clientError" "isClientErrorCode"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str code => toJson (clientStatus code).isSome
    | _ => toJson false

def workspaceOnLaterSandboxTwin : Spec.Twin where
  source := model "sandboxMounts" "workspaceOnLaterSandbox"
  run := fun args =>
    match arr? (Spec.Twin.arg args 0), nat? (Spec.Twin.arg args 1) with
    | some sandboxes, some index =>
      (workspaceOnLater sandboxes index (Spec.Twin.arg args 2)).getD .null
    | _, _ => Spec.Twin.unsupported "sandboxes or index is not usable"

/-- `(?:import\s+(?:[^;"'`]*?\s+from\s*)?["']`, the start both import patterns share. -/
private def importClause : Re :=
  let quoteChar := fun c => c == '"' || c == '\''
  let clause := Re.seqs [.star (.any fun c => c != ';' && !quoteChar c && c != '`') false, .plus reSpace,
    .lit "from", .star reSpace true]
  Re.seqs [.lit "import", .plus reSpace, .opt clause, .any quoteChar]

/-- `import\s*\(\s*["']`. -/
private def dynamicImportOpen : Re :=
  Re.seqs [.lit "import", .star reSpace true, .lit "(", .star reSpace true, .any (fun c => c == '"' || c == '\'')]

/-- `(?!\.{1,2}\/|\/|node:)[^"']+["']`. -/
private def bareTarget : Re :=
  let quoteChar := fun c => c == '"' || c == '\''
  let relative := Re.alt (Re.seqs [.lit ".", .opt (.lit "."), .lit "/"]) (.alt (.lit "/") (.lit "node:"))
  Re.seqs [.notAhead relative, .plus (.any fun c => !quoteChar c), .any quoteChar]

def isIdentifierPart (c : Char) : Bool :=
  c == '.' || c == '$' || c == '_' || isAsciiAlnum c

/-- `NODE_ONLY_PATTERNS`, in the code's order. -/
def nodeOnlyPatterns : List Re :=
  [Re.seqs [.wordB, .opt (.lit "__"), .lit "require", .star reSpace true, .lit "("],
   Re.seqs [.notBack isIdentifierPart, .lit "setImmediate", .star reSpace true, .lit "("],
   .alt (Re.seqs [importClause, .lit "node:"]) (Re.seqs [dynamicImportOpen, .lit "node:"]),
   Re.seqs [.notBack isIdentifierPart, .alt (.lit "process") (.lit "Buffer"), .star reSpace true,
     .alt (.lit "?.") (.alt (.lit ".") (.lit "["))],
   Re.seqs [.wordB, .lit "__dirname", .wordB],
   .alt
     (Re.seqs [.alt .bol (.any fun c => c == '\n' || c == ';'), .star reSpace true, importClause, bareTarget])
     (Re.seqs [dynamicImportOpen, bareTarget, .star reSpace true, .lit ")"])]

/-- `DYNAMIC_CODE_PATTERN`. -/
def dynamicCodePattern : Re :=
  .alt (Re.seqs [.notBack isIdentifierPart, .lit "eval", .star reSpace true, .lit "("])
    (Re.seqs [.wordB, .lit "new", .plus reSpace, .lit "Function", .star reSpace true, .lit "("])

def isWorkersSafeBundleTwin : Spec.Twin where
  source := model "isolateSafety" "isWorkersSafeBundle"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str bundle => toJson (!(nodeOnlyPatterns ++ [dynamicCodePattern]).any (Re.test · bundle))
    | _ => Spec.Twin.unsupported "bundle is not a string"

/-- `resolveRequestId`: an id that fails the pattern is replaced by a random UUID, out of reach. -/
def resolveRequestIdTwin : Spec.Twin where
  source := model "requestId" "resolveRequestId"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str inbound =>
      if requestIdValid inbound then .str inbound
      else Spec.Twin.unsupported "a random UUID replaces it"
    | _ => Spec.Twin.unsupported "a random UUID replaces it"

def bytesToBase64UrlTwin : Spec.Twin where
  source := model "envelope" "bytesToBase64Url"
  run := fun args =>
    match (arr? (get (Spec.Twin.arg args 0) "data")).bind (·.mapM nat?) with
    | some bytes => .str (String.ofList (base64UrlEncode bytes))
    | none => Spec.Twin.unsupported "bytes are not a recorded Buffer"

def blobKeyIdTwin : Spec.Twin where
  source := model "envelope" "blobKeyId"
  run := fun args =>
    match get (Spec.Twin.arg args 0) "ciphertext" with
    | .str ciphertext =>
      match blobKeyId ciphertext with
      | some keyId => .str keyId
      | none => .null
    | _ => Spec.Twin.unsupported "ciphertext is not a string"

def wrapAadTwin : Spec.Twin where
  source := model "envelope" "wrapAad"
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
    | .str accountId, .str keyId => .str s!"{accountId}:{keyId}"
    | _, _ => Spec.Twin.unsupported "account or key id is not a string"

def kekIdOfTwin : Spec.Twin where
  source := model "envelope" "kekIdOf"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str secret => .str (String.ofList ((sha256Hex secret).toList.take 8))
    | _ => Spec.Twin.unsupported "secret is not a string"

/-- The twins in this file. -/
def restTwins : List Spec.Twin :=
  [renderPathTwin, issueSentenceTwin,
   mergeConfigValueTwin, mergeConfigObjectsTwin, redactSecretsTwin, redactConfigSecretsTwin,
   assembleNestedConfigTwin, collectExtraConfigTwin,
   substituteAccountEnvPlaceholdersTwin, pruneEmptyTwin, mergeProviderOptionsTwin,
   buildNestedAgentBranchTwin, buildNestedModelBranchTwin, buildNestedToolsBranchTwin,
   toNestedAgentConfigTwin, fromNestedAgentConfigTwin, assertNoUnsupportedKeysTwin, sortJsonTwin,
   stableJsonTwin, stripUndefinedTwin, apiErrorBodyTwin, byStatusTwin, rateLimitHeadersTwin,
   isClientErrorCodeTwin, isWorkersSafeBundleTwin,
   wrapAadTwin, kekIdOfTwin]

end Spec.Config
