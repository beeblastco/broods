import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign3/sandbox3a.tsv`.

The recorder cannot see `#private` fields, so a method whose effects carry `#config`, `#env`, `#shared`
or `#reservationKey` has no twin here.
-/

namespace Spec.Sandbox.Wavesandbox3a

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (j : Json) : Bool := j.compress == undef.compress

private def isNullish (j : Json) : Bool := isUndef j || j == .null

private def field (j : Json) (k : String) : Json := (j.getObjVal? k).toOption.getD undef

private def str (j : Json) : String := j.getStr?.toOption.getD ""

private def items (j : Json) : List Json := (j.getArr?.toOption.getD #[]).toList

private def truthy (j : Json) : Bool :=
  match j with
  | .null | .bool false | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def orElse (j fallback : Json) : Json := if isNullish j then fallback else j

private def obj (kv : List (String × Json)) : Json :=
  Json.mkObj (kv.filter fun (_, v) => !isUndef v)

private def num? (j : Json) : Option Nat :=
  match j with
  | .num n => if n.exponent == 0 && n.mantissa >= 0 then some n.mantissa.toNat else none
  | _ => none

private def schema (name : String) : Json := Json.mkObj [("$opaque", toJson name)]

private def fn (name : String) : Json := Json.mkObj [("$fn", toJson name)]

private def jsString (j : Json) : String :=
  if isUndef j then "undefined" else
  match j with
  | .str s => s
  | other => other.compress

/-- JavaScript's `trim`, over the whitespace a shell or log writes. -/
private def jsTrim (s : String) : String :=
  let ws (c : Char) : Bool := c == ' ' || c == '\n' || c == '\t' || c == '\r'
  String.ofList (((s.toList.dropWhile ws).reverse.dropWhile ws).reverse)

private def sextet (c : Char) : Option Nat :=
  if 'A' ≤ c ∧ c ≤ 'Z' then some (c.toNat - 65)
  else if 'a' ≤ c ∧ c ≤ 'z' then some (c.toNat - 97 + 26)
  else if '0' ≤ c ∧ c ≤ '9' then some (c.toNat - 48 + 52)
  else if c == '+' || c == '-' then some 62
  else if c == '/' || c == '_' then some 63
  else none

/-- `Buffer.from(text, "base64")`: skips what is not in the alphabet and stops at padding. -/
private def base64Decode (text : String) : List UInt8 :=
  let values := (text.toList.takeWhile (· != '=')).filterMap sextet
  let rec go : Nat → List Nat → List UInt8
    | 0, _ => []
    | fuel + 1, a :: b :: c :: d :: rest =>
      let n := a * 262144 + b * 4096 + c * 64 + d
      (n / 65536).toUInt8 :: (n / 256 % 256).toUInt8 :: (n % 256).toUInt8 :: go fuel rest
    | _, [a, b, c] =>
      let n := a * 262144 + b * 4096 + c * 64
      [(n / 65536).toUInt8, (n / 256 % 256).toUInt8]
    | _, [a, b] => [((a * 262144 + b * 4096) / 65536).toUInt8]
    | _, _ => []
  go (values.length + 1) values

private def alphabet : Array Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray

/-- `Buffer.toString("base64")`. -/
private def base64Encode (bytes : List UInt8) : String :=
  let letter (n : Nat) : Char := alphabet.getD (n % 64) 'A'
  let rec go : Nat → List UInt8 → List Char
    | 0, _ => []
    | fuel + 1, a :: b :: c :: rest =>
      let n := a.toNat * 65536 + b.toNat * 256 + c.toNat
      letter (n / 262144) :: letter (n / 4096) :: letter (n / 64) :: letter n :: go fuel rest
    | _, [a, b] =>
      let n := a.toNat * 65536 + b.toNat * 256
      [letter (n / 262144), letter (n / 4096), letter (n / 64), '=']
    | _, [a] =>
      let n := a.toNat * 65536
      [letter (n / 262144), letter (n / 4096), '=', '=']
    | _, [] => []
  String.ofList (go (bytes.length + 1) bytes)

private def bytesJson (bytes : List UInt8) : Json :=
  Json.mkObj [("$bytes", toJson (base64Encode bytes))]

/-- `options.abortSignal?.throwIfAborted()`. -/
private def abortCheck (options : Json) : Prog Unit := do
  if isUndef (field options "abortSignal") then return
  let _ ← Prog.effect "options.abortSignal?.throwIfAborted"

/-- Runs `body`, then `cleanup` whichever way it ended, then finishes the way `body` did. -/
private def tryFinally (body : Prog Json) (cleanup : Prog Unit) : Prog Json := do
  let result ← Prog.catchFail (body.bind fun value => pure (Except.ok value))
    (fun error => pure (Except.error error))
  cleanup
  match result with
  | .ok value => pure value
  | .error error => Prog.fail error

/-- `fmt`-free `${stderr}${stdout}`.trim(), or the fallback when that is empty. -/
private def shellFailure (result : Json) : String :=
  let text := jsTrim (str (field result "stderr") ++ str (field result "stdout"))
  if text.isEmpty then "Error: edit failed" else text

private def toolError (message : String) : Prog Unit := do
  let _ ← Prog.effect "toolError" [toJson message]

/-- `data.replace(old, new)`: the first occurrence only. -/
private def replaceFirst (data old new_ : String) : String :=
  match data.splitOn old with
  | [] => data
  | first :: rest => if rest.isEmpty then data else first ++ new_ ++ old.intercalate rest

/-- `editOnShell`. -/
private def editOnShell (call : Json) : Prog Json := do
  let rel := str (Twin.callArg call 1)
  let oldString := str (Twin.callArg call 2)
  let newString := str (Twin.callArg call 3)
  let replaceAll := truthy (Twin.callArg call 4)
  if oldString.isEmpty then toolError "Error: old_string must not be empty"
  if oldString == newString then toolError "Error: old_string and new_string are identical"
  let q := str (← Prog.effect "shellQuote" [toJson s!"./{rel}"])
  let quotedRel := str (← Prog.effect "shellQuote" [toJson rel])
  let read ← Prog.effect "run"
    [toJson (s!"if [ ! -f {q} ]; then printf 'Error: file not found: %s\\n' {quotedRel} >&2; " ++
      s!"exit 1; fi; base64 -w0 {q}")]
  if !truthy (field read "ok") then toolError (shellFailure read)
  if truthy (field read "truncated") then
    toolError s!"Error: {rel} is too large to edit here; rewrite it with write"
  let bytes := base64Decode (jsTrim (str (field read "stdout")))
  let some data := String.fromUTF8? (ByteArray.mk bytes.toArray)
    | Prog.unsupported "file is not valid UTF-8, which Buffer.toString replaces lossily"
  let count := (data.splitOn oldString).length - 1
  if count == 0 then toolError s!"Error: old_string not found in {rel}"
  if !replaceAll && count > 1 then
    toolError s!"Error: old_string is not unique ({count} matches); add context or set replace_all"
  let updated :=
    if replaceAll then newString.intercalate (data.splitOn oldString)
    else replaceFirst data oldString newString
  let encoded ← Prog.effect "toBase64" [toJson updated]
  let quoted := str (← Prog.effect "shellQuote" [encoded])
  let wrote ← Prog.effect "run" [toJson s!"printf '%s' {quoted} | base64 -d > {q}"]
  if !truthy (field wrote "ok") then toolError (shellFailure wrote)
  let replacements := if replaceAll then count else 1
  let plural := if replacements == 1 then "" else "s"
  return toJson s!"Edited {rel} ({replacements} replacement{plural})"

/-- The `for` body of `refreshBuildingSnapshots`. An executor without `snapshotStatus` is invisible
in a recording, so the twin models providers that have it. -/
private def refreshOne (snapshot : Json) : Prog Bool := do
  let executor := obj [("provider", field snapshot "provider")]
  let _ ← Prog.effect "providerExecutor" [executor]
  let state ← Prog.catchFail (Prog.effect "executor .snapshotStatus" [field snapshot "externalImageId"])
    (fun error => do
      let _ ← Prog.effect "toErrorMessage" [error]
      pure (toJson "building"))
  if str state == "building" then return false
  let row := obj
    [("accountId", field snapshot "accountId"), ("scope", field snapshot "scope"),
     ("name", field snapshot "name"), ("provider", field snapshot "provider"),
     ("baseImage", field snapshot "baseImage"),
     ("externalImageId", field snapshot "externalImageId"), ("status", state)]
  Prog.catchFail (do let _ ← Prog.effect "upsertSandboxSnapshot" [row]; pure true)
    (fun error => do let _ ← Prog.effect "toErrorMessage" [error]; pure false)

/-- `refreshBuildingSnapshots`. -/
private def refreshBuildingSnapshots (_call : Json) : Prog Json := do
  let building ← Prog.effect "runtime.query" [toJson "listBuildingSandboxSnapshots", Json.mkObj []]
  let mut finished : Nat := 0
  for snapshot in items building do
    if ← refreshOne snapshot then finished := finished + 1
  return toJson finished

/-- `DEFAULT_SIZE` in `sandbox-sizes.ts`. -/
private def defaultSize : String := "xsmall"

/-- `resolveSandboxSpecs`. -/
private def resolveSandboxSpecs (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let provider := str (field input "provider")
  let sizes := Twin.moduleValue call "SANDBOX_SIZES"
  let base := field sizes defaultSize
  if provider == "sandbox" then
    let resources ← Prog.effect "workdirResources" [input]
    return obj
      [("vcpu", orElse (field resources "cpu") (field base "vcpu")),
       ("memoryMb", orElse (field resources "memoryMb") (field base "memoryMb")),
       ("storageGb", orElse (field resources "diskGb") (field base "storageGb"))]
  if provider == "lambda" then return Twin.moduleValue call "MICROVM_SPECS"
  if provider == "worker" then return Twin.moduleValue call "WORKER_SPECS"
  let size := field input "size"
  if provider == "cloudflare" then
    let chosen := if isNullish size then defaultSize else str size
    return field (field (Twin.moduleValue call "CLOUDFLARE_INSTANCE_TYPES") chosen) "specs"
  if truthy size then return field sizes (str size)
  let options := orElse (field input "options") (Json.mkObj [])
  let positive (key : String) : Prog Json := Prog.effect "positiveNumber" [field options key]
  let cpu ← positive "cpu"
  let memory ← positive "memoryMb"
  let disk ← positive "diskGb"
  return obj
    [("vcpu", orElse cpu (field base "vcpu")),
     ("memoryMb", orElse memory (field base "memoryMb")),
     ("storageGb", orElse disk (field base "storageGb"))]

/-- The state a Workdir `Sandbox` holds, which its `state` getter reads. -/
private def sandboxState (sandbox : Json) : Json :=
  field (Twin.field sandbox "data") "state"

/-- `sandboxReservationKey` then `getSandboxExternalId`, as `#reservedId` does. -/
private def reservedId (request : Json) : Prog (Option Json) := do
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return none
  let id ← Prog.effect "getSandboxExternalId" [toJson "sandbox", key]
  return if truthy id then some id else none

/-- `#reserved`. -/
private def reserved (request : Json) : Prog (Option Json) := do
  let some id ← reservedId request | return none
  return some (← Prog.effect "this.#client.sandboxes.get" [id])

/-- `WorkdirSandboxExecutor.suspend` and `resume`. -/
private def workdirToggle (label : String) (call : Json) : Prog Json := do
  if let some _ ← reserved (Twin.callArg call 0) then
    let _ ← Prog.effect label
  return undef

/-- `WorkdirSandboxExecutor.snapshot`. -/
private def workdirSnapshot (call : Json) : Prog Json := do
  let some _ ← reserved (Twin.callArg call 0)
    | Prog.throwError "Error" "no reserved workdir sandbox to snapshot for this workspace"
  let data ← Prog.effect "sandbox.snapshot"
  let configString (key : String) : Prog Json := Prog.effect "configString" [field data key]
  let first ← configString "id"
  let snapshotId ← if isNullish first then configString "snapshot_id" else pure first
  if !truthy snapshotId then Prog.throwError "Error" "workdir snapshot did not return an id"
  let image ← configString "image_id"
  let externalImageId ← if isNullish image then configString "image" else pure image
  return obj
    ([("snapshotId", snapshotId)] ++
      if truthy externalImageId then [("externalImageId", externalImageId)] else [])

/-- `WorkdirSandboxExecutor.getInstanceInfo`. -/
private def workdirInstanceInfo (call : Json) : Prog Json := do
  let some id ← reservedId (Twin.callArg call 0) | return Json.null
  Prog.catchFail
    (do
      let sandbox ← Prog.effect "this.#client.sandboxes.get" [id]
      let state ← Prog.effect "mapWorkdirState" [sandboxState sandbox]
      let errorMessage ←
        if str state == "error" then Prog.effect "workdirRecordError" [sandbox] else pure undef
      pure (obj [("externalId", id), ("state", state), ("errorMessage", errorMessage)]))
    (fun error => do
      let gone ← Prog.effect "isSandboxGoneError" [error]
      if truthy gone then
        pure (obj [("externalId", id), ("state", toJson "terminating")])
      else
        Prog.fail error)

/-- `workdirRecordError`. -/
private def workdirRecordError (call : Json) : Prog Json :=
  Prog.effect "configString" [field (Twin.field (Twin.callArg call 0) "data") "error"]

/-- The three-way wait that both harness sessions' `runCommand` ends with. -/
private def runCommand (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  abortCheck options
  let process ← Prog.effect "this.spawnCommand" [options]
  if field options "abortSignal" != Twin.undefinedJson then
    return ← Prog.unsupported "Promise.all can reject with reads still pending, which par cannot express"
  let outcomes ← Prog.all
    [("readHarnessStream", [Twin.field process "stdout"]),
     ("readHarnessStream", [Twin.field process "stderr"]),
     ("process.wait", [])]
  match outcomes with
  | [.ok stdout, .ok stderr, .ok result] =>
    return obj [("exitCode", field result "exitCode"), ("stdout", stdout), ("stderr", stderr)]
  | [.threw error _, _, _] | [_, .threw error _, _] | [_, _, .threw error _] => Prog.fail error
  | _ => Prog.unsupported "a stream never finished"

/-- `WorkdirHarnessSession.readFile`. -/
private def workdirReadFile (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  abortCheck options
  let path := str (← Prog.effect "shellQuote" [field options "path"])
  let result ← Prog.effect "this.#sandbox.exec"
    [toJson (s!"if [ -f {path} ]; then base64 < {path} | tr -d '\\n'; " ++
      s!"elif [ ! -e {path} ]; then exit 44; else exit 45; fi")]
  abortCheck options
  let exitCode := num? (field result "exit_code")
  if exitCode == some 44 then return Json.null
  if exitCode != some 0 then
    Prog.fail (← Prog.effect "workdirError" [toJson "read file", result])
  return bytesJson (base64Decode (jsTrim (str (field result "stdout"))))

/-- The base64 of `Buffer.from(options.content)` when the content is bytes. -/
private def contentBase64 (options : Json) : Prog String :=
  match (field options "content").getObjVal? "$bytes" with
  | .ok (.str encoded) => pure encoded
  | _ => Prog.unsupported "content is not recorded bytes"

/-- `WorkdirHarnessSession.writeFile`. -/
private def workdirWriteFile (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  abortCheck options
  let uuid := str (← Prog.effect "randomUUID")
  let temporaryName := s!".broods-harness-upload-{uuid}"
  let temporaryPath := s!"/workspace/{temporaryName}"
  let body : Prog Json := do
    let encoded ← contentBase64 options
    let _ ← Prog.effect "this.#sandbox.writeFile" [toJson temporaryName, toJson encoded]
    abortCheck options
    let dir ← Prog.effect "dirname" [field options "path"]
    let quotedDir := str (← Prog.effect "shellQuote" [dir])
    let quotedTemporary := str (← Prog.effect "shellQuote" [toJson temporaryPath])
    let quotedPath := str (← Prog.effect "shellQuote" [field options "path"])
    let result ← Prog.effect "this.#sandbox.exec"
      [toJson s!"mkdir -p {quotedDir} && base64 -d {quotedTemporary} > {quotedPath}"]
    abortCheck options
    if num? (field result "exit_code") != some 0 then
      Prog.fail (← Prog.effect "workdirError" [toJson "write file", result])
    pure undef
  tryFinally body do
    let quoted := str (← Prog.effect "shellQuote" [toJson temporaryPath])
    let _ ← Prog.attempt "this.#sandbox .exec" [toJson s!"rm -f {quoted}"]

/-- `MicrovmHarnessSession.writeFile`. -/
private def microvmWriteFile (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  abortCheck options
  let encoded ← contentBase64 options
  let dir ← Prog.effect "dirname" [field options "path"]
  let quotedDir := str (← Prog.effect "shellQuote" [dir])
  let quotedContent := str (← Prog.effect "shellQuote" [toJson encoded])
  let quotedPath := str (← Prog.effect "shellQuote" [field options "path"])
  let signal := field options "abortSignal"
  let result ← Prog.effect "this.#shell.exec"
    [toJson s!"mkdir -p {quotedDir} && printf %s {quotedContent} | base64 -d > {quotedPath}",
     if isUndef signal then undef else obj [("abortSignal", signal)]]
  if num? (field result "exitCode") != some 0 then
    Prog.fail (← Prog.effect "microvmError" [toJson "write file", result])
  return undef

/-- The most chunks one read takes in this model. The TypeScript loop has no bound. -/
private def maxChunks : Nat := 4096

/-- The `for (;;)` of `MicrovmHarnessSession.readFile`. -/
private def readChunks (options : Json) :
    Nat → Option String → Nat → List UInt8 → Prog Json
  | 0, _, _, _ => Prog.unsupported "more chunks than the model allows"
  | fuel + 1, first, offset, collected => do
    abortCheck options
    let path := field options "path"
    let chunk ← Prog.effect "readFileChunk"
      [Json.mkObj [("exec", fn "exec")], path, toJson offset, field options "abortSignal"]
    if chunk == .null && first.isNone then return Json.null
    let stamp := str (field chunk "stamp")
    if chunk == .null || (first.isSome && first != some stamp) then
      Prog.throwError "Error" s!"{str path} changed while it was being read"
    let some encoded := ((field chunk "bytes").getObjVal? "$bytes").toOption
      | Prog.unsupported "chunk bytes were too large to record"
    let bytes := base64Decode (str encoded)
    let offset := offset + bytes.length
    let collected := collected ++ bytes
    let size := ((stamp.splitOn " ").headD "").toNat?.getD 0
    if bytes.isEmpty || offset >= size then return bytesJson collected
    readChunks options fuel (some stamp) offset collected

/-- `MicrovmHarnessSession.getPortUrl`. -/
private def microvmPortUrl (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let protocol := field options "protocol"
  if !isUndef protocol && str protocol != "ws" then
    Prog.throwError "Error" "MicroVM Harness proxy supports WebSocket ports only"
  Prog.effect "this.#proxy.getPortUrl" [field options "port"]

/-- The most pages one listing walks in this model. The TypeScript loop has no bound. -/
private def maxPages : Nat := 4096

private def frameParser (call : Json) : Prog Json :=
  Prog.effect "parseFrame" [schema "ZodDiscriminatedUnion", Twin.callArg call 0]

private def isUnreserved (c : Char) : Bool :=
  c.isAlphanum || "-_.!~*'()".toList.contains c

private def hexPair (byte : UInt8) : String :=
  let digit (n : Nat) : Char := "0123456789ABCDEF".toList.getD n '0'
  String.ofList ['%', digit (byte.toNat / 16), digit (byte.toNat % 16)]

/-- `encodeURIComponent(key).replace(/%2F/g, "/")`. -/
private def encodeKey (key : String) : String :=
  String.join (key.toList.map fun c =>
    if c == '/' || (c.toNat < 128 && isUnreserved c) then c.toString
    else String.join ((c.toString.toUTF8.toList).map hexPair))

/-- `err.cause ? toErrorMessage(err.cause) : undefined`, evaluated for a log line. -/
private def logCause (error : Json) : Prog Unit := do
  let cause := field (field (field error "$error") "fields") "cause"
  if truthy cause then
    let _ ← Prog.effect "toErrorMessage" [cause]

/-- Runs `body` and, as the S3 wrappers do, logs a failure before rethrowing it. -/
private def logged (body : Prog Json) : Prog Json :=
  Prog.catchFail body fun error => do
    logCause error
    Prog.fail error

/-- `posixMetadata`. -/
private def posixMetadata (call : Json) : Prog Json := do
  let kind := str (Twin.param call 0)
  let executable := truthy (Twin.param call 1)
  let now := jsString (← Prog.effect "Date.now")
  let stamp := toJson s!"{now}000000ns"
  let permissions :=
    if kind == "directory" then "0040777" else if executable then "0100777" else "0100666"
  return Json.mkObj
    [("file-owner", toJson "993"), ("file-group", toJson "990"),
     ("file-permissions", toJson permissions), ("file-atime", stamp), ("file-mtime", stamp)]

/-- `key.endsWith("/") ? "directory" : "file"`. -/
private def kindOf (key : String) : Json :=
  toJson (if key.endsWith "/" then "directory" else "file")

/-- `{ ...(value ? { key: value } : {}) }`. -/
private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if truthy value then [(key, value)] else []

/-- `copyS3Object`. -/
private def copyS3Object (call : Json) : Prog Json := logged do
  let options := Twin.param call 4
  let destinationKey := str (Twin.callArg call 3)
  let _ ← Prog.effect "awsClient"
  let metadata ← Prog.effect "posixMetadata"
    [kindOf destinationKey, toJson (field options "executable" == toJson true)]
  let source := str (Twin.callArg call 0) ++ "/" ++ encodeKey (str (Twin.callArg call 1))
  let command ← Prog.effect "new CopyObjectCommand"
    [obj ([("Bucket", Twin.callArg call 2), ("Key", toJson destinationKey),
        ("CopySource", toJson source), ("MetadataDirective", toJson "REPLACE"),
        ("Metadata", metadata)] ++ whenTruthy "ContentType" (field options "contentType"))]
  let _ ← Prog.effect "awsClient().send" [command]
  return undef

/-- `deleteS3Object`. -/
private def deleteS3Object (call : Json) : Prog Json := do
  let _ ← Prog.effect "awsClient" [Twin.callArg call 2]
  let command ← Prog.effect "new DeleteObjectCommand"
    [obj [("Bucket", Twin.callArg call 0), ("Key", Twin.callArg call 1)]]
  let _ ← Prog.effect "awsClient(access).send" [command]
  return undef

/-- `ensureS3DirectoryMarkers`. -/
private def ensureS3DirectoryMarkers (call : Json) : Prog Json := do
  let parts := (str (Twin.callArg call 1)).splitOn "/" |>.filter (!·.isEmpty)
  let mut prefix_ := ""
  for part in parts.dropLast do
    prefix_ := if prefix_.isEmpty then part else s!"{prefix_}/{part}"
    let metadata ← Prog.effect "posixMetadata" [toJson "directory"]
    let _ ← Prog.effect "putS3Object"
      [Twin.callArg call 0, toJson s!"{prefix_}/", toJson "",
       Json.mkObj
         [("contentType", toJson "application/x-directory"), ("metadata", metadata)]]
  return undef

/-- `headS3Object`. -/
private def headS3Object (call : Json) : Prog Json :=
  Prog.catchFail
    (do
      let _ ← Prog.effect "awsClient" [Twin.callArg call 2]
      let command ← Prog.effect "new HeadObjectCommand"
        [obj [("Bucket", Twin.callArg call 0), ("Key", Twin.callArg call 1)]]
      let result ← Prog.effect "awsClient(access).send" [command]
      pure (obj
        [("contentLength", field result "ContentLength"),
         ("contentType", field result "ContentType")]))
    (fun error => do
      if truthy (← Prog.effect "isMissingS3Error" [error]) then pure Json.null
      else Prog.fail error)

/-- The calendar date of a day count from 1970, by Hinnant's `civil_from_days`. -/
private def civilFromDays (days : Nat) : Nat × Nat × Nat :=
  let z := days + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let day := doy - (153 * mp + 2) / 5 + 1
  let month := if mp < 10 then mp + 3 else mp - 9
  (yoe + era * 400 + (if month <= 2 then 1 else 0), month, day)

private def padded (width value : Nat) : String :=
  let digits := toString value
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `Date.prototype.toISOString` for a time at or after 1970. -/
private def isoString (ms : Nat) : String :=
  let (year, month, day) := civilFromDays (ms / 86400000)
  let inDay := ms % 86400000
  s!"{padded 4 year}-{padded 2 month}-{padded 2 day}T{padded 2 (inDay / 3600000)}:" ++
    s!"{padded 2 (inDay / 60000 % 60)}:{padded 2 (inDay / 1000 % 60)}.{padded 3 (inDay % 1000)}Z"

/-- `etag.replace(/^"|"$/g, "")`. -/
private def stripQuotes (etag : String) : String :=
  let chars := etag.toList
  let front := if chars.head? == some '"' then chars.drop 1 else chars
  String.ofList (if front.getLast? == some '"' then front.dropLast else front)

/-- One entry of `listS3Prefix`'s answer, or none for an item with no key. -/
private def listedObject (item : Json) : Prog (Option Json) := do
  if !truthy (field item "Key") then return none
  let modified := field item "LastModified"
  let lastModified ←
    if isUndef modified then pure undef
    else match num? (field modified "$date") with
      | some ms => pure (toJson (isoString ms))
      | none => Prog.unsupported "a date before 1970 or not recorded as one"
  let etag := field item "ETag"
  return some (obj
    [("key", field item "Key"), ("size", field item "Size"), ("lastModified", lastModified),
     ("etag", if isUndef etag then undef else toJson (stripQuotes (str etag)))])

/-- The `do ... while` of `listS3Prefix`. -/
private def listPages (call : Json) : Nat → Json → List Json → Prog Json
  | 0, _, _ => Prog.unsupported "more pages than the model allows"
  | fuel + 1, token, found => do
    let _ ← Prog.effect "awsClient" [Twin.callArg call 2]
    let command ← Prog.effect "new ListObjectsV2Command"
      [obj [("Bucket", Twin.callArg call 0), ("Prefix", Twin.callArg call 1),
        ("ContinuationToken", token), ("MaxKeys", toJson (1000 : Nat))]]
    let result ← Prog.effect "awsClient(access).send" [command]
    let mut found := found
    for item in items (field result "Contents") do
      if let some entry ← listedObject item then found := found ++ [entry]
    let next := field result "NextContinuationToken"
    if truthy next then listPages call fuel next found
    else return .arr found.toArray

/-- `putS3ObjectUrl`. -/
private def putS3ObjectUrl (call : Json) : Prog Json := do
  let client ← Prog.effect "awsClient"
  let command ← Prog.effect "new PutObjectCommand"
    [obj [("Bucket", Twin.callArg call 0), ("Key", Twin.callArg call 1)]]
  Prog.effect "getSignedUrl"
    [client, command,
     Json.mkObj
       [("expiresIn", orElse (field (Twin.param call 2) "expiresInSeconds") (toJson (300 : Nat)))]]

/-- `readS3Text`. -/
private def readS3Text (call : Json) : Prog Json := do
  let _ ← Prog.effect "readS3Body"
    [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2, Twin.callArg call 3]
  Prog.effect "body.transformToString"

/-- `s3ObjectExists`. -/
private def s3ObjectExists (call : Json) : Prog Json := logged do
  let head ← Prog.effect "headS3Object"
    [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2]
  return toJson (head != .null)

/-- JavaScript's `length` of a string: UTF-16 code units. -/
private def utf16Length (text : String) : Nat :=
  text.toList.foldl (fun total c => total + if c.toNat > 65535 then 2 else 1) 0

/-- `typeof body === "string" ? body.length : body.byteLength`. -/
private def bodySize (body : Json) : Option Nat :=
  match body with
  | .str text => some (utf16Length text)
  | other => ((other.getObjVal? "$bytes").toOption).map fun encoded =>
      (base64Decode (str encoded)).length

/-- `writeS3Object`. -/
private def writeS3Object (call : Json) : Prog Json := do
  let body := Twin.callArg call 2
  let key := str (Twin.callArg call 1)
  let options := Twin.param call 3
  let some size := bodySize body
    | Prog.unsupported "body is neither a string nor recorded bytes"
  logged do
    let metadata ← Prog.effect "posixMetadata"
      [kindOf key, toJson (field options "executable" == toJson true)]
    let _ ← Prog.effect "putS3Object"
      [Twin.callArg call 0, toJson key, body,
       obj [("contentType", field options "contentType"), ("metadata", metadata),
         ("access", field options "access")]]
    return toJson size

/-- `putS3Object`. -/
private def putS3Object (call : Json) : Prog Json := do
  let options := Twin.param call 3
  let _ ← Prog.effect "awsClient" [field options "access"]
  let command ← Prog.effect "new PutObjectCommand"
    [obj ([("Bucket", Twin.callArg call 0), ("Key", Twin.callArg call 1),
        ("Body", Twin.callArg call 2)] ++
      whenTruthy "ContentType" (field options "contentType") ++
      whenTruthy "Metadata" (field options "metadata"))]
  let _ ← Prog.effect "awsClient(options.access).send" [command]
  return undef

private def skipQueue : Json := Json.mkObj [("skipQueue", toJson true)]

/-- `setSandboxInstanceSpecs`: a failed mirror write is only logged. -/
private def setSandboxInstanceSpecs (call : Json) : Prog Json := do
  let _ ← Prog.attempt "adminMutation"
    [toJson "sandbox.instances.setSpecs",
     obj [("accountId", Twin.callArg call 0), ("reservationKey", Twin.callArg call 1),
       ("externalId", Twin.callArg call 2), ("specs", Twin.callArg call 3)],
     skipQueue]
  return undef

/-- `setSandboxInstanceStatus`. -/
private def setSandboxInstanceStatus (call : Json) : Prog Json := do
  let options := Twin.callArg call 3
  let outcome ← Prog.attempt "adminMutation"
    [toJson "sandbox.instances.setStatus",
     obj [("accountId", Twin.callArg call 0), ("reservationKey", Twin.callArg call 1),
       ("status", Twin.callArg call 2),
       ("observed", toJson (field options "observed" == toJson true)),
       ("errorMessage", field options "errorMessage")],
     skipQueue]
  match outcome with
  | .ok changed => return changed
  | _ => return toJson false

/-- `sandboxInstanceIsControllable`. -/
private def sandboxInstanceIsControllable (call : Json) : Prog Json := do
  let answer ← Prog.effect "adminQuery"
    [toJson "sandbox.instances.isControllable",
     obj [("accountId", Twin.callArg call 0), ("sandboxConfigId", Twin.callArg call 1),
       ("reservationKey", Twin.callArg call 2)]]
  return toJson (answer == toJson true)

/-- `recordSandboxBurst`. -/
private def recordSandboxBurst (call : Json) : Prog Json := do
  let totals := Twin.callArg call 2
  let outcome ← Prog.attempt "adminMutation"
    [toJson "sandbox.instances.recordBurst",
     obj [("accountId", Twin.callArg call 0), ("externalId", Twin.callArg call 1),
       ("vcpuSeconds", field totals "vcpuSeconds"), ("gbSeconds", field totals "gbSeconds")],
     skipQueue]
  match outcome with
  | .ok recorded => return recorded
  | _ => return toJson false

/-- `findSandboxSnapshot`. -/
private def findSandboxSnapshot (call : Json) : Prog Json :=
  Prog.effect "adminQuery"
    [toJson "sandbox.snapshots.findByImage",
     obj (whenTruthy "accountId" (Twin.callArg call 0) ++
       [("externalImageId", Twin.callArg call 1)])]

/-- `upsertSandboxSnapshot`. -/
private def upsertSandboxSnapshot (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let copied := ["accountId", "scope", "name", "provider", "baseImage", "externalImageId"]
  let _ ← Prog.effect "adminMutation"
    [toJson "sandbox.snapshots.upsert",
     obj (copied.map (fun key => (key, field input key)) ++
       whenTruthy "status" (field input "status"))]
  return undef

/-- `getSandboxExternalId` and `getSandboxReservationRecord`. -/
private def reservationQuery (name : String) (call : Json) : Prog Json :=
  Prog.effect "runtime.query"
    [toJson name, obj [("provider", Twin.callArg call 0), ("reservationKey", Twin.callArg call 1)]]

/-- The arguments `claimSandboxInstance` and `saveSandboxInstance` both write. -/
private def reservationRow (call : Json) : Json :=
  obj [("provider", Twin.callArg call 0), ("reservationKey", Twin.callArg call 1),
    ("externalId", Twin.callArg call 2), ("accountId", Twin.callArg call 3),
    ("ttlSeconds", Twin.callArg call 4)]

/-- `claimSandboxInstance`. -/
private def claimSandboxInstance (call : Json) : Prog Json := do
  if !truthy (Twin.callArg call 3) then return toJson false
  Prog.effect "runtime.mutate" [toJson "claimSandboxReservation", reservationRow call]

/-- `saveSandboxInstance`. -/
private def saveSandboxInstance (call : Json) : Prog Json := do
  if !truthy (Twin.callArg call 3) then return undef
  let _ ← Prog.effect "runtime.mutate" [toJson "saveSandboxReservation", reservationRow call]
  return undef

private def core : String := "apps/core/src/"
private def sandboxDir : String := core ++ "harness/sandbox/"
private def workdir : String := sandboxDir ++ "workdir-executor.ts#"
private def workdirDriver : String := sandboxDir ++ "workdir-harness-driver.ts#WorkdirHarnessSession."
private def microvmDriver : String := sandboxDir ++ "microvm-harness-driver.ts#MicrovmHarnessSession."
private def s3 : String := core ++ "shared/s3.ts#"
private def machineSocket : String := core ++ "shared/machine-socket.ts#"
private def utils : String := sandboxDir ++ "utils.ts#"
private def instances : String := core ++ "shared/convex/sandbox-instances.ts#"
private def snapshots : String := core ++ "shared/convex/sandbox-snapshots.ts#"
private def store : String := sandboxDir ++ "instance-store.ts#"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (core ++ "harness/tools/edit.tool.ts#editOnShell") editOnShell,
   Twin.traced (core ++ "shared/sandbox-snapshot-builds.ts#refreshBuildingSnapshots")
     refreshBuildingSnapshots,
   Twin.traced (core ++ "shared/sandbox-sizes.ts#resolveSandboxSpecs") resolveSandboxSpecs,
   Twin.traced (workdir ++ "WorkdirSandboxExecutor.snapshot") workdirSnapshot,
   Twin.traced (workdir ++ "WorkdirSandboxExecutor.suspend") (workdirToggle "sandbox.pause"),
   Twin.traced (workdir ++ "WorkdirSandboxExecutor.resume") (workdirToggle "sandbox.resume"),
   Twin.traced (workdir ++ "WorkdirSandboxExecutor.getInstanceInfo") workdirInstanceInfo,
   Twin.traced (workdir ++ "workdirRecordError") workdirRecordError,
   Twin.traced (workdirDriver ++ "readFile") workdirReadFile,
   Twin.traced (workdirDriver ++ "writeFile") workdirWriteFile,
   Twin.traced (workdirDriver ++ "runCommand") runCommand,
   Twin.traced (microvmDriver ++ "writeFile") microvmWriteFile,
   Twin.traced (microvmDriver ++ "readFile")
     (fun call => readChunks (Twin.callArg call 0) maxChunks none 0 []),
   Twin.traced (microvmDriver ++ "getPortUrl") microvmPortUrl,
   Twin.traced (microvmDriver ++ "runCommand") runCommand,
   Twin.traced (s3 ++ "posixMetadata") posixMetadata,
   Twin.traced (s3 ++ "copyS3Object") copyS3Object,
   Twin.traced (s3 ++ "deleteS3Object") deleteS3Object,
   Twin.traced (s3 ++ "ensureS3DirectoryMarkers") ensureS3DirectoryMarkers,
   Twin.traced (s3 ++ "headS3Object") headS3Object,
   Twin.traced (s3 ++ "listS3Prefix") (fun call => logged (listPages call maxPages undef [])),
   Twin.traced (s3 ++ "putS3ObjectUrl") putS3ObjectUrl,
   Twin.traced (s3 ++ "readS3Text") readS3Text,
   Twin.traced (s3 ++ "s3ObjectExists") s3ObjectExists,
   Twin.traced (s3 ++ "writeS3Object") writeS3Object,
   Twin.traced (s3 ++ "putS3Object") putS3Object,
   Twin.traced (instances ++ "setSandboxInstanceSpecs") setSandboxInstanceSpecs,
   Twin.traced (instances ++ "setSandboxInstanceStatus") setSandboxInstanceStatus,
   Twin.traced (instances ++ "sandboxInstanceIsControllable") sandboxInstanceIsControllable,
   Twin.traced (instances ++ "recordSandboxBurst") recordSandboxBurst,
   Twin.traced (snapshots ++ "findSandboxSnapshot") findSandboxSnapshot,
   Twin.traced (snapshots ++ "upsertSandboxSnapshot") upsertSandboxSnapshot,
   Twin.traced (store ++ "getSandboxExternalId") (reservationQuery "getSandboxReservation"),
   Twin.traced (store ++ "getSandboxReservationRecord")
     (reservationQuery "getSandboxReservationRecord"),
   Twin.traced (store ++ "claimSandboxInstance") claimSandboxInstance,
   Twin.traced (store ++ "saveSandboxInstance") saveSandboxInstance,
   Twin.traced (machineSocket ++ "parseCoreFrame") frameParser,
   Twin.traced (machineSocket ++ "parseDaemonFrame") frameParser]

end Spec.Sandbox.Wavesandbox3a
