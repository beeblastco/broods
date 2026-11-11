import Spec.Sandbox.Twins.Runtime.SandboxRules

/-!
Twins of `packages/convex/model/workspaceRules.ts`. The bucket and role checks read `process.env`, so a
call that reaches them is unsupported; `ownAuthWith` holds the whole rule with the env as a parameter.
-/

namespace Spec.Sandbox.Rt

open Lean

/-- The source path of the workspace rules. -/
def workspaceRules (name : String) : String :=
  s!"packages/convex/model/workspaceRules.ts#{name}"

/-- The platform names `workspaceStorageOwnAuth` compares against, read from `process.env`. -/
structure PlatformEnv where
  buckets : List String := []
  roleArns : List String := []
  accountId : Option String := none

/-- `^arn:[a-z-]+:iam::(\d+):role\/.+$`, giving the account id. -/
def roleArnAccount (arn : String) : Option String :=
  match arn.splitOn ":iam::" with
  | head :: rest@(_ :: _) =>
    let tail := ":iam::".intercalate rest
    let headParts := head.toList
    let partition := headParts.drop 4
    let goodHead := head.startsWith "arn:" && !partition.isEmpty &&
      partition.all (fun c => ('a' ≤ c && c ≤ 'z') || c == '-')
    let (digits, after) := tail.toList.span Char.isDigit
    let afterText := String.ofList after
    match afterText.startsWith ":role/", (String.ofList (after.drop 6)).toList with
    | true, roleName@(_ :: _) =>
      if goodHead && !digits.isEmpty && !arn.toList.any (fun c => c == '\n' || c == '\r' || c.toNat == 8232 || c.toNat == 8233) && !roleName.isEmpty then
        some (String.ofList digits)
      else none
    | _, _ => none
  | _ => none

/-- `r2AccountId`. -/
def r2AccountId (endpoint : String) : R (Option String) :=
  match parseUrl endpoint with
  | .invalid => pure none
  | .unmodelled => unsup "a URL form the parser leaves out"
  | .ok url =>
    if url.protocol != "https:" || !url.username.isEmpty || !url.password.isEmpty || !url.port.isEmpty ||
        !url.search.isEmpty || !url.hash.isEmpty || url.pathname != "/" then
      pure none
    else
      match url.hostname.splitOn "." with
      | account :: rest =>
        let tail := ".".intercalate rest
        let goodTail := tail == "r2.cloudflarestorage.com" || tail == "eu.r2.cloudflarestorage.com" ||
          tail == "fedramp.r2.cloudflarestorage.com"
        let isHex := account.length == 32 &&
          account.toList.all (fun c => ('a' ≤ c && c ≤ 'f') || ('0' ≤ c && c ≤ '9'))
        pure (if goodTail && isHex then some account else none)
      | [] => pure none

/-- The part of `workspaceStorageOwnAuth` before any env read: `some` when the arguments decide it. -/
def ownAuthBeforeEnv (storage : Json) : R (Option Json) := do
  let bucket := get storage "bucket"
  let authType := get (get storage "auth") "type"
  match get storage "endpoint" with
  | .str endpoint =>
    if !endpoint.isEmpty then
      if !truthy bucket then
        fail "config.storage.endpoint requires config.storage.bucket; the managed bucket has no custom endpoint"
      assertStorageEndpoint endpoint "config.storage.endpoint"
  | _ => pure ()
  if truthy bucket then return none
  if authType == .str "r2" then
    fail "config.storage.auth.type \"r2\" requires config.storage.bucket; R2 has no managed bucket"
  return some .null

/-- `workspaceStorageOwnAuth` past its first checks, with the platform names given. -/
def ownAuthWith (env : PlatformEnv) (storage : Json) : R Json := do
  match ← ownAuthBeforeEnv storage with
  | some decided => return decided
  | none => pure ()
  let bucket := lowerAscii ((strAt storage "bucket").getD "")
  if env.buckets.any (fun name => lowerAscii name == bucket) then
    fail "config.storage.bucket must be a bucket you own; omit it to use the managed bucket"
  let auth := get storage "auth"
  let authType := get auth "type"
  if authType == .str "r2" then
    let endpoint := (strAt storage "endpoint").getD ""
    let account ← if endpoint.isEmpty then pure none else r2AccountId endpoint
    if account.isNone then
      fail "config.storage.auth.type \"r2\" requires config.storage.endpoint to be your account R2 endpoint, https://<account id>.r2.cloudflarestorage.com"
    match opt storage "region" with
    | none | some (.str "auto") => pure ()
    | some _ => fail "config.storage.region must be \"auto\" or omitted for R2"
    return auth
  if authType != .str "assumeRole" then
    fail "config.storage.auth.type \"assumeRole\" or \"r2\" is required when config.storage.bucket is set; a named bucket is only reached with its own credentials"
  match roleArnAccount ((strAt auth "roleArn").getD "") with
  | none => fail "config.storage.auth.roleArn must be an IAM role ARN"
  | some account =>
    if env.accountId == some account || env.roleArns.any (includes · s!"::{account}:") then
      fail "config.storage.auth.roleArn must not be a role in the platform AWS account"
    return auth

/-- `workspaceStorageOwnAuth` from the arguments alone. -/
def workspaceStorageOwnAuth (storage : Json) : R Json := do
  match ← ownAuthBeforeEnv storage with
  | some decided => pure decided
  | none => unsup "a named bucket is compared with process.env"

/-- `normalizeWorkspacePrefix`. -/
def normalizeWorkspacePrefix (prefix : Option String) : String :=
  let trimmed := stripSlashes (prefix.getD "")
  if trimmed.isEmpty then "" else s!"{trimmed}/"

/-- `disabledFeature`. -/
def disabledFeature (feature : Json) : Option Json :=
  if get feature "enabled" == .bool false then some (Json.mkObj [("enabled", .bool false)]) else none

/-- `normalizeWorkspaceStorageAuth`. -/
def normalizeWorkspaceStorageAuth (value : Json) : R (Option Json) := do
  match get value "type" with
  | .str "r2" =>
    let accessKeyId := jsTrim ((strAt value "accessKeyId").getD "")
    let secretAccessKey := jsTrim ((strAt value "secretAccessKey").getD "")
    if !isEnvRef accessKeyId || !isEnvRef secretAccessKey then
      fail "config.storage.auth.accessKeyId and secretAccessKey must each be one ${NAME} env reference; workspace config never stores key values"
    pure (some (Json.mkObj [("type", .str "r2"), ("accessKeyId", .str accessKeyId),
      ("secretAccessKey", .str secretAccessKey)]))
  | .str "assumeRole" =>
    pure (some (Json.mkObj [("type", .str "assumeRole"),
      ("roleArn", .str (jsTrim ((strAt value "roleArn").getD "")))]))
  | _ => pure (if truthy value then some (Json.mkObj [("type", .str "managed")]) else none)

/-- `normalizeWorkspaceStorage`. -/
def normalizeWorkspaceStorage (value : Json) : R Json := do
  if value == .null then return Json.mkObj [("provider", .str "s3")]
  if get value "provider" == .str "disk" then
    match ["bucket", "region", "endpoint", "prefix", "auth"].find? (has value ·) with
    | some extra =>
      fail s!"config.storage.{extra} does not apply to \"disk\": its files live on the sandbox's own disk"
    | none => return Json.mkObj [("provider", .str "disk")]
  let bucket := trimmedOrNone (get value "bucket")
  let region := trimmedOrNone (get value "region")
  let endpoint := trimmedOrNone (get value "endpoint")
  let prefix := trimmedOrNone (get value "prefix")
  if bucket.isSome && (stripSlashes (prefix.getD "")).isEmpty then
    fail "config.storage.prefix is required when config.storage.bucket is set; the sandbox mount is scoped to that prefix"
  let auth ← normalizeWorkspaceStorageAuth (get value "auth")
  let roleArn := auth.bind fun item =>
    if get item "type" == .str "assumeRole" then strAt item "roleArn" else none
  let literals := [("config.storage.bucket", bucket), ("config.storage.region", region),
    ("config.storage.endpoint", endpoint), ("config.storage.prefix", prefix),
    ("config.storage.auth.roleArn", roleArn)]
  for (name, literal) in literals do
    if (literal.map hasEnvPlaceholder).getD false then
      fail s!"{name} cannot be an env reference; only R2 keys take env()"
  let storage := objOf [("provider", some ((opt value "provider").getD (.str "s3"))),
    ("bucket", bucket.map Json.str), ("region", region.map Json.str),
    ("endpoint", endpoint.map Json.str), ("prefix", prefix.map Json.str), ("auth", auth)]
  let _ ← workspaceStorageOwnAuth storage
  pure storage

/-- `STORAGE_AUTH`, the discriminated union under `config.storage.auth`. -/
def checkStorageAuth (auth : Json) : R Unit := do
  if !isObj auth then fail "config.storage.auth must be an object"
  match get auth "type" with
  | .str "managed" => pure ()
  | .str "r2" =>
    if !isNonEmptyString (get auth "accessKeyId") then
      fail "config.storage.auth.accessKeyId must be a non-empty string"
    if !isNonEmptyString (get auth "secretAccessKey") then
      fail "config.storage.auth.secretAccessKey must be a non-empty string"
  | .str "assumeRole" =>
    if !isNonEmptyString (get auth "roleArn") then
      fail "config.storage.auth.roleArn must be a non-empty string"
    if has auth "externalId" then
      fail "config.storage.auth.externalId is no longer accepted: Broods assigns the external id for your account. Remove it from the config (send null in a PATCH) and require the id from GET /v1/account/storage-trust in your role's trust policy"
  | _ => fail "config.storage.auth.type must be one of: managed, assumeRole, r2"

/-- `HARNESS_FEATURE` at `path`. -/
def checkHarnessFeature (path : String) (feature : Option Json) : R Unit := do
  match feature with
  | none => pure ()
  | some item =>
    if !isObj item then fail s!"{path} must be an object"
    checkBool s!"{path}.enabled" (opt item "enabled")

/-- `WORKSPACE_CONFIG` in its declared field order. -/
def checkWorkspaceShape (config : Json) : R Unit := do
  if !isObj config then fail "config must be an object"
  match opt config "storage" with
  | none => pure ()
  | some storage =>
    if !isObj storage then fail "config.storage must be an object"
    match opt storage "provider" with
    | some (.str "vercel") =>
      fail "config.storage.provider \"vercel\" is not supported yet; Vercel Drive workspace storage is not wired. Use \"s3\" or omit config.storage."
    | provider => checkEnum "config.storage.provider" ["s3", "disk"] provider
    for field in ["bucket", "region", "endpoint", "prefix"] do
      checkString s!"config.storage.{field}" (opt storage field)
    match opt storage "auth" with
    | none => pure ()
    | some auth => checkStorageAuth auth
  checkEnum "config.isolation" ["conversation", "agent"] (opt config "isolation")
  match opt config "harness" with
  | none => pure ()
  | some harness =>
    if !isObj harness then fail "config.harness must be an object"
    checkHarnessFeature "config.harness.workspace" (opt harness "workspace")
    checkHarnessFeature "config.harness.memory" (opt harness "memory")

/-- `normalizeWorkspaceConfig`. -/
def normalizeWorkspaceConfig (value : Json) : R Json := do
  if value == .null then return Json.mkObj [("storage", Json.mkObj [("provider", .str "s3")])]
  checkWorkspaceShape value
  let storage ← normalizeWorkspaceStorage (get value "storage")
  let workspacePrompt := disabledFeature (get (get value "harness") "workspace")
  let memory := disabledFeature (get (get value "harness") "memory")
  let harness := if workspacePrompt.isSome || memory.isSome then
      some (objOf [("workspace", workspacePrompt), ("memory", memory)])
    else none
  let isolation := if truthy (get value "isolation") then opt value "isolation" else none
  pure (objOf [("storage", some storage), ("isolation", isolation), ("harness", harness)])

/-- The twins of the workspace rules. -/
def workspaceRulesTwins : List Spec.Twin :=
  [ twin (workspaceRules "workspaceStorageOwnAuth") fun args =>
      workspaceStorageOwnAuth (Spec.Twin.arg args 0),
    twin (workspaceRules "normalizeWorkspaceStorage") fun args =>
      normalizeWorkspaceStorage (Spec.Twin.arg args 0),
    twin (workspaceRules "normalizeWorkspaceStorageAuth") fun args => do
      pure ((← normalizeWorkspaceStorageAuth (Spec.Twin.arg args 0)).getD .null),
    twin (workspaceRules "normalizeWorkspaceConfig") fun args =>
      normalizeWorkspaceConfig (Spec.Twin.arg args 0),
    twin (workspaceRules "r2AccountId") fun args => do
      match Spec.Twin.arg args 0 with
      | .str endpoint => pure (((← r2AccountId endpoint).map Json.str).getD .null)
      | _ => unsup "endpoint is not a string",
    twin (workspaceRules "disabledFeature") fun args =>
      pure ((disabledFeature (Spec.Twin.arg args 0)).getD .null),
    twin (workspaceRules "normalizeWorkspacePrefix") fun args =>
      pure (.str (normalizeWorkspacePrefix (strOf (Spec.Twin.arg args 0)))) ]

end Spec.Sandbox.Rt
