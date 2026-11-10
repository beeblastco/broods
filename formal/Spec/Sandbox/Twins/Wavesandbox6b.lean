import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign6/sandbox6b.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox6b

open Lean Spec

private def machine : String := "apps/core/src/harness/sandbox/machine-executor.ts#"
private def undef : Json := Twin.undefinedJson

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def same (a b : Json) : Bool := a.compress == b.compress

private def isUndef (value : Json) : Bool := same value undef

private def truthy (value : Json) : Bool :=
  match value with
  | .null | .bool false => false
  | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def isTrue (value : Json) : Bool := same value (toJson true)

private def fnRef (name : String := "") : Json := Json.mkObj [("$fn", toJson name)]

private def asInt (value : Json) : Option Int := value.getInt?.toOption

/-- `undefined` in an object is dropped by `JSON.stringify`, and is `null` in an array. -/
private def dropUndefined : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .arr items => .arr (items.map fun item =>
        if isUndef item then .null else dropUndefined fuel item)
    | .obj kvs =>
      Json.mkObj (kvs.toList.filterMap fun (key, item) =>
        if isUndef item then none else some (key, dropUndefined fuel item))
    | other => other

private def stringify (value : Json) : String :=
  Twin.jsonStringify 64 (dropUndefined 64 value)

/-- Looks a key up in a recorded `Map`. -/
private def mapGet (map : Json) (key : String) : Option Json :=
  match field map "$map" with
  | .arr entries =>
    (entries.toList.find? fun entry => same (Twin.arg entry 0) (toJson key)).map (Twin.arg · 1)
  | _ => none

private def mapValues (map : Json) : List Json :=
  match field map "$map" with
  | .arr entries => entries.toList.map (Twin.arg · 1)
  | _ => []

private def socketData (socket : Json) : Json := Twin.field socket "data"

private def closeUnauthorized : List Json := [toJson (4401 : Nat), toJson "Unauthorized; run broods login"]

private def closeExpired : List Json := [toJson (4419 : Nat), toJson "Credential expired"]

/-- `sendReady`. -/
def sendReady (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let expiresAt := field (socketData socket) "expiresAt"
  let base : List (String × Json) :=
    [("type", toJson "ready"), ("sandboxId", Twin.callArg call 1)]
  let extra : List (String × Json) ← if isUndef expiresAt then pure [] else do
    let now ← Prog.effect "Date.now"
    match asInt expiresAt, asInt now with
    | some expires, some current => pure [("expiresInMs", toJson (expires - current))]
    | _, _ => Prog.unsupported "a clock that is not an integer"
  let frame := Json.mkObj
    (base ++ extra ++ [("$keys", toJson ((base ++ extra).map (·.1)))])
  let _ ← Prog.effect "socket.send" [toJson (stringify frame)]
  return undef

/-- `armExpiry`. -/
def armExpiry (call : Json) : Prog Json := do
  let data := socketData (Twin.callArg call 0)
  let expiresAt := field data "expiresAt"
  if isUndef expiresAt then return undef
  let _ ← Prog.effect "clearTimeout" [field data "expiry"]
  let now ← Prog.effect "Date.now"
  match asInt expiresAt, asInt now with
  | some expires, some current =>
    let _ ← Prog.effect "setTimeout" [fnRef, toJson (expires - current)]
    return undef
  | _, _ => Prog.unsupported "a clock that is not an integer"

/-- `revalidate`. `closed` is read as the code read it, after the lookup. The other `socket.data`
fields are as they stood at entry, so a credential refreshed during the lookup is not modelled. -/
def revalidate (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let data := socketData socket
  let storedAuth := field data "authorization"
  let authorization := if isUndef storedAuth then toJson "" else storedAuth
  match ← Prog.attempt "resolveBearerAuth" [Json.mkObj [("authorization", authorization)]] with
  | .pending => Prog.unsupported "the lookup never finished"
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    return undef
  | .ok auth =>
    if Twin.abortedRead call 0 then return undef
    let claim := field data "claim"
    let kind := field auth "kind"
    let accountMatches :=
      truthy auth && !same kind (toJson "admin") &&
      same (field (field auth "account") "accountId") (field data "accountId")
    let allowed ←
      if !accountMatches then pure false
      else if !same kind (toJson "role") || isUndef claim then pure true
      else do
        let principal ← Prog.effect "rolePrincipal" [field auth "role"]
        let verdict ← Prog.effect "authorize" [principal, toJson "sandboxes:write", claim]
        pure (truthy (field verdict "allow"))
    if allowed then return undef
    let expiresAt := field data "expiresAt"
    let expired ←
      if isUndef expiresAt then pure false else do
        let now ← Prog.effect "Date.now"
        pure (match asInt expiresAt, asInt now with
          | some expires, some current => expires <= current
          | _, _ => false)
    let _ ← Prog.effect "socket.close" (if expired then closeExpired else closeUnauthorized)
    return undef

private def setKey (value : Json) (name : String) (item : Json) : Json :=
  match value with
  | .obj kvs => .obj (kvs.insert name item)
  | other => other

/-- `socket` once `socket.data` holds this credential. -/
private def withCredential (socket authorization expiresAt : Json) : Json :=
  let fields := field socket "$fields"
  let data := setKey (setKey (field fields "data") "authorization" authorization) "expiresAt" expiresAt
  setKey socket "$fields" (setKey fields "data" data)

/-- `refreshCredential`. `closed` is read after the lookup; other fields as at entry, see `revalidate`. -/
def refreshCredential (call : Json) : Prog Json := do
  let socket := Twin.callArg call 0
  let data := socketData socket
  let authorization := match Twin.callArg call 1 with
    | .str token => toJson s!"Bearer {token}"
    | _ => undef
  match ← Prog.attempt "resolveBearerAuth" [Json.mkObj [("authorization", authorization)]] with
  | .pending => Prog.unsupported "the lookup never finished"
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    return undef
  | .ok auth =>
    if Twin.abortedRead call 0 then return undef
    let ticket :=
      if same (field auth "kind") (toJson "deployment") &&
          same (field (field auth "account") "accountId") (field data "accountId")
      then field auth "stageTicket" else undef
    let stage := field data "stage"
    let expiresAt := field data "expiresAt"
    if isUndef expiresAt || !isTrue (field ticket "sandboxWrite") ||
        !same (field ticket "projectId") (field stage "projectId") ||
        !same (field ticket "stageId") (field stage "stageId") then
      let _ ← Prog.effect "socket.close" closeUnauthorized
      let connections := Twin.moduleValue call "connections"
      let entries := (field connections "$map").getArr?.toOption.getD #[]
      let key := field data "key"
      let remaining := entries.filter fun entry => Twin.arg entry 0 != key
      if remaining.size != entries.size then
        Prog.setState "module.connections" (Json.mkObj [("$map", Json.arr remaining)])
      return undef
    match asInt (field ticket "expiresAt"), asInt expiresAt with
    | some fresh, some held =>
      if fresh <= held then return undef
      Prog.setChanged "args.0.data.authorization" (field data "authorization") authorization
      Prog.setChanged "args.0.data.expiresAt" expiresAt (field ticket "expiresAt")
      let table := Twin.moduleValue call "connections"
      let hasSocket (entry : Json) : Bool := same (field (Twin.arg entry 1) "socket") socket
      let rows := (field table "$map").getArr?.toOption.getD #[]
      if rows.any hasSocket then
        let updated := rows.map fun entry =>
          if hasSocket entry then
            .arr #[Twin.arg entry 0, setKey (Twin.arg entry 1) "socket"
              (withCredential socket authorization (field ticket "expiresAt"))]
          else entry
        Prog.setState "module.connections" (Json.mkObj [("$map", .arr updated)])
      let _ ← Prog.effect "armExpiry" [socket]
      let key := field data "key"
      let connection := match key with
        | .str name => mapGet (Twin.moduleValue call "connections") name
        | _ => none
      match connection with
      | some entry =>
        if same (field entry "socket") socket then
          let _ ← Prog.effect "sendReady" [socket, field (field entry "ref") "sandboxConfigId"]
        return undef
      | none => return undef
    | _, _ => Prog.unsupported "an expiry that is not an integer"

/-- `sendHeartbeats`. -/
def sendHeartbeats (call : Json) : Prog Json := do
  for connection in mapValues (Twin.moduleValue call "connections") do
    let _ ← Prog.effect "mirrorConnection" [fnRef]
    Prog.spawn "revalidate" [field connection "socket"]
  return undef

private def mapEntries (map : Json) : List (String × Json) :=
  match field map "$map" with
  | .arr pairs => pairs.toList.filterMap fun pair =>
    match Twin.arg pair 0 with
    | .str key => some (key, Twin.arg pair 1)
    | _ => none
  | _ => []

private def mapJson (entries : List (String × Json)) : Json :=
  Json.mkObj [("$map", .arr (entries.map fun (key, value) =>
    Json.arr #[toJson key, value]).toArray)]

/-- `readTargetCache.set`: a key already present keeps its place. States only a visible change. -/
private def noteReadTarget (cache : Json) (key : String) (target staleAt : Json) : Prog Unit := do
  let promise := Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [("$resolved", target)])]
  let entry := Json.mkObj [("target", promise), ("staleAt", staleAt)]
  let entries := mapEntries cache
  match entries.find? (·.1 == key) with
  | some (_, old) =>
    if !same (field old "staleAt") staleAt || !same (Twin.resolved (field old "target")) target then
      Prog.setState "module.readTargetCache"
        (mapJson (entries.map fun item => if item.1 == key then (key, entry) else item))
  | none => Prog.setState "module.readTargetCache" (mapJson (entries ++ [(key, entry)]))

/-- The `pending.catch` that drops a rejected lookup from the cache. -/
private def forgetReadTarget (cache : Json) (key : String) : Prog Unit := do
  let entries := mapEntries cache
  if entries.any (·.1 == key) then
    Prog.setState "module.readTargetCache" (mapJson (entries.filter (·.1 != key)))

/-- `resolveS3ReadTarget`. A cached target is read from the module's cache as it stood at entry. -/
def resolveS3ReadTarget (call : Json) : Prog Json := do
  let ctx := Twin.callArg call 0
  let storage := field ctx "storage"
  if same (field storage "provider") (toJson "disk") then
    Prog.throwError "Error" "A disk workspace has no bucket; its files live on its sandbox"
  let identity ← Prog.effect "resolveS3MountIdentity" [ctx]
  if !truthy (field storage "bucket") then
    return Json.mkObj [("bucket", field identity "bucket"), ("prefix", field identity "prefix")]
  let keyParts := [field storage "auth", field storage "owner", field identity "bucket",
    field identity "prefix", field identity "region", field identity "endpoint"]
  let cacheKey := stringify (.arr keyParts.toArray)
  let cached : Option Json ←
    match mapGet (Twin.moduleValue call "readTargetCache") cacheKey with
    | none => pure none
    | some entry => do
      let now ← Prog.effect "Date.now"
      let staleAt := field entry "staleAt"
      let fresh := same (field staleAt "$number") (toJson "Infinity") ||
        (match asInt staleAt, asInt now with
          | some stale, some current => stale > current
          | _, _ => false)
      if !fresh then pure none else
        let target := Twin.resolved (field entry "target")
        if isUndef target then Prog.unsupported "a cached target that had not resolved"
        else pure (some target)
  if let some target := cached then
    if !truthy (← Prog.effect "nearsExpiry" [target]) then return target
  let cache := Twin.moduleValue call "readTargetCache"
  if same (field (field storage "auth") "type") (toJson "r2") then
    match ← Prog.all [("readTargetFromMount", [ctx]), ("Date.now", [])] with
    | [.ok target, .ok now] =>
      let staleAt := match asInt now with
        | some current => toJson (current + 60 * 1000)
        | none => undef
      noteReadTarget cache cacheKey target staleAt
      return target
    | [.threw error _, _] =>
      forgetReadTarget cache cacheKey
      Prog.fail error
    | _ => Prog.unsupported "the mount lookup never finished"
  match ← Prog.attempt "readTargetFromMount" [ctx] with
  | .ok target =>
    noteReadTarget cache cacheKey target (Json.mkObj [("$number", toJson "Infinity")])
    return target
  | .threw error _ =>
    forgetReadTarget cache cacheKey
    Prog.fail error
  | .pending => Prog.unsupported "the mount lookup never finished"

/-- `meterEphemeralSandbox`. Specs only feed writes queued as closures, so their value is not read. -/
def meterEphemeralSandbox (call : Json) : Prog Json := do
  let plane := Twin.callArg call 0
  let accountId := if truthy (field plane "ownCredentials") then undef else field plane "accountId"
  if !truthy accountId then return fnRef
  if !isUndef (Twin.callArg call 4) then Prog.spawn "readSpecs"
  Prog.spawn "queueMirrorWrite" [Twin.callArg call 2, fnRef]
  return fnRef

/-- `MAX_TIMEOUT_MS` in `apps/cloudflare-sandbox/src/limits.ts`. -/
private def maxTimeoutMs : Int := 15 * 60 * 1000

/-- `MAX_OUTPUT_BYTES` in `apps/cloudflare-sandbox/src/limits.ts`. -/
private def maxOutputBytes : Int := 1024 * 1024

/-- `CLOUDFLARE_INSTANCE_TYPES[size].name`. -/
private def cloudflareInstance : String → Option String
  | "tiny" | "xsmall" => some "standard-1"
  | "small" => some "standard-2"
  | "medium" => some "standard-3"
  | "large" => some "standard-4"
  | _ => none

private def cloudflareLabel : String := "cloudflare sandbox bridge"

private def runInCwd : String :=
  "mkdir -p -- \"$1\" && cd -- \"$1\" && exec bash -lc \"$2\" bash \"${@:3}\""

private def bridgeExec (config request id : Json) (workspace : Json) (reserved : Bool) :
    Prog Json := do
  let timeoutMs : Int := match asInt (field request "timeoutSeconds") with
    | some seconds => min (seconds * 1000) maxTimeoutMs
    | none => 0
  if timeoutMs == 0 then Prog.unsupported "a fractional or missing timeout"
  let connection ← Prog.effect "cloudflareConnection"
  let env ← Prog.effect "mergeSandboxEnv"
    [field config "envVars", (Json.mkObj (if field request "principal" == Twin.undefinedJson then [] else [("principal", field request "principal")]))]
  let idle ←
    if reserved then do
      let lifecycle ← Prog.effect "resolveSandboxLifecycle" [field config "lifecycle"]
      pure (field lifecycle "idleTimeoutSeconds")
    else pure (toJson (timeoutMs / 1000 + (if timeoutMs % 1000 == 0 then 0 else 1) + 60))
  let argv := Json.arr
    #[toJson "bash", toJson "-c", toJson runInCwd, toJson "bash", workspace, field request "code"]
  let outputLimit : Int := match asInt (field request "outputLimitBytes") with
    | some limit => min limit maxOutputBytes
    | none => 0
  let size := match field config "size" with
    | .str name => name
    | _ => "xsmall"
  let instanceName ← match cloudflareInstance size with
    | some name => pure name
    | none => Prog.unsupported "an unknown size"
  let response ← Prog.effect "callPlatformWorker"
    [connection, toJson cloudflareLabel,
     toJson s!"/v1/sandboxes/{id.getStr?.toOption.getD ""}/exec", toJson "POST",
     Json.mkObj
       [("argv", argv), ("env", env), ("timeoutMs", toJson timeoutMs),
        ("outputLimitBytes", toJson outputLimit), ("idleTimeoutSeconds", idle),
        ("enableInternet", toJson (same (field (field config "network") "mode") (toJson "allow-all"))),
        ("instance", toJson instanceName)],
     toJson (timeoutMs + 60000)]
  let _ := response
  let text ← Prog.effect "response.text"
  Prog.effect "parseExecResponse" [text, toJson cloudflareLabel]

/-- `CloudflareSandboxExecutor.run`. -/
def cloudflareRun (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let config := Twin.field (Twin.self call) "#config"
  let plane := field config "controlPlane"
  let startedAt ← Prog.effect "Date.now"
  let key ← Prog.effect "sandboxReservationKey" [request]
  let reserved ←
    if isTrue (field config "persistent") && !isUndef key then
      Prog.effect "reservePlatformSandbox" [toJson "cloudflare", field plane "accountId", key]
    else pure undef
  let isReserved := truthy reserved
  let id ←
    if isReserved then pure reserved else do
      let uuid ← Prog.effect "crypto.randomUUID"
      pure (toJson s!"fp-e-{uuid.getStr?.toOption.getD ""}")
  if !isReserved then
    Prog.drain (fun label _ =>
      if label == "arg4" then do
        let _ ← Prog.effect "configuredSandboxSpecs" [config]
      else Prog.unsupported s!"callback {label}") 4
    let _ ← Prog.effect "meterEphemeralSandbox"
      [plane, toJson "cloudflare", id, field request "metadata", fnRef]
  let destroy : Prog Unit :=
    if isReserved then pure () else do
      let connection ← Prog.effect "cloudflareConnection"
      Prog.spawn "callPlatformWorker"
        [connection, toJson cloudflareLabel,
         toJson s!"/v1/sandboxes/{id.getStr?.toOption.getD ""}", toJson "DELETE"]
      let _ ← Prog.effect "waitUntil" [Json.mkObj [("$opaque", toJson "Promise")]]
  let outcome : Except Json Json ← Prog.catchFail
    (do
      let workspace ← Prog.effect "requiredWorkspacePath" [request, toJson "/workspace"]
      let response ← bridgeExec config request id workspace isReserved
      if isReserved && truthy key then
        Prog.spawn "queueMirrorWrite" [id, fnRef]
      let result ← Prog.effect "execRunResult"
        [request, response, toJson "cloudflare", startedAt]
      Prog.drain (fun label _ =>
        if label == "arg1" then do
          let specs ← Prog.effect "configuredSandboxSpecs" [config]
          Prog.spawn "upsertSandboxInstance"
            [plane, toJson "cloudflare", key, id, field request "metadata",
             Json.mkObj (if isUndef specs then [] else [("specs", specs)])]
        else Prog.unsupported s!"callback {label}") 4
      pure (Except.ok result))
    (fun error => pure (Except.error error))
  destroy
  match outcome with
  | .ok result => return result
  | .error error => Prog.fail error

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (machine ++ "sendReady") sendReady,
   Twin.traced (machine ++ "armExpiry") armExpiry,
   Twin.traced (machine ++ "revalidate") revalidate,
   Twin.traced (machine ++ "refreshCredential") refreshCredential,
   Twin.traced (machine ++ "sendHeartbeats") sendHeartbeats,
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#resolveS3ReadTarget" resolveS3ReadTarget,
   Twin.traced "apps/core/src/harness/sandbox/utils.ts#meterEphemeralSandbox" meterEphemeralSandbox,
   Twin.traced "apps/core/src/harness/sandbox/cloudflare-executor.ts#CloudflareSandboxExecutor.run"
     cloudflareRun]

end Spec.Sandbox.Wavesandbox6b
