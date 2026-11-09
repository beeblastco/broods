import Spec.Twin
import Spec.Channels.Twins.Wave10

/-!
Wave 11 twins of the channels subsystem: functions that no repository test reached, now driven by
`replay/extra`. See `AUTHORING.md`.
-/

namespace Spec.Channels.Wave11

open Lean Spec

private def member (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def items (value : Json) : List Json :=
  match value with
  | .arr entries => entries.toList
  | _ => []

private def isUndefined (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

private def number (value : Json) : Nat :=
  match value with
  | .num n => n.mantissa.toNat
  | _ => 0

/-- `cleanupChannelPartitions`: a conversation-partitioned channel drops each conversation-isolated
workspace's reserved sandboxes and stored files for the closed conversation. -/
private def cleanupChannelPartitions (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let accountId := member options "accountId"
  let channelName := member options "channelName"
  let conversationKey := member options "conversationKey"
  let partition ← Prog.effect "channelPartitionOf" [member options "agentConfig", channelName]
  if member partition "by" != toJson "conversation" then
    return Twin.undefinedJson
  let _ ← Prog.effect "getStorage"
  let mut deleted : Nat := 0
  for ref in items (member (member options "agentConfig") "workspaces") do
    let record ← Prog.effect "storage.workspaceConfigs.getById" [accountId, member ref "workspaceId"]
    let config := member record "config"
    if member config "isolation" != toJson "conversation" then
      continue
    let base ← Prog.effect "workspaceNamespace" [accountId, member ref "workspaceId"]
    let channelScopeKey ← Prog.effect "channelScopeKeyFromConversation" [conversationKey]
    let scopedKey ← Prog.effect "channelScopeKeyFromConversation"
      [conversationKey, toJson "conversation"]
    let isolated ← Prog.effect "isolatedWorkspaceNamespace"
      [base, toJson "conversation",
       Json.mkObj [("channelName", channelName), ("channelScopeKey", channelScopeKey),
         ("conversationKey", scopedKey), ("partition", partition)]]
    let _ ← Prog.effect "releaseReservedSandboxes" [accountId, .arr #[isolated]]
    let context ← Prog.effect "workspaceReadContext" [member config "storage", isolated]
    let target ← Prog.effect "resolveS3ReadTarget" [context]
    let removed ← Prog.effect "deleteS3Prefix"
      [member target "bucket", member target "prefix", member target "access"]
    deleted := deleted + number removed
  return Twin.undefinedJson

/-- `setLogService`: later log lines carry this service name. -/
private def setLogService (call : Json) : Prog Json := do
  Prog.setChanged "module.service" (Twin.moduleValue call "service") (Twin.callArg call 0)
  return Twin.undefinedJson

/-- `MAX_ATTACHMENT_BYTES` in `media-types.ts` and `DISCORD_FETCH_TIMEOUT_MS` in `discord-channel.ts`. -/
private def maxAttachmentBytes : Nat := 25 * 1024 * 1024

private def discordFetchTimeoutMs : Nat := 30000

/-- `fetchDiscordFile`: the tenant-steerable CDN url goes through the address guard, and only 2xx bytes count. -/
private def fetchDiscordFile (call : Json) : Prog Json := do
  let response ← Prog.effect "guardedFetch"
    [Twin.callArg call 0, Twin.undefinedJson,
     Json.mkObj [("binary", toJson true), ("bodyLimitBytes", toJson maxAttachmentBytes),
       ("timeoutMs", toJson discordFetchTimeoutMs)]]
  let status := number (member response "status")
  if status < 200 || status >= 300 then
    Prog.throwError "Error" s!"Discord answered {status}"
  return member response "bodyBytes"

/-- `BroodsWhatsAppAdapter.graphApiUpload`. The stock Graph host goes to the SDK, which is not
recorded; a tenant host takes the form through the guarded fetch. -/
private def graphApiUpload (call : Json) : Prog Json := do
  let graphUrl := Twin.field (Twin.self call) "graphApiUrl"
  if Wave10.urlHost (Wave10.jsonText graphUrl) == "graph.facebook.com" then
    Prog.unsupported "the SDK's own upload is not recorded"
  Prog.effect "this.tenantGraphApi"
    [Twin.callArg call 0, Json.mkObj [("body", Twin.callArg call 1)]]

private def closure (file factory label : String) : String :=
  s!"apps/core/src/shared/{file}.ts#{factory}/{label}"

private def mod (call : Json) (name : String) : Json := Twin.moduleValue call name

private def sendTo (effect : String) (call : Json) : Prog Json := do
  let source := mod call "source"
  let _ ← Prog.effect effect [member source "threadId", Json.mkObj [("markdown", Twin.callArg call 0)]]
  return Twin.undefinedJson

/-- `createWhatsAppChannel`'s `sendText`, `createTeamsChannel`'s and `createGoogleChatChannel`'s:
the text goes to the source's thread. -/
private def transportSendText (call : Json) : Prog Json := sendTo "transport.postMessage" call

/-- `createGitHubActions`'s `sendText`. -/
private def githubSendText (call : Json) : Prog Json := sendTo "github.postMessage" call

/-- `createDiscordActions`'s `sendAttachments`: the bytes are read first, then one message carries them
with the caption. -/
private def discordSendAttachments (call : Json) : Prog Json := do
  let files ← Prog.effect "discordUploads" [Twin.callArg call 0]
  let caption := Twin.callArg call 1
  let markdown := if caption == Twin.undefinedJson || caption == .null then toJson "" else caption
  let _ ← Prog.effect "discord.postMessage"
    [mod call "threadId", Json.mkObj [("markdown", markdown), ("files", files)]]
  return Twin.undefinedJson

/-- `createSlackChannel`'s `canHandle`: only a request that carries Slack's signature header. -/
private def slackCanHandle (call : Json) : Prog Json :=
  pure (toJson (!isUndefined (member (member (Twin.callArg call 0) "headers") "x-slack-signature")))

/-- `createPancakeChannel`'s `canHandle`: any POST. -/
private def pancakeCanHandle (call : Json) : Prog Json :=
  pure (toJson (member (Twin.callArg call 0) "method" == toJson "POST"))

private def hexValue? (c : Char) : Option Nat :=
  if '0' ≤ c && c ≤ '9' then some (c.toNat - '0'.toNat)
  else if 'a' ≤ c && c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
  else if 'A' ≤ c && c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
  else none

/-- `URLSearchParams` decoding for an ASCII value: `+` is a space and `%XX` is that byte. -/
private def formDecode : List Char → Option (List Char)
  | [] => some []
  | '+' :: rest => (formDecode rest).map (' ' :: ·)
  | '%' :: a :: b :: rest =>
    match hexValue? a, hexValue? b with
    | some high, some low =>
      let code := high * 16 + low
      if code < 128 then (formDecode rest).map (Char.ofNat code :: ·) else none
    | _, _ => (formDecode rest).map (fun tail => '%' :: a :: b :: tail)
  | c :: rest => (formDecode rest).map (c :: ·)

/-- `new URLSearchParams(query).get(name)`: the first matching pair's value, if any. -/
private def searchParam (query name : String) : Option String :=
  (query.splitOn "&").findSome? fun pair =>
    match pair.splitOn "=" with
    | key :: value =>
      match formDecode key.toList, formDecode ("=".intercalate value).toList with
      | some decodedKey, some decodedValue =>
        if String.ofList decodedKey == name then some (String.ofList decodedValue) else none
      | _, _ => none
    | [] => none

/-- `createPancakeChannel`'s `authenticate`: the webhook url carries the secret as `?secret=`. -/
private def pancakeAuthenticate (call : Json) : Prog Json := do
  let query := member (Twin.callArg call 0) "rawQueryString"
  match query with
  | .str text =>
    match searchParam text "secret" with
    | some provided =>
      if provided.isEmpty then return toJson false
      Prog.effect "timingSafeStringEqual" [toJson provided, mod call "webhookSecret"]
    | none => return toJson false
  | _ => Prog.unsupported "query string is not a string"

/-- `createPancakeActions`'s `sendText`: the page token, source, text and sender go to the Pancake API. -/
private def pancakeSendText (call : Json) : Prog Json :=
  Prog.effect "sendPancakeMessage"
    [mod call "pageAccessToken", mod call "source", Twin.callArg call 0, mod call "senderId"]

/-- `createPancakeActions`'s `sendAttachments`, shared by `sendFiles` and `sendImages`. -/
private def pancakeSendAttachments (call : Json) : Prog Json :=
  Prog.effect "sendPancakeAttachments"
    [mod call "pageAccessToken", mod call "source", Twin.callArg call 0, Twin.callArg call 1,
     mod call "senderId"]

/-- `createZaloActions`'s `sendTyping`: a typing action in the chat. -/
private def zaloSendTyping (call : Json) : Prog Json := do
  let _ ← Prog.effect "callZaloApi"
    [mod call "botToken", toJson "sendChatAction",
     Json.mkObj [("chat_id", member (mod call "source") "chatId"), ("action", toJson "typing")]]
  return Twin.undefinedJson

/-- `createTelegramChannel`'s `sendAttachments`: posted into the source's thread. -/
private def telegramSendAttachments (call : Json) : Prog Json := do
  let _ ← Prog.effect "postTelegramAttachments"
    [mod call "transport", member (mod call "source") "threadId", Twin.callArg call 0,
     Twin.callArg call 1]
  return Twin.undefinedJson

/-- `createInstagramChannel`'s `ownerId`: the configured account. -/
private def instagramOwnerId (call : Json) : Prog Json :=
  pure (member (mod call "options") "accountId")

private def truthyJson (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str text => !text.isEmpty
  | .num number => number.mantissa != 0
  | other => !isUndefined other

/-- `createSlackActions`'s `sendFiles`: each file's name and bytes, then one upload into the thread.
The first name is read alone; after that the byte reads and the later names overlap. -/
private def slackSendFiles (call : Json) : Prog Json := do
  let source := mod call "source"
  let files := items (Twin.callArg call 0)
  let mut uploads : Array Json := #[]
  match files with
  | [] => pure ()
  | first :: rest =>
    let firstName ← Prog.effect "channelAttachmentName" [first]
    let group := [("channelAttachmentBytes", [first])] ++
      rest.flatMap fun file => [("channelAttachmentName", [file]), ("channelAttachmentBytes", [file])]
    let outcomes ← Prog.all group
    let values ← outcomes.mapM fun outcome =>
      match outcome with
      | .ok value => pure value
      | .threw error _ => throw error
      | .pending => Prog.unsupported "an upload read never settled"
    let names := firstName :: ((List.range rest.length).map fun i => values.getD (1 + 2 * i) Twin.undefinedJson)
    let bytes := (values.head?.toList) ++ ((List.range rest.length).map fun i => values.getD (2 + 2 * i) Twin.undefinedJson)
    for (name, data) in names.zip bytes do
      uploads := uploads.push (Json.mkObj [("data", data), ("filename", name), ("title", name)])
  let caption := Twin.callArg call 1
  let thread := member source "threadTs"
  let options := Json.mkObj
    ([("token", member (mod call "api") "token"), ("fetch", member (mod call "api") "fetch"),
      ("channelId", member source "channelId")] ++
     (if truthyJson caption then [("initialComment", caption)] else []) ++
     (if truthyJson thread then [("threadTs", thread)] else []))
  let _ ← Prog.effect "uploadSlackFiles" [.arr uploads, options]
  return Twin.undefinedJson

/-- `createSlackActions`'s `sendImages`: one card, the caption first, then an image block per image. -/
private def slackSendImages (call : Json) : Prog Json := do
  let caption := Twin.callArg call 1
  let mut children : Array Json := #[]
  if truthyJson caption then
    children := children.push (← Prog.effect "CardText" [caption])
  for image in items (Twin.callArg call 0) do
    let name := member image "name"
    let alt := if !isUndefined name && name != .null then name
      else if !isUndefined caption && caption != .null then caption else toJson "Image"
    children := children.push (← Prog.effect "Image"
      [Json.mkObj [("url", member image "url"), ("alt", alt)]])
  let card ← Prog.effect "Card" [Json.mkObj [("children", .arr children)]]
  let _ ← Prog.effect "postSlackCard" [mod call "api", mod call "source", card]
  return Twin.undefinedJson

/-- `createPancakeChannel`'s `actions`: the source is checked, then the page's action set is built. -/
private def pancakeActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toPancakeSource" [member (Twin.callArg call 0) "source"]
  Prog.effect "createPancakeActions" [mod call "pageAccessToken", source, mod call "senderId"]

/-- `createZaloChannel`'s `actions`. -/
private def zaloActions (call : Json) : Prog Json := do
  let source ← Prog.effect "toZaloSource" [member (Twin.callArg call 0) "source"]
  Prog.effect "createZaloActions" [mod call "botToken", source]

/-- `watchChannelConnections`'s `close`: every plane's client closes together. -/
private def closeConnectionWatch (call : Json) : Prog Json := do
  let outcomes ← Prog.all ((items (mod call "clients")).map fun _ => ("client.close", []))
  for outcome in outcomes do
    match outcome with
    | .threw error _ => throw error
    | .pending => return ← Prog.unsupported "a client close never settled"
    | .ok _ => pure ()
  return Twin.undefinedJson

/-- `GatewaySocket.scheduleReconnect`'s timer callback: dial again. -/
private def reconnectDial (_call : Json) : Prog Json :=
  Prog.effect "this.dial"

/-- `Forwarder.open`'s `onMessageCreate`: delivery starts and is not awaited. -/
private def onMessageCreate (call : Json) : Prog Json := do
  Prog.spawn "this.deliver" [mod call "botToken", mod call "threads", Twin.callArg call 0]
  return Twin.undefinedJson

/-- `createSlackUserNameResolver`'s resolver: a user's handle, else their full name, else null. -/
private def slackUserName (call : Json) : Prog Json := do
  let user ← Prog.effect "slack.getUser" [Twin.callArg call 0]
  let pick (name : String) : Option Json :=
    match member user name with
    | .null => none
    | other => if isUndefined other then none else some other
  return (pick "userName").getD ((pick "fullName").getD Json.null)

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/integrations.ts#cleanupChannelPartitions" cleanupChannelPartitions,
   Twin.traced "apps/discord-forwarder/src/log.ts#setLogService" setLogService,
   Twin.traced "apps/core/src/shared/discord-channel.ts#fetchDiscordFile" fetchDiscordFile,
   Twin.traced "apps/core/src/shared/whatsapp-channel.ts#BroodsWhatsAppAdapter.graphApiUpload" graphApiUpload,
   Twin.traced (closure "whatsapp-channel" "createWhatsAppChannel" "sendText") transportSendText,
   Twin.traced (closure "teams-channel" "createTeamsChannel" "sendText") transportSendText,
   Twin.traced (closure "gchat-channel" "createGoogleChatChannel" "sendText") transportSendText,
   Twin.traced (closure "github-channel" "createGitHubActions" "sendText") githubSendText,
   Twin.traced (closure "discord-channel" "createDiscordActions" "sendAttachments") discordSendAttachments,
   Twin.traced (closure "slack-channel" "createSlackChannel" "canHandle") slackCanHandle,
   Twin.traced (closure "pancake-channel" "createPancakeChannel" "canHandle") pancakeCanHandle,
   Twin.traced (closure "pancake-channel" "createPancakeChannel" "authenticate") pancakeAuthenticate,
   Twin.traced (closure "pancake-channel" "createPancakeActions" "sendText") pancakeSendText,
   Twin.traced (closure "pancake-channel" "createPancakeActions" "sendAttachments") pancakeSendAttachments,
   Twin.traced (closure "zalo-channel" "createZaloActions" "sendTyping") zaloSendTyping,
   Twin.traced (closure "telegram-channel" "createTelegramChannel" "sendAttachments") telegramSendAttachments,
   Twin.traced (closure "instagram-channel" "createInstagramChannel" "ownerId") instagramOwnerId,
   Twin.traced (closure "pancake-channel" "createPancakeChannel" "actions") pancakeActions,
   Twin.traced (closure "zalo-channel" "createZaloChannel" "actions") zaloActions,
   Twin.traced "apps/discord-forwarder/src/connections.ts#watchChannelConnections/close" closeConnectionWatch,
   Twin.traced "apps/discord-forwarder/src/socket.ts#GatewaySocket.scheduleReconnect/arg0" reconnectDial,
   Twin.traced "apps/discord-forwarder/src/supervisor.ts#Forwarder.open/onMessageCreate" onMessageCreate,
   Twin.traced (closure "slack-channel" "createSlackUserNameResolver" "return") slackUserName,
   Twin.traced (closure "slack-channel" "createSlackActions" "sendFiles") slackSendFiles,
   Twin.traced (closure "slack-channel" "createSlackActions" "sendImages") slackSendImages]

end Spec.Channels.Wave11
