import Spec.Channels.Twins.Wavechannels1.Base

namespace Spec.Channels.Wavechannels1.Delivery

open Lean Spec Spec.Channels.Wavechannels1.Base

private def rules (name : String) : String := "packages/convex/model/channelRules.ts#" ++ name
private def media (name : String) : String := "apps/core/src/media.ts#" ++ name
private def pancake (name : String) : String := "apps/core/src/shared/pancake-channel.ts#" ++ name

private def maxMediaBytes : Nat := 26214400

private def schema : Json := Json.mkObj [("$opaque", toJson "ZodMiniObject")]

private def trimmed (value : Json) : Json :=
  if nullish value then undef else .str (jsTrim (text value))

private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if jsTruthy value then [(key, value)] else []

private def binding (entry : Json) : Json :=
  Json.mkObj ([("agentId", .str (jsTrim (text (get entry "agentId"))))] ++
    if get entry "isDefault" == .bool true then [("isDefault", .bool true)] else [])

private def workspaceRef (entry : Json) : Json :=
  Json.mkObj [("name", .str (jsTrim (text (get entry "name")))),
    ("workspaceId", .str (jsTrim (text (get entry "workspaceId"))))]

private def tagRole (entry : Json) : Json :=
  let users := get entry "userIds"
  Json.mkObj [("roleId", .str (jsTrim (text (get entry "roleId")))),
    ("userIds", if nullish users then Json.arr #[] else users)]

private def partitionOf (value : Json) : Json :=
  if get value "by" == .str "shared" then Json.mkObj [("by", .str "shared")]
  else Json.mkObj [("by", .str "conversation"), ("alias", .str (jsTrim (text (get value "alias"))))]

private def normalizeConfig (call : Json) : Prog Json := do
  let config ← Prog.effect "parseInput" [schema, Twin.callArg call 0, .str "config"]
  let mapped := fun (key : String) (render : Json → Json) =>
    let value := get config key
    if jsTruthy value then [(key, jarr ((items value).map render))] else []
  return Json.mkObj (
    whenTruthy "instructions" (trimmed (get config "instructions")) ++
    [("agentBindings", jarr ((items (get config "agentBindings")).map binding))] ++
    mapped "workspaces" workspaceRef ++
    whenTruthy "policies" (get config "policies") ++
    whenTruthy "denyTools" (get config "denyTools") ++
    whenTruthy "replyIn" (get config "replyIn") ++
    (if jsTruthy (get config "partition") then [("partition", partitionOf (get config "partition"))]
     else []) ++
    whenTruthy "sandboxImages" (get config "sandboxImages") ++
    mapped "tagRoles" tagRole)

private def normalizeCreate (call : Json) : Prog Json := do
  let input ← Prog.effect "parseInput" [schema, Twin.callArg call 0, .str ""]
  let config ← Prog.effect "normalizeChannelRecordConfig" [get input "config"]
  let trim := fun (key : String) => (key, Json.str (jsTrim (text (get input key))))
  return Json.mkObj ([trim "platform", trim "externalId", trim "name"] ++
    whenTruthy "workspaceRef" (trimmed (get input "workspaceRef")) ++
    whenTruthy "description" (trimmed (get input "description")) ++
    [("config", config)])

private def normalizeUpdate (call : Json) : Prog Json := do
  let input ← Prog.effect "parseInput" [schema, Twin.callArg call 0, .str ""]
  let orNull := fun (key : String) =>
    let value := get input key
    if missing value then [] else
      let out := trimmed value
      [(key, if jsTruthy out then out else Json.null)]
  let config ←
    if missing (get input "config") then pure []
    else do
      let value ← Prog.effect "normalizeChannelRecordConfig" [get input "config"]
      pure [("config", value)]
  return Json.mkObj (
    (if missing (get input "name") then []
     else [("name", Json.str (jsTrim (text (get input "name"))))]) ++
    orNull "description" ++ orNull "workspaceRef" ++ config ++
    (if missing (get input "status") then [] else [("status", get input "status")]))

/-- Decoded length of the recorder's base64 `$bytes`. -/
private def byteLength (bytes : Json) : Nat :=
  let encoded := text (get bytes "$bytes")
  let padding := (encoded.toList.filter (· == '=')).length
  encoded.length * 3 / 4 - padding

private def readMediaObject (call : Json) : Prog Json := do
  let object := Twin.callArg call 0
  let ticket := Twin.callArg call 1
  let bytes ← Prog.effect "readS3Bytes"
    [get object "bucket", get object "key", get object "access", num maxMediaBytes]
  if !jsTruthy (get object "access") then
    let egress := normalize ⟨(byteLength bytes : Int), 9⟩
    let scope := if missing (get ticket "workspaceId") then undef
      else Json.mkObj [("workspaceId", get ticket "workspaceId")]
    let _ ← Prog.effect "recordUsage"
      [get ticket "accountId", Json.mkObj [("egressGb", .num egress)], scope]
  return bytes

private def located (bucket key access head : Json) : Json :=
  Json.mkObj ([("bucket", bucket), ("key", key), ("head", head)] ++
    if missing access then [] else [("access", access)])

private def locateMediaObject (call : Json) : Prog Json := do
  let ticket := Twin.callArg call 0
  if missing (get ticket "workspaceId") then
    let bucket ← Prog.effect "requireEnv" [.str "FILESYSTEM_BUCKET_NAME"]
    let key ← Prog.effect "attachmentStoreKey" [ticket]
    let head ← Prog.effect "headS3Object" [bucket, key]
    return if jsTruthy head then located bucket key undef head else .null
  let _ ← Prog.effect "getStorage"
  let record ← Prog.effect "getStorage().workspaceConfigs.getById"
    [get ticket "accountId", get ticket "workspaceId"]
  if !jsTruthy record then return .null
  let context ← Prog.effect "workspaceReadContext"
    [get (get record "config") "storage", get ticket "namespace"]
  let target ← Prog.effect "resolveS3ReadTarget" [context]
  let key := Json.str (text (get target "prefix") ++ text (get ticket "path"))
  let access := get target "access"
  let head ← Prog.effect "headS3Object"
    (if jsTruthy access then [get target "bucket", key, access] else [get target "bucket", key])
  return if jsTruthy head then located (get target "bucket") key access head else .null

/-- `Math.max(0, Math.floor(exp - nowMs / 1000))`, exact in integers. -/
private def maxAge (exp now : Int) : Nat := ((exp * 1000 - now) / 1000).toNat

private def numberText (value : Json) : String :=
  match value with
  | .num n => toString n
  | other => other.compress

private def mediaHeaders (ticket head contentType now : Json) : Json :=
  let exp := (asNum (get ticket "exp")).mantissa
  let pairs : List (String × String) :=
    [("cache-control", s!"public, max-age={maxAge exp (asNum now).mantissa}, immutable")] ++
    (if contentType == .str "image/svg+xml" then [("content-disposition", "attachment")] else []) ++
    (if missing (get head "contentLength") then []
     else [("content-length", numberText (get head "contentLength"))]) ++
    [("content-type", text contentType), ("x-content-type-options", "nosniff")]
  jarr (pairs.map fun (name, value) => jarr [.str name, .str value])

private def handleMediaRequest (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  let token := dropChars (text (get request "path")) 10
  let ticket ←
    if token == "" then pure Json.null
    else do
      let secret ← Prog.effect "requireSecretsEnv" [.str "MEDIA_TICKET_SECRET"]
      Prog.effect "openMediaTicket" [.str token, secret]
  if !jsTruthy ticket then return ← Prog.effect "notFound"
  let object ← Prog.effect "locateMediaObject" [ticket]
  if !jsTruthy object then return ← Prog.effect "notFound"
  let head := get object "head"
  let size := if missing (get head "contentLength") then 0 else (asNum (get head "contentLength")).mantissa
  if size > (maxMediaBytes : Int) then
    return ← Prog.effect "errorResponse" [num 413, .str "Payload too large"]
  let bytes ←
    if (text (get request "method")).toUpper != "HEAD" then
      Prog.effect "readMediaObject" [object, ticket]
    else pure Json.null
  let contentType ← Prog.effect "contentTypeForPath" [get ticket "path"]
  let now ← Prog.effect "Date.now"
  return Json.mkObj [("$response", Json.mkObj
    [("status", num 200), ("headers", mediaHeaders ticket head contentType now),
     ("body", bytes)])]

private def namedFns (names : List (String × String)) : List (String × Json) :=
  names.map fun (key, name) => (key, fnJson name)

private def pancakeActions : Json :=
  Json.mkObj (namedFns [("sendText", "sendText"), ("sendFiles", "sendAttachments"),
    ("sendImages", "sendAttachments"), ("sendTyping", "sendTyping"),
    ("reactToMessage", "reactToMessage")])

private def pancakeChannel : Json :=
  Json.mkObj ([("name", .str "pancake")] ++ namedFns [("canHandle", "canHandle"),
    ("authenticate", "authenticate"), ("parse", "parse"), ("actions", "actions")])

private def sendPancakeMessage (call : Json) : Prog Json := do
  let sender := Twin.callArg call 3
  let payload := Json.mkObj ([("message", Twin.callArg call 2)] ++ whenTruthy "sender_id" sender)
  Prog.effect "postPancakeMessage" [Twin.callArg call 0, Twin.callArg call 1, payload]

/-- `JSON.stringify` of the request body, in the order the object literals are written. -/
private def pancakeBody (source payload : Json) : String :=
  let comment := get source "messageType" == .str "COMMENT"
  let head : List (String × Json) :=
    if comment then [("action", .str "reply_comment"), ("message_id", get source "messageId")]
    else [("action", .str "reply_inbox")]
  let tail := ["content_ids", "message", "sender_id"].filterMap fun key =>
    let value := get payload key
    if missing value then none else some (key, value)
  "{" ++ ",".intercalate ((head ++ tail).map fun (key, value) =>
    (toJson key).compress ++ ":" ++ value.compress) ++ "}"

private def postPancakeMessage (call : Json) : Prog Json := do
  let token := Twin.callArg call 0
  let source := Twin.callArg call 1
  let path := "pages/" ++ encodeComponent (text (get source "pageId")) ++ "/conversations/" ++
    encodeComponent (text (get source "conversationId")) ++ "/messages"
  let url ← Prog.effect "pancakeApiUrl" [.str path, token]
  let response ← Prog.effect "fetch" [url, Json.mkObj
    [("method", .str "POST"),
     ("headers", Json.mkObj [("Content-Type", .str "application/json")]),
     ("body", .str (pancakeBody source (Twin.callArg call 2)))]]
  let bodyText ← Prog.effect "response.text"
  let body ← Prog.effect "parseJsonBody" [bodyText]
  let status := (asNum (get (get response "$response") "status")).mantissa
  if status < 200 || status > 299 || get body "success" == .bool false then
    let _ ← Prog.effect "formatPancakeError" [body, bodyText]
    let detail ← Prog.effect "formatPancakeError" [body, bodyText]
    return ← Prog.throwError "Error" s!"Pancake send message failed ({status}): {text detail}"
  return undef

private def ignored : Json := Json.mkObj [("kind", .str "ignore")]

private def pancakeMessage (pageId conversation message payload fromId fromName textValue : Json)
    (attachments tagIds hash : Json) : Json :=
  let page := text pageId
  let source := Json.mkObj (
    [("pageId", pageId), ("conversationId", get conversation "id"), ("messageId", get message "id"),
     ("messageType", get message "type"), ("tagIds", tagIds)] ++
    [("postId", get (get (get payload "data") "post") "id"), ("fromId", fromId), ("fromName", fromName),
     ("pageCustomerId", get (get message "from") "page_customer_id")].filter (!missing ·.2))
  let identity := Json.mkObj (
    [("workspaceRef", pageId), ("channelId", get conversation "id")] ++
    whenTruthy "userId" fromId ++ whenTruthy "userName" fromName)
  Json.mkObj [("kind", .str "message"), ("ack", Json.mkObj [("statusCode", num 200)]),
    ("message", Json.mkObj (
      [("eventId", .str s!"pancake:{page}:{text (get message "id")}:{text hash}"),
       ("conversationKey", .str s!"pancake:{page}:{text (get conversation "id")}"),
       ("channelName", .str "pancake"),
       ("content", jarr [Json.mkObj [("type", .str "text"),
         ("text", if missing textValue then .str "" else textValue)]])] ++
      (if (items attachments).isEmpty then [] else [("attachments", attachments)]) ++
      [("identity", identity), ("source", source)]))]

private def orElse (first second : Json) : Json := if nullish first then second else first

private def parsePancakeWebhook (call : Json) : Prog Json := do
  let pageId := Twin.callArg call 1
  let parsed ← Prog.effect "parseChannelWebhookBody"
    [.str "pancake", get (Twin.callArg call 0) "body"]
  if get parsed "kind" == .str "ignore" then return parsed
  let payload := get parsed "payload"
  if get payload "event_type" != .str "messaging" || get payload "page_id" != pageId then
    return ignored
  let conversation := get (get payload "data") "conversation"
  let message := get (get payload "data") "message"
  let textValue := trimmed (get message "message")
  let attachments ← Prog.effect "pancakeAttachments" [get message "attachments"]
  if !jsTruthy (get conversation "id") || !jsTruthy (get message "id") ||
      (!jsTruthy textValue && (items attachments).isEmpty) then
    return ignored
  let validType ← Prog.effect "isPancakeMessageType" [get message "type"]
  if !jsTruthy validType then return ignored
  let dropReason ← Prog.effect "pancakeDropReason" [message, pageId]
  if jsTruthy dropReason then return ignored
  let channelAllowed ← Prog.effect "isAllowedId" [Twin.callArg call 2, get conversation "id"]
  if !jsTruthy channelAllowed then return ignored
  let sender := get message "from"
  let owner := get conversation "from"
  let fromId := orElse (get sender "id") (get owner "id")
  let userAllowed ← Prog.effect "isAllowedId" [Twin.callArg call 3, fromId]
  if !jsTruthy userAllowed then return ignored
  let fromName := orElse (get sender "name") (get owner "name")
  let tagIds ← Prog.effect "normalizePancakeTagIds" [get conversation "tags"]
  let hash ← Prog.effect "hashEventContent" [textValue, attachments]
  return pancakeMessage pageId conversation message payload fromId fromName textValue attachments
    tagIds hash

/-- This file's twins. -/
def twins : List Twin :=
  [Twin.traced (rules "normalizeChannelRecordConfig") normalizeConfig,
   Twin.traced (rules "normalizeCreateChannelRecordInput") normalizeCreate,
   Twin.traced (rules "normalizeUpdateChannelRecordInput") normalizeUpdate,
   Twin.traced (media "notFound") (fun _ => Prog.effect "errorResponse" [num 404, .str "Not found"]),
   Twin.traced (media "readMediaObject") readMediaObject,
   Twin.traced (media "locateMediaObject") locateMediaObject,
   Twin.traced (media "handleMediaRequest") handleMediaRequest,
   Twin.traced (pancake "createPancakeActions") (fun _ => pure pancakeActions),
   Twin.traced (pancake "createPancakeChannel") (fun _ => pure pancakeChannel),
   Twin.traced (pancake "sendPancakeMessage") sendPancakeMessage,
   Twin.traced (pancake "postPancakeMessage") postPancakeMessage,
   Twin.traced (pancake "parsePancakeWebhook") parsePancakeWebhook]

end Spec.Channels.Wavechannels1.Delivery
