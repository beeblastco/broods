import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign5/hosted5a.tsv`.
-/

namespace Spec.Hosted.Wavehosted5a

open Lean Spec

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def nil (value : Json) : Bool := value == .null || undef value
private def obj (entries : List (String × Json)) : Json := Json.mkObj entries
private def fnValue (name : String) : Json := obj [("$fn", toJson name)]
private def opaque_ (name : String) : Json := obj [("$opaque", toJson name)]

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def str? (value : Json) : Option String := (value.getStr?).toOption
private def str (value : Json) : String := (str? value).getD ""
private def isStr (value : Json) : Bool := (str? value).isSome

private def items (value : Json) : List Json :=
  match value with
  | .arr values => values.toList
  | _ => []

/-- JavaScript truthiness of a recorded value. -/
private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str text => !text.isEmpty
  | .num number => number != 0
  | _ => !undef value

private def set (value : Json) (name : String) (item : Json) : Json :=
  value.setObjVal! name item

/-- The entries of a recorded `Map`. -/
private def mapEntries (value : Json) : List (Json × Json) :=
  (items (field value "$map")).map fun entry =>
    (Twin.arg entry 0, Twin.arg entry 1)

private def mapGet (value : Json) (key : Json) : Option Json :=
  ((mapEntries value).find? (·.1 == key)).map (·.2)

private def mapDelete (value : Json) (key : Json) : Json :=
  obj [("$map", .arr ((mapEntries value).filter (·.1 != key)
    |>.map (fun entry => Json.arr #[entry.1, entry.2])).toArray)]

private def mapSet (value key entry : Json) : Json :=
  let entries := mapEntries value
  let next := if entries.any (·.1 == key) then
    entries.map (fun pair => if pair.1 == key then (key, entry) else pair)
    else entries ++ [(key, entry)]
  obj [("$map", .arr (next.map (fun pair => Json.arr #[pair.1, pair.2])).toArray)]

private def addNumbers (left right : Json) : Json :=
  toJson (((left.getInt?).toOption.getD 0) + ((right.getInt?).toOption.getD 0))

private def numGt (left right : Json) : Bool :=
  match left, right with
  | .num a, .num b => decide (b < a)
  | _, _ => false

/-- Enters the callbacks an instrumented call hands back, which perform no effects themselves. -/
private def drainSilent : Prog Unit :=
  Prog.drain (fun _ _ => pure ()) 4096

/-- The `(client) => client.listTools()` callback passed to `withClient`. -/
private def listToolsCallback : Prog Unit :=
  Prog.drain (fun label _ =>
    match label with
    | "arg1" => do
      let _ ← Prog.attempt "client.listTools"
      pure ()
    | other => Prog.unsupported s!"callback {other}") 8

/-- `fetchListing`'s synchronous start and what it left to do after its first await. -/
private def listingCall (connection onCpuUsec : Json) : String × List Json :=
  if truthy (field connection "sandbox") then
    ("sandboxMcpRequest",
      [field connection "sandbox", field (field connection "record") "name",
       obj [("method", toJson "tools/list"), ("params", obj [])]])
  else
    ("withClient", [connection, fnValue "", onCpuUsec])

/-- Validates a sandbox listing once it has landed; `withClient` runs the callback instead. -/
private def finishListing (connection : Json) (outcome : Outcome) : Prog Json := do
  match outcome with
  | .pending => Prog.unsupported "the listing never settled"
  | .threw error _ => .fail error
  | .ok listing =>
    if !truthy (field connection "sandbox") then
      return listing
    let accepted ← Prog.effect "isSpecType.ListToolsResult" [listing]
    if !truthy accepted then
      Prog.throwError "Error"
        s!"MCP server {str (field (field connection "record") "name")} answered tools/list with a result this SDK does not accept"
    else
      return listing

private def everyTool (name : String) : List Json → Prog Unit
  | [] => pure ()
  | tool :: rest => do
    let accepted ← Prog.effect "isSpecType.Tool" [tool]
    if truthy accepted then
      everyTool name rest
    else
      Prog.throwError "Error" s!"MCP server {name} listed a tool this SDK does not accept"

/-- `listMcpTools`. The result of a live cached listing is a promise the recording cannot read. -/
private def listMcpTools (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let onCpuUsec := Twin.callArg call 1
  let overrides := Twin.moduleValue call "testOverrides"
  if truthy (field overrides "listTools") then
    return ← Prog.effect "testOverrides.listTools" [connection]
  let record := field connection "record"
  if field record "transport" == toJson "machine" && !truthy (field connection "sandbox") then
    let tools ← Prog.effect "runMachineMcpList" [record]
    everyTool (str (field record "name")) (items tools)
    return tools
  let (listingFn, listingArgs) := listingCall connection onCpuUsec
  if truthy (field connection "uncached") then
    if !truthy (field connection "sandbox") then listToolsCallback
    let outcome ← Prog.attempt listingFn listingArgs
    let listing ← finishListing connection outcome
    return field listing "tools"
  let key ← Prog.effect "cacheKeyFor" [connection]
  let cache := Twin.moduleValue call "toolListCache"
  let current := mapGet cache key
  let cache ←
    match current with
    | none => pure cache
    | some entry =>
      let now ← Prog.effect "Date.now"
      if numGt (field entry "expiresAt") now then
        Prog.unsupported "a live cached listing is a promise the recording cannot read"
      else
        pure (mapDelete cache key)
  if !truthy (field connection "sandbox") then listToolsCallback
  let outcome ← Prog.attempt listingFn listingArgs
  let _ ← Prog.effect "pruneCache" [cache]
  let _ ← Prog.effect "Date.now"
  if let .threw _ _ := outcome then
    if current.isSome then Prog.setState "module.toolListCache" cache
  let listing ← finishListing connection outcome
  let now ← Prog.effect "Date.now"
  let ttl ← Prog.effect "clampTtlMs" [field listing "ttlMs"]
  let entry := obj [("tools", obj [("$opaque", toJson "Promise"), ("$fields", obj [])]),
    ("expiresAt", addNumbers now ttl)]
  Prog.setState "module.toolListCache" (mapSet cache key entry)
  return field listing "tools"

/-- `makeClient` inside `connectClient`. -/
private def makeClient (connection onCpuUsec discover : Json) (info : Json) : Prog Json := do
  let record := field connection "record"
  let hosted := field record "transport" == toJson "hosted"
  let headers ← Prog.effect "mcpRequestHeaders" [connection]
  let fetcher ←
    if hosted then Prog.effect "hostedMcpFetch" [connection, onCpuUsec]
    else pure (fnValue "publicHostFetch")
  let url := if hosted then toJson "http://mcp-hosted.internal/mcp" else field record "url"
  let transport ← Prog.effect "new StreamableHTTPClientTransport"
    [obj [("$url", url)],
     obj [("requestInit", obj [("headers", headers)]), ("fetch", fetcher)]]
  let client ← Prog.effect "new Client"
    [info,
     obj [("supportedProtocolVersions", .arr #[toJson "2026-07-28"]),
          ("versionNegotiation", obj [("mode", obj [("pin", toJson "2026-07-28")])])]]
  let connectOptions :=
    if truthy discover then
      obj [("prior", obj [("kind", toJson "modern"), ("discover", discover)])]
    else obj []
  let _ ← Prog.effect "client.connect" [transport, connectOptions]
  return client

/-- `connectClient`. -/
private def connectClient (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let key := Twin.callArg call 1
  let onCpuUsec := Twin.callArg call 2
  let info := Twin.moduleValue call "CLIENT_INFO"
  let record := field connection "record"
  if field record "transport" != toJson "hosted" && !truthy (field record "url") then
    return ← Prog.throwError "Error"
      s!"MCP server {str (field record "name")} has no url to connect to"
  if truthy (field connection "uncached") then
    return ← makeClient connection onCpuUsec Twin.undefinedJson info
  let cache := Twin.moduleValue call "discoverCache"
  let cached := mapGet cache key
  let (fresh, cache) ←
    match cached with
    | none => pure (false, cache)
    | some entry =>
      let now ← Prog.effect "Date.now"
      if numGt (field entry "expiresAt") now then pure (true, cache)
      else pure (false, mapDelete cache key)
  let prior := if fresh then (cached.map (field · "discover")).getD Twin.undefinedJson
    else Twin.undefinedJson
  let (client, cache) ←
    Prog.catchFail
      (do
        let made ← makeClient connection onCpuUsec prior info
        pure (made, cache))
      (fun error =>
        if !truthy prior then .fail error
        else do
          let made ← makeClient connection onCpuUsec Twin.undefinedJson info
          pure (made, mapDelete cache key))
  let discover ← Prog.effect "client.getDiscoverResult"
  if truthy discover && (mapGet cache key).isNone then
    let _ ← Prog.effect "pruneCache" [cache]
    let now ← Prog.effect "Date.now"
    let ttl ← Prog.effect "clampTtlMs" [field discover "ttlMs"]
    Prog.setState "module.discoverCache"
      (mapSet cache key (obj [("discover", discover), ("expiresAt", addNumbers now ttl)]))
  else if cache != Twin.moduleValue call "discoverCache" then
    Prog.setState "module.discoverCache" cache
  return client

/-- `withClient`: `client.close` runs and its failure is ignored, whatever the operation did. -/
private def withClient (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let key ← Prog.effect "cacheKeyFor" [connection]
  let client ← Prog.effect "connectClient" [connection, key, Twin.callArg call 2]
  let outcome ← Prog.attempt "operation" [client]
  let _ ← Prog.attempt "client.close"
  match outcome with
  | .ok value => return value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "the operation never settled"

/-- `clientErrorData`. -/
private def clientErrorData (call : Json) : Prog Json := do
  let failure := field (Twin.callArg call 0) "$error"
  if field failure "name" != toJson "ConvexError" then
    return .null
  let data := field (field failure "fields") "data"
  match data with
  | .obj _ =>
    if undef data || undef (field data "code") || undef (field data "message") then
      return .null
    if !isStr (field data "message") then
      return .null
    let known ← Prog.effect "isClientErrorCode" [field data "code"]
    if !truthy known then
      return .null
    return obj [("code", field data "code"), ("message", field data "message")]
  | _ => return .null

private def rpcSchema : Json := opaque_ "ZodMiniRecord"

/-- `handleMcpServiceRpc`. -/
private def handleMcpServiceRpc (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let request := Twin.callArg call 1
  let parsed ← Prog.effect "parseJsonBody" [request]
  let body ← Prog.effect "parseOr" [rpcSchema, parsed]
  let refuse (status : Nat) (message : String) : Prog Json :=
    Prog.effect "errorResponse" [toJson status, toJson message]
  if !truthy body then
    return ← refuse 400 "Request body must be a JSON object"
  let method_ := field body "method"
  if method_ != toJson "tools/list" && method_ != toJson "tools/call" then
    return ← refuse 400 "method must be tools/list or tools/call"
  let connection? : Sum Json Json ←
    if isStr (field body "serverId") then do
      let storage ← Prog.effect "getStorage"
      let _ := storage
      let record ← Prog.effect "getStorage().mcp.getById" [accountId, field body "serverId"]
      if !truthy record || field record "status" != toJson "active" then
        pure (Sum.inl (← refuse 404 "MCP server not found"))
      else
        let base ← Prog.effect "mcpConnection" [record, Twin.undefinedJson]
        let sandbox ← Prog.effect "explorerSandboxTarget" [accountId, record]
        pure (Sum.inr (if undef sandbox then base else set base "sandbox" sandbox))
    else do
      let probe ← Prog.effect "parseProbe" [field body "probe"]
      if isStr probe then
        pure (Sum.inl (← refuse 400 (str probe)))
      else
        let row ← Prog.effect "probeRecord" [accountId, probe]
        let base ← Prog.effect "mcpConnection" [row, Twin.undefinedJson]
        pure (Sum.inr (set base "uncached" (toJson true)))
  match connection? with
  | .inl response => return response
  | .inr connection =>
    if method_ == toJson "tools/list" then
      let tools ← Prog.effect "listMcpTools" [connection]
      return ← Prog.effect "jsonResponse" [toJson (200 : Nat), obj [("tools", tools)]]
    if !truthy (field body "toolName") || !isStr (field body "toolName") then
      return ← refuse 400 "tools/call needs a toolName"
    let args ← Prog.effect "parseOr" [rpcSchema, field body "args", obj []]
    let started ← Prog.effect "Date.now"
    let signal ← Prog.effect "AbortSignal.timeout" [toJson (30000 : Nat)]
    let result ← Prog.effect "callMcpToolResult"
      [connection, field body "toolName", args, obj [("abortSignal", signal)]]
    let finished ← Prog.effect "Date.now"
    let duration :=
      match finished, started with
      | .num a, .num b => toJson (a.mantissa - b.mantissa)
      | _, _ => .null
    Prog.effect "jsonResponse"
      [toJson (200 : Nat), obj [("result", result), ("durationMs", duration)]]

/-- JavaScript `<` on strings, by code unit, for ids that are ASCII. -/
private def strLt (left right : String) : Bool := decide (left < right)

private def insertBy (lt : Json → Json → Bool) (item : Json) : List Json → List Json
  | [] => [item]
  | head :: rest =>
    if lt item head then item :: head :: rest else head :: insertBy lt item rest

/-- A stable sort: an element goes after those it does not sort before. -/
private def stableSort (lt : Json → Json → Bool) (values : List Json) : List Json :=
  values.foldl (fun sorted item => insertBy lt item sorted) []

/-- `liveSince ?? Infinity` ordering. A value with none never sorts before one with. -/
private def liveBefore (left right : Json) : Bool :=
  let leftSince := field left "liveSince"
  let rightSince := field right "liveSince"
  if nil leftSince then false
  else if nil rightSince then true
  else numGt rightSince leftSince

private def enabledAgents (record host : Json) : List Json → Prog (List Json)
  | [] => pure []
  | agent :: rest => do
    let sandboxes := field (field agent "config") "sandboxes"
    if !(items sandboxes).contains (field host "sandboxId") then
      return ← enabledAgents record host rest
    let enabled ← Prog.effect "isToolEnabled"
      [field (field (field agent "config") "mcp") (str (field record "serverId"))]
    let others ← enabledAgents record host rest
    return if truthy enabled then agent :: others else others

/-- `explorerSandboxTarget`. -/
private def explorerSandboxTarget (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let record := Twin.callArg call 1
  if field record "transport" != toJson "machine" then
    return Twin.undefinedJson
  let _ ← Prog.effect "getStorage"
  let sandboxes ← Prog.effect "storage.sandboxConfigs.list" [accountId]
  let host? := (items sandboxes).find? fun sandbox =>
    field sandbox "name" == field record "sandbox" && field sandbox "stageId" == field record "stageId"
  match host? with
  | none => return Twin.undefinedJson
  | some host =>
    if field (field host "config") "provider" != toJson "lambda" then
      return Twin.undefinedJson
    let agents ← Prog.effect "storage.agents.listForStage"
      [accountId, field record "projectId", field record "stageId"]
    let chosen ← enabledAgents record host (items agents)
    drainSilent
    let ordered := stableSort
      (fun left right => strLt (str (field left "agentId")) (str (field right "agentId"))) chosen
    let outcomes ← Prog.all (ordered.map fun agent =>
      ("agentSandboxCandidate", [accountId, record, agent, host]))
    let candidates ← outcomes.mapM fun outcome =>
      match outcome with
      | .ok value => pure value
      | .threw error _ => (.fail error : Prog Json)
      | .pending => Prog.unsupported "a candidate never settled"
    drainSilent
    match stableSort liveBefore (candidates.filter (!undef ·)) with
    | best :: _ => return field best "target"
    | [] =>
      let runtime ← Prog.effect "resolveAgentRuntime"
        [obj [("sandboxes", .arr #[field host "sandboxId"])],
         obj [("accountId", accountId), ("agentId", toJson "mcp-explorer")]]
      Prog.effect "sandboxMcpTarget" [record, runtime]

/-- `pruneEmpty`: nested objects are cleaned first and vanish when nothing is left. -/
private def pruneEmpty (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let keys : List String :=
    match value.getObjVal? "$keys", value with
    | .ok (.arr names), _ => names.toList.filterMap str?
    | _, .obj kvs => kvs.keys.filter (· != "$keys")
    | _, _ => []
  let mut cleaned : List (String × Json) := []
  for key in keys do
    let raw := field value key
    if undef raw then
      continue
    let branch ← Prog.effect "parseOr" [opaque_ "ZodMiniRecord", raw]
    if truthy branch then
      let child ← Prog.effect "pruneEmpty" [branch]
      if truthy child then
        cleaned := cleaned ++ [(key, child)]
      continue
    cleaned := cleaned ++ [(key, raw)]
  return if cleaned.isEmpty then Twin.undefinedJson else obj cleaned

private def assertAgentRuntimeRefs (call : Json) : Prog Json := do
  let parsed ← Prog.effect "parseInput"
    [opaque_ "ZodMiniObject", Twin.callArg call 0, toJson "config"]
  Prog.effect "assertRuntimeRefs" [parsed, Twin.param call 1]

private def zodObject : Json := opaque_ "ZodObject"

/-- `createTaskServer`: the five MCP task methods it registers, in order. -/
private def createTaskServer (call : Json) : Prog Json := do
  let capability := Twin.moduleValue call "TASK_CAPABILITY"
  let capabilities := match capability with
    | .obj kvs => Json.obj (kvs.insert "tools" (obj []))
    | _ => obj [("tools", obj [])]
  let server ← Prog.effect "new Server"
    [Twin.moduleValue call "SERVER_INFO", obj [("capabilities", capabilities)]]
  let handler := fnValue ""
  let params := obj [("params", zodObject)]
  let _ ← Prog.effect "server.setRequestHandler" [toJson "tools/list", handler]
  let _ ← Prog.effect "server.setRequestHandler"
    [toJson "tools/call", obj [("params", zodObject), ("result", opaque_ "ZodUnion")], handler]
  for name in ["tasks/get", "tasks/update", "tasks/cancel"] do
    let _ ← Prog.effect "server.setRequestHandler" [toJson name, params, handler]
  return server

/-- A `Request`'s headers as the recorder writes them: lowercase names, sorted. -/
private def requestHeaderPairs (headers : Json) : Json :=
  let pairs : List (String × Json) :=
    match headers with
    | .obj kvs => (kvs.toArray.toList.filter (·.1 != "$keys")).map fun (key, value) => (key.toLower, value)
    | _ => []
  let sorted := pairs.toArray.qsort (fun left right => decide (left.1 < right.1))
  .arr (sorted.map fun (key, value) => Json.arr #[toJson key, value])

/-- `handleMcpRequest`. The factory runs inside `mcp.fetch`, entered as a callback. -/
private def handleMcpRequest (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let auth ← Prog.effect "resolveBearerAuth" [field request "headers"]
  if !truthy auth || field auth "kind" == toJson "admin" then
    return ← Prog.effect "errorResponse" [toJson (401 : Nat), toJson "Unauthorized"]
  let caller := obj [("auth", auth), ("request", request), ("replay", Twin.callArg call 1)]
  let mcp ← Prog.effect "createMcpHandler" [fnValue "", obj [("legacy", toJson "reject")]]
  let _ := mcp
  let incoming := obj [("$request", obj [("method", field request "method"),
    ("url", toJson "http://core/mcp"), ("headers", requestHeaderPairs (field request "headers")),
    ("body", if field request "method" == toJson "GET" || field request "method" == toJson "HEAD"
      then Json.null else field request "body")])]
  Prog.drain (fun label _ =>
    match label with
    | "arg0" => do
      let _ ← Prog.attempt "createTaskServer" [caller]
      pure ()
    | other => Prog.unsupported s!"callback {other}") 64
  let outcome ← Prog.attempt "mcp.fetch" [incoming]
  match outcome with
  | .ok value => return value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "mcp.fetch never settled"

private def harness : String := "apps/core/src/harness/"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (harness ++ "mcp/client.ts#listMcpTools") listMcpTools,
   Twin.traced (harness ++ "mcp/client.ts#connectClient") connectClient,
   Twin.traced (harness ++ "mcp/client.ts#withClient") withClient,
   Twin.traced "packages/convex/model/clientError.ts#clientErrorData" clientErrorData,
   Twin.traced "apps/core/src/accounts/mcp-service.ts#handleMcpServiceRpc" handleMcpServiceRpc,
   Twin.traced "apps/core/src/accounts/mcp-service.ts#explorerSandboxTarget" explorerSandboxTarget,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#pruneEmpty" pruneEmpty,
   Twin.traced "packages/convex/model/agentRules.ts#assertAgentRuntimeRefs" assertAgentRuntimeRefs,
   Twin.traced (harness ++ "mcp-tasks.ts#createTaskServer") createTaskServer,
   Twin.traced (harness ++ "mcp-tasks.ts#handleMcpRequest") handleMcpRequest]

end Spec.Hosted.Wavehosted5a
