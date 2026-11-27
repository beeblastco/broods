import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign5/sandbox5b.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox5b

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def nullish (value : Json) : Bool :=
  isUndef value || value.compress == Json.null.compress

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def str (value : Json) : String :=
  (value.getStr?).toOption.getD ""

private def jsTrue (value : Json) : Bool :=
  value.compress == (toJson true).compress

/-- JavaScript truthiness for the values these functions branch on. -/
private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool b => b
  | .str s => !s.isEmpty
  | .num n => n.mantissa != 0
  | _ => !isUndef value

private def elems (value : Json) : List Json :=
  match value with
  | .arr items => items.toList
  | _ => []

/-- An object's own keys in insertion order, which the recorder gives in `$keys` when not sorted. -/
private def keysOf (value : Json) : List String :=
  match value with
  | .obj kvs =>
    match value.getObjVal? "$keys" with
    | .ok (.arr keys) => keys.toList.filterMap fun key => (Json.getStr? key).toOption
    | _ => kvs.keys.filter fun key => key != "$keys" && key != "$fields"
  | _ => []

private def entriesOf (value : Json) : List (String × Json) :=
  (keysOf value).map fun key => (key, field value key)

/-- `{...base, ...extra}`. -/
private def spread (base : Json) (extra : List (String × Json)) : Json :=
  Json.mkObj ((entriesOf base).filter (fun entry => !(extra.any (·.1 == entry.1))) ++ extra)

/-- A number scaled by a whole factor, with the decimal form `JSON.stringify` would print. -/
private def scale (value : Json) (factor : Int) : Option JsonNumber :=
  match value with
  | .num n =>
    let rec strip : Nat → Int → Nat → JsonNumber
      | 0, m, e => ⟨m, e⟩
      | fuel + 1, m, e =>
        if e > 0 && m % 10 == 0 then strip fuel (m / 10) (e - 1) else ⟨m, e⟩
    some (strip (n.exponent + 1) (n.mantissa * factor) n.exponent)
  | _ => none

/-- `/\$\{[A-Z][A-Z0-9_]*\}/.test(value)`. -/
private def hasEnvPlaceholder (value : String) : Bool :=
  let upper (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'
  let tailChar (c : Char) : Bool := upper c || ('0' ≤ c && c ≤ '9') || c == '_'
  let rec closes : List Char → Bool
    | [] => false
    | c :: rest => c == '}' || (tailChar c && closes rest)
  let rec scan : List Char → Bool
    | [] => false
    | '$' :: '{' :: c :: rest => (upper c && closes rest) || scan ('{' :: c :: rest)
    | _ :: rest => scan rest
  scan value.toList

/-- `value.replace(/\/+$/, "")`. -/
private def stripTrailingSlashes (value : String) : String :=
  String.ofList ((value.toList.reverse.dropWhile (· == '/')).reverse)

/-- `EXEC_GRACE_MS` in `apps/core/src/harness/sandbox/utils.ts`. -/
private def execGraceMs : Int := 15000

/-- `HttpSandboxExecutor.run`. -/
private def httpRun (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let self := Twin.self call
  let config := Twin.field self "#config"
  let seams := Twin.field self "#seams"
  let startedAt ← Prog.effect "Date.now"
  let suppliedOptions := field config "options"
  let options := if nullish suppliedOptions then Json.mkObj [] else suppliedOptions
  let endpointValue ← Prog.effect "configString" [field options "endpoint"]
  if !truthy endpointValue then
    Prog.throwError "Error" "custom sandbox needs options.endpoint"
  let endpoint := str endpointValue
  let _ ← Prog.effect "assertPublicHttpsUrl" [endpointValue, toJson "custom sandbox endpoint"]
  let token ← Prog.effect "configString" [field options "token"]
  let headers ← Prog.effect "stringRecord" [field options "headers"]
  let credentials := (if truthy token then str token else "") ::
    (entriesOf headers).map fun entry => str entry.2
  if credentials.any hasEnvPlaceholder then
    Prog.throwError "Error"
      "custom sandbox token or header still carries a ${NAME} ref: refs resolve when the sandbox syncs from code, not through the API"
  let env ← Prog.effect "mergeSandboxEnv"
    [field config "envVars", (Json.mkObj (if field request "principal" == Twin.undefinedJson then [] else [("principal", field request "principal")]))]
  let some timeoutMs := scale (field request "timeoutSeconds") 1000
    | Prog.unsupported "a timeout that is not a number"
  let payload := Json.mkObj
    [("runtime", toJson "bash"),
     ("code", field request "code"),
     ("timeout_ms", .num timeoutMs),
     ("env", env),
     ("$keys", toJson ["runtime", "code", "timeout_ms", "env"])]
  let graceValue := field seams "graceMs"
  let grace : Int := match graceValue with
    | .num n => if n.exponent == 0 then n.mantissa else execGraceMs
    | _ => execGraceMs
  if timeoutMs.exponent != 0 then
    Prog.unsupported "a fractional millisecond timeout"
  let requestHeaders := spread headers
    ([("content-type", toJson "application/json")] ++
      (if truthy token then [("authorization", toJson s!"Bearer {str token}")] else []))
  let init := Json.mkObj
    [("method", toJson "POST"),
     ("headers", requestHeaders),
     ("body", toJson (Twin.jsonStringify 32 payload))]
  let transport := field seams "transport"
  let limits := spread (if isUndef transport then Json.mkObj [] else transport)
    [("redirectLimit", toJson (0 : Nat)),
     ("timeoutMs", .num ⟨timeoutMs.mantissa + grace, 0⟩)]
  let response ← Prog.effect "guardedFetch"
    [toJson s!"{stripTrailingSlashes endpoint}/exec", init, limits]
  let status := (match field response "status" with
    | .num n => n.mantissa
    | _ => 0)
  if status < 200 || status >= 300 then
    let body ← Prog.effect "truncateText"
      [field response "bodyText", field request "outputLimitBytes"]
    Prog.throwError "Error"
      s!"custom sandbox exec failed ({status}): {str (field body "value")}"
  let parsed ← Prog.effect "parseExecResponse"
    [field response "bodyText", toJson "custom sandbox exec"]
  Prog.effect "execRunResult" [request, parsed, toJson "custom", startedAt]

/-- The value of one request header, or `""`, as `headers.get(name) ?? ""` gives it. -/
private def requestHeader (request : Json) (name : String) : String :=
  let pairs := elems (field (field request "$request") "headers")
  match pairs.find? (fun pair => str (Twin.arg pair 0) == name) with
  | some pair => str (Twin.arg pair 1)
  | none => ""

/-- `upgradeMachineSocket`: what the socket may do is decided here, from the bearer alone. -/
private def upgradeMachineSocket (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let authorization := toJson (requestHeader request "authorization")
  let auth ← Prog.effect "resolveBearerAuth" [Json.mkObj [("authorization", authorization)]]
  let kind := str (field auth "kind")
  let accountId := field (field auth "account") "accountId"
  let ticket := field auth "stageTicket"
  let data : List (String × Json) :=
    if kind == "account" then
      [("accountId", accountId), ("authorization", authorization)]
    else if kind == "role" then
      let role := field auth "role"
      let projectId := field role "projectId"
      let stageId := field role "stageId"
      [("accountId", accountId), ("authorization", authorization), ("role", role)] ++
        (if truthy projectId && truthy stageId then
          [("stage", Json.mkObj [("projectId", projectId), ("stageId", stageId)])]
        else [])
    else if kind == "deployment" && jsTrue (field ticket "sandboxWrite") then
      [("accountId", accountId), ("authorization", authorization),
       ("expiresAt", field ticket "expiresAt"),
       ("stage", Json.mkObj
         [("projectId", field ticket "projectId"), ("stageId", field ticket "stageId")])]
    else []
  let upgraded ← Prog.effect "server.upgrade"
    [request, Json.mkObj [("data", Json.mkObj data)]]
  if truthy upgraded then
    pure undef
  else
    Prog.unsupported "a failed upgrade builds a Response the recording cannot carry"

/-- What one provider tool leaves behind for the tools after it. -/
private structure ProviderState where
  tools : List (String × Json)
  context : Json
  standIns : Array Json

/-- `map.set(name, value)` on a recorded `Map`'s entries: a known key keeps its place. -/
private def mapSet (pairs : Array Json) (name : String) (value : Json) : Array Json :=
  let entry := Json.arr #[toJson name, value]
  let isName (pair : Json) : Bool := str (Twin.arg pair 0) == name
  if pairs.any isName then pairs.map (fun pair => if isName pair then entry else pair)
  else pairs.push entry

/-- `context.approvalRequirements?.set(name, true)`, as the next effect's arguments will show it. -/
private def requireApproval (context : Json) (name : String) : Json :=
  match (field context "approvalRequirements").getObjVal? "$map" with
  | .ok (.arr pairs) =>
    spread context
      [("approvalRequirements", Json.mkObj [("$map", .arr (mapSet pairs name (toJson true)))])]
  | _ => context

/-- What the recorder writes in place of an object an effect was handed. -/
private def handed : Json := Json.mkObj [("$handed", toJson true)]

/-- `built` as stored: a tool that kept the object `factory` was handed as `options` holds that object,
which the recorder reports as handed. -/
private def storedTool (built args : Json) : Json :=
  let options := field built "options"
  if !isUndef options && options.compress == args.compress then
    spread built [("options", handed)]
  else built

/-- States the changes the entries handled so far made to `tools` and to the Maps it shares. -/
private def stateProviderWrites (call : Json) (state : ProviderState) : Prog Unit := do
  let tools := Twin.callArg call 0
  let context := Twin.callArg call 2
  let before := keysOf tools
  for name in before ++ (state.tools.map (·.1)).filter (!before.contains ·) do
    Prog.setChanged s!"args.0.{name}" (field tools name) ((state.tools.lookup name).getD undef)
  Prog.setChanged "args.2.approvalRequirements.$map"
    (field (field context "approvalRequirements") "$map")
    (field (field state.context "approvalRequirements") "$map")
  let standIns := field (Twin.callArg call 3) "standIns"
  Prog.setChanged "args.3.standIns.$map" (field standIns "$map") (.arr state.standIns)
  -- The caller passes one Map as both `context.sandboxStandIns` and `sandbox.standIns`.
  if !isUndef (field context "sandboxStandIns") then
    Prog.setChanged "args.2.sandboxStandIns.$map" (field standIns "$map") (.arr state.standIns)

/-- Runs `body`; if it throws, the writes up to `state` still happened. -/
private def stating {α : Type} (call : Json) (state : ProviderState) (body : Prog α) : Prog α :=
  Prog.catchFail body fun error => do
    stateProviderWrites call state
    .fail error

/-- The entries of a `Map` argument, or none if the call passed something else. -/
private def mapPairs (value : Json) : Array Json :=
  (field value "$map").getArr?.toOption.getD #[]

/-- `registerProviderTools`, one entry of `agentConfig.tools` at a time. -/
private def providerEntry (call : Json) (state : ProviderState)
    (toolName : String) (toolConfig : Json) : Prog ProviderState := do
  let sandbox := Twin.callArg call 3
  let names := state.tools.map (·.1)
  let nameJson := toJson toolName
  let (harnessName, enabled) ← stating call state do
    let supported ← Prog.effect "isProviderToolName" [nameJson]
    if !truthy supported then
      Prog.throwError "Error" s!"config.tools.{toolName} is not a supported tool"
    let harnessName ← Prog.effect "isHarnessToolName" [nameJson]
    if truthy harnessName && str (field toolConfig "type") != "provider" then
      let message ← Prog.effect "harnessNameError" [nameJson]
      Prog.throwError "Error" (str message)
    let enabled ← Prog.effect "isToolEnabled" [toolConfig]
    pure (harnessName, enabled)
  if !truthy enabled then
    return state
  let context := if jsTrue (field toolConfig "needsApproval") then
    requireApproval state.context toolName else state.context
  let approved : ProviderState := { state with context := context }
  let (args, built, standIn, replaces, bound) ← stating call approved do
    let runtimeConfig ← Prog.effect "externalToolRuntimeConfig" [toolConfig]
    let build ← Prog.effect "providerToolBuild"
      [nameJson, spread context [("config", runtimeConfig)]]
    let args := field build "args"
    let built ← Prog.effect "factory" [args]
    let id := field built "id"
    let candidate := str (field built "type") == "provider" &&
      !jsTrue (field built "isProviderExecuted")
    let onProvider ←
      if candidate then Prog.effect "runsOnProvider" [id, args] else pure (toJson false)
    let standIn ←
      if candidate && !truthy onProvider then
        Prog.effect "sandboxStandIn"
          [id, Json.mkObj
            ([("toolName", nameJson),
              ("sandboxTools", field sandbox "sandboxTools"),
              ("fileContext", field sandbox "fileContext")] ++
              (if isUndef (field toolConfig "command") then []
               else [("command", field toolConfig "command")]))]
      else pure undef
    let replaces := (elems (field standIn "replaces")).map str
    let taken := truthy harnessName || names.contains toolName
    if taken && !replaces.contains toolName then
      let message ← Prog.effect "harnessNameError" [nameJson]
      Prog.throwError "Error" (str message)
    let bound ← if isUndef standIn then pure undef else Prog.effect "standIn.execute.bind" [standIn]
    pure (args, built, standIn, replaces, bound)
  if isUndef standIn then
    return { approved with
      tools := approved.tools.filter (·.1 != toolName) ++ [(toolName, storedTool built args)] }
  let remaining := approved.tools.filter (!replaces.contains ·.1)
  let withoutReplaced : ProviderState := { approved with tools := remaining }
  let tool ← stating call withoutReplaced
    (Prog.effect "factory" [spread args [("execute", bound)]])
  return { withoutReplaced with
    tools := remaining.filter (·.1 != toolName) ++ [(toolName, tool)]
    -- `sandbox.standIns` keeps the stand-in that `standIn.execute.bind` was handed.
    standIns := mapSet approved.standIns toolName handed }

private def registerProviderTools (call : Json) : Prog Json := do
  let configured := field (Twin.callArg call 1) "tools"
  let initial : ProviderState :=
    { tools := entriesOf (Twin.callArg call 0)
      context := Twin.callArg call 2
      standIns := mapPairs (field (Twin.callArg call 3) "standIns") }
  let mut state := initial
  for (toolName, toolConfig) in entriesOf (if nullish configured then Json.mkObj [] else configured) do
    state ← providerEntry call state toolName toolConfig
  stateProviderWrites call state
  pure undef

/-- One server `registerMcpTools` resolved, ready to merge. -/
private structure McpServer where
  serverId : String
  serverConfig : Json
  connection : Json
  remoteTools : List Json

/-- `\b401\b`: a `401` with no word character on either side. -/
private def hasWord401 (message : String) : Bool :=
  let chars := message.toList.toArray
  let isWord (c : Char) : Bool := c.isAlphanum || c == '_'
  (List.range chars.size).any fun i =>
    chars[i]? == some '4' && chars[i + 1]? == some '0' && chars[i + 2]? == some '1' &&
      !(i > 0 && (chars[i - 1]?.map isWord).getD false) &&
      !((chars[i + 3]?.map isWord).getD false)

/-- `MCP_AUTH_FAILURE_PATTERN`, case-insensitive. -/
private def isAuthFailure (message : String) : Bool :=
  let lower := message.toLower
  let has (needle : String) : Bool := (lower.splitOn needle).length > 1
  hasWord401 lower || has "requires authorization" || has "sign in again" || has "has no connection"

/-- The sign-in tool registered when a keyless HTTP server rejects the listing. -/
private def registerSignIn (tools record context : Json) : Prog Unit := do
  let session := field context "session"
  let requester :=
    match field (field session "principal") "chain" with
    | .arr items => items[0]?.getD undef
    | _ => undef
  let owner :=
    field requester "kind" == toJson "api" && field requester "keyKind" == toJson "account" &&
      !truthy (field context "channel") &&
      field (field session "delivery") "kind" != toJson "channel" &&
      field (field session "policyDelivery") "kind" != toJson "channel"
  let name ← Prog.effect "mcpToolName" [field record "name", toJson "sign_in"]
  let tool ← Prog.effect "mcpSignInTool" [record, toJson owner]
  Prog.setChanged s!"args.0.{str name}" (field tools (str name)) tool

/-- The async body run for one configured MCP server. -/
private def resolveMcpServer (tools accountId context : Json) (serverId : String) (serverConfig : Json) :
    Prog (Option McpServer) := do
  let _ ← Prog.effect "getStorage"
  let record ← Prog.effect "getStorage().mcp.getById" [accountId, toJson serverId]
  if !truthy record || str (field record "status") != "active" then
    Prog.throwError "Error" s!"config.mcp.{serverId} references an unknown MCP server"
  if truthy (field record "disabled") then
    return none
  let session := field context "session"
  let connection ← Prog.effect "mcpConnection"
    [record, field serverConfig "headers", field serverConfig "oauth",
     field session "principal", field session "userCredential"]
  let target ← Prog.effect "sandboxMcpTarget" [record, context]
  let connection := if isUndef target then connection else spread connection [("sandbox", target)]
  let onCpu := if truthy (field context "onSandboxCpu") then
    Json.mkObj [("$fn", toJson "")] else undef
  let listing ← Prog.attempt "listMcpTools" [connection, onCpu]
  match listing with
  | .ok tools =>
    let allowed := field record "allowedTools"
    let remote := (elems tools).filter fun item =>
      !truthy allowed ||
        (elems allowed).any fun name => name.compress == (field item "name").compress
    return some ⟨serverId, serverConfig, connection, remote⟩
  | .threw cause _ =>
    let wrapped := field cause "$error"
    let message := if isUndef wrapped then str cause else str (field wrapped "message")
    if isUndef wrapped && !(cause.getStr?).isOk then
      return ← Prog.unsupported "a listing failure that is not an Error"
    if field record "transport" == toJson "http" && !truthy (field record "oauth") then
      let header ← Prog.effect "authorizationHeaderName" [field record "headers"]
      if !truthy header && isAuthFailure message then
        registerSignIn tools record context
    return none
  | .pending => Prog.unsupported "an MCP listing that never finished"

/-- `registerMcpTools`. More than one server overlaps, which this sequential model does not cover. -/
private def registerMcpTools (call : Json) : Prog Json := do
  let context := Twin.callArg call 2
  let configured := field (Twin.callArg call 1) "mcp"
  let mut entries : List (String × Json) := []
  for entry in entriesOf (if nullish configured then Json.mkObj [] else configured) do
    let enabled ← Prog.effect "isToolEnabled" [entry.2]
    if truthy enabled then
      entries := entries ++ [entry]
  match entries with
  | [] => pure undef
  | first :: rest =>
    let accountId := field context "accountId"
    if !truthy accountId then
      Prog.throwError "Error" s!"config.mcp.{first.1} requires an account-scoped session"
    if !rest.isEmpty then
      Prog.unsupported "several MCP servers resolve concurrently"
    let server ← resolveMcpServer (Twin.callArg call 0) accountId context first.1 first.2
    match server with
    | none => pure undef
    | some server =>
      let serverTools ← Prog.effect "mcpTools"
        [server.connection, .arr server.remoteTools.toArray,
         field context "onSandboxCpu", field context "onToolRetry"]
      let names := keysOf serverTools
      if names.length != server.remoteTools.length then
        Prog.throwError "Error"
          s!"config.mcp.{server.serverId} has remote tools whose sanitized model-facing names collide"
      let tools := Twin.callArg call 0
      let existing := keysOf tools
      let conflict := names.find? existing.contains
      let registered := names.takeWhile (!existing.contains ·)
      let approvals := field context "approvalRequirements"
      if !isUndef approvals && jsTrue (field server.serverConfig "needsApproval") then
        let updated := registered.foldl (fun pairs name => mapSet pairs name (toJson true))
          (mapPairs approvals)
        Prog.setChanged "args.2.approvalRequirements.$map" (field approvals "$map") (.arr updated)
      let policy := field context "policyMcpIdsByName"
      if !isUndef policy then
        let updated := registered.foldl (fun pairs name => mapSet pairs name (toJson server.serverId))
          (mapPairs policy)
        Prog.setChanged "args.2.policyMcpIdsByName.$map" (field policy "$map") (.arr updated)
      match conflict with
      | some name =>
        Prog.throwError "Error"
          s!"config.mcp.{server.serverId} model-facing name '{name}' conflicts with another tool"
      | none =>
        for name in names do
          Prog.setChanged s!"args.0.{name}" (field tools name) (field serverTools name)
        pure undef

/-- `availableToolNames`. -/
private def availableToolNames (call : Json) : Prog Json := do
  let byId := jsTrue (Twin.callArg call 1)
  let mut names : List String := []
  for (name, factory) in entriesOf (Twin.callArg call 0) do
    if byId then
      let id ← Prog.effect "factoryId" [factory]
      if !isUndef id then
        names := names ++ [str id]
    else
      names := names ++ [name]
  let sorted := (names.toArray.qsort (· < ·)).toList
  pure (toJson (if sorted.isEmpty then "none" else ", ".intercalate sorted))

/-- UTF-16 length, which is what `text.length` counts. -/
private def utf16Length (text : String) : Nat :=
  text.toList.foldl (fun total c => total + (if c.val > 0xFFFF then 2 else 1)) 0

/-- A UTF-8 prefix decoded the way a streaming `TextDecoder` does: a split character is held back. -/
private def decodePrefix (bytes : List UInt8) : String :=
  let rec attempt : Nat → List UInt8 → String
    | 0, _ => ""
    | fuel + 1, candidate =>
      match String.fromUTF8? (ByteArray.mk candidate.toArray) with
      | some text => text
      | none => attempt fuel candidate.dropLast
  attempt 4 bytes

/-- `MAX_UTF8_BYTES_PER_UNIT` in `runtime.ts`. -/
private def maxUtf8BytesPerUnit : Nat := 3

/-- `capped`: cuts text to a byte limit without splitting a character. -/
private def capped (call : Json) : Prog Json := do
  let text := str (Twin.callArg call 0)
  let some limit := (Twin.callArg call 1).getNat?.toOption
    | Prog.unsupported "a limit that is not a whole number"
  let whole := Json.mkObj [("text", toJson text), ("truncated", toJson false)]
  if utf16Length text * maxUtf8BytesPerUnit <= limit then
    return whole
  let bytes := text.toUTF8.toList
  if bytes.length <= limit then
    return whole
  return Json.mkObj [("text", toJson (decodePrefix (bytes.take limit))), ("truncated", toJson true)]

/-- `withPositionals`. -/
private def withPositionals (call : Json) : Prog Json := do
  let script := str (Twin.callArg call 0)
  let args := elems (Twin.callArg call 1)
  if args.isEmpty then
    return toJson script
  let quoted := args.map fun arg => "'" ++ (str arg).replace "'" "'\\''" ++ "'"
  return toJson s!"set -- {" ".intercalate quoted}\n{script}"

/-- `execResult`. -/
private def execResult (call : Json) : Prog Json := do
  let finished := Twin.callArg call 0
  let limit := field (Twin.callArg call 1) "outputLimitBytes"
  let timedOut := jsTrue (Twin.callArg call 2)
  let stdout ← Prog.effect "capped" [field finished "stdout", limit]
  let stderr ← Prog.effect "capped" [field finished "stderr", limit]
  let exitCode := field finished "exitCode"
  return Json.mkObj
    [("ok", toJson (!timedOut && exitCode.compress == "0")),
     ("exit_code", if timedOut then Json.null else exitCode),
     ("timed_out", toJson timedOut),
     ("stdout", field stdout "text"),
     ("stderr", field stderr "text"),
     ("truncated", toJson (jsTrue (field stdout "truncated") || jsTrue (field stderr "truncated")))]

/-- `INTERNET` in `runtime.ts`, read from the recorded module binding. -/
private def internetNetwork (call : Json) : Json :=
  Twin.moduleValue call "INTERNET"

/-- `DEADLINE_EXIT_CODE` in `runtime.ts`. -/
private def deadlineExitCode : String := "124"

/-- `8 * MAX_OUTPUT_BYTES`, the total output `just-bash` is allowed. -/
private def maxTotalOutputBytes : Nat := 8 * 1024 * 1024

/-- `Runtime.exec`. The rejected-`exec` path stays out: no recording reaches it. -/
private def runtimeExec (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let state := Twin.callArg call 1
  let before ←
    if state.compress == Json.null.compress then pure none
    else some <$> Prog.effect "decodeState" [state]
  let fs ← match before with
    | some decoded => pure (field decoded "fs")
    | none => Prog.effect "emptyFs"
  let cwd := field request "cwd"
  let timeoutMs := field request "timeoutMs"
  let _ ← Prog.effect "fs.mkdir" [cwd, Json.mkObj [("recursive", toJson true)]]
  let _ ← Prog.effect "new Bash"
    [Json.mkObj
      ([("fs", fs), ("cwd", cwd), ("env", field request "env"),
        ("executionLimits", Json.mkObj
          [("maxExecutionTimeMs", timeoutMs), ("maxOutputSize", toJson maxTotalOutputBytes)])] ++
       (if truthy (field request "enableInternet") then
         [("network", internetNetwork call)] else []))]
  let startedAt ← Prog.effect "Date.now"
  let script ← Prog.effect "withPositionals" [field request "script", field request "args"]
  let run ← Prog.attempt "bash .exec"
    [script, Json.mkObj [("cwd", cwd), ("rawScript", toJson true)]]
  let finished ← match run with
    | .ok value => pure value
    | _ => Prog.unsupported "a rejected bash exec"
  let timedOut ←
    if (field finished "exitCode").compress == deadlineExitCode then do
      let now ← Prog.effect "Date.now"
      match now, startedAt, timeoutMs with
      | .num a, .num b, .num t => pure (decide (a.mantissa - b.mantissa >= t.mantissa))
      | _, _, _ => Prog.unsupported "a clock that is not a number"
    else pure false
  let result ← Prog.effect "execResult" [finished, request, toJson timedOut]
  if !truthy (field request "persist") then
    return Json.mkObj [("result", result), ("state", Json.null)]
  let after ← Prog.effect "packState" [fs, cwd]
  let previous := match before with
    | some decoded => field decoded "packed"
    | none => Json.null
  let same ← Prog.effect "samePacked" [previous, after]
  if truthy same then
    return Json.mkObj [("result", result), ("state", toJson "unchanged")]
  if after.compress == Json.null.compress then
    return Json.mkObj [("result", result), ("state", Json.null)]
  let compressed ← Prog.effect "compressState" [after]
  return Json.mkObj [("result", result), ("state", compressed)]

private def base64Alphabet : Array Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray

/-- Standard base64, as the recorder writes `$bytes`. -/
private def base64 (bytes : List UInt8) : String :=
  let sym (n : Nat) : Char := base64Alphabet.getD (n % 64) '='
  let rec go : Nat → List UInt8 → List Char
    | 0, _ => []
    | _, [] => []
    | fuel + 1, a :: b :: c :: rest =>
      let n := a.toNat * 65536 + b.toNat * 256 + c.toNat
      [sym (n / 262144), sym (n / 4096), sym (n / 64), sym n] ++ go fuel rest
    | _, [a, b] =>
      let n := a.toNat * 65536 + b.toNat * 256
      [sym (n / 262144), sym (n / 4096), sym (n / 64), '=']
    | _, [a] =>
      let n := a.toNat * 65536
      [sym (n / 262144), sym (n / 4096), '=', '=']
  String.ofList (go (bytes.length + 1) bytes)

/-- The recorder's form of a `Uint8Array` holding the UTF-8 of `text`. -/
private def utf8Bytes (text : String) : Json :=
  Json.mkObj [("$bytes", toJson (base64 text.toUTF8.toList))]

/-- `bearerMatches`: digests both sides, so the compare does not depend on length. -/
private def bearerMatches (call : Json) : Prog Json := do
  let apiKey := Twin.callArg call 1
  if !truthy apiKey then
    return toJson false
  let header := requestHeader (Twin.callArg call 0) "authorization"
  let digests ← Prog.all
    [("crypto.subtle.digest", [toJson "SHA-256", utf8Bytes header]),
     ("crypto.subtle.digest", [toJson "SHA-256", utf8Bytes s!"Bearer {str apiKey}"])]
  match digests with
  | [.ok given, .ok expected] =>
    Prog.effect "crypto.subtle.timingSafeEqual" [given, expected]
  | _ => Prog.unsupported "a digest that failed"

/-- `factoryById`: stops at the first factory whose built tool has this id. -/
private def factoryById (call : Json) : Prog Json := do
  let wanted := Twin.callArg call 1
  let mut found := undef
  for (_, factory) in entriesOf (Twin.callArg call 0) do
    let id ← Prog.effect "factoryId" [factory]
    if id.compress == wanted.compress then
      found := factory
      break
  Prog.effect "parseOr" [Json.mkObj [("$opaque", toJson "ZodMiniCustom")], found]

/-- `sandboxHoldsWorkspace`. -/
private def sandboxHoldsWorkspace (call : Json) : Prog Json := do
  let sandbox := Twin.callArg call 1
  if str (Twin.callArg call 0) == "disk" then
    return toJson (str (field sandbox "provider") == "worker" && jsTrue (field sandbox "persistent"))
  Prog.effect "supportsS3WorkspaceMount" [field sandbox "provider", field sandbox "options"]

private def toolsSource (name : String) : String :=
  s!"apps/core/src/harness/tools/{name}"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/sandbox/http-executor.ts#HttpSandboxExecutor.run" httpRun,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#upgradeMachineSocket"
     upgradeMachineSocket,
   Twin.traced (toolsSource "index.ts#registerProviderTools") registerProviderTools,
   Twin.traced (toolsSource "index.ts#registerMcpTools") registerMcpTools,
   Twin.traced (toolsSource "provider-tool.ts#availableToolNames") availableToolNames,
   Twin.traced (toolsSource "provider-tool.ts#factoryById") factoryById,
   Twin.traced "apps/cloudflare-worker/src/runtime.ts#capped" capped,
   Twin.traced "apps/cloudflare-worker/src/runtime.ts#withPositionals" withPositionals,
   Twin.traced "apps/cloudflare-worker/src/runtime.ts#execResult" execResult,
   Twin.traced "apps/cloudflare-worker/src/runtime.ts#Runtime.exec" runtimeExec,
   Twin.traced "apps/cloudflare-sandbox/src/bearer.ts#bearerMatches" bearerMatches,
   Twin.traced "packages/convex/model/sandboxProviders.ts#sandboxHoldsWorkspace"
     sandboxHoldsWorkspace]

end Spec.Sandbox.Wavesandbox5b
