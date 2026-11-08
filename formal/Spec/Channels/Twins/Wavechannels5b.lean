import Spec.Channels.Twins.Support
import Spec.Access.Twins.Crypto

/-!
Twins for the functions listed in `.lake/worklist/assign5/channels5b.tsv`.
-/

namespace Spec.Channels.Wavechannels5b

open Lean Spec Spec.Channels

private def get (v : Json) (k : String) : Json := (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def text (v : Json) : String := v.getStr?.toOption.getD ""
private def undef : Json := Twin.undefinedJson
private def isUndef (v : Json) : Bool := v == Twin.undefinedJson
private def nullish (v : Json) : Bool := isUndef v || v == .null
private def live (v : Json) : Bool := !nullish v && truthy v
private def a (c : Json) (n : Nat) : Json := Twin.callArg c n
private def obj (pairs : List (String × Json)) : Json := Json.mkObj pairs
private def fnValue (name : String) : Json := obj [("$fn", .str name)]
private def int (v : Json) : Int := v.getInt?.toOption.getD 0
private def selfField (c : Json) (k : String) : Json := Twin.field (Twin.self c) k

/-- A key and value, left out when the value is `undefined`, as `JSON` does. -/
private def present (key : String) (value : Json) : List (String × Json) :=
  if isUndef value then [] else [(key, value)]

private def core (file name : String) : String := s!"apps/core/src/shared/{file}.ts#{name}"
private def media (name : String) : String := s!"apps/core/src/harness/channel-media.ts#{name}"

/-! ## Inbound attachments -/

/-- `Buffer.byteLength` of a recorded `$bytes` value, from its base64 length. -/
private def byteLength (bytes : Json) : Nat :=
  let chars := (text (get bytes "$bytes")).toList.filter (· != '=')
  chars.length * 3 / 4

/-- The message `err instanceof Error ? err.message : String(err)` gives for a recorded error. -/
private def errorMessage (error : Json) : Prog String :=
  match (error.getObjVal? "$error").toOption with
  | some body => pure (text (get body "message"))
  | none => Prog.unsupported "a thrown value that is not an Error"

/-- `URLSearchParams` serialisation of one key or value. -/
private def formEncode (s : String) : String :=
  (encodeComponent s).replace "%20" "+" |>.replace "!" "%21" |>.replace "'" "%27"
    |>.replace "(" "%28" |>.replace ")" "%29" |>.replace "~" "%7E"

/-- A metadata object's entries in insertion order, which `$keys` records. -/
private def orderedEntries (value : Json) : List (String × Json) :=
  let plain := (entries value).filter (fun entry => entry.1 != "$keys")
  match (value.getObjVal? "$keys").toOption.bind (fun keys => keys.getArr?.toOption) with
  | some keys =>
    keys.toList.filterMap fun key =>
      plain.find? (fun entry => entry.1 == text key)
  | none => plain

/-- `mediaReferenceUrl`, needed up front because `cacheMedia` overlaps it and takes its answer. -/
private def referenceValue (att mediaType name channel : Json) : Prog (Option String) := do
  let fetchMetadata := get att "fetchMetadata"
  let metadata :=
    if !nullish fetchMetadata then fetchMetadata
    else if live (get att "url") then obj [("url", get att "url")]
    else undef
  if nullish metadata || (orderedEntries metadata).isEmpty then return none
  let own := orderedEntries metadata
  if own.any (fun entry => entry.1 == "mediaType" || entry.1 == "type") then
    return ← Prog.unsupported "metadata keys that collide with the reference's own parameters"
  let pairs := own ++ [("mediaType", mediaType), ("type", get att "type")]
  let query := "&".intercalate (pairs.map fun p => formEncode p.1 ++ "=" ++ formEncode (text p.2))
  return some s!"broods-media://{text channel}/{encodeComponent (text name)}?{query}"

/-- `[^\p{L}\p{N}._-]+` collapsed to `-`, edges trimmed, cut to 80. ASCII names only. -/
private def safeName (name : String) : Option String :=
  if name.toList.any (fun ch => ch.toNat > 127) then none else
  let allowed := fun (ch : Char) => ch.isAlphanum || ['.', '_', '-'].contains ch
  let collapsed := (name.toList.foldl (fun (acc : List Char × Bool) ch =>
    if allowed ch then (ch :: acc.1, false)
    else if acc.2 then acc else ('-' :: acc.1, true)) ([], false)).1.reverse
  let trimmed := (collapsed.dropWhile (· == '-')).reverse.dropWhile (· == '-') |>.reverse
  some (String.ofList (trimmed.take 80))

/-- `mediaPath`, needed up front because `writeMediaObject` overlaps it and takes its answer. -/
private def pathValue (name eventId : String) (index : Int) : Prog String := do
  let some safe := safeName name | return ← Prog.unsupported "Unicode letters in a media name"
  let digest := Spec.Access.Crypto.hex (Spec.Access.Crypto.sha256 (Spec.Access.Crypto.utf8 eventId))
  let folder := String.ofList (digest.toList.take 12)
  return s!"media/{folder}/{index}-{if safe.isEmpty then "attachment" else safe}"

/-- The first failure among overlapping effects, as `Promise.all` raises it. -/
private def firstThrown : List Outcome → Option Json
  | [] => none
  | .threw error _ :: _ => some error
  | _ :: rest => firstThrown rest

private def outcomeValue : Outcome → Json
  | .ok value => value
  | _ => undef

private def optionalTranscript (transcript : Json) : List (String × Json) :=
  if live transcript then [("transcript", transcript)] else []

/-- The `try` body of `storeAttachment`, after the bytes were read. -/
private def storeBody (att index context bytes claimed : Json) (received : Nat) : Prog Json := do
  let mediaType ← Prog.effect "resolveMediaType" [bytes, claimed]
  let _ ← Prog.effect "assertWithinLimit" [toJson received, mediaType]
  let name ← Prog.effect "mediaFileName" [att, mediaType, index]
  let transcribe := ("audioTranscript", [bytes, mediaType, get context "agentConfig"])
  let workspace := get context "workspace"
  let accountId := get context "accountId"
  let channel := get context "channelName"
  if !live workspace || !live accountId then
    let reference ← referenceValue att mediaType name channel
    let referenceCall := ("mediaReferenceUrl", [att, mediaType, name, channel])
    let outcomes ← Prog.all [transcribe, referenceCall]
    if let some error := firstThrown (outcomes.drop 1) then
      return ← throw error
    if let some url := reference then
      let _ ← Prog.effect "cacheMedia" [Json.str url, bytes]
    if let some error := firstThrown (outcomes.take 1) then
      return ← throw error
    let transcript := outcomeValue (outcomes.headD .pending)
    let referenceEntry := match reference with
      | some url => [("reference", Json.str url)]
      | none => []
    return obj ([("name", name), ("mediaType", mediaType), ("data", bytes),
      ("receivedBytes", toJson received)] ++ referenceEntry ++ optionalTranscript transcript)
  let eventId := get context "eventId"
  let path ← pathValue (text name) (text eventId) (int index)
  let outcomes ← Prog.all [transcribe,
    ("mediaPath", [name, eventId, index]),
    ("writeMediaObject", [workspace, accountId, .str path, bytes, mediaType])]
  if let some error := firstThrown outcomes then
    return ← throw error
  let transcript := outcomeValue (outcomes.headD .pending)
  let url := outcomeValue (outcomes.getD 2 .pending)
  let landing := if live url then [("url", url)] else [("data", bytes)]
  return obj ([("name", name), ("mediaType", mediaType), ("path", .str path),
    ("receivedBytes", toJson received)] ++ landing ++ optionalTranscript transcript)

/-- `storeAttachment`: every failure becomes a stored line of text. -/
private def storeAttachment (c : Json) : Prog Json := do
  let att := a c 0
  let index := a c 1
  let context := a c 2
  let claimed := get att "mimeType"
  let fallbackName :=
    if !nullish (get att "name") then get att "name"
    else .str s!"{text (get att "type")}-{int index + 1}"
  let failed := fun (message : String) (received : Nat) =>
    obj [("name", fallbackName),
      ("mediaType", if nullish claimed then .str "application/octet-stream" else claimed),
      ("failure", .str message), ("receivedBytes", toJson received)]
  let size := get att "size"
  if !isUndef size then
    let limit ← Prog.effect "limitForMediaType" [claimed]
    if int size > int limit then
      let again ← Prog.effect "limitForMediaType" [claimed]
      let shown ← Prog.effect "formatBytes" [again]
      return failed s!"file is larger than {text shown}" 0
  match ← Prog.attempt "readAttachmentBytes" [att] with
  | .pending => Prog.unsupported "the read never finished"
  | .threw error _ => return failed (← errorMessage error) 0
  | .ok bytes =>
    let received := byteLength bytes
    Prog.catchFail (storeBody att index context bytes claimed received) fun error => do
      if (error.getObjVal? "$unsupported").toOption.isSome then
        return ← throw error
      return failed (← errorMessage error) received

/-- `writeMediaObject`. The second write's bucket and key are computed because the writes overlap the
lookups that name them: `workspaceReadContext` reads the same `FILESYSTEM_BUCKET_NAME`. -/
private def writeMediaObject (c : Json) : Prog Json := do
  let workspace := a c 0
  let accountId := a c 1
  let path := a c 2
  let bytes := a c 3
  let mediaType := a c 4
  let ticket := obj [("accountId", accountId), ("path", path)]
  let context ← Prog.effect "workspaceReadContext"
    [get (get workspace "config") "storage", get workspace "namespace"]
  let target ← Prog.effect "resolveS3ReadTarget" [context]
  let bucket := get context "managedBucket"
  if nullish bucket then
    return ← Prog.unsupported "no managed bucket: requireEnv throws mid-way through the array"
  let key := s!"attachments/{encodeComponent (text accountId)}/{text path}"
  let contentType := [("contentType", mediaType)]
  let outcomes ← Prog.all [
    ("writeS3Object", [get target "bucket", .str (text (get target "prefix") ++ text path), bytes,
      obj (contentType ++ present "access" (get target "access"))]),
    ("requireEnv", [.str "FILESYSTEM_BUCKET_NAME"]),
    ("attachmentStoreKey", [ticket]),
    ("writeS3Object", [bucket, .str key, bytes, obj contentType])]
  if let some error := firstThrown outcomes then
    return ← throw error
  Prog.effect "sealedLinkFor" [ticket]

/-! ## Channel factories -/

private def loggerFor (channel : String) : Prog Json := do
  let _ ← Prog.effect "new ConsoleLogger" [.str "error"]
  Prog.effect "new ConsoleLogger(\"error\").child" [.str channel]

private def fns (names : List String) : List (String × Json) :=
  names.map fun name => (name, fnValue name)

private def createSlackChannel (c : Json) : Prog Json := do
  let logger ← loggerFor "slack"
  let _ ← Prog.effect "new SlackAdapter"
    [obj (present "apiUrl" (Twin.param c 5) ++
      [("botToken", a c 0), ("signingSecret", a c 1), ("mode", .str "webhook"), ("logger", logger)])]
  return obj ([("name", .str "slack")] ++
    fns ["rehydrateAttachment", "canHandle", "authenticate", "parse", "actions", "applyReplyIn"])

private def createWhatsAppChannel (c : Json) : Prog Json := do
  let options := a c 0
  let logger ← loggerFor "whatsapp"
  let userName := get options "userName"
  let _ ← Prog.effect "new BroodsWhatsAppAdapter"
    [obj (present "apiUrl" (get options "apiUrl") ++ present "apiVersion" (get options "apiVersion") ++
      [("accessToken", get options "accessToken"), ("appSecret", get options "appSecret"),
       ("logger", logger), ("phoneNumberId", get options "phoneNumberId"),
       ("userName", if nullish userName then .str "whatsapp-bot" else userName),
       ("verifyToken", get options "verifyToken")])]
  return obj ([("name", .str "whatsapp"), ("routesEachEntry", toJson true)] ++
    fns ["rehydrateAttachment", "canHandle", "authenticate", "parse", "actions"])

private def createSlackActions (c : Json) : Prog Json := do
  let source := a c 3
  let _ ← Prog.effect "channelApiFetch" [a c 1]
  let threadTs := get source "threadTs"
  let threadId ←
    if live threadTs then
      Prog.effect "slack.encodeThreadId"
        [obj [("channel", get source "channelId"), ("threadTs", threadTs)]]
    else pure undef
  let _ ← Prog.effect "new SlackFormatConverter"
  let stream := if live threadId && live (get source "userId") then fns ["stream"] else []
  return obj (fns ["sendFiles", "sendImages", "sendQuestions", "sendSticker", "sendText", "sendTyping",
    "reactToMessage"] ++ [("supportsReactions", toJson (live (get source "messageTs")))] ++ stream)

/-! ## WhatsApp, Discord and Pancake leaves -/

/-- `downloadMedia`'s lookup hop. The recordings stop there, so a good answer is out of the model. -/
private def downloadMedia (c : Json) : Prog Json := do
  let auth := obj [("headers", obj
    [("authorization", .str s!"Bearer {text (selfField c "accessToken")}")])]
  let lookup ← Prog.effect "guardedFetch"
    [.str s!"{text (selfField c "graphApiUrl")}/{text (a c 0)}", auth]
  let status := int (get lookup "status")
  if status < 200 || status >= 300 then
    return ← Prog.throwError "Error" s!"WhatsApp media lookup answered {status}"
  Prog.unsupported "the download hop has no recording"

private def standardBase64 (text : String) : String :=
  let plain := text.toList.map fun ch =>
    if ch == '-' then '+' else if ch == '_' then '/' else ch
  String.ofList (plain ++ List.replicate ((4 - plain.length % 4) % 4) '=')

private def verifyRequestSignature (c : Json) : Prog Json :=
  let body := standardBase64
    (Spec.Access.Crypto.base64UrlEncode (Spec.Access.Crypto.utf8 (text (a c 0))))
  let orNull := fun (v : Json) => if nullish v then Json.null else v
  Prog.effect "this.verifySignature" [obj [("$bytes", .str body)], orNull (a c 1), orNull (a c 2)]

private def uploadPancakeContent (c : Json) : Prog Json := do
  let attachment := a c 2
  let name ← Prog.effect "channelAttachmentName" [attachment]
  let form ← Prog.effect "new FormData"
  let bytes ← Prog.effect "channelAttachmentBytes" [attachment]
  let mimeType := get attachment "mimeType"
  let contentType ←
    if nullish mimeType then Prog.effect "contentTypeForPath" [name] else pure mimeType
  let file ← Prog.effect "new File" [.arr #[bytes], name, obj [("type", contentType)]]
  let _ ← Prog.effect "form.set" [.str "file", file]
  let url ← Prog.effect "pancakeApiUrl"
    [.str s!"pages/{encodeComponent (text (a c 1))}/upload_contents", a c 0]
  let response ← Prog.effect "fetch" [url, obj [("method", .str "POST"), ("body", form)]]
  let bodyText ← Prog.effect "response.text"
  let body ← Prog.effect "parseJsonBody" [bodyText]
  let status := int (get (get response "$response") "status")
  let contentId := get body "id"
  if status < 200 || status >= 300 || !live contentId then
    let shown ← Prog.effect "formatPancakeError" [body, bodyText]
    return ← Prog.throwError "Error"
      s!"Pancake upload of {text name} failed ({status}): {text shown}"
  return contentId

private def sendPancakeAttachments (c : Json) : Prog Json := do
  let source := a c 1
  let attachments := (a c 2).getArr?.toOption.getD #[] |>.toList
  let caption := a c 3
  let senderId := a c 4
  let mut index := 0
  for attachment in attachments do
    let contentId ← Prog.effect "uploadPancakeContent"
      [a c 0, get source "pageId", attachment]
    let captionText := if index == 0 && !nullish caption then jsTrim (text caption) else ""
    let payload := [("content_ids", Json.arr #[contentId])] ++
      (if captionText.isEmpty then [] else [("message", Json.str captionText)]) ++
      (if live senderId then [("sender_id", senderId)] else [])
    let _ ← Prog.effect "postPancakeMessage" [a c 0, source, obj payload]
    index := index + 1
  return undef

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (media "storeAttachment") storeAttachment,
   Twin.traced (media "writeMediaObject") writeMediaObject,
   Twin.traced (core "slack-channel" "createSlackChannel") createSlackChannel,
   Twin.traced (core "slack-channel" "createSlackActions") createSlackActions,
   Twin.traced (core "slack-channel" "createSlackUserNameResolver")
     (fun _ => pure (fnValue "")),
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel") createWhatsAppChannel,
   Twin.traced (core "whatsapp-channel" "BroodsWhatsAppAdapter.downloadMedia") downloadMedia,
   Twin.traced (core "discord-channel" "BroodsDiscordAdapter.verifyRequestSignature")
     verifyRequestSignature,
   Twin.traced (core "pancake-channel" "uploadPancakeContent") uploadPancakeContent,
   Twin.traced (core "pancake-channel" "sendPancakeAttachments") sendPancakeAttachments,
   Twin.traced "packages/convex/model/connections.ts#isConnectionType"
     (fun c => pure (toJson (a c 0 == .str "chatgpt")))]

end Spec.Channels.Wavechannels5b
