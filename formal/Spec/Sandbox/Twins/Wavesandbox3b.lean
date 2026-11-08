import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign3/sandbox3b.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox3b

open Lean Spec

private def field (j : Json) (k : String) : Json :=
  (j.getObjVal? k).toOption.getD Twin.undefinedJson

private def str (j : Json) : String := j.getStr?.toOption.getD ""
private def items (j : Json) : List Json := j.getArr?.toOption.getD #[] |>.toList
private def undef (j : Json) : Bool := j == Twin.undefinedJson
private def nullish (j : Json) : Bool := undef j || j == .null
private def nonEmpty (j : Json) : Bool := str j != ""
private def num (n : Int) : Json := toJson n
private def intOf (j : Json) : Option Int := j.getInt?.toOption

/-- A recorded `Map` as its entries, in insertion order. -/
private def mapEntries (j : Json) : List (Json × Json) :=
  (items (field j "$map")).filterMap fun pair =>
    match items pair with
    | [key, value] => some (key, value)
    | _ => none

private def mapGet (j : Json) (key : String) : Option Json :=
  (mapEntries j).find? (fun entry => str entry.1 == key) |>.map (·.2)

private def setHas (j : Json) (value : String) : Bool :=
  (items (field j "$set")).any (str · == value)

private def isJsSpace (c : Char) : Bool :=
  c == ' ' || c == '\n' || c == '\t' || c == '\r' || c == '\x0b' || c == '\x0c' ||
  c.val == 0xA0 || c.val == 0xFEFF || c.val == 0x2028 || c.val == 0x2029

/-- `String.prototype.trim`, for the whitespace that occurs in these inputs. -/
private def jsTrim (s : String) : String :=
  let front := s.toList.dropWhile isJsSpace
  String.ofList (front.reverse.dropWhile isJsSpace).reverse

private def base64Value (c : Char) : Option Nat :=
  if 'A' ≤ c && c ≤ 'Z' then some (c.toNat - 'A'.toNat)
  else if 'a' ≤ c && c ≤ 'z' then some (c.toNat - 'a'.toNat + 26)
  else if '0' ≤ c && c ≤ '9' then some (c.toNat - '0'.toNat + 52)
  else if c == '+' then some 62
  else if c == '/' then some 63
  else none

/-- Canonical base64 to bytes, or `none` for anything else. -/
private def base64Decode (text : String) : Option (List UInt8) :=
  let rec go (fuel : Nat) (rest : List Char) (out : List UInt8) : Option (List UInt8) :=
    match fuel, rest with
    | _, [] => some out.reverse
    | 0, _ => none
    | _ + 1, a :: b :: '=' :: '=' :: [] => do
      let x ← base64Value a
      let y ← base64Value b
      some (((x * 4 + y / 16).toUInt8 :: out).reverse)
    | _ + 1, a :: b :: c :: '=' :: [] => do
      let x ← base64Value a
      let y ← base64Value b
      let z ← base64Value c
      some (((y % 16 * 16 + z / 4).toUInt8 :: (x * 4 + y / 16).toUInt8 :: out).reverse)
    | fuel + 1, a :: b :: c :: d :: tail => do
      let x ← base64Value a
      let y ← base64Value b
      let z ← base64Value c
      let w ← base64Value d
      go fuel tail
        ((z % 4 * 64 + w).toUInt8 :: (y % 16 * 16 + z / 4).toUInt8 ::
          (x * 4 + y / 16).toUInt8 :: out)
    | _ + 1, _ => none
  go text.length text.toList []

/-- The days-from-civil inverse: `Date.prototype.toISOString` for a non-negative instant. -/
private def isoString (ms : Nat) : String :=
  let pad (width n : Nat) : String :=
    let text := toString n
    String.ofList (List.replicate (width - text.length) '0') ++ text
  let days := ms / 86400000
  let inDay := ms % 86400000
  let z := days + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let day := doy - (153 * mp + 2) / 5 + 1
  let month := if mp < 10 then mp + 3 else mp - 9
  let year := yoe + era * 400 + (if month <= 2 then 1 else 0)
  s!"{pad 4 year}-{pad 2 month}-{pad 2 day}T{pad 2 (inDay / 3600000)}:" ++
    s!"{pad 2 (inDay / 60000 % 60)}:{pad 2 (inDay / 1000 % 60)}.{pad 3 (inDay % 1000)}Z"

private def mountStatements (bucket pref : String) : Json :=
  let keyed (pairs : List (String × Json)) : Json :=
    Json.mkObj (pairs ++ [("$keys", toJson (pairs.map (·.1)))])
  .arr #[
    keyed [("Effect", toJson "Allow"),
      ("Action", toJson ["s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:AbortMultipartUpload"]),
      ("Resource", toJson [s!"arn:aws:s3:::{bucket}/{pref}*"])],
    keyed [("Effect", toJson "Allow"),
      ("Action", toJson ["s3:ListBucket"]),
      ("Resource", toJson [s!"arn:aws:s3:::{bucket}"]),
      ("Condition", Json.mkObj [("StringLike",
        Json.mkObj [("s3:prefix", toJson [s!"{pref}*"])])])]]

/-- `assumeScopedMountCredentials`. Only the platform role may set a source identity or tags. -/
private def assumeScopedMountCredentials (call : Json) : Prog Json := do
  let params := Twin.callArg call 0
  let pref := str (field params "prefix")
  if !pref.endsWith "/" then
    Prog.throwError "Error"
      s!"workspace S3 mount prefix must end with \"/\", got {(toJson pref).compress}"
  else
  let attribution := field params "attribution"
  let attributed := !nullish attribution
  let identity ←
    if attributed then Prog.effect "sessionIdentity" [attribution] else pure Twin.undefinedJson
  let role := field params "roleArn"
  let env ← Prog.effect "optionalEnv" [toJson "SANDBOX_MOUNT_ROLE_ARN"]
  let platformRole := role == env
  let client ← Prog.effect "new STSClient" [Json.mkObj []]
  let _ := client
  let policy := Json.mkObj [("Version", toJson "2012-10-17"),
    ("Statement", mountStatements (str (field params "bucket")) pref),
    ("$keys", toJson ["Version", "Statement"])]
  let agent := field attribution "agentId"
  let tags : List Json :=
    Json.mkObj [("Key", toJson "broods:account"), ("Value", field attribution "accountId")] ::
      (if nonEmpty agent then [Json.mkObj [("Key", toJson "broods:agent"), ("Value", agent)]]
       else [])
  let external := field params "externalId"
  let command : Json := Json.mkObj
    ([("RoleArn", role),
      ("RoleSessionName", toJson
        (if nonEmpty identity then s!"fp-sandbox-mount-{str identity}" else "fp-sandbox-mount")),
      ("DurationSeconds", toJson (3600 : Nat)),
      ("Policy", toJson (Twin.jsonStringify 16 policy))] ++
     (if nonEmpty external then [("ExternalId", external)] else []) ++
     (if attributed && platformRole then
        [("SourceIdentity", identity), ("Tags", .arr tags.toArray)] else []))
  let built ← Prog.effect "new AssumeRoleCommand" [command]
  let result ← Prog.effect "new STSClient({}).send" [built]
  let credentials := field result "Credentials"
  let access := field credentials "AccessKeyId"
  let secret := field credentials "SecretAccessKey"
  let token := field credentials "SessionToken"
  if !nonEmpty access || !nonEmpty secret || !nonEmpty token then
    Prog.throwError "Error" "Failed to assume the workspace S3 mount role"
  else
  let expiration := field credentials "Expiration"
  let expiry : List (String × Json) :=
    match intOf (field expiration "$date") with
    | some ms => [("AWS_CREDENTIAL_EXPIRATION", toJson (isoString ms.toNat))]
    | none => []
  pure (Json.mkObj ([("AWS_ACCESS_KEY_ID", access), ("AWS_SECRET_ACCESS_KEY", secret),
    ("AWS_SESSION_TOKEN", token)] ++ expiry))

/-- `OCCUPANT_STALE_MS` in `live-status.ts`. -/
private def occupantStaleMs : Int := 6 * 60 * 60 * 1000

private def sinceOf (one : Json) : Int := (intOf (field one "since")).getD 0

/-- `sandboxNeighbours`: live occupants other than this event, oldest first. -/
private def sandboxNeighbours (call : Json) : Prog Json := do
  let table := Twin.moduleValue call "occupants"
  match mapGet table (str (Twin.callArg call 0)) with
  | none => pure (.arr #[])
  | some holders =>
    let now ← Prog.effect "Date.now"
    let staleBefore := (intOf now).getD 0 - occupantStaleMs
    let eventId := str (Twin.callArg call 1)
    let live := (mapEntries holders).filter fun entry =>
      decide (sinceOf entry.2 > staleBefore) && str entry.1 != eventId
    let sorted := (live.map (·.2)).mergeSort fun a b => sinceOf a ≤ sinceOf b
    pure (.arr sorted.toArray)

private def connections (call : Json) : Json := Twin.moduleValue call "connections"

/-- `connectedMachine`. -/
private def connectedMachine (call : Json) : Prog Json := do
  let plane := field (Twin.callArg call 0) "controlPlane"
  let sandboxConfigId := field plane "sandboxConfigId"
  if !nonEmpty sandboxConfigId then
    Prog.throwError "Error" "machine sandbox needs a sandbox config record"
  else
    let key ← Prog.effect "registryKey" [field plane "accountId", sandboxConfigId]
    match mapGet (connections call) (str key) with
    | some connection => pure connection
    | none =>
      let name := str (field plane "name")
      Prog.throwError "Error"
        s!"machine sandbox \"{name}\" is not connected. Run `broods machine {name}` on that computer."

/-- `isMachineConnected`. -/
private def isMachineConnected (call : Json) : Prog Json := do
  let plane := field (Twin.callArg call 0) "controlPlane"
  let sandboxConfigId := field plane "sandboxConfigId"
  if !nonEmpty sandboxConfigId then
    pure (toJson false)
  else
    let key ← Prog.effect "registryKey" [field plane "accountId", sandboxConfigId]
    pure (toJson (mapGet (connections call) (str key)).isSome)

/-- `machineServingMcp`. `socket.data.accountId` is not recorded; `claimSandbox` sets
`ref.accountId` from the same value, so the twin reads that. -/
private def machineServingMcp (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  let sandbox := if nullish (field record "sandbox") then "" else str (field record "sandbox")
  let found := (mapEntries (connections call)).find? fun entry =>
    field (field entry.2 "ref") "accountId" == field record "accountId" &&
      str (field entry.2 "name") == sandbox
  match found with
  | none =>
    Prog.throwError "Error"
      s!"machine sandbox \"{sandbox}\" is not connected. Run `broods machine {sandbox} --mcp <file>` on that computer."
  | some (_, connection) =>
    let name := str (field record "name")
    if setHas (field connection "mcp") name then
      pure connection
    else
      Prog.throwError "Error"
        s!"machine sandbox \"{sandbox}\" does not serve MCP server \"{name}\". Add it under mcpServers in its --mcp file."

/-- `settleReply`: an unknown request only logs. -/
private def settleReply (call : Json) : Prog Json := do
  let reply := Twin.callArg call 1
  let pending := (mapGet (connections call) (str (Twin.callArg call 0))).bind fun connection =>
    mapGet (field connection "pending") (str (field reply "id"))
  match pending with
  | none => pure Twin.undefinedJson
  | some entry =>
    let _ ← Prog.effect "clearTimeout" [field entry "timer"]
    let updated := (mapEntries (connections call)).map fun (key, connection) =>
      let value := if key == Twin.callArg call 0 then
          let remaining := (mapEntries (field connection "pending")).filter
            (fun entry => entry.1 != field reply "id")
          let pendingMap := Json.mkObj [("$map", Json.arr (remaining.map
            (fun (k, v) => Json.arr #[k, v])).toArray)]
          Json.mkObj ((connection.getObj?.toOption.map (·.toList) |>.getD []).map
            (fun (k, v) => (k, if k == "pending" then pendingMap else v)))
        else connection
      Json.arr #[key, value]
    Prog.setState "module.connections" (Json.mkObj [("$map", Json.arr updated.toArray)])
    let _ ← Prog.effect "pending.resolve" [reply]
    pure Twin.undefinedJson

/-- `mirrorConnection`: the write starts on a later tick, so the call itself only returns. -/
private def mirrorConnection (_call : Json) : Prog Json :=
  pure Twin.undefinedJson

/-- `sandboxTimeoutSeconds`. -/
private def sandboxTimeoutSeconds (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let limits ← Prog.effect "workspaceSandboxLimits" [field config "provider"]
  let given := Twin.callArg call 1
  let preferred := if nullish given then field limits "defaultTimeoutSeconds" else given
  let max := field limits "maxTimeoutSeconds"
  match intOf preferred, intOf max with
  | some a, some b =>
    Prog.effect "boundedInteger" [field config "timeout", num (min a b), max]
  | _, _ => Prog.unsupported "a limit that is not an integer"

/-- `machineState`. -/
private def machineState (call : Json) : Prog Json := do
  let entry := Twin.callArg call 0
  let sandbox := field entry "sandbox"
  if field sandbox "provider" != toJson "machine" then
    pure (toJson "")
  else
    let connected ← Prog.effect "isMachineConnected" [sandbox]
    pure (toJson (if connected == toJson true then ", connected"
      else s!", offline: the person must run `broods machine {str (field entry "name")}`"))

/-- What `withholdTools` leaves in `tools`, by name: each denied tool goes, and a stand-in hands
back the sandbox tools it replaced unless those are denied too. -/
def withholdToolNames (names denied : List String) (standIns : Json)
    (sandboxTools : List String) : List String :=
  names.foldl (init := names) fun kept toolName =>
    let standIn := mapGet standIns toolName
    let runsAs := (standIn.map (fun one => items (field one "runsAs"))).getD []
    if !denied.contains toolName && !runsAs.any (fun name => denied.contains (str name)) then
      kept
    else
      let replaces := (standIn.map (fun one => items (field one "replaces"))).getD []
      let back := (replaces.map str).filter fun name =>
        sandboxTools.contains name && !denied.contains name
      kept.filter (· != toolName) ++ back.filter (!kept.contains ·)

/-- An object's own keys, in `$keys` order when the recorder gave one. -/
private def ownKeys (value : Json) : List String :=
  match value with
  | .obj kvs =>
    match value.getObjVal? "$keys" with
    | .ok (.arr keys) => keys.toList.filterMap fun key => (Json.getStr? key).toOption
    | _ => kvs.keys.filter fun key => key != "$keys" && key != "$fields"
  | _ => []

/-- What `withholdTools` leaves in `tools` and in `standIns`, as `withholdToolNames` decides it. -/
private def withheld (names denied : List String) (standIns sandboxTools : Json)
    (tools : List (String × Json)) : List (String × Json) × Array Json :=
  names.foldl (init := (tools, (items (field standIns "$map")).toArray))
    fun (kept, entries) toolName =>
      let standIn := mapGet standIns toolName
      let runsAs := (standIn.map (fun one => items (field one "runsAs"))).getD []
      if !denied.contains toolName && !runsAs.any (fun name => denied.contains (str name)) then
        (kept, entries)
      else
        let restored := ((standIn.map (fun one => items (field one "replaces"))).getD []).map str
        let back := restored.filter fun name =>
          !denied.contains name && !undef (field sandboxTools name)
        (back.foldl (fun out name => out.filter (·.1 != name) ++ [(name, field sandboxTools name)])
          (kept.filter (·.1 != toolName)),
         entries.filter (fun entry => str (Twin.arg entry 0) != toolName))

/-- `withholdTools`: deletes denied tools from `tools` and `standIns`, and restores what they replaced. -/
private def withholdTools (call : Json) : Prog Json := do
  let tools := Twin.callArg call 0
  let standIns := Twin.callArg call 2
  let names := ownKeys tools
  let (kept, entries) := withheld names ((items (Twin.callArg call 1)).map str) standIns
    (Twin.callArg call 3) (names.map fun name => (name, field tools name))
  for name in names ++ (kept.map (·.1)).filter (!names.contains ·) do
    Prog.setChanged s!"args.0.{name}" (field tools name) ((kept.lookup name).getD Twin.undefinedJson)
  Prog.setChanged "args.2.$map" (field standIns "$map") (.arr entries)
  return Twin.undefinedJson

private def fn (name : String) : Json := Json.mkObj [("$fn", toJson name)]

private def opaque_ (name : String) : Json := Json.mkObj [("$opaque", toJson name)]

private def base64Alphabet : Array Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray

/-- Standard padded base64. -/
private def base64Encode (bytes : List UInt8) : String :=
  let at_ (n : Nat) : Char := base64Alphabet.getD n '='
  let rec go (fuel : Nat) (rest : List Nat) (out : List Char) : List Char :=
    match fuel, rest with
    | 0, _ | _, [] => out.reverse
    | fuel + 1, [a] => go fuel [] ('=' :: '=' :: at_ (a % 4 * 16) :: at_ (a / 4) :: out)
    | fuel + 1, [a, b] =>
      go fuel [] ('=' :: at_ (b % 16 * 4) :: at_ (a % 4 * 16 + b / 16) :: at_ (a / 4) :: out)
    | fuel + 1, a :: b :: c :: tail =>
      go fuel tail
        (at_ (c % 64) :: at_ (b % 16 * 4 + c / 64) :: at_ (a % 4 * 16 + b / 16) :: at_ (a / 4) :: out)
  String.ofList (go (bytes.length + 1) (bytes.map (·.toNat)) [])

private def hexByte (b : UInt8) : String :=
  let digit (n : Nat) : Char := "0123456789abcdef".toList.getD n '0'
  String.ofList [digit (b.toNat / 16), digit (b.toNat % 16)]

private def base36Digit (n : Nat) : Char :=
  "0123456789abcdefghijklmnopqrstuvwxyz".toList.getD n '0'

/-- `Number.prototype.toString(36)` for a whole number. -/
private def natBase36 (n : Nat) : String :=
  let rec go (fuel value : Nat) (out : List Char) : List Char :=
    match fuel with
    | 0 => out
    | fuel + 1 =>
      let next := base36Digit (value % 36) :: out
      if value < 36 then next else go fuel (value / 36) next
  String.ofList (go 32 n [])

/-- The first `count` base-36 fraction digits of a recorded number in `[0, 1)`. -/
private def fractionBase36 (value : Json) (count : Nat) : String :=
  match value with
  | .num n =>
    let scale := 10 ^ n.exponent
    let rec go : Nat → Nat → List Char → List Char
      | 0, _, out => out.reverse
      | fuel + 1, rest, out =>
        if rest == 0 then out.reverse
        else go fuel ((rest * 36) % scale) (base36Digit (rest * 36 / scale) :: out)
    String.ofList (go count n.mantissa.toNat [])
  | _ => ""

/-- `generateJobId`. -/
private def generateJobId (_call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  let random ← Prog.effect "Math.random"
  pure (toJson s!"job_{natBase36 ((intOf now).getD 0).toNat}{fractionBase36 random 6}")

/-- `logsScript`. -/
private def logsScript (call : Json) : Prog Json := do
  let dir := str (Twin.callArg call 0)
  let jobId := Twin.callArg call 1
  let _ ← Prog.effect "assertSafeJobId" [jobId]
  let quoted ← Prog.effect "shellQuote" [toJson s!"{dir}/{str jobId}.log"]
  pure (toJson s!"tail -c {((intOf (Twin.callArg call 2)).getD 0)} {str quoted} 2>/dev/null || true")

/-- `stopScript`. -/
private def stopScript (call : Json) : Prog Json := do
  let dir := str (Twin.callArg call 0)
  let jobId := Twin.callArg call 1
  let _ ← Prog.effect "assertSafeJobId" [jobId]
  let f (ext : String) : Prog String := do
    return str (← Prog.effect "shellQuote" [toJson s!"{dir}/{str jobId}.{ext}"])
  let pid1 ← f "pid"
  let pid2 ← f "pid"
  let pid3 ← f "pid"
  let exit1 ← f "exit"
  let exit2 ← f "exit"
  let running ← f "running"
  pure (toJson ("; ".intercalate [
    s!"if [ -f {pid1} ]; then kill -TERM -\"$(cat {pid2})\" 2>/dev/null || true; sleep 1; " ++
      s!"kill -KILL -\"$(cat {pid3})\" 2>/dev/null || true; fi",
    s!"[ -f {exit1} ] || echo 143 > {exit2}",
    s!"rm -f {running}"]))

/-- `webpSize`, on the three chunk layouts it reads. -/
private def webpSize (call : Json) : Prog Json :=
  match base64Decode (str (field (Twin.callArg call 0) "$bytes")) with
  | none => Prog.unsupported "bytes the recorder did not encode as base64"
  | some list =>
    let bytes := list.toArray
    let at_ (i : Nat) : Nat := (bytes.getD i 0).toNat
    let le (i n : Nat) : Nat :=
      (List.range n).foldr (fun k total => total * 256 + at_ (i + k)) 0
    let size (width height : Nat) : Json :=
      Json.mkObj [("width", toJson width), ("height", toJson height)]
    if bytes.size < 30 then
      pure Twin.undefinedJson
    else
      let tag := ((List.range 4).map fun k => Char.ofNat (at_ (12 + k)))
      if tag == "VP8 ".toList then
        pure (size (le 26 2 % 16384) (le 28 2 % 16384))
      else if tag == "VP8L".toList then
        let bits := le 21 4
        pure (size (bits % 16384 + 1) (bits / 16384 % 16384 + 1))
      else if tag == "VP8X".toList then
        pure (size (le 24 3 + 1) (le 27 3 + 1))
      else
        pure Twin.undefinedJson

/-- `delay`: the executor runs at once and arms one timer. -/
private def delay (call : Json) : Prog Json := do
  Prog.drain (fun _ _ => pure ()) 4
  let _ ← Prog.effect "setTimeout" [fn "", Twin.callArg call 0]
  pure Twin.undefinedJson

/-- `shellProcessError`: stderr, else stdout, else a message naming the operation. -/
private def shellProcessError (call : Json) : Prog Json :=
  let result := Twin.callArg call 1
  let stderr := str (field result "stderr")
  let stdout := str (field result "stdout")
  let code := (intOf (field result "exitCode")).getD 0
  pure (Prog.errorJson "Error"
    (if stderr != "" then stderr else if stdout != "" then stdout
     else s!"Sandbox failed to {str (Twin.callArg call 0)} (exit {code})"))

/-- `runSandboxBackground`. A recorded class instance hides whether it has the method. -/
private def runSandboxBackground (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let options := Twin.callArg call 3
  let executor ← Prog.effect "createSandboxExecutor" [config]
  if !undef (field executor "$opaque") then
    Prog.unsupported "a class instance's methods are not recorded"
  else if undef (field executor "runBackground") then
    Prog.throwError "Error" "this sandbox provider does not support background jobs"
  else
    let limits ← Prog.effect "workspaceSandboxLimits" [field config "provider"]
    let root ← Prog.effect "workspaceRootFor" [config]
    let timeout ← Prog.effect "sandboxTimeoutSeconds" [config]
    let output ← Prog.effect "boundedInteger"
      [field config "outputLimitBytes", field limits "defaultOutputLimitBytes",
       field limits "maxOutputLimitBytes"]
    let optional (name : String) : List (String × Json) :=
      let value := field options name
      if nullish value || value == toJson false then [] else [(name, value)]
    Prog.effect "executor.runBackground" [Json.mkObj
      ([("code", Twin.callArg call 2), ("namespace", Twin.callArg call 1),
        ("jobId", field options "jobId")] ++ optional "callback" ++ optional "metadata" ++
       [("workspaceRoot", root), ("timeoutSeconds", timeout), ("outputLimitBytes", output)])]

/-- `startSandboxSweeper`. -/
private def startSandboxSweeper (call : Json) : Prog Json := do
  if !undef (Twin.moduleValue call "sweeper") then
    pure Twin.undefinedJson
  else
    let interval ← Prog.effect "positiveIntegerEnv"
      [toJson "SANDBOX_SWEEP_INTERVAL_SECONDS", num 3600]
    let random ← Prog.effect "Math.random"
    let jitter : Nat := match random with
      | .num n => n.mantissa.toNat * 30000 / 10 ^ n.exponent
      | _ => 0
    let first ← Prog.effect "setTimeout" [fn "runSweep", toJson jitter]
    Prog.setState "module.firstSweep" first
    let _ ← Prog.effect "firstSweep.unref"
    let timer ← Prog.effect "setInterval" [fn "runSweep", num (((intOf interval).getD 0) * 1000)]
    Prog.setState "module.sweeper" timer
    let _ ← Prog.effect "sweeper.unref"
    pure Twin.undefinedJson

/-- `stopSandboxSweeper`. -/
private def stopSandboxSweeper (call : Json) : Prog Json := do
  let first := Twin.moduleValue call "firstSweep"
  let sweeper := Twin.moduleValue call "sweeper"
  if !undef first then
    let _ ← Prog.effect "clearTimeout" [first]
    Prog.setState "module.firstSweep" Json.null
  if !undef sweeper then
    let _ ← Prog.effect "clearInterval" [sweeper]
    Prog.setState "module.sweeper" Json.null
  pure Twin.undefinedJson

/-- Throws the `ClientError` built by the recorded constructor. -/
private def clientError (message : String) : Prog Json := do
  let error ← Prog.effect "new ClientError" [toJson message]
  throw error

/-- The name inside a `${NAME}` reference: `/^\$\{([A-Z][A-Z0-9_]*)\}$/`. -/
private def envRefName (text : String) : Option String :=
  match text.toList with
  | '$' :: '{' :: rest =>
    match rest.reverse with
    | '}' :: inner =>
      let name := inner.reverse
      match name with
      | first :: tail =>
        if first.isUpper && tail.all (fun c => c.isUpper || c.isDigit || c == '_') then
          some (String.ofList name)
        else none
      | [] => none
    | _ => none
  | _ => none

private def optionalJson : Option String → Json
  | some text => toJson text
  | none => Twin.undefinedJson

/-- `normalizeFilePath`: strips edge slashes and refuses empty, `.` and `..` segments. -/
private def normalizeFilePath (call : Json) : Prog Json := do
  match (Twin.callArg call 0).getStr? with
  | .error _ => clientError "path is required"
  | .ok value =>
    let trimmed := (jsTrim value).toList
    let front := trimmed.dropWhile (· == '/')
    let path := String.ofList (front.reverse.dropWhile (· == '/')).reverse
    if path == "" || (path.splitOn "/").any (fun part => part == "" || part == "." || part == "..")
    then clientError "Invalid workspace file path"
    else pure (toJson path)

/-- `workspaceEnvRefFields`. -/
private def workspaceEnvRefFields (call : Json) : Prog Json :=
  let auth := field (field (Twin.callArg call 0) "storage") "auth"
  let isR2 := field auth "type" == toJson "r2"
  let name (key : String) : Json :=
    if isR2 then optionalJson (envRefName (str (field auth key))) else Twin.undefinedJson
  let present := [("r2AccessKeyEnv", name "accessKeyId"),
    ("r2SecretAccessKeyEnv", name "secretAccessKey")].filter (fun entry => !undef entry.2)
  pure (Json.mkObj present)

/-- `normalizeWorkspaceStorageAuth`: r2 keys must be env references, never values. -/
private def normalizeWorkspaceStorageAuth (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let kind := field value "type"
  if kind == toJson "r2" then
    let accessKeyId := jsTrim (str (field value "accessKeyId"))
    let secretAccessKey := jsTrim (str (field value "secretAccessKey"))
    if (envRefName accessKeyId).isNone || (envRefName secretAccessKey).isNone then
      clientError ("config.storage.auth.accessKeyId and secretAccessKey must each be one " ++
        "${NAME} env reference; workspace config never stores key values")
    else
      pure (Json.mkObj [("type", kind), ("accessKeyId", toJson accessKeyId),
        ("secretAccessKey", toJson secretAccessKey)])
  else if kind == toJson "assumeRole" then
    pure (Json.mkObj [("type", kind), ("roleArn", toJson (jsTrim (str (field value "roleArn"))))])
  else if nullish value then
    pure Twin.undefinedJson
  else
    pure (Json.mkObj [("type", toJson "managed")])

/-- `normalizeCreateWorkspaceConfigInput`. -/
private def normalizeCreateWorkspaceConfigInput (call : Json) : Prog Json := do
  let input ← Prog.effect "parseInput" [opaque_ "ZodMiniObject", Twin.callArg call 0, toJson ""]
  let description := jsTrim (str (field input "description"))
  let config ← Prog.effect "normalizeWorkspaceConfig" [field input "config"]
  pure (Json.mkObj ([("name", toJson (jsTrim (str (field input "name"))))] ++
    (if description != "" then [("description", toJson description)] else []) ++
    [("config", config)]))

/-- `normalizeUpdateWorkspaceConfigInput`: `config` is replaced only when the input has that key. -/
private def normalizeUpdateWorkspaceConfigInput (call : Json) : Prog Json := do
  let existing := Twin.callArg call 0
  let input ← Prog.effect "parseInput" [opaque_ "ZodMiniObject", Twin.callArg call 1, toJson ""]
  let config ←
    match input.getObjVal? "config" with
    | .ok given =>
      let parsed ← Prog.effect "parseInput" [opaque_ "ZodMiniRecord", given, toJson "config"]
      let merged ← Prog.effect "mergeConfigObjects" [existing, parsed]
      Prog.effect "normalizeWorkspaceConfig" [merged]
    | .error _ => pure existing
  let name := field input "name"
  let description := field input "description"
  let trimmedDescription : Json :=
    if description == .null then .null
    else
      let text := jsTrim (str description)
      if text == "" then Twin.undefinedJson else toJson text
  pure (Json.mkObj
    ((if undef name then [] else [("name", toJson (jsTrim (str name)))]) ++
     (if undef description || undef trimmedDescription then []
      else [("description", trimmedDescription)]) ++
     [("config", config)]))

/-- `workspaceNamespace`: the first 40 hex digits of a SHA-256 over the scoped id. -/
private def workspaceNamespace (call : Json) : Prog Json := do
  let text := s!"filesystem-namespace\x00{str (Twin.callArg call 0)}:{str (Twin.callArg call 1)}"
  let digest ← Prog.effect "crypto.subtle.digest"
    [toJson "SHA-256", Json.mkObj [("$bytes", toJson (base64Encode text.toUTF8.toList))]]
  match base64Decode (str (field digest "$bytes")) with
  | none => Prog.unsupported "a digest the recorder did not encode as base64"
  | some bytes =>
    pure (toJson ("fs-" ++ String.ofList (("".intercalate (bytes.map hexByte)).toList.take 40)))

/-- `isWorkspaceIsolation`. -/
private def isWorkspaceIsolation (call : Json) : Prog Json :=
  let value := Twin.callArg call 0
  pure (toJson (value == toJson "conversation" || value == toJson "agent"))

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [
   Twin.traced "apps/core/src/harness/sandbox/s3-mount.ts#assumeScopedMountCredentials"
     assumeScopedMountCredentials,
   Twin.traced "apps/core/src/harness/sandbox/live-status.ts#sandboxNeighbours" sandboxNeighbours,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#connectedMachine" connectedMachine,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#isMachineConnected"
     isMachineConnected,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#machineServingMcp"
     machineServingMcp,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#settleReply" settleReply,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#mirrorConnection" mirrorConnection,
   Twin.traced "apps/core/src/harness/tools/filesystem-utils.ts#sandboxTimeoutSeconds"
     sandboxTimeoutSeconds,
   Twin.traced "apps/core/src/harness/tools/filesystem-utils.ts#machineState" machineState,
   Twin.traced "apps/core/src/harness/tools/index.ts#withholdTools" withholdTools,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#generateJobId" generateJobId,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#logsScript" logsScript,
   Twin.traced "apps/core/src/harness/sandbox/jobs.ts#stopScript" stopScript,
   Twin.traced "apps/core/src/harness/tools/utils.ts#webpSize" webpSize,
   Twin.traced "apps/core/src/harness/sandbox/harness-shell-process.ts#delay" delay,
   Twin.traced "apps/core/src/harness/sandbox/harness-shell-process.ts#shellProcessError"
     shellProcessError,
   Twin.traced "apps/core/src/harness/tools/filesystem-utils.ts#runSandboxBackground"
     runSandboxBackground,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#startSandboxSweeper" startSandboxSweeper,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#stopSandboxSweeper" stopSandboxSweeper,
   Twin.traced "packages/convex/model/workspaceRules.ts#normalizeFilePath" normalizeFilePath,
   Twin.traced "packages/convex/model/workspaceRules.ts#workspaceEnvRefFields" workspaceEnvRefFields,
   Twin.traced "packages/convex/model/workspaceRules.ts#normalizeWorkspaceStorageAuth"
     normalizeWorkspaceStorageAuth,
   Twin.traced "packages/convex/model/workspaceRules.ts#normalizeCreateWorkspaceConfigInput"
     normalizeCreateWorkspaceConfigInput,
   Twin.traced "packages/convex/model/workspaceRules.ts#normalizeUpdateWorkspaceConfigInput"
     normalizeUpdateWorkspaceConfigInput,
   Twin.traced "packages/convex/model/workspaceRules.ts#workspaceNamespace" workspaceNamespace,
   Twin.traced "packages/convex/model/workspaceIsolation.ts#isWorkspaceIsolation"
     isWorkspaceIsolation]

end Spec.Sandbox.Wavesandbox3b
