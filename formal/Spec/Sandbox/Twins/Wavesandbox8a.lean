import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign8/sandbox8a.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox8a

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def same (a b : Json) : Bool := a.compress == b.compress

private def isUndef (value : Json) : Bool := same value undef

private def isNullish (value : Json) : Bool := isUndef value || same value Json.null

private def truthy (value : Json) : Bool :=
  match value with
  | .null | .bool false => false
  | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def isTrue (value : Json) : Bool := same value (toJson true)

private def orElse (value fallback : Json) : Json :=
  if isNullish value then fallback else value

private def str (value : Json) : String := value.getStr?.toOption.getD ""

private def asInt (value : Json) : Option Int := value.getInt?.toOption

private def fnRef : Json := Json.mkObj [("$fn", toJson "")]

private def promiseRef : Json := Json.mkObj [("$opaque", toJson "Promise")]

/-- Keeps the entries whose value is set, as a spread of `cond ? {k: v} : {}` does. -/
private def objWhen (entries : List (String × Json × Bool)) : Json :=
  Json.mkObj (entries.filterMap fun (key, value, keep) => if keep then some (key, value) else none)

/-- JSON drops a key whose value is `undefined`. -/
private def present (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

private def config (call : Json) : Json := Twin.field (Twin.self call) "#config"

private def options (call : Json) : Json := orElse (field (config call) "options") (Json.mkObj [])

private def controlPlaneField (call : Json) (name : String) : Json :=
  field (field (config call) "controlPlane") name

/-- `shellQuote`, for the one site that passes it to `map` where the recorder cannot see it. -/
private def shellQuoted (text : String) : String :=
  "'" ++ text.replace "'" "'\\''" ++ "'"

/-- Removes the trailing slashes `replace(/\/+$/, "")` strips. -/
private def dropTrailingSlashes (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile (· == '/')).reverse

/-- `sandbox.id`: the SDK reads it from the sandbox's record. -/
private def sandboxData (sandbox : Json) : Json := Twin.field sandbox "data"

private def sandboxId (sandbox : Json) : Json := field (sandboxData sandbox) "id"

private def sandboxState (sandbox : Json) : Json := field (sandboxData sandbox) "state"

private def errorInfo (error : Json) : Json := field error "$error"

private def errorMessage (error : Json) : String := str (field (errorInfo error) "message")

/-- `#persistent`: the key is only computed for a persistent config. -/
def persistent (call request : Json) : Prog Bool := do
  if !isTrue (field (config call) "persistent") then return false
  return truthy (← Prog.effect "sandboxReservationKey" [request])

/-- `#s3MountStrategy`. -/
private def mountStrategy (call request : Json) : Prog String := do
  if !truthy (field request "namespace") && !isTrue (field (options call) "mountAwsS3Buckets") then
    return "none"
  let storage := field (config call) "storage"
  if same (field (field storage "auth") "type") (toJson "r2") then return "exec"
  return if truthy (← Prog.effect "mountRoleArn" [storage]) then "exec" else "declarative"

/-- `#workspaceRoot`. -/
private def workspaceRoot (call : Json) : Prog Json := do
  let configured ← Prog.effect "configString" [field (options call) "workspaceRoot"]
  Prog.effect "stripTrailingSlashes" [orElse configured (toJson "/mnt/workspaces")]

private def workDir (call : Json) (key : Json) : Prog String := do
  return s!"{str (← workspaceRoot call)}/{str key}"

/-- `#mountPath`. The regex is inline, so a root from the request has no effect to record. -/
private def mountPath (call request : Json) : Prog String := do
  let root ← match field request "workspaceRoot" with
    | .str given => pure given
    | _ => do pure (str (← workspaceRoot call))
  return s!"{dropTrailingSlashes root}/{str (field request "namespace")}"

/-- `#s3Mounts`. -/
private def s3Mounts (call request : Json) : Prog (Option Json) := do
  if (← mountStrategy call request) != "declarative" then return none
  let context ← Prog.effect "executorS3Context" [config call, request]
  let identity ← Prog.effect "resolveS3MountIdentity" [context]
  let path ← mountPath call request
  return some (.arr #[objWhen
    [("type", toJson "s3", true), ("bucket", field identity "bucket", true),
     ("mount_path", toJson path, true), ("read_only", toJson false, true),
     ("prefix", field identity "prefix", truthy (field identity "prefix")),
     ("region", field identity "region", truthy (field identity "region")),
     ("endpoint", field identity "endpoint", truthy (field identity "endpoint"))]])

/-- `#createOptions`. Each conditional spread reads its value twice, and the recording shows both. -/
private def createOptions (call request : Json) (isPersistent : Bool) : Prog Json := do
  let opts := options call
  let mounts ← s3Mounts call request
  let network ← Prog.effect "workdirNetwork" [field (config call) "network"]
  let secrets : Option Json ← match mounts with
    | some _ => some <$> Prog.effect "s3SecretNames" [opts]
    | none => pure none
  let image ← Prog.effect "configString" [field (config call) "snapshot"]
  let firstResources ← Prog.effect "workdirResources" [config call]
  let resources ← if truthy firstResources then Prog.effect "workdirResources" [config call]
    else pure undef
  let firstVersion ← Prog.effect "configString" [field opts "imageVersion"]
  let version ← if truthy firstVersion then Prog.effect "configString" [field opts "imageVersion"]
    else pure undef
  let autoStop : Option Int ← if isPersistent then do
      let lifecycle ← Prog.effect "resolveSandboxLifecycle" [field (config call) "lifecycle"]
      match asInt (field lifecycle "idleTimeoutSeconds") with
      | some idle => pure (some (min (max idle 30) 3600))
      | none => Prog.unsupported "an idle timeout that is not an integer"
    else pure none
  let startup := objWhen
    [("network", network, truthy network),
     ("secrets", secrets.getD undef, secrets.isSome)]
  let hasStartup := truthy network || secrets.isSome
  return objWhen
    [("resources", resources, truthy firstResources),
     ("image", image, truthy image),
     ("image_version", version, truthy firstVersion),
     ("mounts", mounts.getD undef, mounts.isSome),
     ("docker", Json.mkObj [("enabled", toJson true)], isTrue (field opts "docker")),
     ("auto_stop_seconds", toJson (autoStop.getD 0), autoStop.isSome),
     ("startup", startup, hasStartup)]

/-- What `#create` does with the SDK's answer: an admission refusal becomes a capacity error. -/
private def createOutcome : Outcome → Prog Json
  | .ok sandbox => pure sandbox
  | .threw error _ => do
    let status := asInt (field (field (errorInfo error) "fields") "status")
    if same (field (errorInfo error) "$class") (toJson "SandboxError") &&
        (status == some 429 || status == some 503) then
      let capacity ← Prog.effect "new SandboxCapacityError" [toJson (errorMessage error)]
      Prog.fail capacity
    else
      Prog.fail error
  | .pending => Prog.unsupported "sandbox creation never finished"

/-- `#create`. -/
private def create (call : Json) (createOpts : Json) : Prog Json := do
  let _ ← Prog.effect "assertSnapshotBootable" [field (config call) "controlPlane", field createOpts "image"]
  createOutcome (← Prog.attempt "this.#client.sandboxes.create" [createOpts])

/-- `#reconnect`. -/
private def reconnect (externalId : Json) : Prog Json := do
  let sandbox ← Prog.effect "this.#client.sandboxes.get" [externalId]
  let rawState := sandboxState sandbox
  let state ← Prog.effect "mapWorkdirState" [rawState]
  if same state (toJson "error") || same state (toJson "terminating") then
    let reason ← Prog.effect "workdirRecordError" [sandbox]
    let suffix := if truthy reason then s!": {str reason}" else ""
    let gone ← Prog.effect "new SandboxGoneError"
      [toJson s!"workdir sandbox {str externalId} is {str rawState}{suffix}"]
    Prog.fail gone
  if same rawState (toJson "stopped") || same rawState (toJson "standby") then
    let _ ← Prog.effect "sandbox.resume"
  return sandbox

private def metadataOf (request : Json) : Json := field request "metadata"

private def releaseRequest (key externalId : Json) : Json :=
  Json.mkObj [("reservationKey", key), ("expectedExternalId", externalId)]

/-- The reservation left behind when a claim is lost or rejected. -/
private def createAndClaim (call request key : Json) : Prog (Json × Bool) := do
  let opts ← createOptions call request true
  let created ← create call opts
  let accountId := controlPlaneField call "accountId"
  let idle := controlPlaneField call "releaseAfterIdleSeconds"
  let claim : Prog (Option (Json × Bool)) := do
    let claimed ← Prog.effect "claimSandboxInstance"
      [toJson "sandbox", key, sandboxId created, accountId, idle]
    if !truthy claimed then return none
    let specs ← Prog.effect "configuredSandboxSpecs" [config call]
    let _ ← Prog.effect "upsertSandboxInstance"
      [field (config call) "controlPlane", toJson "sandbox", key, sandboxId created,
       metadataOf request, present [("specs", specs)]]
    return some (created, true)
  let claimed ← tryCatch claim fun error => do
    if (error.getObjVal? "$unsupported").toOption.isSome then Prog.fail error
    let _ ← Prog.all
      [("created.delete", []),
       ("deleteSandboxInstance", [toJson "sandbox", key, accountId, sandboxId created])]
    Prog.fail error
  if let some reservation := claimed then return reservation
  let winner ← Prog.effect "getSandboxExternalId" [toJson "sandbox", key]
  match ← Prog.attempt "created.delete" with
  | .threw error _ => let _ ← Prog.effect "toErrorMessage" [error]
  | _ => pure ()
  if !truthy winner then
    Prog.throwError "Error" "failed to reserve workdir sandbox (lost create race)"
  return (← reconnect winner, false)

/-- Uses a stored sandbox, and falls through to a new one when it is gone for good. -/
private def reuseReserved (call request key externalId : Json) : Prog (Option (Json × Bool)) := do
  let attempt : Prog (Option (Json × Bool)) := do
    let sandbox ← reconnect externalId
    Prog.spawn "saveSandboxInstance"
      [toJson "sandbox", key, externalId, controlPlaneField call "accountId",
       controlPlaneField call "releaseAfterIdleSeconds"]
    Prog.spawn "upsertSandboxInstance"
      [field (config call) "controlPlane", toJson "sandbox", key, externalId, metadataOf request]
    return some (sandbox, false)
  tryCatch attempt fun error => do
    if (error.getObjVal? "$unsupported").toOption.isSome then Prog.fail error
    if !truthy (← Prog.effect "isSandboxGoneError" [error]) then Prog.fail error
    let _ ← Prog.effect "this.release" [releaseRequest key externalId]
    return none

/-- `#acquireWithState`. -/
def acquireWithState (call request : Json) : Prog (Json × Bool) := do
  if !(← persistent call request) then
    let opts ← createOptions call request false
    return (← create call opts, true)
  let key ← Prog.effect "sandboxReservationKey" [request]
  let reserved ← Prog.effect "getSandboxReservationRecord" [toJson "sandbox", key]
  let expired ← if same reserved Json.null then pure false else do
    let lifecycle ← Prog.effect "resolveSandboxLifecycle" [field (config call) "lifecycle"]
    pure (truthy (← Prog.effect "outlivedMaxLifetime" [lifecycle, field reserved "claimedAt"]))
  if expired then
    let _ ← Prog.effect "this.release" [releaseRequest key (field reserved "externalId")]
  let externalId := if expired || same reserved Json.null then Json.null else field reserved "externalId"
  if truthy externalId then
    if let some reservation ← reuseReserved call request key externalId then
      return reservation
  createAndClaim call request key

/-- `#runLifecycle`. -/
private def runLifecycle (call : Json) (dir : String) : Prog Unit := do
  let script ← Prog.effect "lifecycleScript"
    [toJson dir, field (config call) "onCreate", field (config call) "onResume"]
  if !truthy script then return ()
  let result ← Prog.effect "sandbox.exec" [script]
  if !same (field result "exit_code") (toJson (0 : Nat)) then
    let stderr := field result "stderr"
    let stdout := field result "stdout"
    Prog.throwError "Error"
      (if truthy stderr then str stderr else if truthy stdout then str stdout
       else "workdir lifecycle hook failed")

private def floorSeconds (now : Json) : Prog Int :=
  match asInt now with
  | some ms => pure (ms / 1000)
  | none => Prog.unsupported "a clock that is not an integer"

/-- `#mountS3`. -/
private def mountS3 (call request mount : Json) : Prog Unit := do
  if !truthy (field mount "credentials") then
    Prog.throwError "Error" "workdir S3 assume-role mount resolved no credentials"
  let path ← mountPath call request
  let flag (name value : String) (keep : Bool) : List String := if keep then [name, value] else []
  let parts : List String :=
    [str (field mount "bucket"), path] ++
    flag "--prefix" (str (field mount "prefix")) (truthy (field mount "prefix")) ++
    ["--allow-delete", "--allow-overwrite"] ++
    flag "--region" (str (field mount "region")) (truthy (field mount "region")) ++
    flag "--endpoint-url" (str (field mount "endpoint")) (truthy (field mount "endpoint"))
  let mountArgs := " ".intercalate (parts.map shellQuoted)
  let quotedPath ← Prog.effect "shellQuote" [toJson path]
  let now ← floorSeconds (← Prog.effect "Date.now")
  let fresh ← Prog.effect "freshMountScript" [toJson path, toJson now]
  let quoted := str quotedPath
  let script := "\n".intercalate
    [s!"if ! \{ {str fresh}; }; then",
     s!"fusermount -u {quoted} 2>/dev/null || umount -l {quoted} 2>/dev/null;",
     s!"mkdir -p {quoted} && mount-s3 {mountArgs} && echo {now} > \"$stamp_file\";",
     "fi"]
  let credentials := match field mount "credentials" with
    | .obj entries => entries.toList
    | _ => []
  let region := field mount "region"
  let env := Json.mkObj (credentials ++ [("AWS_EC2_METADATA_DISABLED", toJson "true")] ++
    (if truthy region then [("AWS_REGION", region), ("AWS_DEFAULT_REGION", region)] else []))
  let result ← Prog.effect "sandbox.exec" [toJson script, Json.mkObj [("env", env)]]
  if !same (field result "exit_code") (toJson (0 : Nat)) then
    let stderr := field result "stderr"
    let stdout := field result "stdout"
    Prog.throwError "Error"
      (if truthy stderr then str stderr else if truthy stdout then str stdout
       else "workdir S3 workspace mount failed")

/-- `#ensureS3Mount`. `minted` is the outcome of a mount resolved before the sandbox existed. -/
private def ensureS3Mount (call request : Json) (isFirstCreate : Bool) (minted : Option Outcome) :
    Prog Unit := do
  let context ← Prog.effect "executorS3Context" [config call, request]
  if !isFirstCreate then
    let path ← mountPath call request
    let now ← floorSeconds (← Prog.effect "Date.now")
    let script ← Prog.effect "freshMountScript" [toJson path, toJson now]
    let check ← Prog.effect "sandbox.exec" [script]
    if same (field check "exit_code") (toJson (0 : Nat)) then return ()
  let mount ← match minted with
    | some (.ok value) => pure value
    | some (.threw error _) => Prog.fail error
    | some .pending => Prog.unsupported "a mount that never resolved"
    | none => Prog.effect "resolveS3Mount" [context]
  mountS3 call request mount

/-- The `finally` of `run`: an ephemeral sandbox is deleted off the tool's clock. -/
private def deleteEphemeral (isPersistent : Bool) : Prog Unit := do
  if !isPersistent then
    Prog.spawn "sandbox.delete"
    Prog.spawn "waitUntil" [promiseRef]

/-- The command itself, with the timeout workdir's API does not carry. -/
private def runCommand (call request sandbox : Json) (startedAt : Int) : Prog Json := do
  let cwd : Option Json ← if truthy (field request "namespace") then do
      let root ← workspaceRoot call
      some <$> Prog.effect "workspacePath" [request, root]
    else pure none
  let quoted ← Prog.effect "shellQuote" [field request "code"]
  let env ← Prog.effect "mergeSandboxEnv"
    [field (config call) "envVars", field request "envVars", field request "principal"]
  let timeout := (field request "timeoutSeconds").compress
  let result ← Prog.effect "sandbox.exec"
    [toJson s!"timeout -k 5 {timeout} bash -c {str quoted}",
     objWhen [("cwd", cwd.getD undef, cwd.isSome), ("env", env, true)]]
  let limit := field request "outputLimitBytes"
  let stdout ← Prog.effect "truncateText" [orElse (field result "stdout") (toJson ""), limit]
  let stderr ← Prog.effect "truncateText" [orElse (field result "stderr") (toJson ""), limit]
  let finished ← Prog.effect "Date.now"
  let exitCode := field result "exit_code"
  let duration ← match asInt finished with
    | some now => pure (now - startedAt)
    | none => Prog.unsupported "a clock that is not an integer"
  return Json.mkObj
    [("ok", toJson (same exitCode (toJson (0 : Nat)))),
     ("runtime", orElse (field request "runtime") (toJson "bash")),
     ("exitCode", exitCode),
     ("stdout", field stdout "value"),
     ("stderr", field stderr "value"),
     ("durationMs", toJson duration),
     ("truncated", toJson (truthy (field stdout "truncated") || truthy (field stderr "truncated"))),
     ("timedOut", toJson (same exitCode (toJson (124 : Nat)) || same exitCode (toJson (137 : Nat)))),
     ("provider", toJson "sandbox")]

/-- Handles the metering callback, which reads the configured specs. -/
private def meterCallback (call : Json) (label : String) (_args : Json) : Prog Unit :=
  match label with
  | "arg4" => do
    let _ ← Prog.effect "configuredSandboxSpecs" [config call]
    pure ()
  | other => Prog.unsupported s!"callback {other}"

/-- The part of `run` guarded by its `finally`. -/
private def runGuarded (call request sandbox : Json) (isPersistent isFirstCreate execMount : Bool)
    (minted : Option Outcome) (startedAt : Int) : Prog Json := do
  if execMount then ensureS3Mount call request isFirstCreate minted
  if isPersistent then
    let key ← Prog.effect "sandboxReservationKey" [request]
    runLifecycle call (← workDir call key)
  runCommand call request sandbox startedAt

private def isUndefinedOutcome : Outcome → Bool
  | .ok value => isUndef value
  | _ => false

/-- An ephemeral exec mount is resolved unawaited, so everything up to the create overlaps it and
must be asked for at once. The create's options depend on those answers, so this covers a config
with none of them set and checks the answers agree. -/
private def mintAndCreate (call request : Json) : Prog (Outcome × Json) := do
  let cfg := config call
  let opts := options call
  let context ← Prog.effect "executorS3Context" [cfg, request]
  let storage := field cfg "storage"
  let roleCheck : List (String × List Json) :=
    if same (field (field storage "auth") "type") (toJson "r2") then [] else [("mountRoleArn", [storage])]
  let createOpts := objWhen
    [("docker", Json.mkObj [("enabled", toJson true)], isTrue (field opts "docker"))]
  let settled ← Prog.all ([("resolveS3Mount", [context])] ++ roleCheck ++
    [("workdirNetwork", [field cfg "network"]),
     ("configString", [field cfg "snapshot"]),
     ("workdirResources", [cfg]),
     ("configString", [field opts "imageVersion"]),
     ("assertSnapshotBootable", [field cfg "controlPlane", undef]),
     ("this.#client.sandboxes.create", [createOpts])])
  match settled.head?, settled.getLast? with
  | some minted, some created =>
    let unset := (settled.drop (1 + roleCheck.length)).dropLast.take 4
    if !unset.all isUndefinedOutcome then
      Prog.unsupported "an ephemeral exec mount with image or network options"
    return (minted, ← createOutcome created)
  | _, _ => Prog.unsupported "no answers"

/-- `WorkdirSandboxExecutor.run`. -/
def workdirRun (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let startedAt ← match asInt (← Prog.effect "Date.now") with
    | some now => pure now
    | none => Prog.unsupported "a clock that is not an integer"
  let isPersistent ← persistent call request
  let execMount := (← mountStrategy call request) == "exec"
  let early ← if execMount && !isPersistent then some <$> mintAndCreate call request else pure none
  let minted := early.map (·.1)
  let (sandbox, isFirstCreate) ← match early with
    | some (_, created) => pure (created, true)
    | none => acquireWithState call request
  if !isPersistent then
    Prog.drain (meterCallback call) 2
    let _ ← Prog.effect "meterEphemeralSandbox"
      [field (config call) "controlPlane", toJson "sandbox", sandboxId sandbox, metadataOf request, fnRef]
  let attempt := runGuarded call request sandbox isPersistent isFirstCreate execMount minted startedAt
  let result ← tryCatch attempt fun error => do
    deleteEphemeral isPersistent
    Prog.fail error
  deleteEphemeral isPersistent
  return result

/-- `#requirePersistent`. -/
private def requirePersistent (call request : Json) : Prog Json := do
  if !(← persistent call request) then
    Prog.throwError "Error" "background jobs require a persistent workdir sandbox reservation key"
  Prog.effect "sandboxReservationKey" [request]

/-- `WorkdirSandboxExecutor.runBackground`. -/
def workdirRunBackground (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let key ← requirePersistent call request
  let (sandbox, isFirstCreate) ← acquireWithState call request
  if (← mountStrategy call request) == "exec" then
    ensureS3Mount call request isFirstCreate none
  runLifecycle call (← workDir call key)
  let jobId ← if isNullish (field request "jobId") then Prog.effect "generateJobId"
    else pure (field request "jobId")
  let jobsDir := s!"{str (← workspaceRoot call)}/.fp-jobs/{str key}"
  let dir ← workDir call key
  let callback := field request "callback"
  let script ← Prog.effect "launchScript"
    [toJson jobsDir, jobId, toJson dir, field request "code",
     objWhen [("maxConcurrentJobs", toJson (10 : Nat), true),
              ("callback", callback, truthy callback)]]
  let merged ← Prog.effect "mergeSandboxEnv" [field (config call) "envVars", field request "envVars"]
  let callbackVars ← Prog.effect "callbackEnv" [callback]
  let entries (value : Json) : List (String × Json) :=
    match value with
    | .obj items => items.toList
    | _ => []
  let keep := (entries merged).filter fun item => !(entries callbackVars).any (·.1 == item.1)
  let result ← Prog.effect "sandbox.exec"
    [script, Json.mkObj [("env", Json.mkObj (keep ++ entries callbackVars))]]
  if !same (field result "exit_code") (toJson (0 : Nat)) then
    let stderr := field result "stderr"
    let stdout := field result "stdout"
    Prog.throwError "Error"
      (if truthy stderr then str stderr else if truthy stdout then str stdout
       else "failed to launch background job")
  return Json.mkObj [("jobId", jobId), ("externalId", sandboxId sandbox)]

/-- `WorkdirSandboxExecutor.acquireHarnessReservation`. A signal needs recorded aborts it lacks. -/
def workdirAcquireHarness (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  if !isUndef (field request "abortSignal") then Prog.unsupported "an abort signal"
  if !(← persistent call request) then
    Prog.throwError "Error" "Harness sessions require a persistent workdir sandbox reservation key"
  let (sandbox, isFirstCreate) ← acquireWithState call request
  let setup : Prog Unit := do runLifecycle call (← workDir call (field request "reservationKey"))
  tryCatch setup fun error => do
    if (error.getObjVal? "$unsupported").toOption.isSome then Prog.fail error
    if isFirstCreate && !isTrue (field request "shared") then
      let _ ← Prog.attempt "this.release" [request]
    Prog.fail error
  return Json.mkObj [("sandbox", sandbox), ("isFirstCreate", toJson isFirstCreate)]

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/sandbox/workdir-executor.ts#WorkdirSandboxExecutor.run" workdirRun,
   Twin.traced "apps/core/src/harness/sandbox/workdir-executor.ts#WorkdirSandboxExecutor.runBackground" workdirRunBackground,
   Twin.traced "apps/core/src/harness/sandbox/workdir-executor.ts#WorkdirSandboxExecutor.acquireHarnessReservation" workdirAcquireHarness]

end Spec.Sandbox.Wavesandbox8a
