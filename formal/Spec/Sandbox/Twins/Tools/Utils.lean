import Spec.Sandbox.Twins.Tools.Js
import Spec.Sandbox.Twins.Tools.Filesystem

/-!
Twins of `apps/core/src/harness/tools/utils.ts`.
-/

namespace Spec.Sandbox.Tools

open Lean

private def file : String := "utils.ts"

private def maxImageBytes : Nat := 6 * 1024 * 1024

private def maxResultImages : Nat := 8

private def maxImageSide : Nat := 8000

/-! ## The SDK's tool result schema, `outputSchema` in `ai/dist/index.js`. -/

private def isRecordOf (test : Json → Bool) (value : Json) : Bool :=
  isObj value && (entries value).all fun pair => test pair.2

private def isStringRecord : Json → Bool := isRecordOf isStr

private def optionalField (value : Json) (key : String) (test : Json → Bool) : Bool :=
  match value.getObjVal? key with
  | .ok inner => test inner
  | .error _ => true

private def providerOptionsOk (value : Json) : Bool :=
  optionalField value "providerOptions" (isRecordOf isObj)

private def fileIdOk (value : Json) : Bool :=
  isStr value || isStringRecord value

private def fileDataOk (data : Json) : Bool :=
  match field data "type" with
  | .str "data" => isStr (field data "data")
  | .str "reference" => isStringRecord (field data "reference")
  | .str "text" => isStr (field data "text")
  | _ => false

private def contentPartOk (part : Json) : Bool :=
  providerOptionsOk part &&
    match field part "type" with
    | .str "text" => isStr (field part "text")
    | .str "file" =>
      fileDataOk (field part "data") && isStr (field part "mediaType") &&
        optionalField part "filename" isStr
    | .str "file-data" =>
      isStr (field part "data") && isStr (field part "mediaType") &&
        optionalField part "filename" isStr
    | .str "file-url" => isStr (field part "url") && optionalField part "mediaType" isStr
    | .str "file-id" => fileIdOk (field part "fileId")
    | .str "file-reference" => isStringRecord (field part "providerReference")
    | .str "image-data" => isStr (field part "data") && isStr (field part "mediaType")
    | .str "image-url" => isStr (field part "url")
    | .str "image-file-id" => fileIdOk (field part "fileId")
    | .str "image-file-reference" => isStringRecord (field part "providerReference")
    | .str "custom" => true
    | _ => false

private def holdsUrlInstance (part : Json) : Bool :=
  field part "type" == Json.str "file" && fieldAt part ["data", "type"] == Json.str "url"

/-- Whether the SDK accepts `value` as a tool result. A `URL` instance reaches the recording as a
string, and a plain string there would fail, so the recording cannot say which it was. -/
def isToolResultOutput (value : Json) : R Bool := do
  if field value "type" == Json.str "content" && (items (field value "value")).any holdsUrlInstance then
    noModel "a URL instance and a string look the same once recorded"
  return providerOptionsOk value &&
    match field value "type" with
    | .str "text" | .str "error-text" => isStr (field value "value")
    | .str "json" | .str "error-json" => hasKey value "value"
    | .str "execution-denied" => optionalField value "reason" isStr
    | .str "content" => isArr (field value "value") && (items (field value "value")).all contentPartOk
    | _ => false

/-- `parseToolResultOutput`: the value when it is a tool result, else `undefined`. -/
def parseToolResultOutput (value : Json) : R (Option Json) := do
  return if ← isToolResultOutput value then some value else none

/-! ## Parts -/

private def optionsPair (part : Json) : List (String × Json) :=
  if truthy (field part "providerOptions") then
    [("providerOptions", field part "providerOptions")]
  else []

def textPart (value providerOptions : Json) : Json :=
  object ([("type", Json.str "text"), ("text", value)] ++
    if truthy providerOptions then [("providerOptions", providerOptions)] else [])

private def partText (value part : Json) : Json := textPart value (field part "providerOptions")

/-- A part's declared key order, for `JSON.stringify(part)`. -/
private def partKeyOrder : List String :=
  ["type", "url", "mediaType", "fileId", "providerOptions"]

private def stringifiedPart (part : Json) : R Json := do
  return partText (Json.str (← stringifyDeclared partKeyOrder part)) part

private def isHostChar (c : Char) : Bool :=
  ('a' ≤ c ∧ c ≤ 'z') || ('A' ≤ c ∧ c ≤ 'Z') || ('0' ≤ c ∧ c ≤ '9') || c == '-' || c == '.'

private def isPlainUrlChar (c : Char) : Bool :=
  isHostChar c || "_~!$&'()*+,;=:@/?#%".toList.contains c

private def isSchemeChar (c : Char) : Bool :=
  isHostChar c || c == '+'

private def isAlpha (c : Char) : Bool :=
  ('a' ≤ c ∧ c ≤ 'z') || ('A' ≤ c ∧ c ≤ 'Z')

private def isDigit (c : Char) : Bool := '0' ≤ c ∧ c ≤ '9'

private def looksNumericHost (host : String) : Bool :=
  match (split host ".").getLast? with
  | some label => !label.isEmpty && label.toList.all isDigit
  | none => false

private def isDottedQuad (host : String) : Bool :=
  let labels := split host "."
  labels.length == 4 && labels.all fun label =>
    !label.isEmpty && label.length ≤ 3 && label.toList.all isDigit &&
      (label == "0" || label.toList.head? != some '0') && label.toNat! ≤ 255

/-- `new URL(url).href`, or `none` when it throws. Only a plain http(s) URL is modelled: its scheme
and host lower, its default port drop and its empty path become `/`. -/
def urlHref (url : String) : R (Option String) := do
  let chars := url.toList
  match chars with
  | [] => return none
  | c :: _ =>
    if c.toNat ≤ 32 then noModel "URL with leading whitespace"
    if !isAlpha c then return none
  let schemeChars := chars.takeWhile isSchemeChar
  let afterScheme := chars.drop schemeChars.length
  match afterScheme with
  | ':' :: rest =>
    let scheme := String.ofList (schemeChars.map asciiLower)
    if scheme != "http" && scheme != "https" then noModel "URL scheme other than http(s)"
    match rest with
    | '/' :: '/' :: after =>
      if !after.all isPlainUrlChar then noModel "URL characters that get percent-encoded"
      let authority := after.takeWhile fun c => c != '/' && c != '?' && c != '#'
      let tail := String.ofList (after.drop authority.length)
      let hostChars := authority.takeWhile (· != ':')
      let portChars := (authority.drop hostChars.length).drop 1
      let hasPort := authority.length != hostChars.length
      if !hostChars.all isHostChar || hostChars.isEmpty then noModel "URL host outside the plain form"
      let host := String.ofList (hostChars.map asciiLower)
      if looksNumericHost host && !isDottedQuad host then noModel "numeric host normalisation"
      if !portChars.all isDigit then noModel "URL port outside the plain form"
      let port := (String.ofList portChars).toNat?.getD 0
      if port > 65535 then return none
      let defaultPort := if scheme == "http" then 80 else 443
      let portText :=
        if !hasPort || portChars.isEmpty || port == defaultPort then "" else s!":{port}"
      if contains tail "/." || contains tail "%" then noModel "URL dot segments or escapes"
      let path := if isPrefix tail "/" then tail else "/" ++ tail
      return some s!"{scheme}://{host}{portText}{path}"
    | _ => noModel "http(s) URL without two slashes"
  | _ => return none

private def urlPartToUserPart (part : Json) : R Json := do
  match field part "url" with
  | .str url =>
    match ← urlHref url with
    | some href =>
      let mediaType :=
        if field part "type" == Json.str "image-url" then Json.str "image"
        else orElse (field part "mediaType") (Json.str "application/octet-stream")
      return Json.mkObj ([
        ("type", Json.str "file"),
        ("data", Json.mkObj [("type", Json.str "url"), ("url", Json.str href)]),
        ("mediaType", mediaType)] ++ optionsPair part)
    | none => stringifiedPart part
  | _ => noModel "url is not a string"

private def filePart (data mediaType : Json) (rest : List (String × Json)) : Json :=
  object ([("type", Json.str "file"), ("data", data), ("mediaType", mediaType)] ++ rest)

private def referencePart (reference : Json) (isImage : Bool) (part : Json) : Json :=
  filePart
    (Json.mkObj [("type", Json.str "reference"), ("reference", reference)])
    (Json.str (if isImage then "image" else "application/octet-stream"))
    (optionsPair part)

private def filenamePair (part : Json) : List (String × Json) :=
  if truthy (field part "filename") then [("filename", field part "filename")] else []

def contentPartToUserPart (part : Json) : R Json :=
  let kind := field part "type"
  match kind with
  | .str "text" => pure (partText (field part "text") part)
  | .str "file" =>
    pure (filePart (field part "data") (field part "mediaType") (filenamePair part ++ optionsPair part))
  | .str "file-data" | .str "image-data" =>
    pure (filePart
      (Json.mkObj [("type", Json.str "data"), ("data", field part "data")])
      (field part "mediaType")
      ((if kind == Json.str "file-data" then filenamePair part else []) ++ optionsPair part))
  | .str "file-url" | .str "image-url" => urlPartToUserPart part
  | .str "file-reference" | .str "image-file-reference" =>
    pure (referencePart (field part "providerReference") (kind == Json.str "image-file-reference") part)
  | .str "file-id" | .str "image-file-id" =>
    if isStr (field part "fileId") then stringifiedPart part
    else pure (referencePart (field part "fileId") (kind == Json.str "image-file-id") part)
  | .str "custom" => stringifiedPart part
  | _ => pure Json.null

def formatJSONValue (value : Json) : R String :=
  match value with
  | .str inner => pure inner
  | other => stringify other

def modelValueToUserParts (value : Json) : R Json := do
  match ← parseToolResultOutput value with
  | none => return Json.arr #[textPart (Json.str (← formatJSONValue value)) Json.null]
  | some output =>
    let options := field output "providerOptions"
    match field output "type" with
    | .str "text" | .str "error-text" => return Json.arr #[textPart (field output "value") options]
    | .str "json" | .str "error-json" =>
      return Json.arr #[textPart (Json.str (← formatJSONValue (field output "value"))) options]
    | .str "execution-denied" =>
      let reason := field output "reason"
      let message :=
        if truthy reason then s!"Execution denied: {text reason}" else "Execution denied"
      return Json.arr #[textPart (Json.str message) options]
    | _ => return Json.arr ((← (items (field output "value")).mapM contentPartToUserPart)).toArray

/-! ## Recorded values whose JSON form lost their type -/

private def erasureDepth : Nat := 64

private def holdsErasedValue : Nat → Json → Bool
  | 0, _ => true
  | _ + 1, .null => true
  | fuel + 1, .arr values => values.toList.any (holdsErasedValue fuel)
  | fuel + 1, .obj pairs =>
    pairs.toList.isEmpty || pairs.toList.any fun pair => holdsErasedValue fuel pair.2
  | _ + 1, _ => false

/-- A recorded null may have been `undefined` and a recorded `{}` a class instance, and neither of
those is a JSON value. -/
private def erasedType : R Json := noModel "the recording erased whether this value was plain JSON"

private def isDateText (value : String) : Bool :=
  let d := Re.digit
  let digits (n : Nat) : List Re := List.replicate n d
  Re.test (Re.seqs ([Re.Re.bol'] ++ digits 4 ++ [Re.lit "-"] ++ digits 2 ++ [Re.lit "-"] ++ digits 2 ++
    [Re.lit "T"] ++ digits 2 ++ [Re.lit ":"] ++ digits 2 ++ [Re.lit ":"] ++ digits 2 ++ [Re.lit "."] ++
    digits 3 ++ [Re.lit "Z", .eol])) value

private def resultTypes : List String :=
  ["text", "error-text", "json", "error-json", "execution-denied", "content"]

def normalizeToolResultOutput (output : Json) : R Json := do
  if ← isToolResultOutput output then return output
  match field output "type" with
  | .str kind =>
    if isObj output && resultTypes.contains kind then
      jsThrow s!"Invalid ToolResultOutput for type \"{kind}\""
  | _ => pure ()
  match output with
  | .str value =>
    if isDateText value then erasedType
    else return Json.mkObj [("type", Json.str "text"), ("value", output)]
  | other =>
    if holdsErasedValue erasureDepth other then erasedType
    else return Json.mkObj [("type", Json.str "json"), ("value", other)]

/-! ## Agent config -/

private def mergedList (config parent : Json) (key : String) : List (String × Json) :=
  let merged := dedupe (items (field parent key) ++ items (field config key))
  if merged.isEmpty then [] else [(key, Json.arr merged.toArray)]

def subagentConfig (config parent : Json) : Json :=
  spread config (Json.mkObj (
    mergedList config parent "policies" ++ mergedList config parent "denyTools" ++
    [("subagent", spread (field config "subagent") (Json.mkObj [("enabled", Json.bool false)]))]))

/-- `applyRunOverrides(parent, { model: parent.subagent?.model })`, agent-config.ts:606. -/
private def withSubagentModel (parent : Json) : R Json := do
  let model := fieldAt parent ["subagent", "model"]
  if !truthy model || (entries model).isEmpty then return parent
  if truthy (field parent "harness") && field model "providerOptions" != Json.null then
    jsThrow "model.providerOptions is not supported with config.harness; set model.reasoning"
  return spread parent (Json.mkObj [("model", spread (field parent "model") model)])

def virtualSubagentConfig (parent : Json) : R Json := do
  return subagentConfig (← withSubagentModel parent) parent

/-! ## Images -/

private def u16be (bytes : Array Nat) (at_ : Nat) : Nat :=
  bytes.getD at_ 0 * 256 + bytes.getD (at_ + 1) 0

private def u16le (bytes : Array Nat) (at_ : Nat) : Nat :=
  bytes.getD (at_ + 1) 0 * 256 + bytes.getD at_ 0

private def u32be (bytes : Array Nat) (at_ : Nat) : Nat :=
  u16be bytes at_ * 65536 + u16be bytes (at_ + 2)

private def u32le (bytes : Array Nat) (at_ : Nat) : Nat :=
  u16le bytes (at_ + 2) * 65536 + u16le bytes at_

private def u24le (bytes : Array Nat) (at_ : Nat) : Nat :=
  bytes.getD (at_ + 2) 0 * 65536 + u16le bytes at_

private def latin1 (bytes : Array Nat) (start stop : Nat) : String :=
  String.ofList (((bytes.toList.drop start).take (stop - start)).map Char.ofNat)

abbrev Pixels := Nat × Nat

private def pixelsJson (pixels : Pixels) : Json :=
  Json.mkObj [("width", nat pixels.1), ("height", nat pixels.2)]

private def jpegWalk (bytes : Array Nat) : Nat → Nat → Option Pixels
  | 0, _ => none
  | fuel + 1, offset =>
    if offset + 9 ≤ bytes.size && bytes.getD offset 0 == 0xff then
      let marker := bytes.getD (offset + 1) 0
      if marker == 0xff then jpegWalk bytes fuel (offset + 1)
      else if marker ≥ 0xc0 && marker ≤ 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc then
        some (u16be bytes (offset + 7), u16be bytes (offset + 5))
      else jpegWalk bytes fuel (offset + 2 + u16be bytes (offset + 2))
    else none

def jpegSize (bytes : Array Nat) : Option Pixels := jpegWalk bytes (bytes.size + 1) 2

private def webpSize (bytes : Array Nat) : Option Pixels :=
  if bytes.size < 30 then none
  else
    match latin1 bytes 12 16 with
    | "VP8 " => some (u16le bytes 26 % 16384, u16le bytes 28 % 16384)
    | "VP8L" =>
      let bits := u32le bytes 21
      some (bits % 16384 + 1, bits / 16384 % 16384 + 1)
    | "VP8X" => some (u24le bytes 24 + 1, u24le bytes 27 + 1)
    | _ => none

def imageSize (bytes : Array Nat) (mediaType : String) : Option Pixels :=
  if mediaType == "image/png" then
    if bytes.size ≥ 24 && latin1 bytes 12 16 == "IHDR" then some (u32be bytes 16, u32be bytes 20)
    else none
  else if mediaType == "image/gif" then
    if bytes.size ≥ 10 then some (u16le bytes 6, u16le bytes 8) else none
  else if mediaType == "image/webp" then webpSize bytes
  else jpegSize bytes

private def isBase64Char (c : Char) : Bool :=
  isAlpha c || isDigit c || c == '+' || c == '/'

def base64Bytes (data : String) : Option Nat :=
  let chars := data.toList
  let body := chars.takeWhile isBase64Char
  let tail := chars.drop body.length
  let tailOk := tail == [] || tail == ['='] || tail == ['=', '=']
  if jsLength data % 4 != 0 || !tailOk then none
  else some (chars.length / 4 * 3 - tail.length)

/-- `imageMediaTypeSignatures` up to the last type a model takes, in order; `none` is a wildcard. -/
private def imageSignatures : List (String × List (Option Nat)) := [
  ("image/gif", [71, 73, 70, 56, 55, 97].map some),
  ("image/gif", [71, 73, 70, 56, 57, 97].map some),
  ("image/png", [137, 80, 78, 71].map some),
  ("image/jpeg", [255, 216].map some),
  ("image/webp", [some 82, some 73, some 70, some 70, none, none, none, none,
    some 87, some 69, some 66, some 80])]

private def matchesSignature (bytes : List Nat) (signature : List (Option Nat)) : Bool :=
  bytes.length ≥ signature.length &&
    (signature.zip bytes).all fun (want, have_) =>
      match want with
      | some value => value == have_
      | none => true

private def sniffPrefix (data : String) (maxBytes : Nat) : List Nat :=
  let maxChars := (maxBytes + 2) / 3 * 4
  (fromBase64 (String.ofList (data.toList.take maxChars))).toList.take maxBytes

/-- `detectMediaType`, provider-utils, for valid base64. Signatures past WebP cannot be a type
`MODEL_IMAGE_TYPES` holds, so a miss here and a hit there both refuse the image alike. -/
def detectImageType (data : String) : Option String :=
  let head := sniffPrefix data 18
  let bytes :=
    if head.length > 10 && head.take 3 == [73, 68, 51] then
      let full := sniffPrefix data 131084
      let byteAt := fun (i : Nat) => (full.getD i 0) % 128
      let size := byteAt 6 * 2097152 + byteAt 7 * 16384 + byteAt 8 * 128 + byteAt 9
      full.drop (size + 10)
    else head
  (imageSignatures.find? fun entry => matchesSignature bytes entry.2).map (·.1)

private structure ImageTally where
  images : Nat := 0
  bytes : Nat := 0
  parts : List Json := []

private def imageNote (part : Json) (data : String) (problem : String) : Json :=
  Json.mkObj [
    ("type", Json.str "text"),
    ("text", Json.str s!"[An image ({text (field part "mediaType")}, {jsLength data} base64 characters) was not shown to you: {problem}.]")]

private def notPicture : String := "it is not a PNG, JPEG, GIF or WebP image"

private def limitImage (tally : ImageTally) (part : Json) (data : String) : ImageTally :=
  let refuse := fun (problem : String) => { tally with parts := imageNote part data problem :: tally.parts }
  match base64Bytes data, detectImageType data with
  | some size, some mediaType =>
    if tally.bytes + size > maxImageBytes then
      refuse s!"it would take the result over the {maxImageBytes / 1024 / 1024} MB of images one result may carry"
    else if tally.images ≥ maxResultImages then
      refuse s!"the result carries more than {maxResultImages} images"
    else
      match imageSize (fromBase64 data) mediaType with
      | none => refuse notPicture
      | some (width, height) =>
        if max width height > maxImageSide || min width height < 1 then
          refuse s!"it is {width}x{height} pixels; a side must be 1 to {maxImageSide}"
        else
          { images := tally.images + 1
            bytes := tally.bytes + size
            parts := spread part (Json.mkObj [("mediaType", Json.str mediaType)]) :: tally.parts }
  | _, _ => refuse notPicture

def withImageLimits (parts : List Json) : R Json := do
  let tally ← parts.foldlM (fun (tally : ImageTally) part =>
    if field part "type" != Json.str "image-data" then
      pure { tally with parts := part :: tally.parts }
    else
      match field part "data" with
      | .str data => pure (limitImage tally part data)
      | _ => noModel "image data is not a string") {}
  return Json.arr tally.parts.reverse.toArray

/-- A `Buffer` as recorded by its `toJSON`. -/
private def bufferBytes (value : Json) : R (Array Nat) :=
  match (items (field value "data")).mapM intOf? with
  | some bytes => pure (bytes.map Int.toNat).toArray
  | none => noModel "not a recorded Buffer"

private def optionalPixels : Option Pixels → Json
  | some pixels => pixelsJson pixels
  | none => Json.null

/-! ## Subagent ownership -/

private def isLineEnd (c : Char) : Bool :=
  c == '\n' || c == '\r' || c.toNat == 0x2028 || c.toNat == 0x2029

/-- `parseAccountAgentScopedKey`, shared/runtime-keys.ts:275: account and agent. -/
def parseAccountAgentScopedKey (value : String) : Option (String × String) :=
  let notColon := Re.noneOf ":"
  let pattern := Re.seqs [.bol, Re.lit "acct:", .group 1 (Re.plus notColon), Re.lit ":agent:",
    .group 2 (Re.plus notColon), Re.lit ":", Re.plus (.chr fun c => !isLineEnd c), .eol]
  let s := value.toList.toArray
  (Re.execFrom pattern s 0).bind fun found =>
    match Re.groupText s found 1, Re.groupText s found 2 with
    | some account, some agent => some (account, agent)
    | _, _ => none

private def hexLower : Re := .chr fun c => ('0' ≤ c ∧ c ≤ '9') || ('a' ≤ c ∧ c ≤ 'f')

private def subagentTaskId : Re :=
  let hex (n : Nat) : List Re := List.replicate n hexLower
  Re.seqs ([.bol, Re.lit "subagent~",
    .group 1 (Re.plus (.chr fun c => isAlpha c || isDigit c || c == '_' || c == '-')),
    Re.lit "~"] ++ hex 8 ++ [Re.lit "-"] ++ hex 4 ++ [Re.lit "-", .chr (fun c => '1' ≤ c ∧ c ≤ '8')] ++
    hex 3 ++ [Re.lit "-", Re.oneOf "89ab"] ++ hex 3 ++ [Re.lit "-"] ++ hex 12 ++ [.eol])

private def toUrlAlphabet (c : Char) : Char :=
  if c == '+' then '-' else if c == '/' then '_' else c

private def fromUrlAlphabet (c : Char) : Char :=
  if c == '-' then '+' else if c == '_' then '/' else c

/-- `subagentParentEventId`, shared/runtime-keys.ts:303. The round trip through base64url refuses
anything that did not decode to the same text. -/
def subagentParentEventId (taskId : String) : Option String := do
  let encoded ← Re.firstGroup subagentTaskId taskId
  let bytes := fromBase64 (String.ofList (encoded.toList.map fromUrlAlphabet))
  let decoded ← String.fromUTF8? (ByteArray.mk (bytes.map UInt8.ofNat))
  let again := String.ofList (((toBase64 decoded).toList.filter (· != '=')).map toUrlAlphabet)
  if again != encoded then none
  else (parseAccountAgentScopedKey decoded).map fun _ => decoded

/-- `startedInConversation`, without the last step: the parent's conversation is in storage. -/
def startedInConversation (context : Json) (taskId : String) : R Bool :=
  match subagentParentEventId taskId with
  | none => pure false
  | some parentEventId =>
    if Json.str parentEventId == field context "eventId" then pure true
    else
      match parseAccountAgentScopedKey parentEventId with
      | none => pure false
      | some (account, _) =>
        if Json.str account != field context "accountId" then pure false
        else noModel "the parent run's conversation is in storage, not the arguments"

/-! ## The twins -/

private def textArg (value : Json) (name : String) (run : String → R Json) : R Json :=
  match value with
  | .str inner => run inner
  | _ => noModel s!"{name} is not a string"

def utilTwins : List Spec.Twin := [
  tool file "isFatalSandboxSetupError" (fun a => textArg (arg a 0) "value" fun value =>
    pure (Json.bool (isFatalSandboxSetupError value))),
  tool file "toolError" (fun a => textArg (arg a 0) "value" fun value =>
    jsThrow (if isFatalSandboxSetupError value then s!"Sandbox setup failed: {value}" else value)),
  tool file "subagentNotFound" fun a =>
    pure (Json.str s!"Error: no subagent task found for {text (arg a 0)}"),
  tool file "textPart" fun a => pure (textPart (arg a 0) (arg a 1)),
  tool file "formatJSONValue" fun a => do return Json.str (← formatJSONValue (arg a 0)),
  tool file "parseToolResultOutput" fun a => do
    return (← parseToolResultOutput (arg a 0)).getD Json.null,
  tool file "normalizeToolResultOutput" fun a => normalizeToolResultOutput (arg a 0),
  tool file "modelValueToUserParts" fun a => modelValueToUserParts (arg a 0),
  tool file "toolContentPartToUserPart" fun a => contentPartToUserPart (arg a 0),
  tool file "urlToolContentPartToUserPart" fun a => urlPartToUserPart (arg a 0),
  tool file "prependTextToUserParts" (fun a => textArg (arg a 0) "prefix" fun prefix =>
    let parts := items (arg a 1)
    match parts with
    | head :: rest =>
      if field head "type" == Json.str "text" then
        pure (Json.arr (Array.mk (spread head (Json.mkObj
          [("text", Json.str (prefix ++ text (field head "text")))]) :: rest)))
      else pure (Json.arr (Array.mk (textPart (Json.str prefix) Json.null :: parts)))
    | [] => pure (Json.arr #[textPart (Json.str prefix) Json.null])),
  tool file "toolContentItems" fun a =>
    pure (Json.arr ((items (field (arg a 0) "content")).flatMap fun part =>
      if field part "type" == Json.str "tool-result" &&
          fieldAt part ["output", "type"] == Json.str "content" then
        items (fieldAt part ["output", "value"])
      else []).toArray),
  tool file "subagentConfig" fun a => pure (subagentConfig (arg a 0) (arg a 1)),
  tool file "virtualSubagentConfig" fun a => virtualSubagentConfig (arg a 0),
  tool file "withImageLimits" fun a => withImageLimits (items (arg a 0)),
  tool file "base64Bytes" (fun a => textArg (arg a 0) "data" fun data =>
    pure (((base64Bytes data).map nat).getD Json.null)),
  tool file "imageSize" (fun a => textArg (arg a 1) "mediaType" fun mediaType => do
    return optionalPixels (imageSize (← bufferBytes (arg a 0)) mediaType)),
  tool file "jpegSize" fun a => do
    return optionalPixels (jpegSize (← bufferBytes (arg a 0))),
  tool file "isJSONValue" (fun a =>
    if holdsErasedValue erasureDepth (arg a 0) then erasedType else pure (Json.bool true)),
  tool file "startedInConversation" (fun a => textArg (arg a 1) "taskId" fun taskId => do
    return Json.bool (← startedInConversation (arg a 0) taskId)),
  tool file "getOwnedSubagent" (fun a =>
    textArg (field (arg a 1) "taskId") "taskId" fun taskId => do
      if ← startedInConversation (arg a 0) taskId then
        noModel "the subagent's record is in storage, not the arguments"
      else return Json.null)]

end Spec.Sandbox.Tools
