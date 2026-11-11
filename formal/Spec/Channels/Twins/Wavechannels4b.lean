import Spec.Channels.Twins.Wavechannels8a
import Spec.Channels.Twins.Wavechannels1.Base

/-!
Twins for the functions listed in `.lake/worklist/assign4/channels4b.tsv`.
-/

namespace Spec.Channels.Wavechannels4b

open Lean Spec Spec.Channels Spec.Channels.Wavechannels1.Base

private def socketSource (name : String) : String :=
  "apps/discord-forwarder/src/socket.ts#GatewaySocket." ++ name

private def telegramApiUrl : String := "https://api.telegram.org"

/-- `TELEGRAM_REQUEST_TIMEOUT_MS`. -/
private def telegramTimeoutMs : Nat := 10000

/-- `FATAL_CLOSE_CODES` in `apps/discord-forwarder/src/discord.ts`. -/
private def fatalCloseCodes : List Nat := [4004, 4010, 4011, 4012, 4013, 4014]

/-- `SESSION_ENDING_CLOSE_CODES` in `apps/discord-forwarder/src/discord.ts`. -/
private def sessionEndingCloseCodes : List Nat := [4007, 4009]

private def optional (key : String) (value : Json) : List (String × Json) :=
  if missing value then [] else [(key, value)]

private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if jsTruthy value then [(key, value)] else []

private def nullishOr (value fallback : Json) : Json :=
  if nullish value then fallback else value

private def isCode (codes : List Nat) (code : Json) : Bool :=
  codes.any fun item => code == num item

private def maxNumber (a b : Json) : Json :=
  if asNum a < asNum b then b else a

private def subtract (a b : Json) : Json :=
  let right := asNum b
  .num (addNum (asNum a) ⟨-right.mantissa, right.exponent⟩)

/-- A key's entry in a recorded `Map`, or `none` when the map cannot be read or has no such key. -/
private def mapEntry (map : Json) (key : Json) : Option Json :=
  (items (get map "$map")).findSome? fun entry =>
    if Twin.arg entry 0 == key then some (Twin.arg entry 1) else none

private def consoleLogger (scope : String) : Prog Json := do
  let _ ← Prog.effect "new ConsoleLogger" [.str "error"]
  Prog.effect "new ConsoleLogger(\"error\").child" [.str scope]

/-- The adapter object a channel factory hands back: its name and its closures. -/
private def channelAdapter (name : String) : Json :=
  Json.mkObj
    ([("name", toJson name)] ++
      (["rehydrateAttachment", "canHandle", "authenticate", "parse", "actions"].map fun key =>
        (key, fnJson key)))

private def createTelegramChannel (call : Json) : Prog Json := do
  let options := Twin.param call 6
  let _ ← Prog.effect "normalizeBotUsername" [get options "botUsername"]
  let logger ← consoleLogger "telegram"
  let _ ← Prog.effect "new BroodsTelegramAdapter" [Json.mkObj
    (optional "apiUrl" (Twin.param call 5) ++
      [("botToken", Twin.param call 0),
       ("secretToken", Twin.param call 1),
       ("mode", toJson "webhook"),
       ("nativeStreaming", toJson true),
       ("logger", logger)])]
  return channelAdapter "telegram"

private def createDiscordChannel (call : Json) : Prog Json := do
  let logger ← consoleLogger "discord"
  let _ ← Prog.effect "new BroodsDiscordAdapter" [Json.mkObj
    (optional "apiUrl" (Twin.param call 4) ++
      [("applicationId", toJson "broods-discord-webhook"),
       ("botToken", Twin.param call 0),
       ("publicKey", Twin.param call 1),
       ("logger", logger)])]
  return channelAdapter "discord"

private def createDiscordActions (call : Json) : Prog Json := do
  let source := Twin.callArg call 2
  let logger ← consoleLogger "discord"
  let _ ← Prog.effect "new BroodsDiscordAdapter" [Json.mkObj
    (optional "apiUrl" (Twin.callArg call 3) ++
      [("applicationId", get source "applicationId"),
       ("botToken", Twin.callArg call 0),
       ("publicKey", Twin.callArg call 1),
       ("logger", logger)])]
  if nullish (get source "threadId") then
    let me := toJson "@me"
    let channel :=
      nullishOr (get source "channelId")
        (nullishOr (get source "interactionId") (nullishOr (get source "messageId") me))
    let _ ← Prog.effect "discord.encodeThreadId"
      [Json.mkObj [("guildId", nullishOr (get source "guildId") me), ("channelId", channel)]]
  let hasMessage := (str? (get source "messageId")).isSome
  return Json.mkObj
    [("sendFiles", fnJson "sendAttachments"),
     ("sendImages", fnJson "sendAttachments"),
     ("sendSticker", fnJson "sendSticker"),
     ("sendText", fnJson "sendText"),
     ("sendTyping", fnJson "sendTyping"),
     ("supportsReactions", toJson hasMessage),
     ("reactToMessage", fnJson "reactToMessage")]

private def createGoogleChatChannel (call : Json) : Prog Json := do
  let _ ← Prog.effect "googleChatTransport" [Twin.callArg call 0]
  return channelAdapter "gchat"

private def createInstagramChannel (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let logger ← consoleLogger "instagram"
  let transport ← Prog.effect "new InstagramAdapter" [Json.mkObj
    ([("accessToken", get options "accessToken"),
      ("accountId", get options "accountId"),
      ("appSecret", get options "appSecret"),
      ("logger", logger),
      ("verifyToken", get options "verifyToken")] ++
      optional "apiVersion" (get options "apiVersion") ++
      optional "userName" (get options "userName"))]
  Prog.effect "createMetaChannel" [Json.mkObj
    (optional "allowedChannelIds" (get options "allowedChannelIds") ++
      optional "allowedUserIds" (get options "allowedUserIds") ++
      [("appSecret", get options "appSecret"),
       ("name", toJson "instagram"),
       ("object", toJson "instagram"),
       ("ownerId", fnJson "ownerId"),
       ("postsAttachments", toJson true),
       ("prefix", toJson "instagram:"),
       ("textLimit", Json.mkObj [("max", num 950), ("unit", toJson "bytes")]),
       ("transport", transport),
       ("verifyToken", get options "verifyToken")])]

private def tokenValidator (call : Json) : Prog Json := do
  let appId := Twin.callArg call 0
  let validators := Twin.moduleValue call "tokenValidators"
  if missing (get validators "$map") then
    Prog.unsupported "the validator cache was too big to record"
  else
    match mapEntry validators appId with
    | some cached =>
      let kept := (Spec.Channels.Wavechannels8a.mapEntries validators).filter
        (fun entry => Twin.arg entry 0 != appId)
      let next := Spec.Channels.Wavechannels8a.mapSet
        (Spec.Channels.Wavechannels8a.mapValue kept) appId cached
      Spec.Channels.Wavechannels8a.stateChange "module.tokenValidators" validators next
      return cached
    | none =>
      let validator ← Prog.effect "new JwtValidator" [Json.mkObj
        [("clientId", appId),
         ("jwksUriOptions", Json.mkObj
           [("type", toJson "uri"),
            ("uri", toJson "https://login.botframework.com/v1/.well-known/keys")]),
         ("validateIssuer", Json.mkObj
           [("allowedIssuer", toJson "https://api.botframework.com")])]]
      let next := Spec.Channels.Wavechannels8a.mapSet validators appId validator
      let entries := Spec.Channels.Wavechannels8a.mapEntries next
      let next := if entries.length > 100 then
        Spec.Channels.Wavechannels8a.mapValue (entries.drop 1) else next
      Spec.Channels.Wavechannels8a.stateChange "module.tokenValidators" validators next
      return validator

private def attachmentsKey (attachments : List Json) : List (String × Json) :=
  if attachments.isEmpty then [] else [("attachments", .arr attachments.toArray)]

private def gchatInboundMessage (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let parsed := Twin.callArg call 1
  let identity := Twin.callArg call 4
  let name := text (get message "name")
  let threadOrChannel := nullishOr (get identity "threadId") (get identity "channelId")
  let source := Json.mkObj
    ([("messageName", get message "name"),
      ("spaceName", get identity "channelId"),
      ("threadId", Twin.callArg call 3)] ++
      whenTruthy "threadName" (get identity "threadId") ++
      whenTruthy "userId" (get identity "userId") ++
      whenTruthy "userName" (get identity "userName"))
  return Json.mkObj
    ([("eventId", toJson s!"gchat:{name}"),
      ("conversationKey", toJson s!"gchat:{text threadOrChannel}"),
      ("channelName", toJson "gchat"),
      ("content", Twin.callArg call 2)] ++
      attachmentsKey (items (Twin.field parsed "attachments")) ++
      [("identity", identity), ("source", source)])

/-- `withGuardedRead`: only a bot-authenticated attachment keeps its reader. -/
private def guardedAttachment (attachment : Json) : Json :=
  if get (get attachment "fetchMetadata") "auth" == toJson "bot" then attachment
  else Json.mkObj ((entries attachment).filter (·.1 != "fetchData"))

private def teamsInboundMessage (call : Json) : Prog Json := do
  let conversationId := Twin.callArg call 0
  let parsed := Twin.callArg call 1
  let identity := Twin.callArg call 2
  let conversation := text conversationId
  let source := Json.mkObj
    ([("conversationId", conversationId),
      ("messageId", Twin.field parsed "id"),
      ("threadId", Twin.field parsed "threadId")] ++
      whenTruthy "userId" (get identity "userId") ++
      whenTruthy "userName" (get identity "userName"))
  return Json.mkObj
    ([("eventId", toJson s!"teams:{conversation}:{text (Twin.field parsed "id")}"),
      ("conversationKey", toJson s!"teams:{conversation}"),
      ("channelName", toJson "teams"),
      ("content", Twin.field parsed "text")] ++
      attachmentsKey ((items (Twin.field parsed "attachments")).map guardedAttachment) ++
      [("identity", identity), ("source", source)])

private def isOkStatus (response : Json) : Bool :=
  let status := (asNum (get (get response "$response") "status")).mantissa
  200 ≤ status && status < 300

private def downloadFile (call : Json) : Prog Json := do
  let self := Twin.self call
  let fileId := Twin.callArg call 0
  let apiBase := Twin.field self "apiBaseUrl"
  if apiBase == toJson telegramApiUrl then
    Prog.unsupported "the SDK's own download is not recorded"
  else
    let file ← Prog.effect "this.telegramFetch"
      [toJson "getFile", Json.mkObj [("file_id", fileId)]]
    let path := get file "file_path"
    if !jsTruthy path then
      Prog.throwError "Error" s!"Telegram file {text fileId} has no path"
    else
      let stored := Twin.field self "staticBotToken"
      let botToken ← if nullish stored then Prog.effect "this.resolveBotToken" else pure stored
      let signal ← Prog.effect "AbortSignal.timeout" [num telegramTimeoutMs]
      let url := s!"{text apiBase}/file/bot{text botToken}/{text path}"
      let response ← Prog.effect "publicHostFetch"
        [toJson url, Json.mkObj [("signal", signal)]]
      if isOkStatus response then
        Prog.effect "readCappedFile" [response, fileId]
      else
        let status := (get (get response "$response") "status").compress
        Prog.throwError "Error" s!"Failed to download Telegram file {text fileId}: {status}"

private def scheduleReconnect (call : Json) : Prog Json := do
  let self := Twin.self call
  let options := Twin.field self "options"
  let backoff ← Prog.effect "backoffDelayMs"
    [Twin.field self "attempt", get (get options "config") "backoffCeilingMs"]
  let _ ← Prog.effect "budget.remaining" [get options "botToken"]
  let timer ← Prog.effect "setTimeout" [fnJson "", maxNumber (Twin.callArg call 2) backoff]
  Spec.Channels.Wavechannels8a.socketFields self
    [("attempt", num ((Twin.field self "attempt").getNat?.toOption.getD 0 + 1)),
     ("state", .str "backoff"), ("reconnectTimer", timer)]
  return undef

private def reserveIdentify (call : Json) : Prog Json := do
  let self := Twin.self call
  let botToken := get (Twin.field self "options") "botToken"
  let consumed ← Prog.effect "budget.consume" [botToken]
  if jsTruthy consumed then
    return toJson true
  let retryAt ← Prog.effect "budget.retryAt" [botToken]
  let target ← if nullish retryAt then Prog.effect "Date.now" else pure retryAt
  let now ← Prog.effect "Date.now"
  let timer ← Prog.effect "setTimeout" [fnJson "", maxNumber (num 1000) (subtract target now)]
  Spec.Channels.Wavechannels8a.socketFields self
    [("state", .str "exhausted"), ("reconnectTimer", timer)]
  return toJson false

private def handleClose (call : Json) : Prog Json := do
  let self := Twin.self call
  let code := Twin.callArg call 1
  if Twin.callArg call 0 != Twin.field self "socket" then
    return undef
  let _ ← Prog.effect "this.clearTimers"
  if Twin.field self "state" == toJson "stopped" || isCode fatalCloseCodes code then
    Spec.Channels.Wavechannels8a.socketFields self
      ([("socket", .null), ("awaitingAck", .bool false)] ++
        if Twin.field self "state" == toJson "stopped" then [] else [("state", toJson "fatal")])
    return undef
  if isCode sessionEndingCloseCodes code then
    let _ ← Prog.effect "this.forgetSession"
  let _ ← Prog.effect "this.scheduleReconnect"
    [code, Twin.callArg call 2, Twin.param call 3]
  Spec.Channels.Wavechannels8a.socketFields self [("socket", .null), ("awaitingAck", .bool false)]
  return undef

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/shared/telegram-channel.ts#createTelegramChannel" createTelegramChannel,
   Twin.traced "apps/core/src/shared/telegram-channel.ts#BroodsTelegramAdapter.downloadFile" downloadFile,
   Twin.traced "apps/core/src/shared/discord-channel.ts#createDiscordChannel" createDiscordChannel,
   Twin.traced "apps/core/src/shared/discord-channel.ts#createDiscordActions" createDiscordActions,
   Twin.traced "apps/core/src/shared/gchat-channel.ts#createGoogleChatChannel" createGoogleChatChannel,
   Twin.traced "apps/core/src/shared/gchat-channel.ts#toInboundMessage" gchatInboundMessage,
   Twin.traced "apps/core/src/shared/teams-channel.ts#toInboundMessage" teamsInboundMessage,
   Twin.traced "apps/core/src/shared/teams-channel.ts#tokenValidator" tokenValidator,
   Twin.traced "apps/core/src/shared/instagram-channel.ts#createInstagramChannel" createInstagramChannel,
   Twin.traced (socketSource "scheduleReconnect") scheduleReconnect,
   Twin.traced (socketSource "reserveIdentify") reserveIdentify,
   Twin.traced (socketSource "handleClose") handleClose]

end Spec.Channels.Wavechannels4b
