import Spec.Twin
import Spec.Sandbox.Twins.Tools.Js
import Spec.Sandbox.Twins.Wavesandbox8a

/-!
Twins of the Daytona executor's reserved-sandbox paths: acquire with its claim race, background
jobs, job status, logs and stop, and `run` for both reserved and ephemeral sandboxes. The private
helpers (`#acquire`, `#reconnect`, `#reserved`, `#runLifecycle`, `#shell`) are inlined.
-/

namespace Spec.Sandbox.Wave11

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def str (value : Json) : String := value.getStr?.toOption.getD ""
private def truthy (value : Json) : Bool := !undef value && Tools.truthy value
private def nullish (value : Json) : Bool := undef value || value == .null
private def jsStr (text : String) : Json := toJson text
private def nothing : Json := Twin.undefinedJson

/-- `value ?? fallback`. -/
private def orElse (value fallback : Json) : Json := if nullish value then fallback else value

private def errorOf (message : String) : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("name", jsStr "Error"), ("message", jsStr message), ("fields", Json.mkObj []),
     ("$class", jsStr "Error")])]

private def fail {α : Type} (message : String) : Prog α := Prog.fail (errorOf message)

private def config (call : Json) : Json := Twin.field (Twin.self call) "#config"
private def accountOf (cfg : Json) : Json := field (field cfg "controlPlane") "accountId"

/-- `.catch(() => {})` around one effect. -/
private def ignoring (fn : String) (args : List Json) : Prog Unit := do
  let _ ← Prog.attempt fn args

/-- A `try`/`catch` that lets a model opt-out through untouched. -/
private def catching {α : Type} (body : Prog α) (handler : Json → Prog α) : Prog α :=
  Prog.catchFail body fun error =>
    if (error.getObjVal? "$unsupported").toOption.isSome then Prog.fail error else handler error

private def daytona : Json := jsStr "daytona"

/-- `MAX_CONCURRENT_BACKGROUND_JOBS`. -/
private def maxConcurrentJobs : Nat := 10

/-- `#persistent`: the key is only computed for a persistent config. -/
private def persistent (cfg request : Json) : Prog Bool := do
  if field cfg "persistent" != toJson true then return false
  let key ← Prog.effect "sandboxReservationKey" [request]
  return truthy key

/-- `#create`: a runner shortage becomes a capacity error, anything else passes through. -/
private def create (cfg options : Json) : Prog Json := do
  match ← Prog.attempt "client.create" [options] with
  | .ok sandbox => return sandbox
  | .threw error _ =>
    let noRunners ← Prog.effect "isNoRunnersError" [error]
    if !truthy noRunners then return ← Prog.fail error
    let snapshot := field cfg "snapshot"
    let subject := if truthy snapshot then s!"snapshot '{str snapshot}'" else "the request"
    let capacity ← Prog.effect "new SandboxCapacityError"
      [jsStr (s!"Daytona has no available runner for {subject} in the " ++
        "selected region. The snapshot may be non-general (pinned to one runner) or the " ++
        "runner is at capacity. Rebuild it as a general snapshot or retry.")]
    Prog.fail capacity
  | .pending => Prog.unsupported "client.create never finished"

/-- `#reconnect`: a sandbox that is not running is started. -/
private def reconnect (externalId : Json) : Prog Json := do
  let sandbox ← Prog.effect "client.get" [externalId]
  let state := field sandbox "state"
  let text ← if nullish state then pure "" else
    match state with
    | .str text => pure text
    | _ => Prog.unsupported "a sandbox state that is not a string"
  if text != "" && text != "started" && text != "starting" then
    let _ ← Prog.effect "sandbox.start"
  return sandbox

private def specsUpsert (cfg request sandbox ns id : Json) : Prog Unit := do
  let specs ← Prog.effect "daytonaSpecs" [sandbox]
  Prog.spawn "queueMirrorUpsert"
    [Tools.mirrorUpsert (field cfg "controlPlane") daytona ns id (field request "metadata")
      (some [("specs", specs)])]

/-- `#acquire`: reconnects to the stored sandbox, or creates one and settles the claim race. -/
private def acquire (cfg request : Json) : Prog Json := do
  let clientOptions ← Prog.effect "daytonaClientOptions" [cfg]
  let _ ← Prog.effect "new Daytona" [clientOptions]
  if !(← persistent cfg request) then
    let options ← Prog.effect "daytonaCreateOptions" [cfg, request, toJson false]
    return ← create cfg options
  let ns ← Prog.effect "sandboxReservationKey" [request]
  let externalId ← Prog.effect "getSandboxExternalId" [daytona, ns]
  let account := accountOf cfg
  let reused : Option Json ←
    if truthy externalId then
      catching
        (do
          let sandbox ← reconnect externalId
          ignoring "saveSandboxInstance" [daytona, ns, externalId, account]
          specsUpsert cfg request sandbox ns externalId
          pure (some sandbox))
        fun error => do
          let gone ← Prog.effect "isSandboxGoneError" [error]
          if !truthy gone then return ← Prog.fail error
          ignoring "deleteSandboxInstance" [daytona, ns, account, externalId]
          pure none
    else pure none
  if let some sandbox := reused then return sandbox
  let options ← Prog.effect "daytonaCreateOptions" [cfg, request, toJson true]
  let sandbox ← create cfg options
  let id := field sandbox "id"
  let claimed ← catching
    (do
      let won ← Prog.effect "claimSandboxInstance" [daytona, ns, id, account]
      if truthy won then specsUpsert cfg request sandbox ns id
      pure (truthy won))
    fun error => do
      let _ ← Prog.all [("sandbox.delete", []),
        ("deleteSandboxInstance", [daytona, ns, account, id])]
      Prog.fail error
  if claimed then return sandbox
  let winner ← Prog.effect "getSandboxExternalId" [daytona, ns]
  ignoring "sandbox.delete" []
  if !truthy winner then
    return ← fail "failed to reserve daytona sandbox (lost create race)"
  reconnect winner

/-- `#workspaceRoot`: `workspaceRoot` option, `/mnt/workspaces` by default, no trailing slashes. -/
private def workspaceRoot (cfg : Json) : Prog String := do
  let root ← Prog.effect "configString" [field (field cfg "options") "workspaceRoot"]
  let chosen := if nullish root then "/mnt/workspaces" else str root
  return String.ofList (chosen.toList.reverse.dropWhile (· == '/')).reverse

private def workDir (cfg : Json) (ns : String) : Prog String := do
  return (← workspaceRoot cfg) ++ "/" ++ ns

private def jobsDir (cfg : Json) (ns : String) : Prog String := do
  return (← workspaceRoot cfg) ++ "/.fp-jobs/" ++ ns

/-- The message of a failed command: what it printed, or the caller's fallback. -/
private def printed (response : Json) (fallback : String) : String :=
  str (orElse (field response "result")
    (orElse (field (field response "artifacts") "stdout") (jsStr fallback)))

private def exitedNonZero (response : Json) : Bool :=
  (orElse (field response "exitCode") (toJson (0 : Nat))).compress != "0"

/-- `#runLifecycle`. -/
private def runLifecycle (cfg sandbox : Json) (dir : String) : Prog Unit := do
  let script ← Prog.effect "lifecycleScript"
    [jsStr dir, field cfg "onCreate", field cfg "onResume"]
  if !truthy script then return
  let response ← Prog.effect "sandbox.process.executeCommand" [script]
  if exitedNonZero response then
    return ← fail (printed response "daytona lifecycle hook failed")

/-- `#shell`. -/
private def shell (code : Json) : Prog Json := do
  let response ← Prog.effect "sandbox.process.executeCommand" [code]
  return orElse (field response "result")
    (orElse (field (field response "artifacts") "stdout") (jsStr ""))

/-- `#reserved`: the reservation's sandbox, reconnected, and its jobs directory. -/
private def reserved (cfg request : Json) : Prog (Json × String) := do
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return ← fail "a persistent sandbox reservation key is required"
  let externalId ← Prog.effect "getSandboxExternalId" [daytona, key]
  if !truthy externalId then return ← fail "no reserved daytona sandbox for this reservation"
  let clientOptions ← Prog.effect "daytonaClientOptions" [cfg]
  let _ ← Prog.effect "new Daytona" [clientOptions]
  let sandbox ← reconnect externalId
  return (sandbox, ← jobsDir cfg (str key))

private def jobStatus (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let (_, dir) ← reserved cfg request
  let script ← Prog.effect "statusScript" [jsStr dir, field request "jobId"]
  let stdout ← shell script
  Prog.effect "parseJobStatus" [field request "jobId", stdout]

private def jobLogs (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let bytes := orElse (field request "outputLimitBytes") (toJson (65536 : Nat))
  let (_, dir) ← reserved cfg request
  let script ← Prog.effect "logsScript" [jsStr dir, field request "jobId", bytes]
  let stdout ← shell script
  let logs ← Prog.effect "truncateText" [stdout, bytes]
  return Json.mkObj
    [("jobId", field request "jobId"), ("logs", field logs "value"),
     ("truncated", field logs "truncated")]

private def stopJob (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let (_, dir) ← reserved cfg request
  let stop ← Prog.effect "stopScript" [jsStr dir, field request "jobId"]
  let _ ← shell stop
  let script ← Prog.effect "statusScript" [jsStr dir, field request "jobId"]
  let stdout ← shell script
  Prog.effect "parseJobStatus" [field request "jobId", stdout]

private def runBackground (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  if !(← persistent cfg request) then
    return ← fail "background jobs require a persistent daytona sandbox reservation key"
  let ns := str (← Prog.effect "sandboxReservationKey" [request])
  let sandbox ← acquire cfg request
  let _ ← Prog.effect "mountAwsS3Buckets" [sandbox, request, cfg]
  runLifecycle cfg sandbox (← workDir cfg ns)
  let jobId := field request "jobId"
  let jobs ← jobsDir cfg ns
  let work ← workDir cfg ns
  let callback := field request "callback"
  let script ← Prog.effect "launchScript"
    [jsStr jobs, jobId, jsStr work, field request "code",
     Json.mkObj ([("maxConcurrentJobs", toJson maxConcurrentJobs)] ++
       (if truthy callback then [("callback", callback)] else []))]
  let env ← Prog.effect "callbackEnv" [callback]
  let response ← Prog.effect "sandbox.process.executeCommand" [script, nothing, env]
  if exitedNonZero response then
    return ← fail (printed response "failed to launch background job")
  return Json.mkObj [("jobId", jobId), ("externalId", field sandbox "id")]

/-- The `() => daytonaSpecs(sandbox)` callback, entered when the meter reads the specs. -/
private def meterCallback (sandbox : Json) : Prog Unit :=
  Prog.drain (fun label _ =>
    if label == "arg4" then do let _ ← Prog.effect "daytonaSpecs" [sandbox]
    else Prog.unsupported s!"callback {label}") 1

private def elapsed (later earlier : Json) : Json :=
  match later.getInt?, earlier.getInt? with
  | .ok finish, .ok start => toJson (finish - start)
  | _, _ => Json.null

private def isEmptyObject (value : Json) : Bool :=
  match value with
  | .obj entries => entries.toArray.all (fun entry => entry.1.startsWith "$")
  | _ => false

/-- The body of `run`'s `try`. -/
private def execute (cfg request sandbox startedAt : Json) (isPersistent : Bool) : Prog Json := do
  let _ ← Prog.effect "mountAwsS3Buckets" [sandbox, request, cfg]
  if isPersistent then
    let key ← Prog.effect "sandboxReservationKey" [request]
    runLifecycle cfg sandbox (← workDir cfg (str key))
  let cwd ← Prog.effect "workspacePath" [request]
  let env ← Prog.effect "mergeSandboxEnv"
    [field cfg "envVars", (Json.mkObj (if field request "principal" == Twin.undefinedJson then [] else [("principal", field request "principal")]))]
  let response ← Prog.effect "sandbox.process.executeCommand"
    [field request "code", cwd, if isEmptyObject env then nothing else env,
     field request "timeoutSeconds"]
  let exitCode := field response "exitCode"
  let text := orElse (field response "result")
    (orElse (field (field response "artifacts") "stdout") (jsStr ""))
  let stdout ← Prog.effect "truncateText" [text, field request "outputLimitBytes"]
  let finished ← Prog.effect "Date.now"
  return Json.mkObj
    [("ok", toJson (!exitedNonZero response)),
     ("runtime", jsStr "bash"),
     ("exitCode", orElse exitCode Json.null),
     ("stdout", field stdout "value"),
     ("stderr", jsStr ""),
     ("durationMs", elapsed finished startedAt),
     ("truncated", field stdout "truncated"),
     ("provider", daytona)]

private def run (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let startedAt ← Prog.effect "Date.now"
  let isPersistent ← persistent cfg request
  let sandbox ← acquire cfg request
  let endMeter ←
    if isPersistent then pure nothing
    else
      meterCallback sandbox
      Prog.effect "meterEphemeralSandbox"
        [field cfg "controlPlane", daytona, field sandbox "id", field request "metadata",
         Json.mkObj [("$fn", jsStr "")]]
  let cleanup : Prog Unit := do
    if !isPersistent then
      let deleted ← Prog.attempt "sandbox.delete"
      let _ ← Prog.effect "waitUntil" [Json.mkObj [("$opaque", jsStr "Promise")]]
      match deleted with
      | .ok _ => if truthy endMeter then
          let _ ← Prog.effect "endMeter"
      | .threw error _ => let _ ← Prog.effect "toErrorMessage" [error]
      | .pending => pure ()
  let result ← catching (execute cfg request sandbox startedAt isPersistent) fun error => do
    cleanup
    Prog.fail error
  cleanup
  return result

private def staticAwsKeys (call : Json) : Prog Json := do
  let env := Twin.callArg call 0
  let accessKeyId := field env "AWS_ACCESS_KEY_ID"
  let secretAccessKey := field env "AWS_SECRET_ACCESS_KEY"
  if !truthy accessKeyId || !truthy secretAccessKey then
    return ← fail ("Daytona AWS S3 mounts require SANDBOX_MOUNT_ROLE_ARN in the harness runtime " ++
      "or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in sandbox envVars.")
  let token := field env "AWS_SESSION_TOKEN"
  return Json.mkObj ([("AWS_ACCESS_KEY_ID", accessKeyId), ("AWS_SECRET_ACCESS_KEY", secretAccessKey)] ++
    (if truthy token then [("AWS_SESSION_TOKEN", token)] else []))

/-- `#reconnect` of the workdir executor. -/
private def wdReconnect (externalId : Json) : Prog Json := do
  let sandbox ← Prog.effect "this.#client.sandboxes.get" [externalId]
  let rawState := field (Twin.field sandbox "data") "state"
  let state ← Prog.effect "mapWorkdirState" [rawState]
  if state == jsStr "error" || state == jsStr "terminating" then
    let reason ← Prog.effect "workdirRecordError" [sandbox]
    let suffix := if truthy reason then s!": {str reason}" else ""
    let gone ← Prog.effect "new SandboxGoneError"
      [jsStr s!"workdir sandbox {str externalId} is {str rawState}{suffix}"]
    return ← Prog.fail gone
  if rawState == jsStr "stopped" || rawState == jsStr "standby" then
    let _ ← Prog.effect "sandbox.resume"
  return sandbox

/-- `#workspaceRoot` of the workdir executor. -/
private def wdRoot (cfg : Json) : Prog String := do
  let options := orElse (field cfg "options") (Json.mkObj [])
  let configured ← Prog.effect "configString" [field options "workspaceRoot"]
  return str (← Prog.effect "stripTrailingSlashes" [orElse configured (jsStr "/mnt/workspaces")])

/-- `#jobContext`. -/
private def wdJobContext (cfg request : Json) : Prog (Json × String) := do
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then
    return ← fail "job operations require a persistent sandbox reservation key"
  let externalId ← Prog.effect "getSandboxExternalId" [jsStr "sandbox", key]
  if !truthy externalId then return ← fail "no reserved workdir sandbox for this workspace"
  let sandbox ← wdReconnect externalId
  return (sandbox, (← wdRoot cfg) ++ "/.fp-jobs/" ++ str key)

/-- `#shell` of the workdir executor. -/
private def wdShell (cmd : Json) : Prog Json := do
  let result ← Prog.effect "sandbox.exec" [cmd]
  return orElse (field result "stdout") (jsStr "")

private def wdJobStatus (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let (_, dir) ← wdJobContext (config call) request
  let script ← Prog.effect "statusScript" [jsStr dir, field request "jobId"]
  let stdout ← wdShell script
  Prog.effect "parseJobStatus" [field request "jobId", stdout]

private def wdJobLogs (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let bytes := orElse (field request "outputLimitBytes") (toJson (65536 : Nat))
  let (_, dir) ← wdJobContext (config call) request
  let script ← Prog.effect "logsScript" [jsStr dir, field request "jobId", bytes]
  let stdout ← wdShell script
  let logs ← Prog.effect "truncateText" [stdout, bytes]
  return Json.mkObj
    [("jobId", field request "jobId"), ("logs", field logs "value"),
     ("truncated", field logs "truncated")]

private def wdStopJob (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let (_, dir) ← wdJobContext (config call) request
  let stop ← Prog.effect "stopScript" [jsStr dir, field request "jobId"]
  let _ ← wdShell stop
  let script ← Prog.effect "statusScript" [jsStr dir, field request "jobId"]
  let stdout ← wdShell script
  Prog.effect "parseJobStatus" [field request "jobId", stdout]

private def cfSource (name : String) : String :=
  "apps/core/src/harness/sandbox/cloudflare-executor.ts#CloudflareSandboxExecutor." ++ name

private def cfLabel : Json := jsStr "cloudflare sandbox bridge"

/-- `CLOUDFLARE_INSTANCE_TYPES[size].name`. -/
private def cfInstance : String → Option String
  | "tiny" | "xsmall" => some "standard-1"
  | "small" => some "standard-2"
  | "medium" => some "standard-3"
  | "large" => some "standard-4"
  | _ => none

/-- `#exec` for the warm-up command: reserved, 30 second timeout, 1 KiB of output. -/
private def cfWarmExec (cfg id : Json) : Prog Unit := do
  let connection ← Prog.effect "cloudflareConnection"
  let env ← Prog.effect "mergeSandboxEnv" [field cfg "envVars"]
  let lifecycle ← Prog.effect "resolveSandboxLifecycle" [field cfg "lifecycle"]
  let size := match field cfg "size" with
    | .str name => name
    | _ => "xsmall"
  let instanceName ← match cfInstance size with
    | some name => pure name
    | none => Prog.unsupported "an unknown size"
  let _ ← Prog.effect "callPlatformWorker"
    [connection, cfLabel, jsStr s!"/v1/sandboxes/{str id}/exec", jsStr "POST",
     Json.mkObj
       [("argv", .arr #[jsStr "true"]), ("env", env), ("timeoutMs", toJson (30000 : Nat)),
        ("outputLimitBytes", toJson (1024 : Nat)),
        ("idleTimeoutSeconds", field lifecycle "idleTimeoutSeconds"),
        ("enableInternet", toJson (field (field cfg "network") "mode" == jsStr "allow-all")),
        ("instance", jsStr instanceName)],
     toJson (90000 : Nat)]
  let text ← Prog.effect "response.text"
  let _ ← Prog.effect "parseExecResponse" [text, cfLabel]

private def source (name : String) : String :=
  "apps/core/src/harness/sandbox/daytona-executor.ts#DaytonaSandboxExecutor." ++ name

private def wdSource (name : String) : String :=
  "apps/core/src/harness/sandbox/workdir-executor.ts#WorkdirSandboxExecutor." ++ name

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/sandbox/daytona-executor.ts#staticAwsKeys" staticAwsKeys,
   Twin.traced (source "run") run,
   Twin.traced (source "runBackground") runBackground,
   Twin.traced (source "jobStatus") jobStatus,
   Twin.traced (source "jobLogs") jobLogs,
   Twin.traced (source "stopJob") stopJob,
   Twin.traced (wdSource "jobStatus") wdJobStatus,
   Twin.traced (wdSource "jobLogs") wdJobLogs,
   Twin.traced (wdSource "stopJob") wdStopJob]

end Spec.Sandbox.Wave11
