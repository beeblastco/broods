import Spec.Twin
import Spec.Config.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign4/hosted4a.tsv`.
-/

namespace Spec.Hosted.Wavehosted4a

open Lean Spec

private def undefinedJson : Json := Twin.undefinedJson
private def undef (value : Json) : Bool := value == undefinedJson
private def nil (value : Json) : Bool := value == .null || undef value
private def obj (entries : List (String × Json)) : Json := Json.mkObj entries
private def fn (name : String) : Json := obj [("$fn", toJson name)]

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undefinedJson

private def str (value : Json) : String := (value.getStr?).toOption.getD ""
private def isStr (value : Json) : Bool := (value.getStr?).toOption.isSome

private def items (value : Json) : List Json :=
  match value with
  | .arr values => values.toList
  | _ => []

/-- `Object.keys`, in the recorded order. -/
private def ownKeys (value : Json) : List String :=
  match value.getObjVal? "$keys", value with
  | .ok (.arr keys), _ => keys.toList.filterMap fun key => (key.getStr?).toOption
  | _, .obj kvs => kvs.keys.filter (· != "$keys")
  | _, _ => []

/-- A plain JSON object, not `undefined`, an array or null. -/
private def isObject (value : Json) : Bool :=
  match value with
  | .obj _ => !undef value
  | _ => false

private def put (name : String) (value : Json) (entries : List (String × Json)) :
    List (String × Json) :=
  entries.filter (·.1 != name) ++ [(name, value)]

private def failClient (message : String) : Prog Json := do
  let error ← Prog.effect "new ClientError" [toJson message]
  .fail error

/-- What `normalizeConnection` writes into `input`. Its answer is `undefined`, so the out-parameter
is modelled here from the fields it validated. -/
private def connectionWrites (record : Json) (input : List (String × Json)) :
    List (String × Json) :=
  let copy (name : String) (entries : List (String × Json)) :=
    if undef (field record name) then entries else put name (field record name) entries
  let written := copy "runtime" (copy "sandbox" (copy "bundle" (copy "url" input)))
  let stored :=
    if undef (field record "bundleStorageId") then written
    else copy "sha256" (copy "bundleStorageId" written)
  let has (name : String) := stored.any (·.1 == name)
  let transport :=
    if has "sandbox" then some "machine"
    else if has "bundle" || has "bundleStorageId" then some "hosted"
    else if has "url" then some "http"
    else none
  let typed := match transport with
    | some kind => put "transport" (toJson kind) stored
    | none => stored
  if nil (field record "command") then typed else put "command" (field record "command") typed

/-- What `normalizeOauth` writes into `input`, for the same reason. -/
private def oauthWrites (record : Json) (input : List (String × Json)) : List (String × Json) :=
  let value := field record "oauth"
  if nil value then input
  else
    let tokenUrl := field value "tokenUrl"
    put "oauth" (obj ([("clientId", field value "clientId"),
      ("clientSecret", field value "clientSecret"),
      ("refreshToken", field value "refreshToken")] ++
      (if nil tokenUrl then [] else [("tokenUrl", tokenUrl)]))) input

private def normalizeMcpInput (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  if !isObject record then
    return ← failClient "Request body must be a JSON object"
  let mut input : List (String × Json) := []
  if !undef (field record "name") then
    input := put "name" (← Prog.effect "normalizeName" [field record "name"]) input
  if !nil (field record "description") then
    input := put "description"
      (← Prog.effect "normalizeDescription" [field record "description"]) input
  let _ ← Prog.effect "normalizeConnection" [record, obj input]
  input := connectionWrites record input
  if input.any (·.1 == "bundle") then
    input := put "sha256"
      (← Prog.effect "sha256Hex" [(input.lookup "bundle").getD undefinedJson]) input
  if !nil (field record "headers") then
    input := put "headers" (← Prog.effect "normalizeHeaders" [field record "headers"]) input
  let _ ← Prog.effect "normalizeOauth" [record, obj input]
  input := oauthWrites record input
  if !nil (field record "allowedTools") then
    input := put "allowedTools"
      (← Prog.effect "normalizeAllowedTools" [field record "allowedTools"]) input
  let disabled := field record "disabled"
  if !undef disabled then
    match disabled with
    | .bool _ => input := put "disabled" disabled input
    | _ => return ← failClient "disabled must be a boolean"
  if input.lookup "transport" == some (toJson "machine") && input.any (·.1 == "headers") then
    return ← failClient "headers do not apply to a machine server"
  if field (Twin.callArg call 1) "requireConnection" == toJson true then
    if !input.any (·.1 == "name") then
      return ← failClient "name must be provided"
    if !input.any (·.1 == "transport") then
      return ← failClient
        "url must be provided, or bundle for a hosted server, or sandbox for a server on a machine"
  return obj input

/-- `#wake`: runs each waiter queued when the push started. -/
private def wake (self : Json) : Prog Unit := do
  for _ in items (Twin.field self "#waiters") do
    let _ ← Prog.effect "waiter"

private def framePush (call : Json) : Prog Json := do
  let self := Twin.self call
  if !isStr (Twin.field self "#buffer") then
    return ← Prog.unsupported "the previous frame buffer was too big to record"
  let text := str (Twin.field self "#buffer") ++ str (Twin.callArg call 0)
  let lines := text.splitOn "\n"
  let mut frames := items (Twin.field self "#frames")
  for line in lines.dropLast do
    let frame ← Prog.effect "parseRunnerFrame" [toJson line]
    if !nil frame then frames := frames ++ [frame]
  if lines.getLast!.length > 524288 then
    return ← Prog.unsupported "the new frame buffer is too big to record"
  let buffer := toJson (lines.getLast!)
  if buffer != Twin.field self "#buffer" then
    Prog.setState "self.#buffer" buffer
  if .arr frames.toArray != Twin.field self "#frames" then
    Prog.setState "self.#frames" (.arr frames.toArray)
  if !(items (Twin.field self "#waiters")).isEmpty then
    Prog.setState "self.#waiters" (.arr #[])
  wake self
  return undefinedJson

private def frameClose (call : Json) : Prog Json := do
  let self := Twin.self call
  let frame ← Prog.effect "parseRunnerFrame" [Twin.field self "#buffer"]
  if Twin.field self "#buffer" != toJson "" then
    Prog.setState "self.#buffer" (toJson "")
  if !nil frame then
    Prog.setState "self.#frames" (.arr ((items (Twin.field self "#frames")) ++ [frame]).toArray)
  if Twin.field self "#closed" != toJson true then
    Prog.setState "self.#closed" (toJson true)
  if !(items (Twin.field self "#waiters")).isEmpty then
    Prog.setState "self.#waiters" (.arr #[])
  wake self
  return undefinedJson

private def requiredEnv (call : Json) : Prog Json := do
  let name := str (Twin.callArg call 0)
  let value := Twin.env call name
  let trimmed := if isStr value then Js.trim (str value) else ""
  if trimmed.isEmpty then
    return ← Prog.throwError "Error" s!"{name} must be set"
  return toJson trimmed

private def shutdownIsolatePool (call : Json) : Prog Json := do
  let reaper := Twin.moduleValue call "reaper"
  if !undef reaper then
    let _ ← Prog.effect "clearInterval" [reaper]
  if !undef reaper then
    Prog.setState "module.reaper" .null
  let pool := items (Twin.moduleValue call "pool")
  if !pool.isEmpty then
    Prog.setState "module.pool" (.arr #[])
  for _ in pool do
    let _ ← Prog.effect "worker.kill"
  return undefinedJson

private def setMcpForTests (call : Json) : Prog Json := do
  if Twin.moduleValue call "testOverrides" != Twin.callArg call 0 then
    Prog.setState "module.testOverrides" (Twin.callArg call 0)
  for name in ["discoverCache", "toolListCache"] do
    let empty := obj [("$map", .arr #[])]
    if Twin.moduleValue call name != empty then
      Prog.setState ("module." ++ name) empty
  let _ ← Prog.effect "clearMcpOauthTokens"
  return undefinedJson

private def stripTrailingSlashes (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile (· == '/')).reverse

private def responseOk (response : Json) : Bool :=
  match (field (field response "$response") "status").getNat? with
  | .ok status => 200 ≤ status && status < 300
  | _ => false

private def logHandler (call : Json) : Prog Json := do
  let payload ← Prog.effect "decodeCloudWatchEvent" [Twin.callArg call 0]
  if str (field payload "messageType") != "DATA_MESSAGE" || (items (field payload "logEvents")).isEmpty then
    return undefinedJson
  let auth ← Prog.effect "requiredEnv" [toJson "OTEL_EXPORTER_OTLP_HEADERS"]
  let body ← Prog.effect "otlpLogsRequest" [payload, auth]
  let endpoint ← Prog.effect "requiredEnv" [toJson "OTEL_EXPORTER_OTLP_ENDPOINT"]
  let headers ← Prog.effect "otlpHeaders" [auth]
  let signal ← Prog.effect "AbortSignal.timeout" [toJson (10000 : Nat)]
  let merged := put "content-type" (toJson "application/json")
    ((ownKeys headers).map fun key => (key, field headers key))
  let response ← Prog.effect "fetch"
    [toJson (stripTrailingSlashes (str endpoint) ++ "/v1/logs"),
     obj [("method", toJson "POST"), ("headers", obj merged),
          ("body", toJson (Twin.jsonStringify 64 body)), ("signal", signal)]]
  if !responseOk response then
    let status := (field (field response "$response") "status").compress
    return ← Prog.throwError "Error"
      s!"OTLP push failed with HTTP {status} for {str (field payload "logStream")}"
  return undefinedJson

private def base64Alphabet : List Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList

private def base64Encode (bytes : List Nat) : String :=
  let sym (n : Nat) := base64Alphabet.getD (n % 64) 'A'
  let rec go : List Nat → List Char
    | [] => []
    | [a] => [sym (a / 4), sym (a % 4 * 16), '=', '=']
    | [a, b] => [sym (a / 4), sym (a % 4 * 16 + b / 16), sym (b % 16 * 4), '=']
    | a :: b :: c :: rest =>
      [sym (a / 4), sym (a % 4 * 16 + b / 16), sym (b % 16 * 4 + c / 64), sym c] ++ go rest
  String.ofList (go bytes)

private def base64Decode (text : String) : List UInt8 :=
  let value (c : Char) : Nat := base64Alphabet.idxOf c
  let rec go : List Nat → List Nat
    | a :: b :: c :: d :: rest =>
      [a * 4 + b / 16, b % 16 * 16 + c / 4, c % 4 * 64 + d] ++ go rest
    | [a, b, c] => [a * 4 + b / 16, b % 16 * 16 + c / 4]
    | [a, b] => [a * 4 + b / 16]
    | _ => []
  (go ((text.toList.filter (· != '=')).map value)).map Nat.toUInt8

private def drainInvokeStream (call : Json) : Prog Json := do
  let client := Twin.callArg call 0
  let payload := Twin.callArg call 1
  let name ← Prog.effect "requireEnv" [toJson "TOOL_RUNNER_FUNCTION_NAME"]
  let isolated ← Prog.effect "booleanEnv" [toJson "MCP_TENANT_ISOLATION", toJson false]
  let encoded := base64Encode
    ((Twin.jsonStringify 64 payload).toUTF8.toList.map UInt8.toNat)
  let command ← Prog.effect "new InvokeWithResponseStreamCommand"
    [obj ([("FunctionName", name), ("InvocationType", toJson "RequestResponse")] ++
      (if isolated == toJson true then [("TenantId", field payload "tenantId")] else []) ++
      [("Payload", obj [("$bytes", toJson encoded)])])]
  let result ← Prog.effect "client.send"
    [command, obj [("abortSignal", Twin.callArg call 2)]]
  let _ := client
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "onInvoked" [now]
  for event in items (field result "EventStream") do
    let chunk := field (field event "PayloadChunk") "Payload"
    if !undef chunk then
      match String.fromUTF8? (ByteArray.mk (base64Decode (str (field chunk "$bytes"))).toArray) with
      | some text => let _ ← Prog.effect "queue.push" [toJson text]
      | none => return ← Prog.unsupported "a chunk split inside a UTF-8 sequence"
    else
      let complete := field event "InvokeComplete"
      let code := field complete "ErrorCode"
      if !undef code && str code != "" then
        let details := field complete "ErrorDetails"
        let reason := if isStr details && str details != "" then str details else str code
        return ← Prog.throwError "Error" s!"tool runner Lambda failed: {reason}"
  let _ ← Prog.effect "queue.push" [toJson ""]
  return undefinedJson

private def errorOf (value : Json) : Json := field value "$error"

/-- Enters the drain callback `runBatch` was given, once, with its queue and `onInvoked`. -/
private def runDrain (start : Json → Json → Prog Unit) : Prog Unit :=
  .input fun
    | some ("arg2", args) => Prog.catchFail (start (Twin.arg args 0) (Twin.arg args 1)) (fun _ => pure ())
    | some (other, _) => Prog.unsupported s!"callback {other}"
    | none => pure ()

private def sendBatch (call : Json) : Prog Json := do
  let batch := Twin.callArg call 0
  let requests := Twin.callArg call 1
  let signal := Twin.callArg call 2
  let record := field batch "record"
  let bucket ← Prog.effect "toolBundlesBucket"
  let bundleUrl ← Prog.effect "getS3ObjectUrl"
    [bucket, field record "bundleStorageKey", obj [("expiresInSeconds", toJson (120 : Nat))]]
  let payload := obj
    [("mode", toJson "mcp"), ("toolName", field record "name"), ("tenantId", field batch "tenantId"),
     ("expectedSha256", field record "sha256"), ("bundleUrl", bundleUrl), ("requests", requests)]
  let bridge ← Prog.effect "workersUrl" [record]
  let drainFn := obj [("$fn", toJson "")]
  let lambda : Json → Json → Prog Unit := fun queue onInvoked => do
    let client ← Prog.effect "defaultClient"
    let _ ← Prog.effect "drainInvokeStream" [client, payload, signal, queue, onInvoked]
  if !isStr bridge then
    runDrain lambda
    let outcome ← Prog.attempt "runBatch" [record, requests, drainFn]
    return ← settle outcome
  runDrain fun queue onInvoked => do
    let _ ← Prog.effect "drainBridgeStream" [bridge, payload, signal, queue, onInvoked]
  let first ← Prog.attempt "runBatch" [record, requests, drainFn]
  match first with
  | .ok value => return value
  | .pending => return ← Prog.unsupported "runBatch never settled"
  | .threw error _ =>
    let failure := errorOf error
    if (field failure "$class") != toJson "WorkerNotRunError" then
      return ← .fail error
    if field (field failure "fields") "status" == toJson (422 : Nat) then
      let _ ← Prog.effect "bundleKey" [record]
      let _ ← Prog.effect "Date.now"
    runDrain lambda
    let retry ← Prog.attempt "runBatch" [record, requests, drainFn]
    match retry with
    | .ok value => return value
    | .pending => return ← Prog.unsupported "runBatch never settled"
    | .threw lambdaError _ =>
      let text ← Prog.effect "toErrorMessage" [lambdaError]
      return ← Prog.throwError "Error"
        s!"{str text} (Lambda fallback after: {str (field failure "message")})"
where
  settle (outcome : Outcome) : Prog Json :=
    match outcome with
    | .ok value => pure value
    | .threw error _ => .fail error
    | .pending => Prog.unsupported "runBatch never settled"

private def callMcpToolResult (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let toolName := Twin.callArg call 1
  let args := Twin.callArg call 2
  let options := Twin.param call 3
  let overrides := Twin.moduleValue call "testOverrides"
  if !nil overrides && !nil (field overrides "callTool") then
    return ← Prog.effect "testOverrides.callTool" [connection, toolName, args]
  let record := field connection "record"
  if field record "transport" == toJson "machine" then
    let sandbox := field connection "sandbox"
    let relayed ← if nil sandbox then
        Prog.effect "runMachineMcpCall" [record, toolName, args]
      else
        Prog.effect "sandboxMcpRequest"
          [sandbox, field record "name",
           obj [("method", toJson "tools/call"),
                ("params", obj [("name", toolName), ("arguments", args)])],
           field options "abortSignal"]
    if (← Prog.effect "isCallToolResult" [relayed]) != toJson true then
      return ← Prog.throwError "Error"
        s!"MCP tool {str (field record "name")}.{str toolName} answered with a result this SDK does not accept"
    return relayed
  let signal := field options "abortSignal"
  let enter : Prog Unit := .input fun
    | some ("arg1", entered) =>
      Prog.catchFail
        (do
          let _ ← Prog.effect "client.callTool"
            [obj [("name", toolName), ("arguments", args)],
             if nil signal then obj [] else obj [("signal", signal)]]
          let _ := entered)
        (fun _ => pure ())
    | some (other, _) => Prog.unsupported s!"callback {other}"
    | none => pure ()
  enter
  let outcome ← Prog.attempt "withClient" [connection, fn "", field options "onCpuUsec"]
  match outcome with
  | .ok value => return value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "withClient never settled"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  let harness := "apps/core/src/harness/"
  [Twin.traced "packages/convex/model/mcp.ts#normalizeMcpInput" normalizeMcpInput,
   Twin.traced (harness ++ "frames.ts#FrameQueue.push") framePush,
   Twin.traced (harness ++ "frames.ts#FrameQueue.close") frameClose,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#requiredEnv" requiredEnv,
   Twin.traced "apps/lambda/sandbox-log-forwarder.mjs#handler" logHandler,
   Twin.traced (harness ++ "isolate/executor.ts#shutdownIsolatePool") shutdownIsolatePool,
   Twin.traced (harness ++ "mcp/client.ts#setMcpForTests") setMcpForTests,
   Twin.traced (harness ++ "mcp/client.ts#callMcpToolResult") callMcpToolResult,
   Twin.traced (harness ++ "mcp/hosted.ts#drainInvokeStream") drainInvokeStream,
   Twin.traced (harness ++ "mcp/hosted.ts#sendBatch") sendBatch]

end Spec.Hosted.Wavehosted4a
