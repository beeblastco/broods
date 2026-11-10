import Spec.Twin
import Spec.Sandbox.Twins.Tools.Js
import Spec.Sandbox.Twins.Tools.Scripts
import Spec.Sandbox.Twins.Runtime.Basics

namespace Spec.Sandbox.Wavesandbox1

open Lean Spec

private def get (j : Json) (key : String) : Json :=
  (j.getObjVal? key).toOption.getD Twin.undefinedJson

private def text (j : Json) : String :=
  match j with
  | .str s => s
  | .num n => toString n
  | .bool b => if b then "true" else "false"
  | .null => "null"
  | _ => if j == Twin.undefinedJson then "undefined" else j.compress

private def items (j : Json) : List Json :=
  (j.getArr?).toOption.getD #[] |>.toList

private def missing (j : Json) : Bool := j == Twin.undefinedJson

private def nullish (j : Json) : Bool := missing j || j == .null

private def truthy (j : Json) : Bool := !missing j && Tools.truthy j

private def fallback (j d : Json) : Json := if nullish j then d else j

private def bytes (j : Json) : ByteArray :=
  ByteArray.mk ((Tools.fromBase64 (text (get j "$bytes"))).map UInt8.ofNat)

private def readChunks : Nat → ByteArray → Bool → String → Prog Json
  | 0, _, _, _ => Prog.unsupported "stream exceeds 4096 chunks"
  | fuel + 1, acc, bounded, path => do
    let next ← Prog.effect "reader.read"
    if truthy (get next "done") then return toJson (String.fromUTF8! acc)
    let chunk := bytes (get next "value")
    if bounded && acc.size + chunk.size > 16777216 then
      let _ ← Prog.effect "reader.cancel"
      Prog.throwError "Error" s!"MicroVM {path} answered more than 16777216 bytes"
    else readChunks fuel (acc ++ chunk) bounded path

private def boundedText (call : Json) : Prog Json := do
  let res := Twin.callArg call 0
  let path := text (Twin.callArg call 1)
  let headers := items (get (get res "$response") "headers")
  let length := headers.findSome? fun h =>
    if Twin.arg h 0 == toJson "content-length" then (text (Twin.arg h 1)).toNat? else none
  if length.getD 0 > 16777216 then
    let _ ← Prog.effect "res.body?.cancel"
    return ← Prog.throwError "Error" s!"MicroVM {path} answered more than 16777216 bytes"
  let _ ← Prog.effect "res.body.getReader"
  readChunks 4096 ByteArray.empty true path

private def readHarnessStream (_call : Json) : Prog Json := do
  let _ ← Prog.effect "stream.getReader"
  let result ← Prog.catchFail
    (do
      let result ← readChunks 4096 ByteArray.empty false ""
      pure (Except.ok result : Except Json Json))
    (fun err => pure (.error err))
  let _ ← Prog.effect "reader.releaseLock"
  match result with
  | .ok value => pure value
  | .error err => .fail err

private def workdirNetwork (args : Json) : Json := Id.run do
  let n := Twin.arg args 0
  if nullish n then return Json.null
  let mode := text (get n "mode")
  if mode == "allow-all" then return Json.mkObj [("egress", toJson "default")]
  if mode == "deny-all" then return Json.mkObj [("egress", toJson "none")]
  let allow := (items (get n "allowDomains")).map (fun v =>
    Json.mkObj [("type", toJson "domain"), ("value", v)]) ++ items (get n "allowCidrs")
  return if allow.isEmpty then Json.mkObj [("egress", toJson "none")]
    else Json.mkObj [("egress", toJson "allowlist"), ("allow", toJson allow)]

private def runsOnOwnCredentials (args : Json) : Json :=
  let cfg := Twin.arg args 0
  let key := match text (get cfg "provider") with
    | "e2b" | "daytona" => "apiKey"
    | "vercel" => "token"
    | "sandbox" => "workdirUrl"
    | _ => ""
  let value := get (get cfg "options") key
  toJson (if ["machine", "custom"].contains (text (get cfg "provider")) then true
    else key != "" && match value with | .str s => !s.trimAscii.toString.isEmpty | _ => false)

private def sharedWorkspaceNamespace (call : Json) : Prog Json := do
  let base := Twin.callArg call 0
  let isolation := Twin.callArg call 1
  let scope := Twin.callArg call 2
  if missing isolation then return base
  if isolation == toJson "agent" then
    if !truthy (get scope "agentId") then
      return ← Prog.throwError "Error" "Workspace isolation \"agent\" requires an agent identity"
    let folder ← Prog.effect "agentNamespaceFolder" [get scope "agentId"]
    return toJson s!"{text base}/{text folder}"
  let partition := get scope "partition"
  if !truthy partition then
    if !truthy (get scope "channelName") then return base
    return ← Prog.throwError "Error" "Workspace isolation requires the active channel to define partition"
  if get partition "by" == toJson "shared" then return base
  let key := fallback (get scope "conversationKey") (get scope "channelScopeKey")
  if !truthy key then
    return ← Prog.throwError "Error" "Conversation workspace isolation requires an active conversation key"
  let folder ← Prog.effect "normalizeFilesystemNamespace" [key]
  return toJson s!"{text base}/{text (get partition "alias")}/{text folder}"

private def formatMachineNow (args : Json) : Json := Id.run do
  let status := Twin.arg args 0
  let usage := get status "usage"
  let mut parts := [text (fallback (get status "state") (toJson "running"))]
  if !missing (get usage "load1") then
    let cpus := text (fallback (get usage "cpus") (toJson "?"))
    let plural := if get usage "cpus" == toJson (1 : Nat) then "" else "s"
    parts := parts ++ [s!"load {text (get usage "load1")} on {cpus} CPU{plural}"]
  if !missing (get usage "memoryUsedMb") then
    parts := parts ++ [s!"RAM {text (get usage "memoryUsedMb")} of {text (get usage "memoryTotalMb")} MB used"]
  if !missing (get usage "diskUsedGb") then
    parts := parts ++ [s!"disk {text (get usage "diskUsedGb")} of {text (get usage "diskTotalGb")} GB used"]
  return toJson (String.intercalate ", " parts)

private def assertSnapshotBootable (call : Json) : Prog Json := do
  let cp := Twin.callArg call 0
  let snapshot := Twin.callArg call 1
  if !truthy snapshot then return .null
  let row ← Prog.effect "findSandboxSnapshot" [get cp "accountId", snapshot]
  if !truthy row then return .null
  let refusal ← if truthy cp then do
    let scope ← Prog.effect "sandboxScope" [cp]
    Prog.effect "snapshotBootRefusal" [row, Json.mkObj [("accountId", get cp "accountId"), ("scope", scope)]]
  else pure (toJson "config.snapshot names a snapshot, which boots only from a sandbox config of its own account and stage")
  if truthy refusal then return ← Prog.throwError "Error" (text refusal)
  return row

private def orphanPages : Nat → Json → List Json → Prog Json
  | 0, _, _ => Prog.unsupported "more than 1024 orphan pages"
  | fuel + 1, cursor, acc => do
    let page ← Prog.effect "runtime.query" [toJson "listOrphanedSandboxInstances",
      Json.mkObj [("cursor", cursor), ("limit", toJson (100 : Nat))]]
    let acc := acc ++ items (get page "page")
    if truthy (get page "isDone") || get page "cursor" == .null || acc.length >= 100 then return toJson acc
    orphanPages fuel (get page "cursor") acc

private def snapshotStatus (call : Json) : Prog Json := do
  let cmd ← Prog.effect "new GetMicrovmImageCommand"
    [Json.mkObj [("imageIdentifier", Twin.callArg call 0)]]
  let image ← Prog.effect "this.#client.send" [cmd]
  return toJson (if truthy (get image "latestActiveImageVersion") then "active"
    else if truthy (get image "latestFailedImageVersion") || get image "state" == toJson "CREATE_FAILED"
      then "build_failed" else "building")

private def grepGlobFlag (args : Json) : Json :=
  let glob := text (Twin.arg args 0)
  let exclude := glob.startsWith "!"
  let pattern := if exclude then String.ofList (glob.toList.drop 1) else glob
  let segments := pattern.splitOn "/"
  let tail := segments.getLast!
  let dir := if tail == "**" || tail == "" then (segments.reverse.drop 1).headD "" else ""
  toJson (if exclude && dir != "" && !(dir.contains '*') then s!"--exclude-dir={dir}"
    else s!"--{if exclude then "exclude" else "include"}={if tail == "" then "*" else tail}")

private def validateQuestions (args : Json) : Json := Id.run do
  let mut seen : List Json := []
  for q in items (Twin.arg args 0) do
    let id := get q "id"
    if seen.contains id then return toJson s!"question id \"{text id}\" is used twice"
    seen := id :: seen
  return .null

private def microvmImageScope (args : Json) : Json :=
  let parts := (text (Twin.arg args 0)).splitOn ":"
  if parts[0]? == some "arn" && parts[2]? == some "lambda" &&
    parts[5]? == some "microvm-image" && parts.length >= 7
  then toJson (String.intercalate ":" (parts.take 6)) else Json.null

private def mapWorkdirState (args : Json) : Json :=
  toJson (match text (Twin.arg args 0) with
    | "running" | "creating" | "resuming" => "running"
    | "stopped" | "standby" | "stopping" => "suspended"
    | "deleting" | "deleted" => "terminating"
    | "failed" => "error"
    | _ => "unknown")

private def assertDistinctSandboxNames (args : Json) : Json := Id.run do
  let mut seen : List Json := []
  for entry in items (Twin.arg args 0) do
    let name := get entry "name"
    if seen.contains name then
      return Twin.threw s!"Sandbox \"{text name}\" is attached twice; bash picks a sandbox by name"
    seen := name :: seen
  return .null

private def normalizeOptionalString (args : Json) : Json :=
  let value := Twin.arg args 0
  if nullish value then Json.null else
    match value with
    | .str s => let s := s.trimAscii.toString
                if s.isEmpty then Json.null else toJson s
    | _ => Twin.threw s!"{text (Twin.arg args 1)} must be a string"

private def truncateText (args : Json) : Json :=
  let value := text (Twin.arg args 0)
  let limit := (Twin.arg args 1).getNat?.toOption.getD 0
  let truncated : Bool := value.toUTF8.size > limit
  Json.mkObj [("value", toJson (if truncated then
    String.fromUTF8! (value.toUTF8.extract 0 limit) ++ "\n[output truncated]" else value)),
    ("truncated", toJson truncated)]

private def workspacePath (args : Json) : Json :=
  let req := Twin.arg args 0
  let root := text (fallback (get req "workspaceRoot") (Twin.arg args 1))
  let root := String.ofList ((root.toList.reverse.dropWhile (· == '/')).reverse)
  if root == "" || root == "null" || root == "undefined" then Json.null
  else toJson (if truthy (get req "namespace") then s!"{root}/{text (get req "namespace")}" else root)

private def isExecResponse (args : Json) : Json :=
  let obj := Twin.arg args 0
  let fields := [("ok", "boolean", true), ("runtime", "string", false),
    ("exit_code", "number", false), ("timed_out", "boolean", true),
    ("duration_ms", "number", true), ("stdout", "string", true),
    ("stderr", "string", true), ("truncated", "boolean", false), ("cpu_usec", "number", false)]
  toJson (fields.all fun (key, ty, required) =>
    let value := get obj key
    (!required && nullish value) || match value, ty with
    | .bool _, "boolean" | .str _, "string" | .num _, "number" => true
    | _, _ => false)

private def daytonaNetworkOptions (args : Json) : Json :=
  let network := get (Twin.arg args 0) "network"
  let mode := text (fallback (get network "mode") (toJson "deny-all"))
  let cidrs := items (get network "allowCidrs")
  Json.mkObj ([("networkBlockAll", toJson (mode != "allow-all"))] ++
    if mode != "allow-all" && mode != "deny-all" && !cidrs.isEmpty
      then [("networkAllowList", toJson (String.intercalate "," (cidrs.map text)))] else [])

private def microvmShellConnection (call : Json) : Prog Json := do
  let id := Twin.callArg call 0
  let cmd ← Prog.effect "new GetMicrovmCommand" [Json.mkObj [("microvmIdentifier", id)]]
  let info ← Prog.effect "client.send" [cmd]
  if !truthy (get info "endpoint") then
    return ← Prog.throwError "Error" s!"MicroVM {text id} has no endpoint"
  let cmd ← Prog.effect "new CreateMicrovmShellAuthTokenCommand"
    [Json.mkObj [("microvmIdentifier", id), ("expirationInMinutes", toJson (30 : Nat))]]
  let result ← Prog.effect "client.send" [cmd]
  let token := get (get result "authToken") "X-aws-proxy-auth"
  if !truthy token then
    return ← Prog.throwError "Error" "CreateMicrovmShellAuthToken did not return an X-aws-proxy-auth token"
  let endpoint := text (get info "endpoint")
  let endpoint := if endpoint.startsWith "https://" then String.ofList (endpoint.toList.drop 8)
    else if endpoint.startsWith "http://" then String.ofList (endpoint.toList.drop 7) else endpoint
  return Json.mkObj [("url", toJson s!"wss://{endpoint}"), ("authorization", token)]

private def managedIngressConnectorArn (call : Json) : Prog Json := do
  let initial ← Prog.effect "optionalEnv" [toJson "AWS_REGION"]
  let region ← if nullish initial then Prog.effect "optionalEnv" [toJson "AWS_DEFAULT_REGION"] else pure initial
  if !truthy region then return ← Prog.throwError "Error" "MicroVM ingress connectors require AWS_REGION"
  return toJson s!"arn:aws:lambda:{text region}:aws:network-connector:aws-network-connector:{text (Twin.callArg call 0)}"

private def deferAttempted (call : Json) : Prog Json := do
  let rs := items (Twin.callArg call 1)
  if rs.isEmpty then return Twin.undefinedJson
  let _ ← Prog.attempt "runtime .mutate" [toJson "deferSandboxReservations",
    Json.mkObj [("accountId", Twin.callArg call 0), ("reservations", toJson (rs.map fun r =>
      Json.mkObj [("provider", get r "provider"), ("reservationKey", get r "reservationKey")]))]]
  return Twin.undefinedJson

private def normalizeRequiredString (args : Json) : Json :=
  match Twin.arg args 0 with
  | .str s => if s.trimAscii.toString != "" then toJson s.trimAscii.toString
      else Twin.threw s!"{text (Twin.arg args 1)} must be a non-empty string"
  | _ => Twin.threw s!"{text (Twin.arg args 1)} must be a non-empty string"

private def normalizeWorkspacePrefix (args : Json) : Json :=
  let s := text (fallback (Twin.arg args 0) (toJson ""))
  let cs := ((s.toList.dropWhile (· == '/')).reverse.dropWhile (· == '/')).reverse
  toJson (if cs.isEmpty then "" else String.ofList cs ++ "/")

private def s3Location (args : Json) : Json :=
  let uri := text (Twin.arg args 0)
  let segments := (String.ofList (uri.toList.drop 5)).splitOn "/"
  let bucket := segments.headD ""
  let key := String.intercalate "/" (segments.drop 1)
  if uri.startsWith "s3://" && bucket != "" && key != "" &&
    !(key.toList.any fun c => c == '\n' || c == '\r')
  then Json.mkObj [("bucket", toJson bucket), ("key", toJson key)] else .null

private def s3SecretNames (args : Json) : Json :=
  let names := (items (get (Twin.arg args 0) "s3SecretNames")).filter fun j =>
    match j with | .str s => s.trimAscii.toString != "" | _ => false
  toJson (if names.isEmpty then [toJson "AWS_ACCESS_KEY_ID", toJson "AWS_SECRET_ACCESS_KEY"] else names)

private def principalEnv (args : Json) : Json :=
  let p := Twin.arg args 0
  Json.mkObj ([("BROODS_ACCOUNT_ID", get p "accountId"), ("BROODS_AGENT_ID", get p "agentId")] ++
    (if truthy (get p "baseUrl") then [("BROODS_BASE_URL", get p "baseUrl")] else []) ++
    [("BROODS_RUN_TOKEN", get p "runToken")])

private def notes (call : Json) (kind : String) : Prog Json := do
  let ctx := Twin.callArg call 0
  let ws := items (get ctx "workspaces")
  let mut names : List String := []
  for w in ws do
    if kind == "reserved" then
      if get (get w "sandbox") "persistent" == toJson true then
        let own ← Prog.effect "isAgentOwnSandbox" [w, ctx]
        if !truthy own then names := names ++ [text (get w "name")]
    else
      let allowed ← Prog.effect "writesOutsideAllowed" [w, ctx]
      if truthy allowed == (kind == "own") then names := names ++ [text (get w "name")]
  if names.isEmpty then return toJson ""
  let joined := String.intercalate ", " names
  return toJson (if kind == "own" then
    s!"\n- Your own reserved sandbox backs {joined}: the whole filesystem there is yours and survives between calls, so writing outside the workspace directory is allowed. It still dies with the reservation — keep anything that must outlive it in the workspace directory."
    else if kind == "reserved" then
    s!"\n- {joined} run on a reserved (persistent) sandbox: packages installed under $HOME (e.g. a uv/venv or npm prefix) survive across calls until the reservation ends. It is an execution layer you borrow, so writes outside the workspace directory are still rejected — keep results in the workspace."
    else
    let scope := if names.length == ws.length then "Writes" else s!"In {joined}, writes"
    s!" {scope} to an absolute path elsewhere are rejected, except /tmp and /var/tmp, which are available for genuine scratch and are discarded when the sandbox stops.")

private def s3MountNote (args : Json) : Json :=
  let mounted := (items (get (Twin.arg args 0) "workspaces")).any fun w =>
    ["daytona", "lambda", "sandbox", "vercel"].contains (text (get (get w "sandbox") "provider"))
  toJson (if mounted then "\n- The workspace is an S3 mount with no rename or append: `sed -i`, `mv` and `>>` on its files fail. Use edit/write, or work in /tmp and `cp` back." else "")

private def namespaceKey (call : Json) (kind : String) : Prog Json := do
  let a := Twin.callArg call 0
  let b := Twin.callArg call 1
  let c := Twin.callArg call 2
  let key := if kind == "agent" then s!"{text a}:{text b}:{text c}"
    else if kind == "pinned" then s!"{text a}:pinned:{text b}"
    else if truthy a then s!"{text a}:{text b}" else text b
  Prog.effect "normalizeFilesystemNamespace" [toJson key]

private def configString (args : Json) : Json :=
  match Twin.arg args 0 with
  | .str s => if s.trimAscii.toString.isEmpty then .null else toJson s.trimAscii.toString
  | _ => .null

private def descriptorId (args : Json) : Json :=
  let c := Twin.arg args 0
  let id := get c "id"
  if ["provider", "provider-defined"].contains (text (get c "type")) then
    match id with | .str _ => id | _ => .null
  else .null

private def shortHash (args : Json) : Json :=
  let hash := (Rt.utf16Units (text (Twin.arg args 0))).foldl
    (fun h c => (h * 33 + c) % 4294967296) 5381
  let rec repr : Nat → Nat → List Char
    | 0, _ => []
    | fuel + 1, n =>
      let c := ("0123456789abcdefghijklmnopqrstuvwxyz".toList[n % 36]!).toNat
      if n < 36 then [Char.ofNat c] else repr fuel (n / 36) ++ [Char.ofNat c]
  toJson (String.ofList ((repr 16 hash).take 6))

private def slugFor (args : Json) : Json :=
  let value := text (fallback (Twin.arg args 0) (toJson ""))
  let dflt := fallback (Twin.arg args 1) (toJson "sandbox")
  let limit := (Twin.arg args 2).getNat?.toOption.getD 40
  let mapped := value.toLower.toList.map fun c =>
    if ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '-' then c else '-'
  let collapsed := mapped.foldl (fun acc c =>
    if c == '-' && acc.head? == some '-' then acc else c :: acc) ([] : List Char)
  let cut := (collapsed.reverse.take limit)
  let cut := if cut.head? == some '-' then cut.drop 1 else cut
  let cut := if cut.getLast? == some '-' then cut.take (cut.length - 1) else cut
  if cut.isEmpty then dflt else toJson (String.ofList cut)

private def workdirPtyUrl (args : Json) : Json :=
  match Rt.parseUrl (text (Twin.arg args 0)) with
  | .invalid => Twin.threw "Invalid URL"
  | .unmodelled => Twin.unsupported "URL outside shared parser"
  | .ok u =>
    let scheme := if u.protocol == "https:" then "wss:" else "ws:"
    let auth := if u.username == "" && u.password == "" then "" else
      u.username ++ (if u.password == "" then "" else ":" ++ u.password) ++ "@"
    let authority := auth ++ u.hostname ++ (if u.port == "" then "" else ":" ++ u.port)
    let id := text (Twin.arg args 1)
    if !(id.toList.all fun c => c.isAlphanum || "-_.!~*'()".contains c) then
      Twin.unsupported "identifier requires URI encoding"
    else toJson s!"{scheme}//{authority}{Rt.dropTrailingSlashes u.pathname}/v1/sandboxes/{id}/pty{u.search}{u.hash}"

private def r2AccountId (args : Json) : Json :=
  match Rt.parseUrl (text (Twin.arg args 0)) with
  | .invalid => .null
  | .unmodelled => Twin.unsupported "URL outside shared parser"
  | .ok u =>
    let suffix := ".r2.cloudflarestorage.com"
    let account := String.ofList (u.hostname.toList.take (u.hostname.length - suffix.length))
    if u.protocol == "https:" && u.username == "" && u.password == "" &&
      u.port == "" && u.search == "" && u.hash == "" && u.pathname == "/" &&
      u.hostname.endsWith suffix && account.length == 32 &&
      account.toList.all (fun c => c.isDigit || ('a' ≤ c && c ≤ 'f'))
    then toJson account else .null

private def isReservedStandalone (call : Json) : Prog Json := do
  let cfg := Twin.callArg call 0
  if get cfg "persistent" != toJson true then return toJson false
  let key ← Prog.effect "statelessReservationKeyFor" [cfg]
  return toJson (!missing key)

private def executeDaytonaSetupCommand (call : Json) : Prog Json := do
  let command := Twin.callArg call 1
  let response ← Prog.effect "sandbox.process.executeCommand" [command]
  if fallback (get response "exitCode") (toJson (0 : Nat)) != toJson (0 : Nat) then
    return ← Prog.throwError "Error" s!"Daytona setup command failed: {text command}\n{text (fallback (get response "result") (toJson ""))}"
  return Twin.undefinedJson

private def deleteSandboxInstance (call : Json) : Prog Json := do
  let account := Twin.callArg call 2
  if !truthy account then return toJson false
  let opts := [("provider", Twin.callArg call 0), ("reservationKey", Twin.callArg call 1),
    ("expectedExternalId", Twin.callArg call 3), ("onlyExpired", Twin.callArg call 4), ("accountId", account)]
  Prog.effect "runtime.mutate" [toJson "deleteSandboxReservation", Json.mkObj (opts.filter fun kv => !missing kv.2)]

private def sendUpstreamMessage (call : Json) : Prog Json := do
  let data := Twin.callArg call 1
  if (match data with | .str _ => true | _ => !missing (get data "$bytes")) then
    let _ ← Prog.effect "socket.send" [data]
    return Twin.undefinedJson
  Prog.unsupported "websocket data other than text or recorded bytes"

private def byteJson (data : ByteArray) : Json :=
  Json.mkObj [("$bytes", toJson (Rt.base64 data.toList))]

private def terminalMac (call : Json) : Prog Json := do
  let key ← Prog.effect "crypto.subtle.importKey"
    [toJson "raw", byteJson (text (Twin.callArg call 0)).toUTF8,
      Json.mkObj [("name", toJson "HMAC"), ("hash", toJson "SHA-256")], toJson false, toJson ["sign"]]
  let message := "terminal" ++ String.singleton (Char.ofNat 0) ++ text (Twin.callArg call 1) ++
    String.singleton (Char.ofNat 0) ++ text (Twin.callArg call 2)
  let signature ← Prog.effect "crypto.subtle.sign" [toJson "HMAC", key, byteJson message.toUTF8]
  let encoded := Rt.base64 (bytes signature).toList
  return toJson (String.ofList ((encoded.toList.map fun c =>
    if c == '+' then '-' else if c == '/' then '_' else c).filter (· != '=')))

private def signTerminalToken (call : Json) : Prog Json := do
  let mac ← Prog.effect "mac" [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2]
  return toJson s!"tt1.{text (Twin.callArg call 2)}.{text mac}"

private def isolatedWorkspaceNamespace (call : Json) : Prog Json := do
  let base := Twin.callArg call 0
  let isolation := Twin.callArg call 1
  let scope := fallback (Twin.callArg call 2) (Json.mkObj [])
  if !truthy (get scope "userConversationKey") then
    return ← Prog.effect "sharedWorkspaceNamespace" [base, isolation, scope]
  let namespaceValue ← if isolation == toJson "agent" then
    Prog.effect "sharedWorkspaceNamespace" [base, isolation, scope] else pure base
  let key ← Prog.effect "normalizeFilesystemNamespace" [get scope "userConversationKey"]
  return toJson s!"{text namespaceValue}/users/{text key}"

private def microvmImageVariant (call : Json) : Prog Json := do
  let arn := Twin.callArg call 0
  let scope ← Prog.effect "microvmImageScope" [arn]
  let name := ((text arn).splitOn ":")[6]?.getD ""
  if !truthy scope || name == "" then return Twin.undefinedJson
  return toJson s!"{text scope}:{name}-{text (Twin.callArg call 1)}"

private def parseExecResponse (call : Json) : Prog Json := do
  let body := text (Twin.callArg call 0)
  let label := text (Twin.callArg call 1)
  if body == "" then return ← Prog.throwError "Error" s!"{label} returned an empty response"
  match Json.parse body with
  | .error _ => Prog.unsupported "engine-specific JSON syntax error message"
  | .ok parsed =>
    if !(match parsed with | .obj _ => true | _ => false) then
      return ← Prog.throwError "Error" s!"{label} response must be a JSON object"
    let valid ← Prog.effect "isExecResponse" [parsed]
    if !truthy valid then
      return ← Prog.throwError "Error" s!"{label} response is not a sandbox exec response"
    return parsed

private def execRunResult (call : Json) : Prog Json := do
  let req := Twin.callArg call 0
  let response := Twin.callArg call 1
  let stdout ← Prog.effect "truncateText" [get response "stdout", get req "outputLimitBytes"]
  let stderr ← Prog.effect "truncateText" [get response "stderr", get req "outputLimitBytes"]
  let duration ← if truthy (get response "duration_ms") then pure (get response "duration_ms")
    else do
      let now ← Prog.effect "Date.now"
      pure (toJson ((now.getInt?.toOption.getD 0) - (Twin.callArg call 3).getInt?.toOption.getD 0))
  let cpu := get response "cpu_usec"
  let hasCpu := match cpu with | .num n => n.mantissa > 0 | _ => false
  return Json.mkObj ([("ok", get response "ok"), ("runtime", fallback (get req "runtime") (toJson "bash")),
    ("exitCode", fallback (get response "exit_code") .null), ("stdout", get stdout "value"),
    ("stderr", get stderr "value"), ("durationMs", duration), ("timedOut", get response "timed_out"),
    ("truncated", toJson (truthy (get response "truncated") || truthy (get stdout "truncated") || truthy (get stderr "truncated"))),
    ("provider", Twin.callArg call 2)] ++ if hasCpu == true then [("cpuUsec", cpu)] else [])

private def normalizeTask (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let index := text (Twin.callArg call 1)
  if !(match task with | .obj _ => !missing task | _ => false) then
    return ← Prog.throwError "Error" s!"tasks[{index}] must be an object"
  let keys := match get task "$keys" with
    | .arr names => names.toList.map text
    | _ => (Tools.entries task).map Prod.fst
  for key in keys do
    if !["agentId", "prompt", "conversationKey", "isolated"].contains key then
      return ← Prog.throwError "Error" s!"tasks[{index}].{key} is not supported"
  let prompt ← Prog.effect "normalizeRequiredString" [get task "prompt", toJson s!"tasks[{index}].prompt"]
  let agent ← Prog.effect "normalizeOptionalString" [get task "agentId", toJson s!"tasks[{index}].agentId"]
  let persistent := Twin.callArg call 2 == toJson "persistent"
  if !persistent && !nullish (get task "conversationKey") then
    return ← Prog.throwError "Error" s!"tasks[{index}].conversationKey is only supported in persistent mode"
  let conversation ← if persistent then
    Prog.effect "normalizeOptionalString" [get task "conversationKey", toJson s!"tasks[{index}].conversationKey"]
    else pure Twin.undefinedJson
  let isolated := get task "isolated"
  if !nullish isolated && !(match isolated with | .bool _ => true | _ => false) then
    return ← Prog.throwError "Error" s!"tasks[{index}].isolated must be a boolean"
  return Json.mkObj ((if truthy agent then [("agentId", agent)] else []) ++ [("prompt", prompt)] ++
    (if truthy conversation then [("conversationKey", conversation)] else []) ++
    (if isolated == toJson true then [("isolated", toJson true)] else []))

private def previewKey (call : Json) : Prog Json := do
  let key ← Prog.effect "configString" [get (get (Twin.callArg call 0) "options") "apiKey"]
  if nullish key then return ← Prog.effect "optionalEnv" [toJson "WORKDIR_API_KEY"]
  return key

private def numeric (j : Json) : Float :=
  match j with | .num n => n.toFloat | _ => 0

private def numberJson (x : Float) : Json :=
  match JsonNumber.fromFloat? x with | .inr n => .num (Rt.numNormal n) | .inl _ => .null

private def plain (source : String) (run : Json → Json) : Twin :=
  { source := source, run := run }

private def sandbox (file name : String) : String :=
  s!"apps/core/src/harness/sandbox/{file}.ts#{name}"


/-! ## Second pass: leaves and their direct callers -/

/-- What `new Bash({ fs: new InMemoryFs(), cwd: "/" }).fs.getAllPaths()` lists on just-bash 3.6. -/
private def defaultPaths : List String :=
  ["/", "/bin", "/usr", "/usr/bin", "/dev", "/dev/fd", "/dev/null", "/dev/zero", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/proc", "/proc/self", "/proc/self/fd", "/proc/version", "/proc/self/exe", "/proc/self/cmdline", "/proc/self/comm", "/proc/self/status", "/proc/self/fd/0", "/proc/self/fd/1", "/proc/self/fd/2", "/bin/echo", "/usr/bin/echo", "/bin/cat", "/usr/bin/cat", "/bin/printf", "/usr/bin/printf", "/bin/ls", "/usr/bin/ls", "/bin/mkdir", "/usr/bin/mkdir", "/bin/mktemp", "/usr/bin/mktemp", "/bin/rmdir", "/usr/bin/rmdir", "/bin/touch", "/usr/bin/touch", "/bin/rm", "/usr/bin/rm", "/bin/cp", "/usr/bin/cp", "/bin/mv", "/usr/bin/mv", "/bin/ln", "/usr/bin/ln", "/bin/chmod", "/usr/bin/chmod", "/bin/pwd", "/usr/bin/pwd", "/bin/readlink", "/usr/bin/readlink", "/bin/head", "/usr/bin/head", "/bin/tail", "/usr/bin/tail", "/bin/wc", "/usr/bin/wc", "/bin/stat", "/usr/bin/stat", "/bin/grep", "/usr/bin/grep", "/bin/fgrep", "/usr/bin/fgrep", "/bin/egrep", "/usr/bin/egrep", "/bin/rg", "/usr/bin/rg", "/bin/sed", "/usr/bin/sed", "/bin/awk", "/usr/bin/awk", "/bin/sort", "/usr/bin/sort", "/bin/uniq", "/usr/bin/uniq", "/bin/comm", "/usr/bin/comm", "/bin/cut", "/usr/bin/cut", "/bin/paste", "/usr/bin/paste", "/bin/tr", "/usr/bin/tr", "/bin/rev", "/usr/bin/rev", "/bin/nl", "/usr/bin/nl", "/bin/fold", "/usr/bin/fold", "/bin/expand", "/usr/bin/expand", "/bin/unexpand", "/usr/bin/unexpand", "/bin/strings", "/usr/bin/strings", "/bin/split", "/usr/bin/split", "/bin/column", "/usr/bin/column", "/bin/join", "/usr/bin/join", "/bin/tee", "/usr/bin/tee", "/bin/find", "/usr/bin/find", "/bin/basename", "/usr/bin/basename", "/bin/dirname", "/usr/bin/dirname", "/bin/tree", "/usr/bin/tree", "/bin/du", "/usr/bin/du", "/bin/env", "/usr/bin/env", "/bin/printenv", "/usr/bin/printenv", "/bin/alias", "/usr/bin/alias", "/bin/unalias", "/usr/bin/unalias", "/bin/history", "/usr/bin/history", "/bin/xargs", "/usr/bin/xargs", "/bin/true", "/usr/bin/true", "/bin/false", "/usr/bin/false", "/bin/yes", "/usr/bin/yes", "/bin/clear", "/usr/bin/clear", "/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/bin/jq", "/usr/bin/jq", "/bin/base64", "/usr/bin/base64", "/bin/diff", "/usr/bin/diff", "/bin/date", "/usr/bin/date", "/bin/sleep", "/usr/bin/sleep", "/bin/timeout", "/usr/bin/timeout", "/bin/time", "/usr/bin/time", "/bin/seq", "/usr/bin/seq", "/bin/expr", "/usr/bin/expr", "/bin/md5sum", "/usr/bin/md5sum", "/bin/sha1sum", "/usr/bin/sha1sum", "/bin/sha256sum", "/usr/bin/sha256sum", "/bin/file", "/usr/bin/file", "/bin/html-to-markdown", "/usr/bin/html-to-markdown", "/bin/help", "/usr/bin/help", "/bin/which", "/usr/bin/which", "/bin/tac", "/usr/bin/tac", "/bin/hostname", "/usr/bin/hostname", "/bin/whoami", "/usr/bin/whoami", "/bin/od", "/usr/bin/od", "/bin/gzip", "/usr/bin/gzip", "/bin/gunzip", "/usr/bin/gunzip", "/bin/zcat", "/usr/bin/zcat"]

private def utf8Json (bytes : List UInt8) : Json :=
  Json.mkObj [("$bytes", toJson (Rt.base64 bytes))]

private def bytesOf (j : Json) : List UInt8 :=
  (bytes j).toList

private def u32Bytes (n : Nat) : List UInt8 :=
  [(n / 16777216 % 256).toUInt8, (n / 65536 % 256).toUInt8, (n / 256 % 256).toUInt8, (n % 256).toUInt8]

/-- One pass of the `for (const path of paths)` loop of `packState`. -/
private def packEntries (cwd : String) (cwdInUse : Bool) :
    List String → List String → List (List UInt8) → Prog (List String × List (List UInt8))
  | [], entries, blobs => pure (entries.reverse, blobs.reverse)
  | path :: rest, entries, blobs => do
    if path == cwd && !cwdInUse then return ← packEntries cwd cwdInUse rest entries blobs
    let stat ← Prog.effect "fs.lstat" [toJson path]
    let quoted := Tools.jsonQuote path
    if truthy (get stat "isSymbolicLink") then
      let target ← Prog.effect "fs.readlink" [toJson path]
      let entry := s!"\{\"path\":{quoted},\"kind\":\"link\",\"target\":{Tools.jsonQuote (text target)}}"
      packEntries cwd cwdInUse rest (entry :: entries) blobs
    else if truthy (get stat "isDirectory") then
      let entry := s!"\{\"path\":{quoted},\"kind\":\"dir\",\"mode\":{text (get stat "mode")}}"
      packEntries cwd cwdInUse rest (entry :: entries) blobs
    else
      let data ← Prog.effect "fs.readFileBuffer" [toJson path]
      let blob := bytesOf data
      let entry :=
        s!"\{\"path\":{quoted},\"kind\":\"file\",\"mode\":{text (get stat "mode")},\"mtime\":{text (get (get stat "mtime") "$date")},\"size\":{blob.length}}"
      packEntries cwd cwdInUse rest (entry :: entries) (blob :: blobs)

/-- `packState`: a 4-byte big-endian header length, the JSON header, then the file bodies. -/
private def packState (call : Json) : Prog Json := do
  let cwd := text (Twin.callArg call 1)
  let all ← Prog.effect "fs .getAllPaths"
  let paths := ((items all).map text).filter (fun p => !defaultPaths.contains p)
  let paths := paths.mergeSort (fun a b => a ≤ b)
  let cwdInUse := paths.any (fun p => Tools.isPrefix p (cwd ++ "/"))
  let (entries, blobs) ← packEntries cwd cwdInUse paths [] []
  if entries.isEmpty then return .null
  let header := ("[" ++ String.intercalate "," entries ++ "]").toUTF8.toList
  let bodyLength := blobs.foldl (fun total blob => total + blob.length) 0
  let zeroed := List.replicate (4 + header.length + bodyLength) (0 : UInt8)
  let _ ← Prog.effect "new DataView" [utf8Json zeroed]
  let _ ← Prog.effect "new DataView(packed.buffer).setUint32" [toJson (0 : Nat), toJson header.length]
  return utf8Json (u32Bytes header.length ++ header ++ blobs.flatten)

private def voidJson : Json := Twin.undefinedJson

/-- The loopback branch of `microvmUpstreamUrl`. The AWS branch has no recording. -/
private def microvmUpstreamUrl (call : Json) : Prog Json := do
  let endpoint := text (Twin.callArg call 0)
  let search := text (Twin.callArg call 1)
  let raw := if Tools.contains endpoint "://" then endpoint else "wss://" ++ endpoint
  match raw.splitOn "://" with
  | [scheme, rest] =>
    if Twin.callArg call 2 != toJson true then
      return ← Prog.unsupported "AWS endpoint branch has no recording"
    let authority := ((rest.splitOn "/").headD "")
    let hostname := ((authority.splitOn ":").headD "")
    if scheme != "ws" || hostname != "127.0.0.1" then
      return ← Prog.throwError "Error" "Insecure MicroVM proxy upstream must be loopback ws"
    return toJson s!"ws://{authority}/{search}"
  | _ => Prog.unsupported "endpoint with more than one scheme separator"

/-- `burstHeader`: zod keeps the two totals when both are numbers and drops any other key. -/
private def burstHeader (call : Json) : Prog Json := do
  let headers := items (get (Twin.callArg call 0) "$headers")
  let found := headers.findSome? fun h =>
    if Twin.arg h 0 == toJson "x-sandbox-burst" then some (text (Twin.arg h 1)) else none
  match found with
  | none => return voidJson
  | some value =>
    match Json.parse value with
    | .error _ => return voidJson
    | .ok parsed =>
      let checked ← Prog.effect "burstTotals.safeParse" [parsed]
      if get checked "success" == toJson true then return get checked "data" else return voidJson

/-- `assertSandboxReachesWorkspace`. -/
private def assertSandboxReachesWorkspace (call : Json) : Prog Json := do
  let name := text (Twin.callArg call 0)
  let sandbox := Twin.callArg call 1
  if Twin.callArg call 3 == toJson true then
    if truthy sandbox then
      let holds ← Prog.effect "sandboxHoldsWorkspace" [toJson "disk", sandbox]
      if truthy holds then return voidJson
    return ← Prog.throwError "Error"
      s!"Workspace \"{name}\": a \"disk\" workspace lives on its sandbox's own disk: give it a worker sandbox with persistent: true"
  let denied (provider : String) : Prog Json :=
    Prog.throwError "Error"
      s!"Workspace \"{name}\" cannot run on a {provider} sandbox; give it its own sandbox or set sandbox: null"
  if truthy sandbox then
    let provider := get sandbox "provider"
    let mounts ← Prog.effect "supportsS3WorkspaceMount" [provider, get sandbox "options"]
    if !truthy mounts then return ← denied (text provider)
    let fallbackProvider := get sandbox "fallbackProvider"
    if truthy fallbackProvider then
      let fallbackMounts ← Prog.effect "supportsS3WorkspaceMount" [fallbackProvider, voidJson]
      if !truthy fallbackMounts then return ← denied (text fallbackProvider)
  if get sandbox "provider" == toJson "lambda" &&
      get (get sandbox "network") "mode" != toJson "allow-all" &&
      truthy (Twin.callArg call 2) then
    return ← Prog.throwError "Error"
      s!"Workspace \"{name}\" uses its own bucket, which a lambda sandbox reaches only with network allow-all; set that or sandbox: null"
  return voidJson

/-- `THROWAWAY_NOTE` in `bash.tool.ts`. -/
private def throwawayNote : String :=
  "Nothing written there reaches durable storage, so use it for throwaway work"

private def sandboxParamSchema (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let choices := items (← Prog.effect "sandboxParamChoices" [context])
  if choices.isEmpty then return voidJson
  let ignores := if (items (get context "workspaces")).isEmpty then "" else " When set, `workspace` is ignored."
  return Json.mkObj
    [("type", toJson "string"),
     ("enum", Json.arr (choices.map (get · "name")).toArray),
     ("description", toJson s!"Sandbox to run on, with no workspace mounted. {throwawayNote}.{ignores}")]

/-- NFKD with combining marks removed, for the ranges `Tools.foldTable` covers. -/
private def foldChar (c : Char) : Option String :=
  let n := c.toNat
  if n < 128 then some (String.singleton c)
  else if 0x300 ≤ n && n ≤ 0x36f then some ""
  else if n ≤ 0x24f || (0x1e00 ≤ n && n ≤ 0x1eff) then
    let line := (Tools.foldTable.splitOn "\n").find? (fun l => l.toList.head? == some c)
    some (match line with
      | some l => String.ofList (l.toList.drop 1)
      | none => "-")
  else none

private def trimDashes (chars : List Char) : List Char :=
  ((chars.dropWhile (· == '-')).reverse.dropWhile (· == '-')).reverse

private def memorySlugTwin (call : Json) : Prog Json := do
  let title := text (Twin.callArg call 0)
  match title.toList.mapM foldChar with
  | none => Prog.unsupported "a character outside the folding table's ranges"
  | some parts =>
    let step (out : List Char) (c : Char) : List Char :=
      if ('a' ≤ c ∧ c ≤ 'z') ∨ ('0' ≤ c ∧ c ≤ '9') then c :: out
      else match out with
        | '-' :: _ => out
        | _ => '-' :: out
    let lowered := (String.join parts).toList.map Char.toLower
    let kebab := trimDashes (lowered.foldl step []).reverse
    let slug := ((kebab.take 60).reverse.dropWhile (· == '-')).reverse
    if !slug.isEmpty && slug == kebab then return toJson (String.ofList slug)
    let _ ← Prog.effect "createHash" [toJson "sha256"]
    let _ ← Prog.effect "createHash(\"sha256\") .update" [toJson title, toJson "utf8"]
    let digest ← Prog.effect "createHash(\"sha256\") .update(title, \"utf8\") .digest" [toJson "hex"]
    let hash := String.ofList ((text digest).toList.take 8)
    return toJson (if slug.isEmpty then s!"memory-{hash}" else s!"{String.ofList slug}-{hash}")

private def occupySandbox (call : Json) : Prog Json := do
  let key := Twin.callArg call 0
  let event := Twin.callArg call 1
  let entries := items (get (Twin.moduleValue call "occupants") "$map")
  let holders := entries.find? (fun entry => Twin.arg entry 0 == key)
  let held := holders.map (fun entry => items (get (Twin.arg entry 1) "$map")) |>.getD []
  let now ← Prog.effect "Date.now"
  let occupant := Twin.callArg call 2
  let fields := occupant.getObj?.toOption.map (·.toList) |>.getD []
  let value := Json.mkObj (fields.filter (fun pair => pair.1 != "since") ++ [("since", now)])
  let pair := Json.arr #[event, value]
  let updated := if held.any (fun entry => Twin.arg entry 0 == event) then
      held.map (fun entry => if Twin.arg entry 0 == event then pair else entry)
    else held ++ [pair]
  let outer := Json.arr #[key, Json.mkObj [("$map", Json.arr updated.toArray)]]
  let updatedEntries := if holders.isSome then
      entries.map (fun entry => if Twin.arg entry 0 == key then outer else entry)
    else entries ++ [outer]
  Prog.setState "module.occupants" (Json.mkObj [("$map", Json.arr updatedEntries.toArray)])
  return Json.mkObj [("$fn", toJson "")]

/-- `EXECUTORS` keys in `sandbox/index.ts`. -/
private def executorProviders : List String :=
  ["cloudflare", "custom", "daytona", "e2b", "lambda", "machine", "sandbox", "vercel", "worker"]

private def providerExecutor (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let provider := get config "provider"
  if !executorProviders.contains (text provider) then
    return ← Prog.throwError "Error" s!"sandbox provider {text provider} is not supported"
  Prog.effect "EXECUTORS[config.provider]" [config]

private def machinesNote (args : Json) : Json :=
  let entries := (items (Twin.arg args 0)).map fun machine =>
    let description := get machine "description"
    s!"  - {text (get machine "name")}" ++ (if truthy description then s!": {text description}" else "")
  toJson ("You can reach more than one computer, each with its own screen. Pass `sandbox` with the one to act on, and take a screenshot after switching, since coordinates never carry from one screen to another:\n" ++
    String.intercalate "\n" entries)

/-- `delay`: the promise's executor is entered, then arms the timer with `resolve`. -/
private def delayTwin (call : Json) : Prog Json := do
  Prog.drain (fun _ _ => pure ()) 1
  let _ ← Prog.effect "setTimeout" [Json.mkObj [("$fn", toJson "")], Twin.callArg call 0]
  return voidJson

/-- `evictToCap` below the cap. Above it the function only mutates a map no recording shows. -/
private def evictToCap (call : Json) : Prog Json :=
  if (items (get (Twin.callArg call 0) "$map")).length < 512 then pure voidJson
  else Prog.unsupported "eviction at the cap has no recording"

private def backgroundLoop : List Json → Prog Bool
  | [] => pure false
  | workspace :: rest => do
    let supports ← Prog.effect "sandboxSupportsBackgroundJobs" [get workspace "sandbox"]
    if truthy supports then pure true else backgroundLoop rest

private def backgroundAvailable (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  if !truthy (get context "background") then return toJson false
  return toJson (← backgroundLoop (items (get context "workspaces")))

/-- `USAGE_PROBE` in `live-status.ts`. -/
private def usageProbe : String :=
  "; ".intercalate
    ["echo \"cpus $(nproc 2>/dev/null)\"",
     "echo \"load $(cut -d' ' -f1 /proc/loadavg 2>/dev/null)\"",
     "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print \"mem\", t, a}' /proc/meminfo 2>/dev/null",
     "df -Pk / 2>/dev/null | awk 'NR==2{print \"disk\", $2, $3}'"]

/-- `reportSandboxUsage`: the probe races the abort signal, and any failure is swallowed. -/
private def reportSandboxUsage (call : Json) : Prog Json := do
  let onUsage := Twin.callArg call 1
  let abortSignal := Twin.callArg call 2
  if !truthy onUsage || Twin.abortedRead call 0 then return voidJson
  let deadline ← Prog.effect "AbortSignal.timeout" [toJson (3000 : Nat)]
  let signal ←
    if truthy abortSignal then Prog.effect "AbortSignal.any" [.arr #[abortSignal, deadline]]
    else pure deadline
  Prog.drain (fun label _ =>
    if label == "arg0" then do
      let _ ← Prog.effect "signal.addEventListener"
        [toJson "abort", Json.mkObj [("$fn", toJson "")], Json.mkObj [("once", toJson true)]]
    else Prog.unsupported s!"callback {label}") 1
  let result ← Prog.attempt "session.runCommand"
    [Json.mkObj [("command", toJson usageProbe), ("abortSignal", signal)]]
  match result with
  | .ok value =>
    Prog.catchFail
      (do
        if get value "exitCode" == toJson (0 : Nat) then
          let usage ← Prog.effect "parseSandboxUsage" [get value "stdout"]
          let _ ← Prog.effect "onUsage" [usage]
        return voidJson)
      (fun error =>
        if (error.getObjVal? "$unsupported").isOk then .fail error else pure voidJson)
  | _ => return voidJson

private def stringProp (description : String) : Json :=
  Json.mkObj [("type", toJson "string"), ("description", toJson description)]

/-- An object schema, plus the optional `workspace` property. -/
private def toolSchema (context : Json) (props : List (String × Json)) (required : List String) :
    Prog Json := do
  let workspace ← Prog.effect "workspaceParamSchema" [get context "workspaces"]
  let extra := if truthy workspace then [("workspace", workspace)] else []
  return Json.mkObj
    [("type", toJson "object"),
     ("properties", Json.mkObj (props ++ extra)),
     ("required", toJson required),
     ("additionalProperties", toJson false)]

private def boolProp (description : String) : Json :=
  Json.mkObj [("type", toJson "boolean"), ("description", toJson description)]

private def grepInputSchema (call : Json) : Prog Json :=
  toolSchema (Twin.callArg call 0)
    [("pattern", stringProp "Regular expression to search for."),
     ("path", stringProp "File or directory to search, relative to the workspace root. Defaults to the root."),
     ("glob", stringProp "Glob to filter files, e.g. `*.ts` or `**/*.py`."),
     ("output_mode", Json.mkObj
       [("type", toJson "string"),
        ("enum", toJson ["content", "files_with_matches", "count"]),
        ("description", toJson "content: matching lines; files_with_matches: file paths (default); count: match counts.")]),
     ("case_insensitive", boolProp "Case-insensitive search."),
     ("line_numbers", boolProp "Include line numbers (content mode).")]
    ["pattern"]

private def memoryInputSchema (call : Json) : Prog Json :=
  toolSchema (Twin.callArg call 0)
    [("title", stringProp "Short title of the fact; it becomes the entry's file name (kebab-cased)."),
     ("description", stringProp "One-line summary, shown in the MEMORY.md index and used to decide relevance later."),
     ("content", stringProp "The memory itself (markdown). One fact per entry."),
     ("type", Json.mkObj
       [("type", toJson "string"),
        ("enum", toJson ["user", "feedback", "project", "reference"]),
        ("description", toJson "Kind of memory: \"user\" for who a person is, \"feedback\" for guidance or corrections on how to behave, \"project\" for ongoing work or goals, \"reference\" for pointers to resources. Defaults to \"project\".")])]
    ["title", "description", "content"]

private def globInputSchema (call : Json) : Prog Json :=
  toolSchema (Twin.callArg call 0)
    [("pattern", stringProp "Glob pattern, e.g. `**/*.ts` or `src/**/*.py`."),
     ("path", stringProp "Directory to search in, relative to the workspace root. Defaults to the root.")]
    ["pattern"]

private def buildRunSubagentInputSchema (args : Json) : Json :=
  let base : List (String × Json) :=
    [("agentId", stringProp "Exact predefined subagent id to use. Include it when a listed subagent is suitable; omit it only for a virtual subagent, which runs on your own config."),
     ("prompt", stringProp "The task prompt for the subagent."),
     ("isolated", boolProp "Give a coding subagent a machine of its own for this new conversation instead of the machine its other conversations share. Only when the work needs it: untrusted code or secrets that must not reach other tasks, installs or services that would clash, or tests that other work in parallel could contaminate. Ignored when resuming.")]
  let extra : List (String × Json) :=
    if Twin.arg args 0 == toJson "persistent" then
      [("conversationKey", stringProp "A conversationKey an earlier run_subagent call returned, to resume that child. Omit to start a new persistent conversation.")]
    else []
  Json.mkObj
    [("type", toJson "object"),
     ("properties", Json.mkObj [("tasks", Json.mkObj
       [("type", toJson "array"),
        ("minItems", toJson (1 : Nat)),
        ("maxItems", toJson (10 : Nat)),
        ("items", Json.mkObj
          [("type", toJson "object"),
           ("properties", Json.mkObj (base ++ extra)),
           ("required", toJson ["prompt"]),
           ("additionalProperties", toJson false)])])]),
     ("required", toJson ["tasks"]),
     ("additionalProperties", toJson false)]

private def globScript (args : Json) : Json :=
  match Tools.globScriptParts with
  | [a, b, c] => toJson (a ++ text (Twin.arg args 0) ++ b ++ text (Twin.arg args 1) ++ c)
  | _ => Twin.unsupported "glob script layout"

/-- `fileOperationScript`: the operation's keys in their order, with `path` replaced in place. -/
private def fileOperationScript (call : Json) : Prog Json := do
  let operation := Twin.callArg call 0
  let path ← Prog.effect "toWorkspaceRelative" [get operation "path"]
  if path == toJson "." then
    return ← Prog.throwError "Error" "Error: path must reference a file"
  let keys := ["type", "path", "diff", "line", "text"]
  let fields := Tools.withoutKeys operation ["$keys"]
  if !(Tools.entries fields).all (keys.contains ·.1) then
    return ← Prog.unsupported "an operation key outside the model"
  let replaced := Tools.spread fields (Json.mkObj [("path", path)])
  match Tools.stringifyDeclared keys replaced with
  | .error _ => Prog.unsupported "operation cannot be serialised"
  | .ok payload =>
    let encoded ← Prog.effect "toBase64" [toJson payload]
    return toJson (s!"node -e \"$(printf '%s' '{Tools.toBase64 Tools.applyScript}' | base64 -d)\" <<'BROODS_OP'\n{text encoded}\nBROODS_OP")


private def zodSchema (name : String) : Json := Json.mkObj [("$opaque", toJson name)]

private def errorFieldsSchema : Json := zodSchema "ZodMiniObject"
private def recordSchema : Json := zodSchema "ZodMiniRecord"
private def factorySchema : Json := zodSchema "ZodMiniCustom"

private def splitWhitespace (line : String) : List String :=
  (line.split (fun c => c == ' ' || c == '\t' || c == '\r')).toList.map (·.toString) |>.filter (· != "")

/-- `Number(token)`, or none for the values the recorder writes as tags. -/
private def numberToken (token : String) : Option Json :=
  match Rt.jsNumber token with
  | .exact value => some (.num value)
  | _ => none

private def usageFields (stdout : String) : Option (List (String × List Json)) :=
  (stdout.splitOn "\n").foldlM (init := []) fun fields line =>
    match splitWhitespace line with
    | [] => some fields
    | key :: values => do
      let numbers ← values.mapM numberToken
      pure ((key, numbers) :: fields.filter (·.1 != key))

private def isReadingEffect (value : Json) : Prog Bool := do
  return truthy (← Prog.effect "isReading" [value])

private def jsRound (x : Float) : Json := numberJson (x + 0.5).floor

/-- `a / den` as JavaScript prints it: the fewest decimals that read back as the same double. -/
private def shortestRatio (a den : Nat) : Json :=
  let target := Float.ofNat a / Float.ofNat den
  let digits := (List.range 18).findSome? fun dp =>
    let m := (a * 10 ^ dp + den / 2) / den
    if Float.ofScientific m true dp == target then some (m, dp) else none
  match digits with
  | some (m, dp) => .num (Rt.numNormal ⟨(m : Int), dp⟩)
  | none => .null

/-- `parseSandboxUsage`: a key seen twice keeps its last line. -/
private def parseSandboxUsage (call : Json) : Prog Json := do
  match usageFields (text (Twin.callArg call 0)) with
  | none => Prog.unsupported "a reading that is not a finite number"
  | some fields =>
    let field (key : String) : List Json := ((fields.find? (·.1 == key)).map (·.2)).getD []
    let at_ (values : List Json) (i : Nat) : Json := values.getD i Twin.undefinedJson
    let cpus := at_ (field "cpus") 0
    let load1 := at_ (field "load") 0
    let mem := field "mem"
    let disk := field "disk"
    let mut usage : List (String × Json) := []
    if ← isReadingEffect cpus then usage := ("cpus", cpus) :: usage
    if ← isReadingEffect load1 then usage := ("load1", load1) :: usage
    if (← isReadingEffect (at_ mem 0)) then
      if (← isReadingEffect (at_ mem 1)) then
        let total := numeric (at_ mem 0)
        usage := ("memoryTotalMb", jsRound (total / 1024)) ::
          ("memoryUsedMb", jsRound ((total - numeric (at_ mem 1)) / 1024)) :: usage
    if (← isReadingEffect (at_ disk 0)) then
      if (← isReadingEffect (at_ disk 1)) then
        let gigabytes (value : Json) : Json :=
          shortestRatio (value.getNat?.toOption.getD 0) 1048576
        let total ← Prog.effect "roundTenth" [gigabytes (at_ disk 0)]
        let used ← Prog.effect "roundTenth" [gigabytes (at_ disk 1)]
        usage := ("diskTotalGb", total) :: ("diskUsedGb", used) :: usage
    return Json.mkObj usage

private def sweepKey : String := "sandbox-sweep"

private def reservationId (one : Json) : String :=
  s!"{text (get one "provider")}:{text (get one "reservationKey")}"

/-- The `finally` of `sweepAccount`. A failed lease release is only logged. -/
private def sweepCleanup (accountId : Json) (pending : List Json) : Prog Unit := do
  let _ ← Prog.effect "deferAttempted" [accountId, Json.arr pending.toArray]
  match ← Prog.attempt "runtime .mutate"
      [toJson "releaseClaim", Json.mkObj [("accountId", accountId), ("key", toJson sweepKey)]] with
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    pure ()
  | _ => pure ()

private def sweepAccount (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let reservations := Twin.callArg call 1
  let claim ← Prog.attempt "runtime.mutate"
    [toJson "claimEvent",
     Json.mkObj [("accountId", accountId), ("key", toJson sweepKey), ("ttlSeconds", toJson (300 : Nat))]]
  match claim with
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    let _ ← Prog.effect "deferAttempted" [accountId, reservations]
    return toJson (0 : Nat)
  | .pending => Prog.unsupported "claim never finished"
  | .ok leased =>
    if !truthy leased then return toJson (0 : Nat)
    match ← Prog.attempt "releaseExpiredSandboxes" [accountId, reservations] with
    | .ok released =>
      let done := (items released).map reservationId
      let pending := (items reservations).filter fun one => !done.contains (reservationId one)
      sweepCleanup accountId pending
      return toJson (items released).length
    | .threw error _ =>
      sweepCleanup accountId (items reservations)
      throw error
    | .pending => Prog.unsupported "release never finished"

/-- The glob's literal directory, `/^([^!*?[{]+)\/(?:\*\*\/)?[^/]+$/`. -/
private def globRoot : Tools.Re :=
  Tools.Re.seqs
    [.bol, .group 1 (Tools.Re.plus (Tools.Re.noneOf "!*?[{")), Tools.Re.lit "/",
     Tools.Re.opt (Tools.Re.lit "**/"), Tools.Re.plus (Tools.Re.noneOf "/"), .eol]

private def searchCommand (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let mode := fallback (get input "output_mode") (toJson "files_with_matches")
  let flags :=
    (if truthy (get input "case_insensitive") then ["-i"] else []) ++
    (if mode == toJson "files_with_matches" then ["-l"]
     else if mode == toJson "count" then ["-c"]
     else if truthy (get input "line_numbers") then ["-n"] else [])
  let path ← if truthy (get input "path") then
      (some ∘ text) <$> Prog.effect "toWorkspaceRelative" [get input "path"]
    else pure none
  let glob := if truthy (get input "glob") then some (text (get input "glob")) else none
  let root := path <|> Tools.Re.firstGroup globRoot (if nullish (get input "glob") then "" else text (get input "glob"))
  let inside := (root.map (·.splitOn "/")).getD []
  let pattern := text (get input "pattern")
  let rg := ["rg"] ++ flags ++ (match glob with | some g => ["-g", g] | none => []) ++
    ["-e", pattern] ++ (match path with | some p => ["--", p] | none => [])
  let globFlag ← match glob with
    | some g => (fun f => [text f]) <$> Prog.effect "grepGlobFlag" [toJson g]
    | none => pure []
  let grep := ["grep", "-rIE"] ++
    ([".git", "node_modules"].filter (!inside.contains ·)).map (s!"--exclude-dir={·}") ++
    flags ++ globFlag ++ ["-e", pattern] ++ (match root with | some r => ["--", r] | none => [])
  let quoted (words : List String) := String.intercalate " " (words.map Tools.shellQuote)
  return toJson s!"if command -v rg >/dev/null 2>&1; then {quoted rg}; else {quoted grep}; fi"

private def pinnedKey (sandbox : Json) : Option String :=
  match get (get sandbox "options") "reservationKey" with
  | .str value => let trimmed := value.trimAscii.toString; if trimmed.isEmpty then none else some trimmed
  | _ => none

private def agentSandboxReservation (call : Json) : Prog Json := do
  let sandbox := Twin.callArg call 0
  let accountId := Twin.callArg call 1
  let agentId := Twin.callArg call 2
  if get sandbox "persistent" != toJson true || !truthy accountId then return voidJson
  match pinnedKey sandbox with
  | some pinned => Prog.effect "pinnedSandboxReservationKey" [accountId, toJson pinned]
  | none =>
    if !truthy agentId then return voidJson
    Prog.effect "agentSandboxReservationKey" [accountId, agentId, Twin.callArg call 3]

private def readFileChunk (call : Json) : Prog Json := do
  let path := Twin.callArg call 1
  let offset := (Twin.callArg call 2).getNat?.toOption.getD 0
  let signal := Twin.callArg call 3
  let q := text (← Prog.effect "shellQuote" [path])
  let result ← Prog.effect "executor.exec"
    [toJson s!"if [ -f {q} ]; then stat -c '%s %i %z' {q}; tail -c +{offset + 1} {q} | head -c 184320 | base64 | tr -d '\\n'; elif [ ! -e {q} ]; then exit 44; else exit 45; fi",
     if truthy signal then Json.mkObj [("abortSignal", signal)] else voidJson]
  let code := get result "exitCode"
  if code == toJson (44 : Nat) then return .null
  if code != toJson (0 : Nat) then
    return ← Prog.fail (← Prog.effect "shellProcessError" [toJson "read file", result])
  let lines := (text (get result "stdout")).splitOn "\n"
  let encoded := (lines.getD 1 "").trimAscii.toString
  return Json.mkObj
    [("bytes", utf8Json ((Tools.fromBase64 encoded).toList.map UInt8.ofNat)),
     ("stamp", toJson (lines.getD 0 ""))]

private def formatSandboxStatus (call : Json) : Prog Json := do
  let status := Twin.callArg call 0
  let specs := get status "specs"
  let disk :=
    if missing (get specs "storageGb") then "" else s!", {text (get specs "storageGb")} GB disk"
  let specsText ←
    if truthy specs then do
      let memory ← Prog.effect "formatMegabytes" [get specs "memoryMb"]
      pure s!", {text (get specs "vcpu")} vCPU, {text memory} RAM{disk}"
    else pure ""
  let shared := truthy (get status "shared")
  let sharing :=
    if shared then "shared: other conversations of this agent run on it too, each in its own folder"
    else "isolated: only this conversation runs on it"
  let neighbours := items (get status "neighbours")
  let names := neighbours.map fun one =>
    if nullish (get one "agentId") then "unknown agent" else text (get one "agentId")
  let others :=
    if neighbours.isEmpty then "none"
    else s!"{neighbours.length} ({String.intercalate ", " names})"
  let machine ←
    if missing (get status "state") && missing (get status "usage") then pure []
    else do
      let now ← Prog.effect "formatMachineNow" [status]
      pure [s!"machine now: {text now}"]
  return toJson
    ([s!"your machine: {text (get status "name")} ({text (get status "provider")}{specsText}), {sharing}"] ++
     machine ++ [s!"other runs on it now: {others}"] ++
     (if shared && !neighbours.isEmpty then
       ["stay in your own folder, leave processes and ports you did not start alone, and expect CPU and memory to be shared"]
      else []))

private def factoryIdTwin (call : Json) : Prog Json := do
  let factory ← Prog.effect "parseOr" [factorySchema, Twin.callArg call 0]
  if !truthy factory then return voidJson
  match ← Prog.attempt "factory" [Json.mkObj []] with
  | .ok built => return if get built "type" == toJson "provider" then get built "id" else voidJson
  | .threw _ _ => return voidJson
  | .pending => Prog.unsupported "factory never finished"

private def providerToolArgs (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  if get config "type" == toJson "provider" || get config "type" == toJson "provider-defined" then
    Prog.effect "parseOr" [recordSchema, get config "args", Json.mkObj []]
  else pure config

/-- `/no (available )?runners?/i` over the error's message, or the error if it is a string. -/
private def isNoRunnersError (call : Json) : Prog Json := do
  let error := Twin.callArg call 0
  let fields ← Prog.effect "parseOr" [errorFieldsSchema, error]
  let message :=
    match get fields "message", error with
    | .str m, _ => m
    | _, .str m => m
    | _, _ => ""
  let lowered := Rt.lowerAscii message
  return toJson (Tools.contains lowered "no runner" || Tools.contains lowered "no available runner")

private def backgroundNote (call : Json) : Prog Json := do
  if !truthy (← Prog.effect "backgroundAvailable" [Twin.callArg call 0]) then return toJson ""
  return toJson "\n- Set background:true for long-running commands in a reserved workspace; the result is delivered back automatically when it finishes, and you can check on it with async_status."

private def bashInputSchema (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let workspace ← Prog.effect "workspaceParamSchema" [get context "workspaces"]
  let sandboxProp ← Prog.effect "sandboxParamSchema" [context]
  let background ← Prog.effect "backgroundAvailable" [context]
  let props : List (String × Json) :=
    [("command", stringProp "The bash command to run."),
     ("pty", boolProp "Run the command attached to a real interactive TTY (pseudo-terminal). Use when a program refuses to run or degrades without a terminal (isatty checks, TTY-only prompts, terminal UIs). Note: stderr merges into stdout and lines end with CRLF.")] ++
    (if truthy workspace then [("workspace", workspace)] else []) ++
    (if truthy sandboxProp then [("sandbox", sandboxProp)] else []) ++
    (if truthy background then
      [("background", boolProp "Run the command as a detached background job in the reserved sandbox and return immediately with a statusId. Use for long-running tasks in the background. The result is delivered back into the conversation automatically when the job finishes; you can also check progress meanwhile with async_status.")]
     else [])
  return Json.mkObj
    [("type", toJson "object"),
     ("properties", Json.mkObj props),
     ("required", toJson ["command"]),
     ("additionalProperties", toJson false)]

private def reservedStandaloneNote (call : Json) : Prog Json := do
  if !truthy (← Prog.effect "isReservedStandalone" [Twin.callArg call 0]) then return toJson ""
  return toJson " That sandbox is reserved, so its own filesystem does survive between calls until the reservation ends — but only the workspace outlives it."

/-- `agentSandboxStatus` up to the early return; a reserved entry reads the occupant map. -/
private def agentSandboxStatus (call : Json) : Prog Json := do
  let entry := Twin.callArg call 0
  let sandbox := get entry "sandbox"
  let key ← Prog.effect "configString" [get (get sandbox "options") "reservationKey"]
  if !truthy entry || get sandbox "persistent" != toJson true || !truthy key then return voidJson
  let specs ← Prog.effect "configuredSandboxSpecs" [sandbox]
  let neighbours ← Prog.effect "sandboxNeighbours" [key, Twin.callArg call 1]
  return Json.mkObj
    ((if missing specs then [] else [("specs", specs)]) ++
     [("name", get entry "name"), ("provider", get sandbox "provider"),
      ("shared", toJson true), ("neighbours", neighbours)])

private def stringRecord (call : Json) : Prog Json := do
  let parsed ← Prog.effect "parseOr" [recordSchema, Twin.callArg call 0, Json.mkObj []]
  return Json.mkObj ((Tools.entries parsed).filter fun (_, value) =>
    match value with | .str _ => true | _ => false)

private def identityEnvKeys : List String :=
  ["BROODS_ACCOUNT_ID", "BROODS_AGENT_ID", "BROODS_BASE_URL", "BROODS_RUN_TOKEN"]

/-- `RESERVED_SANDBOX_ENV_KEYS` in `sandbox/utils.ts`. -/
private def reservedEnvKeys : List String :=
  identityEnvKeys ++ ["BASH_ENV", "ENV", "HOME", "LD_AUDIT", "LD_LIBRARY_PATH", "LD_PRELOAD", "LOGNAME", "NODE_OPTIONS", "PATH", "PROMPT_COMMAND", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "SHELL", "TMPDIR", "USER", "__CB_CODE", "__CB_LOG", "__CB_TOKEN", "__CB_URL"]

private def mergeSandboxEnv (call : Json) : Prog Json := do
  let account ← Prog.effect "stringRecord" [Twin.callArg call 0]
  let layers := Twin.callArg call 1
  let principal := get layers "principal"
  let request := get layers "requestEnv"
  let requestPairs := if missing request then [] else Tools.entries request
  let overrides := requestPairs.filter (!reservedEnvKeys.contains ·.1)
  let accountPairs := (Tools.entries account).filter (!identityEnvKeys.contains ·.1)
  let principalPairs ←
    if truthy principal then Tools.entries <$> Prog.effect "principalEnv" [principal]
    else pure []
  return Json.mkObj (accountPairs ++ overrides ++ principalPairs)

private def verifyTerminalToken (call : Json) : Prog Json := do
  let apiKey := Twin.callArg call 0
  let now := Twin.callArg call 3
  if !truthy apiKey then return toJson false
  match (text (Twin.callArg call 1)).splitOn "." with
  | ["tt1", expiry, signature] =>
    if expiry.isEmpty || signature.isEmpty then return toJson false
    match Rt.jsNumber expiry, now with
    | .exact value, .num nowValue =>
      match Rt.intOf value with
      | some whole =>
        if whole.natAbs > 9007199254740991 || Rt.numLe value nowValue then return toJson false
        let outcomes ← Prog.all
          [("crypto.subtle.digest", [toJson "SHA-256", byteJson signature.toUTF8]),
           ("mac", [apiKey, Twin.callArg call 2, .num value])]
        match outcomes with
        | [.ok given, .ok macText] =>
          let expected ← Prog.effect "crypto.subtle.digest"
            [toJson "SHA-256", byteJson (text macText).toUTF8]
          Prog.effect "timingSafeEqual" [given, expected]
        | _ => Prog.unsupported "a failed digest has no recording"
      | none => return toJson false
    | _, _ => return toJson false
  | _ => return toJson false

private def mountS3Bucket (call : Json) : Prog Json := do
  let sandbox := Twin.callArg call 0
  let mount := Twin.callArg call 1
  let mountPath := Twin.callArg call 2
  let quote : Prog String := text <$> Prog.effect "shellQuote" [mountPath]
  let run (command : String) : Prog Unit := do
    let _ ← Prog.effect "executeDaytonaSetupCommand" [sandbox, toJson command]
  run s!"sudo mkdir -p {← quote}"
  run s!"sudo chown \"$(id -u)\":\"$(id -g)\" {← quote}"
  let option (flag key : String) : List String :=
    if truthy (get mount key) then [flag, text (get mount key)] else []
  let words := ["--allow-delete", "--allow-overwrite", "--allow-other"] ++
    option "--prefix" "prefix" ++ option "--region" "region" ++ option "--endpoint-url" "endpoint" ++
    [text (get mount "bucket"), text mountPath]
  let mountArgs := String.intercalate " " (words.map Tools.shellQuote)
  run s!"mountpoint -q {← quote} || sudo -E mount-s3 --uid \"$(id -u)\" --gid \"$(id -g)\" {mountArgs}"
  return voidJson

private def providerToolBuild (call : Json) : Prog Json := do
  let toolName := text (Twin.callArg call 0)
  let context := Twin.callArg call 1
  let config := get context "config"
  let factories ← Prog.effect "providerToolFactories" [get context "modelProvider"]
  let id ← Prog.effect "descriptorId" [config]
  let factory ←
    if missing id then Prog.effect "parseOr" [factorySchema, get factories toolName]
    else Prog.effect "factoryById" [factories, id]
  if !truthy factory then
    let asked := if missing id then "" else s!" ({text id})"
    let names ← Prog.effect "availableToolNames" [factories, toJson (!missing id)]
    return ← Prog.throwError "Error"
      (s!"config.tools.{toolName}{asked} is not a provider-defined tool on config.model.provider '{text (get context "modelProviderName")}' " ++
       s!"(available: {text names}). Connect an MCP server for anything the provider does not execute itself.")
  let args ← Prog.effect "providerToolArgs" [config]
  return Json.mkObj [("args", args), ("factory", factory)]

private def reservedAgentSandbox (call : Json) : Prog Json := do
  let sandbox := Twin.callArg call 0
  let userKey := Twin.callArg call 4
  let agentKey ← Prog.effect "agentSandboxReservation"
    [sandbox, Twin.callArg call 1, Twin.callArg call 2, Twin.callArg call 3]
  let reservationKey ←
    if truthy agentKey && truthy userKey && (pinnedKey sandbox).isNone then
      Prog.effect "normalizeFilesystemNamespace" [toJson s!"{text agentKey}:{text userKey}"]
    else pure agentKey
  let options := get sandbox "options"
  if !truthy reservationKey || reservationKey == get options "reservationKey" then return sandbox
  return Tools.spread sandbox
    (Json.mkObj [("options", Tools.spread (fallback options (Json.mkObj []))
      (Json.mkObj [("reservationKey", reservationKey)]))])

private def present (key : String) (value : Json) : List (String × Json) :=
  if missing value then [] else [(key, value)]

private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if truthy value then [(key, value)] else []

private def sandboxControlPlane (call : Json) : Prog Json := do
  let record := Twin.callArg call 1
  let config := get record "config"
  let specs ← Prog.effect "resolveSandboxSpecs"
    [Json.mkObj ([("provider", get config "provider")] ++ present "size" (get config "size") ++
      present "options" (get config "options"))]
  let own ← Prog.effect "runsOnOwnCredentials" [config]
  let lifecycle ← Prog.effect "resolveSandboxLifecycle" [get config "lifecycle"]
  return Json.mkObj
    ([("accountId", Twin.callArg call 0)] ++ whenTruthy "projectId" (get record "projectId") ++
     whenTruthy "stageId" (get record "stageId") ++
     present "sandboxConfigId" (get record "sandboxId") ++ present "name" (get record "name") ++
     [("specs", specs)] ++
     whenTruthy "snapshotId" (get config "snapshot") ++
     (if truthy (get config "network") then [("egress", get (get config "network") "mode")] else []) ++
     whenTruthy "permissionMode" (get config "permissionMode") ++
     (if truthy own then [("ownCredentials", toJson true)] else []) ++
     [("idleTimeoutSeconds", get lifecycle "idleTimeoutSeconds")])

/-- `sandboxesNote`. `choice === context.sandboxes[0]` is compared by value. -/
private def sandboxesNote (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let choices := items (← Prog.effect "sandboxParamChoices" [context])
  if choices.isEmpty then return toJson ""
  let first := (items (get context "sandboxes")).head?
  let hasWorkspaces := !(items (get context "workspaces")).isEmpty
  let entries ← choices.mapM fun choice => do
    let isDefault := some choice == first
    let description := get choice "description"
    let label :=
      if !nullish description then text description
      else if isDefault then "your own sandbox" else ""
    let reserved ←
      if isDefault && hasWorkspaces then
        text <$> Prog.effect "reservedStandaloneNote" [get choice "sandbox"]
      else pure ""
    pure s!"  - {text (get choice "name")}{if label.isEmpty then "" else s!": {label}."}{reserved}"
  return toJson (s!"\n- sandbox:\"<name>\" runs on that sandbox with no workspace mounted. {throwawayNote}:\n" ++
    String.intercalate "\n" entries)

private def normalizeInput (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  match get input "tasks" with
  | .arr tasks =>
    if tasks.isEmpty then
      return ← Prog.throwError "Error" "tasks must include at least one subagent task"
    if tasks.size > 10 then
      return ← Prog.throwError "Error" "tasks must include at most 10 subagent tasks"
    let results ← (tasks.toList.zipIdx).mapM fun (task, index) =>
      Prog.effect "normalizeTask" [task, toJson index, Twin.callArg call 1]
    return Json.arr results.toArray
  | _ => Prog.throwError "Error" "tasks must be a non-empty array"

/-- Groups by account, keeping each account's first appearance as the Map's order. -/
private def byAccount (reservations : List Json) : List (Json × List Json) :=
  reservations.foldl (init := []) fun groups one =>
    let account := get one "accountId"
    if groups.any (·.1 == account) then
      groups.map fun group => if group.1 == account then (group.1, group.2 ++ [one]) else group
    else groups ++ [(account, [one])]

private def sweepExpiredSandboxes (_call : Json) : Prog Json := do
  let outcomes ← Prog.all
    [("runtime.query", [toJson "listExpiredSandboxReservations", Json.mkObj [("limit", toJson (100 : Nat))]]),
     ("listOrphanedSandboxes", [])]
  match outcomes with
  | [.ok expired, .ok orphaned] =>
    let mut released : Nat := 0
    for (account, reservations) in byAccount (items expired ++ items orphaned) do
      let count ← Prog.effect "sweepAccount" [account, Json.arr reservations.toArray]
      released := released + (count.getNat?.toOption.getD 0)
    return toJson released
  | [.threw error _, _] => throw error
  | [_, .threw error _] => throw error
  | _ => Prog.unsupported "a listing never finished"

private def upsertSandboxInstance (call : Json) : Prog Json := do
  let plane := Twin.callArg call 0
  if !truthy plane then return toJson true
  let metadata := fallback (Twin.callArg call 4) (Json.mkObj [])
  let options := Twin.callArg call 5
  let specs := get options "specs"
  let ephemeral := get options "ephemeral" == toJson true
  let fromPlane (key : String) := present key (get plane key)
  let fromMeta (key : String) (to_ : String) := present to_ (get metadata key)
  let payload := Json.mkObj
    ([("accountId", get plane "accountId")] ++ fromPlane "projectId" ++ fromPlane "stageId" ++
     [("provider", Twin.callArg call 1), ("reservationKey", Twin.callArg call 2),
      ("externalId", Twin.callArg call 3), ("name", get plane "name"),
      ("specs", if nullish specs then get plane "specs" else specs)] ++
     (if missing specs then [] else [("specsVerified", toJson true)]) ++
     fromPlane "sandboxConfigId" ++ fromPlane "snapshotId" ++ fromPlane "egress" ++
     fromPlane "permissionMode" ++ fromPlane "ownCredentials" ++ fromPlane "idleTimeoutSeconds" ++
     fromMeta "traceId" "lastUsedTraceId" ++ fromMeta "traceId" "createdByTraceId" ++
     fromMeta "taskId" "lastUsedTaskId" ++ fromMeta "taskId" "createdByTaskId" ++
     fromMeta "agentId" "agentId" ++ fromMeta "conversationKey" "conversationKey" ++
     fromMeta "workspaceName" "workspaceName" ++ fromMeta "workspaceId" "workspaceId" ++
     present "logStream" (get options "logStream") ++
     (if ephemeral then [("ephemeral", toJson true)] else []))
  match ← Prog.attempt "adminMutation"
    [(Json.mkObj [("$convexFunction", toJson "sandbox/instances:upsert")]), payload, Json.mkObj [("skipQueue", toJson true)]] with
  | .ok written => return written
  | .threw _ _ => return toJson false
  | .pending => Prog.unsupported "the mutation never settled"

/-- The optional methods each executor class declares, in the order the wrapper binds them. -/
private def executorMethods (className : String) : Option (List String) :=
  match className with
  | "E2BSandboxExecutor" | "DaytonaSandboxExecutor" => some ["runBackground"]
  | "VercelSandboxExecutor" => some ["runBackground"]
  | "MicrovmSandboxExecutor" => some ["runBackground", "resume", "postReserved"]
  | "CloudflareSandboxExecutor" => some []
  | "WorkdirSandboxExecutor" => some ["runBackground", "resume"]
  | "HttpSandboxExecutor" | "MachineSandboxExecutor" | "WorkerSandboxExecutor" => some []
  | _ => none

private def createSandboxExecutor (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let executor ← Prog.effect "providerExecutor" [config]
  let plane := get config "controlPlane"
  if !truthy (get plane "accountId") || truthy (get plane "ownCredentials") then return executor
  match executorMethods (text (get executor "$opaque")) with
  | none => Prog.unsupported "an executor class outside the model"
  | some methods =>
    let _ ← Prog.effect "executor.run.bind" [executor]
    for method in methods do
      let _ ← Prog.effect s!"executor.{method}?.bind" [executor]
    return executor


/-- `configString(key) ?? optionalEnv(env)`, asked in that order. -/
private def configOrEnv (options : Json) (key env : String) : Prog Json := do
  let value ← Prog.effect "configString" [get options key]
  if nullish value then Prog.effect "optionalEnv" [toJson env] else pure value

private def workdirConnection (call : Json) : Prog Json := do
  let options := get (Twin.callArg call 0) "options"
  let customUrl ← Prog.effect "configString" [get options "workdirUrl"]
  if truthy customUrl then
    let _ ← Prog.effect "assertPublicHttpsUrl" [customUrl, toJson "config.options.workdirUrl"]
  let baseUrl ← if nullish customUrl then Prog.effect "optionalEnv" [toJson "WORKDIR_URL"] else pure customUrl
  if !truthy baseUrl then
    return ← Prog.throwError "Error"
      "workdir sandbox requires config.options.workdirUrl or the WORKDIR_URL environment variable"
  let customKey ← Prog.effect "configString" [get options "apiKey"]
  if truthy customUrl && !truthy customKey then
    return ← Prog.throwError "Error" "config.options.apiKey is required when config.options.workdirUrl is set"
  let apiKey ← if nullish customKey then Prog.effect "optionalEnv" [toJson "WORKDIR_API_KEY"] else pure customKey
  return Json.mkObj [("baseUrl", baseUrl), ("apiKey", fallback apiKey (toJson ""))]

private def daytonaClientOptions (call : Json) : Prog Json := do
  let options := get (Twin.callArg call 0) "options"
  let customUrl ← Prog.effect "configString" [get options "apiUrl"]
  if truthy customUrl then
    let _ ← Prog.effect "assertPublicHttpsUrl" [customUrl, toJson "config.options.apiUrl"]
  let customKey ← Prog.effect "configString" [get options "apiKey"]
  if truthy customUrl && !truthy customKey then
    return ← Prog.throwError "Error" "config.options.apiKey is required when config.options.apiUrl is set"
  let apiKey ← if nullish customKey then Prog.effect "optionalEnv" [toJson "DAYTONA_API_KEY"] else pure customKey
  let organizationId ← configOrEnv options "organizationId" "DAYTONA_ORGANIZATION_ID"
  let apiUrl ← if nullish customUrl then Prog.effect "optionalEnv" [toJson "DAYTONA_API_URL"] else pure customUrl
  let target ← configOrEnv options "target" "DAYTONA_TARGET"
  return Json.mkObj
    (whenTruthy "apiKey" apiKey ++ whenTruthy "organizationId" organizationId ++
     whenTruthy "apiUrl" apiUrl ++ whenTruthy "target" target)

private def timeoutNote (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let selectable := items (← Prog.effect "selectableSandboxes" [context])
  let reachable :=
    ((items (get context "workspaces")).map (get · "sandbox") ++ selectable.map (get · "sandbox")).filter truthy
  let limits ← reachable.mapM fun sandbox => do
    let seconds ← Prog.effect "sandboxTimeoutSeconds" [sandbox]
    pure (seconds.getNat?.toOption.getD 0)
  let unique := limits.eraseDups.mergeSort (· ≤ ·)
  if unique.isEmpty then return toJson ""
  let joined := String.intercalate " or " (unique.map (s!"{·}s"))
  return toJson s!"\n- Each call is limited to {joined}; past it the call fails."

private def noteText (label : String) (context : Json) : Prog String :=
  text <$> Prog.effect label [context]

private def bashDescription (call : Json) : Prog Json := do
  let context := Twin.callArg call 0
  let shared := "- Run programs directly, e.g. `python3 script.py` or `node app.js`. stdout and stderr are returned together, followed by `[exit code N]` when the command fails; very large output is truncated."
  let quoting := "- Use proper quoting for paths or arguments containing spaces (e.g. cd \"path with spaces\")."
  if (items (get context "workspaces")).isEmpty then
    let first := (items (get context "sandboxes")).head?
    let sandbox := (first.map (get · "sandbox")).getD Twin.undefinedJson
    let runtimes ← text <$> Prog.effect "runtimeDescription" [sandbox]
    let reserved := truthy (← Prog.effect "isReservedStandalone" [sandbox])
    let kind := if reserved then "a reserved" else "an ephemeral"
    let state :=
      if reserved then "The sandbox is reserved: files persist across calls until the reservation ends, but nothing reaches durable storage. Shell state (working directory, environment variables, background processes) resets every call, so chain dependent steps with && or ;."
      else "The sandbox is stateless: each call runs in a fresh container with no persistent storage. Files do NOT persist across calls, and shell state (working directory, environment variables, background processes) resets every call — keep the whole task in a single command, chaining steps with && or ;."
    let timeout ← noteText "timeoutNote" context
    let sandboxes ← noteText "sandboxesNote" context
    return toJson (s!"Executes a bash command in {kind} Linux sandbox (bash, python3, and node on PATH).\n\nUsage notes:\n- {runtimes}\n" ++
      quoting ++ "\n" ++ shared ++ timeout ++ s!"\n- {state}{sandboxes}")
  let timeout ← noteText "timeoutNote" context
  let s3 ← noteText "s3MountNote" context
  let guard ← noteText "writeGuardNote" context
  let reserved ← noteText "reservedNote" context
  let own ← noteText "ownSandboxNote" context
  let sandboxes ← noteText "sandboxesNote" context
  let background ← noteText "backgroundNote" context
  return toJson ("Executes a bash command on the attached workspace in a Linux sandbox (bash, python3, and node on PATH).\n\nUsage notes:\n- The selected workspace's sandbox may restrict runtimes; commands using disallowed runtimes are rejected before execution.\n" ++
    quoting ++ "\n- IMPORTANT: prefer the dedicated `read`, `write`, `edit`, `glob`, and `grep` tools over their bash equivalents (cat/sed/find/grep) — they are faster, safer, and return structured results.\n" ++
    shared ++ timeout ++ "\n- Each command starts in the current workspace directory; use relative paths." ++ s3 ++
    "\n- DURABILITY: the workspace directory is the only storage that outlives the sandbox. Anything the task should keep — results, generated code, reports — must be written to a workspace-relative path." ++ guard ++
    "\n- Reading outside the workspace is fine: the sandbox is a whole Linux machine, so inspecting system files, installed packages, or /proc needs no special handling.\n- Files you write to the workspace persist across calls, but shell state does not: the working directory, environment variables, and background processes reset every call — chain dependent steps with && in a single command." ++
    reserved ++ own ++ sandboxes ++ background)

private def daytonaEnvVars (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let baseEnv := Twin.callArg call 2
  if get (get config "options") "mountAwsS3Buckets" != toJson true then return baseEnv
  let context ← Prog.effect "executorS3Context" [config, Twin.callArg call 1]
  let mount ← Prog.effect "resolveS3Mount" [context]
  let credentials ←
    if nullish (get mount "credentials") then Prog.effect "staticAwsKeys" [baseEnv]
    else pure (get mount "credentials")
  let region := get mount "region"
  return Json.mkObj (Tools.entries baseEnv ++ (if missing credentials then [] else Tools.entries credentials) ++
    (if truthy region then [("AWS_REGION", region), ("AWS_DEFAULT_REGION", region)] else []))

private def minutes (seconds : Json) : Json :=
  numberJson (max 1.0 ((numeric seconds / 60 + 0.5).floor))

private def daytonaCreateOptions (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let request := Twin.callArg call 1
  let options := get config "options"
  let _ ← Prog.effect "assertSnapshotBootable" [get config "controlPlane", get config "snapshot"]
  let baseEnv ← Prog.effect "mergeSandboxEnv" [get config "envVars"]
  let envVars ← Prog.effect "daytonaEnvVars" [config, request, baseEnv]
  let lifecycle ← Prog.effect "resolveSandboxLifecycle" [get config "lifecycle"]
  let imageOnce ← Prog.effect "configString" [get options "image"]
  let image ← if truthy imageOnce then
      (fun i => [("image", i)]) <$> Prog.effect "configString" [get options "image"]
    else pure []
  let network ← Prog.effect "daytonaNetworkOptions" [config]
  let grace := fallback (get lifecycle "maxLifetimeSeconds") (toJson (604800 : Nat))
  return Json.mkObj
    ([("language", toJson "typescript")] ++ whenTruthy "snapshot" (get config "snapshot") ++ image ++
     (if (Tools.entries envVars).isEmpty then [] else [("envVars", envVars)]) ++ Tools.entries network ++
     (if truthy (Twin.callArg call 2) then
       [("autoStopInterval", minutes (get lifecycle "idleTimeoutSeconds")),
        ("autoDeleteInterval", minutes grace)]
      else []))

private def mountAwsS3Buckets (call : Json) : Prog Json := do
  let request := Twin.callArg call 1
  let config := Twin.callArg call 2
  let options := get config "options"
  if get options "mountAwsS3Buckets" != toJson true then return voidJson
  let context ← Prog.effect "executorS3Context" [config, request]
  let identity ← Prog.effect "resolveS3MountIdentity" [context]
  let root := Rt.dropTrailingSlashes (text (fallback (get request "workspaceRoot") (toJson "/mnt/workspaces")))
  let _ ← Prog.effect "mountS3Bucket"
    [Twin.callArg call 0, identity, toJson s!"{root}/{text (get request "namespace")}"]
  return voidJson

private def workdirClient (call : Json) : Prog Json := do
  let connection ← Prog.effect "workdirConnection" [Twin.callArg call 0]
  Prog.effect "new Client" [get connection "baseUrl", get connection "apiKey"]

/-- `REMOVE_RETRY_DELAYS_MS`. -/
private def removeRetryDelays : List Nat := [0, 500, 2000]

/-- The retried `internal.sandbox.instances.remove` calls: the last failure is the caller's to log. -/
private def removeAttempts (args : Json) : List Nat → Prog Json
  | [] => pure voidJson
  | delay :: rest => do
    let _ ← Prog.effect "Bun.sleep" [toJson delay]
    match ← Prog.attempt "adminMutation"
        [toJson "sandbox.instances.remove", args, Json.mkObj [("skipQueue", toJson true)]] with
    | .ok _ => pure voidJson
    | .threw _ _ => if rest.isEmpty then pure voidJson else removeAttempts args rest
    | .pending => Prog.unsupported "the mutation never settled"

/-- `removeSandboxInstance`: every failure is logged, so it always settles undefined. -/
private def removeSandboxInstance (call : Json) : Prog Json := do
  match ← Prog.attempt "getConvexClient" with
  | .threw _ _ => return voidJson
  | .pending => return ← Prog.unsupported "the client never settled"
  | .ok _ => pure ()
  let externalId := Twin.callArg call 2
  let args := Json.mkObj
    ([("accountId", Twin.callArg call 0), ("reservationKey", Twin.callArg call 1)] ++
      (if externalId == voidJson then [] else [("externalId", externalId)]))
  removeAttempts args removeRetryDelays

private def postToChannel (call : Json) : Prog Json := do
  let channel := Twin.callArg call 0
  let questions := Twin.callArg call 2
  let formatted ← Prog.effect "formatQuestionsText" [questions]
  let text_ ← Prog.effect "channel.transformText" [formatted]
  if text_ == .null then return toJson "question blocked by the outbound message hook"
  let actions := get channel "actions"
  if truthy (get actions "sendQuestions") then
    let _ ← Prog.effect "channel.actions.sendQuestions"
      [Json.mkObj [("statusId", Twin.callArg call 1), ("questions", questions), ("text", text_)]]
  else
    let _ ← Prog.effect "channel.actions.sendText" [text_]
  return .null

/-- This author's twins, in assignment order. -/
def twins : List Twin :=
  [Twin.traced (sandbox "workdir-executor" "workdirConnection") workdirConnection,
   Twin.traced (sandbox "workdir-executor" "workdirClient") workdirClient,
   Twin.traced (sandbox "daytona-executor" "daytonaClientOptions") daytonaClientOptions,
   Twin.traced (sandbox "daytona-executor" "daytonaEnvVars") daytonaEnvVars,
   Twin.traced (sandbox "daytona-executor" "daytonaCreateOptions") daytonaCreateOptions,
   Twin.traced (sandbox "daytona-executor" "mountAwsS3Buckets") mountAwsS3Buckets,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#timeoutNote" timeoutNote,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#description" bashDescription,
   Twin.traced "apps/core/src/harness/tools/ask-questions.tool.ts#postToChannel" postToChannel,
   Twin.traced "apps/core/src/shared/convex/sandbox-instances.ts#removeSandboxInstance" removeSandboxInstance,
Twin.traced (sandbox "live-status" "parseSandboxUsage") parseSandboxUsage,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#sweepAccount" sweepAccount,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#sweepExpiredSandboxes" sweepExpiredSandboxes,
   Twin.traced "apps/core/src/harness/tools/grep.tool.ts#searchCommand" searchCommand,
   Twin.traced "apps/core/src/shared/workspaces.ts#agentSandboxReservation" agentSandboxReservation,
   Twin.traced "apps/core/src/shared/workspaces.ts#reservedAgentSandbox" reservedAgentSandbox,
   Twin.traced "apps/core/src/shared/workspaces.ts#sandboxControlPlane" sandboxControlPlane,
   Twin.traced (sandbox "harness-shell-process" "readFileChunk") readFileChunk,
   Twin.traced (sandbox "live-status" "formatSandboxStatus") formatSandboxStatus,
   Twin.traced (sandbox "live-status" "agentSandboxStatus") agentSandboxStatus,
   Twin.traced "apps/core/src/harness/tools/provider-tool.ts#factoryId" factoryIdTwin,
   Twin.traced "apps/core/src/harness/tools/provider-tool.ts#providerToolArgs" providerToolArgs,
   Twin.traced "apps/core/src/harness/tools/provider-tool.ts#providerToolBuild" providerToolBuild,
   Twin.traced (sandbox "utils" "isNoRunnersError") isNoRunnersError,
   Twin.traced (sandbox "utils" "stringRecord") stringRecord,
   Twin.traced (sandbox "utils" "mergeSandboxEnv") mergeSandboxEnv,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#backgroundNote" backgroundNote,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#inputSchema" bashInputSchema,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#reservedStandaloneNote" reservedStandaloneNote,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#sandboxesNote" sandboxesNote,
   Twin.traced "apps/core/src/harness/tools/run-subagent.tool.ts#normalizeInput" normalizeInput,
   Twin.traced "apps/cloudflare-sandbox/src/terminal-token.ts#verifyTerminalToken" verifyTerminalToken,
   Twin.traced (sandbox "daytona-executor" "mountS3Bucket") mountS3Bucket,
   Twin.traced "apps/core/src/shared/convex/sandbox-instances.ts#upsertSandboxInstance" upsertSandboxInstance,
   Twin.traced (sandbox "index" "createSandboxExecutor") createSandboxExecutor,
Twin.traced "apps/cloudflare-worker/src/vfs-state.ts#packState" packState,
   Twin.traced (sandbox "microvm-websocket-proxy" "microvmUpstreamUrl") microvmUpstreamUrl,
   Twin.traced (sandbox "microvm-executor" "burstHeader") burstHeader,
   Twin.traced "apps/core/src/shared/workspaces.ts#assertSandboxReachesWorkspace" assertSandboxReachesWorkspace,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#sandboxParamSchema" sandboxParamSchema,
   Twin.traced "apps/core/src/harness/tools/memory.tool.ts#memorySlug" memorySlugTwin,
   Twin.traced (sandbox "live-status" "occupySandbox") occupySandbox,
   Twin.traced (sandbox "index" "providerExecutor") providerExecutor,
   plain "apps/core/src/harness/tools/computer.tool.ts#machinesNote" machinesNote,
   Twin.traced (sandbox "microvm-executor" "delay") delayTwin,
   Twin.traced (sandbox "microvm-executor" "evictToCap") evictToCap,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#backgroundAvailable" backgroundAvailable,
   Twin.traced (sandbox "live-status" "reportSandboxUsage") reportSandboxUsage,
   Twin.traced "apps/core/src/harness/tools/grep.tool.ts#inputSchema" grepInputSchema,
   Twin.traced "apps/core/src/harness/tools/memory.tool.ts#inputSchema" memoryInputSchema,
   Twin.traced "apps/core/src/harness/tools/glob.tool.ts#inputSchema" globInputSchema,
   plain "apps/core/src/harness/tools/run-subagent.tool.ts#buildRunSubagentInputSchema" buildRunSubagentInputSchema,
   plain "apps/core/src/harness/tools/glob.tool.ts#globScript" globScript,
   Twin.traced "apps/core/src/harness/tools/file-operation.ts#fileOperationScript" fileOperationScript,
Twin.traced "apps/cloudflare-sandbox/src/terminal-token.ts#mac" terminalMac,
   Twin.traced "apps/cloudflare-sandbox/src/terminal-token.ts#signTerminalToken" signTerminalToken,
   Twin.traced "apps/core/src/shared/workspaces.ts#isolatedWorkspaceNamespace" isolatedWorkspaceNamespace,
   Twin.traced (sandbox "microvm-executor" "microvmImageVariant") microvmImageVariant,
   Twin.traced (sandbox "utils" "parseExecResponse") parseExecResponse,
   Twin.traced (sandbox "utils" "execRunResult") execRunResult,
   Twin.traced "apps/core/src/harness/tools/run-subagent.tool.ts#normalizeTask" normalizeTask,
   Twin.traced (sandbox "workdir-harness-driver" "workdirPreviewKey") previewKey,
   plain (sandbox "live-status" "formatMegabytes") (fun a =>
     let x := numeric (Twin.arg a 0)
     if x >= 1024 then toJson s!"{text (numberJson (x / 1024))} GB" else toJson s!"{text (Twin.arg a 0)} MB"),
   plain (sandbox "live-status" "roundTenth") (fun a => numberJson (((numeric (Twin.arg a 0) * 10 + 0.5).floor) / 10)),
   Twin.traced (sandbox "instance-store" "getSandboxReleaseTarget") (fun c =>
     Prog.effect "runtime.query" [toJson "getSandboxReleaseTarget", Json.mkObj
       ([("accountId", Twin.callArg c 0), ("provider", Twin.callArg c 1), ("reservationKey", Twin.callArg c 2)] ++
       if missing (Twin.callArg c 3) then [] else [("externalId", Twin.callArg c 3)])]),
   Twin.traced (sandbox "utils" "requiredWorkspacePath") (fun c => Prog.effect "workspacePath" [Twin.callArg c 0, Twin.callArg c 1]),
   Twin.traced (sandbox "utils" "sandboxNamePrefix") (fun c => do
     let slug ← Prog.effect "slugFor" [Twin.callArg c 0, Twin.undefinedJson, toJson (31 : Nat)]
     let hash ← Prog.effect "shortHash" [Twin.callArg c 0]
     pure (toJson s!"fp-p-{text slug}-{text hash}")),
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#ptyCommand" (fun c => do
     let quoted ← Prog.effect "shellQuote" [Twin.callArg c 0]
     pure (toJson s!"script -qec {text quoted} /dev/null")),
   plain (sandbox "utils" "shortHash") shortHash,
   plain (sandbox "utils" "slugFor") slugFor,
   plain (sandbox "workdir-executor" "workdirPtyUrl") workdirPtyUrl,
   plain "packages/convex/model/workspaceRules.ts#r2AccountId" r2AccountId,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#isReservedStandalone" isReservedStandalone,
   Twin.traced (sandbox "daytona-executor" "executeDaytonaSetupCommand") executeDaytonaSetupCommand,
   Twin.traced (sandbox "instance-store" "deleteSandboxInstance") deleteSandboxInstance,
   Twin.traced (sandbox "microvm-websocket-proxy" "sendUpstreamMessage") sendUpstreamMessage,
   plain (sandbox "utils" "configuredSandboxSpecs") (fun a =>
     let cfg := Twin.arg a 0
     if ["cloudflare", "lambda", "sandbox"].contains (text (get cfg "provider")) then
       fallback (get (get cfg "controlPlane") "specs") .null else .null),
   Twin.traced (sandbox "daytona-executor" "daytonaSpecs") (fun c =>
     let cfg := Twin.callArg c 0
     pure (Json.mkObj [("vcpu", get cfg "cpu"), ("memoryMb", toJson ((get cfg "memory").getNat?.toOption.getD 0 * 1024)), ("storageGb", get cfg "disk")])),
   plain (sandbox "live-status" "isReading") (fun a => toJson (match Twin.arg a 0 with | .num _ => true | _ => false)),
   Twin.traced (sandbox "microvm-executor" "microvmShellConnection") microvmShellConnection,
   Twin.traced (sandbox "microvm-executor" "managedIngressConnectorArn") managedIngressConnectorArn,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#deferAttempted" deferAttempted,
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#ownSandboxNote" (fun c => notes c "own"),
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#reservedNote" (fun c => notes c "reserved"),
   Twin.traced "apps/core/src/harness/tools/bash.tool.ts#writeGuardNote" (fun c => notes c "guard"),
   plain "apps/core/src/harness/tools/bash.tool.ts#s3MountNote" s3MountNote,
   plain "apps/core/src/harness/tools/run-subagent.tool.ts#normalizeRequiredString" normalizeRequiredString,
   plain "packages/convex/model/workspaceRules.ts#normalizeWorkspacePrefix" normalizeWorkspacePrefix,
   plain "apps/core/src/harness/tools/provider-tool.ts#descriptorId" descriptorId,
   plain (sandbox "microvm-executor" "s3Location") s3Location,
   plain (sandbox "workdir-executor" "s3SecretNames") s3SecretNames,
   plain (sandbox "utils" "principalEnv") principalEnv,
   plain (sandbox "utils" "configString") configString,
   plain (sandbox "utils" "sandboxReservationKey") (fun a =>
     fallback (get (Twin.arg a 0) "reservationKey") (fallback (get (Twin.arg a 0) "namespace") .null)),
   plain (sandbox "utils" "shellQuote") (fun a => toJson ("'" ++ (text (Twin.arg a 0)).replace "'" "'\\''" ++ "'")),
   plain (sandbox "microvm-executor" "homeEnv") (fun a =>
     if truthy (Twin.arg a 0) then Json.mkObj [("HOME", Twin.arg a 0), ("TMPDIR", toJson "/tmp")] else Json.mkObj []),
   plain (sandbox "microvm-executor" "isTerminalMicrovmState") (fun a =>
     toJson (["TERMINATED", "TERMINATING"].contains (text (Twin.arg a 0)))),
   plain (sandbox "microvm-executor" "microvmImageName") (fun a =>
     toJson (String.intercalate ":" (((text (Twin.arg a 0)).splitOn ":").take 7))),
   plain (sandbox "microvm-executor" "microvmLocalNamespace") (fun a =>
     toJson (((text (Twin.arg a 0)).splitOn "/").headD "")),
   plain (sandbox "microvm-executor" "mapMicrovmState") (fun a =>
     toJson (match text (Twin.arg a 0) with
     | "RUNNING" | "PENDING" => "running"
     | "SUSPENDED" | "SUSPENDING" => "suspended"
     | "TERMINATING" | "TERMINATED" => "terminating"
     | _ => "unknown")),
   Twin.traced "apps/core/src/shared/workspaces.ts#workspaceNamespace" (fun c => namespaceKey c "workspace"),
   Twin.traced "apps/core/src/shared/workspaces.ts#agentSandboxReservationKey" (fun c => namespaceKey c "agent"),
   Twin.traced "apps/core/src/shared/workspaces.ts#pinnedSandboxReservationKey" (fun c => namespaceKey c "pinned"),
   Twin.traced "apps/cloudflare-sandbox/src/terminal-token.ts#timingSafeEqual" (fun c =>
     pure (toJson (bytes (Twin.callArg c 0) == bytes (Twin.callArg c 1)))),
   plain "packages/convex/model/workspaceRules.ts#disabledFeature" (fun a =>
     if get (Twin.arg a 0) "enabled" == toJson false then Json.mkObj [("enabled", toJson false)] else .null),
   Twin.traced "apps/cloudflare-worker/src/vfs-state.ts#compressState" (fun c => Prog.effect "gzipSync" [Twin.callArg c 0]),
   Twin.traced "apps/cloudflare-worker/src/vfs-state.ts#emptyFs" (fun _ =>
     Prog.effect "new InMemoryFs" [Twin.undefinedJson, Json.mkObj [("maxTotalBytes", toJson (25165824 : Nat))]]),
   plain (sandbox "microvm-websocket-proxy" "microvmWebSocketProtocols") (fun a =>
     toJson ["lambda-microvms", s!"lambda-microvms.authentication.{text (Twin.arg a 0)}", s!"lambda-microvms.port.{text (Twin.arg a 1)}"]),
   Twin.traced (sandbox "microvm-executor" "boundedText") boundedText,
   Twin.traced (sandbox "harness-shell-process" "readHarnessStream") readHarnessStream,
   Twin.traced "apps/core/src/shared/workspaces.ts#sharedWorkspaceNamespace" sharedWorkspaceNamespace,
   plain (sandbox "workdir-executor" "workdirNetwork") workdirNetwork,
   plain "apps/core/src/shared/workspaces.ts#runsOnOwnCredentials" runsOnOwnCredentials,
   Twin.traced (sandbox "utils" "assertSnapshotBootable") assertSnapshotBootable,
   plain (sandbox "live-status" "formatMachineNow") formatMachineNow,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#listOrphanedSandboxes"
     (fun _ => orphanPages 1024 .null []),
   Twin.traced (sandbox "microvm-executor" "MicrovmSandboxExecutor.snapshotStatus") snapshotStatus,
   plain "apps/core/src/harness/tools/grep.tool.ts#grepGlobFlag" grepGlobFlag,
   plain "apps/core/src/harness/tools/ask-questions.tool.ts#validateQuestions" validateQuestions,
   plain (sandbox "microvm-executor" "microvmImageScope") microvmImageScope,
   plain (sandbox "workdir-executor" "mapWorkdirState") mapWorkdirState,
   plain "apps/core/src/shared/workspaces.ts#assertDistinctSandboxNames" assertDistinctSandboxNames,
   plain "apps/core/src/harness/tools/run-subagent.tool.ts#normalizeOptionalString" normalizeOptionalString,
   plain (sandbox "utils" "truncateText") truncateText,
   plain (sandbox "utils" "workspacePath") workspacePath,
   plain (sandbox "utils" "isExecResponse") isExecResponse,
   plain (sandbox "daytona-executor" "daytonaNetworkOptions") daytonaNetworkOptions,
   plain "apps/cloudflare-worker/src/vfs-state.ts#samePacked"
     (fun args => toJson (Twin.arg args 0 == Twin.arg args 1))]

end Spec.Sandbox.Wavesandbox1
