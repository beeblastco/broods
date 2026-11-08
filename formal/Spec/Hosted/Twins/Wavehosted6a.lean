import Spec.Twin
import Spec.Hosted.Twins.Wavehosted8a
import Spec.Access.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign6/hosted6a.tsv`.
-/

namespace Spec.Hosted.Wavehosted6a

open Lean Spec

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def obj (entries : List (String × Json)) : Json := Json.mkObj entries
private def fn (name : String) : Json := obj [("$fn", toJson name)]
private def undefinedResult : Prog Json := pure Twin.undefinedJson

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def str (value : Json) : String := (value.getStr?).toOption.getD ""

private def items (value : Json) : List Json :=
  match value with
  | .arr values => values.toList
  | _ => []

private def isTrue (value : Json) : Bool := value == toJson true

/-- `map.get(key)` on a recorded `Map`. -/
private def mapGet (table : Json) (key : String) : Option Json :=
  ((items (field table "$map")).find? fun entry => str (Twin.arg entry 0) == key).map
    fun entry => Twin.arg entry 1

private def aborted (signal : Json) : Bool := isTrue (field signal "$signal")

/-- `flushBatch`: numbers the live calls from one and starts the send without waiting. -/
def flushBatch (call : Json) : Prog Json := do
  let batch := Twin.callArg call 1
  let remaining := (items (field (Twin.moduleValue call "openBatches") "$map")).filter
    fun entry => Twin.arg entry 0 != Twin.callArg call 0
  Prog.setState "module.openBatches" (obj [("$map", .arr remaining.toArray)])
  let _ ← Prog.effect "clearTimeout" [field batch "timer"]
  let live := (items (field batch "calls")).filter fun entry => !aborted (field entry "abortSignal")
  if live.isEmpty then
    return Twin.undefinedJson
  for _ in live do
    let _ ← Prog.effect "call.abortSignal.addEventListener"
      [toJson "abort", fn "", obj [("once", toJson true)]]
  let requests := live.zipIdx.map fun (entry, index) =>
    obj [("id", toJson (toString (index + 1))), ("mcpRequest", field entry "request")]
  Prog.spawn "send" [batch, .arr requests.toArray, obj [("$signal", toJson false)]]
  undefinedResult

/-- `AccountCipher.dataKey`: a cached promise wins, then the unknown and retired checks. -/
def dataKey (call : Json) : Prog Json := do
  let self := Twin.self call
  let keyId := str (Twin.callArg call 0)
  match mapGet (Twin.field self "dataKeys") keyId with
  | some cached =>
    let value := Twin.resolved cached
    if undef value then Prog.unsupported "cached key still pending when recorded" else pure value
  | none =>
    match mapGet (Twin.field self "keys") keyId with
    | none => Prog.throwError "Error" s!"Unknown account key {keyId}"
    | some wrapped =>
      if !undef (field wrapped "retiredAt") then
        Prog.throwError "Error" s!"Account key {keyId} is retired"
      else do
        Spec.Hosted.Wavehosted8a.cacheDataKeyState call (Twin.callArg call 0)
        Prog.effect "unwrapAccountKey"
          [Twin.field self "accountId", Twin.field self "secrets", wrapped,
           Twin.field self "primitive"]

private def bridgeErrorChars : Nat := 512

private def responseStatus (response : Json) : Int :=
  ((field (field response "$response") "status").getInt?).toOption.getD 0

private def hasHeader (response : Json) (name : String) : Bool :=
  (items (field (field response "$response") "headers")).any fun entry =>
    str (Twin.arg entry 0) == name

/-- The `.catch` on the bridge fetch: a timeout or abort was metered, unreachable falls back. -/
private def bridgeFetchFailed (startedAt onInvokedError : Json) : Prog Json := do
  let error := onInvokedError
  let timedOut ← Prog.effect "isTimeoutError" [error]
  let details := field error "$error"
  let abortError := str (field details "$class") == "DOMException" && str (field details "name") == "AbortError"
  if !isTrue timedOut && str (field details "$class") == "DOMException" && undef (field details "name") then
    return ← Prog.unsupported "DOMException name was not recorded"
  if isTrue timedOut || abortError then
    let _ ← Prog.effect "onInvoked" [startedAt]
  let unreachable ← Prog.effect "isUnreachableError" [error]
  if isTrue unreachable then
    let message ← Prog.effect "toErrorMessage" [error]
    let wrapped ← Prog.effect "new WorkerNotRunError"
      [toJson s!"cloudflare MCP runtime unreachable: {str message}"]
    .fail wrapped
  .fail error

/-- `drainBridgeStream`, up to the streamed body, whose chunks the recording does not hold. -/
def drainBridgeStream (call : Json) : Prog Json := do
  let url := Twin.callArg call 0
  let payload := Twin.callArg call 1
  let apiKey ← Prog.effect "requireEnv" [toJson "CLOUDFLARE_MCP_API_KEY"]
  let startedAt ← Prog.effect "Date.now"
  let timeout ← Prog.effect "AbortSignal.timeout" [toJson (45000 : Nat)]
  let signal ← Prog.effect "AbortSignal.any" [.arr #[Twin.callArg call 2, timeout]]
  let init := obj
    [("method", toJson "POST"),
     ("headers", obj
       [("authorization", toJson s!"Bearer {str apiKey}"),
        ("content-type", toJson "application/json")]),
     ("body", toJson (Twin.jsonStringify 64 payload)),
     ("redirect", toJson "error"),
     ("signal", signal)]
  match ← Prog.attempt "fetch" [url, init] with
  | .pending => Prog.unsupported "fetch never settled"
  | .threw error _ => bridgeFetchFailed startedAt error
  | .ok response =>
    let status := responseStatus response
    if 200 ≤ status && status ≤ 299 then
      Prog.unsupported "the streamed body is not in the recording"
    else
      let text ← Prog.effect "response.text"
      let reason := String.ofList ((str text).toList.take bridgeErrorChars)
      let suffix := if reason.isEmpty then "" else s!": {reason}"
      let message := s!"cloudflare MCP runtime failed with HTTP {status}{suffix}"
      if hasHeader response "x-broods-nothing-ran" then
        let wrapped ← Prog.effect "new WorkerNotRunError" [toJson message, toJson status]
        .fail wrapped
      Prog.throwError "Error" message

private def base64Alphabet : List Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList

private def sextet (c : Char) : Option Nat :=
  base64Alphabet.idxOf? c

private def decodeGroup : List Nat → List Nat
  | [a, b] => [(a * 4 + b / 16) % 256]
  | [a, b, c] => [(a * 4 + b / 16) % 256, ((b % 16) * 16 + c / 4) % 256]
  | [a, b, c, d] =>
    [(a * 4 + b / 16) % 256, ((b % 16) * 16 + c / 4) % 256, ((c % 4) * 64 + d) % 256]
  | _ => []

private def decodeSextets (fuel : Nat) (rest : List Nat) : List Nat :=
  match fuel with
  | 0 => []
  | fuel + 1 =>
    if rest.isEmpty then [] else decodeGroup (rest.take 4) ++ decodeSextets fuel (rest.drop 4)

/-- `Buffer.from(text, "base64")`. Characters outside the alphabet are skipped, as Node does. -/
private def base64Decode (text : String) : List Nat :=
  let sextets := text.toList.filterMap sextet
  decodeSextets (sextets.length + 1) sextets

private def letter (n : Nat) : Char := base64Alphabet.getD (n % 64) 'A'

private def encodeGroup : List Nat → List Char
  | [a] => [letter (a / 4), letter ((a % 4) * 16), '=', '=']
  | [a, b] => [letter (a / 4), letter ((a % 4) * 16 + b / 16), letter ((b % 16) * 4), '=']
  | [a, b, c] =>
    [letter (a / 4), letter ((a % 4) * 16 + b / 16), letter ((b % 16) * 4 + c / 64), letter c]
  | _ => []

private def encodeBytes (fuel : Nat) (rest : List Nat) : List Char :=
  match fuel with
  | 0 => []
  | fuel + 1 =>
    if rest.isEmpty then [] else encodeGroup (rest.take 3) ++ encodeBytes fuel (rest.drop 3)

/-- A byte array as the recorder writes it. -/
private def bytesJson (bytes : List Nat) : Json :=
  obj [("$bytes", toJson (String.ofList (encodeBytes (bytes.length + 1) bytes)))]

private def bytesOf (value : Json) : List Nat := base64Decode (str (field value "$bytes"))

/-- `new TextDecoder("utf-8", { fatal: true })`, `none` for what the twins do not model. -/
private def decodeUtf8 (bytes : List Nat) : Option String :=
  if bytes.take 3 == [0xef, 0xbb, 0xbf] then none
  else String.fromUTF8? (ByteArray.mk (bytes.map UInt8.ofNat).toArray)

private def utf8Bytes (text : String) : List Nat := text.toUTF8.toList.map UInt8.toNat

private def intOf (value : Json) : Int := (value.getInt?).toOption.getD 0

private def nullish (value : Json) : Bool := value == .null || undef value

private def stringified (value : Json) : String := Twin.jsonStringify 32 value

private def ordered (entries : List (String × Json)) : Json :=
  obj (("$keys", Json.arr (entries.map (fun entry => toJson entry.1)).toArray) :: entries)

/-- The `Number(process.env.NAME)` every positive-number setting starts from. -/
private def envNumber (raw : Json) : Float :=
  match (raw.getStr?).toOption with
  | some text => Spec.Access.Js.numberOfString text
  | none => Spec.Access.Js.nan

private def finitePositive (value : Float) : Bool :=
  !value.isNaN && !value.isInf && value > 0.0

/-- `reuseKey`: a warm child is keyed by tenant and bundle, unless reuse is off. -/
def reuseKey (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let tenant := field event "tenantId"
  let sha := field event "expectedSha256"
  if Twin.env call "MCP_CHILD_REUSE" == toJson "0" then
    return .null
  match (tenant.getStr?).toOption, (sha.getStr?).toOption with
  | some tenantId, some expected => pure (toJson s!"{tenantId}:{expected}")
  | _, _ => pure .null

/-- `positiveEnvInt`. -/
def positiveEnvInt (call : Json) : Prog Json := do
  let value := envNumber (Twin.env call (str (Twin.callArg call 0)))
  if finitePositive value then
    pure (Spec.Access.Js.floatJson value.floor)
  else
    pure (Twin.callArg call 1)

/-- `matchesWarm`: same key, under the call cap, and not idle past its limit. -/
def matchesWarm (call : Json) : Prog Json := do
  let warm := Twin.moduleValue call "warm"
  if nullish warm || isTrue (field warm "dead") || field warm "key" != Twin.callArg call 0 then
    return toJson false
  let maxCalls ← Prog.effect "positiveEnvInt" [toJson "MCP_CHILD_MAX_CALLS", toJson (64 : Nat)]
  if intOf (field warm "callsServed") ≥ intOf maxCalls then
    return toJson false
  let idle ← Prog.effect "positiveEnvInt" [toJson "MCP_CHILD_IDLE_SECONDS", toJson (300 : Nat)]
  let now ← Prog.effect "Date.now"
  pure (toJson (decide (intOf now - intOf (field warm "lastUsedAt") ≤ intOf idle * 1000)))

/-- `lineStartsWith`. -/
def lineStartsWith (call : Json) : Prog Json := do
  let prefixBytes := bytesOf (Twin.callArg call 2)
  let filled := intOf (Twin.callArg call 1)
  pure (toJson (decide (filled ≥ (prefixBytes.length : Int)) &&
    (bytesOf (Twin.callArg call 0)).take prefixBytes.length == prefixBytes))

/-- `childTimeoutSeconds`: 28 seconds leaves the child's grace inside the run's 30. -/
def childTimeoutSeconds (call : Json) : Prog Json := do
  let graceBound : Float := 28.0
  let override := envNumber (Twin.env call "TOOL_RUNNER_TIMEOUT_SECONDS")
  let seconds := if finitePositive override then min graceBound override else graceBound
  pure (toJson (Spec.Access.Js.floatJson (max 1.0 seconds)).compress)

/-- `scrubbedEnv`: nothing from the role's environment but `PATH`. -/
def scrubbedEnv (call : Json) : Prog Json := do
  let home := Twin.callArg call 0
  let path := Twin.env call "PATH"
  let timeout ← Prog.effect "childTimeoutSeconds"
  pure (obj
    [("PATH", if nullish path then toJson "/usr/local/bin:/usr/bin:/bin" else path),
     ("HOME", home), ("TMPDIR", home), ("NODE_ENV", toJson "production"),
     ("TOOL_RUNNER_TIMEOUT_SECONDS", timeout)])

/-- `endWithError`: one untagged error frame, then the end of the stream. -/
def endWithError (call : Json) : Prog Json := do
  let frame := ordered [("t", toJson "error"), ("error", Twin.callArg call 1)]
  let _ ← Prog.effect "responseStream.write" [toJson (stringified frame ++ "\n")]
  let _ ← Prog.effect "responseStream.end"
  undefinedResult

/-- `killGroup`: the whole process group, or just the child if that fails. -/
def killGroup (call : Json) : Prog Json := do
  let child := Twin.callArg call 0
  match ← Prog.attempt "process.kill" [toJson (-intOf (Twin.field child "pid")), toJson "SIGKILL"] with
  | .ok _ => undefinedResult
  | _ =>
    let _ ← Prog.attempt "child.kill" [toJson "SIGKILL"]
    undefinedResult

/-- `retire`. -/
def retire (call : Json) : Prog Json := do
  if Twin.moduleValue call "warm" == Twin.callArg call 0 then
    Prog.setState "module.warm" .null
  let _ ← Prog.effect "killGroup" [field (Twin.callArg call 0) "child"]
  undefinedResult

private def responseOk (response : Json) : Bool :=
  let status := responseStatus response
  200 ≤ status && status ≤ 299

/-- `readBundleSource`: inline bytes win over a download. -/
def readBundleSource (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  match (field event "bundleSourceB64").getStr? with
  | .ok inline => pure (bytesJson (base64Decode inline))
  | .error _ =>
    let url := field event "bundleUrl"
    if ((url.getStr?).toOption).isNone then
      Prog.throwError "Error" "mcp runner event needs one of bundleSourceB64 or bundleUrl"
    else
      let response ← Prog.effect "fetch" [url]
      if !responseOk response then
        Prog.throwError "Error" s!"mcp server bundle fetch failed with HTTP {responseStatus response}"
      else
        Prog.effect "response.arrayBuffer"

private def promiseArg : Json := obj [("$opaque", toJson "Promise")]

private def maxErrorChars : Nat := 256

/-- `boundedMessage`. -/
def boundedMessage (call : Json) : Prog Json := do
  let error := Twin.callArg call 1
  let details := field error "$error"
  let text ←
    if !undef details then pure (str (field details "message"))
    else match error.getStr? with
      | .ok value => pure value
      | .error _ => Prog.unsupported "String() of a non-error value"
  let full := s!"{str (Twin.callArg call 0)}: {text}"
  pure (toJson (String.ofList (full.toList.take maxErrorChars)))

/-- `encodeFrame`. -/
def encodeFrame (call : Json) : Prog Json :=
  pure (bytesJson (utf8Bytes (stringified (Twin.callArg call 0) ++ "\n")))

/-- `errorFrame`. -/
def errorFrame (call : Json) : Prog Json := do
  let message ← Prog.effect "boundedMessage"
    [toJson "mcp server failed on the cloudflare runtime", Twin.callArg call 1]
  pure (obj [("t", toJson "error"), ("id", Twin.callArg call 0), ("error", message)])

private def hexDigit (n : Nat) : Char :=
  "0123456789abcdef".toList.getD n '0'

/-- `hex`. -/
def hexTwin (call : Json) : Prog Json :=
  pure (toJson (String.ofList ((bytesOf (Twin.callArg call 0)).flatMap fun byte =>
    [hexDigit (byte / 16), hexDigit (byte % 16)])))

/-- `ensureLoaded`: the ping overlaps the deadline that races it. -/
def ensureLoaded (_call : Json) : Prog Json := do
  let _ ← Prog.effect "worker.getEntrypoint" [toJson "Loaded"]
  let outcomes ← Prog.all
    [("worker.getEntrypoint<LoadedEntrypoint>(\"Loaded\").ping", []),
     ("withDeadline", [promiseArg, toJson (12000 : Nat), toJson "load timed out"])]
  match outcomes with
  | [_, .ok _] => undefinedResult
  | [_, .threw error _] => .fail error
  | _ => Prog.unsupported "the deadline never settled"

private def bodyStream : Json := obj [("$opaque", toJson "ReadableStream")]

/-- `downloadBundle`. -/
def downloadBundle (call : Json) : Prog Json := do
  let signal ← Prog.effect "AbortSignal.timeout" [toJson (10000 : Nat)]
  let response ← Prog.effect "fetch"
    [Twin.callArg call 0, obj [("redirect", toJson "manual"), ("signal", signal)]]
  if !responseOk response then
    Prog.throwError "Error" s!"bundle fetch failed with HTTP {responseStatus response}"
  else
    Prog.effect "readBoundedBytes" [bodyStream, obj [("remaining", toJson (10000000 : Nat))]]

/-- The stored copy, where reading it fails the same as not having one. -/
private def storedCopy (key : Json) : Prog (Option Json) := do
  match ← Prog.attempt "bundles .get" [key] with
  | .ok object =>
    if nullish object then return none
    match ← Prog.attempt "object.arrayBuffer" with
    | .ok bytes => pure (some bytes)
    | _ => pure none
  | _ => pure none

/-- `loadBundle`: every load is re-hashed, and only a download is written back. -/
def loadBundle (call : Json) : Prog Json := do
  let batch := Twin.callArg call 0
  let expected := field batch "expectedSha256"
  let key := toJson s!"{str expected}.mjs"
  let copy ← storedCopy key
  let bytes ← match copy with
    | some stored => pure stored
    | none => Prog.effect "downloadBundle" [field batch "bundleUrl"]
  let digest ← Prog.effect "crypto.subtle.digest" [toJson "SHA-256", bytes]
  let sha ← Prog.effect "hex" [digest]
  if sha != expected then
    Prog.throwError "Error" "bundle sha256 does not match the uploaded row"
  else
    if copy.isNone then
      Prog.spawn "bundles.put" [key, bytes, obj [("sha256", sha)]]
      let _ ← Prog.effect "ctx.waitUntil" [promiseArg]
    match decodeUtf8 (bytesOf bytes) with
    | some text => pure (toJson text)
    | none => Prog.unsupported "bundle is not plain UTF-8"

private def maxReads : Nat := 4096

/-- The read loop of `readBoundedBytes`, giving the bytes in order or the error to rethrow. -/
private def readChunks : Nat → Int → List Nat → Prog (Except Json (List Nat))
  | 0, _, _ => Prog.unsupported "more chunks than the model reads"
  | fuel + 1, remaining, taken => do
    match ← Prog.attempt "reader.read" with
    | .pending => Prog.unsupported "read never settled"
    | .threw error _ => pure (.error error)
    | .ok next =>
      if isTrue (field next "done") then
        pure (.ok taken)
      else
        let chunk := bytesOf (field next "value")
        let left := remaining - chunk.length
        if left < 0 then
          pure (.error (Prog.errorJson "Error" "body exceeds its size limit"))
        else
          readChunks fuel left (taken ++ chunk)

/-- `readBoundedBytes`. -/
def readBoundedBytes (call : Json) : Prog Json := do
  if nullish (Twin.callArg call 0) then
    return bytesJson []
  let _ ← Prog.effect "stream.getReader"
  let outcome ← readChunks maxReads (intOf (field (Twin.callArg call 1) "remaining")) []
  let _ ← Prog.effect "reader.releaseLock"
  match outcome with
  | .ok bytes => pure (bytesJson bytes)
  | .error error => .fail error

/-- `readBounded`. -/
def readBounded (call : Json) : Prog Json := do
  let bytes ← Prog.effect "readBoundedBytes" [Twin.callArg call 0, Twin.callArg call 1]
  match decodeUtf8 (bytesOf bytes) with
  | some text => pure (toJson text)
  | none => Prog.unsupported "body is not plain UTF-8"

private def maxOutputBytes : Int := 16 * 1024 * 1024
private def maxErrorFrameBytes : Int := 2048
private def endFrame : List Nat := utf8Bytes "{\"t\":\"end\"}\n"

/-- `streamFrames` for one request. Several interleave by which tenant answers first. -/
def streamFrames (call : Json) : Prog Json := do
  let requests := items (Twin.callArg call 1)
  match requests with
  | [request] =>
    let _ ← Prog.effect "writable.getWriter"
    let budget := maxOutputBytes - endFrame.length - maxErrorFrameBytes
    Prog.catchFail
      (do
        let served ← Prog.effect "serveRequest"
          [Twin.callArg call 0, request, obj [("remaining", toJson budget)]]
        let frame := field served "frame"
        let line ← Prog.effect "encodeFrame" [frame]
        let overhead := ((bytesOf line).length : Int) - intOf (field served "drawn")
        let final? := str (field frame "t") == "final"
        let written ←
          if final? && decide (overhead > budget) then do
            let replacement ← Prog.effect "errorFrame"
              [field request "id", toJson "output exceeded the 16 MiB batch limit"]
            Prog.effect "encodeFrame" [replacement]
          else
            pure line
        let _ ← Prog.effect "writer.write" [written]
        let _ ← Prog.effect "writer.write" [bytesJson endFrame]
        let _ ← Prog.effect "writer.close"
        undefinedResult)
      (fun error => do
        let _ ← Prog.effect "writer.abort" [error]
        undefinedResult)
  | _ => Prog.unsupported "concurrent requests interleave by the tenant's timing"

/-- The scheme and `host` of an absolute URL. -/
private def urlParts (url : String) : String × String :=
  let chars := url.toList
  let scheme := chars.takeWhile (· != ':')
  let afterScheme := (chars.drop (scheme.length + 1)).drop 2
  (String.ofList (scheme ++ [':']),
   String.ofList (afterScheme.takeWhile fun c => c != '/' && c != '?' && c != '#'))

/-- `TenantOutbound.fetch`: only http(s), and never the runtime's own hosts. -/
def tenantOutboundFetch (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let (scheme, host) := urlParts (str (field request "url"))
  let props := field (Twin.field (Twin.self call) "ctx") "props"
  let blocked := (items (field props "blockedHosts")).any (· == toJson host)
  if (scheme != "https:" && scheme != "http:") || blocked then
    return obj [("$response", obj [("status", toJson (403 : Nat)), ("headers", .arr #[])])]
  Prog.effect "fetch" [request, obj [("redirect", toJson "manual")]]

private def harness : String := "apps/core/src/harness/"
private def lambdaSource (name : String) : String := "apps/lambda/handler.mjs#" ++ name
private def workerSource (name : String) : String := "apps/cloudflare-mcp/src/index.ts#" ++ name

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (harness ++ "mcp/hosted.ts#flushBatch") flushBatch,
   Twin.traced (harness ++ "mcp/hosted.ts#drainBridgeStream") drainBridgeStream,
   Twin.traced "packages/convex/model/envelope.ts#AccountCipher.dataKey" dataKey,
   Twin.traced (lambdaSource "reuseKey") reuseKey,
   Twin.traced (lambdaSource "positiveEnvInt") positiveEnvInt,
   Twin.traced (lambdaSource "matchesWarm") matchesWarm,
   Twin.traced (lambdaSource "lineStartsWith") lineStartsWith,
   Twin.traced (lambdaSource "childTimeoutSeconds") childTimeoutSeconds,
   Twin.traced (lambdaSource "scrubbedEnv") scrubbedEnv,
   Twin.traced (lambdaSource "endWithError") endWithError,
   Twin.traced (lambdaSource "killGroup") killGroup,
   Twin.traced (lambdaSource "retire") retire,
   Twin.traced (lambdaSource "readBundleSource") readBundleSource,
   Twin.traced (workerSource "boundedMessage") boundedMessage,
   Twin.traced (workerSource "encodeFrame") encodeFrame,
   Twin.traced (workerSource "errorFrame") errorFrame,
   Twin.traced (workerSource "hex") hexTwin,
   Twin.traced (workerSource "ensureLoaded") ensureLoaded,
   Twin.traced (workerSource "downloadBundle") downloadBundle,
   Twin.traced (workerSource "loadBundle") loadBundle,
   Twin.traced (workerSource "readBoundedBytes") readBoundedBytes,
   Twin.traced (workerSource "readBounded") readBounded,
   Twin.traced (workerSource "streamFrames") streamFrames,
   Twin.traced (workerSource "TenantOutbound.fetch") tenantOutboundFetch]

end Spec.Hosted.Wavehosted6a
