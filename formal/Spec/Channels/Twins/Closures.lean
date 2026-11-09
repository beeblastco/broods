import Spec.Twin
import Spec.Channels.Twins.Support

/-!
Twins of closures the channel adapters return: `parse`, `authenticate`, `canHandle`, `actions` and
the send methods. Each runs after its factory returned, so it has its own recording
(`file#factory/label`). `AUTHORING.md`, Traced twins.
-/

namespace Spec.Channels.Closures

open Lean Spec Spec.Channels

private def core (file factory label : String) : String :=
  s!"apps/core/src/shared/{file}.ts#{factory}/{label}"

private def get (value : Json) (key : String) : Json :=
  (field? value key).getD Twin.undefinedJson

private def arg (call : Json) (index : Nat) : Json := Twin.callArg call index

private def mod (call : Json) (name : String) : Json := Twin.moduleValue call name

private def undef : Json := Twin.undefinedJson

/-- JavaScript truthiness, where the recorded `undefined` is falsy. -/
private def isTruthy (value : Json) : Bool :=
  value != undef && truthy value

/-- `value ?? fallback`. -/
private def orElse (value fallback : Json) : Json :=
  if value == undef || value == .null then fallback else value

/-- `String(value)` for the strings and integers the webhooks carry. -/
private def jsString (value : Json) : String :=
  match value with
  | .str text => text
  | .num number =>
    match numInt? number with
    | some whole => toString whole
    | none => number.toString
  | .bool flag => toString flag
  | .null => "null"
  | other => if other == undef then "undefined" else other.compress

/-- An object's entries that are not `undefined`, as a literal with optional keys. -/
private def object (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => entry.2 != undef)

private def fnMarker (name : String) : Json :=
  Json.mkObj [("$fn", .str name)]

private def ignoreResult (reason : Option String) : Json :=
  Json.mkObj ([("kind", .str "ignore")] ++ optEntry "reason" (reason.map Json.str))

/-- `"x-..." in req.headers`. -/
private def hasHeader (req : Json) (name : String) : Bool :=
  (field? (get req "headers") name).isSome


/-- `text.slice(0, count)`, counting UTF-16 units. -/
private def sliceUnits (text : String) (count : Nat) : String :=
  let step := fun (acc : List Char × Nat) (c : Char) =>
    let width := if c.toNat > 0xffff then 2 else 1
    if acc.2 + width ≤ count then (c :: acc.1, acc.2 + width) else (acc.1, count + 1)
  String.ofList (text.toList.foldl step ([], 0)).1.reverse

/-- `Object.prototype.hasOwnProperty`-style lookup that treats `undefined` as absent. -/
private def isString (value : Json) : Bool :=
  (str? value).isSome


private def base64Char (n : Nat) : Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray.getD n 'A'

private def base64Groups : List Nat → List Char
  | x :: y :: z :: rest =>
    [base64Char (x / 4), base64Char ((x % 4) * 16 + y / 16), base64Char ((y % 16) * 4 + z / 64),
     base64Char (z % 64)] ++ base64Groups rest
  | [x, y] => [base64Char (x / 4), base64Char ((x % 4) * 16 + y / 16), base64Char ((y % 16) * 4), '=']
  | [x] => [base64Char (x / 4), base64Char ((x % 4) * 16), '=', '=']
  | [] => []

/-- `Buffer.from(text)` as the recorder writes it: the UTF-8 bytes in base64. -/
private def bufferOf (text : String) : Json :=
  Json.mkObj [("$bytes", .str (String.ofList (base64Groups (text.toUTF8.toList.map UInt8.toNat))))]

/-! ### Telegram -/

private def telegramApiUrl : String := "https://api.telegram.org"

/-- The `apiUrl` and `botToken` the factory handed the adapter, read back from it: the parse
closure does not hold them itself. -/
private def telegramCredentials (call : Json) : Json × Json :=
  let transport := mod call "transport"
  let base := Twin.field transport "apiBaseUrl"
  (if base == .str telegramApiUrl then undef else base, Twin.field transport "staticBotToken")

/-- The text a `r:<label>` reply button carries: one to sixty UTF-16 units after the prefix. -/
private def replyCallbackText (data : String) : Option String :=
  match stripPrefix? data "r:" with
  | some rest =>
    let units := rest.toList.foldl (fun n c => n + if c.toNat > 0xffff then 2 else 1) 0
    if 1 ≤ units && units ≤ 60 then some rest else none
  | none => none

/-- `parseQuestionClick`. -/
private def telegramQuestionClick (call callback updateId : Json) : Prog Json := do
  let (apiUrl, botToken) := telegramCredentials call
  Prog.spawn "callTelegramBotApi"
    [apiUrl, botToken, .str "answerCallbackQuery",
     object [("callback_query_id", get callback "id")]]
  let answer ← Prog.effect "parseQuestionButtonId" [get callback "data"]
  let content : Option String :=
    if isTruthy answer then some "[button answer]"
    else
      match get callback "data" with
      | .str data => replyCallbackText data
      | _ => none
  let message := get callback "message"
  let some text := content
    | return ignoreResult (some "unknown callback")
  if !isTruthy message then return ignoreResult (some "unknown callback")
  let chatId := jsString (get (get message "chat") "id")
  let channelOk ← Prog.effect "isAllowedId" [mod call "allowedChannelIds", .str chatId]
  let allowed ←
    if channelOk == .bool true then
      Prog.effect "isAllowedId"
        [mod call "allowedUserIds", .str (jsString (get (get callback "from") "id"))]
    else pure (.bool false)
  if allowed != .bool true then return ignoreResult (some "not allowed")
  Prog.spawn "callTelegramBotApi"
    [apiUrl, botToken, .str "editMessageReplyMarkup",
     object [("chat_id", get (get message "chat") "id"),
       ("message_id", get message "message_id"),
       ("reply_markup", Json.mkObj [("inline_keyboard", .arr #[])])]]
  let parsed ← Prog.effect "transport.parseMessage" [message]
  let envelope ← Prog.effect "telegramEnvelope" [message, parsed, get callback "from"]
  return Json.mkObj
    [("kind", .str "message"), ("redelivers", .bool true),
     ("message", object
       [("eventId", .str s!"tg:{jsString updateId}"),
        ("conversationKey", .str s!"tg:{chatId}"),
        ("channelName", .str "telegram"),
        ("content", .str text),
        ("identity", get envelope "identity"),
        ("source", spread (Json.mkObj []) (get envelope "source")),
        ("answer", if isTruthy answer then answer else undef)])]

/-- `createTelegramChannel`'s `parse`. -/
private def telegramParse (call : Json) : Prog Json := do
  let body ← Prog.effect "parseChannelWebhookBody" [.str "telegram", get (arg call 0) "body"]
  if get body "kind" == .str "ignore" then return body
  let update := get body "payload"
  if isTruthy (get update "callback_query") then
    return ← telegramQuestionClick call (get update "callback_query") (get update "update_id")
  let message ← Prog.effect "extractInboundMessage" [update]
  if !isTruthy message then return ignoreResult none
  let text ← Prog.effect "telegramMessageText" [message]
  if !isTruthy text then
    let media ← Prog.effect "hasTelegramMedia" [message]
    if !isTruthy media then return ignoreResult none
  let chatId := jsString (get (get message "chat") "id")
  let channelOk ← Prog.effect "isAllowedId" [mod call "allowedChannelIds", .str chatId]
  if channelOk != .bool true then return ignoreResult none
  let fromId := get (get message "from") "id"
  let senderId : Json := if isTruthy fromId then .str (jsString fromId) else undef
  let senderOk ← Prog.effect "isAllowedId" [mod call "allowedUserIds", senderId]
  if senderOk != .bool true then return ignoreResult none
  let botUsername := mod call "botUsername"
  let runAgent ←
    if isTruthy botUsername then Prog.effect "addressesTelegramBot" [message, botUsername]
    else pure (.bool true)
  let parsed ← Prog.effect "transport.parseMessage" [message]
  let attachments ← Prog.effect "telegramAttachments"
    [mod call "transport", get message "sticker", parsed]
  let commandToken ← Prog.effect "telegramCommandToken" [message, botUsername]
  let envelope ← Prog.effect "telegramEnvelope" [message, parsed, get message "from"]
  let body ←
    if isTruthy (get message "sticker") then Prog.effect "stickerText" [get message "sticker"]
    else pure (Twin.field parsed "text")
  let content ← Prog.effect "withReplyContext" [body, Twin.field parsed "replyTo"]
  let hasAttachments : Bool := match attachments with
    | .arr items => decide (items.size > 0)
    | _ => false
  return Json.mkObj
    [("kind", .str (if isTruthy runAgent then "message" else "context")),
     ("redelivers", .bool true),
     ("message", object
       [("eventId", .str s!"tg:{jsString (get update "update_id")}"),
        ("conversationKey", .str s!"tg:{chatId}"),
        ("channelName", .str "telegram"),
        ("content", content),
        ("attachments", if hasAttachments then attachments else undef),
        ("identity", get envelope "identity"),
        ("source", spread (get envelope "source") (object [("commandToken", commandToken)]))])]

/-- `createTelegramChannel`'s `authenticate`. -/
private def telegramAuthenticate (call : Json) : Prog Json := do
  let secret := get (get (arg call 0) "headers") "x-telegram-bot-api-secret-token"
  if !isTruthy secret then return .bool false
  let same ← Prog.effect "timingSafeStringEqual" [secret, mod call "webhookSecret"]
  return .bool (same == .bool true)

/-- `createTelegramChannel`'s `canHandle`. -/
private def telegramCanHandle (call : Json) : Prog Json :=
  pure (.bool (hasHeader (arg call 0) "x-telegram-bot-api-secret-token"))

/-- `createTelegramChannel`'s `actions`. -/
private def telegramActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toTelegramSource" [get (arg call 0) "source"]
  let positive : Bool := match get source "chatId" with
    | .num number => decide (0 < number.mantissa)
    | _ => false
  return Json.mkObj
    ([("sendFiles", fnMarker "sendAttachments"), ("sendImages", fnMarker "sendAttachments"),
      ("sendQuestions", fnMarker "sendQuestions"),
      ("sendReplyButtons", fnMarker "sendReplyButtons"),
      ("sendSticker", fnMarker "sendSticker"), ("sendText", fnMarker "sendText"),
      ("sendTyping", fnMarker "sendTyping"), ("supportsReactions", .bool true),
      ("reactToMessage", fnMarker "reactToMessage")] ++
      if positive then [("stream", fnMarker "stream")] else [])

private def threadField (source : Json) : List (String × Json) :=
  optEntry "message_thread_id"
    (if get source "messageThreadId" == undef then none else some (get source "messageThreadId"))

/-- `sendQuestions`. -/
private def telegramSendQuestions (call : Json) : Prog Json := do
  let source := mod call "source"
  let keyboard ← Prog.effect "questionKeyboard" [arg call 0]
  let _ ← Prog.effect "callTelegramBotApi"
    [mod call "apiUrl", mod call "botToken", .str "sendMessage",
     Json.mkObj ([("chat_id", get source "chatId"), ("text", get (arg call 0) "text")] ++
       threadField source ++ [("reply_markup", Json.mkObj [("inline_keyboard", keyboard)])])]
  return undef

/-- `sendReplyButtons`: every chunk but the last is plain, the last carries the buttons. -/
private def telegramSendReplyButtons (call : Json) : Prog Json := do
  let source := mod call "source"
  let text := arg call 0
  let chunks ← Prog.effect "splitTelegramRawText" [text]
  let items := (arr? chunks).getD []
  let last := items.getLast?.getD text
  for chunk in items.dropLast do
    let _ ← Prog.effect "callTelegramBotApi"
      [mod call "apiUrl", mod call "botToken", .str "sendMessage",
       Json.mkObj ([("chat_id", get source "chatId"), ("text", chunk)] ++ threadField source)]
  let labels := (arr? (arg call 1)).getD []
  let buttons := labels.map fun label =>
    Json.mkObj [("text", label), ("callback_data", .str s!"r:{(str? label).getD ""}")]
  let _ ← Prog.effect "callTelegramBotApi"
    [mod call "apiUrl", mod call "botToken", .str "sendMessage",
     Json.mkObj ([("chat_id", get source "chatId"), ("text", last)] ++ threadField source ++
       [("reply_markup", Json.mkObj [("inline_keyboard", jarr [jarr buttons])])])]
  return undef

/-- `TELEGRAM_FILE_ID_PATTERN`, `/^[\w-]+$/`. -/
private def isFileId (value : String) : Bool :=
  !value.isEmpty && value.toList.all fun c =>
    c.isAlphanum && c.toNat < 128 || c == '_' || c == '-'

/-- `sendSticker`: a URL is checked, anything else must be a file id. -/
private def telegramSendSticker (call : Json) : Prog Json := do
  let source := mod call "source"
  let value := jsTrim ((str? (arg call 0)).getD "")
  if (indexOf? value "://").isSome then
    let _ ← Prog.effect "assertTelegramStickerUrl" [.str value]
  else if !isFileId value then
    Prog.throwError "Error"
      "Telegram sendSticker needs a sticker file_id or a public http(s) URL, not a file path"
  let _ ← Prog.effect "callTelegramBotApi"
    [mod call "apiUrl", mod call "botToken", .str "sendSticker",
     Json.mkObj ([("chat_id", get source "chatId"), ("sticker", .str value)] ++ threadField source)]
  return undef

/-- `sendText`: one post per chunk. -/
private def telegramSendText (call : Json) : Prog Json := do
  let source := mod call "source"
  let chunks ← Prog.effect "splitTelegramRawText" [arg call 0]
  for chunk in (arr? chunks).getD [] do
    let _ ← Prog.effect "transport.postMessage"
      [get source "threadId", Json.mkObj [("markdown", chunk)]]
  return undef

/-- `sendTyping`. -/
private def telegramSendTyping (call : Json) : Prog Json :=
  Prog.effect "transport.startTyping" [get (mod call "source") "threadId"]

/-- `reactToMessage`: the default emoji stands in for none. -/
private def telegramReact (call : Json) : Prog Json :=
  let source := mod call "source"
  Prog.effect "transport.addReaction"
    [get source "threadId", get source "messageId", orElse (arg call 0) (mod call "reactionEmoji")]

/-- `rehydrateAttachment`. -/
private def telegramRehydrate (call : Json) : Prog Json :=
  Prog.effect "transport.rehydrateAttachment" [arg call 0]


/-! ### Zalo -/

private def zaloTextLimit : Nat := 2000

/-- `createZaloChannel`'s `parse`. -/
private def zaloParse (call : Json) : Prog Json := do
  let body ← Prog.effect "parseChannelWebhookBody" [.str "zalo", get (arg call 0) "body"]
  if get body "kind" == .str "ignore" then return body
  let update ← Prog.effect "unwrapZaloUpdate" [get body "payload"]
  let eventName :=
    match get update "event_name" with
    | .str name => sliceUnits name 128
    | _ => "missing"
  let missingReason := get (mod call "ZALO_MESSAGE_EVENTS") eventName
  let ignore := fun (reason : String) =>
    Prog.effect "ignoreZaloUpdate" [update, .str reason]
  if !isTruthy missingReason then return ← ignore s!"unsupported_event:{eventName}"
  let message := get update "message"
  let media ← Prog.effect "zaloMessageMedia" [.str eventName, message]
  let chat := get message "chat"
  let chatId := get chat "id"
  let senderId := get (get message "from") "id"
  let messageId := get message "message_id"
  let chatType := get chat "chat_type"
  if !isTruthy messageId then return ← ignore "missing_message_id"
  if !isTruthy chatId then return ← ignore "missing_chat_id"
  if !isTruthy senderId then return ← ignore "missing_sender_id"
  if !isTruthy media then return ← ignore (jsString missingReason)
  let validType ← Prog.effect "isZaloChatType" [chatType]
  if !isTruthy validType then
    return ← ignore s!"unsupported_chat_type:{jsString (orElse chatType (.str "missing"))}"
  if isTruthy (get (get message "from") "is_bot") then return ← ignore "bot_message"
  let channelOk ← Prog.effect "isAllowedId" [mod call "allowedChannelIds", chatId]
  if !isTruthy channelOk then return ← ignore s!"chat_not_allowed:{jsString chatId}"
  let userOk ← Prog.effect "isAllowedId" [mod call "allowedUserIds", senderId]
  if !isTruthy userOk then return ← ignore s!"user_not_allowed:{jsString senderId}"
  let sender := get message "from"
  let senderName := orElse (get sender "display_name") (get sender "name")
  let named : Json := if isTruthy senderName then senderName else undef
  let date := get message "date"
  let attachments := get media "attachments"
  let hasAttachments : Bool := match attachments with
    | .arr items => decide (items.size > 0)
    | _ => false
  return Json.mkObj
    [("kind", .str "message"),
     ("ack", Json.mkObj [("statusCode", toJson (200 : Nat)), ("body", .str "ok")]),
     ("message", object
       [("eventId", .str s!"zalo:{jsString (get update "event_name")}:{jsString chatId}:{jsString senderId}:{jsString messageId}"),
        ("conversationKey", .str s!"zalo:{jsString chatId}"),
        ("channelName", .str "zalo"),
        ("content", get media "text"),
        ("attachments", if hasAttachments then attachments else undef),
        ("identity", object [("channelId", chatId), ("userId", senderId), ("userName", named)]),
        ("source", object
          [("chatId", chatId), ("chatType", chatType), ("messageId", messageId),
           ("senderId", senderId), ("eventName", .str eventName), ("senderName", named),
           ("date", match date with | .num _ => date | _ => undef)])])]

/-- `createZaloChannel`'s `authenticate`. -/
private def zaloAuthenticate (call : Json) : Prog Json := do
  let secret := get (get (arg call 0) "headers") "x-bot-api-secret-token"
  if secret == undef then return .bool false
  let same ← Prog.effect "timingSafeStringEqual" [secret, mod call "webhookSecret"]
  return .bool (same == .bool true)

/-- `createZaloChannel`'s `canHandle`. -/
private def zaloCanHandle (call : Json) : Prog Json :=
  pure (.bool (get (arg call 0) "method" == .str "POST"))

/-- `sendImages`: one photo per image, the caption on the first. -/
private def zaloSendImages (call : Json) : Prog Json := do
  let chatId := get (mod call "source") "chatId"
  let caption := arg call 1
  let mut index := 0
  for image in (arr? (arg call 0)).getD [] do
    let photo ← Prog.effect "zaloHttpUrl" [get image "url"]
    if !isTruthy photo then
      Prog.throwError "Error"
        "Zalo sendPhoto needs an absolute http(s) image URL that Zalo can fetch"
    let withCaption := isTruthy caption && index == 0
    let _ ← Prog.effect "callZaloApi"
      [mod call "botToken", .str "sendPhoto",
       object [("chat_id", chatId), ("photo", photo),
         ("caption", if withCaption then .str (sliceUnits ((str? caption).getD "") zaloTextLimit) else undef)]]
    index := index + 1
  return undef

/-- `sendSticker`. -/
private def zaloSendSticker (call : Json) : Prog Json := do
  let value := jsTrim ((str? (arg call 0)).getD "")
  if value.isEmpty then Prog.throwError "Error" "Zalo sendSticker needs a sticker id or name"
  let _ ← Prog.effect "callZaloApi"
    [mod call "botToken", .str "sendSticker",
     Json.mkObj [("chat_id", get (mod call "source") "chatId"), ("sticker", .str value)]]
  return undef

/-- `sendText`: one message per chunk. -/
private def zaloSendText (call : Json) : Prog Json := do
  let chunks ← Prog.effect "chunkChannelText" [arg call 0, toJson zaloTextLimit]
  for chunk in (arr? chunks).getD [] do
    let _ ← Prog.effect "callZaloApi"
      [mod call "botToken", .str "sendMessage",
       Json.mkObj [("chat_id", get (mod call "source") "chatId"), ("text", chunk)]]
  return undef


/-! ### Discord -/

private def discordGatewayHeader : String := "x-discord-gateway-token"

private def jsonResponse (status : Nat) (body : Option String) : Json :=
  Json.mkObj
    [("kind", .str "response"),
     ("response", Json.mkObj
       ([("statusCode", toJson status),
         ("headers", Json.mkObj [("Content-Type", .str "application/json")])] ++
        optEntry "body" (body.map Json.str)))]

/-- The `type: 4` ephemeral reply an interaction gets when it is refused. -/
private def ephemeralReply (content : String) : Json :=
  jsonResponse 200 (some s!"\{\"type\":4,\"data\":\{\"content\":\"{content}\",\"flags\":64}}")

private def stripSlash (command : String) : String :=
  (stripPrefix? command "/").getD command

/-- `createDiscordChannel`'s `parse`. -/
private def discordParse (call : Json) : Prog Json := do
  let req := arg call 0
  let body ← Prog.effect "parseChannelWebhookBody" [.str "discord", get req "body"]
  if get body "kind" == .str "ignore" then return body
  let payload := get body "payload"
  let gatewayEvent ← Prog.effect "parseForwardedGatewayEvent"
    [mod call "discord", payload, mod call "allowedChannelIds", mod call "allowedUserIds",
     mod call "options"]
  if isTruthy gatewayEvent then return gatewayEvent
  let unsupported := fun (_ : Unit) => Prog.effect "unsupportedInteractionResponse"
  if hasHeader req discordGatewayHeader then return ← unsupported ()
  if get payload "type" == toJson (1 : Nat) then
    return jsonResponse 200 (some "{\"type\":1}")
  if get payload "type" == toJson (0 : Nat) then return jsonResponse 204 none
  if get payload "type" != toJson (2 : Nat) || !isTruthy (get payload "id") ||
      !isTruthy (get payload "token") || !isTruthy (get payload "application_id") ||
      !isTruthy (get payload "channel_id") || !isTruthy (get (get payload "data") "name") then
    return ← unsupported ()
  if !isTruthy (get payload "guild_id") then return ephemeralReply "Discord DMs are disabled."
  let interactionUser := orElse (get (get (get payload "member") "user") "id")
    (get (get payload "user") "id")
  let userOk ← Prog.effect "isAllowedId" [mod call "allowedUserIds", interactionUser]
  if !isTruthy userOk then return ephemeralReply "You are not allowed here."
  let thread ← Prog.effect "toDiscordInteractionThread" [payload]
  let channelOk ← Prog.effect "isAllowedId" [mod call "allowedChannelIds", get thread "channelId"]
  if !isTruthy channelOk then return ephemeralReply "This channel is not allowed."
  let data := get payload "data"
  let command ← Prog.effect "discord.parseCommand" [get data "name", get data "options"]
  let resolved ← Prog.effect "resolveDiscordCommand"
    [.str (stripSlash ((str? (get command "command")).getD "")), get command "text"]
  if !isTruthy resolved then return ← unsupported ()
  let threadId ← Prog.effect "discord.encodeThreadId" [thread]
  let withThread := if isTruthy (get thread "threadId") then threadId else undef
  let token := get resolved "commandToken"
  let source := object
    [("applicationId", get payload "application_id"), ("interactionToken", get payload "token"),
     ("interactionId", get payload "id"), ("guildId", get payload "guild_id"),
     ("channelId", get thread "channelId"), ("threadId", withThread),
     ("commandToken", if isTruthy token then token else undef),
     ("userId", interactionUser)]
  let contentText := get resolved "contentText"
  return Json.mkObj
    [("kind", .str "message"),
     ("ack", Json.mkObj
       [("statusCode", toJson (200 : Nat)),
        ("headers", Json.mkObj [("Content-Type", .str "application/json")]),
        ("body", .str "{\"type\":5}")]),
     ("message", Json.mkObj
       [("eventId", .str s!"discord:{jsString (get payload "id")}"),
        ("conversationKey", threadId), ("channelName", .str "discord"),
        ("content", if isTruthy contentText then
          jarr [Json.mkObj [("type", .str "text"), ("text", contentText)]] else jarr []),
        ("identity", object
          [("workspaceRef", get payload "guild_id"), ("channelId", get thread "channelId"),
           ("threadId", if isTruthy (get thread "threadId") then get thread "threadId" else undef),
           ("userId", if isTruthy interactionUser then interactionUser else undef)]),
        ("source", source)])]

/-- `createDiscordChannel`'s `authenticate`: the forwarder token, else the interaction signature. -/
private def discordAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let headers := get req "headers"
  if hasHeader req discordGatewayHeader then
    let provided := get headers discordGatewayHeader
    if !isString provided then return .bool false
    let token ← Prog.effect "discordForwarderToken" [mod call "botToken"]
    return ← Prog.effect "timingSafeStringEqual" [provided, token]
  Prog.effect "discord.verifyRequestSignature"
    [get req "body", get headers "x-signature-ed25519", get headers "x-signature-timestamp"]

/-- `createDiscordChannel`'s `actions`. -/
private def discordActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toDiscordSource" [get (arg call 0) "source"]
  Prog.effect "createDiscordActions"
    [mod call "botToken", mod call "publicKey", source, mod call "apiUrl"]

/-- `/^\d+$/`. -/
private def isDigits (value : String) : Bool :=
  !value.isEmpty && value.toList.all fun c => '0' ≤ c && c ≤ '9'

/-- `sendSticker`: a numeric id posted straight to the channel or thread. -/
private def discordSendSticker (call : Json) : Prog Json := do
  let value := jsTrim ((str? (arg call 0)).getD "")
  if !isDigits value then Prog.throwError "Error" "Discord sendSticker needs a numeric sticker id"
  let decoded ← Prog.effect "discord.decodeThreadId" [mod call "threadId"]
  let target := orElse (get decoded "threadId") (get decoded "channelId")
  if !isTruthy target then Prog.throwError "Error" "Discord sendSticker needs a channel to post in"
  let _ ← Prog.effect "callDiscordApi"
    [mod call "apiUrl", mod call "botToken", .str s!"channels/{jsString target}/messages",
     Json.mkObj [("sticker_ids", jarr [.str value])]]
  return undef

/-- `sendText`: inside the slash-command context when there is one, else straight to the thread. -/
private def discordSendText (call : Json) : Prog Json := do
  let source := mod call "source"
  let threadId := mod call "threadId"
  let post := fun (_ : Unit) =>
    Prog.effect "discord.postMessage" [threadId, Json.mkObj [("markdown", arg call 0)]]
  if !isTruthy (get source "interactionToken") then
    let _ ← post ()
    return undef
  let outcome ← Prog.attempt "discord.runWithSlashCommandContext"
    [Json.mkObj [("channelId", threadId), ("interactionToken", get source "interactionToken"),
       ("initialResponseSent", .bool false)], fnMarker ""]
  match outcome with
  | .ok _ => return undef
  | .threw error _ =>
    if isTruthy (get source "channelId") then
      let _ ← post ()
      return undef
    Prog.fail error
  | .pending => Prog.fail (Json.mkObj [("pending", .bool true)])

/-- `sendTyping`. -/
private def discordSendTyping (call : Json) : Prog Json := do
  if !isTruthy (get (mod call "source") "channelId") then return undef
  let _ ← Prog.effect "discord.startTyping" [mod call "threadId"]
  return undef

/-- `reactToMessage`: only a message with an id can be reacted to. -/
private def discordReact (call : Json) : Prog Json := do
  let messageId := get (mod call "source") "messageId"
  if !isString messageId then return undef
  let _ ← Prog.effect "discord.addReaction"
    [mod call "threadId", messageId, orElse (arg call 0) (.str "eyes")]
  return undef


/-! ### GitHub -/

private def textResponse (body : String) : Json :=
  Json.mkObj
    [("kind", .str "response"),
     ("response", Json.mkObj
       [("statusCode", toJson (200 : Nat)),
        ("headers", Json.mkObj [("Content-Type", .str "text/plain; charset=utf-8")]),
        ("body", .str body)])]

/-- `createGitHubChannel`'s `parse`: filter the delivery, then hand it to the parser for its event. -/
private def githubParse (call : Json) : Prog Json := do
  let req := arg call 0
  let headers := get req "headers"
  let event := get headers "x-github-event"
  let deliveryId := get headers "x-github-delivery"
  let body ← Prog.effect "parseChannelWebhookBody" [.str "github", get req "body"]
  if get body "kind" == .str "ignore" then return body
  let payload := get body "payload"
  if event == .str "ping" then return textResponse "ok"
  let repository := get payload "repository"
  let fullName := get repository "full_name"
  let owner := get (get repository "owner") "login"
  let repo := get repository "name"
  if !isTruthy event || !isTruthy deliveryId || !isTruthy fullName || !isTruthy owner ||
      !isTruthy repo then
    return ignoreResult none
  let channelOk ← Prog.effect "isAllowedId" [mod call "allowedChannelIds", fullName]
  if !isTruthy channelOk then return ignoreResult none
  let senderOk ← Prog.effect "isAllowedId"
    [mod call "allowedUserIds", get (get payload "sender") "login"]
  if !isTruthy senderOk then return ignoreResult none
  let github := mod call "github"
  let botUserName := mod call "botUserName"
  let delivery := [payload, deliveryId, owner, repo, fullName]
  let credentials := object
    [("apiUrl", mod call "apiUrl"), ("appId", mod call "appId"),
     ("privateKey", mod call "privateKey"), ("botUserName", botUserName)]
  match event with
  | .str "issues" =>
    Prog.effect "parseIssuesEvent" ([github] ++ delivery ++ [mod call "options", botUserName])
  | .str "issue_comment" =>
    Prog.effect "parseIssueCommentEvent" ([github] ++ delivery ++ [credentials])
  | .str "pull_request" =>
    Prog.effect "parsePullRequestEvent" ([github] ++ delivery ++ [mod call "options", botUserName])
  | .str "pull_request_review_comment" =>
    Prog.effect "parseReviewCommentEvent" ([github] ++ delivery ++ [credentials])
  | _ => pure (ignoreResult none)

/-- `createGitHubChannel`'s `authenticate`. -/
private def githubAuthenticate (call : Json) : Prog Json :=
  Prog.effect "github.verifyWebhookSignature"
    [get (arg call 0) "body", get (get (arg call 0) "headers") "x-hub-signature-256"]

/-- `createGitHubChannel`'s `actions`. -/
private def githubActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toGitHubSource" [get (arg call 0) "source"]
  Prog.effect "createGitHubActions"
    [mod call "appId", mod call "privateKey", source, mod call "apiUrl"]

/-- `createGitHubActions`' `reactToMessage`. -/
private def githubReact (call : Json) : Prog Json := do
  let source := mod call "source"
  if !isTruthy (get source "messageId") then return undef
  let _ ← Prog.effect "github.addReaction"
    [get source "threadId", get source "messageId", orElse (arg call 0) (.str "eyes")]
  return undef

/-- `createGitHubRestClient`'s `get`: an authenticated GET that must answer 2xx. -/
private def githubGet (call : Json) : Prog Json := do
  let path := jsString (arg call 0)
  let response ← Prog.effect "request"
    [.str s!"{jsString (mod call "baseApiUrl")}{path}",
     Json.mkObj [("method", .str "GET"),
       ("headers", Json.mkObj
         [("Accept", .str "application/vnd.github+json"),
          ("Authorization", .str s!"Bearer {jsString (mod call "token")}"),
          ("X-GitHub-Api-Version", .str "2022-11-28")])]]
  let status := get (get response "$response") "status"
  let ok := match status with
    | .num number => numGe number 200 && !numGe number 300
    | _ => false
  if !ok then Prog.throwError "Error" s!"GitHub GET {path} failed ({jsString status})"
  Prog.effect "response.json"


/-! ### Linear -/

private def linearContextTag : String := "linear_issue_context"

/-- `createLinearChannel`'s `parse`: a new comment that mentions the bot, from another member. -/
private def linearParse (call : Json) : Prog Json := do
  let body ← Prog.effect "parseChannelWebhookBody" [.str "linear", get (arg call 0) "body"]
  if get body "kind" == .str "ignore" then return body
  let payload := get body "payload"
  if get payload "type" != .str "Comment" || get payload "action" != .str "create" then
    return ignoreResult (some "not a new comment")
  let comment := get payload "data"
  let issue := get comment "issue"
  let user := get comment "user"
  if !isTruthy (get comment "issueId") || !isTruthy issue || !isTruthy user ||
      isTruthy (get comment "botActor") then
    return ignoreResult (some "not a member comment on an issue")
  let options := mod call "options"
  let mentioned ← Prog.effect "mentions" [get comment "body", get options "userName"]
  if !isTruthy mentioned then return ignoreResult (some "not mentioned")
  let identity ← Prog.effect "transport.loadIdentity"
  if get user "id" == identity then return ignoreResult (some "own comment")
  let teamKey := get (get issue "team") "key"
  let teamOk ← Prog.effect "isAllowedId" [get options "allowedChannelIds", teamKey]
  if !isTruthy teamOk then return ignoreResult (some "not allowed")
  let userOk ← Prog.effect "isAllowedId" [get options "allowedUserIds", get user "id"]
  if !isTruthy userOk then return ignoreResult (some "not allowed")
  let threadId ← Prog.effect "transport.encodeThreadId"
    [Json.mkObj [("issueId", get comment "issueId"),
      ("commentId", orElse (get comment "parentId") (get comment "id"))]]
  let text := jsTrim ((str? (get comment "body")).getD "")
  let context ← Prog.effect "formatIssueContext" [issue]
  return Json.mkObj
    [("kind", .str "message"), ("redelivers", .bool true),
     ("ack", Json.mkObj [("statusCode", toJson (200 : Nat))]),
     ("message", object
       [("eventId", .str s!"linear:{jsString (get comment "id")}"),
        ("conversationKey", threadId), ("channelName", .str "linear"), ("content", .str text),
        ("events", jarr
          [Json.mkObj [("role", .str "system"), ("content", context), ("persist", .bool false)],
           Json.mkObj [("role", .str "user"),
             ("content", jarr [Json.mkObj [("type", .str "text"), ("text", .str text)]])]]),
        ("identity", object
          [("workspaceRef", get payload "organizationId"), ("channelId", teamKey),
           ("threadId", get issue "identifier"), ("userId", get user "id"),
           ("userName", get user "name")]),
        ("source", object
          [("commentId", get comment "id"), ("issueId", get comment "issueId"),
           ("threadId", threadId)])])]

/-- `createLinearChannel`'s `authenticate`: the signed body's own timestamp is what is verified. -/
private def linearAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let signature := get (get req "headers") "linear-signature"
  let timestamp ← Prog.effect "webhookTimestamp" [req]
  if !isTruthy signature || timestamp == undef then return .bool false
  let verified ← Prog.attempt "webhooks.verify"
    [bufferOf ((str? (get req "body")).getD ""), signature, timestamp]
  match verified with
  | .ok value => return value
  | _ => return .bool false

/-- `createLinearChannel`'s `canHandle`. -/
private def linearCanHandle (call : Json) : Prog Json :=
  pure (.bool (hasHeader (arg call 0) "linear-signature"))

/-- `createLinearChannel`'s `actions`. -/
private def linearActions (call : Json) : Prog Json := do
  let _ ← Prog.effect "toLinearSource" [get (arg call 0) "source"]
  return Json.mkObj
    [("sendText", fnMarker "sendText"), ("sendTyping", fnMarker "sendTyping"),
     ("supportsReactions", .bool true), ("reactToMessage", fnMarker "reactToMessage")]

/-- `sendText`: the identity is loaded before the first post. -/
private def linearSendText (call : Json) : Prog Json := do
  let _ ← Prog.effect "transport.loadIdentity"
  let _ ← Prog.effect "transport.postMessage"
    [get (mod call "source") "threadId", Json.mkObj [("markdown", arg call 0)]]
  return undef


/-! ### Meta (Messenger, Instagram) -/

/-- `URLSearchParams.get` on the `{"$params": [[key, value], ...]}` that `handshakeParams` returns. -/
private def paramValue (params : Json) (key : String) : Option Json :=
  ((arr? (get params "$params")).getD []).findSome? fun pair =>
    if Twin.arg pair 0 == .str key then some (Twin.arg pair 1) else none

private def metaSignatureHeader : String := "x-hub-signature-256"

/-- `createMetaChannel`'s `canHandle`: a handshake GET, or a POST carrying the signature. -/
private def metaCanHandle (call : Json) : Prog Json := do
  let req := arg call 0
  if get req "method" == .str "GET" then
    let params ← Prog.effect "handshakeParams" [req]
    return .bool (paramValue params "hub.mode").isSome
  return .bool (hasHeader req metaSignatureHeader)

/-- `createMetaChannel`'s `authenticate`: the verify token on a GET, else the body's HMAC. -/
private def metaAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let options := mod call "options"
  if get req "method" == .str "GET" then
    let params ← Prog.effect "handshakeParams" [req]
    let token := paramValue params "hub.verify_token"
    if paramValue params "hub.mode" != some (.str "subscribe") then return .bool false
    let some token := token | return .bool false
    if token == .null then return .bool false
    return ← Prog.effect "timingSafeStringEqual" [token, get options "verifyToken"]
  let signature := get (get req "headers") metaSignatureHeader
  let _ ← Prog.effect "createHmac" [.str "sha256", get options "appSecret"]
  let _ ← Prog.effect "createHmac(\"sha256\", options.appSecret) .update" [get req "body", .str "utf8"]
  let digest ← Prog.effect
    "createHmac(\"sha256\", options.appSecret) .update(req.body, \"utf8\") .digest" [.str "hex"]
  let expected := Json.str s!"sha256={jsString digest}"
  if signature == undef then return .bool false
  let same ← Prog.effect "timingSafeStringEqual" [signature, expected]
  return .bool (isTruthy same)

/-- `createMetaChannel`'s `parse`: the events addressed to this owner, one result or a batch. -/
private def metaParse (call : Json) : Prog Json := do
  let req := arg call 0
  let options := mod call "options"
  if get req "method" == .str "GET" then
    let params ← Prog.effect "handshakeParams" [req]
    return Json.mkObj
      [("kind", .str "response"), ("reason", .str "subscription handshake"),
       ("response", Json.mkObj
         [("statusCode", toJson (200 : Nat)),
          ("headers", Json.mkObj [("content-type", .str "text/plain")]),
          ("body", orElse ((paramValue params "hub.challenge").getD .null) (.str ""))])]
  let body ← Prog.effect "parseChannelWebhookBody" [mod call "name", get req "body"]
  if get body "kind" == .str "ignore" then return body
  let payload := get body "payload"
  if get payload "object" != get options "object" then
    return ignoreResult (some "not a messaging subscription")
  let events ← Prog.effect "messageEvents" [payload]
  let found := (arr? events).getD []
  if found.isEmpty then return ignoreResult (some "no message")
  let ownerId ← Prog.effect "options.ownerId"
  let mut results : List Json := []
  for entry in found do
    if get entry "recipientId" == ownerId then
      results := results ++ [← Prog.effect "parseEvent" [options, entry]]
  let messages := results.filter fun result => get result "kind" == .str "message"
  if messages.length > 1 then
    return Json.mkObj [("kind", .str "batch"), ("results", jarr messages)]
  match messages.head?, results.head? with
  | some message, _ => return message
  | none, some first => return first
  | none, none => return ignoreResult (some "no message for this owner")

/-- `createMetaChannel`'s `actions`. -/
private def metaActions (call : Json) : Prog Json := do
  let _ ← Prog.effect "toMetaSource" [mod call "name", get (arg call 0) "source"]
  let attachments :=
    if isTruthy (get (mod call "options") "postsAttachments") then
      [("sendFiles", fnMarker "sendAttachments"), ("sendImages", fnMarker "sendAttachments")]
    else []
  return Json.mkObj
    (attachments ++ [("sendText", fnMarker "sendText"), ("sendTyping", fnMarker "sendTyping"),
      ("reactToMessage", fnMarker "reactToMessage")])

/-- `sendText`: one post per chunk. -/
private def metaSendText (call : Json) : Prog Json := do
  let chunks ← Prog.effect "splitMetaText" [arg call 0, get (mod call "options") "textLimit"]
  for chunk in (arr? chunks).getD [] do
    let _ ← Prog.effect "transport.postMessage"
      [get (mod call "source") "threadId", Json.mkObj [("markdown", chunk)]]
  return undef

/-- `sendTyping`. -/
private def metaSendTyping (call : Json) : Prog Json :=
  Prog.effect "transport.startTyping" [get (mod call "source") "threadId"]


/-! ### Messenger -/

/-- `createMessengerChannel`'s `ownerId`: the page id, looked up once per access token. -/
private def messengerOwnerId (call : Json) : Prog Json := do
  let token := get (mod call "options") "pageAccessToken"
  let entries := (arr? (get (mod call "pageIds") "$map")).getD []
  match entries.find? (fun entry => Twin.arg entry 0 == token) with
  | some entry => return Twin.resolved (Twin.arg entry 1)
  | none =>
    let lookup ← Prog.effect "transport.pageId"
    let pending := Json.mkObj
      [("$opaque", .str "Promise"), ("$fields", Json.mkObj [("$resolved", lookup)])]
    Prog.setState "module.pageIds"
      (Json.mkObj [("$map", jarr (entries ++ [jarr [token, pending]]))])
    return lookup

/-! ### WhatsApp -/

/-- `createWhatsAppChannel`'s `canHandle`. -/
private def whatsappCanHandle (call : Json) : Prog Json := do
  let req := arg call 0
  if get req "method" == .str "GET" then
    let params ← Prog.effect "handshakeParams" [req]
    return .bool (paramValue params "hub.mode").isSome
  return .bool (hasHeader req "x-hub-signature-256")

/-- `createWhatsAppChannel`'s `authenticate`: the verify token on a GET, else the SDK's HMAC check. -/
private def whatsappAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  if get req "method" == .str "GET" then
    let params ← Prog.effect "handshakeParams" [req]
    if paramValue params "hub.mode" != some (.str "subscribe") then return .bool false
    let some token := paramValue params "hub.verify_token" | return .bool false
    if token == .null then return .bool false
    return ← Prog.effect "timingSafeStringEqual" [token, get (mod call "options") "verifyToken"]
  let valid ← Prog.effect "transport.verifyWebhookSignature"
    [get req "body", get (get req "headers") "x-hub-signature-256"]
  return .bool (isTruthy valid)

/-- `createWhatsAppChannel`'s `parse`. -/
private def whatsappParse (call : Json) : Prog Json := do
  let req := arg call 0
  let options := mod call "options"
  if get req "method" == .str "GET" then
    let params ← Prog.effect "handshakeParams" [req]
    return Json.mkObj
      [("kind", .str "response"), ("reason", .str "subscription handshake"),
       ("response", Json.mkObj
         [("statusCode", toJson (200 : Nat)),
          ("headers", Json.mkObj [("content-type", .str "text/plain")]),
          ("body", orElse ((paramValue params "hub.challenge").getD .null) (.str ""))])]
  let body ← Prog.effect "parseChannelWebhookBody" [.str "whatsapp", get req "body"]
  if get body "kind" == .str "ignore" then return body
  let inbound ← Prog.effect "findInboundMessages"
    [get body "payload", get options "phoneNumberId"]
  let mut results : List Json := []
  for item in (arr? inbound).getD [] do
    results := results ++ [← Prog.effect "parseInbound" [item, mod call "transport", options]]
  let messages := results.filter fun result => get result "kind" == .str "message"
  if messages.length > 1 then
    return Json.mkObj [("kind", .str "batch"), ("results", jarr messages)]
  match messages.head?, results.head? with
  | some message, _ => return message
  | none, some first => return first
  | none, none => return ignoreResult (some "no message for this number")

/-- `createWhatsAppChannel`'s `actions`. -/
private def whatsappActions (call : Json) : Prog Json := do
  let _ ← Prog.effect "toWhatsAppSource" [get (arg call 0) "source"]
  return Json.mkObj
    [("sendFiles", fnMarker "sendAttachments"), ("sendImages", fnMarker "sendAttachments"),
     ("sendText", fnMarker "sendText"), ("sendTyping", fnMarker "sendTyping"),
     ("supportsReactions", .bool true), ("reactToMessage", fnMarker "reactToMessage")]

/-- `sendTyping`: the typing indicator also marks the message read. -/
private def whatsappSendTyping (call : Json) : Prog Json :=
  Prog.effect "transport.sendTypingIndicator" [get (mod call "source") "messageId"]

/-- `reactToMessage`: only an explicit emoji reacts. -/
private def whatsappReact (call : Json) : Prog Json := do
  if !isTruthy (arg call 0) then return undef
  let source := mod call "source"
  let _ ← Prog.effect "transport.addReaction"
    [get source "threadId", get source "messageId", arg call 0]
  return undef


/-! ### Twilio -/

/-- `createTwilioChannel`'s `canHandle`: a signed POST, for this number when the account has one. -/
private def twilioCanHandle (call : Json) : Prog Json := do
  let req := arg call 0
  if get req "method" != .str "POST" || !hasHeader req "x-twilio-signature" then
    return .bool false
  let payload ← Prog.effect "readTwilioForm" [get req "body"]
  let phone := get (mod call "options") "phoneNumber"
  return .bool (get payload "kind" != .str "text" || !isTruthy phone || get payload "to" == phone)

/-- Header names in the order `new Headers(...)` iterates them: lowercase, sorted. -/
private def sortedHeaders (headers : Json) : Json :=
  let lowered := (entries headers).filter (fun entry => entry.1 != "$keys") |>.map fun entry =>
    (entry.1.toLower, entry.2)
  let sorted := lowered.toArray.qsort (fun a b => a.1 < b.1)
  jarr (sorted.toList.map fun entry => jarr [.str entry.1, entry.2])

/-- `createTwilioChannel`'s `authenticate`: Twilio signs the public URL it called. -/
private def twilioAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let options := mod call "options"
  let base := get options "publicBaseUrl"
  let query := get req "rawQueryString"
  let derived : Json :=
    if isTruthy base then
      .str s!"{jsString base}{jsString (get req "rawPath")}{if isTruthy query then "?" ++ jsString query else ""}"
    else undef
  let url := orElse (get options "webhookUrl") derived
  if !isTruthy url then return .bool false
  let outcome ← Prog.attempt "verifyTwilioRequest"
    [Json.mkObj [("$request", Json.mkObj
       [("method", .str "POST"), ("url", url), ("headers", sortedHeaders (get req "headers"))])],
     Json.mkObj [("authToken", get options "authToken"), ("webhookUrl", url)]]
  match outcome with
  | .ok _ => return .bool true
  | .threw error _ =>
    if get (get error "$error") "name" == .str "TwilioWebhookVerificationError" then
      return .bool false
    Prog.fail error
  | .pending => Prog.fail (Json.mkObj [("pending", .bool true)])

private def twimlEmpty (call : Json) : Json := mod call "TWIML_EMPTY"

/-- `createTwilioChannel`'s `parse`. -/
private def twilioParse (call : Json) : Prog Json := do
  let options := mod call "options"
  let payload ← Prog.effect "readTwilioForm" [get (arg call 0) "body"]
  let ignore := fun (reason : String) =>
    Json.mkObj [("kind", .str "ignore"), ("reason", .str reason), ("response", twimlEmpty call)]
  if get payload "kind" != .str "text" then
    return ignore s!"unsupported:{jsString (get payload "kind")}"
  if !isTruthy (get payload "messageSid") then return ignore "missing_message_sid"
  let channelOk ← Prog.effect "isAllowedId" [get options "allowedChannelIds", get payload "from"]
  let allowed ←
    if isTruthy channelOk then
      Prog.effect "isAllowedId" [get options "allowedUserIds", get payload "from"]
    else pure (.bool false)
  if !isTruthy allowed then return ignore "not allowed"
  let parsed ← Prog.effect "transport.parseMessage" [payload]
  let attachments := Twin.field parsed "attachments"
  let hasAttachments : Bool := match attachments with
    | .arr items => decide (items.size > 0)
    | _ => false
  if !isTruthy (Twin.field parsed "text") && !hasAttachments then return ignore "empty"
  return Json.mkObj
    [("kind", .str "message"), ("ack", twimlEmpty call),
     ("message", object
       [("eventId", .str s!"twilio:{jsString (get payload "messageSid")}"),
        ("conversationKey", Twin.field parsed "threadId"), ("channelName", .str "twilio"),
        ("content", Twin.field parsed "text"),
        ("attachments", if hasAttachments then attachments else undef),
        ("identity", object [("channelId", get payload "from"), ("userId", get payload "from")]),
        ("source", object
          [("from", get payload "from"), ("messageSid", get payload "messageSid"),
           ("to", get payload "to")])])]

/-- `createTwilioChannel`'s `actions`. -/
private def twilioActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toTwilioSource" [get (arg call 0) "source"]
  let _ ← Prog.effect "transport.encodeThreadId"
    [Json.mkObj [("recipient", get source "from"),
      ("sender", orElse (get (mod call "options") "messagingServiceSid") (get source "to"))]]
  return Json.mkObj
    [("sendText", fnMarker "sendText"), ("sendImages", fnMarker "sendImages"),
     ("sendTyping", fnMarker "sendTyping"), ("reactToMessage", fnMarker "reactToMessage")]

/-- `sendText`: one raw message per rendered chunk. -/
private def twilioSendText (call : Json) : Prog Json := do
  let chunks ← Prog.effect "renderTwilioText" [arg call 0]
  for chunk in (arr? chunks).getD [] do
    let _ ← Prog.effect "transport.postMessage"
      [mod call "threadId", Json.mkObj [("raw", chunk)]]
  return undef


/-! ### Teams -/

/-- `createTeamsChannel`'s `authenticate`: a bearer token that names the activity's service URL. -/
private def teamsAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let header := get (get req "headers") "authorization"
  let body ← Prog.effect "parseChannelWebhookBody" [.str "teams", get req "body"]
  let token := match header with
    | .str text => stripPrefix? text "Bearer "
    | _ => none
  let some token := token | return .bool false
  if get body "kind" == .str "ignore" then return .bool false
  let serviceUrl := get (get body "payload") "serviceUrl"
  if !isTruthy serviceUrl then return .bool false
  let _ ← Prog.effect "tokenValidator" [get (mod call "options") "appId"]
  let claims ← Prog.effect "tokenValidator(options.appId).validateAccessToken"
    [.str token, Json.mkObj [("validateServiceUrl",
      Json.mkObj [("expectedServiceUrl", serviceUrl)])]]
  return .bool (isTruthy claims)

/-- `createTeamsChannel`'s `parse`. -/
private def teamsParse (call : Json) : Prog Json := do
  let options := mod call "options"
  let body ← Prog.effect "parseChannelWebhookBody" [.str "teams", get (arg call 0) "body"]
  if get body "kind" == .str "ignore" then return body
  let activity := get body "payload"
  if get activity "channelId" != .str "msteams" then
    return ignoreResult (some s!"not_teams:{jsString (orElse (get activity "channelId") (.str "unknown"))}")
  let conversationId := get (get activity "conversation") "id"
  if get activity "type" != .str "message" || !isTruthy conversationId then
    return ignoreResult (some s!"activity:{jsString (get activity "type")}")
  let fromId := get (get activity "from") "id"
  if isTruthy fromId && fromId == get (get activity "recipient") "id" then
    return ignoreResult (some "own message")
  let identity ← Prog.effect "teamsIdentity" [activity, conversationId]
  let channelOk ← Prog.effect "isAllowedId"
    [get options "allowedChannelIds", get identity "channelId"]
  let allowed ←
    if isTruthy channelOk then
      Prog.effect "isAllowedId" [get options "allowedUserIds", get identity "userId"]
    else pure (.bool false)
  if !isTruthy allowed then return ignoreResult (some "not allowed")
  let text ← Prog.effect "withoutBotMention" [activity]
  let parsed ← Prog.effect "transport.parseMessage" [setField activity "text" text]
  let attachments := Twin.field parsed "attachments"
  let hasAttachments : Bool := match attachments with
    | .arr items => decide (items.size > 0)
    | _ => false
  if !isTruthy (Twin.field parsed "text") && !hasAttachments then
    return ignoreResult (some "empty message")
  let message ← Prog.effect "toInboundMessage" [conversationId, parsed, identity]
  return Json.mkObj [("kind", .str "message"), ("message", message)]

/-- `createTeamsChannel`'s `actions`. -/
private def teamsActions (call : Json) : Prog Json := do
  let _ ← Prog.effect "toTeamsSource" [get (arg call 0) "source"]
  return Json.mkObj
    [("sendText", fnMarker "sendText"), ("sendTyping", fnMarker "sendTyping"),
     ("reactToMessage", fnMarker "reactToMessage")]


/-! ### Google Chat -/

/-- `createGoogleChatChannel`'s `authenticate`: the SDK answers 200 only for a token Google signed. -/
private def gchatAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let header := orElse (get (get req "headers") "authorization") (.str "")
  let response ← Prog.effect "transport.handleWebhook"
    [Json.mkObj [("$request", Json.mkObj
       [("method", .str "POST"),
        ("url", .str s!"https://core.invalid{jsString (get req "rawPath")}"),
        ("headers", jarr [jarr [.str "authorization", header]])])]]
  return .bool (get (get response "$response") "status" == toJson (200 : Nat))

/-- `createGoogleChatChannel`'s `parse`. -/
private def gchatParse (call : Json) : Prog Json := do
  let options := mod call "options"
  let body ← Prog.effect "parseChannelWebhookBody" [.str "gchat", get (arg call 0) "body"]
  if get body "kind" == .str "ignore" then return body
  let event ← Prog.effect "addOnEvent" [get body "payload"]
  let payload := get (get event "chat") "messagePayload"
  if !isTruthy event || !isTruthy payload then return ignoreResult (some "not a message")
  let message := get payload "message"
  if get (get message "sender") "type" == .str "BOT" then
    return ignoreResult (some "bot message")
  let identity ← Prog.effect "googleChatIdentity" [get payload "space", message]
  let channelOk ← Prog.effect "isAllowedId"
    [get options "allowedChannelIds", get identity "channelId"]
  let allowed ←
    if isTruthy channelOk then
      Prog.effect "isAllowedId" [get options "allowedUserIds", get identity "userId"]
    else pure (.bool false)
  if !isTruthy allowed then return ignoreResult (some "not allowed")
  let parsed ← Prog.effect "transport.parseMessage" [event]
  let text := jsTrim (jsString (orElse (get message "argumentText") (Twin.field parsed "text")))
  let attachments := Twin.field parsed "attachments"
  let hasAttachments : Bool := match attachments with
    | .arr items => decide (items.size > 0)
    | _ => false
  if text.isEmpty && !hasAttachments then return ignoreResult (some "empty message")
  let threadName := get identity "threadId"
  let threadId ← Prog.effect "transport.encodeThreadId"
    [Json.mkObj ([("spaceName", get identity "channelId")] ++
      (if isTruthy threadName then [("threadName", threadName)] else []) ++
      [("isDM", .bool (!isTruthy threadName))])]
  let inbound ← Prog.effect "toInboundMessage" [message, parsed, .str text, threadId, identity]
  return Json.mkObj [("kind", .str "message"), ("message", inbound)]

/-- `createGoogleChatChannel`'s `actions`. -/
private def gchatActions (call : Json) : Prog Json := do
  let _ ← Prog.effect "toGoogleChatSource" [get (arg call 0) "source"]
  return Json.mkObj
    [("sendText", fnMarker "sendText"), ("sendTyping", fnMarker "sendTyping"),
     ("reactToMessage", fnMarker "reactToMessage")]


/-! ### Slack -/

/-- `text.replace(/^:+|:+$/g, "")`. -/
private def stripColons (text : String) : String :=
  let front := text.toList.dropWhile (· == ':')
  String.ofList (front.reverse.dropWhile (· == ':')).reverse

/-- `createSlackChannel`'s `authenticate`: the SDK helper throws on a bad signature. -/
private def slackAuthenticate (call : Json) : Prog Json := do
  let req := arg call 0
  let outcome ← Prog.attempt "verifySlackSignature"
    [get req "body", get req "headers", Json.mkObj [("signingSecret", mod call "signingSecret")]]
  match outcome with
  | .ok _ => return .bool true
  | _ => return .bool false

/-- `createSlackChannel`'s `parse`: the slack body's kind picks the parser. -/
private def slackParse (call : Json) : Prog Json := do
  let req := arg call 0
  let headers := get req "headers"
  let payload ← Prog.effect "parseSlackWebhookBody"
    [get req "body", Json.mkObj [("headers", headers)]]
  let channels := mod call "allowedChannelIds"
  let users := mod call "allowedUserIds"
  match get payload "kind" with
  | .str "url_verification" =>
    return Json.mkObj
      [("kind", .str "response"), ("reason", .str "url_verification"),
       ("response", Json.mkObj
         [("statusCode", toJson (200 : Nat)),
          ("headers", Json.mkObj [("Content-Type", .str "application/json")]),
          ("body", .str (Twin.jsonStringify 8 (Json.mkObj [("challenge", get payload "challenge")])))])]
  | .str "slash_command" => Prog.effect "parseSlashCommand" [payload, channels, users]
  | .str "block_actions" => Prog.effect "parseQuestionClick" [payload, channels, users]
  | kind =>
    let contentType := jsString (orElse (get headers "content-type") (.str ""))
    if (indexOf? contentType "application/x-www-form-urlencoded").isSome then
      return ignoreResult (some s!"unsupported_slack_payload:{jsString kind}")
    let resolver ←
      if mod call "userNameResolver" == undef || mod call "userNameResolver" == .null then
        Prog.effect "createSlackUserNameResolver" [mod call "slack"]
      else pure (mod call "userNameResolver")
    Prog.effect "parseEventCallback"
      [get req "body", mod call "botToken", channels, users, resolver]

/-- `createSlackChannel`'s `actions`. -/
private def slackActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toSlackSource" [get (arg call 0) "source"]
  Prog.effect "createSlackActions"
    [mod call "botToken", mod call "apiUrl", mod call "slack", source, mod call "reactionEmoji"]

/-- `createSlackChannel`'s `applyReplyIn`: where a reply goes in the thread. -/
private def slackApplyReplyIn (call : Json) : Prog Json := do
  let source := arg call 0
  let slackSource ← Prog.effect "toSlackSource" [source]
  let threadTs :=
    if arg call 1 == .str "thread" then orElse (get slackSource "inThreadTs") (get slackSource "messageTs")
    else get slackSource "inThreadTs"
  return spread (dropField source "threadTs") (object [("threadTs", threadTs)])

private def slackApi (call : Json) : Json := mod call "api"

/-- `createSlackActions`' `sendText`: the slash command's response URL, else a channel post. -/
private def slackSendText (call : Json) : Prog Json := do
  let source := mod call "source"
  if isTruthy (get source "responseUrl") then
    let text ← Prog.effect "formatter.toResponseUrlText" [Json.mkObj [("markdown", arg call 0)]]
    let _ ← Prog.effect "sendSlackWebhookResponse" [get source "responseUrl", text]
    return undef
  let _ ← Prog.effect "postSlackMessage"
    [spread (slackApi call) (object
      [("channel", get source "channelId"), ("markdownText", arg call 0),
       ("threadTs", get source "threadTs"), ("unfurlLinks", .bool false),
       ("unfurlMedia", .bool false)])]
  return undef

/-- `/^[a-z0-9_+-]+$/i`. -/
private def isEmojiName (name : String) : Bool :=
  !name.isEmpty && name.toList.all fun c =>
    (c.isAlphanum && c.toNat < 128) || c == '_' || c == '+' || c == '-'

/-- `sendSticker`: an image URL becomes a card, an emoji name a message. -/
private def slackSendSticker (call : Json) : Prog Json := do
  let source := mod call "source"
  let value := jsTrim ((str? (arg call 0)).getD "")
  if value.isEmpty then
    Prog.throwError "Error"
      "Slack sendSticker needs a custom emoji name or public http(s) image URL"
  if (indexOf? value "://").isSome then
    let image ← Prog.effect "Image" [Json.mkObj [("url", .str value), ("alt", .str "Sticker")]]
    let card ← Prog.effect "Card" [Json.mkObj [("children", jarr [image])]]
    let _ ← Prog.effect "postSlackCard" [slackApi call, source, card]
    return undef
  let emojiName := stripColons value
  let text := if isEmojiName emojiName then s!":{emojiName}:" else value
  if isTruthy (get source "responseUrl") then
    let _ ← Prog.effect "sendSlackWebhookResponse" [get source "responseUrl", .str text]
    return undef
  let _ ← Prog.effect "postSlackMessage"
    [spread (slackApi call) (object
      [("channel", get source "channelId"), ("text", .str text),
       ("threadTs", get source "threadTs")])]
  return undef

/-- `reactToMessage`: `reactions.add` on the triggering message. -/
private def slackReact (call : Json) : Prog Json := do
  let source := mod call "source"
  if !isTruthy (get source "messageTs") then return undef
  let emoji := orElse (arg call 0) (mod call "reactionEmoji")
  let answer ← Prog.effect "callSlackApi"
    [.str "reactions.add",
     Json.mkObj [("channel", get source "channelId"), ("timestamp", get source "messageTs"),
       ("name", .str (stripColons (jsString emoji)))],
     spread (slackApi call) (Json.mkObj [("contentType", .str "json")])]
  let _ ← Prog.effect "assertSlackOk" [.str "reactions.add", answer]
  return undef

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (core "telegram-channel" "createTelegramChannel" "parse") telegramParse,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "authenticate") telegramAuthenticate,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "canHandle") telegramCanHandle,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "actions") telegramActions,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "sendQuestions") telegramSendQuestions,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "sendReplyButtons")
     telegramSendReplyButtons,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "sendSticker") telegramSendSticker,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "sendText") telegramSendText,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "sendTyping") telegramSendTyping,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "reactToMessage") telegramReact,
   Twin.traced (core "telegram-channel" "createTelegramChannel" "rehydrateAttachment")
     telegramRehydrate,
   Twin.traced (core "zalo-channel" "createZaloChannel" "parse") zaloParse,
   Twin.traced (core "zalo-channel" "createZaloChannel" "authenticate") zaloAuthenticate,
   Twin.traced (core "zalo-channel" "createZaloChannel" "canHandle") zaloCanHandle,
   Twin.traced (core "zalo-channel" "createZaloActions" "sendImages") zaloSendImages,
   Twin.traced (core "zalo-channel" "createZaloActions" "sendSticker") zaloSendSticker,
   Twin.traced (core "zalo-channel" "createZaloActions" "sendText") zaloSendText,
   Twin.traced (core "discord-channel" "createDiscordChannel" "parse") discordParse,
   Twin.traced (core "discord-channel" "createDiscordChannel" "authenticate") discordAuthenticate,
   Twin.traced (core "discord-channel" "createDiscordChannel" "actions") discordActions,
   Twin.traced (core "discord-channel" "createDiscordActions" "sendSticker") discordSendSticker,
   Twin.traced (core "discord-channel" "createDiscordActions" "sendText") discordSendText,
   Twin.traced (core "discord-channel" "createDiscordActions" "sendTyping") discordSendTyping,
   Twin.traced (core "discord-channel" "createDiscordActions" "reactToMessage") discordReact,
   Twin.traced (core "github-channel" "createGitHubChannel" "parse") githubParse,
   Twin.traced (core "github-channel" "createGitHubChannel" "authenticate") githubAuthenticate,
   Twin.traced (core "github-channel" "createGitHubChannel" "actions") githubActions,
   Twin.traced (core "github-channel" "createGitHubActions" "reactToMessage") githubReact,
   Twin.traced (core "github-channel" "createGitHubRestClient" "get") githubGet,
   Twin.traced (core "linear-channel" "createLinearChannel" "parse") linearParse,
   Twin.traced (core "linear-channel" "createLinearChannel" "authenticate") linearAuthenticate,
   Twin.traced (core "linear-channel" "createLinearChannel" "canHandle") linearCanHandle,
   Twin.traced (core "linear-channel" "createLinearChannel" "actions") linearActions,
   Twin.traced (core "linear-channel" "createLinearChannel" "sendText") linearSendText,
   Twin.traced (core "meta-channel" "createMetaChannel" "canHandle") metaCanHandle,
   Twin.traced (core "meta-channel" "createMetaChannel" "authenticate") metaAuthenticate,
   Twin.traced (core "meta-channel" "createMetaChannel" "parse") metaParse,
   Twin.traced (core "meta-channel" "createMetaChannel" "actions") metaActions,
   Twin.traced (core "meta-channel" "createMetaChannel" "sendText") metaSendText,
   Twin.traced (core "meta-channel" "createMetaChannel" "sendTyping") metaSendTyping,
   Twin.traced (core "messenger-channel" "createMessengerChannel" "ownerId") messengerOwnerId,
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel" "canHandle") whatsappCanHandle,
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel" "authenticate") whatsappAuthenticate,
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel" "parse") whatsappParse,
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel" "actions") whatsappActions,
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel" "sendTyping") whatsappSendTyping,
   Twin.traced (core "whatsapp-channel" "createWhatsAppChannel" "reactToMessage") whatsappReact,
   Twin.traced (core "twilio-channel" "createTwilioChannel" "canHandle") twilioCanHandle,
   Twin.traced (core "twilio-channel" "createTwilioChannel" "authenticate") twilioAuthenticate,
   Twin.traced (core "twilio-channel" "createTwilioChannel" "parse") twilioParse,
   Twin.traced (core "twilio-channel" "createTwilioChannel" "actions") twilioActions,
   Twin.traced (core "twilio-channel" "createTwilioChannel" "sendText") twilioSendText,
   Twin.traced (core "teams-channel" "createTeamsChannel" "authenticate") teamsAuthenticate,
   Twin.traced (core "teams-channel" "createTeamsChannel" "parse") teamsParse,
   Twin.traced (core "teams-channel" "createTeamsChannel" "actions") teamsActions,
   Twin.traced (core "gchat-channel" "createGoogleChatChannel" "authenticate") gchatAuthenticate,
   Twin.traced (core "gchat-channel" "createGoogleChatChannel" "parse") gchatParse,
   Twin.traced (core "gchat-channel" "createGoogleChatChannel" "actions") gchatActions,
   Twin.traced (core "slack-channel" "createSlackChannel" "authenticate") slackAuthenticate,
   Twin.traced (core "slack-channel" "createSlackChannel" "parse") slackParse,
   Twin.traced (core "slack-channel" "createSlackChannel" "actions") slackActions,
   Twin.traced (core "slack-channel" "createSlackChannel" "applyReplyIn") slackApplyReplyIn,
   Twin.traced (core "slack-channel" "createSlackActions" "sendText") slackSendText,
   Twin.traced (core "slack-channel" "createSlackActions" "sendSticker") slackSendSticker,
   Twin.traced (core "slack-channel" "createSlackActions" "reactToMessage") slackReact]

end Spec.Channels.Closures
