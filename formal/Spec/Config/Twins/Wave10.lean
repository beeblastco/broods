import Spec.Config.Twins.Rest

/-!
Twins of config functions beside the ones in `Rest.lean`.
-/

namespace Spec.Config.Wave10

open Lean Spec.Js Spec.Zod Spec.Config

/-- `WEB_STREAMS_PATTERN`: `(?<![.\w$])(?:Readable|Writable|Transform)Stream\b`. -/
private def webStreamsPattern : Re :=
  Re.seqs [.notBack isIdentifierPart, .alt (.lit "Readable") (.alt (.lit "Writable") (.lit "Transform")),
    .lit "Stream", .wordB]

/-- `isIsolateSafeBundle`: no Node-only construct and no web stream in the bundle source. -/
def isIsolateSafeBundleTwin : Spec.Twin where
  source := "packages/convex/model/isolateSafety.ts#isIsolateSafeBundle"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str bundle => toJson (!(nodeOnlyPatterns ++ [webStreamsPattern]).any (Re.test · bundle))
    | _ => Spec.Twin.unsupported "bundle is not a string"


/-- A recorded value as the corpus would hold it: a class instance is its fields, an undefined property
is dropped, and an undefined item is null. -/
private def asCorpus : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    if value == Spec.Twin.undefinedJson then .null else
    match value with
    | .arr items => .arr (items.map (asCorpus fuel))
    | .obj kvs =>
      match kvs.get? "$opaque", kvs.get? "$fields" with
      | some _, some fields => asCorpus fuel fields
      | _, _ =>
        Json.mkObj (kvs.toList.filterMap fun (key, item) =>
          if item == Spec.Twin.undefinedJson || key == "$keys" || key == "$class" then none
          else some (key, asCorpus fuel item))
    | other => other

/-- A traced twin that answers from a model written over plain JSON, for functions whose arguments carry
values a corpus cannot hold, such as a zod schema. -/
private def tracedFromPlain (twin : Spec.Twin) : Spec.Twin :=
  Spec.Twin.traced twin.source fun call =>
    let args := match call.getObjVal? "args" with
      | .ok (.arr items) => Json.arr (items.map (asCorpus 64))
      | _ => Json.arr #[]
    match twin.run args with
    | .null => Prog.unsupported "null and undefined record alike"
    | out =>
      match out.getObjVal? "unsupported", out.getObjVal? "threw" with
      | .ok reason, _ => Prog.unsupported (reason.getStr?.toOption.getD "")
      | _, .ok message => Prog.throwError "Error" (message.getStr?.toOption.getD "")
      | _, _ => pure out


private def base64Value (c : Char) : Nat :=
  if 'A' ≤ c && c ≤ 'Z' then c.toNat - 'A'.toNat
  else if 'a' ≤ c && c ≤ 'z' then c.toNat - 'a'.toNat + 26
  else if '0' ≤ c && c ≤ '9' then c.toNat - '0'.toNat + 52
  else if c == '+' then 62 else 63

/-- The bytes of a standard base64 text, which is how the recorder carries a `Buffer`. -/
private def base64Decode (text : String) : List Nat :=
  let digits := (text.toList.filter (· != '=')).map base64Value
  let rec go : Nat → List Nat → List Nat
    | 0, _ => []
    | _ + 1, a :: b :: c :: d :: rest =>
      ((a * 4 + b / 16) % 256) :: ((b * 16 + c / 4) % 256) :: ((c * 64 + d) % 256) :: go rest.length rest
    | _ + 1, [a, b, c] => [(a * 4 + b / 16) % 256, (b * 16 + c / 4) % 256]
    | _ + 1, [a, b] => [(a * 4 + b / 16) % 256]
    | _ + 1, _ => []
  go (digits.length + 1) digits

/-- `bytesToBase64Url`: the bytes as unpadded base64 in the URL alphabet. -/
def bytesToBase64Url (call : Json) : Prog Json :=
  match (Spec.Twin.callArg call 0).getObjVal? "$bytes" with
  | .ok (.str text) => pure (toJson (String.ofList (base64UrlEncode (base64Decode text))))
  | _ => Prog.unsupported "bytes are not a recorded Buffer"

/-- The name rule of a recorded placeholder pattern: the account pattern or the general one. -/
private def placeholderNames (pattern : Json) : Option (String → Bool) :=
  match pattern.getObjVal? "$regexp" with
  | .ok (.str source) =>
    if source == "/\\$\\{([A-Z][A-Z0-9_]*)\\}/g" then some isAccountEnvName
    else if source == "/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g" then some isEnvName
    else none
  | _ => none

/-- An object's entries in the order the recorder saw them: `$keys` when it lists them, else sorted. -/
private def insertionOrder (object : Json) (sorted : List (String × Json)) : List (String × Json) :=
  match object.getObjVal? "$keys" with
  | .ok (.arr keys) =>
    keys.toList.filterMap fun key =>
      match key.getStr? with
      | .ok name => (object.getObjVal? name).toOption.map (name, ·)
      | .error _ => none
  | _ => sorted.filter fun (key, _) => key != "$keys" && key != "$class" && key != "$fields"

/-- `substitutePlaceholders`: strings take their `${NAME}` values, arrays and objects recurse, and a
prototype-polluting key is dropped. -/
def substitutePlaceholders (call : Json) : Prog Json := do
  let config := Spec.Twin.callArg call 0
  let variables := Spec.Twin.callArg call 1
  let pattern := Spec.Twin.callArg call 2
  let some valid := placeholderNames pattern
    | Prog.unsupported "the pattern is not one of the code's two"
  match config with
  | .str text => return substituteString valid variables text
  | .arr items =>
    let mut out : Array Json := #[]
    for item in items do
      out := out.push (← Prog.effect "substitutePlaceholders" [item, variables, pattern])
    return .arr out
  | .obj kvs =>
    let mut out : List (String × Json) := []
    for (key, item) in insertionOrder config kvs.toList do
      if key == "__proto__" || key == "constructor" || key == "prototype" then continue
      out := out ++ [(key, ← Prog.effect "substitutePlaceholders" [item, variables, pattern])]
    return Json.mkObj out
  | other => return other


private def isError (value : Json) : Bool :=
  (value.getObjVal? "$error").isOk

/-- The schema recorded as a class instance, when its `def` holds only what the recording keeps. -/
private def schemaOfCall (call : Json) : Option Schema :=
  schemaOfDef 16 (asCorpus 64 (Spec.Twin.callArg call 0))

/-- The input value, or none when the caller passed undefined. -/
private def inputOfCall (call : Json) : Option Json :=
  let value := Spec.Twin.callArg call 1
  if value == Spec.Twin.undefinedJson then none else some (asCorpus 64 value)

/-- `parseOr`: the parsed value, or the fallback when it does not fit. An `Error` is no plain object, so a
record refuses it; an object schema would read its prototype, which the model does not carry. -/
def parseOr (call : Json) : Prog Json := do
  let some schema := schemaOfCall call
    | Prog.unsupported "schema is not expressible from its recorded def"
  let value := Spec.Twin.callArg call 1
  let fallback := Spec.Twin.callArg call 2
  if isError value then
    match schema with
    | .record .. => return fallback
    | _ => Prog.unsupported "an Error is read through its prototype chain"
  match run 64 schema (inputOfCall call) with
  | .ok output => return output.getD Spec.Twin.undefinedJson
  | .bad _ => return fallback
  | .unknown reason => Prog.unsupported reason

/-- `parseInput`: the parsed value. A failure builds a zod issue the model does not carry. -/
def parseInput (call : Json) : Prog Json := do
  let some schema := schemaOfCall call
    | Prog.unsupported "schema is not expressible from its recorded def"
  match run 64 schema (inputOfCall call) with
  | .ok output => return output.getD Spec.Twin.undefinedJson
  | .bad _ => Prog.unsupported "a failure builds a zod issue the model does not carry"
  | .unknown reason => Prog.unsupported reason


private def undef (value : Json) : Bool := value == Spec.Twin.undefinedJson

/-- A property of a recorded object, undefined when absent. -/
private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Spec.Twin.undefinedJson

/-- `resolveRequestId`: an inbound id of the issued shape is kept, anything else is replaced. -/
def resolveRequestId (call : Json) : Prog Json := do
  match Spec.Twin.callArg call 0 with
  | .str inbound =>
    if requestIdValid inbound then return .str inbound
    Prog.effect "crypto.randomUUID"
  | _ => Prog.effect "crypto.randomUUID"

/-- `blobKeyId`: the key id inside a `v2:` ciphertext, or null. -/
def blobKeyIdProg (call : Json) : Prog Json :=
  match get (Spec.Twin.callArg call 0) "ciphertext" with
  | .str ciphertext => pure ((blobKeyId ciphertext).map Json.str |>.getD .null)
  | _ => Prog.unsupported "ciphertext is not a string"

/-- `workspaceOnLaterSandbox`: the workspace ref on a sandbox after the first, or undefined. -/
def workspaceOnLaterSandboxProg (call : Json) : Prog Json :=
  match arr? (Spec.Twin.callArg call 0), nat? (Spec.Twin.callArg call 1) with
  | some sandboxes, some index =>
    pure ((workspaceOnLater sandboxes index (Spec.Twin.callArg call 2)).getD Spec.Twin.undefinedJson)
  | _, _ => Prog.unsupported "sandboxes or index is not usable"

/-- `providerBaseURL`: the trimmed base URL, from `base_url` when that is a string, else `baseURL`. -/
def providerBaseURLProg (call : Json) : Prog Json :=
  let settings := asCorpus 64 (Spec.Twin.callArg call 0)
  let raw := match get settings "base_url" with
    | .str text => some (Json.str text)
    | _ => field? settings "baseURL"
  match raw with
  | none | some .null => pure Spec.Twin.undefinedJson
  | some (.str text) =>
    let trimmed := trim text
    pure (if trimmed.isEmpty then Spec.Twin.undefinedJson else .str trimmed)
  | some _ => Prog.unsupported "baseURL is not a string"

/-- `publicHttpsUrlProblem`: why a URL is not a public https one, or undefined. -/
def publicHttpsUrlProblemProg (call : Json) : Prog Json := do
  match Spec.Twin.callArg call 0 with
  | .str value =>
    match Spec.Url.parse value with
    | .invalid => return .str "must be a valid URL"
    | .unknown reason => Prog.unsupported reason
    | .ok url =>
      if url.protocol != "https:" then return .str "must use https"
      let internal ← Prog.effect "isPrivateHostname" [.str url.hostname]
      if internal == toJson true then
        return .str "must not point to a private or internal address"
      return Spec.Twin.undefinedJson
  | _ => Prog.unsupported "value is not a string"

/-- `clientErrorData`: the code and message of a `ConvexError` carrying a known client code, or null. -/
def clientErrorData (call : Json) : Prog Json := do
  let error := Spec.Twin.callArg call 0
  let details := get error "$error"
  let cls := get details "$class"
  if cls != .str "ConvexError" && cls != .str "ClientError" then return .null
  let data := get (get details "fields") "data"
  match data with
  | .obj _ =>
    match field? data "code", field? data "message" with
    | some code, some (.str message) =>
      let known ← Prog.effect "isClientErrorCode" [code]
      if known == toJson true then
        return Json.mkObj [("code", code), ("message", .str message)]
      return .null
    | _, _ => return .null
  | _ => return .null


/-- Throws the `ClientError` the code builds for this message. -/
private def clientError {α : Type} (message : String) : Prog α := do
  let error ← Prog.effect "new ClientError" [.str message]
  .fail error

/-- A void check whose plain twin gives the first problem: success is undefined and a problem is a
`ClientError`. -/
private def checkFromPlain (twin : Spec.Twin) : Spec.Twin :=
  Spec.Twin.traced twin.source fun call =>
    let args := match call.getObjVal? "args" with
      | .ok (.arr items) => Json.arr (items.map (asCorpus 64))
      | _ => Json.arr #[]
    match twin.run args with
    | .null => pure Spec.Twin.undefinedJson
    | out =>
      match out.getObjVal? "unsupported", out.getObjVal? "threw" with
      | .ok reason, _ => Prog.unsupported (reason.getStr?.toOption.getD "")
      | _, .ok message => clientError (message.getStr?.toOption.getD "")
      | _, _ => pure out

/-- `assertCompleteChannels`: a channel set up halfway, then Meta channels through `assertMetaCredentials`. -/
def assertCompleteChannels (call : Json) : Prog Json := do
  let channels := asCorpus 64 (Spec.Twin.callArg call 0)
  let raw := Spec.Twin.callArg call 0
  let withoutMeta := Json.mkObj ((Spec.Js.entries channels).filter fun (key, _) =>
    key != "instagram" && key != "messenger")
  match completeChannelsProblem withoutMeta with
  | .threw message => clientError message
  | .unknown reason => Prog.unsupported reason
  | .ok _ =>
    let instagram := field raw "instagram"
    if !undef instagram && Spec.Js.truthy (asCorpus 64 instagram) then
      let _ ← Prog.effect "assertMetaCredentials" [instagram, .str "config.channels.instagram",
        toJson ["accessToken", "accountId", "appSecret", "verifyToken"]]
    let messenger := field raw "messenger"
    if !undef messenger && Spec.Js.truthy (asCorpus 64 messenger) then
      let _ ← Prog.effect "assertMetaCredentials" [messenger, .str "config.channels.messenger",
        toJson ["appSecret", "pageAccessToken", "verifyToken"]]
    return Spec.Twin.undefinedJson

/-- `assertRuntimeRefs`: no `sandbox`, no repeated sandbox, no workspace on a later sandbox, and a
harness that runs in a sandbox needs one. -/
def assertRuntimeRefs (call : Json) : Prog Json := do
  let config := Spec.Twin.callArg call 0
  let options := Spec.Twin.callArg call 1
  if !undef (field config "sandbox") then clientError sandboxRemovedMessage
  let listed := field config "sandboxes"
  let sandboxes := match listed with
    | .arr items => items.toList
    | _ => []
  let workspaces := field config "workspaces"
  let mut seen : List Json := []
  let mut index := 0
  for sandboxId in sandboxes do
    let name := match sandboxId with | .str text => text | _ => ""
    if seen.contains sandboxId then
      clientError s!"config.sandboxes[{index}] \"{name}\" is listed more than once"
    let mounted ← Prog.effect "workspaceOnLaterSandbox" [toJson sandboxes, toJson index, workspaces]
    if !undef mounted && Spec.Js.truthy mounted then
      let workspace := match field mounted "name" with | .str text => text | _ => ""
      clientError s!"config.sandboxes[{index}] \"{name}\" also backs workspace \"{workspace}\"; only the first sandbox can back a workspace"
    seen := seen ++ [sandboxId]
    index := index + 1
  let harness := field config "harness"
  if (!undef (field options "patch") && Spec.Js.truthy (field options "patch")) || !sandboxes.isEmpty ||
      undef harness || harness == .null then
    return Spec.Twin.undefinedJson
  let parsed ← Prog.effect "HARNESS_TYPE.safeParse" [harness]
  if field parsed "success" == toJson true then
    let kind := match field (field parsed "data") "type" with | .str text => text | _ => ""
    clientError s!"config.sandboxes needs at least one sandbox for the {kind} harness; the first runs it"
  return Spec.Twin.undefinedJson


/-- A zod schema the code builds with closures for its checks: the class is the answer a caller can read. -/
private def zodInstance (cls : String) : Json :=
  Json.mkObj [("$opaque", toJson cls), ("$fields", Json.mkObj [])]

/-- `positiveInteger`: a number schema with an integer-range check. -/
def positiveInteger (_call : Json) : Prog Json :=
  pure (zodInstance "ZodMiniNumber")

/-- `refusingProtoKey`: the schema behind a pipe that refuses an own `__proto__` key. -/
def refusingProtoKey (_call : Json) : Prog Json :=
  pure (zodInstance "ZodMiniPipe")

/-- `unsupportedKeys`: a check that flags every key outside the list. -/
def unsupportedKeys (_call : Json) : Prog Json :=
  pure (zodInstance "$ZodCheck")

/-- `wholeValue`: a catch of the schema piped into a transform that reports one issue. -/
def wholeValue (_call : Json) : Prog Json :=
  pure (zodInstance "ZodMiniPipe")

/-- `stringRecord`: `wholeValue` of the string-to-string record schema. -/
def stringRecord (call : Json) : Prog Json :=
  Prog.effect "wholeValue" [zodInstance "ZodMiniRecord", Spec.Twin.callArg call 0]


/-- `extractModelFields`: moves the model's own keys into the flat patch, and the option keys out of
`modelOptions`, which stays behind in the patch when anything is left. -/
def extractModelFields (call : Json) : Prog Json := do
  let modelBefore := Spec.Twin.callArg call 0
  let options := Spec.Twin.callArg call 1
  let patchBefore := Spec.Twin.callArg call 2
  let move (source patch : Json) (key target : String) : Json × Json :=
    match field source key with
    | .str text => (del source key, set patch target (.str text))
    | _ => (source, patch)
  let (model, patch) := move modelBefore patchBefore "provider" "provider"
  let (model, patch) := move model patch "modelId" "modelId"
  let output := field model "output"
  let (model, patch) :=
    if undef output then (model, patch)
    else (del model "output", if output == .null then patch else set patch "outputFormat" output)
  let truthyOptions := !undef options && Spec.Js.truthy options
  let (modelNext, optionsNext, patchNext) :=
    if !truthyOptions then (model, options, patch) else
    let number (source patch : Json) (key : String) : Json × Json :=
      match field source key with
      | .num value => (del source key, set patch key (.num value))
      | _ => (source, patch)
    let (kept, patch) := number options patch "temperature"
    let (kept, patch) := number kept patch "maxTokens"
    let patch := if (Spec.Js.entries kept).isEmpty then patch else set patch "providerOptions" kept
    (del model "providerOptions", kept, patch)
  Prog.setChanged "args.0" modelBefore modelNext
  if truthyOptions then Prog.setChanged "args.1" options optionsNext
  Prog.setChanged "args.2" patchBefore patchNext
  return Spec.Twin.undefinedJson

/-- The twins in this file. -/
def twins : List Spec.Twin :=
  [isIsolateSafeBundleTwin, Spec.Twin.traced "packages/convex/model/storedJson.ts#parseOr" parseOr,
   Spec.Twin.traced "packages/convex/model/inputSchema.ts#parseInput" parseInput,
   tracedFromPlain defaultMessageTwin,
   Spec.Twin.traced "packages/convex/model/agentConfigCodec.ts#substitutePlaceholders" substitutePlaceholders,
   Spec.Twin.traced "packages/convex/model/envelope.ts#bytesToBase64Url" bytesToBase64Url,
   Spec.Twin.traced "packages/convex/model/requestId.ts#resolveRequestId" resolveRequestId,
   Spec.Twin.traced "packages/convex/model/envelope.ts#blobKeyId" blobKeyIdProg,
   Spec.Twin.traced "packages/convex/model/sandboxMounts.ts#workspaceOnLaterSandbox" workspaceOnLaterSandboxProg,
   Spec.Twin.traced "packages/convex/model/agentRules.ts#providerBaseURL" providerBaseURLProg,
   Spec.Twin.traced "packages/convex/model/agentRules.ts#publicHttpsUrlProblem" publicHttpsUrlProblemProg,
   Spec.Twin.traced "packages/convex/model/clientError.ts#clientErrorData" clientErrorData,
   Spec.Twin.traced "packages/convex/model/agentRules.ts#assertCompleteChannels" assertCompleteChannels,
   Spec.Twin.traced "packages/convex/model/agentRules.ts#assertRuntimeRefs" assertRuntimeRefs,
   checkFromPlain assertMetaCredentialsTwin,
   checkFromPlain assertHarnessSupportsTwin,
   Spec.Twin.traced "packages/convex/model/inputSchema.ts#positiveInteger" positiveInteger,
   Spec.Twin.traced "packages/convex/model/inputSchema.ts#refusingProtoKey" refusingProtoKey,
   Spec.Twin.traced "packages/convex/model/inputSchema.ts#unsupportedKeys" unsupportedKeys,
   Spec.Twin.traced "packages/convex/model/inputSchema.ts#wholeValue" wholeValue,
   Spec.Twin.traced "packages/convex/model/inputSchema.ts#stringRecord" stringRecord,
   Spec.Twin.traced "packages/convex/model/agentConfigCodec.ts#extractModelFields" extractModelFields]

end Spec.Config.Wave10
