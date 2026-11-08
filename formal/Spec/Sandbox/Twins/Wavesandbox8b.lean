import Spec.Twin
import Spec.Sandbox.Twins.Tools.Js
import Spec.Sandbox.Twins.Runtime.Basics

namespace Spec.Sandbox.Wavesandbox8b

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def string (value : Json) : String :=
  value.getStr?.toOption.getD ""

private def bytes (value : Json) : ByteArray :=
  ByteArray.mk ((Tools.fromBase64 (string (field value "$bytes"))).map UInt8.ofNat)

private def bytesJson (value : ByteArray) : Json :=
  Json.mkObj [("$bytes", toJson (Rt.base64 value.toList))]

/-- Restores the packed filesystem header and consumes file payloads in header order. -/
private def decodeState (call : Json) : Prog Json := do
  let packed ← Prog.effect "gunzipSync" [Twin.callArg call 0]
  let data := bytes packed
  let _ ← Prog.effect "new DataView" [packed, toJson (0 : Nat), toJson (4 : Nat)]
  let length ← Prog.effect "new DataView( packed.buffer, packed.byteOffset, HEADER_LENGTH_BYTES, ).getUint32"
    [toJson (0 : Nat)]
  let headerLength := length.getNat?.toOption.getD 0
  let header := String.fromUTF8! (data.extract 4 (4 + headerLength))
  let entries ← match Json.parse header with
    | .ok (.arr entries) => pure entries
    | _ => Prog.unsupported "invalid packed filesystem header"
  let fs ← Prog.effect "emptyFs"
  let mut offset := 4 + headerLength
  for entry in entries do
    let path := field entry "path"
    let mode := field entry "mode"
    if field entry "kind" == toJson "dir" then
      let _ ← Prog.effect "fs.mkdirSync" [path, Json.mkObj [("recursive", toJson true)]]
      let _ ← Prog.effect "fs.chmod" [path, mode]
    else if field entry "kind" == toJson "file" then
      let size := (field entry "size").getNat?.toOption.getD 0
      let chunk := bytesJson (data.extract offset (offset + size))
      let _ ← Prog.effect "fs.writeFileSync" [path, chunk, Twin.undefinedJson,
        Json.mkObj [("mode", mode), ("mtime", Json.mkObj [("$date", field entry "mtime")])]]
      offset := offset + size
    else
      let _ ← Prog.effect "fs.symlink" [field entry "target", path]
  return Json.mkObj [("fs", fs), ("packed", packed)]

/-- Constructs the AI SDK tool without invoking its deferred execute callback. -/
private def filesystemTool (name description : String) (call : Json) : Prog Json := do
  let schema ← Prog.effect "inputSchema" [Twin.callArg call 0]
  let inputSchema ← Prog.effect "jsonSchema" [schema]
  let tool ← Prog.effect "tool" [Json.mkObj [("description", toJson description),
    ("inputSchema", inputSchema), ("execute", Json.mkObj [("$fn", toJson "execute")])]]
  return Json.mkObj [(name, tool)]

private def memoryTool (call : Json) : Prog Json :=
  filesystemTool "memory_save" "Saves one durable fact to your persistent memory so it survives future conversations.\n\nUsage notes:\n- The entry is written to memory/<slug>.md and indexed in memory/MEMORY.md (loaded into your context every turn).\n- Its metadata records the conversation scope it was learned in (originSessionId), so you can tell where a memory came from when reading it later.\n- Check the memory index already in your context first: saving an existing title updates that entry instead of duplicating it." call

private def globTool (call : Json) : Prog Json :=
  filesystemTool "glob" "Fast file pattern matching in the workspace. Supports glob patterns like `**/*.ts` or `src/**/*.py`.\n\nUsage notes:\n- Returns matching paths (relative to the search root) sorted by modification time, newest first.\n- path is the directory to search in, relative to the workspace root; it defaults to the root.\n- Prefer this over `bash find` for locating files by name." call

private def readTool (call : Json) : Prog Json :=
  filesystemTool "read" "Reads a file from the workspace, returning its contents with line numbers (cat -n style).\n\nUsage notes:\n- file_path is relative to the workspace root.\n- Reads up to 2000 lines from the start by default; use offset and limit to page through large files.\n- Lines are returned as `<line_number>\\t<content>`.\n- Prefer this over `bash cat` for reading files.\n- Reading an audio file returns its transcript rather than its bytes." call

private def editTool (call : Json) : Prog Json :=
  filesystemTool "edit" "Performs exact string replacements in a workspace file.\n\nUsage notes:\n- file_path is relative to the workspace root.\n- old_string must match the file contents exactly, including whitespace and indentation, and must be unique unless replace_all is true; otherwise the edit fails.\n- new_string must differ from old_string.\n- The edit fails if the file does not exist — use the `write` tool to create new files." call

private def writeTool (call : Json) : Prog Json :=
  filesystemTool "write" "Writes a file to the workspace, overwriting it if it already exists.\n\nUsage notes:\n- file_path is relative to the workspace root; missing parent directories are created.\n- Prefer editing an existing file with the `edit` tool over overwriting it with `write`.\n- Always prefer this over `bash` redirection for creating files." call

private def isUndef (value : Json) : Bool :=
  value == Twin.undefinedJson

private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str text => text != ""
  | .num number => number != 0
  | other => !isUndef other

private def intOf (value : Json) : Int :=
  value.getInt?.toOption.getD 0

private def spread (value : Json) : List (String × Json) :=
  match value with
  | .obj entries => entries.toArray.toList.filter (·.1 != "$keys")
  | _ => []

private def merged (value : Json) (extra : List (String × Json)) : Json :=
  Json.mkObj ((spread value).filter (fun entry => !(extra.any (·.1 == entry.1))) ++ extra)

private def present (key : String) (value : Json) : List (String × Json) :=
  if isUndef value then [] else [(key, value)]

/-- Runs `handler` on a thrown value, passing `Prog.unsupported` through untouched. -/
private def catching {α : Type} (body : Prog α) (handler : Json → Prog α) : Prog α :=
  Prog.catchFail body fun error =>
    if (error.getObjVal? "$unsupported").toOption.isSome then Prog.fail error else handler error

/-- A `.catch(() => {})` on a call whose rejection is deliberately dropped. -/
private def ignoring (fn : String) (args : List Json) : Prog Unit := do
  let _ ← Prog.attempt fn args

private def stripTrailingSlashes (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile (· == '/')).reverse

private def keepAliveSlackMs : Int := 60000

private def provider : Json := toJson "vercel"

/-- `#persistent`: the key is only computed for a persistent config. -/
private def vercelPersistent (config request : Json) : Prog Bool := do
  if field config "persistent" != toJson true then return false
  return truthy (← Prog.effect "sandboxReservationKey" [request])

private def vercelWorkspaceRoot (config : Json) : Prog String := do
  let options := field config "options"
  let root ← Prog.effect "configString" [field options "workspaceRoot"]
  return stripTrailingSlashes (if isUndef root || root == .null then "/mnt/workspaces" else string root)

/-- `#shell`: a failed setup command throws what `commandError` renders. -/
private def vercelShell (config _sandbox : Json) (code : String)
    (cwd : Option String) (env : List (String × Json)) : Prog Json := do
  let base ← Prog.effect "stringRecord" [field config "envVars"]
  let result ← Prog.effect "sandbox.runCommand" [Json.mkObj
    ([("cmd", toJson "bash"), ("args", toJson [toJson "-lc", toJson code])] ++
      (match cwd with | some dir => [("cwd", toJson dir)] | none => []) ++
      [("env", merged base env)])]
  if field result "exitCode" != toJson (0 : Nat) then
    let message ← Prog.effect "commandError" [result, toJson "vercel sandbox setup command failed"]
    return ← Prog.throwError "Error" (string message)
  Prog.effect "result.stdout"

/-- `#keepAlive`: the session is extended only when it would end inside the call's window. -/
private def vercelKeepAlive (self sandbox : Json) (seconds : Int) : Prog Unit := do
  let expires := field (field sandbox "expiresAt") "$date"
  if isUndef expires then return
  let now ← Prog.effect "Date.now"
  let idle := intOf (field (Twin.field self "#lifecycle") "idleTimeoutSeconds")
  let shortMs := intOf now + (idle + seconds) * 1000 - intOf expires
  if shortMs <= 0 then return
  match ← Prog.attempt "sandbox.extendTimeout" [toJson (shortMs + keepAliveSlackMs)] with
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
  | _ => pure ()

private def vercelLifecycle (config sandbox : Json) (key : String) : Prog Unit := do
  let onCreate := (field config "onCreate").getArr?.toOption.getD #[]
  let onResume := (field config "onResume").getArr?.toOption.getD #[]
  if onCreate.isEmpty && onResume.isEmpty then return
  let workDir := (← vercelWorkspaceRoot config) ++ "/" ++ key
  let jobsDir := (← vercelWorkspaceRoot config) ++ "/.fp-jobs/" ++ key
  let marker := jobsDir ++ "/.fp-lifecycle-created"
  let quote := fun (text : String) => do
    return string (← Prog.effect "shellQuote" [toJson text])
  let quotedWork ← quote workDir
  let quotedJobs ← quote jobsDir
  let quotedLock ← quote (jobsDir ++ "/.fp-lifecycle.lock")
  let quotedCd ← quote workDir
  let quotedMarker ← quote marker
  let quotedTouch ← quote marker
  let script := "\n".intercalate
    (["set -e", s!"mkdir -p {quotedWork} {quotedJobs}", s!"exec 9>{quotedLock}", "flock 9",
      s!"cd {quotedCd}", "{", s!"if [ ! -f {quotedMarker} ]; then"] ++
      (onCreate.toList.map fun command => "  " ++ string command) ++
      [s!"  touch {quotedTouch}", "else"] ++
      (onResume.toList.map fun command => "  " ++ string command) ++
      ["fi", "} 9>&-"])
  let _ ← vercelShell config sandbox script (some "/") []

private def vercelEnsureMount (self config sandbox request : Json) (persistent : Bool) :
    Prog Unit := do
  if !truthy (← Prog.effect "mountsWorkspace" [request]) then return
  let root ← vercelWorkspaceRoot config
  let mountPath ← Prog.effect "workspacePath" [request, toJson root]
  let now := intOf (← Prog.effect "Date.now") / 1000
  let fresh ← Prog.effect "freshMountScript" [mountPath, toJson now]
  let check ← Prog.effect "sandbox.runCommand"
    [Json.mkObj [("cmd", toJson "bash"), ("args", toJson [toJson "-lc", fresh])]]
  if field check "exitCode" == toJson (0 : Nat) then return
  let context ← Prog.effect "executorS3Context" [config, request]
  let mount ← Prog.effect "resolveS3Mount" [context]
  let credentials := field mount "credentials"
  if !truthy credentials then
    return ← Prog.throwError "Error" "vercel S3 workspace mounts need SANDBOX_MOUNT_ROLE_ARN in the harness runtime, or a workspace bucket with assumeRole or R2 auth"
  if persistent then vercelKeepAlive self sandbox (intOf (field request "timeoutSeconds"))
  let script ← Prog.effect "mountScript" [mount, mountPath, toJson now]
  let region := field mount "region"
  let _ ← vercelShell config sandbox (string script) (some "/")
    (spread credentials ++ [("AWS_EC2_METADATA_DISABLED", toJson "true")] ++
      (if truthy region then [("AWS_REGION", region), ("AWS_DEFAULT_REGION", region)] else []))

private def vercelUpsert (config sandbox request key name : Json) : Prog Unit := do
  let specs ← Prog.effect "vercelSpecs" [sandbox]
  let _ ← Prog.effect "upsertSandboxInstance"
    [field config "controlPlane", provider, key, name, field request "metadata",
      Json.mkObj (present "specs" specs)]

private def vercelForget (config key name : Json) : Prog Unit :=
  ignoring "deleteSandboxInstance"
    [provider, key, field (field config "controlPlane") "accountId", name]

/-- Reattaches to a stored sandbox, or says the caller must create a new one. -/
private def vercelReattach (self config request key storedName : Json) : Prog (Option Json) :=
  catching (do
    let auth ← Prog.effect "vercelAuthOptions" [config]
    let sandbox ← Prog.effect "Sandbox.get" [merged (Json.mkObj [("name", storedName)]) (spread auth)]
    let outlived ← Prog.effect "outlivedMaxLifetime"
      [Twin.field self "#lifecycle", field (field sandbox "createdAt") "$date"]
    if !truthy outlived then
      let networkId ← Prog.effect "configString" [field (field config "options") "networkId"]
      if field sandbox "networkId" != networkId then
        let target := if isUndef networkId then Json.null else networkId
        let _ ← Prog.effect "sandbox.update" [Json.mkObj [("networkId", target)]]
      ignoring "saveSandboxInstance"
        [provider, key, storedName, field (field config "controlPlane") "accountId"]
      vercelUpsert config sandbox request key storedName
      return some sandbox
    let _ ← Prog.effect "sandbox.delete"
    vercelForget config key storedName
    return none) fun error => do
    if !truthy (← Prog.effect "isSandboxGoneError" [error]) then Prog.fail error
    vercelForget config key storedName
    return none

/-- Creates a fresh named sandbox and settles the claim race for its reservation. -/
private def vercelCreateClaimed (config request key : Json) : Prog Json := do
  let name ← Prog.effect "vercelSandboxName" [key]
  let _ ← Prog.effect "assertSnapshotBootable" [field config "controlPlane", field config "snapshot"]
  let options ← Prog.effect "vercelCreateOptions" [config, request, toJson true]
  let sandbox ← Prog.effect "Sandbox.create" [merged options [("name", name)]]
  let accountId := field (field config "controlPlane") "accountId"
  let claimed : Prog Bool := catching (do
    let won ← Prog.effect "claimSandboxInstance" [provider, key, name, accountId]
    if truthy won then vercelUpsert config sandbox request key name
    return truthy won) fun error => do
    vercelForget config key name
    ignoring "sandbox.delete" []
    Prog.fail error
  if ← claimed then return sandbox
  let winner ← Prog.effect "getSandboxExternalId" [provider, key]
  if !truthy winner then
    vercelUpsert config sandbox request key name
    return sandbox
  ignoring "sandbox.delete" []
  let auth ← Prog.effect "vercelAuthOptions" [config]
  Prog.effect "Sandbox.get" [merged (Json.mkObj [("name", winner)]) (spread auth)]

private def vercelAcquire (self config request : Json) : Prog Json :=
  catching (do
    if !(← vercelPersistent config request) then
      let _ ← Prog.effect "assertSnapshotBootable"
        [field config "controlPlane", field config "snapshot"]
      let options ← Prog.effect "vercelCreateOptions" [config, request, toJson false]
      return ← Prog.effect "Sandbox.create" [options]
    let key ← Prog.effect "sandboxReservationKey" [request]
    let storedName ← Prog.effect "getSandboxExternalId" [provider, key]
    if truthy storedName then
      if let some sandbox ← vercelReattach self config request key storedName then
        return sandbox
    vercelCreateClaimed config request key) fun error => do
    Prog.fail (← Prog.effect "classifyVercelError" [error])

/-- `VercelSandboxExecutor.run`, with its private helpers inlined. -/
private def vercelRun (call : Json) : Prog Json := do
  let self := Twin.self call
  let config := Twin.field self "#config"
  let request := Twin.callArg call 0
  let seconds := intOf (field request "timeoutSeconds")
  let startedAt := intOf (← Prog.effect "Date.now")
  let persistent ← vercelPersistent config request
  if isUndef (Twin.field self "#sandboxClass") then
    Prog.setState "self.#sandboxClass" (Json.mkObj [("$opaque", toJson "Promise")])
  let sandbox ← vercelAcquire self config request
  if !persistent then
    Prog.drain (fun label _ =>
      if label == "arg4" then do let _ ← Prog.effect "vercelSpecs" [sandbox]
      else Prog.unsupported s!"callback {label}") 4
    let _ ← Prog.effect "meterEphemeralSandbox"
      [field config "controlPlane", provider, field sandbox "name", field request "metadata",
        Json.mkObj [("$fn", toJson "")]]
  let finish : Prog Unit := do
    if !persistent then
      match ← Prog.attempt "sandbox.stop" with
      | .ok _ => let _ ← Prog.effect "endMeter"
      | _ => pure ()
  let cwd ← if persistent then do
      let key ← Prog.effect "sandboxReservationKey" [request]
      pure (toJson ((← vercelWorkspaceRoot config) ++ "/" ++ string key))
    else Prog.effect "workspacePath" [request]
  let body : Prog Json := do
    vercelEnsureMount self config sandbox request persistent
    if truthy cwd then
      let quoted ← Prog.effect "shellQuote" [cwd]
      let _ ← vercelShell config sandbox ("mkdir -p " ++ string quoted) (some "/") []
    if persistent && truthy cwd then
      vercelKeepAlive self sandbox seconds
      let key ← Prog.effect "sandboxReservationKey" [request]
      vercelLifecycle config sandbox (string key)
      vercelKeepAlive self sandbox seconds
    let env ← Prog.effect "mergeSandboxEnv"
      [field config "envVars", field request "envVars", field request "principal"]
    let result ← Prog.effect "sandbox.runCommand" [Json.mkObj
      ([("cmd", toJson "bash"), ("args", toJson [toJson "-lc", field request "code"])] ++
        (if truthy cwd then [("cwd", cwd)] else []) ++
        [("env", env), ("timeoutMs", toJson (seconds * 1000))])]
    return result
  let result ← catching body fun error => do
    finish
    Prog.fail error
  -- `return this.#adaptResult(...)` is not awaited, so `finally` overlaps its stream reads.
  let outcomes ← Prog.all ([("result.stdout", []), ("result.stderr", [])] ++
    (if persistent then [] else [("sandbox.stop", [])]))
  if let some (.ok _) := outcomes[2]? then
    let _ ← Prog.effect "endMeter"
  let (rawOut, rawErr) ← match outcomes with
    | .ok out :: .ok err :: _ => pure (out, err)
    | .threw error _ :: _ => Prog.fail error
    | _ :: .threw error _ :: _ => Prog.fail error
    | _ => Prog.unsupported "result streams did not settle"
  let limit := field request "outputLimitBytes"
  let out ← Prog.effect "truncateText" [rawOut, limit]
  let err ← Prog.effect "truncateText" [rawErr, limit]
  let finishedAt := intOf (← Prog.effect "Date.now")
  let exitCode := field result "exitCode"
  let runtime := field request "runtime"
  return Json.mkObj
    [("ok", toJson (exitCode == toJson (0 : Nat))),
     ("runtime", if isUndef runtime || runtime == .null then toJson "bash" else runtime),
     ("exitCode", exitCode), ("stdout", field out "value"), ("stderr", field err "value"),
     ("durationMs", toJson (finishedAt - startedAt)),
     ("truncated", toJson (truthy (field out "truncated") || truthy (field err "truncated"))),
     ("provider", provider)]

private def maxConcurrentBackgroundJobs : Nat := 10

/-- `#reserved`: finds the reservation's sandbox and keeps it alive for the call. -/
private def vercelReserved (self config request : Json) : Prog (Json × String) := do
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then
    return ← Prog.throwError "Error" "a persistent sandbox reservation key is required"
  let name ← Prog.effect "getSandboxExternalId" [provider, key]
  if !truthy name then
    return ← Prog.throwError "Error" "no reserved vercel sandbox for this reservation"
  if isUndef (Twin.field self "#sandboxClass") then
    Prog.setState "self.#sandboxClass" (Json.mkObj [("$opaque", toJson "Promise")])
  let auth ← Prog.effect "vercelAuthOptions" [config]
  let sandbox ← Prog.effect "Sandbox.get" [merged (Json.mkObj [("name", name)]) (spread auth)]
  vercelKeepAlive self sandbox 0
  return (sandbox, (← vercelWorkspaceRoot config) ++ "/.fp-jobs/" ++ string key)

private def vercelJobStatus (call : Json) : Prog Json := do
  let self := Twin.self call
  let config := Twin.field self "#config"
  let request := Twin.callArg call 0
  let (sandbox, jobsDir) ← vercelReserved self config request
  let script ← Prog.effect "statusScript" [toJson jobsDir, field request "jobId"]
  let stdout ← vercelShell config sandbox (string script) none []
  Prog.effect "parseJobStatus" [field request "jobId", stdout]

private def vercelJobLogs (call : Json) : Prog Json := do
  let self := Twin.self call
  let config := Twin.field self "#config"
  let request := Twin.callArg call 0
  let limit := field request "outputLimitBytes"
  let bytes := if isUndef limit || limit == .null then toJson (65536 : Nat) else limit
  let (sandbox, jobsDir) ← vercelReserved self config request
  let script ← Prog.effect "logsScript" [toJson jobsDir, field request "jobId", bytes]
  let stdout ← vercelShell config sandbox (string script) none []
  let logs ← Prog.effect "truncateText" [stdout, bytes]
  return Json.mkObj
    [("jobId", field request "jobId"), ("logs", field logs "value"),
     ("truncated", field logs "truncated")]

private def vercelStopJob (call : Json) : Prog Json := do
  let self := Twin.self call
  let config := Twin.field self "#config"
  let request := Twin.callArg call 0
  let (sandbox, jobsDir) ← vercelReserved self config request
  let stop ← Prog.effect "stopScript" [toJson jobsDir, field request "jobId"]
  let _ ← vercelShell config sandbox (string stop) none []
  let script ← Prog.effect "statusScript" [toJson jobsDir, field request "jobId"]
  let stdout ← vercelShell config sandbox (string script) none []
  Prog.effect "parseJobStatus" [field request "jobId", stdout]

private def vercelPrewarm (call : Json) : Prog Json := do
  let self := Twin.self call
  let config := Twin.field self "#config"
  let request := Twin.callArg call 0
  if !(← vercelPersistent config request) then return Twin.undefinedJson
  if isUndef (Twin.field self "#sandboxClass") then
    Prog.setState "self.#sandboxClass" (Json.mkObj [("$opaque", toJson "Promise")])
  let base := merged (Json.mkObj [("code", toJson "")]) (spread request)
  let _ ← vercelAcquire self config
    (merged base [("timeoutSeconds", toJson (30 : Nat)), ("outputLimitBytes", toJson (1024 : Nat))])
  return Twin.undefinedJson

private def vercelRunBackground (call : Json) : Prog Json := do
  let self := Twin.self call
  let config := Twin.field self "#config"
  let request := Twin.callArg call 0
  let seconds := intOf (field request "timeoutSeconds")
  if !(← vercelPersistent config request) then
    return ← Prog.throwError "Error" "background jobs require a persistent vercel sandbox reservation key"
  let ns := string (← Prog.effect "sandboxReservationKey" [request])
  if isUndef (Twin.field self "#sandboxClass") then
    Prog.setState "self.#sandboxClass" (Json.mkObj [("$opaque", toJson "Promise")])
  let sandbox ← vercelAcquire self config request
  let workDir := (← vercelWorkspaceRoot config) ++ "/" ++ ns
  vercelEnsureMount self config sandbox request true
  let quoted ← Prog.effect "shellQuote" [toJson workDir]
  let _ ← vercelShell config sandbox ("mkdir -p " ++ string quoted) (some "/") []
  let given := field request "jobId"
  let jobId ← if isUndef given || given == .null then Prog.effect "generateJobId" else pure given
  vercelKeepAlive self sandbox seconds
  vercelLifecycle config sandbox ns
  vercelKeepAlive self sandbox seconds
  let jobsDir := (← vercelWorkspaceRoot config) ++ "/.fp-jobs/" ++ ns
  let callback := field request "callback"
  let script ← Prog.effect "launchScript"
    [toJson jobsDir, jobId, toJson workDir, field request "code", Json.mkObj
      ([("maxConcurrentJobs", toJson maxConcurrentBackgroundJobs)] ++
        (if truthy callback then [("callback", callback)] else []))]
  let base ← Prog.effect "stringRecord" [field config "envVars"]
  let extra ← Prog.effect "callbackEnv" [callback]
  let result ← Prog.effect "sandbox.runCommand" [Json.mkObj
    [("cmd", toJson "bash"), ("args", toJson [toJson "-lc", script]),
     ("env", merged base (spread extra)), ("timeoutMs", toJson (seconds * 1000))]]
  if field result "exitCode" != toJson (0 : Nat) then
    let message ← Prog.effect "commandError" [result, toJson "failed to launch background job"]
    return ← Prog.throwError "Error" (string message)
  return Json.mkObj [("jobId", jobId), ("externalId", field sandbox "name")]

/-- `commandError`: whatever the command printed, or the caller's fallback. -/
private def commandError (call : Json) : Prog Json := do
  let outcomes ← Prog.all [("result.stderr", []), ("result.stdout", [])]
  match outcomes with
  | [.ok stderr, .ok stdout] =>
    let printed := [stderr, stdout].filter truthy |>.map string
    return if printed.isEmpty then Twin.callArg call 1 else toJson ("\n".intercalate printed)
  | .threw error _ :: _ => Prog.fail error
  | _ :: .threw error _ :: _ => Prog.fail error
  | _ => Prog.unsupported "streams did not settle"

def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#VercelSandboxExecutor.runBackground" vercelRunBackground,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#VercelSandboxExecutor.jobStatus" vercelJobStatus,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#VercelSandboxExecutor.jobLogs" vercelJobLogs,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#VercelSandboxExecutor.stopJob" vercelStopJob,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#VercelSandboxExecutor.prewarm" vercelPrewarm,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#commandError" commandError,
   Twin.traced "apps/core/src/harness/sandbox/vercel-executor.ts#VercelSandboxExecutor.run" vercelRun,
   Twin.traced "apps/cloudflare-worker/src/vfs-state.ts#decodeState" decodeState,
   Twin.traced "apps/core/src/harness/tools/memory.tool.ts#memoryTool" memoryTool,
   Twin.traced "apps/core/src/harness/tools/glob.tool.ts#globTool" globTool,
   Twin.traced "apps/core/src/harness/tools/read.tool.ts#readTool" readTool,
   Twin.traced "apps/core/src/harness/tools/edit.tool.ts#editTool" editTool,
   Twin.traced "apps/core/src/harness/tools/write.tool.ts#writeTool" writeTool]

end Spec.Sandbox.Wavesandbox8b
