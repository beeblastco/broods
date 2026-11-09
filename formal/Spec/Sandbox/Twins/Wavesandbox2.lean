import Spec.Twin
import Spec.Sandbox.Twins.Tools.Js
import Spec.Config.Twins.Js

namespace Spec.Sandbox.Wavesandbox2

open Lean Spec

private def field (j : Json) (k : String) : Json :=
  (j.getObjVal? k).toOption.getD Twin.undefinedJson

private def str (j : Json) : String := j.getStr?.toOption.getD ""
private def items (j : Json) : List Json := j.getArr?.toOption.getD #[] |>.toList
private def entries (j : Json) : List (String × Json) :=
  if j == Twin.undefinedJson then [] else
  match j with | .obj kv => kv.toList | _ => []
private def undef (j : Json) : Bool := j == Twin.undefinedJson
private def truthy (j : Json) : Bool := !undef j && Tools.truthy j
private def obj (kv : List (String × Json)) : Json :=
  Json.mkObj (kv.filter fun (_, v) => !undef v)
private def merge (base : Json) (kv : List (String × Json)) : Json :=
  obj ((entries base).filter (fun (k, _) => !kv.any (·.1 == k)) ++ kv)
private def nullish (j fallback : Json) : Json :=
  if undef j || j == .null then fallback else j
private def fn (name : String) : Json := Json.mkObj [("$fn", toJson name)]
private def jsString (j : Json) : String :=
  if undef j then "undefined" else
  match j with | .str s => s | .obj _ => "[object Object]" | _ => j.compress
private def pureTwin (source : String) (f : Json → Json) : Twin :=
  Twin.traced source (fun call => pure (f call))

private def classifyVercelError (call : Json) : Json := Id.run do
  let err := Twin.callArg call 0
  let wrapped := field err "$error"
  let message := if undef wrapped then jsString err else str (field wrapped "message")
  let fields := if undef wrapped then err else field wrapped "fields"
  let numeric := [field fields "status", field fields "statusCode", field (field fields "response") "status"]
    |>.find? fun v => match v with | .num _ => true | _ => false
  let tails := (message.toLower.splitOn "status code ").drop 1
  let statusText := tails.findSome? fun tail =>
    let digits := String.ofList (tail.toList.takeWhile Char.isDigit)
    let rest := tail.toList.drop digits.length
    if (digits == "401" || digits == "403") &&
      !(rest.head?.any fun c => c.isAlphanum || c == '_') then some digits else none
  let status := numeric.getD ((statusText.map (fun s => toJson (s.toNat?.getD 0))).getD Twin.undefinedJson)
  if status == toJson (401 : Nat) || status == toJson (403 : Nat) then
    let reason := ((message.splitOn " is not ok:").drop 1).head?.bind fun s =>
      let r := String.ofList (s.toList.dropWhile Char.isWhitespace)
      if r.isEmpty then none else some r
    return Prog.errorJson "Error" ("Vercel Sandbox rejected the request (HTTP " ++ jsString status ++ "): " ++
      reason.getD "the VERCEL_TOKEN is invalid or lacks access to the configured team/project." ++
      " Verify VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and options.networkId when set.")
  return if undef wrapped then Prog.errorJson "Error" message else err

private def base64Bytes (call : Json) : Json :=
  let s := str (Twin.callArg call 0)
  let chars := s.toList
  let payload := chars.takeWhile (· != '=')
  let padding := chars.drop payload.length
  if s.length % 4 != 0 || padding.length > 2 || !padding.all (· == '=') ||
    !payload.all (fun c => c.isAlpha || c.isDigit || c == '+' || c == '/') then Twin.undefinedJson
  else toJson (s.length / 4 * 3 - padding.length)

private def jpegLoop (bytes : Array Nat) : Nat → Nat → Json
  | 0, _ => Twin.undefinedJson
  | fuel + 1, offset =>
    if offset + 9 > bytes.size || bytes.getD offset 0 != 255 then Twin.undefinedJson else
    let marker := bytes.getD (offset + 1) 0
    if marker == 255 then jpegLoop bytes fuel (offset + 1)
    else if marker >= 192 && marker <= 207 && marker != 196 && marker != 200 && marker != 204 then
      obj [("width", toJson (bytes.getD (offset + 7) 0 * 256 + bytes.getD (offset + 8) 0)),
        ("height", toJson (bytes.getD (offset + 5) 0 * 256 + bytes.getD (offset + 6) 0))]
    else jpegLoop bytes fuel (offset + 2 + bytes.getD (offset + 2) 0 * 256 + bytes.getD (offset + 3) 0)

private def jpegSize (call : Json) : Json :=
  let bytes := Tools.fromBase64 (str (field (Twin.callArg call 0) "$bytes"))
  jpegLoop bytes bytes.size 2

private def platformWorkerConnection (call : Json) : Prog Json := do
  let urlEnv := Twin.callArg call 0
  let keyEnv := Twin.callArg call 1
  let base ← Prog.effect "optionalEnv" [urlEnv]
  let key ← Prog.effect "optionalEnv" [keyEnv]
  if !truthy base || !truthy key then
    return ← Prog.throwError "Error" s!"the {str (Twin.callArg call 2)} sandbox provider needs {str urlEnv} and {str keyEnv} on core"
  let url := str base
  let parts := url.splitOn "://"
  if parts.length != 2 then return ← Prog.unsupported "URL syntax outside absolute hierarchical URLs"
  let protocol := parts.headD ""
  let host := ((parts[1]!).splitOn "/").headD ""
  let hostname := if host.startsWith "[" then (host.splitOn "]").headD "" ++ "]" else (host.splitOn ":").headD ""
  if protocol != "https" && !["localhost", "127.0.0.1", "[::1]"].contains hostname then
    return ← Prog.throwError "Error" (str urlEnv ++ " must be https outside loopback")
  return obj [("baseURL", toJson (String.ofList (url.toList.reverse.dropWhile (· == '/')).reverse)), ("apiKey", key)]

private def mountAttribution (call : Json) : Prog Json := do
  let account := field (field (Twin.callArg call 0) "controlPlane") "accountId"
  if !truthy account then return Twin.undefinedJson
  let request := Twin.callArg call 1
  let agent := field (field request "metadata") "agentId"
  let mut own := false
  if !undef agent then
    let folder ← Prog.effect "agentNamespaceFolder" [agent]
    own := (str (field request "namespace")).endsWith ("/" ++ str folder)
  return obj [("accountId", account), ("agentId", if own then agent else Twin.undefinedJson)]

private def parseJobStatus (call : Json) : Json :=
  let text := (str (Twin.callArg call 1)).trimAscii.toString
  let job := Twin.callArg call 0
  if text.startsWith "done" then
    let words := text.splitOn " " |>.filter (· != "")
    let code := (words[1]?.bind String.toInt?).map toJson |>.getD Json.null
    obj [("jobId", job), ("state", toJson (if code == toJson (0 : Int) then "completed" else "failed")), ("exitCode", code)]
  else obj [("jobId", job), ("state", toJson (if text == "running" then "running" else "unknown"))]

private def rejectPending (call : Json) : Prog Json := do
  let entries := items (field (field (Twin.callArg call 0) "pending") "$map")
  for entry in entries do
    let pending := Twin.arg entry 1
    let _ ← Prog.effect "clearTimeout" [field pending "timer"]
    let _ ← Prog.effect "pending.reject" [Json.mkObj [("$error", Json.mkObj
      [("name", toJson "Error"), ("message", Twin.callArg call 1), ("fields", Json.mkObj []),
       ("$class", toJson "Error")])]]
  if !entries.isEmpty then Prog.setState "args.0.pending.$map" (.arr #[])
  return Twin.undefinedJson

private def stripSlashes (s : String) : String :=
  String.ofList (((s.toList.dropWhile (· == '/')).reverse.dropWhile (· == '/')).reverse)

private def joinPrefix (call : Json) : Json :=
  let parts := [Twin.callArg call 0, Twin.callArg call 1] |>.map (stripSlashes ∘ str)
  let joined := String.intercalate "/" (parts.filter (· != ""))
  toJson (if joined.isEmpty then "" else joined ++ "/")

private def sandboxJobRef (call : Json) : Json :=
  let input := Twin.callArg call 0
  if field input "kind" == toJson "sandbox_job" && (field input "namespace").getStr?.isOk &&
    (field input "jobId").getStr?.isOk then
    obj [("namespace", field input "namespace"), ("jobId", field input "jobId")]
  else Twin.undefinedJson

private def settledResult (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let status := field record "status"
  if status == toJson "failed" then
    return obj [("status", status), ("error", nullish (field record "error") .null)]
  if Twin.callArg call 1 == toJson "logs" then
    let logs ← Prog.effect "settledJobLogs" [field record "response"]
    if !undef logs then return if str logs == "" then toJson "(no output)" else logs
  return obj [("status", status), ("response", nullish (field record "response") .null)]

private def subagentConfig (call : Json) : Json := Id.run do
  let config := Twin.callArg call 0
  let parent := Twin.callArg call 1
  let mut kv := [("subagent", merge (field config "subagent") [("enabled", toJson false)])]
  for key in ["policies", "denyTools"] do
    let combined := (items (field parent key) ++ items (field config key)).foldl
      (fun acc v => if acc.contains v then acc else acc ++ [v]) ([] : List Json)
    if !combined.isEmpty then kv := kv ++ [(key, toJson combined)]
  return merge config kv

private def vercelSpecs (call : Json) : Json :=
  let sandbox := Twin.callArg call 0
  if undef (field sandbox "vcpus") || undef (field sandbox "memory") then Twin.undefinedJson
  else obj [("vcpu", field sandbox "vcpus"), ("memoryMb", field sandbox "memory")]

private def callTool (call : Json) : Prog Json := do
  let request := Twin.callArg call 1
  let name := str (field request "toolName")
  let execute := field (field (field (Twin.callArg call 0) "sandboxTools") name) "execute"
  if !truthy execute then return ← Prog.throwError "Error" s!"the {name} tool is not available"
  Prog.effect "execute" [field request "input", Twin.callArg call 2]

private def offersTargetChoice (call : Json) : Prog Json := do
  let context := Twin.callArg call 1
  if (items (field context "workspaces")).length > 1 then return toJson true
  if Twin.callArg call 0 != toJson "bash" then return toJson false
  let choices ← Prog.effect "sandboxParamChoices" [context]
  return toJson (!(items choices).isEmpty)

private def e2bSpecs (_call : Json) : Prog Json :=
  Prog.catchFail (do
    let info ← Prog.effect "sandbox.getInfo" [obj [("requestTimeoutMs", toJson (3000 : Nat))]]
    return obj [("vcpu", field info "cpuCount"), ("memoryMb", field info "memoryMB")])
    (fun _ => pure Twin.undefinedJson)

private def externalToolRuntimeConfig (call : Json) : Json :=
  obj ((entries (Twin.callArg call 0)).filter fun (k, _) => !["command", "enabled", "needsApproval"].contains k)

private def prependTextToUserParts (call : Json) : Json :=
  let lead := str (Twin.callArg call 0)
  let parts := items (Twin.callArg call 1)
  match parts with
  | first :: rest =>
    if field first "type" == toJson "text" then
      toJson (merge first [("text", toJson (lead ++ str (field first "text")))] :: rest)
    else toJson (obj [("type", toJson "text"), ("text", toJson lead)] :: parts)
  | [] => toJson [obj [("type", toJson "text"), ("text", toJson lead)]]

private def toolContentItems (call : Json) : Json :=
  toJson ((items (field (Twin.callArg call 0) "content")).flatMap fun part =>
    if field part "type" == toJson "tool-result" && field (field part "output") "type" == toJson "content"
    then items (field (field part "output") "value") else [])

private def parseToolResultOutput (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let result ← Prog.effect "toolModelMessageSchema.safeParse"
    [obj [("role", toJson "tool"), ("content", toJson [obj [("type", toJson "tool-result"),
      ("toolCallId", toJson ""), ("toolName", toJson ""), ("output", value)]])]]
  return if truthy (field result "success") then value else Twin.undefinedJson

private def namespaceIsolationSuffix (call : Json) : Json :=
  match (str (Twin.callArg call 0)).splitOn "/" with
  | _ :: rest@(_ :: _) => toJson (String.intercalate "/" rest)
  | _ => Twin.undefinedJson

private def exitCodeOf (call : Json) : Json :=
  let output := str (Twin.callArg call 0)
  if output.endsWith "[command failed]" then toJson (1 : Nat) else
  let tail := (output.splitOn "[exit code ").getLast!
  if tail.endsWith "]" then
    let digits := String.ofList (tail.toList.dropLast)
    if !digits.isEmpty && digits.toList.all Char.isDigit then toJson (digits.toNat?.getD 0) else toJson (0 : Nat)
  else toJson (0 : Nat)

private def isLocalShell (call : Json) : Json :=
  let ty := field (field (Twin.callArg call 0) "environment") "type"
  toJson (undef ty || ty == toJson "local")

private def workdirSizeResources (call : Json) : Json :=
  let (cpu, memory, disk) : Json × Nat × Nat := match str (Twin.callArg call 0) with
    | "tiny" => (toJson (0.5 : Float), 512, 8)
    | "xsmall" => (toJson (0.5 : Float), 1024, 8)
    | "small" => (toJson (1 : Nat), 2048, 8)
    | "medium" => (toJson (2 : Nat), 4096, 16)
    | _ => (toJson (4 : Nat), 8192, 32)
  obj [("cpu", cpu), ("memoryMb", toJson memory), ("diskGb", toJson disk)]

private def encodeKeys : Nat → Json → Json
  | 0, j => j
  | fuel + 1, .obj kv => Json.mkObj (kv.toList.map fun (k,v) =>
      (if k.startsWith "$" then "$" ++ k else k, encodeKeys fuel v))
  | fuel + 1, .arr a => .arr (a.map (encodeKeys fuel))
  | _, j => j


private def parseFrame (call : Json) : Prog Json :=
  match Twin.callArg call 1 with
  | .str raw =>
    match Json.parse raw with
    | .error _ => pure .null
    | .ok value => Prog.catchFail (do
      let parsed ← Prog.effect "schema.safeParse" [encodeKeys 64 value]
      return if truthy (field parsed "success") then field parsed "data" else .null)
        (fun _ => pure Json.null)
  | _ => pure .null

private def machineSocketUrl (call : Json) : Prog Json := do
  let parts := (str (Twin.callArg call 0)).splitOn "://"
  if parts.length != 2 then return ← Prog.unsupported "non hierarchical base URL"
  let scheme := if parts.headD "" == "https" then "wss" else "ws"
  let authority := ((parts[1]!).splitOn "/").headD ""
  return toJson (scheme ++ "://" ++ authority ++ "/v1/machines/ws")

private def isMachineUpgrade (call : Json) : Json :=
  let request := field (Twin.callArg call 0) "$request"
  let upgrade := (items (field request "headers")).find? fun h =>
    (str (Twin.arg h 0)).toLower == "upgrade"
  let ws := upgrade.any fun h => (str (Twin.arg h 1)).toLower == "websocket"
  let path := String.intercalate "/" (((str (field request "url")).splitOn "/").drop 3)
  let path := (path.splitOn "?").headD "" |>.splitOn "#" |>.headD ""
  toJson (field request "method" == toJson "GET" && ws && path == "v1/machines/ws")

private def isMissingS3Error (call : Json) : Json :=
  let err := Twin.callArg call 0
  let wrapped := field err "$error"
  let e := if undef wrapped then err else merge (field wrapped "fields") [("name", field wrapped "name")]
  let name := field e "name"
  toJson (name == toJson "NoSuchKey" || name == toJson "NotFound" ||
    (name == toJson "S3Error" && field e "status" == toJson (404 : Nat)) ||
    field e "code" == toJson "NoSuchKey" || field e "Code" == toJson "NoSuchKey" ||
    field (field e "$metadata") "httpStatusCode" == toJson (404 : Nat))

private def textPart (call : Json) : Json :=
  obj ([("type", toJson "text"), ("text", Twin.callArg call 0)] ++
    if truthy (Twin.callArg call 1) then [("providerOptions", Twin.callArg call 1)] else [])

private def isFatalSandboxSetupError (call : Json) : Json :=
  let text := (str (Twin.callArg call 0)).toLower
  toJson (["allocated memory limit", "resource limit", "quota exceeded", "invalid namespace: must match"].any
    fun needle => (text.splitOn needle).length > 1)

private def toolError (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let fatal ← Prog.effect "isFatalSandboxSetupError" [value]
  Prog.throwError "Error" (if truthy fatal then "Sandbox setup failed: " ++ str value else str value)

private def sandboxForNamespace (call : Json) : Json :=
  let found := (items (field (Twin.callArg call 0) "workspaces")).find? fun entry =>
    field entry "namespace" == Twin.callArg call 1 && truthy (field entry "sandbox")
  found.map (fun entry => field entry "sandbox") |>.getD Twin.undefinedJson

private def sessionIdentity (call : Json) : Json :=
  let a := Twin.callArg call 0
  let value := str (nullish (field a "agentId") (toJson ("acct-" ++ str (field a "accountId"))))
  toJson (String.ofList ((value.toList.map fun c =>
    if c.isAlphanum || "_+=,.@-".toList.contains c then c else '-').take 47))

private def nearsExpiry (call : Json) : Prog Json := do
  let expires := field (Twin.callArg call 0) "credentialsExpireAt"
  if undef expires then return toJson false
  let now ← Prog.effect "Date.now"
  return toJson (decide ((field expires "$date").getInt?.toOption.getD 0 - now.getInt?.toOption.getD 0 <= 600000))

private def workspaceReadContext (call : Json) : Prog Json := do
  let bucket ← Prog.effect "optionalEnv" [toJson "FILESYSTEM_BUCKET_NAME"]
  let region ← Prog.effect "optionalEnv" [toJson "AWS_REGION"]
  let region ← if undef region || region == .null then Prog.effect "optionalEnv" [toJson "AWS_DEFAULT_REGION"] else pure region
  return obj [("storage", Twin.callArg call 0), ("namespace", Twin.callArg call 1),
    ("managedBucket", bucket), ("region", region)]

private def assertSafeJobId (call : Json) : Prog Json := do
  let id := str (Twin.callArg call 0)
  if id.isEmpty || !id.toList.all (fun c => c.isAlphanum || c == '_' || c == '-') then
    return ← Prog.throwError "Error" ("Invalid job id: " ++ id)
  return Twin.undefinedJson

private def toScheduleSummary (call : Json) : Json :=
  let cron := Twin.callArg call 0
  obj ([("cronId", field cron "cronId"), ("name", field cron "name"),
    ("schedule", field cron "scheduleExpression"), ("status", field cron "status")] ++
    (["timezone", "conversationKey", "lastStatus", "lastInvokedAt"].filterMap fun k =>
      if truthy (field cron k) then some (k, field cron k) else none))

private def sendImagesDescription (call : Json) : Json :=
  let channel := str (Twin.callArg call 0)
  let source := if truthy (Twin.callArg call 1) then
    "Pass exactly one source: file_paths for images in the workspace, or urls for ones already published on the web."
    else "Pass urls, images already published on the web."
  let delivery := if truthy (Twin.callArg call 2) then
    s!"They arrive inline, so the recipient sees them without opening anything. Send a whole set in one call rather than one call per picture; {channel} decides how to group them."
    else s!"{channel} cannot show pictures inline, so they are delivered as files to download instead."
  toJson s!"Sends one or more images to the current {channel} conversation immediately. {source} {delivery} Use this for an intentional image message; the normal final text answer is delivered automatically. Documents that are not pictures go through send-files."

private def sendFilesDescription (call : Json) : Json :=
  let channel := str (Twin.callArg call 0)
  let delivery := if truthy (Twin.callArg call 1) then
    s!"The files are attached to the {channel} conversation."
    else s!"{channel} has no document attachment, so the files are posted as download links the recipient opens themselves."
  toJson s!"Sends one or more workspace documents to the current {channel} conversation immediately. {delivery} Use it for anything that is not a picture: PDFs, spreadsheets, and text files. Pictures go through send-images instead."

private def s3Hosts (call : Json) : Prog Json := do
  let mount := Twin.callArg call 0
  let endpoint := field mount "endpoint"
  let host ← if truthy endpoint then do
      let parts := (str endpoint).splitOn "://"
      if parts.length != 2 then Prog.unsupported "non hierarchical endpoint URL" else
        pure (((parts[1]!).splitOn "/").headD "" |>.splitOn ":" |>.headD "")
    else pure ("s3." ++ (if truthy (field mount "region") then str (field mount "region") ++ "." else "") ++ "amazonaws.com")
  return toJson [host, str (field mount "bucket") ++ "." ++ host]

private def runsOnProvider (call : Json) : Prog Json := do
  let id := Twin.callArg call 0
  let args := Twin.callArg call 1
  if id == toJson "openrouter.web_search" then return toJson true
  if id == toJson "openai.tool_search" then return toJson (field args "execution" != toJson "client")
  if id != toJson "openai.shell" then return toJson false
  let isLocal ← Prog.effect "isLocalShell" [args]
  return toJson (!truthy isLocal)

private def workdirResources (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let options := field input "options"
  let sized ← if truthy (field input "size") then Prog.effect "workdirSizeResources" [field input "size"] else pure Twin.undefinedJson
  let mut resources := []
  for key in ["cpu", "memoryMb", "diskGb"] do
    let positive ← Prog.effect "positiveNumber" [field options key]
    let value := nullish positive (field sized key)
    if !undef value then resources := resources ++ [(key, value)]
  return if resources.isEmpty then Twin.undefinedJson else obj resources

private def vercelAuthOptions (call : Json) : Prog Json := do
  let options := field (Twin.callArg call 0) "options"
  let mut kv := []
  for (key, env) in [("token", "VERCEL_TOKEN"), ("teamId", "VERCEL_TEAM_ID"), ("projectId", "VERCEL_PROJECT_ID")] do
    let configured ← Prog.effect "configString" [field options key]
    let value ← if undef configured || configured == .null then Prog.effect "optionalEnv" [toJson env] else pure configured
    kv := kv ++ [(key, value)]
  let missing := kv.filterMap fun (key, value) => if !truthy value then some key else none
  if !missing.isEmpty then
    return ← Prog.throwError "Error" ("vercel sandbox auth is missing " ++ String.intercalate ", " missing ++
      "; set config.options.{token,teamId,projectId} or VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID")
  return obj kv

private def imageSize (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let bytes := Tools.fromBase64 (str (field input "$bytes"))
  let media := str (Twin.callArg call 1)
  if media == "image/png" then
    if bytes.size < 24 || (bytes.toList.drop 12 |>.take 4) != [73, 72, 68, 82] then return Twin.undefinedJson
    let read := fun (offset : Nat) => ((List.range 4).foldl fun acc i => acc * 256 + bytes.getD (offset + i) 0) 0
    return obj [("width", toJson (read 16)), ("height", toJson (read 20))]
  if media == "image/gif" then
    if bytes.size < 10 then return Twin.undefinedJson
    return obj [("width", toJson (bytes.getD 6 0 + bytes.getD 7 0 * 256)),
      ("height", toJson (bytes.getD 8 0 + bytes.getD 9 0 * 256))]
  Prog.effect (if media == "image/webp" then "webpSize" else "jpegSize") [input]

private def executorS3Context (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let request := Twin.callArg call 1
  if !truthy (field request "namespace") then
    return ← Prog.throwError "Error" "an AWS S3 workspace mount requires a workspace namespace"
  let options := field config "options"
  let bucket ← Prog.effect "configString" [field options "workspaceBucketName"]
  let bucket ← if undef bucket || bucket == .null then Prog.effect "optionalEnv" [toJson "FILESYSTEM_BUCKET_NAME"] else pure bucket
  let region ← Prog.effect "configString" [field options "awsRegion"]
  let region ← if undef region || region == .null then Prog.effect "optionalEnv" [toJson "AWS_REGION"] else pure region
  let region ← if undef region || region == .null then Prog.effect "optionalEnv" [toJson "AWS_DEFAULT_REGION"] else pure region
  let endpoint ← Prog.effect "configString" [field options "s3Endpoint"]
  let attribution ← Prog.effect "mountAttribution" [config, request]
  return obj [("storage", field config "storage"), ("namespace", field request "namespace"),
    ("managedBucket", bucket), ("region", region), ("endpoint", endpoint), ("attribution", attribution)]

private def releaseCandidates (call : Json) : Prog Json := do
  let provider := Twin.callArg call 0
  let records := (items (Twin.callArg call 1)).filter fun r => field (field r "config") "provider" == provider
  let inst := Twin.callArg call 2
  let platform := obj [("provider", provider)]
  let mut configs := []
  if truthy (field inst "ownCredentials") then
    for record in records do
      if field record "sandboxId" == field inst "sandboxConfigId" then
        let own ← Prog.effect "runsOnOwnCredentials" [field record "config"]
        if truthy own then configs := configs ++ [field record "config"]
    return toJson configs
  if truthy inst then
    for record in records do
      let own ← Prog.effect "runsOnOwnCredentials" [field record "config"]
      if !truthy own then configs := configs ++ [field record "config"]
    return toJson (configs ++ [platform])
  return if [toJson "lambda", toJson "cloudflare", toJson "worker"].contains provider then toJson [platform]
    else toJson (records.map fun r => field r "config")

private def stringProp (description : String) : Json :=
  obj [("type", toJson "string"), ("description", toJson description)]

private def arrayProp (description : String) : Json :=
  obj [("type", toJson "array"), ("items", obj [("type", toJson "string")]),
    ("minItems", toJson (1 : Nat)), ("maxItems", toJson (10 : Nat)), ("description", toJson description)]

private def sendFilesSchema (call : Json) : Prog Json := do
  let workspace ← Prog.effect "workspaceParamSchema" [Twin.callArg call 0]
  return obj [("type", toJson "object"), ("properties", obj
    ([("file_paths", arrayProp "Paths to files in the workspace, each relative to the workspace root."),
      ("caption", stringProp "Optional text shown with the files.")] ++
      if truthy workspace then [("workspace", workspace)] else [])),
    ("required", toJson ["file_paths"]), ("additionalProperties", toJson false)]

private def sendImagesSchema (call : Json) : Prog Json := do
  let workspaces := Twin.callArg call 0
  let workspace ← Prog.effect "workspaceParamSchema" [workspaces]
  let props := (if !(items workspaces).isEmpty then
    [("file_paths", arrayProp "Paths to image files in the workspace, each relative to the workspace root.")] else []) ++
    [("urls", arrayProp "Absolute public http(s) URLs of images the chat provider can fetch."),
      ("caption", stringProp "Optional text shown with the images.")] ++
    (if truthy workspace then [("workspace", workspace)] else [])
  return obj [("type", toJson "object"), ("properties", obj props), ("additionalProperties", toJson false)]

private def sendStickerTool (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let actions := field context "actions"
  if !truthy (field actions "sendSticker") then return obj []
  let bound ← Prog.effect "actions.sendSticker?.bind" [actions]
  if !truthy bound then return obj []
  let schema ← Prog.effect "jsonSchema" [obj [("type", toJson "object"),
    ("properties", obj [("sticker", stringProp "Provider-native sticker id or name, or a public URL. Not a workspace file path.")]),
    ("required", toJson ["sticker"]), ("additionalProperties", toJson false)]]
  let result ← Prog.effect "tool" [obj [("description", toJson s!"Sends a provider-native sticker to the current {str (field context "channelName")} conversation immediately. Use a sticker identifier valid for this provider."),
    ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("send-sticker", result)]

private def sendReactionsTool (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  if field (field context "actions") "supportsReactions" != toJson true then return obj []
  let schema ← Prog.effect "jsonSchema" [obj [("type", toJson "object"),
    ("properties", obj [("emoji", stringProp "Optional channel-native emoji name or Unicode emoji. Omit it to use the channel's configured acknowledgement reaction.")]),
    ("additionalProperties", toJson false)]]
  let result ← Prog.effect "tool" [obj [("description", toJson s!"Adds a reaction to the inbound message in the current {str (field context "channelName")} conversation. The provider may accept only its own emoji names or supported Unicode emoji."),
    ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("send-reactions", result)]

private def sendUpdateTool (call : Json) : Prog Json := do
  let channel := str (field (Twin.callArg call 0) "channelName")
  let schema ← Prog.effect "jsonSchema" [obj [("type", toJson "object"),
    ("properties", obj [("message", merge (stringProp "Progress note to send now, written in the language of the conversation.") [("minLength", toJson (1 : Nat))])]),
    ("required", toJson ["message"]), ("additionalProperties", toJson false)]]
  let result ← Prog.effect "tool" [obj [("description", toJson s!"Sends a short progress note to the current {channel} conversation right now, while the turn keeps running. Use it when the work ahead will take long enough that the recipient would otherwise wait with no sign anything is happening: say what is being done and how long it is likely to take. This is not the answer, which is still delivered when the turn ends, so keep it to a sentence or two and do not repeat an update that is still true."),
    ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("send-update", result)]

private def sendFilesTool (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let actions := field context "actions"
  let workspaces := if truthy (field context "accountId") then nullish (field context "workspaces") (toJson ([] : List Json)) else toJson ([] : List Json)
  if (items workspaces).isEmpty then return obj []
  let description ← Prog.effect "sendFilesDescription" [field context "channelName", toJson (!undef (field actions "sendFiles"))]
  let raw ← Prog.effect "sendFilesSchema" [workspaces]
  let schema ← Prog.effect "jsonSchema" [raw]
  let result ← Prog.effect "tool" [obj [("description", description), ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("send-files", result)]

private def sendImagesTool (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let actions := field context "actions"
  if !truthy (field actions "sendImages") && !truthy (field actions "sendFiles") then return obj []
  let workspaces := if truthy (field context "accountId") then nullish (field context "workspaces") (toJson ([] : List Json)) else toJson ([] : List Json)
  let description ← Prog.effect "sendImagesDescription" [field context "channelName", toJson (!(items workspaces).isEmpty), toJson (!undef (field actions "sendImages"))]
  let raw ← Prog.effect "sendImagesSchema" [workspaces]
  let schema ← Prog.effect "jsonSchema" [raw]
  let result ← Prog.effect "tool" [obj [("description", description), ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("send-images", result)]

private def lifecycleScript (call : Json) : Prog Json := do
  let workDir := str (Twin.callArg call 0)
  let onCreate := (items (Twin.callArg call 1)).map str
  let onResume := (items (Twin.callArg call 2)).map str
  if onCreate.isEmpty && onResume.isEmpty then return Twin.undefinedJson
  let marker ← Prog.effect "shellQuote" [toJson (workDir ++ "/.fp-setup-done")]
  let lock ← Prog.effect "shellQuote" [toJson (workDir ++ "/.fp-setup-lock")]
  let mkdir ← Prog.effect "shellQuote" [toJson workDir]
  let cd ← Prog.effect "shellQuote" [toJson workDir]
  let marker := str marker
  let lock := str lock
  let commands := ["set -e", "mkdir -p " ++ str mkdir, "cd " ++ str cd] ++
    (if onCreate.isEmpty then [] else
      [s!"if [ ! -f {marker} ]; then", "  __waited=0", s!"  until mkdir {lock} 2>/dev/null; do",
        "    if [ \"$__waited\" -ge 600 ]; then break; fi", "    sleep 1", "    __waited=$((__waited + 1))",
        "  done", s!"  trap 'rmdir {lock} 2>/dev/null' EXIT", s!"  if [ ! -f {marker} ]; then"] ++
      onCreate ++ [s!"    touch {marker}", "  fi", s!"  rmdir {lock} 2>/dev/null || true", "  trap - EXIT", "fi"]) ++ onResume
  return toJson (String.intercalate "\n" commands)

private def e2bBackgroundCommand (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  if !truthy (field request "callback") then return field request "code"
  let id := str (Twin.callArg call 1)
  if id.isEmpty || !id.toList.all (fun c => c.isAlphanum || c == '_' || c == '-') then
    return ← Prog.throwError "Error" ("Invalid job id: " ++ id)
  let logFile := "/tmp/fp-e2b-job-" ++ id ++ ".log"
  let code ← Prog.effect "shellQuote" [toJson (Tools.toBase64 (str (field request "code")))]
  let log ← Prog.effect "shellQuote" [toJson logFile]
  let callback ← Prog.effect "callbackSnippet" [field request "callback", toJson logFile]
  let remove ← Prog.effect "shellQuote" [toJson logFile]
  return toJson (String.intercalate "\n" ["bash -lc \"$(printf %s " ++ str code ++ " | base64 -d)\" > " ++ str log ++ " 2>&1",
    "__rc=$?", str callback, "rm -f " ++ str remove, "exit \"$__rc\""])

private def occupiedReason (call : Json) : Json :=
  let holder := str (nullish (Twin.callArg call 0) (toJson "unknown host"))
  let bytes := holder.toUTF8.extract 0 40
  toJson ("Already connected from another daemon (" ++ String.fromUTF8! bytes ++ "); pass --force to take it over")

private def liftStringify (result : Tools.R String) : Prog String :=
  match result with
  | .ok text => pure text
  | .error _ => Prog.unsupported "JSON.stringify key order is not recorded"

private def formatJSONValue (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  match value with
  | .str _ => return value
  | _ => return toJson (← liftStringify (Tools.stringify value))

private def everyChild (active : Json) (children : List Json) : Prog Bool := do
  if undef active && !children.isEmpty then
    return ← Prog.unsupported "the outermost call makes its traversal set internally"
  for child in children do
    let valid ← Prog.effect "isJSONValue" [child, active]
    if !truthy valid then return false
  return true

/-- `Object.values` order: the recorded key order, or sorted when the recorder wrote none. -/
private def objectKeys (value : Json) (plain : List (String × Json)) : List String :=
  match value.getObjVal? "$keys" with
  | .ok (.arr names) => names.toList.filterMap (·.getStr?.toOption)
  | _ => plain.map (·.1)

private def isJSONValue (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let active := Twin.param call 1
  let plain := (entries value).filter (·.1 != "$keys")
  let tag := plain.head?.map (·.1)
  match value with
  | .null | .str _ | .bool _ | .num _ => return toJson true
  | .arr values =>
    if truthy (← Prog.effect "active.has" [value]) then return toJson false
    let _ ← Prog.effect "active.add" [value]
    let valid ← everyChild active values.toList
    let _ ← Prog.effect "active.delete" [value]
    return toJson valid
  | .obj _ =>
    if undef value || tag == some "$fn" || tag == some "$bigint" then return toJson false
    if tag == some "$date" then
      if truthy (← Prog.effect "active.has" [value]) then return toJson false
      let _ ← Prog.effect "active.add" [value]
      let _ ← Prog.effect "active.delete" [value]
      return toJson false
    if tag.any (·.startsWith "$") then return ← Prog.unsupported "recorder tag"
    if plain.isEmpty then return ← Prog.unsupported "undefined-valued keys are not recorded"
    if truthy (← Prog.effect "active.has" [value]) then return toJson false
    let _ ← Prog.effect "active.add" [value]
    let children := (objectKeys value plain).map fun key =>
      let child := field value key
      if child == Json.mkObj [("$ref", toJson (1 : Nat))] then value else child
    let valid ← everyChild active children
    let _ ← Prog.effect "active.delete" [value]
    return toJson valid

/-- Key order of the bodies the platform worker executors build. -/
private def workerBodyOrder : List String :=
  ["script", "argv", "args", "cwd", "env", "timeoutMs", "outputLimitBytes", "idleTimeoutSeconds",
    "enableInternet", "persist", "instance"]

private def callPlatformWorker (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let path := str (Twin.callArg call 2)
  let method := str (Twin.callArg call 3)
  let body := Twin.callArg call 4
  let timeout := Twin.callArg call 5
  let signal ← Prog.effect "AbortSignal.timeout"
    [if undef timeout then toJson (30000 : Nat) else timeout]
  if !undef (field body "$big") then return ← Prog.unsupported "body too big to record"
  let bodyText ← if undef body then pure Twin.undefinedJson else
    pure (toJson (Twin.jsonStringify 64 body))
  let response ← Prog.effect "fetch" [toJson (str (field connection "baseURL") ++ path),
    obj [("method", toJson method),
      ("headers", obj [("Authorization", toJson ("Bearer " ++ str (field connection "apiKey"))),
        ("Content-Type", toJson "application/json")]),
      ("body", bodyText), ("signal", signal), ("redirect", toJson "error")]]
  let status := field (field response "$response") "status"
  let code := status.getInt?.toOption.getD 0
  if 200 <= code && code <= 299 then return response
  let text ← Prog.effect "response.text"
  let error ← Prog.effect "new PlatformWorkerError"
    [Twin.callArg call 1, toJson (method ++ " " ++ path), status, text]
  Prog.fail error

private def sendMessageTool (_call : Json) : Prog Json := do
  let schema ← Prog.effect "jsonSchema" [obj [("type", toJson "object"), ("properties", obj
    [("conversationKey", merge (stringProp "Key of the target channel conversation: channel prefix plus platform ids, e.g. tg:<chatId> (negative for groups), slack:<teamId>:<channelId>[:<threadTs>].") [("minLength", toJson (1 : Nat))]),
     ("message", merge (stringProp "Message to deliver to the target session.") [("minLength", toJson (1 : Nat))])]),
    ("required", toJson ["conversationKey", "message"]), ("additionalProperties", toJson false)]]
  let result ← Prog.effect "tool" [obj [("description", toJson "Sends a message to another channel conversation of this agent, a chat that has messaged it before. The agent processes it there as a follow-up and replies in that chat. Subagent conversations are not reachable here."),
    ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("send-message", result)]

private def standInShape (names : List String) : Json :=
  obj [("replaces", toJson names), ("runsAs", toJson names),
    ("toSandboxCall", fn "toSandboxCall"), ("execute", fn "execute")]

private def editScript (call : Json) : Json :=
  let b64 := fun i => str (Twin.callArg call i)
  toJson (String.intercalate "\n" [
    "node <<'NODEEOF'",
    "const fs = require('node:fs');",
    "const path = Buffer.from(\"" ++ b64 0 ++ "\", \"base64\").toString(\"utf8\");",
    "const oldString = Buffer.from(\"" ++ b64 1 ++ "\", \"base64\").toString(\"utf8\");",
    "const newString = Buffer.from(\"" ++ b64 2 ++ "\", \"base64\").toString(\"utf8\");",
    "const replaceAll = " ++ (if truthy (Twin.callArg call 3) then "true" else "false") ++ ";",
    "function fail(message) { process.stderr.write(message + '\\n'); process.exit(1); }",
    "if (oldString.length === 0) fail('Error: old_string must not be empty');",
    "if (oldString === newString) fail('Error: old_string and new_string are identical');",
    "let data;",
    "try {",
    "  data = fs.readFileSync(path, 'utf8');",
    "} catch (error) {",
    "  if (error && error.code === 'ENOENT') fail(`Error: file not found: ${path}`);",
    "  throw error;",
    "}",
    "const count = data.split(oldString).length - 1;",
    "if (count === 0) fail(`Error: old_string not found in ${path}`);",
    "if (!replaceAll && count > 1) fail(`Error: old_string is not unique (${count} matches); add context or set replace_all`);",
    "const updated = replaceAll ? data.split(oldString).join(newString) : data.replace(oldString, newString);",
    "const fd = fs.openSync(path, 'w');",
    "try { fs.writeSync(fd, updated, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }",
    "const replacements = replaceAll ? count : 1;",
    "process.stdout.write(`Edited ${path} (${replacements} replacement${replacements === 1 ? '' : 's'})\\n`);",
    "NODEEOF"])

private def bootIdFile : String := "/proc/sys/kernel/random/boot_id"

private def quoteVia (label path : String) : Prog String := do
  return str (← Prog.effect label [toJson path])

private def statusScript (call : Json) : Prog Json := do
  let dir := str (Twin.callArg call 0)
  let id := str (Twin.callArg call 1)
  let _ ← Prog.effect "assertSafeJobId" [toJson id]
  let f := fun ext => quoteVia "shellQuote" (dir ++ "/" ++ id ++ "." ++ ext)
  let exit1 ← f "exit"
  let exit2 ← f "exit"
  let running1 ← f "running"
  let running2 ← f "running"
  let boot ← quoteVia "shellQuote" bootIdFile
  let pid1 ← f "pid"
  let pid2 ← f "pid"
  let pid3 ← f "pid"
  return toJson (String.intercalate "\n" [
    "if [ -f " ++ exit1 ++ " ]; then echo \"done $(cat " ++ exit2 ++ ")\";",
    "elif [ -f " ++ running1 ++ " ]; then",
    "  stored=$(cat " ++ running2 ++ " 2>/dev/null);",
    "  current=$(cat " ++ boot ++ " 2>/dev/null);",
    "  if [ -n \"$current\" ] && [ -n \"$stored\" ] && [ \"$stored\" != \"$current\" ]; then echo \"done 137\";",
    "  elif [ -f " ++ pid1 ++ " ] && kill -0 \"$(cat " ++ pid2 ++ ")\" 2>/dev/null; then echo running;",
    "  elif [ -f " ++ pid3 ++ " ]; then echo \"done 137\";",
    "  else echo running; fi;",
    "else echo unknown; fi"])

private def callbackSnippet (call : Json) : Prog Json := do
  let url ← quoteVia "shellQuote" (str (field (Twin.callArg call 0) "url"))
  let log ← quoteVia "shellQuote" (str (Twin.callArg call 1))
  let py := String.intercalate "\n" [
    "import json,os,urllib.request",
    "code=os.environ.get(\"__CB_CODE\",\"\")",
    "try:",
    "    with open(os.environ[\"__CB_LOG\"],\"rb\") as fh: logs=fh.read()[-32768:].decode(\"utf-8\",\"replace\")",
    "except Exception: logs=\"\"",
    "try: ec=int(code)",
    "except Exception: ec=None",
    "ok = code==\"0\"",
    "body={\"status\":\"completed\" if ok else \"failed\",\"response\":{\"exitCode\":ec,\"logs\":logs}}",
    "if not ok: body[\"error\"]=\"Background job exited with code %s\\n%s\"%(code,logs)",
    "req=urllib.request.Request(os.environ[\"__CB_URL\"],data=json.dumps(body).encode(\"utf-8\"),method=\"POST\",headers={\"Content-Type\":\"application/json\",\"x-job-token\":os.environ[\"__CB_TOKEN\"]})",
    "try: urllib.request.urlopen(req,timeout=15)",
    "except Exception: pass"]
  return toJson ("__CB_URL=" ++ url ++ " __CB_LOG=" ++ log ++ " __CB_CODE=\"$__rc\" python3 - <<'__FPCB__' >/dev/null 2>&1 || true\n" ++ py ++ "\n__FPCB__")

private def launchScript (call : Json) : Prog Json := do
  let dir := str (Twin.callArg call 0)
  let id := str (Twin.callArg call 1)
  let options := Twin.callArg call 4
  let _ ← Prog.effect "assertSafeJobId" [toJson id]
  let f := fun ext => quoteVia "q" (dir ++ "/" ++ id ++ "." ++ ext)
  let pid ← f "pid"
  let work ← quoteVia "q" (str (Twin.callArg call 2))
  let log ← f "log"
  let exit ← f "exit"
  let callback ← if truthy (field options "callback") then do
      let snippet ← Prog.effect "callbackSnippet" [field options "callback", toJson (dir ++ "/" ++ id ++ ".log")]
      pure [str snippet]
    else pure []
  let running ← f "running"
  let wrapper := String.intercalate "\n" (["echo $$ > " ++ pid, "cd " ++ work,
    "{\n" ++ str (Twin.callArg call 3) ++ "\n} > " ++ log ++ " 2>&1", "__rc=$?",
    "echo $__rc > " ++ exit] ++ callback ++ ["rm -f " ++ running])
  let max := (field options "maxConcurrentJobs").compress
  let mkdir ← quoteVia "q" dir
  let ls ← quoteVia "q" dir
  let boot ← quoteVia "q" bootIdFile
  let running1 ← f "running"
  let running2 ← f "running"
  let encoded ← quoteVia "q" (Tools.toBase64 wrapper)
  return toJson (String.intercalate "\n" ["mkdir -p " ++ mkdir,
    "__running=$(ls " ++ ls ++ "/*.running 2>/dev/null | wc -l)",
    "if [ \"$__running\" -ge " ++ max ++ " ]; then echo \"background job limit reached (" ++ max ++ " concurrent)\" >&2; exit 1; fi",
    "cat " ++ boot ++ " > " ++ running1 ++ " 2>/dev/null || : > " ++ running2,
    "setsid bash -c \"$(printf %s " ++ encoded ++ " | base64 -d)\" < /dev/null > /dev/null 2>&1 &"])

private def freshMountScript (call : Json) : Prog Json := do
  let mount := str (Twin.callArg call 0)
  let stamp ← quoteVia "shellQuote" (mount ++ ".mounted-at")
  let quoted ← quoteVia "shellQuote" mount
  return toJson (String.intercalate "\n" ["stamp_file=" ++ stamp ++ ";",
    "stamp=$(cat \"$stamp_file\" 2>/dev/null || echo 0);",
    "case \"$stamp\" in '' | *[!0-9]* | 0?* | ???????????*) stamp=0 ;; esac;",
    "age=$((" ++ (Twin.callArg call 1).compress ++ " - stamp));",
    "mountpoint -q " ++ quoted ++ " && [ \"$age\" -ge 0 ] && [ \"$age\" -lt 2700 ]"])

private def readS3Body (call : Json) : Prog Json := do
  let key := Twin.callArg call 1
  let maxBytes := Twin.callArg call 3
  let client ← Prog.effect "awsClient" [Twin.callArg call 2]
  let _ := client
  let command ← Prog.effect "new GetObjectCommand"
    [obj [("Bucket", Twin.callArg call 0), ("Key", key), ("Range", Twin.callArg call 4)]]
  let result ← Prog.effect "awsClient(access).send" [command]
  let body := field result "Body"
  if !truthy body then return ← Prog.throwError "Error" ("S3 object has no body: " ++ str key)
  let length := field result "ContentLength"
  let limit := (maxBytes.getInt?.toOption.getD 0)
  if !undef maxBytes && (undef length || length.getInt?.toOption.getD 0 > limit) then
    let _ ← Prog.effect "result.Body.transformToWebStream"
    let _ ← Prog.effect "result.Body.transformToWebStream().cancel"
    return ← Prog.throwError "Error" ("S3 object " ++ str key ++ " is " ++
      (if undef length then "an unknown number of" else length.compress) ++ " bytes, over the " ++ maxBytes.compress ++ " byte limit")
  return body

private def retryableDeleteCodes : List String := ["InternalError", "ServiceUnavailable", "SlowDown"]

private def deleteKeys (bucket keyPrefix : Json) (pageSize : Nat) : Nat → Nat → List Json → Prog Unit
  | 0, _, _ => Prog.unsupported "more delete attempts than the code allows"
  | fuel + 1, attempt, keys =>
    if keys.isEmpty then pure () else do
    if attempt > 1 then let _ ← Prog.effect "Bun.sleep" [toJson (100 * 2 ^ attempt)]
    let command ← Prog.effect "new DeleteObjectsCommand" [obj [("Bucket", bucket),
      ("Delete", obj [("Objects", toJson (keys.map fun key => obj [("Key", key)])), ("Quiet", toJson true)])]]
    let result ← Prog.effect "client.send" [command]
    let errors := items (field result "Errors")
    if let some first := errors.head? then
      let permanent := errors.any fun e =>
        !truthy (field e "Key") || !retryableDeleteCodes.contains (str (field e "Code"))
      if attempt == 3 || permanent then
        let detail := if undef (field first "Message") || field first "Message" == .null then "" else str (field first "Message")
        let text := s!"S3 could not delete {errors.length} of {pageSize} objects under {str keyPrefix} in {str bucket}, first {jsString (field first "Key")}: {jsString (field first "Code")} {detail}"
        Prog.throwError "Error" text.trimAscii.toString
    deleteKeys bucket keyPrefix pageSize fuel (attempt + 1)
      (errors.filterMap fun e => if truthy (field e "Key") then some (field e "Key") else none)

private def deletePages (bucket keyPrefix : Json) : Nat → Json → Nat → Prog Json
  | 0, _, _ => Prog.unsupported "more pages than the model allows"
  | fuel + 1, token, deleted => do
    let command ← Prog.effect "new ListObjectsV2Command" [obj [("Bucket", bucket), ("Prefix", keyPrefix),
      ("ContinuationToken", token), ("MaxKeys", toJson (1000 : Nat))]]
    let page ← Prog.effect "client.send" [command]
    let keys := (items (field page "Contents")).filterMap fun item =>
      if truthy (field item "Key") then some (field item "Key") else none
    deleteKeys bucket keyPrefix keys.length 4 1 keys
    let total := deleted + keys.length
    let next := field page "NextContinuationToken"
    if truthy next then deletePages bucket keyPrefix fuel next total else return toJson total

private def deleteS3Prefix (call : Json) : Prog Json := do
  let _ ← Prog.effect "awsClient" [Twin.callArg call 2]
  deletePages (Twin.callArg call 0) (Twin.callArg call 1) 1024 Twin.undefinedJson 0

private def startedInConversation (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let parentId ← Prog.effect "subagentParentEventId" [Twin.callArg call 1]
  if parentId == .null then return toJson false
  if parentId == field context "eventId" then return toJson true
  let scope ← Prog.effect "parseAccountAgentScopedKey" [parentId]
  if !truthy scope || field scope "accountId" != field context "accountId" then return toJson false
  let parent ← Prog.effect "getIngressStatusByEventId"
    [obj [("accountId", field scope "accountId"), ("agentId", field scope "agentId"), ("eventId", parentId)]]
  return toJson (field parent "conversationKey" == field context "conversationKey")

private def workspaceSandboxLimits (call : Json) : Prog Json := do
  let provider := Twin.callArg call 0
  let timeout ← if provider == toJson "worker" then pure (toJson (60 : Nat)) else
    if undef provider || provider == toJson "lambda" then
      Prog.effect "positiveIntegerEnv" [toJson "WORKSPACE_SANDBOX_LAMBDA_MAX_TIMEOUT_SECONDS", toJson (600 : Nat)]
    else Prog.effect "positiveIntegerEnv" [toJson "WORKSPACE_SANDBOX_MAX_TIMEOUT_SECONDS", toJson (600 : Nat)]
  let output ← Prog.effect "positiveIntegerEnv" [toJson "WORKSPACE_SANDBOX_MAX_OUTPUT_LIMIT_BYTES", toJson (262144 : Nat)]
  return obj [("maxTimeoutSeconds", timeout), ("maxOutputLimitBytes", output)]

private def sandboxConfigs (call : Json) : Prog Json := do
  let storage ← Prog.effect "getStorage"
  let _ := storage
  Prog.catchFail (Prog.effect "getStorage() .sandboxConfigs.list" [Twin.callArg call 0])
    (fun error => do
      let _ ← Prog.effect "toErrorMessage" [error]
      pure (toJson ([] : List Json)))

private def getS3ObjectUrl (call : Json) : Prog Json := do
  let options := Twin.callArg call 2
  let client ← Prog.effect "awsClient" [field options "access"]
  let command ← Prog.effect "new GetObjectCommand" [obj [("Bucket", Twin.callArg call 0), ("Key", Twin.callArg call 1)]]
  Prog.effect "getSignedUrl" [client, command,
    obj [("expiresIn", nullish (field options "expiresInSeconds") (toJson (300 : Nat)))]]

private def readS3TextHead (call : Json) : Prog Json := do
  let maxBytes := (Twin.callArg call 2).getInt?.toOption.getD 0
  let body ← Prog.effect "readS3Body" [Twin.callArg call 0, Twin.callArg call 1, Twin.undefinedJson,
    Twin.callArg call 2, toJson ("bytes=0-" ++ toString (maxBytes - 1))]
  let _ := body
  Prog.effect "body.transformToString"

private def readS3Bytes (call : Json) : Prog Json := do
  let _ ← Prog.effect "readS3Body" [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2, Twin.callArg call 3]
  Prog.effect "body.transformToByteArray"

private def vercelSandboxName (call : Json) : Prog Json := do
  let pre ← Prog.effect "sandboxNamePrefix" [Twin.callArg call 0]
  let id ← Prog.effect "randomUUID"
  return toJson (str pre ++ "-" ++ String.ofList ((str id).toList.take 8))

private def mountRoleArn (call : Json) : Prog Json := do
  let storage := Twin.callArg call 0
  if !truthy (field storage "bucket") then return ← Prog.effect "optionalEnv" [toJson "SANDBOX_MOUNT_ROLE_ARN"]
  let auth ← Prog.effect "workspaceStorageOwnAuth" [storage]
  return if field auth "type" == toJson "assumeRole" then field auth "roleArn" else Twin.undefinedJson

private def mountExternalId (call : Json) : Prog Json := do
  let storage := Twin.callArg call 0
  if !truthy storage then return Twin.undefinedJson
  let auth ← Prog.effect "workspaceStorageOwnAuth" [storage]
  if field auth "type" != toJson "assumeRole" then return Twin.undefinedJson
  let owner := field storage "owner"
  if !truthy owner then return ← Prog.throwError "Error" "assumeRole workspace storage has no owner"
  let _ ← Prog.effect "getStorage"
  Prog.effect "getStorage().workspaceConfigs.storageExternalId" [field owner "accountId"]

private def virtualSubagentConfig (call : Json) : Prog Json := do
  let parent := Twin.callArg call 0
  let applied ← Prog.effect "applyRunOverrides"
    [parent, obj [("model", field (field parent "subagent") "model")]]
  Prog.effect "subagentConfig" [applied, parent]

private def optionalKey (key : String) (value : Json) : List (String × Json) :=
  if truthy value then [(key, value)] else []

private def urlFilePart (part : Json) : Option Json :=
  let url := str (field part "url")
  match url.splitOn "://" with
  | [scheme, rest] =>
    let plain := scheme.toList.all Char.isAlpha && (rest.splitOn "/").length >= 2 &&
      url == url.toLower && !(rest.toList.contains ' ')
    if plain then
      some (obj ([("type", toJson "file"),
        ("data", obj [("type", toJson "url"), ("url", obj [("$url", toJson url)])]),
        ("mediaType", if field part "type" == toJson "image-url" then toJson "image"
          else nullish (field part "mediaType") (toJson "application/octet-stream"))] ++
        optionalKey "providerOptions" (field part "providerOptions")))
    else none
  | _ => none

private def urlToolContentPartToUserPart (call : Json) : Prog Json :=
  match urlFilePart (Twin.callArg call 0) with
  | some part => pure part
  | none =>
    let part := Twin.callArg call 0
    match Url.parse (str (field part "url")) with
    | .invalid =>
      Prog.effect "textPart" [toJson (Twin.jsonStringify 64 part), field part "providerOptions"]
    | _ => Prog.unsupported "URL parsing and normalisation outside plain absolute URLs"

private def referenceFile (part reference : Json) (mediaType : String) : Json :=
  obj ([("type", toJson "file"),
    ("data", obj [("type", toJson "reference"), ("reference", reference)]),
    ("mediaType", toJson mediaType)] ++ optionalKey "providerOptions" (field part "providerOptions"))

/-- Parts whose conversion calls no top-level helper; `none` for the kinds that do. -/
private def directContentPart (part : Json) : Option Json :=
  let kind := str (field part "type")
  let options := optionalKey "providerOptions" (field part "providerOptions")
  match kind with
  | "file" => some (obj ([("type", toJson "file"), ("data", field part "data"),
      ("mediaType", field part "mediaType")] ++ optionalKey "filename" (field part "filename") ++ options))
  | "file-data" | "image-data" => some (obj ([("type", toJson "file"),
      ("data", obj [("type", toJson "data"), ("data", field part "data")]),
      ("mediaType", field part "mediaType")] ++
      (if kind == "file-data" then optionalKey "filename" (field part "filename") else []) ++ options))
  | "file-reference" => some (referenceFile part (field part "providerReference") "application/octet-stream")
  | "image-file-reference" => some (referenceFile part (field part "providerReference") "image")
  | "file-id" | "image-file-id" =>
    if (field part "fileId").getStr?.isOk then none else
    some (referenceFile part (field part "fileId") (if kind == "image-file-id" then "image" else "application/octet-stream"))
  | _ => none

private def toolContentPartToUserPart (call : Json) : Prog Json := do
  let part := Twin.callArg call 0
  let kind := str (field part "type")
  if kind == "text" then
    return ← Prog.effect "textPart" [field part "text", field part "providerOptions"]
  if kind == "file-url" || kind == "image-url" then
    return ← Prog.effect "urlToolContentPartToUserPart" [part]
  match directContentPart part with
  | some result => return result
  | none =>
    let text ← liftStringify (Tools.stringify part)
    Prog.effect "textPart" [toJson text, field part "providerOptions"]

/-- `.map(toolContentPartToUserPart)` hands the function over by reference, so its calls are not
effects of the caller and the conversion is computed here. -/
private def mappedContentPart (part : Json) : Prog Json := do
  let kind := str (field part "type")
  if kind == "text" then
    return obj ([("type", toJson "text"), ("text", field part "text")] ++
      optionalKey "providerOptions" (field part "providerOptions"))
  if kind == "file-url" || kind == "image-url" then
    match urlFilePart part with
    | some result => return result
    | none => return ← Prog.unsupported "URL parsing outside plain absolute URLs"
  match directContentPart part with
  | some result => return result
  | none => Prog.unsupported "JSON.stringify of a content part"

private def modelValueToUserParts (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let output ← Prog.effect "parseToolResultOutput" [value]
  let single := fun (text options : Json) => do
    return toJson [← Prog.effect "textPart" [text, options]]
  if !truthy output then
    let text ← Prog.effect "formatJSONValue" [value]
    return toJson [← Prog.effect "textPart" [text]]
  let options := field output "providerOptions"
  match str (field output "type") with
  | "text" | "error-text" => single (field output "value") options
  | "json" | "error-json" =>
    let text ← Prog.effect "formatJSONValue" [field output "value"]
    single text options
  | "execution-denied" =>
    let reason := field output "reason"
    single (toJson (if truthy reason then "Execution denied: " ++ jsString reason else "Execution denied")) options
  | "content" =>
    let parts ← (items (field output "value")).mapM mappedContentPart
    return toJson parts
  | other => Prog.unsupported s!"output type {other}"

private def normalizeToolResultOutput (call : Json) : Prog Json := do
  let output := Twin.callArg call 0
  let parsed ← Prog.effect "parseToolResultOutput" [output]
  if truthy parsed then return parsed
  let typed ← Prog.effect "toolResultOutputTypeSchema.safeParse" [output]
  if truthy (field typed "success") then
    return ← Prog.throwError "TypeError" ("Invalid ToolResultOutput for type \"" ++ str (field (field typed "data") "type") ++ "\"")
  if output.getStr?.isOk then return obj [("type", toJson "text"), ("value", output)]
  if truthy (← Prog.effect "isJSONValue" [output]) then
    return obj [("type", toJson "json"), ("value", output)]
  Prog.throwError "TypeError" "Tool output must be a string, a JSON-compatible value, or a valid ToolResultOutput"

private def getOwnedSubagent (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let input := Twin.callArg call 1
  if !truthy (← Prog.effect "startedInConversation" [context, field input "taskId"]) then return .null
  let eventId ← Prog.effect "scopedDirectEventId" [field context "accountId", field input "agentId", field input "taskId"]
  let record ← Prog.effect "getAsyncAgentResult" [eventId]
  if !truthy record then return .null
  let scope ← Prog.effect "parseAccountAgentScopedKey" [field record "conversationKey"]
  if !truthy scope || field record "eventId" != eventId || field record "accountId" != field context "accountId" ||
    field scope "accountId" != field context "accountId" || field scope "agentId" != field input "agentId" then
    return .null
  return record

private def standInWithRun (call : Json) (names : List String) : Prog Json := do
  let _ ← Prog.effect "runCall" [Twin.callArg call 0, fn "toSandboxCall"]
  return standInShape names

private def customTool (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let command ← Prog.effect "configString" [field context "command"]
  if !truthy command then
    return ← Prog.throwError "Error" ("config.tools." ++ str (field context "toolName") ++
      " is an OpenAI custom tool, so it needs `command`: the sandbox command that reads the model's text on stdin")
  let execute ← Prog.effect "runCall" [context, fn "toSandboxCall"]
  return obj [("replaces", toJson ([] : List String)), ("runsAs", toJson ["bash"]),
    ("toSandboxCall", fn "toSandboxCall"), ("execute", execute)]

private def sandboxStandIn (call : Json) : Prog Json := do
  let id := str (Twin.callArg call 0)
  let context := Twin.callArg call 1
  let tool := str (field context "toolName")
  let standIn ← Prog.effect "standInFor" [Twin.callArg call 0, context]
  if !truthy standIn then
    return ← Prog.throwError "Error" s!"config.tools.{tool} ({id}) runs in the caller's code, and Broods has no sandbox tool for it. Supported: Anthropic bash and text editor, OpenAI shell, local shell, apply patch and custom tools. Connect an MCP server for anything else."
  for name in (items (field standIn "runsAs")).map str do
    if !truthy (field (field context "sandboxTools") name) then
      return ← Prog.throwError "Error" (s!"config.tools.{tool} ({id}) runs as {name}, which needs " ++
        if name == "bash" then "a sandbox in config.sandboxes" else "a writable workspace in config.workspaces")
    if truthy (← Prog.effect "offersTargetChoice" [toJson name, field context "fileContext"]) then
      return ← Prog.throwError "Error" s!"config.tools.{tool} ({id}) has no input to pick a workspace or sandbox, and this agent has more than one for {name}. Keep one, or use the Broods tools."
  return standIn

private def e2bApiKey (config : Json) : Prog Json := do
  let configured ← Prog.effect "configString" [field (field config "options") "apiKey"]
  if undef configured || configured == .null then Prog.effect "optionalEnv" [toJson "E2B_API_KEY"] else pure configured

private def e2bIdleMs (config : Json) : Prog Json := do
  let lifecycle ← Prog.effect "resolveSandboxLifecycle" [field config "lifecycle"]
  return toJson ((field lifecycle "idleTimeoutSeconds").getInt?.toOption.getD 0 * 1000)

private def e2bApiOptions (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let key ← e2bApiKey config
  let ms ← e2bIdleMs config
  return obj (optionalKey "apiKey" key ++ [("timeoutMs", ms)])

private def e2bCreateOptions (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let key ← e2bApiKey config
  let persistent ← if truthy (Twin.callArg call 1) then do
      let ms ← e2bIdleMs config
      pure [("timeoutMs", ms), ("lifecycle", obj [("onTimeout", toJson "pause")])]
    else pure []
  return obj (optionalKey "apiKey" key ++ optionalKey "template" (field config "snapshot") ++ persistent)

private def vercelMountScript (call : Json) : Prog Json := do
  let mount := Twin.callArg call 0
  let path := str (Twin.callArg call 1)
  let now := Twin.callArg call 2
  let quoted := str (← Prog.effect "shellQuote" [toJson path])
  let option := fun (flag : String) (value : Json) => if truthy value then [flag, str value] else []
  let args := ["--allow-delete", "--allow-overwrite", "--allow-other"] ++
    option "--prefix" (field mount "prefix") ++ option "--region" (field mount "region") ++
    option "--endpoint-url" (field mount "endpoint") ++ [str (field mount "bucket"), path]
  let mountArgs := String.intercalate " " (args.map Tools.shellQuote)
  let fresh := str (← Prog.effect "freshMountScript" [toJson path, now])
  return toJson (String.intercalate "\n" ["set -e", "exec 9>/tmp/.fp-s3-mount.lock", "flock 9",
    "if ! command -v mount-s3 >/dev/null; then",
    "  arch=\"$(dpkg --print-architecture | sed s/amd64/x86_64/)\"",
    "  curl -fsSL -o /tmp/mount-s3.deb \"https://s3.amazonaws.com/mountpoint-s3-release/latest/${arch}/mount-s3.deb\" || { echo \"mount-s3 is not installed and could not be fetched; boot a snapshot that has it, or allow egress to s3.amazonaws.com and the Ubuntu mirrors\" >&2; exit 1; }",
    "  sudo apt-get update -qq",
    "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/mount-s3.deb",
    "  rm -f /tmp/mount-s3.deb", "fi",
    "if ! { " ++ fresh ++ "; }; then",
    "  sudo umount -l " ++ quoted ++ " 2>/dev/null || true",
    "  sudo mkdir -p " ++ quoted,
    "  sudo chown \"$(id -u)\":\"$(id -g)\" " ++ quoted,
    "  sudo -E mount-s3 --uid \"$(id -u)\" --gid \"$(id -g)\" " ++ mountArgs,
    "  echo " ++ now.compress ++ " | sudo tee \"$stamp_file\" >/dev/null", "fi"])

private def vercelNetworkPolicy (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let request := Twin.callArg call 1
  let network := nullish (field config "network") (obj [("mode", toJson "deny-all")])
  let mode := field network "mode"
  if mode == toJson "allow-all" then return toJson "allow-all"
  let hosts ← if truthy (← Prog.effect "mountsWorkspace" [request]) then do
      let context ← Prog.effect "executorS3Context" [config, request]
      let identity ← Prog.effect "resolveS3MountIdentity" [context]
      pure (items (← Prog.effect "s3Hosts" [identity]))
    else pure []
  if mode == toJson "deny-all" && hosts.isEmpty then return toJson "deny-all"
  let allow := items (field network "allowDomains") ++ hosts
  let cidrs := field network "allowCidrs"
  return obj ((if allow.isEmpty then [] else [("allow", toJson allow)]) ++
    if (items cidrs).isEmpty then [] else [("subnets", obj [("allow", cidrs)])])

private def typedProp (kind description : String) : Json :=
  obj [("type", toJson kind), ("description", toJson description)]

private def editInputSchema (call : Json) : Prog Json := do
  let workspace ← Prog.effect "workspaceParamSchema" [field (Twin.callArg call 0) "workspaces"]
  return obj [("type", toJson "object"), ("properties", obj
    ([("file_path", stringProp "Path to edit, relative to the workspace root."),
      ("old_string", stringProp "The exact text to replace."),
      ("new_string", stringProp "The replacement text (must differ from old_string)."),
      ("replace_all", typedProp "boolean" "Replace every occurrence instead of requiring a unique match.")] ++
      optionalKey "workspace" workspace)),
    ("required", toJson ["file_path", "old_string", "new_string"]), ("additionalProperties", toJson false)]

private def standInFor (call : Json) : Prog Json := do
  let id := str (Twin.callArg call 0)
  let context := Twin.callArg call 1
  if id == "anthropic.bash_20241022" || id == "anthropic.bash_20250124" then
    return ← Prog.effect "anthropicBash" [context]
  if id.startsWith "anthropic.text_editor_" then return ← Prog.effect "textEditor" [context]
  if id == "openai.apply_patch" then return ← Prog.effect "applyPatch" [context]
  if id == "openai.custom" then return ← Prog.effect "customTool" [context]
  if id == "openai.local_shell" then return ← Prog.effect "localShell" [context]
  if id == "openai.shell" then return ← Prog.effect "openaiShell" [context]
  return Twin.undefinedJson

private def readInputSchema (call : Json) : Prog Json := do
  let workspace ← Prog.effect "workspaceParamSchema" [field (Twin.callArg call 0) "workspaces"]
  return obj [("type", toJson "object"), ("properties", obj
    ([("file_path", stringProp "Path to the file, relative to the workspace root."),
      ("offset", typedProp "integer" "1-based line number to start reading from."),
      ("limit", typedProp "integer" "Maximum number of lines to read (default 2000).")] ++
      optionalKey "workspace" workspace)),
    ("required", toJson ["file_path"]), ("additionalProperties", toJson false)]

private def writeInputSchema (call : Json) : Prog Json := do
  let workspace ← Prog.effect "workspaceParamSchema" [field (Twin.callArg call 0) "workspaces"]
  return obj [("type", toJson "object"), ("properties", obj
    ([("file_path", stringProp "Path to write, relative to the workspace root."),
      ("content", stringProp "Full file contents to write.")] ++ optionalKey "workspace" workspace)),
    ("required", toJson ["file_path", "content"]), ("additionalProperties", toJson false)]

private def spokenContents (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let ws := Twin.callArg call 1
  let rel := Twin.callArg call 2
  let mediaType ← Prog.effect "contentTypeForPath" [rel]
  if !truthy config || !(str mediaType).startsWith "audio/" then return .null
  let native ← Prog.effect "acceptsNativeMedia" [field (field config "model") "provider", mediaType]
  if truthy native then return .null
  let bytes ← Prog.catchFail (Prog.effect "workspaceMediaBytes" [ws, rel]) (fun _ => pure Twin.undefinedJson)
  if !truthy bytes then return .null
  let transcript ← Prog.effect "transcribeAudio" [config, bytes, toJson (2 : Nat)]
  if field transcript "status" != toJson "transcribed" then
    let advice ← Prog.effect "transcriptAdvice" [field transcript "recovery", rel]
    return ← Prog.effect "toolError" [toJson ("Error: " ++ str rel ++ " could not be transcribed: " ++
      jsString (field transcript "reason") ++ ". " ++ str advice)]
  let text := field transcript "text"
  Prog.effect "toolText" [toJson (if truthy text then "Transcript of " ++ str rel ++ ":\n\n" ++ str text
    else str rel ++ " contains no speech.")]

private def deliverFiles (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let files := Twin.callArg call 1
  let caption := Twin.callArg call 2
  let actions := field context "actions"
  let channel := str (field context "channelName")
  let count := (items files).length
  let links : Prog Json := do
    let lines := String.intercalate "\n" ((items files).map fun file =>
      str (field file "name") ++ ": " ++ str (field file "url"))
    let _ ← Prog.effect "actions.sendText"
      [toJson (if truthy caption then str caption ++ "\n" ++ lines else lines)]
    Prog.effect "toolText" [toJson s!"{channel} could not attach documents, so {count} download link(s) were sent as text instead. Do not send them again."]
  if !truthy (field actions "sendFiles") then return ← links
  Prog.catchFail (do
    let _ ← Prog.effect "actions.sendFiles"
      [files, if truthy caption then caption else Twin.undefinedJson]
    Prog.effect "toolText" [toJson s!"{count} file(s) sent to the current {channel} conversation."])
    (fun _ => links)

private def workspaceAttachment (call : Json) : Prog Json := do
  let ws := Twin.callArg call 1
  let rel ← Prog.effect "toWorkspaceRelative" [Twin.callArg call 2]
  let url ← Prog.effect "workspaceMediaUrl" [ws, rel, Twin.callArg call 3]
  let last := ((str rel).splitOn "/").getLast!
  let mime ← Prog.effect "contentTypeForPath" [rel]
  return obj [("type", Twin.callArg call 0), ("url", url),
    ("name", toJson (if last.isEmpty then str rel else last)), ("mimeType", mime), ("fetchData", fn "fetchData")]

private def reservePlatformSandbox (call : Json) : Prog Json := do
  let provider := Twin.callArg call 0
  let account := Twin.callArg call 1
  let key := Twin.callArg call 2
  let existing ← Prog.effect "getSandboxExternalId" [provider, key]
  if truthy existing then
    let _ ← Prog.effect "saveSandboxInstance" [provider, key, existing, account]
    return existing
  if !truthy account then return Twin.undefinedJson
  let pre ← Prog.effect "sandboxNamePrefix" [key]
  let uuid ← Prog.effect "crypto.randomUUID"
  let id := toJson (str pre ++ "-" ++ String.ofList ((str uuid).toList.take 8))
  if truthy (← Prog.effect "claimSandboxInstance" [provider, key, id, account]) then return id
  let winner ← Prog.effect "getSandboxExternalId" [provider, key]
  if !truthy winner then
    return ← Prog.throwError "Error" s!"failed to reserve a {str provider} sandbox (lost the reservation race)"
  return winner

private def releasePlatformSandbox (call : Json) : Prog Json := do
  let provider := Twin.callArg call 0
  let request := Twin.callArg call 2
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return Twin.undefinedJson
  let expected := field request "expectedExternalId"
  let id ← if undef expected || expected == .null then Prog.effect "getSandboxExternalId" [provider, key] else pure expected
  if !truthy id then return Twin.undefinedJson
  let _ ← Prog.effect "drop" [id]
  Prog.drain (fun label _ =>
    if label == "arg1" then pure () else Prog.unsupported "unexpected mirror callback") 4
  let _ ← Prog.effect "queueMirrorWrite" [id, fn ""]
  let _ ← Prog.effect "deleteSandboxInstance" [provider, key, Twin.callArg call 1, id]
  return Twin.undefinedJson

private def resolveS3Mount (call : Json) : Prog Json := do
  let ctx := Twin.callArg call 0
  let storage := field ctx "storage"
  let identity ← Prog.effect "resolveS3MountIdentity" [ctx]
  if field (field storage "auth") "type" == toJson "r2" then
    let owner := field storage "owner"
    if !truthy owner then return ← Prog.throwError "Error" "R2 workspace storage has no owner"
    let _ ← Prog.effect "getStorage"
    let minted ← Prog.effect "getStorage().workspaceConfigs.mintR2Credentials"
      [field owner "accountId", field owner "workspaceId", field identity "prefix"]
    return merge identity [("region", toJson "auto"), ("credentials", obj
      [("AWS_ACCESS_KEY_ID", field minted "accessKeyId"), ("AWS_SECRET_ACCESS_KEY", field minted "secretAccessKey"),
       ("AWS_SESSION_TOKEN", field minted "sessionToken"), ("AWS_CREDENTIAL_EXPIRATION", field minted "expiration")])]
  let role ← Prog.effect "mountRoleArn" [storage]
  if !truthy role then return identity
  let external ← Prog.effect "mountExternalId" [storage]
  let credentials ← Prog.effect "assumeScopedMountCredentials" [obj [("roleArn", role),
    ("bucket", field identity "bucket"), ("prefix", field identity "prefix"),
    ("externalId", external), ("attribution", field ctx "attribution")]]
  return if truthy credentials then merge identity [("credentials", credentials)] else identity

/-- Days from 1970-01-01 to a proleptic Gregorian date. -/
private def daysFromCivil (year : Int) (month day : Nat) : Int :=
  let y := if month <= 2 then year - 1 else year
  let era := (y - (if y >= 0 then 0 else 399)) / 400
  let yoe := y - era * 400
  let mp : Int := ((month + 9) % 12 : Nat)
  let doy := (153 * mp + 2) / 5 + (day : Int) - 1
  let doe := yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468

/-- `new Date(text).getTime()` for `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, the form STS and R2 credentials use. -/
private def isoMillis (text : String) : Option Int := do
  let [date, rest] := text.splitOn "T" | none
  let [ys, ms, ds] := date.splitOn "-" | none
  guard (rest.endsWith "Z")
  let time := String.ofList rest.toList.dropLast
  let [hs, ns, ss] := time.splitOn ":" | none
  let (whole, fraction) := match ss.splitOn "." with
    | [w, f] => (w, f)
    | _ => (ss, "0")
  guard (fraction.length <= 3)
  let padded := String.ofList (fraction.toList ++ List.replicate (3 - fraction.length) '0')
  let days := daysFromCivil (← ys.toNat?) (← ms.toNat?) (← ds.toNat?)
  let seconds := (← hs.toNat?) * 3600 + (← ns.toNat?) * 60 + (← whole.toNat?)
  return days * 86400000 + (seconds * 1000 + (← padded.toNat?) : Nat)

private def readTargetFromMount (call : Json) : Prog Json := do
  let mount ← Prog.effect "resolveS3Mount" [Twin.callArg call 0]
  let credentials := field mount "credentials"
  let access := obj ((if truthy credentials then [("credentials", obj
      [("accessKeyId", field credentials "AWS_ACCESS_KEY_ID"),
       ("secretAccessKey", field credentials "AWS_SECRET_ACCESS_KEY"),
       ("sessionToken", field credentials "AWS_SESSION_TOKEN")])] else []) ++
    optionalKey "region" (field mount "region") ++ optionalKey "endpoint" (field mount "endpoint"))
  let expiration := field credentials "AWS_CREDENTIAL_EXPIRATION"
  let expires ← if !truthy expiration then pure [] else
    match isoMillis (str expiration) with
    | some ms => pure [("credentialsExpireAt", obj [("$date", toJson ms)])]
    | none => Prog.unsupported "date format other than ISO 8601 UTC"
  return obj ([("bucket", field mount "bucket"), ("prefix", field mount "prefix"), ("access", access)] ++ expires)

private def releaseOnProvider (call : Json) : Prog Json := do
  let provider := Twin.callArg call 1
  let namespace_ := Twin.callArg call 3
  let target ← Prog.catchFail (Prog.effect "getSandboxReleaseTarget"
    [Twin.callArg call 0, provider, namespace_, Twin.callArg call 4])
    (fun error => do
      let _ ← Prog.effect "toErrorMessage" [error]
      pure Json.null)
  if !truthy (field target "externalId") then return toJson false
  let configs ← Prog.effect "releaseCandidates" [provider, Twin.callArg call 2, field target "instance"]
  for config in items configs do
    let done ← Prog.catchFail (do
      let executor ← Prog.effect "providerExecutor" [config]
      let _ := executor
      let _ ← Prog.effect "executor.release" [obj [("namespace", namespace_), ("expectedExternalId", field target "externalId")]]
      pure true)
      (fun error => do
        let _ ← Prog.effect "toErrorMessage" [error]
        pure false)
    if done then return toJson true
  return toJson false

private def obscuraCommand (call : Json) : Prog Json := do
  let request := Twin.callArg call 1
  let exec := (← Prog.effect "sandboxTimeoutSeconds" [Twin.callArg call 0]).getInt?.toOption.getD 0
  let timeout := max ((exec + 1) / 2) (exec - 5)
  let url := str (← Prog.effect "shellQuote" [field request "url"])
  let fetch := "env -u OBSCURA_ALLOW_PRIVATE_NETWORK obscura fetch " ++ url ++ " --quiet --timeout " ++ toString timeout
  match str (field request "mode") with
  | "eval" =>
    let script := str (← Prog.effect "shellQuote" [nullish (field request "script") (toJson "")])
    return toJson (fetch ++ " --eval " ++ script)
  | "screenshot" =>
    let path := str (← Prog.effect "shellQuote" [field request "path"])
    return toJson ("mkdir -p .broods/browse && " ++ fetch ++ " --screenshot " ++ path)
  | mode => return toJson (fetch ++ " --dump " ++ mode)

private def vercelCreateOptions (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let request := Twin.callArg call 1
  let persistent := truthy (Twin.callArg call 2)
  let lifecycle ← Prog.effect "resolveSandboxLifecycle" [field config "lifecycle"]
  let snapshot := field config "snapshot"
  let source : List (String × Json) :=
    if (str snapshot).startsWith "snap_" then
      [("source", obj [("type", toJson "snapshot"), ("snapshotId", snapshot)])]
    else if truthy snapshot then [("image", snapshot)] else []
  let networkId ← Prog.effect "configString" [field (field config "options") "networkId"]
  let auth ← Prog.effect "vercelAuthOptions" [config]
  let seconds := if persistent then (field lifecycle "idleTimeoutSeconds").getInt?.toOption.getD 0
    else (field request "timeoutSeconds").getInt?.toOption.getD 0 + 300
  let policy ← Prog.effect "vercelNetworkPolicy" [config, request]
  let env ← Prog.effect "mergeSandboxEnv" [field config "envVars", field request "envVars"]
  return merge auth (source ++ optionalKey "networkId" networkId ++
    [("persistent", toJson persistent), ("timeout", toJson (seconds * 1000)), ("networkPolicy", policy),
     ("env", env), ("tags", obj [("app", toJson "broods"), ("provider", toJson "vercel")])])

private def imageNote (part : Json) (problem : String) : Json :=
  obj [("type", toJson "text"), ("text", toJson ("[An image (" ++ jsString (field part "mediaType") ++ ", " ++
    toString (Tools.jsLength (str (field part "data"))) ++ " base64 characters) was not shown to you: " ++ problem ++ ".]"))]

private def notImage : String := "it is not a PNG, JPEG, GIF or WebP image"

private def limitImage (part : Json) (images bytes : Nat) : Prog (Json × Nat × Nat) := do
  let data := field part "data"
  let keep := fun (note : String) => pure (imageNote part note, images, bytes)
  let size ← Prog.effect "base64Bytes" [data]
  if undef size then return ← keep notImage
  let mediaType ← Prog.effect "detectMediaType" [obj [("data", data), ("topLevelType", toJson "image")]]
  if undef mediaType || !["image/gif", "image/jpeg", "image/png", "image/webp"].contains (str mediaType) then
    return ← keep notImage
  let count := (size.getNat?.toOption.getD 0)
  if bytes + count > 6291456 then
    return ← keep "it would take the result over the 6 MB of images one result may carry"
  if images >= 8 then return ← keep "the result carries more than 8 images"
  let pixels ← Prog.effect "imageSize" [obj [("$bytes", data)], mediaType]
  if !truthy pixels then return ← keep notImage
  let width := (field pixels "width").getNat?.toOption.getD 0
  let height := (field pixels "height").getNat?.toOption.getD 0
  if max width height > 8000 || min width height < 1 then
    return ← keep s!"it is {width}x{height} pixels; a side must be 1 to 8000"
  return (merge part [("mediaType", mediaType)], images + 1, bytes + count)

private def withImageLimits (call : Json) : Prog Json := do
  let mut images := 0
  let mut bytes := 0
  let mut output : List Json := []
  for part in items (Twin.callArg call 0) do
    if field part "type" != toJson "image-data" then
      output := output ++ [part]
    else
      let (result, nextImages, nextBytes) ← limitImage part images bytes
      output := output ++ [result]
      images := nextImages
      bytes := nextBytes
  return toJson output

private def recordSandboxAuditEvent (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let actor := nullish (field input "actor") (obj [("source", toJson "unknown")])
  let exitCode := match field input "exitCode" with
    | .num n => [("exitCode", Json.num n)]
    | _ => []
  let args := obj ([("accountId", field input "accountId")] ++
    optionalKey "sandboxConfigId" (field input "sandboxConfigId") ++
    [("reservationKey", field input "reservationKey"), ("provider", field input "provider"),
     ("action", field input "action"), ("result", field input "result")] ++
    optionalKey "status" (field input "status") ++ [("actorSource", field actor "source")] ++
    optionalKey "actorId" (field actor "id") ++ optionalKey "actorEmail" (field actor "email") ++
    optionalKey "actorName" (field actor "name") ++ optionalKey "traceId" (field input "traceId") ++
    optionalKey "taskId" (field input "taskId") ++ optionalKey "errorMessage" (field input "errorMessage") ++
    exitCode ++ [("durationMs", field input "durationMs"), ("truncated", field input "truncated")])
  Prog.catchFail (do
    let _ ← Prog.effect "adminMutation"
      [(Json.mkObj [("$convexFunction", toJson "sandbox/auditEvents:insert")]), args]
    return Twin.undefinedJson) (fun _ => pure Twin.undefinedJson)

private def loadSkillTool (_call : Json) : Prog Json := do
  let schema ← Prog.effect "jsonSchema" [obj [("type", toJson "object"), ("properties", obj
    [("path", stringProp "Exact configured skill path, for example acct_abc/example-skill."),
     ("resources", obj [("type", toJson "array"), ("items", obj [("type", toJson "string")]),
       ("description", toJson "Optional additional resource file paths inside the skill bundle.")])]),
    ("required", toJson ["path"]), ("additionalProperties", toJson false)]]
  let result ← Prog.effect "tool" [obj [("description", toJson "Load detailed instructions for an enabled skill. Use the exact path from the available skills list."),
    ("inputSchema", schema), ("execute", fn "execute")]]
  return obj [("load_skill", result)]

def twins : List Twin :=
  [pureTwin "apps/core/src/harness/sandbox/vercel-executor.ts#classifyVercelError" classifyVercelError,
   pureTwin "apps/core/src/harness/tools/utils.ts#jpegSize" jpegSize,
   Twin.traced "apps/core/src/harness/sandbox/platform-worker.ts#platformWorkerConnection" platformWorkerConnection,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#mountAttribution" mountAttribution,
   pureTwin "apps/core/src/harness/sandbox/jobs.ts#parseJobStatus" parseJobStatus,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#rejectPending" rejectPending,
   pureTwin "apps/core/src/harness/tools/utils.ts#base64Bytes" base64Bytes,
   pureTwin "apps/core/src/harness/sandbox/s3-mount.ts#joinPrefix" joinPrefix,
   pureTwin "apps/core/src/shared/sandbox-sizes.ts#workdirSizeResources" workdirSizeResources,
   pureTwin "apps/core/src/harness/tools/async-status.tool.ts#sandboxJobRef" sandboxJobRef,
   Twin.traced "apps/core/src/harness/tools/async-status.tool.ts#settledResult" settledResult,
   pureTwin "apps/core/src/harness/tools/utils.ts#subagentConfig" subagentConfig,
   pureTwin "apps/core/src/harness/sandbox/vercel-executor.ts#vercelSpecs" vercelSpecs,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#callTool" callTool,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#offersTargetChoice" offersTargetChoice,
   Twin.traced "apps/core/src/harness/sandbox/e2b-executor.ts#e2bSpecs" e2bSpecs,
   pureTwin "apps/core/src/harness/tools/index.ts#externalToolRuntimeConfig" externalToolRuntimeConfig,
   pureTwin "apps/core/src/harness/tools/utils.ts#prependTextToUserParts" prependTextToUserParts,
   pureTwin "apps/core/src/harness/tools/utils.ts#toolContentItems" toolContentItems,
   Twin.traced "apps/core/src/harness/tools/utils.ts#parseToolResultOutput" parseToolResultOutput,
   pureTwin "apps/core/src/harness/sandbox/s3-mount.ts#namespaceIsolationSuffix" namespaceIsolationSuffix,
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#exitCodeOf" exitCodeOf,
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#isLocalShell" isLocalShell,
   Twin.traced "apps/core/src/shared/machine-socket.ts#parseFrame" parseFrame,
   Twin.traced "apps/core/src/shared/machine-socket.ts#machineSocketUrl" machineSocketUrl,
   pureTwin "apps/core/src/harness/sandbox/machine-executor.ts#isMachineUpgrade" isMachineUpgrade,
   pureTwin "apps/core/src/shared/s3.ts#isMissingS3Error" isMissingS3Error,
   pureTwin "apps/core/src/harness/tools/utils.ts#textPart" textPart,
   pureTwin "apps/core/src/harness/tools/utils.ts#isFatalSandboxSetupError" isFatalSandboxSetupError,
   Twin.traced "apps/core/src/harness/tools/utils.ts#toolError" toolError,
   pureTwin "apps/core/src/harness/tools/async-status.tool.ts#sandboxForNamespace" sandboxForNamespace,
   pureTwin "apps/core/src/harness/sandbox/s3-mount.ts#sessionIdentity" sessionIdentity,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#nearsExpiry" nearsExpiry,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#workspaceReadContext" workspaceReadContext,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#assertSafeJobId" assertSafeJobId,
   pureTwin "apps/core/src/harness/tools/schedule.tool.ts#toScheduleSummary" toScheduleSummary,
   pureTwin "apps/core/src/harness/tools/channel.tool.ts#sendImagesDescription" sendImagesDescription,
   pureTwin "apps/core/src/harness/tools/channel.tool.ts#sendFilesDescription" sendFilesDescription,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#s3Hosts" s3Hosts,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#runsOnProvider" runsOnProvider,
   Twin.traced "apps/core/src/shared/sandbox-sizes.ts#workdirResources" workdirResources,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#vercelAuthOptions" vercelAuthOptions,
   Twin.traced "apps/core/src/harness/tools/utils.ts#imageSize" imageSize,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#executorS3Context" executorS3Context,
   Twin.traced "apps/core/src/shared/sandbox-cleanup.ts#releaseCandidates" releaseCandidates,
   pureTwin "apps/core/src/harness/sandbox/machine-executor.ts#registryKey" (fun c => toJson (str (Twin.callArg c 0) ++ ":" ++ str (Twin.callArg c 1))),
   pureTwin "apps/core/src/harness/tools/utils.ts#subagentNotFound" (fun c => toJson ("Error: no subagent task found for " ++ str (Twin.callArg c 0))),
   pureTwin "apps/core/src/harness/tools/utils.ts#toolText" (fun c => Twin.callArg c 0),
   pureTwin "apps/core/src/harness/tools/index.ts#isToolEnabled" (fun c => toJson (!undef (Twin.callArg c 0) && field (Twin.callArg c 0) "enabled" != toJson false)),
   pureTwin "apps/core/src/harness/sandbox/vercel-executor.ts#mountsWorkspace" (fun c => toJson (truthy (field (Twin.callArg c 0) "namespace"))),
   pureTwin "apps/core/src/harness/tools/channel.tool.ts#toChannelFile" (fun c => merge (Twin.callArg c 0) [("type", toJson "file")]),
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#bashCall" (fun c => obj [("toolName", toJson "bash"), ("input", obj [("command", Twin.callArg c 0)])]),
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#insertText" (fun c => nullish (field (Twin.callArg c 0) "insert_text") (nullish (field (Twin.callArg c 0) "new_str") (toJson ""))),
   pureTwin "apps/core/src/harness/sandbox/jobs.ts#callbackEnv" (fun c => if truthy (Twin.callArg c 0) then obj [("__CB_TOKEN", field (Twin.callArg c 0) "token")] else obj []),
   pureTwin "apps/core/src/shared/sandbox-sizes.ts#positiveNumber" (fun c => match Twin.callArg c 0 with | .num n => if n.mantissa > 0 then .num n else Twin.undefinedJson | _ => Twin.undefinedJson),
   Twin.traced "apps/core/src/harness/sandbox/worker-executor.ts#workerConnection" (fun _ => Prog.effect "platformWorkerConnection" [toJson "CLOUDFLARE_WORKER_URL", toJson "CLOUDFLARE_WORKER_API_KEY", toJson "worker"]),
   Twin.traced "apps/core/src/harness/sandbox/cloudflare-executor.ts#cloudflareConnection" (fun _ => Prog.effect "platformWorkerConnection" [toJson "CLOUDFLARE_SANDBOX_URL", toJson "CLOUDFLARE_SANDBOX_API_KEY", toJson "cloudflare"]),
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendFilesSchema" sendFilesSchema,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendImagesSchema" sendImagesSchema,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendStickerTool" sendStickerTool,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendReactionsTool" sendReactionsTool,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendUpdateTool" sendUpdateTool,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendFilesTool" sendFilesTool,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendImagesTool" sendImagesTool,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#lifecycleScript" lifecycleScript,
   Twin.traced "apps/core/src/harness/sandbox/e2b-executor.ts#e2bBackgroundCommand" e2bBackgroundCommand,
   pureTwin "apps/core/src/shared/machine-socket.ts#occupiedReason" occupiedReason,
   Twin.traced "apps/core/src/harness/tools/index.ts#harnessNameError" (fun c => do
     let problem ← Prog.effect "harnessToolNameProblem" [Twin.callArg c 0]
     return toJson ("config.tools." ++ str (Twin.callArg c 0) ++ " " ++ jsString problem)),
   Twin.traced "apps/core/src/harness/tools/utils.ts#formatJSONValue" formatJSONValue,
   Twin.traced "apps/core/src/harness/tools/utils.ts#isJSONValue" isJSONValue,
   Twin.traced "apps/core/src/harness/sandbox/platform-worker.ts#callPlatformWorker" callPlatformWorker,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#sendMessageTool" sendMessageTool,
   pureTwin "apps/core/src/harness/tools/edit.tool.ts#editScript" editScript,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#statusScript" statusScript,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#callbackSnippet" callbackSnippet,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#launchScript" launchScript,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#freshMountScript" freshMountScript,
   Twin.traced "apps/core/src/shared/s3.ts#readS3Body" readS3Body,
   Twin.traced "apps/core/src/shared/s3.ts#deleteS3Prefix" deleteS3Prefix,
   Twin.traced "apps/core/src/harness/tools/utils.ts#startedInConversation" startedInConversation,
   Twin.traced "apps/core/src/shared/sandbox-cleanup.ts#sandboxConfigs" sandboxConfigs,
   Twin.traced "apps/core/src/shared/s3.ts#getS3ObjectUrl" getS3ObjectUrl,
   Twin.traced "apps/core/src/shared/s3.ts#readS3TextHead" readS3TextHead,
   Twin.traced "apps/core/src/shared/s3.ts#readS3Bytes" readS3Bytes,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#vercelSandboxName" vercelSandboxName,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#mountRoleArn" mountRoleArn,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#mountExternalId" mountExternalId,
   Twin.traced "apps/core/src/harness/tools/utils.ts#virtualSubagentConfig" virtualSubagentConfig,
   Twin.traced "packages/convex/model/sandboxRules.ts#workspaceSandboxLimits" workspaceSandboxLimits,
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#applyPatch" (fun _ => standInShape ["edit", "write"]),
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#openaiShell" (fun _ => standInShape ["bash"]),
   pureTwin "apps/core/src/harness/tools/sandbox-stand-in.ts#runCall" (fun _ => fn ""),
   Twin.traced "apps/core/src/harness/tools/utils.ts#urlToolContentPartToUserPart" urlToolContentPartToUserPart,
   Twin.traced "apps/core/src/harness/tools/utils.ts#toolContentPartToUserPart" toolContentPartToUserPart,
   Twin.traced "apps/core/src/harness/tools/utils.ts#modelValueToUserParts" modelValueToUserParts,
   Twin.traced "apps/core/src/harness/tools/utils.ts#normalizeToolResultOutput" normalizeToolResultOutput,
   Twin.traced "apps/core/src/harness/tools/utils.ts#getOwnedSubagent" getOwnedSubagent,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#customTool" customTool,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#sandboxStandIn" sandboxStandIn,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#anthropicBash" (fun c => standInWithRun c ["bash"]),
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#localShell" (fun c => standInWithRun c ["bash"]),
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#textEditor" (fun c => standInWithRun c ["edit", "read", "write"]),
   Twin.traced "apps/core/src/harness/sandbox/e2b-executor.ts#e2bApiOptions" e2bApiOptions,
   Twin.traced "apps/core/src/harness/sandbox/e2b-executor.ts#e2bCreateOptions" e2bCreateOptions,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#mountScript" vercelMountScript,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#vercelNetworkPolicy" vercelNetworkPolicy,
   Twin.traced "apps/core/src/harness/tools/edit.tool.ts#inputSchema" editInputSchema,
   Twin.traced "apps/core/src/harness/tools/sandbox-stand-in.ts#standInFor" standInFor,
   Twin.traced "apps/core/src/harness/tools/read.tool.ts#inputSchema" readInputSchema,
   Twin.traced "apps/core/src/harness/tools/write.tool.ts#inputSchema" writeInputSchema,
   Twin.traced "apps/core/src/harness/tools/read.tool.ts#spokenContents" spokenContents,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#deliverFiles" deliverFiles,
   Twin.traced "apps/core/src/harness/tools/channel.tool.ts#workspaceAttachment" workspaceAttachment,
   Twin.traced "apps/core/src/harness/sandbox/platform-worker.ts#reservePlatformSandbox" reservePlatformSandbox,
   Twin.traced "apps/core/src/harness/sandbox/platform-worker.ts#releasePlatformSandbox" releasePlatformSandbox,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#resolveS3Mount" resolveS3Mount,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#readTargetFromMount" readTargetFromMount,
   Twin.traced "apps/core/src/shared/sandbox-cleanup.ts#releaseOnProvider" releaseOnProvider,
   Twin.traced "apps/core/src/harness/tools/browse.tool.ts#obscuraCommand" obscuraCommand,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#vercelCreateOptions" vercelCreateOptions,
   Twin.traced "apps/core/src/harness/tools/utils.ts#withImageLimits" withImageLimits,
   Twin.traced "apps/core/src/shared/convex/sandbox-audit-events.ts#recordSandboxAuditEvent" recordSandboxAuditEvent,
   Twin.traced "apps/core/src/harness/tools/load-skill.tool.ts#loadSkillTool" loadSkillTool]

end Spec.Sandbox.Wavesandbox2
