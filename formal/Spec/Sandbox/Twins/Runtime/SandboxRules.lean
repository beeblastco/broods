import Spec.Sandbox.Twins.Runtime.Basics

/-!
Twins of `packages/convex/model/sandboxRules.ts` and `sandboxProviders.ts`. Limits are read at their
defaults: the code's constants, with `WORKSPACE_SANDBOX_*` unset.
-/

namespace Spec.Sandbox.Rt

open Lean

/-- The source path of the sandbox rules. -/
def sandboxRules (name : String) : String :=
  s!"packages/convex/model/sandboxRules.ts#{name}"

def sandboxProviderNames : List String :=
  ["sandbox", "lambda", "e2b", "daytona", "vercel", "cloudflare", "worker", "machine", "custom"]

def statelessProviders : List String := ["machine", "custom"]

def platformWorkerProviders : List String := ["cloudflare", "worker"]

def snapshotProviders : List String := ["sandbox", "lambda", "daytona", "e2b", "vercel"]

def mountFlagProviders : List String := ["daytona", "sandbox"]

def platformOptionKeys : List String := ["reservationKey", "workspaceRoot"]

def retiredImageOptions (provider : String) : List String :=
  match provider with
  | "daytona" => ["snapshot"]
  | "e2b" => ["template", "templateId"]
  | "vercel" => ["image", "runtime"]
  | _ => []

def providerMaxIdle (provider : String) : Option Nat :=
  match provider with
  | "cloudflare" => some (6 * 60 * 60)
  | "vercel" => some (24 * 60 * 60)
  | _ => none

/-! ## Input schema -/

/-- `z.optional(z.enum(values))` at `path`. -/
def checkEnum (path : String) (values : List String) (value : Option Json) : R Unit :=
  match value with
  | none => pure ()
  | some (.str text) =>
    if values.contains text then pure ()
    else fail s!"{path} must be one of: {", ".intercalate values}"
  | some _ => fail s!"{path} must be one of: {", ".intercalate values}"

/-- `z.optional(z.boolean())` at `path`. -/
def checkBool (path : String) (value : Option Json) : R Unit :=
  match value with
  | none | some (.bool _) => pure ()
  | some _ => fail s!"{path} must be a boolean"

/-- `z.optional(z.string())` at `path`. -/
def checkString (path : String) (value : Option Json) : R Unit :=
  match value with
  | none | some (.str _) => pure ()
  | some _ => fail s!"{path} must be a string"

/-- A string holding something other than whitespace. -/
def isNonEmptyString (value : Json) : Bool :=
  match value with
  | .str text => !(jsTrim text).isEmpty
  | _ => false

/-- An array's items, when the value is one. -/
def arrayOf (value : Json) : Option (List Json) :=
  match value with
  | .arr items => some items.toList
  | _ => none

/-- Zod drops an own `__proto__` key from a record without checking it. -/
def refuseProtoKey (value : Json) : R Unit :=
  if has value "__proto__" then unsup "an own __proto__ key" else pure ()

/-- `z.optional(POSITIVE_INTEGER)` at `path`. -/
def checkPositive (path : String) (value : Option Json) : R Unit :=
  match value with
  | none => pure ()
  | some item =>
    if isPositiveSafeInt item then pure () else fail s!"{path} must be a positive integer"

/-- `boundedPositiveInteger(max)` at `path`. -/
def checkBounded (path : String) (max : Nat) (value : Option Json) : R Unit := do
  checkPositive path value
  match value with
  | some (.num number) =>
    if numLe number (numOfInt max) then pure ()
    else fail s!"{path} must be an integer from 1 to {max}"
  | _ => pure ()

/-- `SANDBOX_CONFIG_INPUT.network`. -/
def checkNetworkShape (value : Option Json) : R Unit := do
  match value with
  | none => pure ()
  | some network =>
    if !isObj network then fail "config.network must be an object"
    checkEnum "config.network.mode" ["allow-all", "deny-all", "restricted"] (opt network "mode")
    for field in ["allowDomains", "allowCidrs"] do
      match opt network field with
      | none => pure ()
      | some list =>
        match arrayOf list with
        | some items =>
          if !items.all isNonEmptyString then
            fail s!"config.network.{field} must be an array of non-empty strings"
        | none => fail s!"config.network.{field} must be an array of non-empty strings"

/-- `HOOK_LIST` at `path`. -/
def checkHookList (path : String) (value : Option Json) : R Unit :=
  match value with
  | none => pure ()
  | some list =>
    match arrayOf list with
    | some items =>
      if !items.isEmpty && items.all isNonEmptyString then pure ()
      else fail s!"{path} must be a non-empty array of non-empty strings"
    | none => fail s!"{path} must be a non-empty array of non-empty strings"

/-- `SANDBOX_CONFIG_INPUT` in its declared field order, which decides the first issue. -/
def checkConfigShape (config : Json) : R Unit := do
  if !isObj config then fail "config must be an object"
  checkEnum "config.provider" sandboxProviderNames (opt config "provider")
  checkEnum "config.fallbackProvider" sandboxProviderNames (opt config "fallbackProvider")
  checkEnum "config.permissionMode" ["edit", "ask", "bypass"] (opt config "permissionMode")
  checkEnum "config.size" ["tiny", "xsmall", "small", "medium", "large"] (opt config "size")
  checkBool "config.persistent" (opt config "persistent")
  checkString "config.snapshot" (opt config "snapshot")
  checkEnum "config.image" ["browser", "obscura"] (opt config "image")
  checkNetworkShape (opt config "network")
  match opt config "lifecycle" with
  | none => pure ()
  | some lifecycle =>
    if !isObj lifecycle then fail "config.lifecycle must be an object"
    checkBounded "config.lifecycle.idleTimeoutSeconds" (7 * 24 * 60 * 60) (opt lifecycle "idleTimeoutSeconds")
    checkBounded "config.lifecycle.maxLifetimeSeconds" (30 * 24 * 60 * 60) (opt lifecycle "maxLifetimeSeconds")
  checkHookList "config.onCreate" (opt config "onCreate")
  checkHookList "config.onResume" (opt config "onResume")
  match opt config "runtimes" with
  | none => pure ()
  | some list =>
    let error := "config.runtimes must be a non-empty array of: bash, python, node"
    match arrayOf list with
    | some items =>
      let known := fun item : Json =>
        match item with
        | .str text => ["bash", "python", "node"].contains text
        | _ => false
      if items.isEmpty || !items.all known then fail error
    | none => fail error
  checkPositive "config.timeout" (opt config "timeout")
  checkPositive "config.outputLimitBytes" (opt config "outputLimitBytes")
  match opt config "envVars" with
  | none => pure ()
  | some vars =>
    let error := "config.envVars must be an object with string values"
    if !isObj vars then fail error
    refuseProtoKey vars
    if !(entries vars).all (fun entry => (strOf entry.2).isSome) then fail error
  match opt config "options" with
  | none => pure ()
  | some options =>
    if !isObj options then fail "config.options must be an object"
    refuseProtoKey options

/-! ## Rules -/

/-- `assertImage`. -/
def assertImage (image provider fallbackProvider : Json) : R Unit := do
  if image == .null then return
  if provider != .str "lambda" then fail "config.image applies to the lambda provider only"
  if fallbackProvider != .null then
    fail "config.image cannot be set with config.fallbackProvider: the fallback provider has no platform image variants"

/-- `normalizeNetwork`, over a network already past the schema. -/
def normalizeNetwork (value : Option Json) : R Json := do
  match value with
  | none => pure (Json.mkObj [("mode", .str "deny-all")])
  | some network =>
    let mode := (strAt network "mode").getD "deny-all"
    let trimList := fun field =>
      (opt network field).map fun list =>
        Json.arr (((arrayOf list).getD []).map fun entry =>
          .str (jsTrim ((strOf entry).getD ""))).toArray
    let allowDomains := trimList "allowDomains"
    let allowCidrs := trimList "allowCidrs"
    if mode != "restricted" && (allowDomains.isSome || allowCidrs.isSome) then
      fail "config.network.allowDomains and config.network.allowCidrs are only valid when config.network.mode is restricted"
    pure (objOf [("mode", some (.str mode)), ("allowDomains", allowDomains), ("allowCidrs", allowCidrs)])

/-- `assertNetworkEnforceable`. -/
def assertNetworkEnforceable (provider : String) (network : Json) : R Unit := do
  let mode := get network "mode"
  if (provider == "e2b" || statelessProviders.contains provider) && mode != .str "allow-all" then
    fail s!"{provider} cannot enforce egress restrictions; set config.network.mode to allow-all explicitly"
  if platformWorkerProviders.contains provider && mode == .str "restricted" then
    fail s!"{provider} can only turn a sandbox's internet on or off; use config.network.mode deny-all or allow-all"
  if provider == "lambda" && mode == .str "restricted" &&
      (truthy (get network "allowDomains") || truthy (get network "allowCidrs")) then
    fail "lambda (MicroVM) cannot enforce per-sandbox allowlists: its egress connector is fixed at deploy time; use config.network.mode deny-all or allow-all"

/-- `assertResourceLimits`, with the limits at their defaults. -/
def assertResourceLimits (config : Json) (provider : String) : R Unit := do
  let maxTimeout : Nat := if provider == "worker" then 60 else 600
  let check := fun (name : String) (max : Nat) => do
    match opt config name with
    | some (.num number) =>
      if !numLe number (numOfInt max) then
        fail (α := Unit) s!"config.{name} must be an integer from 1 to {max}"
    | _ => pure ()
  check "timeout" maxTimeout
  check "outputLimitBytes" (256 * 1024)

/-- `assertStatelessProviderFields`. -/
def assertStatelessProviderFields (config : Json) (provider : String) : R Unit := do
  if !statelessProviders.contains provider then return
  for field in ["persistent", "size"] do
    if has config field then fail s!"config.{field} does not apply to the {provider} provider"

/-- `assertWorkerLifecycle`. -/
def assertWorkerLifecycle (config : Json) (provider : String) (lifecycle : Option Json) : R Unit := do
  if !platformWorkerProviders.contains provider then return
  for field in ["onCreate", "onResume"] do
    if has config field then
      fail s!"config.{field} is not supported by the {provider} provider; the Worker sets the machine"
  if provider == "worker" then
    if lifecycle.isSome then
      fail "config.lifecycle is not supported by the worker provider: nothing runs between commands, and stored files stay until the sandbox is terminated"
    return
  if (lifecycle.bind (opt · "maxLifetimeSeconds")).isSome then
    fail "config.lifecycle.maxLifetimeSeconds is not supported by the cloudflare provider"

/-- A lifecycle as zod's `z.object` returns it: only its two known keys. -/
def stripLifecycle (lifecycle : Json) : Json :=
  objOf [("idleTimeoutSeconds", opt lifecycle "idleTimeoutSeconds"),
    ("maxLifetimeSeconds", opt lifecycle "maxLifetimeSeconds")]

/-- `normalizePersistentFields`. -/
def normalizePersistentFields (config : Json) (provider : String) : R (List (String × Option Json)) := do
  let lifecycle := opt config "lifecycle"
  let persistent := get config "persistent" == .bool true
  if lifecycle.isSome && !persistent then
    fail "config.lifecycle requires config.persistent to be true"
  let trimHooks := fun (field : String) =>
    (opt config field).map fun list =>
      Json.arr (((arrayOf list).getD []).map fun entry =>
        .str (jsTrim ((strOf entry).getD ""))).toArray
  let onCreate := trimHooks "onCreate"
  let onResume := trimHooks "onResume"
  if (onCreate.isSome || onResume.isSome) && !persistent then
    fail "config.onCreate and config.onResume require config.persistent to be true"
  assertWorkerLifecycle config provider lifecycle
  match providerMaxIdle provider, lifecycle.bind (opt · "idleTimeoutSeconds") with
  | some maxIdle, some (.num idle) =>
    if !numLe idle (numOfInt maxIdle) then
      fail s!"config.lifecycle.idleTimeoutSeconds must be at most {maxIdle} on the {provider} provider"
  | _, _ => pure ()
  if provider == "e2b" && (onCreate.isSome || onResume.isSome) then
    fail "config.onCreate and config.onResume are not supported by the e2b provider; use an E2B template or run setup commands explicitly"
  pure [("lifecycle", lifecycle.map stripLifecycle), ("onCreate", onCreate), ("onResume", onResume)]

/-- `requireString`. -/
def requireString (value : Json) (name : String) : R String :=
  match value with
  | .str text =>
    if (jsTrim text).isEmpty then fail s!"{name} must be a non-empty string" else pure (jsTrim text)
  | _ => fail s!"{name} must be a non-empty string"

/-- `optionalString`. -/
def optionalString (value : Option Json) (name : String) : R (Option String) :=
  match value with
  | none => pure none
  | some (.str text) =>
    let trimmed := jsTrim text
    pure (if trimmed.isEmpty then none else some trimmed)
  | some _ => fail s!"{name} must be a string"

/-- workspaceRules.ts `isClusterEndpoint`. -/
def isClusterEndpoint (value : String) : R Bool :=
  match parseUrl value with
  | .invalid => pure false
  | .unmodelled => unsup "a URL form the parser leaves out"
  | .ok url =>
    pure (["http:", "https:"].contains url.protocol &&
      (isPrivateHostname url.hostname ||
        !url.hostname.toList.any (fun c => c == '.' || c == ':')))

/-- workspaceRules.ts `assertStorageEndpoint`. A cluster endpoint passes or fails on
`ALLOW_PRIVATE_STORAGE_ENDPOINTS`, unless the public check would pass it anyway. -/
def assertStorageEndpoint (value label : String) : R Unit := do
  let cluster ← isClusterEndpoint value
  match ← publicHttpsUrlProblem value with
  | none => pure ()
  | some problem =>
    if cluster then unsup "ALLOW_PRIVATE_STORAGE_ENDPOINTS decides a cluster endpoint"
    else fail s!"{label} {problem}"

/-- `assertNoRetiredImageOptions`. -/
def assertNoRetiredImageOptions (provider : String) (options : Json) : R Unit := do
  for key in retiredImageOptions provider do
    if has options key then
      fail s!"config.options.{key} was removed; set config.snapshot to pick what a {provider} sandbox boots from"

/-- `validateProviderOptions`. `Object.keys` order is lost in Lean's JSON, so two refused keys are not
decided here. -/
def validateProviderOptions (provider : String) (options snapshot : Json) : R Unit := do
  if has options "docker" then
    match get options "docker" with
    | .bool _ => pure ()
    | _ => fail "config.options.docker must be a boolean"
    if provider != "sandbox" then fail "config.options.docker is only supported by the sandbox provider"
  if provider == "lambda" || platformWorkerProviders.contains provider then
    match (entries options).filter (fun entry => !platformOptionKeys.contains entry.1) with
    | [] => pure ()
    | [(key, _)] => fail s!"config.options.{key} is not supported in account sandbox config"
    | _ => unsup "which refused key comes first depends on the object's key order"
  if has options "networkId" then
    let _ ← requireString (get options "networkId") "config.options.networkId"
    if provider != "vercel" then fail "config.options.networkId is only supported by the vercel provider"
  if has options "mountAwsS3Buckets" then
    match get options "mountAwsS3Buckets" with
    | .bool _ => pure ()
    | _ => fail "config.options.mountAwsS3Buckets must be a boolean"
    if !mountFlagProviders.contains provider then
      fail s!"config.options.mountAwsS3Buckets is only read by the daytona and sandbox providers, not {provider}; lambda and vercel mount any attached workspace without it"
  if provider == "machine" && has options "cwd" then
    let _ ← requireString (get options "cwd") "config.options.cwd"
  if has options "s3Endpoint" then
    let endpoint ← requireString (get options "s3Endpoint") "config.options.s3Endpoint"
    assertStorageEndpoint endpoint "config.options.s3Endpoint"
  assertNoRetiredImageOptions provider options
  if provider == "daytona" then
    let image ← optionalString (opt options "image") "config.options.image"
    if image.isSome && snapshot != .null then
      fail "config.snapshot and config.options.image cannot both be set: Daytona boots a snapshot or builds one from an image"

/-! ## Headers -/

def alwaysSecretParts : List String := ["secret", "password", "passwd", "passphrase", "kubeconfig"]

def secretLastWords : List String :=
  ["secret", "secrets", "password", "passwords", "credential", "credentials", "cookie", "cookies",
    "certificate", "pem", "authorization", "authentication", "auth", "bearer", "token", "tokens",
    "key", "keys", "apikey", "accesskey", "privatekey"]

def identifierKeyQualifiers : List String :=
  ["cache", "conversation", "destination", "embeddable", "event", "idempotency", "object",
    "partition", "preview", "public", "reservation", "resource", "scope", "sort", "source",
    "storage", "unscoped"]

def tokenCountNames : List String :=
  ["cachecreationinputtokens", "cachedinputtokens", "cachereadtokens", "cachewritetokens",
    "inputtokens", "maxoutputtokens", "maxtokens", "nocachetokens", "outputtokens",
    "reasoningtokens", "texttokens", "totaltokens"]

def secretWordEndings : List String :=
  ["apikey", "accesskey", "credential", "credentials", "privatekey", "token"]

/-- `replace(/([a-z0-9])([A-Z])/g, "$1 $2")`. -/
def spaceAfterLower (chars : List Char) : List Char :=
  match chars with
  | a :: b :: rest =>
    if (('a' ≤ a && a ≤ 'z') || ('0' ≤ a && a ≤ '9')) && 'A' ≤ b && b ≤ 'Z' then
      a :: ' ' :: b :: spaceAfterLower rest
    else a :: spaceAfterLower (b :: rest)
  | _ => chars

/-- `replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")`. -/
def spaceBeforeWord (chars : List Char) : List Char :=
  let isUpper := fun c : Char => 'A' ≤ c && c ≤ 'Z'
  let rec go (fuel : Nat) (rest : List Char) : List Char :=
    match fuel, rest with
    | 0, _ => rest
    | _, [] => []
    | fuel + 1, c :: tail =>
      if isUpper c then
        let (run, after) := rest.span isUpper
        match after with
        | lower :: more =>
          if run.length ≥ 2 && 'a' ≤ lower && lower ≤ 'z' then
            run.dropLast ++ [' ', run.getLast?.getD ' ', lower] ++ go fuel more
          else run ++ go fuel after
        | [] => run
      else c :: go fuel tail
  go chars.length chars

/-- secretNames.ts `judgeName`, which is also what the cached `isSecretName` answers. -/
def isSecretName (name : String) : Bool :=
  let spaced := spaceBeforeWord (spaceAfterLower name.toList)
  let isWordChar := fun c : Char => ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9')
  let lowered := spaced.map Char.toLower
  let words := ((String.ofList (lowered.map fun c => if isWordChar c then c else ' ')).splitOn " ").filter
    (!·.isEmpty)
  match words.getLast? with
  | none => false
  | some last =>
    if tokenCountNames.contains (String.join words) then false
    else if words.any (fun word => alwaysSecretParts.any (includes word ·)) then true
    else if !secretLastWords.contains last then secretWordEndings.any (last.endsWith ·)
    else if last != "key" && last != "keys" then true
    else
      match words.reverse with
      | _ :: qualifier :: _ => !identifierKeyQualifiers.contains qualifier
      | _ => false

/-- A header name: `^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$`. -/
def isHeaderName (name : String) : Bool :=
  let chars := name.toList
  1 ≤ chars.length && chars.length ≤ 128 && chars.all fun c =>
    c.toNat < 128 && (c.isAlphanum || "!#$%&'*+.^_`|~-".toList.contains c)

/-- mcp.ts `normalizeHeaders`. Which bad header throws first depends on key order. -/
def normalizeHeaders (value stored : Json) : R Unit := do
  if !isObj value then fail "headers must be an object of header name to value"
  let headers := entries value
  if headers.length > 16 then fail "headers must contain at most 16 entries"
  let problem := fun (entry : String × Json) =>
    let (name, headerValue) := entry
    if !isHeaderName name then some s!"headers names must be RFC 9110 tokens: {name}"
    else
      match headerValue with
      | .str text =>
        if utf16Length text > 2048 || text.toList.any (fun c => c == '\r' || c == '\n') then
          some "headers values must be single-line strings of at most 2048 characters"
        else
          let lower := lowerAscii name
          if (isSecretName lower || lower == "key" || lower == "keys") &&
              !isCredentialHeaderValue text && get stored name != .str text then
            some s!"headers values for {name} must reference an account env var like ${"{"}NAME}, not an inline secret"
          else none
      | _ => some "headers values must be single-line strings of at most 2048 characters"
  match headers.filterMap problem with
  | [] => pure ()
  | [message] => fail message
  | _ => unsup "which bad header comes first depends on the object's key order"

/-- `assertCustomOptions`. -/
def assertCustomOptions (options storedHeaders : Json) : R Unit := do
  let endpointText ←
    match get options "endpoint" with
    | .str text => pure text
    | _ => fail "config.options.endpoint is required for the custom provider: the https URL of your sandbox server"
  let endpoint ← assertPublicHttpsUrl endpointText "config.options.endpoint"
  if !endpoint.search.isEmpty || !endpoint.hash.isEmpty then
    fail "config.options.endpoint must not carry a query or fragment"
  if has options "token" then
    let _ ← requireString (get options "token") "config.options.token"
  if has options "headers" then
    let stored :=
      if isObj storedHeaders && (entries storedHeaders).all (fun entry => (strOf entry.2).isSome) then
        storedHeaders
      else Json.mkObj []
    normalizeHeaders (get options "headers") stored

/-- `assertEnvVarsAndOptions`. -/
def assertEnvVarsAndOptions (config : Json) (provider : String) (stored : Json) : R Unit := do
  match opt config "options" with
  | some options => validateProviderOptions provider options (get config "snapshot")
  | none => pure ()
  if provider == "custom" then
    assertCustomOptions ((opt config "options").getD (Json.mkObj []))
      (get (get stored "options") "headers")

/-- `buildNormalizedConfig`. -/
def buildNormalizedConfig (config : Json) (provider : String) (fallbackProvider : Option Json)
    (network : Json) (image : Option Json) (snapshot : Option String)
    (persistentFields : List (String × Option Json)) : Json :=
  objOf ([("provider", some (.str provider)),
      ("fallbackProvider", fallbackProvider),
      ("network", some network),
      ("permissionMode", some ((opt config "permissionMode").getD (.str "ask"))),
      ("size", opt config "size"),
      ("image", image),
      ("snapshot", snapshot.map Json.str),
      ("persistent", opt config "persistent")] ++ persistentFields ++
    [("runtimes", opt config "runtimes"),
      ("timeout", opt config "timeout"),
      ("outputLimitBytes", opt config "outputLimitBytes"),
      ("envVars", opt config "envVars"),
      ("options", opt config "options")])

/-- `normalizeSandboxConfig`. -/
def normalizeSandboxConfig (value stored : Json) : R Json := do
  if value == .null then
    return Json.mkObj [("provider", .str "lambda"), ("permissionMode", .str "ask"),
      ("network", Json.mkObj [("mode", .str "deny-all")])]
  checkConfigShape value
  if has value "internet" then fail "config.internet is no longer supported; use config.network"
  let provider := (strAt value "provider").getD "lambda"
  let fallbackProvider := opt value "fallbackProvider"
  let image := opt value "image"
  let snapshot := trimmedOrNone (get value "snapshot")
  if has value "snapshot" && !snapshotProviders.contains provider then
    fail s!"config.snapshot does not apply to the {provider} provider"
  assertImage (get value "image") (.str provider) (get value "fallbackProvider")
  if fallbackProvider == some (.str provider) then
    fail "config.fallbackProvider must differ from config.provider"
  match fallbackProvider with
  | some (.str fallback) =>
    if statelessProviders.contains fallback then fail s!"config.fallbackProvider cannot be {fallback}"
    if get value "persistent" == .bool true then
      fail "config.fallbackProvider requires config.persistent to be false: a reserved sandbox belongs to one provider"
  | _ => pure ()
  assertStatelessProviderFields value provider
  let network ← normalizeNetwork (opt value "network")
  let persistentFields ← normalizePersistentFields value provider
  let runsOn := match fallbackProvider with
    | some (.str fallback) => [provider, fallback]
    | _ => [provider]
  for target in runsOn do
    assertNetworkEnforceable target network
    assertResourceLimits value target
  assertEnvVarsAndOptions value provider stored
  pure (buildNormalizedConfig value provider fallbackProvider network image snapshot persistentFields)

/-- `resourceCreateInput` with its first issue. -/
def checkCreateInput (input : Json) : R Unit := do
  if !isObj input then fail "Request body must be an object"
  if !isNonEmptyString (get input "name") then fail "name must be a non-empty string"
  checkString "description" (opt input "description")

/-- `resourceUpdateInput` with its first issue. -/
def checkUpdateInput (input : Json) : R Unit := do
  if !isObj input then fail "Request body must be an object"
  match opt input "name" with
  | some name => if !isNonEmptyString name then fail "name must be a non-empty string"
  | none => pure ()
  match opt input "description" with
  | none | some .null | some (.str _) => pure ()
  | some _ => fail "description must be a string"

/-- configValues.ts `mergeConfigValue`, with none as undefined. -/
def mergeConfigValue (fuel : Nat) (existing : Option Json) (patch : Json) : R (Option Json) :=
  match fuel with
  | 0 => unsup "config nests too deep"
  | fuel + 1 =>
    if patch == .str "********" then pure existing
    else if patch == .null then pure none
    else if !isObj patch then pure (some patch)
    else do
      let start : List (String × Json) := match existing with
        | some item => entries item
        | none => []
      let merged ← (entries patch).foldlM (init := start) fun acc (key, item) => do
        if ["__proto__", "constructor", "prototype"].contains key then return acc
        let current := acc.lookup key
        let without := acc.filter (fun entry => entry.1 != key)
        match ← mergeConfigValue fuel current item with
        | some value => pure (without ++ [(key, value)])
        | none => pure without
      pure (some (Json.mkObj merged))

/-- configValues.ts `mergeConfigObjects`. -/
def mergeConfigObjects (existing patch : Json) : R Json := do
  match ← mergeConfigValue 64 (some existing) patch with
  | some merged => pure merged
  | none => pure (Json.mkObj [])

/-- `description` as the create and update rules write it. -/
def trimmedField (value : Json) : Option Json :=
  (trimmedOrNone value).map Json.str

/-- `normalizeCreateSandboxConfigInput`, over the config normalizer named. -/
def normalizeCreateInput (normalize : Json → R Json) (value : Json) : R Json := do
  checkCreateInput value
  let name := jsTrim ((strAt value "name").getD "")
  let config ← normalize (get value "config")
  pure (objOf [("name", some (.str name)), ("description", trimmedField (get value "description")),
    ("config", some config)])

/-- `normalizeUpdateSandboxConfigInput`, over the config normalizer named. -/
def normalizeUpdateInput (normalize : Json → R Json) (existing value : Json) : R Json := do
  checkUpdateInput value
  let config ←
    match opt value "config" with
    | none => pure existing
    | some patch =>
      if !isObj patch then fail "config must be an object"
      refuseProtoKey patch
      normalize (← mergeConfigObjects existing patch)
  let name := (strAt value "name").map fun text => Json.str (jsTrim text)
  let description := match opt value "description" with
    | some .null => some Json.null
    | some item => trimmedField item
    | none => none
  pure (objOf [("name", name), ("description", description), ("config", some config)])

/-- sandboxProviders.ts `supportsS3WorkspaceMount`. -/
def supportsS3WorkspaceMount (provider : String) (options : Json) : Bool :=
  ["lambda", "sandbox", "vercel"].contains provider ||
    (provider == "daytona" && get options "mountAwsS3Buckets" == .bool true)

/-- A provider argument as a string, or a stop. -/
def providerArg (value : Json) : R String :=
  match value with
  | .str provider => pure provider
  | _ => unsup "provider is not a string"

/-! ## Twins -/

/-- The twins of the sandbox rules. -/
def sandboxRulesTwins : List Spec.Twin :=
  [ twin (sandboxRules "normalizeSandboxConfig") fun args =>
      normalizeSandboxConfig (Spec.Twin.arg args 0) (Spec.Twin.arg args 1),
    twin (sandboxRules "normalizeCreateSandboxConfigInput") fun args =>
      normalizeCreateInput (normalizeSandboxConfig · .null) (Spec.Twin.arg args 0),
    twin (sandboxRules "normalizeUpdateSandboxConfigInput") fun args =>
      normalizeUpdateInput (normalizeSandboxConfig · (Spec.Twin.arg args 0))
        (Spec.Twin.arg args 0) (Spec.Twin.arg args 1),
    twin (sandboxRules "validateProviderOptions") fun args => do
      validateProviderOptions (← providerArg (Spec.Twin.arg args 0)) (Spec.Twin.arg args 1)
        (Spec.Twin.arg args 2)
      pure .null,
    twin (sandboxRules "normalizePersistentFields") fun args => do
      pure (objOf (← normalizePersistentFields (Spec.Twin.arg args 0)
        (← providerArg (Spec.Twin.arg args 1)))),
    twin (sandboxRules "buildNormalizedConfig") fun args => do
      let image := Spec.Twin.arg args 4
      let snapshot := Spec.Twin.arg args 5
      let fallback := Spec.Twin.arg args 2
      let fields := (entries (Spec.Twin.arg args 6)).map fun (key, item) => (key, some item)
      pure (buildNormalizedConfig (Spec.Twin.arg args 0) (← providerArg (Spec.Twin.arg args 1))
        (if truthy fallback then some fallback else none) (Spec.Twin.arg args 3)
        (if truthy image then some image else none) (if truthy snapshot then strOf snapshot else none) fields),
    twin (sandboxRules "assertNetworkEnforceable") fun args => do
      assertNetworkEnforceable (← providerArg (Spec.Twin.arg args 0)) (Spec.Twin.arg args 1)
      pure .null,
    twin (sandboxRules "assertCustomOptions") fun args => do
      assertCustomOptions (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)
      pure .null,
    twin (sandboxRules "assertWorkerLifecycle") fun args => do
      let lifecycle := Spec.Twin.arg args 2
      assertWorkerLifecycle (Spec.Twin.arg args 0) (← providerArg (Spec.Twin.arg args 1))
        (if lifecycle == .null then none else some lifecycle)
      pure .null,
    twin (sandboxRules "assertResourceLimits") fun args => do
      assertResourceLimits (Spec.Twin.arg args 0) (← providerArg (Spec.Twin.arg args 1))
      pure .null,
    twin (sandboxRules "normalizeNetwork") fun args =>
      let network := Spec.Twin.arg args 0
      normalizeNetwork (if network == .null then none else some network),
    twin (sandboxRules "assertImage") fun args => do
      assertImage (Spec.Twin.arg args 0) (Spec.Twin.arg args 1) (Spec.Twin.arg args 2)
      pure .null,
    twin (sandboxRules "assertStatelessProviderFields") fun args => do
      assertStatelessProviderFields (Spec.Twin.arg args 0) (← providerArg (Spec.Twin.arg args 1))
      pure .null,
    twin (sandboxRules "assertNoRetiredImageOptions") fun args => do
      assertNoRetiredImageOptions (← providerArg (Spec.Twin.arg args 0)) (Spec.Twin.arg args 1)
      pure .null,
    twin (sandboxRules "assertEnvVarsAndOptions") fun args => do
      assertEnvVarsAndOptions (Spec.Twin.arg args 0) (← providerArg (Spec.Twin.arg args 1))
        (Spec.Twin.arg args 2)
      pure .null,
    twin (sandboxRules "optionalString") fun args => do
      let text ← optionalString (match Spec.Twin.arg args 0 with
        | .null => none
        | item => some item) ((strOf (Spec.Twin.arg args 1)).getD "")
      pure ((text.map Json.str).getD .null),
    twin (sandboxRules "requireString") fun args => do
      pure (.str (← requireString (Spec.Twin.arg args 0) ((strOf (Spec.Twin.arg args 1)).getD ""))),
    twin (sandboxRules "browserSandboxRefusal") fun args =>
      let sandbox := Spec.Twin.arg args 0
      let provider := get sandbox "provider"
      if provider == .str "machine" then pure .null
      else if provider != .str "lambda" || get sandbox "image" != .str "obscura" then
        pure (.str "config.browser needs the agent's first sandbox on provider lambda with image: \"obscura\", or a machine sandbox with obscura installed")
      else if get (get sandbox "network") "mode" != .str "allow-all" then
        pure (.str "config.browser needs the agent's first sandbox to set network.mode to allow-all")
      else pure .null,
    twin (sandboxRules "snapshotBootRefusal") fun args => do
      let snapshot := Spec.Twin.arg args 0
      let sandbox := Spec.Twin.arg args 1
      if get snapshot "accountId" != get sandbox "accountId" then
        return .str "config.snapshot names a snapshot of another account"
      match opt snapshot "scope" with
      | none =>
        return .str "config.snapshot names a snapshot taken before snapshots were locked to a stage; take it again from a sandbox on this stage"
      | some .null => unsup "a null scope reads a property of null"
      | some scope =>
        let target := get sandbox "scope"
        let same :=
          if scope == .str "account" || target == .str "account" then scope == target
          else get scope "projectId" == get target "projectId" && get scope "stageId" == get target "stageId"
        if same then return .null
        return .str "config.snapshot names a snapshot taken on another stage; a sandbox boots only snapshots taken on its own stage",
    twin (sandboxRules "sandboxScope") fun args =>
      let row := Spec.Twin.arg args 0
      if truthy (get row "projectId") && truthy (get row "stageId") then
        pure (Json.mkObj [("projectId", get row "projectId"), ("stageId", get row "stageId")])
      else pure (.str "account"),
    twin "packages/convex/model/sandboxProviders.ts#supportsS3WorkspaceMount" fun args => do
      pure (.bool (supportsS3WorkspaceMount (← providerArg (Spec.Twin.arg args 0)) (Spec.Twin.arg args 1))),
    twin "packages/convex/model/workspaceRules.ts#assertStorageEndpoint" fun args => do
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
      | .str value, .str label =>
        assertStorageEndpoint value label
        pure .null
      | _, _ => unsup "endpoint or label is not a string",
    twin "packages/convex/model/workspaceRules.ts#isClusterEndpoint" fun args => do
      match Spec.Twin.arg args 0 with
      | .str value => pure (.bool (← isClusterEndpoint value))
      | _ => unsup "endpoint is not a string" ]

end Spec.Sandbox.Rt
