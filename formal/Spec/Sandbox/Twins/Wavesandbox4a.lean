import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign4/sandbox4a.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox4a

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (j : Json) : Bool := j.compress == undef.compress

private def isNullish (j : Json) : Bool := isUndef j || j == .null

private def field (j : Json) (k : String) : Json := (j.getObjVal? k).toOption.getD undef

private def str (j : Json) : String := j.getStr?.toOption.getD ""

private def items (j : Json) : List Json := (j.getArr?.toOption.getD #[]).toList

private def truthy (j : Json) : Bool :=
  match j with
  | .null | .bool false | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def orElse (j fallback : Json) : Json := if isNullish j then fallback else j

private def num? (j : Json) : Option Nat :=
  match j with
  | .num n => if n.exponent == 0 && n.mantissa >= 0 then some n.mantissa.toNat else none
  | _ => none

private def contains (text part : String) : Bool := (text.splitOn part).length > 1

/-- JavaScript's `trim`, over the whitespace a shell writes. -/
private def jsTrim (s : String) : String :=
  let ws (c : Char) : Bool := c == ' ' || c == '\n' || c == '\t' || c == '\r'
  String.ofList (((s.toList.dropWhile ws).reverse.dropWhile ws).reverse)

/-- Object spread: the entries of `j`, without the recorder's bookkeeping. -/
private def spread (j : Json) : List (String × Json) :=
  if isUndef j then [] else
  match j with
  | .obj kvs => kvs.toArray.toList.filter fun (k, _) => k != "$keys" && k != "$fields"
  | _ => []

/-- A `catch` handler that lets an opted-out call stay opted out. -/
private def rethrowingUnsupported (handler : Json → Prog Json) (error : Json) : Prog Json :=
  match error.getObjVal? "$unsupported" with
  | .ok _ => .fail error
  | _ => handler error

private def clientError (message : String) : Prog Json := do
  let error ← Prog.effect "new ClientError" [toJson message]
  Prog.fail error

/-- `ROLE_ARN_PATTERN` in `workspaceRules.ts`: the account id of `arn:<partition>:iam::<id>:role/<name>`. -/
private def roleArnAccount (arn : String) : Option String :=
  match arn.splitOn ":" with
  | "arn" :: partition :: "iam" :: "" :: account :: rest =>
    let role := ":".intercalate rest
    if !partition.isEmpty && partition.all (fun c => ('a' ≤ c ∧ c ≤ 'z') || c == '-') &&
        !account.isEmpty && account.all Char.isDigit &&
        role.startsWith "role/" && role.length > 5 && !contains role "\n" then
      some account
    else none
  | _ => none

private def roleArnEnvNames : List String :=
  ["CONVEX_AWS_ROLE_ARN", "SANDBOX_MOUNT_ROLE_ARN", "MICROVM_EXECUTION_ROLE_ARN",
   "MICROVM_BUILD_ROLE_ARN"]

private def bucketEnvNames : List String :=
  ["FILESYSTEM_BUCKET_NAME", "SKILLS_BUCKET_NAME", "TOOL_BUNDLES_BUCKET_NAME",
   "MICROVM_ARTIFACTS_BUCKET_NAME"]

/-- `platformAwsAccountId`. -/
def platformAwsAccountId (call : Json) : Prog Json := do
  let direct := Twin.env call "AWS_ACCOUNT_ID"
  if truthy direct then return direct
  let found := roleArnEnvNames.findSome? fun name =>
    let arn := Twin.env call name
    roleArnAccount (if isUndef arn then "" else str arn)
  return (found.map toJson).getD undef

private def numberWhite (c : Char) : Bool :=
  c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == Char.ofNat 11 || c == Char.ofNat 12

/-- A decimal `StrDecimalLiteral` without sign: `1`, `1.`, `.5`, `1.5e3`. -/
private def decimalLiteral (cs : List Char) : Bool :=
  let (whole, afterWhole) := cs.span Char.isDigit
  let hasDot := afterWhole.head? == some '.'
  let (frac, tail) := if hasDot then afterWhole.tail.span Char.isDigit else ([], afterWhole)
  let exponentOk :=
    match tail with
    | [] => true
    | e :: more =>
      let digits :=
        match more with
        | sign :: rest => if sign == '+' || sign == '-' then rest else more
        | [] => []
      (e == 'e' || e == 'E') && !digits.isEmpty && digits.all Char.isDigit
  (!whole.isEmpty || !frac.isEmpty) && exponentOk

/-- `0x`, `0o` and `0b` literals; digits must fit the radix. -/
private def radixLiteral (cs : List Char) : Bool :=
  match cs with
  | '0' :: marker :: digits =>
    let fits : Char → Bool :=
      if marker == 'x' || marker == 'X' then Char.isAlphanum
      else if marker == 'o' || marker == 'O' then fun c => '0' ≤ c && c ≤ '7'
      else if marker == 'b' || marker == 'B' then fun c => c == '0' || c == '1'
      else fun _ => false
    !digits.isEmpty && digits.all fun c =>
      fits c && (!(marker == 'x' || marker == 'X') || c.isDigit || ('a' ≤ c.toLower && c.toLower ≤ 'f'))
  | _ => false

/-- Whether `Number(text)` is NaN or infinite, so the value is refused. Literal forms that may
be integers are reported as `none`. -/
private def numberRefused (cs : List Char) : Option Bool :=
  let body := match cs with
    | sign :: rest => if sign == '+' || sign == '-' then rest else cs
    | [] => []
  if cs.isEmpty then some true
  else if String.ofList body == "Infinity" then some true
  else if radixLiteral cs || decimalLiteral body then none
  else some true

/-- `positiveIntegerEnv`. Plain digits are parsed; other `Number()` literals are not modelled,
and text that is no number literal is refused as NaN. -/
def positiveIntegerEnv (call : Json) : Prog Json := do
  let name := str (Twin.callArg call 0)
  let value := Twin.env call name
  if isUndef value || value == toJson "" then return Twin.callArg call 1
  let refusal : Prog Json := clientError s!"{name} must be a positive integer"
  let chars := (str value).toList
  if chars.any (fun c => c.toNat > 127) then
    return ← Prog.unsupported "non-ascii env value"
  let trimmed := (chars.dropWhile numberWhite).reverse.dropWhile numberWhite |>.reverse
  if !trimmed.isEmpty && trimmed.all Char.isDigit then
    match (String.ofList trimmed).toNat? with
    | some parsed =>
      if parsed < 1 || parsed > 9007199254740991 then refusal else return toJson parsed
    | none => Prog.unsupported "non-decimal env value"
  else
    match numberRefused trimmed with
    | some _ => refusal
    | none => Prog.unsupported "non-integer number literal"

/-- `assertStorageEndpoint`. -/
def assertStorageEndpoint (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if Twin.env call "ALLOW_PRIVATE_STORAGE_ENDPOINTS" == toJson "true" then
    let cluster ← Prog.effect "isClusterEndpoint" [value]
    if truthy cluster then return undef
  let _ ← Prog.effect "assertPublicHttpsUrl" [value, Twin.callArg call 1]
  return undef

/-- `workspaceStorageOwnAuth`. -/
def workspaceStorageOwnAuth (call : Json) : Prog Json := do
  let storage := Twin.callArg call 0
  let endpoint := field storage "endpoint"
  let bucket := field storage "bucket"
  let auth := field storage "auth"
  let authType := field auth "type"
  if truthy endpoint then
    if !truthy bucket then
      return ← clientError
        "config.storage.endpoint requires config.storage.bucket; the managed bucket has no custom endpoint"
    let _ ← Prog.effect "assertStorageEndpoint" [endpoint, toJson "config.storage.endpoint"]
  if !truthy bucket then
    if authType == toJson "r2" then
      return ← clientError
        "config.storage.auth.type \"r2\" requires config.storage.bucket; R2 has no managed bucket"
    return undef
  let lowered := (str bucket).toLower
  if bucketEnvNames.any (fun name =>
      let value := Twin.env call name
      !isUndef value && (str value).toLower == lowered) then
    return ← clientError
      "config.storage.bucket must be a bucket you own; omit it to use the managed bucket"
  if authType == toJson "r2" then
    let hasAccount ←
      if truthy endpoint then
        let account ← Prog.effect "r2AccountId" [endpoint]
        pure (truthy account)
      else pure false
    if !hasAccount then
      return ← clientError
        "config.storage.auth.type \"r2\" requires config.storage.endpoint to be your account R2 endpoint, https://<account id>.r2.cloudflarestorage.com"
    let region := field storage "region"
    if !isUndef region && region != toJson "auto" then
      return ← clientError "config.storage.region must be \"auto\" or omitted for R2"
    return auth
  if authType != toJson "assumeRole" then
    return ← clientError
      "config.storage.auth.type \"assumeRole\" or \"r2\" is required when config.storage.bucket is set; a named bucket is only reached with its own credentials"
  match roleArnAccount (str (field auth "roleArn")) with
  | none => clientError "config.storage.auth.roleArn must be an IAM role ARN"
  | some account =>
    let marker := s!"::{account}:"
    if Twin.env call "AWS_ACCOUNT_ID" == toJson account ||
        roleArnEnvNames.any (fun name =>
          let value := Twin.env call name
          !isUndef value && contains (str value) marker) then
      clientError "config.storage.auth.roleArn must not be a role in the platform AWS account"
    else
      return auth

/-- `resolveS3MountIdentity`. -/
def resolveS3MountIdentity (call : Json) : Prog Json := do
  let ctx := Twin.callArg call 0
  let storage := field ctx "storage"
  if truthy storage then
    let _ ← Prog.effect "workspaceStorageOwnAuth" [storage]
  if !truthy (field storage "endpoint") && truthy (field ctx "endpoint") then
    let _ ← Prog.effect "assertStorageEndpoint" [field ctx "endpoint", toJson "options.s3Endpoint"]
  let ownBucket := field storage "bucket"
  let bucket := orElse ownBucket (field ctx "managedBucket")
  if !truthy bucket then
    return ← Prog.throwError "Error"
      "workspace S3 mount requires storage.bucket or a managed bucket (FILESYSTEM_BUCKET_NAME)."
  if truthy ownBucket then
    let normalized ← Prog.effect "normalizeWorkspacePrefix" [field storage "prefix"]
    if !truthy normalized then
      return ← Prog.throwError "Error"
        "workspace storage.prefix is required for a bring-your-own bucket; the mount is scoped to bucket/prefix/"
  let keyPrefix ←
    if truthy ownBucket then do
      let normalized ← Prog.effect "normalizeWorkspacePrefix" [field storage "prefix"]
      let suffix ← Prog.effect "namespaceIsolationSuffix" [field ctx "namespace"]
      Prog.effect "joinPrefix" [normalized, suffix]
    else pure (toJson (str (field ctx "namespace") ++ "/"))
  let region := orElse (field storage "region") (field ctx "region")
  let endpoint := orElse (field storage "endpoint") (field ctx "endpoint")
  return Json.mkObj ([("bucket", bucket), ("prefix", keyPrefix)] ++
    (if truthy region then [("region", region)] else []) ++
    (if truthy endpoint then [("endpoint", endpoint)] else []))

/-- `isMicrovmGone`. Non-`Error` values are not modelled. -/
def isMicrovmGone (call : Json) : Prog Json := do
  let error := field (Twin.callArg call 0) "$error"
  if isUndef error then return ← Prog.unsupported "not an Error"
  if field error "$class" == toJson "MicrovmGoneError" then return toJson true
  let message := (str (field error "message")).toLower
  return toJson (field error "name" == toJson "ResourceNotFoundException" ||
    contains message "not found" || contains message "not exist")

/-- `isSandboxGoneError`. -/
def isSandboxGoneError (call : Json) : Prog Json := do
  let error := Twin.callArg call 0
  let errorClass := field (field error "$error") "$class"
  if errorClass == toJson "SandboxGoneError" || errorClass == toJson "MicrovmGoneError" then
    return toJson true
  let fields ← Prog.effect "parseOr"
    [Json.mkObj [("$opaque", toJson "ZodMiniObject")], error]
  if !truthy fields then
    return match error with
      | .str text =>
        let lower := text.toLower
        toJson (contains lower "not found" || contains lower "notfound" ||
          contains lower "does not exist" || contains lower "no such")
      | _ => toJson false
  let status := orElse (orElse (field fields "statusCode") (field fields "status")) (field fields "code")
  if status == toJson (404 : Nat) || status == toJson (410 : Nat) then return toJson true
  let lower := (match field fields "message" with | .str text => text | _ => "").toLower
  return toJson (contains lower "not found" || contains lower "notfound" ||
    contains lower "does not exist" || contains lower "no such" ||
    contains lower "already deleted" || contains lower "already destroyed")

private def vercelAuth (config : Json) : Prog (List (String × Json)) := do
  let auth ← Prog.effect "vercelAuthOptions" [config]
  return spread auth

/-- `VercelSandboxExecutor.release`. -/
def vercelRelease (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let config := Twin.field (Twin.self call) "#config"
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return undef
  let expected := field request "expectedExternalId"
  let name ←
    if isNullish expected then Prog.effect "getSandboxExternalId" [toJson "vercel", key]
    else pure expected
  if !truthy name then return undef
  let body : Prog Json := do
    if isUndef (Twin.field (Twin.self call) "#sandboxClass") then
      Prog.setState "self.#sandboxClass" (Json.mkObj [("$opaque", toJson "Promise")])
    let auth ← vercelAuth config
    let _ ← Prog.effect "Sandbox.get"
      [Json.mkObj ([("name", name), ("resume", toJson false)] ++ auth)]
    let _ ← Prog.effect "sandbox.delete"
    return undef
  let _ ← Prog.catchFail body (rethrowingUnsupported fun error => do
    let gone ← Prog.effect "isSandboxGoneError" [error]
    if truthy gone then return undef else Prog.fail error)
  let _ ← Prog.attempt "deleteSandboxInstance"
    [toJson "vercel", key, field (field config "controlPlane") "accountId", name]
  return undef

/-- `VercelSandboxExecutor.snapshot`, with its private `#reserved` inlined. -/
def vercelSnapshot (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let config := Twin.field (Twin.self call) "#config"
  let body : Prog Json := do
    let key ← Prog.effect "sandboxReservationKey" [request]
    if !truthy key then
      return ← Prog.throwError "Error" "a persistent sandbox reservation key is required"
    let name ← Prog.effect "getSandboxExternalId" [toJson "vercel", key]
    if !truthy name then
      return ← Prog.throwError "Error" "no reserved vercel sandbox for this reservation"
    if isUndef (Twin.field (Twin.self call) "#sandboxClass") then
      Prog.setState "self.#sandboxClass" (Json.mkObj [("$opaque", toJson "Promise")])
    let auth ← vercelAuth config
    let sandbox ← Prog.effect "Sandbox.get" [Json.mkObj ([("name", name)] ++ auth)]
    if !isUndef (field sandbox "expiresAt") then
      return ← Prog.unsupported "keep-alive path has no recording"
    let _ ← Prog.effect "configString" [field (field config "options") "workspaceRoot"]
    let snapshot ← Prog.effect "sandbox.snapshot" [Json.mkObj [("expiration", toJson (0 : Nat))]]
    if field snapshot "status" != toJson "created" then
      return ← Prog.throwError "Error"
        s!"Vercel snapshot {str (field snapshot "snapshotId")} ended {str (field snapshot "status")}"
    return Json.mkObj [("snapshotId", field snapshot "snapshotId")]
  Prog.catchFail body (rethrowingUnsupported fun error => do
    let classified ← Prog.effect "classifyVercelError" [error]
    Prog.fail classified)

/-- `awsClient`: a client per access object, or the module's default one. -/
def awsClient (call : Json) : Prog Json := do
  let access := Twin.callArg call 0
  let envRegion := Twin.env call "AWS_REGION"
  let options (region : Json) (extra : List (String × Json)) : Json :=
    Json.mkObj ((if region == Twin.undefinedJson then [] else [("region", region)]) ++ extra)
  if truthy access then
    let existing ← Prog.effect "accessClients.get" [access]
    if truthy existing then return existing
    let region := if isNullish (field access "region") then envRegion else field access "region"
    let client ← Prog.effect "new AwsS3Client"
      [options region
        ((if truthy (field access "endpoint") then
            [("endpoint", field access "endpoint"), ("forcePathStyle", toJson true)] else []) ++
          (if truthy (field access "credentials") then
            [("credentials", field access "credentials")] else []))]
    let _ ← Prog.effect "accessClients.set" [access, client]
    return client
  let existing := Twin.moduleValue call "defaultClient"
  if !isNullish existing then return existing
  let client ← Prog.effect "new AwsS3Client" [options envRegion []]
  Prog.setState "module.defaultClient" client
  return client

/-- `HarnessShellProcess.kill`, with its private `#kill` inlined. -/
def harnessKill (call : Json) : Prog Json := do
  let self := Twin.self call
  if !isUndef (Twin.field self "#killPromise") then
    return ← Prog.unsupported "a second kill awaits the first, whose result is not recorded"
  Prog.setState "self.#killPromise" (Json.mkObj [("$opaque", toJson "Promise")])
  let root := str (Twin.field self "#root")
  let q (suffix : String) : Prog String := do
    let quoted ← Prog.effect "q" [toJson (root ++ suffix)]
    return str quoted
  let pid1 ← q ".pid"
  let pid2 ← q ".pid"
  let pid3 ← q ".pid"
  let exit1 ← q ".exit"
  let exit2 ← q ".exit"
  let running ← q ".running"
  let command := "; ".intercalate
    [s!"if [ -f {pid1} ]; then kill -TERM -\"$(cat {pid2})\" 2>/dev/null || true; sleep 0.05; kill -KILL -\"$(cat {pid3})\" 2>/dev/null || true; fi",
     s!"[ -f {exit1} ] || echo 143 > {exit2}",
     s!"rm -f {running}"]
  let result ← Prog.effect "this.#executor.exec" [toJson command]
  if field result "exitCode" != toJson (0 : Nat) then
    let error ← Prog.effect "shellProcessError" [toJson "kill command", result]
    return ← Prog.fail error
  return undef

/-- `MicrovmHarnessSession.spawnCommand`. -/
def spawnCommand (call : Json) : Prog Json := do
  let self := Twin.self call
  let options := Twin.callArg call 0
  let signal := field options "abortSignal"
  Prog.effect "HarnessShellProcess.start"
    [Json.mkObj ([("executor", Twin.field self "#shell"),
        ("command", field options "command"),
        ("workingDirectory",
          orElse (field options "workingDirectory") (Twin.field self "#defaultWorkingDirectory")),
        ("env", Json.mkObj (spread (Twin.field self "#env") ++ spread (field options "env")))] ++
      (if truthy signal then [("abortSignal", signal)] else []))]

/-- The session's proxy after `close` ran on it: routes and sockets dropped, the server stopped. -/
private def closedProxy (proxy : Json) : Json :=
  let fields := field proxy "$fields"
  let emptyMap := Json.mkObj [("$map", .arr #[])]
  let promise := Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [("$resolved", undef)])]
  let next := fields.setObjVal! "#routes" emptyMap
    |>.setObjVal! "#routesByPort" emptyMap
    |>.setObjVal! "#connections" (Json.mkObj [("$set", .arr #[])])
    |>.setObjVal! "#server" undef
    |>.setObjVal! "#closePromise" (if isUndef (field fields "#closePromise") then promise else field fields "#closePromise")
  proxy.setObjVal! "$fields" next

private def sessionTeardown (verb message : String) (call : Json) : Prog Json := do
  let self := Twin.self call
  let _ ← Prog.effect "this.#proxy.close"
  let proxy := Twin.field self "#proxy"
  if closedProxy proxy != proxy then Prog.setState "self.#proxy" (closedProxy proxy)
  if truthy (Twin.field self "#shared") then return undef
  if isUndef (field (Twin.field self "#executor") verb) then
    return ← Prog.throwError "Error" message
  let _ ← Prog.effect s!"this.#executor.{verb}"
    [Json.mkObj [("reservationKey", Twin.field self "#reservationKey")]]
  return undef

/-- A `Map` snapshot without the entries whose key `drop` names. -/
private def dropMapEntries (cache : Json) (drop : String → Bool) : Json :=
  Json.mkObj [("$map", .arr ((items (field cache "$map")).filter fun entry =>
    match entry with
    | .arr #[.str key, _] => !drop key
    | _ => true).toArray)]

/-- States a module `Map` that lost entries; a delete that found nothing writes nothing. -/
private def stateDropped (call : Json) (name : String) (drop : String → Bool) : Prog Unit := do
  let cache := Twin.moduleValue call name
  let next := dropMapEntries cache drop
  if (items (field next "$map")).length != (items (field cache "$map")).length then
    Prog.setState s!"module.{name}" next

/-- `MicrovmSandboxExecutor.release`, with its private `#terminate` inlined. -/
def microvmRelease (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let config := Twin.field (Twin.self call) "#config"
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return undef
  let expected := field request "expectedExternalId"
  let microvmId ←
    if isNullish expected then Prog.effect "getSandboxExternalId" [toJson "lambda", key]
    else pure expected
  stateDropped call "reservedEndpoints" (· == str key)
  stateDropped call "mountCredentialRefreshes" (· == str key)
  if !truthy microvmId then return undef
  stateDropped call "authTokens" (·.startsWith (str microvmId ++ ":"))
  let command ← Prog.effect "new TerminateMicrovmCommand"
    [Json.mkObj [("microvmIdentifier", microvmId)]]
  let sent ← Prog.attempt "this.#client .send" [command]
  let terminated ←
    match sent with
    | .ok _ => pure true
    | .threw error _ => do
      let gone ← Prog.effect "isMicrovmGone" [error]
      pure (truthy gone)
    | .pending => Prog.unsupported "termination never settled"
  if !terminated then
    return ← Prog.throwError "Error" s!"failed to terminate MicroVM {str microvmId}"
  let _ ← Prog.attempt "deleteSandboxInstance"
    [toJson "lambda", key, field (field config "controlPlane") "accountId", microvmId]
  return undef

/-- `MicrovmSandboxExecutor.getInstanceInfo`. -/
def microvmInstanceInfo (call : Json) : Prog Json := do
  let key ← Prog.effect "sandboxReservationKey" [Twin.callArg call 0]
  let microvmId ←
    if truthy key then Prog.effect "getSandboxExternalId" [toJson "lambda", key]
    else pure Json.null
  if !truthy microvmId then return Json.null
  let body : Prog Json := do
    let command ← Prog.effect "new GetMicrovmCommand"
      [Json.mkObj [("microvmIdentifier", microvmId)]]
    let info ← Prog.effect "this.#client.send" [command]
    let state ← Prog.effect "mapMicrovmState" [field info "state"]
    return Json.mkObj [("externalId", microvmId), ("state", state)]
  Prog.catchFail body (rethrowingUnsupported fun error => do
    let gone ← Prog.effect "isMicrovmGone" [error]
    if truthy gone then return Json.null
    let message ← Prog.effect "toErrorMessage" [error]
    return Json.mkObj
      [("externalId", microvmId), ("state", toJson "unknown"), ("errorMessage", message)])

/-- `CloudflareSandboxExecutor.getInstanceInfo`. -/
def cloudflareInstanceInfo (call : Json) : Prog Json := do
  let key ← Prog.effect "sandboxReservationKey" [Twin.callArg call 0]
  let id ←
    if truthy key then Prog.effect "getSandboxExternalId" [toJson "cloudflare", key]
    else pure Json.null
  if !truthy id then return Json.null
  let connection ← Prog.effect "cloudflareConnection"
  let _ ← Prog.effect "callPlatformWorker"
    [connection, toJson "cloudflare sandbox bridge", toJson s!"/v1/sandboxes/{str id}", toJson "GET"]
  let body ← Prog.effect "response.json"
  let parsed ← Prog.effect "statusResult.parse" [body]
  if truthy (field parsed "running") then
    return Json.mkObj [("externalId", id), ("state", toJson "running")]
  return Json.null

/-- `markMountCredentialsFresh` refreshes the reservation's thirty-minute credential deadline. -/
def markMountCredentialsFresh (call : Json) : Prog Json := do
  let cache := Twin.moduleValue call "mountCredentialRefreshes"
  let entries := items (field cache "$map")
  if entries.length >= 512 then
    return ← Prog.unsupported "eviction mutates an effect argument without returning its new state"
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "evictToCap" [cache, now]
  let key := Twin.callArg call 0
  let value := Json.mkObj [("expiresAt", toJson (now.getInt?.toOption.getD 0 + 1800000))]
  let entry := Json.arr #[key, value]
  let found := entries.any (fun pair => Twin.arg pair 0 == key)
  let updated := if found then entries.map (fun pair =>
    if Twin.arg pair 0 == key then entry else pair) else entries ++ [entry]
  let next := Json.mkObj [("$map", Json.arr updated.toArray)]
  if next != cache then
    Prog.setState "module.mountCredentialRefreshes" next
  return undef

private def cachedEntry (cache : Json) (key : String) : Option Json :=
  (items (field cache "$map")).findSome? fun entry =>
    match entry with
    | .arr #[.str k, value] => if k == key then some value else none
    | _ => none

/-- `MicrovmSandboxExecutor.createHarnessAuthToken`, with its private `#authToken` inlined. -/
def createHarnessAuthToken (call : Json) : Prog Json := do
  let microvmId := Twin.callArg call 0
  let port := Twin.callArg call 1
  match num? port with
  | some p =>
    if p < 1 || p > 65535 then
      return ← Prog.throwError "Error" s!"MicroVM auth token port is invalid: {p}"
    let cache := Twin.moduleValue call "authTokens"
    let now ← Prog.effect "Date.now"
    let cached := cachedEntry cache s!"{str microvmId}:{p}"
    match cached, (cached.bind fun e => num? (field e "expiresAt")), num? now with
    | some entry, some expires, some current =>
      if expires > current then return field entry "token"
    | _, _, _ => pure ()
    let command ← Prog.effect "new CreateMicrovmAuthTokenCommand"
      [Json.mkObj [("microvmIdentifier", microvmId),
        ("expirationInMinutes", toJson (15 : Nat)),
        ("allowedPorts", .arr #[Json.mkObj [("port", port)]])]]
    let result ← Prog.effect "this.#client.send" [command]
    let token := field (field result "authToken") "X-aws-proxy-auth"
    if !truthy token then
      return ← Prog.throwError "Error"
        "CreateMicrovmAuthToken did not return an X-aws-proxy-auth token"
    let _ ← Prog.effect "evictToCap" [cache, now]
    let cacheKey := s!"{str microvmId}:{p}"
    let entry := Json.arr #[toJson cacheKey, Json.mkObj
      [("token", token), ("expiresAt", toJson (now.getInt?.toOption.getD 0 + 600000))]]
    let entries := items (field cache "$map")
    let updated := if (cachedEntry cache cacheKey).isSome then
      entries.map (fun pair => if Twin.arg pair 0 == toJson cacheKey then entry else pair)
      else entries ++ [entry]
    Prog.setState "module.authTokens" (Json.mkObj [("$map", .arr updated.toArray)])
    return token
  | none => Prog.unsupported "non-integer port"

/-- `bashTargetLines`. -/
def bashTargetLines (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let workspaces := items (field context "workspaces")
  let schema ← Prog.effect "workspaceParamSchema" [field context "workspaces"]
  let choices ← Prog.effect "sandboxParamChoices" [context]
  let namesWorkspace := !isUndef schema
  let namesSandbox := !(items choices).isEmpty
  let workspaceLines := workspaces.zipIdx.map fun (workspace, index) =>
    let name := str (field workspace "name")
    let target := if namesWorkspace then s!"workspace={name}" else s!"workspace {name}, omit workspace"
    let isDefault := if index == 0 then " (default)" else ""
    let readOnly := if truthy (field workspace "sandbox") then "" else " (read-only, no bash)"
    s!"- {target}{isDefault}{readOnly}"
  let selectable ← Prog.effect "selectableSandboxes" [context]
  let mut sandboxLines : List String := []
  for (entry, index) in (items selectable).zipIdx do
    let name := str (field entry "name")
    let target := if namesSandbox then s!"sandbox={name}" else s!"sandbox {name}, omit sandbox"
    let isDefault := if workspaces.isEmpty && index == 0 then " (default)" else ""
    let state ← Prog.effect "machineState" [entry]
    let provider := str (field (field entry "sandbox") "provider")
    sandboxLines := sandboxLines ++
      [s!"- {target}{isDefault} ({provider}, no workspace mounted{str state})"]
  return toJson (workspaceLines ++ sandboxLines)

private def isUpperOrDigit (c : Char) : Bool :=
  ('A' ≤ c ∧ c ≤ 'Z') || ('0' ≤ c ∧ c ≤ '9') || c == '_'

/-- `ACCOUNT_ENV_PLACEHOLDER_PATTERN` in `envRefs.ts`, unanchored. -/
private def hasEnvPlaceholder (text : String) : Bool :=
  (text.splitOn "${").tail.any fun part =>
    match part.splitOn "}" with
    | name :: _ :: _ =>
      match name.toList with
      | first :: rest => 'A' ≤ first ∧ first ≤ 'Z' && rest.all isUpperOrDigit
      | [] => false
    | _ => false

private def stripSlashes (s : String) : String :=
  let dropSlash (cs : List Char) := cs.dropWhile (· == '/')
  String.ofList (dropSlash (dropSlash s.toList).reverse).reverse

private def trimmedOrUndef (value : Json) : Json :=
  if isNullish value then undef else
  let text := jsTrim (str value)
  if text.isEmpty then undef else toJson text

/-- `normalizeWorkspaceStorage`. -/
def normalizeWorkspaceStorage (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if isUndef value then return Json.mkObj [("provider", toJson "s3")]
  if field value "provider" == toJson "disk" then
    match ["bucket", "region", "endpoint", "prefix", "auth"].find?
        (fun key => !isUndef (field value key)) with
    | some extra =>
      return ← clientError
        s!"config.storage.{extra} does not apply to \"disk\": its files live on the sandbox's own disk"
    | none => return Json.mkObj [("provider", toJson "disk")]
  let bucket := trimmedOrUndef (field value "bucket")
  let region := trimmedOrUndef (field value "region")
  let endpoint := trimmedOrUndef (field value "endpoint")
  let keyPrefix := trimmedOrUndef (field value "prefix")
  if truthy bucket && (isUndef keyPrefix || (stripSlashes (str keyPrefix)).isEmpty) then
    return ← clientError
      "config.storage.prefix is required when config.storage.bucket is set; the sandbox mount is scoped to that prefix"
  let auth ← Prog.effect "normalizeWorkspaceStorageAuth" [field value "auth"]
  let literals : List (String × Json) :=
    [("config.storage.bucket", bucket), ("config.storage.region", region),
     ("config.storage.endpoint", endpoint), ("config.storage.prefix", keyPrefix)] ++
    (if field auth "type" == toJson "assumeRole"
      then [("config.storage.auth.roleArn", field auth "roleArn")] else [])
  match literals.find? (fun (_, literal) => truthy literal && hasEnvPlaceholder (str literal)) with
  | some (name, _) => clientError s!"{name} cannot be an env reference; only R2 keys take env()"
  | none =>
    let provider := orElse (field value "provider") (toJson "s3")
    let optional (key : String) (item : Json) : List (String × Json) :=
      if truthy item then [(key, item)] else []
    let storage := Json.mkObj ([("provider", provider)] ++ optional "bucket" bucket ++
      optional "region" region ++ optional "endpoint" endpoint ++ optional "prefix" keyPrefix ++
      optional "auth" auth)
    let _ ← Prog.effect "workspaceStorageOwnAuth" [storage]
    return storage

/-- `normalizeWorkspaceConfig`. -/
def normalizeWorkspaceConfig (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if isNullish value then
    return Json.mkObj [("storage", Json.mkObj [("provider", toJson "s3")])]
  let config ← Prog.effect "parseInput"
    [Json.mkObj [("$opaque", toJson "ZodMiniObject")], value, toJson "config"]
  let storage ← Prog.effect "normalizeWorkspaceStorage" [field config "storage"]
  let harness := field config "harness"
  let workspacePrompt ← Prog.effect "disabledFeature" [field harness "workspace"]
  let memory ← Prog.effect "disabledFeature" [field harness "memory"]
  let harnessKeys : List (String × Json) :=
    (if truthy workspacePrompt then [("workspace", workspacePrompt)] else []) ++
    (if truthy memory then [("memory", memory)] else [])
  let isolation := field config "isolation"
  return Json.mkObj ([("storage", storage)] ++
    (if truthy isolation then [("isolation", isolation)] else []) ++
    (if harnessKeys.isEmpty then [] else [("harness", Json.mkObj harnessKeys)]))

private def throwIfAborted (options : Json) : Prog Unit := do
  if truthy (field options "abortSignal") then
    let _ ← Prog.effect "options.abortSignal?.throwIfAborted"

/-- The driver's private `#session`: builds the session and reports its usage. -/
private def driverSession (self options reservation : Json) : Prog Json := do
  let driver := Twin.field self "#options"
  let env ← Prog.effect "stringRecord" [field (field driver "config") "envVars"]
  let session ← Prog.effect "new MicrovmHarnessSession"
    [Json.mkObj
      [("reservation", reservation),
       ("executor", Twin.field self "#executor"),
       ("reservationKey", field driver "reservationKey"),
       ("defaultWorkingDirectory", orElse (field driver "defaultWorkingDirectory") (toJson "/workspace")),
       ("env", env),
       ("ports", orElse (field driver "ports") (.arr #[])),
       ("shared", toJson (field driver "shared" == toJson true))]]
  let _ ← Prog.effect "reportSandboxUsage"
    [session, field driver "onUsage", field options "abortSignal"]
  throwIfAborted options
  return session

private def reservationRequest (driver options : Json) (shared : Bool) : Json :=
  let signal := field options "abortSignal"
  let metadata := field driver "metadata"
  Json.mkObj ([("reservationKey", field driver "reservationKey")] ++
    (if truthy signal then [("abortSignal", signal)] else []) ++
    (if truthy metadata then [("metadata", metadata)] else []) ++
    (if shared && truthy (field driver "shared") then [("shared", toJson true)] else []))

/-- `MicrovmHarnessDriver.createSession`. -/
def createSession (call : Json) : Prog Json := do
  let self := Twin.self call
  let options := Twin.callArg call 0
  let driver := Twin.field self "#options"
  let identity := field options "identity"
  let expected := field driver "bootstrapIdentity"
  if !isUndef identity && !isUndef expected && identity != expected then
    return ← Prog.throwError "Error"
      "MicroVM Harness bootstrap identity does not match this reservation"
  throwIfAborted options
  let reservation ← Prog.effect "this.#executor.acquireHarnessReservation"
    [reservationRequest driver options true]
  let body : Prog Json := do
    throwIfAborted options
    let session ← driverSession self options reservation
    return Json.mkObj [("session", session), ("isFirstCreate", field reservation "isFirstCreate")]
  Prog.catchFail body (rethrowingUnsupported fun error => do
    if truthy (field reservation "isFirstCreate") && field driver "shared" != toJson true &&
        !isUndef (field (Twin.field self "#executor") "release") then
      let _ ← Prog.attempt "this.#executor .release"
        [Json.mkObj [("reservationKey", field driver "reservationKey")]]
    Prog.fail error)

/-- `MicrovmHarnessDriver.resumeSession`. -/
def resumeSession (call : Json) : Prog Json := do
  let self := Twin.self call
  let options := Twin.callArg call 0
  throwIfAborted options
  let reservation ← Prog.effect "this.#executor.resumeHarnessReservation"
    [reservationRequest (Twin.field self "#options") options false]
  throwIfAborted options
  driverSession self options reservation

private def readTarget (ws : Json) : Prog Json := do
  let context ← Prog.effect "workspaceReadContext"
    [field (field ws "config") "storage", field ws "namespace"]
  Prog.effect "resolveS3ReadTarget" [context]

/-- Calls an S3 helper with the target's `access` only when it has one. -/
private def withAccess (label : String) (target : Json) (args : List Json) : Prog Outcome :=
  let access := field target "access"
  Prog.attempt label (args ++ (if truthy access then [access] else []))

private def errorMessage (error : Json) : String :=
  let inner := field error "$error"
  if isUndef inner then str error else str (field inner "message")

private def padStart6 (text : String) : String :=
  String.ofList (List.replicate (6 - text.length) ' ') ++ text

private def positive? (value : Json) (fallback : Nat) : Nat :=
  match value with
  | .num _ => match num? value with
    | some n => if n > 0 then n else fallback
    | none => fallback
  | _ => fallback

/-- `s3ReadNumbered`. -/
def s3ReadNumbered (call : Json) : Prog Json := do
  let ws := Twin.callArg call 0
  let rel := str (Twin.callArg call 1)
  let target ← readTarget ws
  let key := str (field target "prefix") ++ rel
  match ← withAccess "readS3Text" target [field target "bucket", toJson key] with
  | .ok textJson =>
    let text := str textJson
    let parts := text.splitOn "\n"
    let lines := if text.endsWith "\n" then parts.dropLast else parts
    let start := positive? (Twin.callArg call 2) 1
    let count := positive? (Twin.callArg call 3) 2000
    let selected := (lines.drop (start - 1)).take count
    let numbered := "\n".intercalate (selected.zipIdx.map fun (line, index) =>
      padStart6 (toString (start + index)) ++ "\t" ++ line)
    pure (toJson (if numbered.isEmpty then "" else numbered ++ "\n"))
  | .threw cause _ =>
    let missing ← Prog.effect "isMissingS3Error" [cause]
    if truthy missing then
      Prog.effect "toolError" [toJson s!"Error: file not found: {rel}"]
    else
      Prog.effect "toolError" [toJson (errorMessage cause)]
  | .pending => Prog.unsupported "read never settled"

/-- Newest first, stable, as `sort` with `localeCompare` orders the ISO timestamps S3 reports. -/
private def sortNewestFirst (entries : List (String × String)) : List (String × String) :=
  entries.mergeSort fun a b => b.2 ≤ a.2

/-- `s3Glob`. -/
def s3Glob (call : Json) : Prog Json := do
  let ws := Twin.callArg call 0
  let pattern := Twin.callArg call 1
  let path := Twin.callArg call 2
  let target ← readTarget ws
  let rootRel ←
    if truthy path then Prog.effect "toWorkspaceRelative" [path] else pure (toJson ".")
  let keyPrefix := str (field target "prefix")
  let searchPrefix := if rootRel == toJson "." then keyPrefix else s!"{keyPrefix}{str rootRel}/"
  match ← withAccess "listS3Prefix" target [field target "bucket", toJson searchPrefix] with
  | .ok objects =>
    let _ ← Prog.effect "new Bun.Glob" [pattern]
    let mut kept : List (String × String) := []
    for object in items objects do
      let rel := String.ofList ((str (field object "key")).toList.drop searchPrefix.length)
      if !rel.isEmpty && !rel.endsWith "/" then
        let matched ← Prog.effect "matcher.match" [toJson rel]
        if truthy matched then
          kept := kept ++ [(rel, str (orElse (field object "lastModified") (toJson "")))]
    let matches_ := (sortNewestFirst kept).map (·.1)
    pure (toJson (if matches_.isEmpty then "No files found\n" else "\n".intercalate matches_ ++ "\n"))
  | .threw cause _ => Prog.effect "toolError" [toJson (errorMessage cause)]
  | .pending => Prog.unsupported "listing never settled"

/-- `workspaceMediaUrl`. -/
def workspaceMediaUrl (call : Json) : Prog Json := do
  let ws := Twin.callArg call 0
  let rel := Twin.callArg call 1
  let baseUrl ← Prog.effect "getHarnessPublicUrl"
  if !truthy baseUrl then
    return ← Prog.effect "toolError"
      [toJson "Error: sending a workspace file needs PUBLIC_BASE_URL configured"]
  let target ← readTarget ws
  let key := str (field target "prefix") ++ str rel
  let existsOutcome ← withAccess "s3ObjectExists" target [field target "bucket", toJson key]
  let exists_ ←
    match existsOutcome with
    | .ok value => pure value
    | .threw error _ => Prog.fail error
    | .pending => Prog.unsupported "existence check never settled"
  if !truthy exists_ then
    return ← Prog.effect "toolError" [toJson s!"Error: file not found: {str rel}"]
  let secrets ← Prog.effect "requireSecretsEnv" [toJson "MEDIA_TICKET_SECRET"]
  let token ← Prog.effect "sealMediaTicket"
    [Json.mkObj [("accountId", Twin.callArg call 2), ("workspaceId", field ws "workspaceId"),
      ("namespace", field ws "namespace"), ("path", rel)],
     (items secrets).headD undef]
  return toJson (str baseUrl ++ "/v1/media/" ++ str token)

/-- `workspaceMediaBytes`. -/
def workspaceMediaBytes (call : Json) : Prog Json := do
  let ws := Twin.callArg call 0
  let target ← readTarget ws
  Prog.effect "readS3Bytes"
    [field target "bucket", toJson (str (field target "prefix") ++ str (Twin.callArg call 1)),
     field target "access", Twin.callArg call 2]

/-- `runSandboxOn`. -/
def runSandboxOn (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let ns := Twin.callArg call 1
  let options := Twin.callArg call 3
  let provider := field config "provider"
  let executor ← Prog.effect "createSandboxExecutor" [config]
  -- A fallback run reaches the real MicroVM executor, whose effects record inside this call.
  if field executor "$opaque" == toJson "MicrovmSandboxExecutor" && !truthy ns &&
      isUndef (field config "network") then
    return ← Prog.unsupported "the real MicroVM executor records its internals inline"
  let limits ← Prog.effect "workspaceSandboxLimits" [provider]
  let reservationKey ←
    if !truthy ns && field config "persistent" == toJson true then
      Prog.effect "statelessReservationKeyFor" [config]
    else pure undef
  let startedAt ← Prog.effect "Date.now"
  let namespaceKeys ←
    if truthy ns then do
      let root ← Prog.effect "workspaceRootFor" [config]
      pure [("namespace", ns), ("workspaceRoot", root)]
    else pure []
  let reservationKeys ←
    if truthy reservationKey then do
      let root ← Prog.effect "workspaceRootFor" [config]
      pure [("reservationKey", reservationKey), ("workspaceRoot", root)]
    else pure []
  let optional (key : String) : List (String × Json) :=
    if truthy (field options key) then [(key, field options key)] else []
  let timeout ← Prog.effect "sandboxTimeoutSeconds" [config]
  let outputLimit ← Prog.effect "boundedInteger"
    [field config "outputLimitBytes", field limits "defaultOutputLimitBytes",
     field limits "maxOutputLimitBytes"]
  let request := Json.mkObj ([("code", Twin.callArg call 2)] ++ namespaceKeys ++ reservationKeys ++
    optional "metadata" ++ optional "principal" ++
    [("timeoutSeconds", timeout), ("outputLimitBytes", outputLimit)])
  match ← Prog.attempt "executor .run" [request] with
  | .ok result => return result
  | .threw error _ =>
    let isTimeout ← Prog.effect "isTimeoutError" [error]
    if !truthy isTimeout then return ← Prog.fail error
    let now ← Prog.effect "Date.now"
    match num? now, num? startedAt with
    | some finished, some started =>
      return Json.mkObj
        [("ok", toJson false), ("runtime", toJson "bash"), ("exitCode", Json.null),
         ("stdout", toJson ""),
         ("stderr", toJson "no answer from the sandbox in time; the command may still be running there"),
         ("durationMs", toJson (finished - started)), ("timedOut", toJson true),
         ("provider", provider)]
    | _, _ => Prog.unsupported "non-numeric clock"
  | .pending => Prog.unsupported "run never settled"

/-- `runSandbox`. -/
def runSandbox (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let ns := Twin.callArg call 1
  let code := Twin.callArg call 2
  let options := Twin.callArg call 3
  let first ← Prog.attempt "runSandboxOn" [config, ns, code, options]
  let result ←
    match first with
    | .ok value => pure value
    | .pending => Prog.unsupported "run never settled"
    | .threw error _ => do
      let fallback := field config "fallbackProvider"
      if !truthy fallback || field (field error "$error") "$class" != toJson "SandboxCapacityError" then
        Prog.fail error
      else
        let _ ← Prog.effect "toErrorMessage" [error]
        let primary := (spread config).filter fun (key, _) =>
          key != "fallbackProvider" && key != "options" && key != "snapshot" && key != "controlPlane"
        let controlPlane := field config "controlPlane"
        let planeKeys ←
          if truthy controlPlane then do
            let specs ← Prog.effect "resolveSandboxSpecs"
              [Json.mkObj ([("provider", fallback)] ++
                (if isUndef (field config "size") then [] else [("size", field config "size")]))]
            pure [("controlPlane", Json.mkObj
              (((spread controlPlane).filter fun (key, _) => key != "ownCredentials") ++
                [("specs", specs)]))]
          else pure []
        let rebuilt := Json.mkObj
          ((primary.filter fun (key, _) => key != "provider") ++ [("provider", fallback)] ++ planeKeys)
        Prog.effect "runSandboxOn" [rebuilt, ns, code, options]
  let cpu := field result "cpuUsec"
  match num? cpu with
  | some usec =>
    if usec > 0 && truthy (field options "onSandboxCpu") then
      let _ ← Prog.effect "options?.onSandboxCpu"
        [Json.mkObj [("type", field result "provider"), ("role", toJson "agent"), ("cpuUsec", cpu)]]
  | none => pure ()
  return result

private def isHttpUrl (url : String) : Bool :=
  let lower := url.toLower
  lower.startsWith "http://" || lower.startsWith "https://"

/-- `resolveImages`. -/
def resolveImages (call : Json) : Prog Json := do
  let source := Twin.callArg call 0
  let urls := items (Twin.callArg call 1)
  let filePaths := items (Twin.callArg call 2)
  if !filePaths.isEmpty && !urls.isEmpty then
    return ← Prog.effect "toolError" [toJson "Error: send-images takes file_paths or urls, not both"]
  if !filePaths.isEmpty then
    let ws ← Prog.effect "resolveWorkspace" [field source "workspaces", Twin.callArg call 3]
    let accountId := field source "accountId"
    if !truthy ws || !truthy accountId then
      return ← Prog.effect "toolError" [toJson "Error: no workspace attached"]
    let outcomes ← Prog.all (filePaths.map fun path =>
      ("workspaceAttachment", [toJson "image", ws, path, accountId]))
    let mut attachments : List Json := []
    for outcome in outcomes do
      match outcome with
      | .ok value => attachments := attachments ++ [value]
      | .threw error _ => return ← Prog.fail error
      | .pending => return ← Prog.unsupported "attachment never settled"
    return .arr attachments.toArray
  if urls.isEmpty then
    return ← Prog.effect "toolError"
      [toJson "Error: send-images needs either file_paths (workspace files) or urls (public image URLs)"]
  match urls.find? (fun url => !isHttpUrl (str url)) with
  | some rejected =>
    Prog.effect "toolError" [toJson s!"Error: not a public http(s) URL: {str rejected}"]
  | none =>
    let mut images : List Json := []
    for url in urls do
      let name ← Prog.effect "channelAttachmentName"
        [Json.mkObj [("type", toJson "image"), ("url", url)]]
      let mimeType ← Prog.effect "contentTypeForPath" [name]
      images := images ++ [Json.mkObj
        [("type", toJson "image"), ("url", url), ("name", name), ("mimeType", mimeType)]]
    return .arr images.toArray

/-- `releaseExpiredSandboxes`. -/
def releaseExpiredSandboxes (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let reservations := items (Twin.callArg call 1)
  if reservations.isEmpty then return .arr #[]
  let configs ← Prog.effect "sandboxConfigs" [accountId]
  let mut released : List Json := []
  for reservation in reservations do
    let provider := field reservation "provider"
    let key := field reservation "reservationKey"
    let externalId := field reservation "externalId"
    let takenOutcome ← Prog.attempt "deleteSandboxInstance"
      [provider, key, accountId, externalId, toJson true]
    let taken ←
      match takenOutcome with
      | .ok value => pure (truthy value)
      | .threw error _ => do
        let _ ← Prog.effect "toErrorMessage" [error]
        pure false
      | .pending => Prog.unsupported "take never settled"
    if taken then
      let outcome ← Prog.effect "releaseOnProvider" [accountId, provider, configs, key, externalId]
      if truthy (field outcome "released") then
        released := released ++ [reservation]
        let _ ← Prog.effect "queueMirrorRemove" [accountId, key, externalId]
      else
        let handedBack ← Prog.attempt "claimSandboxInstance"
          [provider, key, externalId, accountId, field reservation "ttlSeconds"]
        let kept ← match handedBack with
          | .ok value => pure (truthy value)
          | .threw _ _ => pure false
          | .pending => Prog.unsupported "hand-back never settled"
        if !kept then
          let _ ← Prog.effect "keepForSweep" [accountId, provider, key, externalId]
  return .arr released.toArray

/-- `TEARDOWN_RETRY_SECONDS` (`sandbox-cleanup.ts:33`). -/
def teardownRetrySeconds : Nat := 60

/-- `keepForSweep`: re-reserves a machine whose teardown failed under `teardown:<externalId>`,
unless the original key already names it again. -/
def keepForSweep (call : Json) : Prog Json := do
  let provider := Twin.callArg call 1
  let key := Twin.callArg call 2
  let externalId := Twin.callArg call 3
  Prog.catchFail (do
    let current ← Prog.effect "getSandboxExternalId" [provider, key]
    if current == externalId then return Twin.undefinedJson
    let _ ← Prog.effect "claimSandboxInstance"
      [provider, toJson ("teardown:" ++ str externalId), externalId, Twin.callArg call 0,
       toJson teardownRetrySeconds]
    return Twin.undefinedJson)
    (fun error => do
      let _ ← Prog.effect "toErrorMessage" [error]
      return Twin.undefinedJson)

/-- `SANDBOX_PROVIDERS` without the stateless ones, in declared order. -/
private def releasableProviders : List String :=
  ["sandbox", "lambda", "e2b", "daytona", "vercel", "cloudflare", "worker"]

/-- `releaseReservedSandboxes`. -/
def releaseReservedSandboxes (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let namespaces := items (Twin.callArg call 1)
  if namespaces.isEmpty then return toJson (0 : Nat)
  let configs ← Prog.effect "sandboxConfigs" [accountId]
  let mut released : Nat := 0
  for ns in namespaces do
    let mut machines : List Json := []
    for provider in releasableProviders do
      let outcome ← Prog.effect "releaseOnProvider" [accountId, toJson provider, configs, ns]
      let released_ := truthy (field outcome "released")
      if released_ then machines := machines ++ [field outcome "externalId"]
      let dropped ← Prog.attempt "deleteSandboxInstance" [toJson provider, ns, accountId]
      let dropped ← match dropped with
        | .ok value => pure (truthy value)
        | .threw _ _ => pure false
        | .pending => Prog.unsupported "reservation delete never settled"
      if dropped && truthy outcome && !released_ then
        let _ ← Prog.effect "keepForSweep" [accountId, toJson provider, ns, field outcome "externalId"]
    released := released + machines.length
    let fences := if machines.isEmpty then [undef] else machines
    let _ ← Prog.all (fences.map fun machine => ("queueMirrorRemove", [accountId, ns, machine]))
  return toJson released

private def sandboxDir : String := "apps/core/src/harness/sandbox/"
private def microvm : String := sandboxDir ++ "microvm-executor.ts#"
private def session : String := sandboxDir ++ "microvm-harness-driver.ts#MicrovmHarnessSession."
private def vercel : String := sandboxDir ++ "vercel-executor.ts#VercelSandboxExecutor."
private def driver : String := sandboxDir ++ "microvm-harness-driver.ts#MicrovmHarnessDriver."
private def tools : String := "apps/core/src/harness/tools/filesystem-utils.ts#"
private def cleanup : String := "apps/core/src/shared/sandbox-cleanup.ts#"
private def rules : String := "packages/convex/model/workspaceRules.ts#"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (rules ++ "platformAwsAccountId") platformAwsAccountId,
   Twin.traced "packages/convex/model/sandboxRules.ts#positiveIntegerEnv" positiveIntegerEnv,
   Twin.traced (rules ++ "assertStorageEndpoint") assertStorageEndpoint,
   Twin.traced (rules ++ "workspaceStorageOwnAuth") workspaceStorageOwnAuth,
   Twin.traced (sandboxDir ++ "s3-mount.ts#resolveS3MountIdentity") resolveS3MountIdentity,
   Twin.traced (microvm ++ "isMicrovmGone") isMicrovmGone,
   Twin.traced (sandboxDir ++ "utils.ts#isSandboxGoneError") isSandboxGoneError,
   Twin.traced (vercel ++ "release") vercelRelease,
   Twin.traced (vercel ++ "snapshot") vercelSnapshot,
   Twin.traced "apps/core/src/shared/s3.ts#awsClient" awsClient,
   Twin.traced (sandboxDir ++ "harness-shell-process.ts#HarnessShellProcess.kill") harnessKill,
   Twin.traced (session ++ "spawnCommand") spawnCommand,
   Twin.traced (session ++ "stop")
     (sessionTeardown "suspend" "MicroVM Harness reservation cannot be suspended"),
   Twin.traced (session ++ "destroy")
     (sessionTeardown "release" "MicroVM Harness reservation cannot be released"),
   Twin.traced (microvm ++ "MicrovmSandboxExecutor.release") microvmRelease,
   Twin.traced (microvm ++ "MicrovmSandboxExecutor.getInstanceInfo") microvmInstanceInfo,
   Twin.traced (sandboxDir ++ "cloudflare-executor.ts#CloudflareSandboxExecutor.getInstanceInfo")
     cloudflareInstanceInfo,
   Twin.traced (microvm ++ "markMountCredentialsFresh") markMountCredentialsFresh,
   Twin.traced (microvm ++ "MicrovmSandboxExecutor.createHarnessAuthToken") createHarnessAuthToken,
   Twin.traced (tools ++ "bashTargetLines") bashTargetLines,
   Twin.traced (rules ++ "normalizeWorkspaceStorage") normalizeWorkspaceStorage,
   Twin.traced (rules ++ "normalizeWorkspaceConfig") normalizeWorkspaceConfig,
   Twin.traced (driver ++ "createSession") createSession,
   Twin.traced (driver ++ "resumeSession") resumeSession,
   Twin.traced (tools ++ "s3ReadNumbered") s3ReadNumbered,
   Twin.traced (tools ++ "s3Glob") s3Glob,
   Twin.traced (tools ++ "workspaceMediaUrl") workspaceMediaUrl,
   Twin.traced (tools ++ "workspaceMediaBytes") workspaceMediaBytes,
   Twin.traced (tools ++ "runSandboxOn") runSandboxOn,
   Twin.traced (tools ++ "runSandbox") runSandbox,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#resolveImages" resolveImages,
   Twin.traced (cleanup ++ "releaseExpiredSandboxes") releaseExpiredSandboxes,
   Twin.traced (cleanup ++ "releaseReservedSandboxes") releaseReservedSandboxes,
   Twin.traced (cleanup ++ "keepForSweep") keepForSweep]

end Spec.Sandbox.Wavesandbox4a
