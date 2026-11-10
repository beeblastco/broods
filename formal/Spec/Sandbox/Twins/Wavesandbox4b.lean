import Spec.Twin
import Spec.Sandbox.Twins.Tools.Js

/-!
Twins for the functions listed in `.lake/worklist/assign4/sandbox4b.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox4b

open Lean Spec

private def field (j : Json) (k : String) : Json :=
  (j.getObjVal? k).toOption.getD Twin.undefinedJson

private def undef (j : Json) : Bool := j == Twin.undefinedJson
private def str (j : Json) : String := j.getStr?.toOption.getD ""
private def truthy (j : Json) : Bool := !undef j && Tools.truthy j
private def nullish (j : Json) : Bool := undef j || j == .null
private def jsStr (s : String) : Json := toJson s
private def obj (kv : List (String × Json)) : Json :=
  Json.mkObj (kv.filter fun (_, v) => !undef v)
private def nothing : Json := Twin.undefinedJson

/-- The object's own keys, without the recorder's tags. -/
private def entries (j : Json) : List (String × Json) :=
  match j with
  | .obj kv => kv.toList.filter fun (k, _) => !k.startsWith "$"
  | _ => []

/-- `{...a, ...b}`. -/
private def spread (a b : Json) : Json :=
  let later := entries b
  Json.mkObj ((entries a).filter (fun (k, _) => !later.any (·.1 == k)) ++ later)

/-- The recorded shape of a thrown error of this class. -/
private def errorOf (cls message : String) (name : String := "Error") : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("name", jsStr name), ("message", jsStr message), ("fields", Json.mkObj []),
     ("$class", jsStr cls)])]

private def fail (message : String) : Prog Json := Prog.fail (errorOf "Error" message)

private def config (call : Json) : Json := Twin.field (Twin.self call) "#config"
private def accountOf (cfg : Json) : Json := field (field cfg "controlPlane") "accountId"

/-- `signal?.throwIfAborted()`: an effect only when the signal exists. -/
private def abortCheck (label : String) (signal : Json) : Prog Unit := do
  if !undef signal then
    let _ ← Prog.effect label
  pure ()

/-- `.catch(() => {})` around one effect. -/
private def ignoring (fn : String) (args : List Json) : Prog Unit := do
  let _ ← Prog.attempt fn args
  pure ()

/-- The `try`/`catch` of a provider's release: only a gone sandbox is forgotten. -/
private def goneOr (body : Prog Unit) : Prog Unit :=
  Prog.catchFail body fun error => do
    let gone ← Prog.effect "isSandboxGoneError" [error]
    if truthy gone then pure () else Prog.fail error

/-- `request.expectedExternalId ?? await getSandboxExternalId(provider, key)`. -/
private def releaseTarget (provider : String) (request key : Json) : Prog Json := do
  let expected := field request "expectedExternalId"
  if nullish expected then Prog.effect "getSandboxExternalId" [jsStr provider, key]
  else pure expected

private def releaseWith (provider : String) (cfg request : Json) (kill : Json → Prog Unit) :
    Prog Json := do
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return nothing
  let externalId ← releaseTarget provider request key
  if !truthy externalId then return nothing
  goneOr (kill externalId)
  ignoring "deleteSandboxInstance" [jsStr provider, key, accountOf cfg, externalId]
  return nothing

private def e2bRelease (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return nothing
  let externalId ← releaseTarget "e2b" request key
  if !truthy externalId then return nothing
  let _ ← Prog.effect "e2bSandboxApi"
  goneOr do
    let options ← Prog.effect "e2bApiOptions" [cfg]
    let _ ← Prog.effect "Sandbox.kill" [externalId, options]
  ignoring "deleteSandboxInstance" [jsStr "e2b", key, accountOf cfg, externalId]
  return nothing

private def e2bSnapshot (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let key ← Prog.effect "sandboxReservationKey" [request]
  let externalId ← if truthy key then Prog.effect "getSandboxExternalId" [jsStr "e2b", key]
    else pure .null
  if !truthy externalId then
    return ← fail "no reserved e2b sandbox to snapshot for this sandbox"
  let _ ← Prog.effect "e2bSandboxApi"
  let options ← Prog.effect "e2bApiOptions" [cfg]
  let snapshot ← Prog.effect "Sandbox.createSnapshot" [externalId, options]
  return Json.mkObj [("snapshotId", field snapshot "snapshotId")]

private def daytonaRelease (call : Json) : Prog Json :=
  let cfg := config call
  releaseWith "daytona" cfg (Twin.callArg call 0) fun externalId => do
    let options ← Prog.effect "daytonaClientOptions" [cfg]
    let _ ← Prog.effect "new Daytona" [options]
    let _ ← Prog.effect "new Daytona(daytonaClientOptions(this.#config)).get" [externalId]
    let _ ← Prog.effect "sandbox.delete"

private def daytonaSnapshot (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let uuid ← Prog.effect "randomUUID"
  let name := "broods-" ++ str uuid
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return ← fail "a persistent sandbox reservation key is required"
  let externalId ← Prog.effect "getSandboxExternalId" [jsStr "daytona", key]
  if !truthy externalId then return ← fail "no reserved daytona sandbox for this reservation"
  let options ← Prog.effect "daytonaClientOptions" [cfg]
  let _ ← Prog.effect "new Daytona" [options]
  let sandbox ← Prog.effect "client.get" [externalId]
  let state := field sandbox "state"
  let text := if nullish state then "" else str state
  if text != "" && text != "started" && text != "starting" then
    let _ ← Prog.effect "sandbox.start"
  let _ ← Prog.effect "configString" [field (field cfg "options") "workspaceRoot"]
  let _ ← Prog.effect "sandbox.createSnapshot" [jsStr name, toJson (300 : Nat)]
  return Json.mkObj [("snapshotId", jsStr name)]

private def workdirState (sandbox : Json) : Json := field (Twin.field sandbox "data") "state"

/-- `#reconnect`. -/
private def workdirReconnect (externalId : Json) : Prog Json := do
  let sandbox ← Prog.effect "this.#client.sandboxes.get" [externalId]
  let state := workdirState sandbox
  let mapped ← Prog.effect "mapWorkdirState" [state]
  if mapped == jsStr "error" || mapped == jsStr "terminating" then
    return ← Prog.unsupported "workdirRecordError on a dead sandbox"
  if state == jsStr "stopped" || state == jsStr "standby" then
    let _ ← Prog.effect "sandbox.resume"
  return sandbox

/-- `#workDir`. -/
private def workDir (cfg : Json) (namespace_ : Json) : Prog String := do
  let root ← Prog.effect "configString" [field (field cfg "options") "workspaceRoot"]
  let chosen := if nullish root then jsStr "/mnt/workspaces" else root
  let stripped ← Prog.effect "stripTrailingSlashes" [chosen]
  return str stripped ++ "/" ++ str namespace_

/-- `#runLifecycle`. -/
private def runLifecycle (cfg : Json) (dir : String) : Prog Unit := do
  let script ← Prog.effect "lifecycleScript" [jsStr dir, field cfg "onCreate", field cfg "onResume"]
  if !truthy script then return
  let result ← Prog.effect "sandbox.exec" [script]
  if field result "exit_code" != toJson (0 : Nat) then
    let stderr := field result "stderr"
    let stdout := field result "stdout"
    let message := if truthy stderr then str stderr else if truthy stdout then str stdout
      else "workdir lifecycle hook failed"
    let _ ← fail message

private def harnessGuard (request : Json) : Prog Unit := do
  abortCheck "request.abortSignal?.throwIfAborted" (field request "abortSignal")

private def notPersistent : String :=
  "Harness sessions require a persistent workdir sandbox reservation key"

/-- `#persistent`: the key is only computed for a persistent config. -/
private def persistent (cfg request : Json) : Prog Bool := do
  if field cfg "persistent" != toJson true then return false
  let key ← Prog.effect "sandboxReservationKey" [request]
  return truthy key

private def workdirResume (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  harnessGuard request
  if !(← persistent cfg request) then return ← fail notPersistent
  let key := field request "reservationKey"
  let externalId ← Prog.effect "getSandboxExternalId" [jsStr "sandbox", key]
  if !truthy externalId then
    let error ← Prog.effect "new SandboxGoneError"
      [jsStr "no reserved workdir sandbox for this Harness session"]
    return ← Prog.fail error
  let sandbox ← workdirReconnect externalId
  runLifecycle cfg (← workDir cfg key)
  let plane := field cfg "controlPlane"
  ignoring "saveSandboxInstance"
    [jsStr "sandbox", key, externalId, accountOf cfg, field plane "releaseAfterIdleSeconds"]
  ignoring "upsertSandboxInstance"
    [plane, jsStr "sandbox", key, externalId, field request "metadata"]
  harnessGuard request
  return sandbox

private def workdirRelease (call : Json) : Prog Json :=
  let cfg := config call
  releaseWith "sandbox" cfg (Twin.callArg call 0) fun externalId => do
    let sandbox ← Prog.effect "this.#client.sandboxes.get" [externalId]
    let mapped ← Prog.effect "mapWorkdirState" [workdirState sandbox]
    if mapped != jsStr "terminating" then
      let _ ← Prog.effect "sandbox.delete"

private def sessionField (call : Json) (name : String) : Json :=
  Twin.field (Twin.self call) ("#" ++ name)

/-- `stop` and `destroy` differ only in the executor method and its message. -/
private def endSession (method message : String) (call : Json) : Prog Json := do
  if sessionField call "shared" == toJson true then return nothing
  if undef (field (sessionField call "executor") method) then return ← fail message
  let _ ← Prog.effect s!"this.#executor.{method}"
    [Json.mkObj [("reservationKey", sessionField call "reservationKey")]]
  return nothing

private def isUrlSafe (c : Char) : Bool :=
  c.isAlphanum || c == '-' || c == '_' || c == '.' || c == '*'

private def sessionGetPortUrl (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let previewKey := sessionField call "previewKey"
  if !truthy previewKey then return ← fail "Workdir Harness port exposure requires an API key"
  let exposed ← Prog.effect "this.#sandbox.exposePort" [field options "port"]
  let parts := (str exposed).splitOn "://"
  match parts with
  | [scheme, rest] =>
    if !rest.contains '/' || rest.contains '?' || rest.contains '#' ||
        !(str previewKey).all isUrlSafe then
      return ← Prog.unsupported "URL normalisation beyond a plain path"
    let protocol := field options "protocol"
    let next :=
      if protocol == jsStr "ws" then (if scheme == "https" then "wss" else "ws")
      else if truthy protocol then str protocol else scheme
    return jsStr (next ++ "://" ++ rest ++ "?key=" ++ str previewKey)
  | _ => Prog.unsupported "not an absolute URL"

private def sessionSpawn (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let dir := field options "workingDirectory"
  Prog.effect "HarnessShellProcess.start" [obj
    [("executor", sessionField call "shell"), ("command", field options "command"),
     ("workingDirectory", if nullish dir then sessionField call "defaultWorkingDirectory" else dir),
     ("env", spread (sessionField call "env") (field options "env")),
     ("abortSignal", if truthy (field options "abortSignal") then field options "abortSignal" else nothing)]]

private def driverOptions (call : Json) : Json := Twin.field (Twin.self call) "#options"

/-- `#session`. -/
private def driverSession (call : Json) (sandbox : Json) : Prog Json := do
  let opts := driverOptions call
  let env ← Prog.effect "stringRecord" [field (field opts "config") "envVars"]
  let previewKey ← Prog.effect "workdirPreviewKey" [field opts "config"]
  let dir := field opts "defaultWorkingDirectory"
  let ports := field opts "ports"
  Prog.effect "new WorkdirHarnessSession" [obj
    [("sandbox", sandbox), ("executor", Twin.field (Twin.self call) "#executor"),
     ("reservationKey", field opts "reservationKey"),
     ("description", jsStr ("Broods Workdir sandbox " ++ str (field sandbox "id"))),
     ("defaultWorkingDirectory", if nullish dir then jsStr "/workspace" else dir),
     ("env", env), ("ports", if nullish ports then .arr #[] else ports),
     ("previewKey", previewKey), ("shared", toJson (field opts "shared" == toJson true))]]

private def optionalSignal (options : Json) : List (String × Json) :=
  if truthy (field options "abortSignal") then [("abortSignal", field options "abortSignal")] else []

private def optionalMetadata (opts : Json) : List (String × Json) :=
  if truthy (field opts "metadata") then [("metadata", field opts "metadata")] else []

private def report (opts options session : Json) : Prog Unit := do
  let _ ← Prog.effect "reportSandboxUsage"
    [session, field opts "onUsage", field options "abortSignal"]

private def driverCreate (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let opts := driverOptions call
  let signal := field options "abortSignal"
  let guard := abortCheck "options.abortSignal?.throwIfAborted" signal
  let identity := field options "identity"
  let expected := field opts "bootstrapIdentity"
  if !undef identity && !undef expected && identity != expected then
    return ← fail "Workdir Harness bootstrap identity does not match this reservation"
  guard
  let shared := truthy (field opts "shared")
  let reservation ← Prog.effect "this.#executor.acquireHarnessReservation" [Json.mkObj
    ([("reservationKey", field opts "reservationKey")] ++ optionalSignal options ++
      optionalMetadata opts ++ (if shared then [("shared", toJson true)] else []))]
  Prog.catchFail
    (do
      guard
      let session ← driverSession call (field reservation "sandbox")
      report opts options session
      guard
      return Json.mkObj
        [("session", session), ("isFirstCreate", field reservation "isFirstCreate")])
    fun error => do
      if truthy (field reservation "isFirstCreate") && field opts "shared" != toJson true then
        let executor := Twin.field (Twin.self call) "#executor"
        if !undef (field executor "release") then
          ignoring "this.#executor .release"
            [Json.mkObj [("reservationKey", field opts "reservationKey")]]
      Prog.fail error

private def driverResume (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let opts := driverOptions call
  let guard := abortCheck "options.abortSignal?.throwIfAborted" (field options "abortSignal")
  guard
  let sandbox ← Prog.effect "this.#executor.resumeHarnessReservation" [Json.mkObj
    ([("reservationKey", field opts "reservationKey")] ++ optionalSignal options ++
      optionalMetadata opts)]
  guard
  let session ← driverSession call sandbox
  report opts options session
  guard
  return session

private def workerInstanceInfo (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let key ← Prog.effect "sandboxReservationKey" [request]
  let id ← if truthy key then Prog.effect "getSandboxExternalId" [jsStr "worker", key]
    else pure .null
  if !truthy id then return .null
  let connection ← Prog.effect "workerConnection"
  let response ← Prog.effect "callPlatformWorker"
    [connection, jsStr "cloudflare v8 worker", jsStr ("/v1/sandboxes/" ++ str id), jsStr "GET"]
  let body ← Prog.effect "response.json"
  let parsed ← Prog.effect "statusResult.parse" [body]
  let _ := response
  if truthy (field parsed "exists") then
    return Json.mkObj [("externalId", id), ("state", jsStr "suspended")]
  return .null

/-- The `drop` callback handed to `releasePlatformSandbox`. -/
private def workerDrop (args : Json) : Prog Unit := do
  let connection ← Prog.effect "workerConnection"
  let _ ← Prog.effect "callPlatformWorker"
    [connection, jsStr "cloudflare v8 worker", jsStr ("/v1/sandboxes/" ++ str (Twin.arg args 0)),
     jsStr "DELETE"]

private def workerRelease (call : Json) : Prog Json := do
  let cfg := config call
  Prog.drain (fun _ args => workerDrop args) 8
  let _ ← Prog.effect "releasePlatformSandbox"
    [jsStr "worker", accountOf cfg, Twin.callArg call 0, Json.mkObj [("$fn", jsStr "")]]
  return nothing

private def fnRef : Json := Json.mkObj [("$fn", jsStr "")]

/-- A whole number of the recorded JSON, or nothing when it has a fraction. -/
private def wholeNumber (j : Json) : Option Nat := j.getNat?.toOption

private def checkReply (reply : Json) (wanted what : String) : Prog Unit := do
  if field reply "type" != jsStr wanted then
    let _ ← fail s!"machine sandbox answered {what} with {str (field reply "type")}"

private def machineExecutorRun (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let connection ← Prog.effect "connectedMachine" [cfg]
  let id ← Prog.effect "crypto.randomUUID"
  let cwd ← Prog.effect "configString" [field (field cfg "options") "cwd"]
  let env ← Prog.effect "mergeSandboxEnv"
    [field cfg "envVars", field request "envVars", field request "principal"]
  let seconds := field request "timeoutSeconds"
  let some whole := wholeNumber seconds | Prog.unsupported "a fractional timeout"
  let frame := obj
    [("type", jsStr "exec"), ("id", id), ("code", field request "code"), ("cwd", cwd), ("env", env),
     ("timeoutSeconds", seconds), ("outputLimitBytes", field request "outputLimitBytes")]
  let reply ← Prog.effect "sendFrame" [connection, frame, toJson (whole * 1000 + 5000)]
  checkReply reply "result" "an exec"
  let limit := field request "outputLimitBytes"
  let stdout ← Prog.effect "truncateText" [field reply "stdout", limit]
  let stderr ← Prog.effect "truncateText" [field reply "stderr", limit]
  let runtime := field request "runtime"
  return Json.mkObj
    [("ok", toJson (field reply "exitCode" == toJson (0 : Nat))),
     ("runtime", if nullish runtime then jsStr "bash" else runtime),
     ("exitCode", field reply "exitCode"), ("stdout", field stdout "value"),
     ("stderr", field stderr "value"), ("durationMs", field reply "durationMs"),
     ("timedOut", field reply "timedOut"),
     ("truncated", toJson (truthy (field reply "truncated") || truthy (field stdout "truncated") ||
       truthy (field stderr "truncated"))),
     ("provider", jsStr "machine")]

private def machineComputerAction (call : Json) : Prog Json := do
  let input := Twin.callArg call 1
  let connection ← Prog.effect "connectedMachine" [Twin.callArg call 0]
  if !truthy (field connection "computer") then
    let name := str (field connection "name")
    return ← fail s!"computer use is off on machine sandbox \"{name}\". Restart it with `broods machine {name} --computer`."
  let id ← Prog.effect "crypto.randomUUID"
  let duration := field input "duration"
  let some seconds := (if nullish duration then some 0 else wholeNumber duration)
    | Prog.unsupported "a fractional duration"
  let frame := spread input (Json.mkObj [("type", jsStr "computer"), ("id", id)])
  let reply ← Prog.effect "sendFrame" [connection, frame, toJson (30000 + seconds * 1000)]
  checkReply reply "computer-result" "a computer action"
  return reply

private def machineMcpCall (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let connection ← Prog.effect "machineServingMcp" [record]
  let id ← Prog.effect "crypto.randomUUID"
  let reply ← Prog.effect "sendFrame" [connection, Json.mkObj
    [("type", jsStr "mcp-call"), ("id", id), ("server", field record "name"),
     ("tool", Twin.callArg call 1), ("args", Twin.callArg call 2)], toJson (60000 : Nat)]
  checkReply reply "mcp-result" "an MCP call"
  if !truthy (field reply "result") then
    let error := field reply "error"
    return ← fail (if nullish error then "machine sandbox returned no MCP result" else str error)
  return field reply "result"

private def machineMcpList (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let connection ← Prog.effect "machineServingMcp" [record]
  let id ← Prog.effect "crypto.randomUUID"
  let reply ← Prog.effect "sendFrame" [connection, Json.mkObj
    [("type", jsStr "mcp-list"), ("id", id), ("server", field record "name")], toJson (60000 : Nat)]
  checkReply reply "mcp-tools" "an MCP listing"
  if !truthy (field reply "tools") then
    let error := field reply "error"
    return ← fail (if nullish error then "machine sandbox returned no MCP listing" else str error)
  return field reply "tools"

private def workerLabel : Json := jsStr "cloudflare v8 worker"

/-- `#meter`: only a config with an account is metered. -/
private def workerMeter (cfg request duration : Json) : Prog Unit := do
  let plane := field cfg "controlPlane"
  if undef plane then return
  let metadata := field request "metadata"
  let _ ← Prog.effect "recordUsage" [field plane "accountId",
    Json.mkObj [("workerMs", duration), ("workerRequests", toJson (1 : Nat))],
    obj [("projectId", field plane "projectId"), ("agentId", field metadata "agentId"),
      ("workspaceId", field metadata "workspaceId")]]

private def minNat (a b : Nat) : Nat := if a < b then a else b

/-- `#exec`. An answer from the Worker means the command ran, so a failure with one is metered. -/
private def workerExec (cfg request : Json) (id : String) (persist : Bool) : Prog Json := do
  let some seconds := wholeNumber (field request "timeoutSeconds")
    | Prog.unsupported "a fractional timeout"
  let some limit := wholeNumber (field request "outputLimitBytes")
    | Prog.unsupported "a fractional output limit"
  let timeoutMs := minNat (seconds * 1000) 60000
  let startedAt ← Prog.effect "Date.now"
  Prog.catchFail
    (do
      let connection ← Prog.effect "workerConnection"
      let cwd ← Prog.effect "requiredWorkspacePath" [request, jsStr "/workspace"]
      let env ← Prog.effect "mergeSandboxEnv"
        [field cfg "envVars", field request "envVars", field request "principal"]
      let args := field request "args"
      let body := Json.mkObj
        [("script", field request "code"), ("args", if nullish args then .arr #[] else args),
         ("cwd", cwd), ("env", env), ("timeoutMs", toJson timeoutMs),
         ("outputLimitBytes", toJson (minNat limit 1048576)),
         ("enableInternet", toJson (field (field cfg "network") "mode" == jsStr "allow-all")),
         ("persist", toJson persist)]
      let _ ← Prog.effect "callPlatformWorker"
        [connection, workerLabel, jsStr s!"/v1/sandboxes/{id}/exec", jsStr "POST", body,
         toJson (timeoutMs + 15000)]
      let text ← Prog.effect "response.text"
      let result ← Prog.effect "parseExecResponse" [text, workerLabel]
      workerMeter cfg request (field result "duration_ms")
      return result)
    fun error => do
      if field (field error "$error") "$class" == jsStr "PlatformWorkerError" then
        let now ← Prog.effect "Date.now"
        let elapsed := (now.getInt?.toOption.getD 0) - (startedAt.getInt?.toOption.getD 0)
        workerMeter cfg request (toJson elapsed)
      Prog.fail error

private def workerRun (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let startedAt ← Prog.effect "Date.now"
  let key ← Prog.effect "sandboxReservationKey" [request]
  let reserved ←
    if field cfg "persistent" == toJson true && !undef key then
      Prog.effect "reservePlatformSandbox" [jsStr "worker", accountOf cfg, key]
    else pure nothing
  let finish (result : Json) : Prog Json :=
    Prog.effect "execRunResult" [request, result, jsStr "worker", startedAt]
  if undef reserved || undef key then
    let uuid ← Prog.effect "crypto.randomUUID"
    return ← finish (← workerExec cfg request ("fp-e-" ++ str uuid) false)
  Prog.drain (fun _ _ => pure ()) 1
  let outcome ← Prog.attempt "serializedByReservation" [reserved, fnRef]
  let result ← match outcome with
    | .ok value => pure value
    | .threw error _ => Prog.fail error
    | .pending => Prog.unsupported "serialized command never finished"
  Prog.spawn "queueMirrorWrite" [reserved, fnRef]
  let answer ← finish result
  Prog.drain (fun _ _ =>
    Prog.spawn "upsertSandboxInstance"
      [field cfg "controlPlane", jsStr "worker", key, reserved, field request "metadata"]) 1
  return answer

/-- `#persistent` of the E2B executor. -/
private def e2bAcquire (cfg request : Json) : Prog Json := do
  let plane := field cfg "controlPlane"
  let snapshot := field cfg "snapshot"
  let _ ← Prog.effect "e2bSandboxApi"
  if !(← persistent cfg request) then
    let _ ← Prog.effect "assertSnapshotBootable" [plane, snapshot]
    let options ← Prog.effect "e2bCreateOptions" [cfg, toJson false]
    return ← Prog.effect "Sandbox.create" [options]
  let ns ← Prog.effect "sandboxReservationKey" [request]
  let externalId ← Prog.effect "getSandboxExternalId" [jsStr "e2b", ns]
  let connected ←
    if truthy externalId then
      Prog.catchFail
        (do
          let options ← Prog.effect "e2bApiOptions" [cfg]
          let sandbox ← Prog.effect "Sandbox.connect" [externalId, options]
          ignoring "saveSandboxInstance" [jsStr "e2b", ns, externalId, accountOf cfg]
          let _ ← Prog.effect "upsertSandboxInstance"
            [plane, jsStr "e2b", ns, externalId, field request "metadata"]
          pure (some sandbox))
        fun error => do
          let gone ← Prog.effect "isSandboxGoneError" [error]
          if !truthy gone then
            let _ ← Prog.fail (α := Json) error
          ignoring "deleteSandboxInstance" [jsStr "e2b", ns, accountOf cfg, externalId]
          pure none
    else pure none
  if let some sandbox := connected then return sandbox
  let _ ← Prog.effect "assertSnapshotBootable" [plane, snapshot]
  let options ← Prog.effect "e2bCreateOptions" [cfg, toJson true]
  let created ← Prog.effect "Sandbox.create" [options]
  let createdId := field created "sandboxId"
  let claimed ← Prog.catchFail
    (do
      let won ← Prog.effect "claimSandboxInstance" [jsStr "e2b", ns, createdId, accountOf cfg]
      if truthy won then
        let _ ← Prog.effect "upsertSandboxInstance"
          [plane, jsStr "e2b", ns, createdId, field request "metadata"]
        if truthy (accountOf cfg) then
          let _ ← Prog.unsupported (α := Json) "the detached specs read"
      pure (truthy won))
    fun error => do
      let api ← Prog.effect "e2bApiOptions" [cfg]
      let _ ← Prog.all [("Sandbox.kill", [createdId, api]),
        ("deleteSandboxInstance", [jsStr "e2b", ns, accountOf cfg, createdId])]
      Prog.fail error
  if claimed then return created
  let winner ← Prog.effect "getSandboxExternalId" [jsStr "e2b", ns]
  let api ← Prog.effect "e2bApiOptions" [cfg]
  ignoring "Sandbox.kill" [createdId, api]
  if !truthy winner then return ← fail "failed to reserve e2b sandbox (lost create race)"
  let again ← Prog.effect "e2bApiOptions" [cfg]
  Prog.effect "Sandbox.connect" [winner, again]

private def e2bRun (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  let startedAt ← Prog.effect "Date.now"
  let isPersistent ← persistent cfg request
  let sandbox ← e2bAcquire cfg request
  let endMeter ←
    if isPersistent then pure nothing
    else
      Prog.drain (fun _ _ => do let _ ← Prog.attempt "e2bSpecs" [sandbox]) 1
      let meter ← Prog.effect "meterEphemeralSandbox"
        [field cfg "controlPlane", jsStr "e2b", field sandbox "sandboxId", field request "metadata", fnRef]
      pure meter
  let cleanup : Prog Unit := do
    if !isPersistent then
      let _ ← Prog.effect "sandbox.kill"
      if truthy endMeter then
        let _ ← Prog.effect "endMeter"
  let some seconds := wholeNumber (field request "timeoutSeconds")
    | Prog.unsupported "a fractional timeout"
  let answer ← Prog.catchFail
    (do
      let envs ← Prog.effect "mergeSandboxEnv"
        [field cfg "envVars", field request "envVars", field request "principal"]
      let result ← Prog.effect "sandbox.commands.run" [field request "code",
        Json.mkObj [("timeoutMs", toJson (seconds * 1000)), ("envs", envs)]]
      let limit := field request "outputLimitBytes"
      let out := field result "stdout"
      let stdout ← Prog.effect "truncateText" [if nullish out then jsStr "" else out, limit]
      let parts := [field result "stderr", field result "error"].filter truthy
      let joined := "\n".intercalate (parts.map str)
      let stderr ← Prog.effect "truncateText" [jsStr joined, limit]
      let now ← Prog.effect "Date.now"
      let exitCode := field result "exitCode"
      let code := if nullish exitCode then Json.null else exitCode
      let runtime := field request "runtime"
      let elapsed := (now.getInt?.toOption.getD 0) - (startedAt.getInt?.toOption.getD 0)
      pure (Json.mkObj
        [("ok", toJson (code == toJson (0 : Nat))),
         ("runtime", if nullish runtime then jsStr "bash" else runtime),
         ("exitCode", code), ("stdout", field stdout "value"), ("stderr", field stderr "value"),
         ("durationMs", toJson elapsed),
         ("truncated", toJson (truthy (field stdout "truncated") || truthy (field stderr "truncated"))),
         ("provider", jsStr "e2b")]))
    fun error => do
      cleanup
      Prog.fail error
  cleanup
  return answer

private def e2bRunBackground (call : Json) : Prog Json := do
  let cfg := config call
  let request := Twin.callArg call 0
  if !(← persistent cfg request) then
    return ← fail "background jobs require a persistent e2b sandbox reservation key"
  let sandbox ← e2bAcquire cfg request
  let given := field request "jobId"
  let jobId ← if nullish given then Prog.effect "generateJobId" else pure given
  let command ← Prog.effect "e2bBackgroundCommand" [request, jobId]
  let merged ← Prog.effect "mergeSandboxEnv" [field cfg "envVars", field request "envVars"]
  let callback ← Prog.effect "callbackEnv" [field request "callback"]
  let some seconds := wholeNumber (field request "timeoutSeconds")
    | Prog.unsupported "a fractional timeout"
  let _ ← Prog.effect "sandbox.commands.run" [command, Json.mkObj
    [("background", toJson true), ("timeoutMs", toJson (seconds * 1000)),
     ("envs", spread merged callback)]]
  ignoring "handle.disconnect" []
  return Json.mkObj [("jobId", jobId), ("externalId", field sandbox "sandboxId")]

private def sandboxSource (file name : String) : String :=
  s!"apps/core/src/harness/sandbox/{file}.ts#{name}"

/-- `workdirError`. The first non-empty of stderr and stdout, else the exit code. -/
private def workdirError (call : Json) : Prog Json := do
  let result := Twin.callArg call 1
  let stderr := str (field result "stderr")
  let stdout := str (field result "stdout")
  if stderr != "" then return errorOf "Error" stderr
  if stdout != "" then return errorOf "Error" stdout
  match (field result "exit_code").getInt? with
  | .ok code =>
    return errorOf "Error" s!"Workdir failed to {str (Twin.callArg call 0)} (exit {code})"
  | .error _ => Prog.unsupported "exit code is not an integer"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (sandboxSource "e2b-executor" "E2BSandboxExecutor.release") e2bRelease,
   Twin.traced (sandboxSource "e2b-executor" "E2BSandboxExecutor.snapshot") e2bSnapshot,
   Twin.traced (sandboxSource "daytona-executor" "DaytonaSandboxExecutor.release") daytonaRelease,
   Twin.traced (sandboxSource "daytona-executor" "DaytonaSandboxExecutor.snapshot") daytonaSnapshot,
   Twin.traced (sandboxSource "workdir-executor" "WorkdirSandboxExecutor.resumeHarnessReservation") workdirResume,
   Twin.traced (sandboxSource "workdir-executor" "WorkdirSandboxExecutor.release") workdirRelease,
   Twin.traced (sandboxSource "workdir-harness-driver" "workdirError") workdirError,
   Twin.traced (sandboxSource "workdir-harness-driver" "WorkdirHarnessSession.stop")
     (endSession "suspend" "Workdir Harness reservation cannot be suspended"),
   Twin.traced (sandboxSource "workdir-harness-driver" "WorkdirHarnessSession.destroy")
     (endSession "release" "Workdir Harness reservation cannot be released"),
   Twin.traced (sandboxSource "workdir-harness-driver" "WorkdirHarnessSession.getPortUrl") sessionGetPortUrl,
   Twin.traced (sandboxSource "workdir-harness-driver" "WorkdirHarnessSession.spawnCommand") sessionSpawn,
   Twin.traced (sandboxSource "workdir-harness-driver" "WorkdirHarnessDriver.createSession") driverCreate,
   Twin.traced (sandboxSource "workdir-harness-driver" "WorkdirHarnessDriver.resumeSession") driverResume,
   Twin.traced (sandboxSource "worker-executor" "WorkerSandboxExecutor.getInstanceInfo") workerInstanceInfo,
   Twin.traced (sandboxSource "worker-executor" "WorkerSandboxExecutor.release") workerRelease,
   Twin.traced (sandboxSource "worker-executor" "WorkerSandboxExecutor.run") workerRun,
   Twin.traced (sandboxSource "machine-executor" "MachineSandboxExecutor.run") machineExecutorRun,
   Twin.traced (sandboxSource "machine-executor" "runMachineComputerAction") machineComputerAction,
   Twin.traced (sandboxSource "machine-executor" "runMachineMcpCall") machineMcpCall,
   Twin.traced (sandboxSource "machine-executor" "runMachineMcpList") machineMcpList,
   Twin.traced (sandboxSource "e2b-executor" "E2BSandboxExecutor.run") e2bRun,
   Twin.traced (sandboxSource "e2b-executor" "E2BSandboxExecutor.runBackground") e2bRunBackground]

end Spec.Sandbox.Wavesandbox4b
