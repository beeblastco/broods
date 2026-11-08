import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign5/sandbox5a.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox5a

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def isUndefined (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

/-- JavaScript truthiness of a recorded value. -/
private def truthy (value : Json) : Bool :=
  if isUndefined value then false else
    match value with
    | .null => false
    | .bool item => item
    | .str item => !item.isEmpty
    | .num item => item.mantissa != 0
    | _ => true

/-- `{ ...base, ...entries }`. The recorder drops a key whose value is `undefined`. -/
private def spread (base : Json) (entries : List (String × Json)) : Json :=
  let present := entries.filter fun (_, item) => !isUndefined item
  match base with
  | .obj kvs => .obj (present.foldl (fun acc (key, item) => acc.insert key item) kvs)
  | _ => Json.mkObj present

private def stringOf (value : Json) : String :=
  (value.getStr?).toOption.getD ""

/-- A sandbox `loadSandbox` has read: its stored record and its config with a control plane. -/
private abbrev Loaded := Json × Json

private abbrev SandboxCache := List (String × Loaded)

/-- `loadSandbox`: at most one read per id, cached with what it resolved to. -/
private def loadSandbox (accountId : Json) (cache : SandboxCache) (sandboxId : String) :
    Prog (Loaded × SandboxCache) := do
  if !truthy accountId then
    Prog.throwError "Error" "Cannot resolve sandbox reference without an account"
  match cache.lookup sandboxId with
  | some loaded => return (loaded, cache)
  | none =>
    let record ← Prog.effect "storage.sandboxConfigs .getById" [accountId, toJson sandboxId]
    if !truthy record then
      Prog.throwError "Error" s!"Referenced sandbox not found: {sandboxId}"
    let config := field record "config"
    let options := field config "options"
    let _ ← Prog.effect "assertNoRetiredImageOptions"
      [field config "provider", if isUndefined options || options == .null then Json.mkObj [] else options]
    let controlPlane ← Prog.effect "sandboxControlPlane" [accountId, record]
    let loaded : Loaded := (record, spread config [("controlPlane", controlPlane)])
    return (loaded, (sandboxId, loaded) :: cache)

/-- One entry of `loadWorkspaces`' loop. -/
private def loadWorkspace (accountId agentId scope : Json) (fallback : Option Json) (ref : Json)
    (cache : SandboxCache) : Prog (Json × SandboxCache) := do
  if !truthy accountId then
    Prog.throwError "Error" "Cannot resolve workspace reference without an account"
  let name := field ref "name"
  let workspaceId := field ref "workspaceId"
  let record ← Prog.effect "storage.workspaceConfigs.getById" [accountId, workspaceId]
  if !truthy record then
    Prog.throwError "Error"
      s!"Referenced workspace not found: {stringOf workspaceId} (as \"{stringOf name}\")"
  let chosen := field ref "sandbox"
  let (effective, cache) ← match chosen with
    | .null => pure (none, cache)
    | .str id =>
      if id.isEmpty then pure (fallback, cache)
      else do
        let (loaded, cache) ← loadSandbox accountId cache id
        pure (some loaded.2, cache)
    | _ => pure (fallback, cache)
  let config := field record "config"
  let storage := field config "storage"
  let ownBucket := truthy (field storage "bucket")
  let onDisk := (field storage "provider").compress == (toJson "disk").compress
  let _ ← Prog.effect "assertSandboxReachesWorkspace"
    [name, effective.getD Twin.undefinedJson, toJson ownBucket, toJson onDisk]
  let readMount :=
    effective.isNone && chosen != .null && !ownBucket
  let wsNamespace ← Prog.effect "workspaceNamespace" [accountId, workspaceId]
  let isolated ← Prog.effect "isolatedWorkspaceNamespace"
    [wsNamespace, field config "isolation", spread scope [("agentId", agentId)]]
  let description := field record "description"
  let entries : List (String × Json) :=
    [("name", name), ("workspaceId", workspaceId), ("namespace", isolated), ("config", config)] ++
    (if truthy description then [("description", description)] else []) ++
    (match effective with
      | some sandbox =>
        [("sandbox",
          if truthy storage && !onDisk then spread sandbox [("storage", storage)] else sandbox)]
      | none => []) ++
    (if readMount then
      [("readMount", Json.mkObj
        [("provider", toJson "lambda"), ("network", Json.mkObj [("mode", toJson "deny-all")])])]
     else [])
  return (Json.mkObj entries, cache)

private def loadWorkspaces (accountId agentId scope : Json) (fallback : Option Json) :
    List Json → SandboxCache → Prog (List Json)
  | [], _ => pure []
  | ref :: rest, cache => do
    let (workspace, cache) ← loadWorkspace accountId agentId scope fallback ref cache
    let others ← loadWorkspaces accountId agentId scope fallback rest cache
    return workspace :: others

private def jsonList (value : Json) : List Json :=
  match value with
  | .arr items => items.toList
  | _ => []

private def agentSandbox (accountId agentId scope : Json) (sandboxId : String) (loaded : Loaded) :
    Prog Json := do
  let record := loaded.1
  let sandbox ← Prog.effect "reservedAgentSandbox"
    [loaded.2, accountId, agentId, toJson sandboxId, field scope "userConversationKey"]
  let description := field record "description"
  return spread (Json.mkObj [])
    ([("name", field record "name")] ++
     (if truthy description then [("description", description)] else []) ++
     [("sandbox", sandbox)])

/-- `resolveAgentRuntime`. Sandboxes load concurrently, and two distinct ones interleave their
reads with validation that needs the answers, which one overlap group cannot express. -/
def resolveAgentRuntime (call : Json) : Prog Json := do
  let agentConfig := Twin.callArg call 0
  let identity := Twin.callArg call 1
  let accountId := field identity "accountId"
  let agentId := field identity "agentId"
  let rawScope := Twin.callArg call 2
  let scope := if isUndefined rawScope then Json.mkObj [] else rawScope
  let _ ← Prog.effect "getStorage"
  let sandboxIds := (jsonList (field agentConfig "sandboxes")).map stringOf
  if sandboxIds.eraseDups.length > 1 then
    Prog.unsupported "several distinct sandboxes load concurrently"
  let (sandboxes, fallback, cache) ← match sandboxIds with
    | [] => pure ([], none, [])
    | first :: _ => do
      let (loaded, cache) ← loadSandbox accountId [] first
      let sandboxes ← sandboxIds.mapM fun id => agentSandbox accountId agentId scope id loaded
      pure (sandboxes, some loaded.2, cache)
  let workspaces ←
    loadWorkspaces accountId agentId scope fallback (jsonList (field agentConfig "workspaces")) cache
  let _ ← Prog.effect "assertDistinctSandboxNames" [.arr sandboxes.toArray]
  return Json.mkObj
    [("sandboxes", .arr sandboxes.toArray), ("workspaces", .arr workspaces.toArray)]

private def fnValue : Json := Json.mkObj [("$fn", toJson "")]

private def isNullish (value : Json) : Bool :=
  isUndefined value || value == .null

private def orElse (value fallback : Json) : Json :=
  if isNullish value then fallback else value

private def isEmptyObject (value : Json) : Bool :=
  match value with
  | .obj kvs => kvs.isEmpty
  | _ => false

/-- `#create`: a runner shortage becomes a capacity error, anything else passes through. -/
private def daytonaCreate (config options : Json) : Prog Json := do
  match ← Prog.attempt "client.create" [options] with
  | .ok sandbox => return sandbox
  | .threw error _ =>
    let noRunners ← Prog.effect "isNoRunnersError" [error]
    if !truthy noRunners then throw error
    let snapshot := field config "snapshot"
    let subject := if truthy snapshot then s!"snapshot '{stringOf snapshot}'" else "the request"
    let capacity ← Prog.effect "new SandboxCapacityError"
      [toJson (s!"Daytona has no available runner for {subject} in the " ++
        "selected region. The snapshot may be non-general (pinned to one runner) or the " ++
        "runner is at capacity. Rebuild it as a general snapshot or retry.")]
    throw capacity
  | .pending => Prog.unsupported "client.create never finished"

/-- The `() => daytonaSpecs(sandbox)` callback, entered when the meter reads the specs. -/
private def daytonaMeterCallback (sandbox : Json) : Prog Unit :=
  .input fun
    | some ("arg4", _) => do
      let _ ← Prog.effect "daytonaSpecs" [sandbox]
      pure ()
    | _ => pure ()

private def elapsed (later earlier : Json) : Json :=
  match later.getInt?, earlier.getInt? with
  | .ok end_, .ok start => toJson (end_ - start)
  | _, _ => Json.null

/-- The body of `run`'s `try`, for a sandbox that is not reserved. -/
private def daytonaExecute (config request sandbox startedAt : Json) : Prog Json := do
  let _ ← Prog.effect "mountAwsS3Buckets" [sandbox, request, config]
  let cwd ← Prog.effect "workspacePath" [request]
  let env ← Prog.effect "mergeSandboxEnv"
    [field config "envVars", field request "envVars", field request "principal"]
  let response ← Prog.effect "sandbox.process.executeCommand"
    [field request "code", cwd, if isEmptyObject env then Twin.undefinedJson else env,
     field request "timeoutSeconds"]
  let exitCode := field response "exitCode"
  let text :=
    orElse (field response "result")
      (orElse (field (field response "artifacts") "stdout") (toJson ""))
  let stdout ← Prog.effect "truncateText" [text, field request "outputLimitBytes"]
  let finished ← Prog.effect "Date.now"
  return Json.mkObj
    [("ok", toJson ((orElse exitCode (toJson (0 : Nat))).compress == "0")),
     ("runtime", orElse (field request "runtime") (toJson "bash")),
     ("exitCode", orElse exitCode Json.null),
     ("stdout", field stdout "value"),
     ("stderr", toJson ""),
     ("durationMs", elapsed finished startedAt),
     ("truncated", field stdout "truncated"),
     ("provider", toJson "daytona")]

/-- `DaytonaSandboxExecutor.run`, for a sandbox that is not reserved. -/
def daytonaRun (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let config := Twin.field (Twin.self call) "#config"
  let startedAt ← Prog.effect "Date.now"
  if (field config "persistent").compress == "true" then
    Prog.unsupported "reserved Daytona sandboxes"
  let clientOptions ← Prog.effect "daytonaClientOptions" [config]
  let _ ← Prog.effect "new Daytona" [clientOptions]
  let createOptions ← Prog.effect "daytonaCreateOptions" [config, request, toJson false]
  let sandbox ← daytonaCreate config createOptions
  daytonaMeterCallback sandbox
  let endMeter ← Prog.effect "meterEphemeralSandbox"
    [field config "controlPlane", toJson "daytona", field sandbox "id", field request "metadata",
     fnValue]
  let cleanup : Prog Unit := do
    let _ ← Prog.effect "sandbox.delete"
    if truthy endMeter then
      let _ ← Prog.effect "endMeter"
    pure ()
  let result ← Prog.catchFail (daytonaExecute config request sandbox startedAt)
    (fun error => do
      cleanup
      throw error)
  cleanup
  return result

private def base64Value (c : Char) : Option Nat :=
  if 'A' ≤ c ∧ c ≤ 'Z' then some (c.toNat - 'A'.toNat)
  else if 'a' ≤ c ∧ c ≤ 'z' then some (c.toNat - 'a'.toNat + 26)
  else if '0' ≤ c ∧ c ≤ '9' then some (c.toNat - '0'.toNat + 52)
  else if c == '+' || c == '-' then some 62
  else if c == '/' || c == '_' then some 63
  else none

/-- Decodes base64 four characters at a time; `=` padding shortens the last group. -/
private def base64Decode (text : String) : Option (List UInt8) :=
  let rec go : Nat → List Char → List UInt8 → Option (List UInt8)
    | 0, _, _ => none
    | _ + 1, [], out => some out.reverse
    | fuel + 1, chars, out =>
      let group := chars.take 4
      let values := group.filterMap base64Value
      if values.length < 2 then none else
        let bits := values.foldl (fun acc item => acc * 64 + item) 0 * 64 ^ (4 - values.length)
        let bytes := [(bits / 65536) % 256, (bits / 256) % 256, bits % 256].take (values.length - 1)
        go fuel (chars.drop 4) (bytes.reverse.map (·.toUInt8) ++ out)
  go (text.length + 1) text.toList []

private def recordedBytes (value : Json) : Option (List UInt8) :=
  match field value "$bytes" with
  | .str text => base64Decode text
  | _ => none

/-- What `readCapped`'s read loop has kept so far. -/
private structure Capped where
  kept : List UInt8 := []
  truncated : Bool := false

private def readLoop (limit : Nat) : Nat → Capped → Prog Capped
  | 0, _ => Prog.unsupported "more chunks than the model reads"
  | fuel + 1, state => do
    match ← Prog.attempt "reader.read" with
    | .threw _ _ => return state
    | .pending => Prog.unsupported "reader.read never finished"
    | .ok chunk =>
      if truthy (field chunk "done") then return state
      match recordedBytes (field chunk "value") with
      | none => Prog.unsupported "a chunk that is not recorded bytes"
      | some bytes =>
        let room := limit - state.kept.length
        let state := if bytes.length > room then { state with truncated := true } else state
        let state :=
          if room > 0 then { state with kept := state.kept ++ bytes.take room } else state
        readLoop limit fuel state

private def jsonNat (value : Json) : Nat :=
  ((value.getInt?).toOption.getD 0).toNat

private def cancelListener : Json := Json.mkObj [("$fn", toJson "cancel")]

/-- `readCapped` in `apps/cloudflare-sandbox/src/index.ts`. -/
def readCapped (call : Json) : Prog Json := do
  let stream := Twin.callArg call 0
  let limit := jsonNat (Twin.callArg call 1)
  let hasReader := !isNullish stream
  if hasReader then
    let _ ← Prog.effect "stream?.getReader"
  let _ ← Prog.effect "signal.addEventListener"
    [toJson "abort", cancelListener, Json.mkObj [("once", toJson true)]]
  let state ← if hasReader then readLoop limit 4096 {} else pure {}
  let _ ← Prog.effect "signal.removeEventListener" [toJson "abort", cancelListener]
  match String.fromUTF8? (ByteArray.mk state.kept.toArray) with
  | some text => return Json.mkObj [("text", toJson text), ("truncated", toJson state.truncated)]
  | none => Prog.unsupported "kept bytes are not valid UTF-8"

private def containerOf (self : Json) : Json :=
  field (Twin.field self "ctx") "container"

/-- `#container`. -/
private def requireContainer (self : Json) : Prog Json := do
  let container := containerOf self
  if !truthy container then
    Prog.throwError "Error" "The container binding is not configured"
  return container

/-- `Sandbox.status`. -/
def sandboxStatus (call : Json) : Prog Json := do
  let container ← requireContainer (Twin.self call)
  return Json.mkObj [("running", field container "running")]

/-- `Sandbox.destroy`. -/
def sandboxDestroy (call : Json) : Prog Json := do
  let self := Twin.self call
  let container ← requireContainer self
  if truthy (field container "running") || truthy (Twin.field self "#booting") then
    let _ ← Prog.effect "container.destroy"
  return Twin.undefinedJson

/-- `requiredImage`. -/
def requiredImage (call : Json) : Prog Json := do
  let image := field (field (Twin.callArg call 0) "images") "sandbox"
  if !truthy image then
    Prog.throwError "Error" "wrangler.jsonc must define the sandbox image"
  return image

private def requestHeader (request : Json) (name : String) : Option String :=
  match field (field request "$request") "headers" with
  | .arr headers =>
    headers.toList.findSome? fun pair =>
      match Twin.arg pair 0, Twin.arg pair 1 with
      | .str key, .str value => if key.toLower == name.toLower then some value else none
      | _, _ => none
  | _ => none

private def hexValue (c : Char) : Option Nat :=
  if '0' ≤ c ∧ c ≤ '9' then some (c.toNat - '0'.toNat)
  else if 'a' ≤ c ∧ c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
  else if 'A' ≤ c ∧ c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
  else none

/-- `+` and `%XX` decoding of a query value. None for a non-ASCII or malformed escape. -/
private def decodeQuery : Nat → List Char → Option (List Char)
  | 0, _ => none
  | _ + 1, [] => some []
  | fuel + 1, '+' :: rest => (decodeQuery fuel rest).map (' ' :: ·)
  | fuel + 1, '%' :: high :: low :: rest =>
    match hexValue high, hexValue low with
    | some h, some l =>
      if h * 16 + l < 128 then
        (decodeQuery fuel rest).map (Char.ofNat (h * 16 + l) :: ·)
      else none
    | _, _ => none
  | _ + 1, '%' :: _ => none
  | fuel + 1, c :: rest => (decodeQuery fuel rest).map (c :: ·)

/-- The `name` query parameter, or none when it needs decoding the model does not do. -/
private def nameParam (url : String) : Option String :=
  let query := ((url.splitOn "?").getD 1 "")
  let found := (query.splitOn "&").findSome? fun pair =>
    match pair.splitOn "=" with
    | key :: rest => if key == "name" then some ("=".intercalate rest) else none
    | [] => none
  let raw := found.getD ""
  (decodeQuery (raw.length + 1) raw.toList).map String.ofList

private def promptSafe (c : Char) : Bool :=
  c.isAlphanum && c.toNat < 128 || c == '_' || c == '.' || c == '-'

/-- `.replace(PROMPT_UNSAFE, "-")`: each run of unsafe characters becomes one dash. -/
private def promptName (text : String) : String :=
  let step := fun (acc : List Char × Bool) (c : Char) =>
    if promptSafe c then (c :: acc.1, false)
    else if acc.2 then acc
    else ('-' :: acc.1, true)
  String.ofList ((text.foldl step ([], false)).1.reverse.take 63)

private def responseJson (status : Nat) : Json :=
  Json.mkObj [("$response", Json.mkObj
    [("status", toJson status), ("headers", .arr #[])])]

/-- `Sandbox.fetch` up to the shell starting. The WebSocket bridge after it is unsupported. -/
def sandboxFetch (call : Json) : Prog Json := do
  let self := Twin.self call
  let container ← requireContainer self
  let request := Twin.callArg call 0
  if requestHeader request "Upgrade" != some "websocket" then
    return responseJson 426
  if !truthy (field container "running") then
    return responseJson 409
  let url := stringOf (field (field request "$request") "url")
  let name ← match nameParam url with
    | some raw => pure (promptName raw)
    | none => Prog.unsupported "a percent-encoded sandbox name"
  let shell ← Prog.effect "container.exec"
    [.arr #[toJson "bash", toJson "-l"],
     Json.mkObj
      [("cwd", toJson "/workspace"),
       ("pty", Json.mkObj [("cols", toJson (120 : Nat)), ("rows", toJson (32 : Nat))]),
       ("env", Json.mkObj
         ([("TERM", toJson "xterm-256color")] ++
          (if name.isEmpty then [] else [("BROODS_SANDBOX_NAME", toJson name)]))),
       ("signal", Json.mkObj [("$signal", toJson false)]),
       ("stdin", toJson "pipe")]]
  if !truthy (field shell "stdin") then
    let _ ← Prog.effect "abort.abort"
    Prog.throwError "Error" "The terminal shell has no stdin"
  Prog.unsupported "the terminal WebSocket bridge"

private def bridgeSource (name : String) : String :=
  "apps/cloudflare-sandbox/src/index.ts#" ++ name

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/shared/workspaces.ts#resolveAgentRuntime" resolveAgentRuntime,
   Twin.traced "apps/core/src/harness/sandbox/daytona-executor.ts#DaytonaSandboxExecutor.run"
     daytonaRun,
   Twin.traced (bridgeSource "readCapped") readCapped,
   Twin.traced (bridgeSource "Sandbox.status") sandboxStatus,
   Twin.traced (bridgeSource "Sandbox.destroy") sandboxDestroy,
   Twin.traced (bridgeSource "requiredImage") requiredImage,
   Twin.traced (bridgeSource "Sandbox.fetch") sandboxFetch]

end Spec.Sandbox.Wavesandbox5a
