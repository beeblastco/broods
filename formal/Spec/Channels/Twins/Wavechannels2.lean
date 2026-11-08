import Spec.Channels.Twins.Wavechannels8a
import Spec.Channels.Twins.Support
import Spec.Sandbox.Twins.Tools.Js

namespace Spec.Channels.Wavechannels2

open Lean Spec Spec.Channels Spec.Sandbox.Tools.Re

private def get (v : Json) (k : String) : Json := (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def text (v : Json) : String := v.getStr?.toOption.getD ""
private def items (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def missing (v : Json) : Bool := v == Twin.undefinedJson || v == .null
private def live (v : Json) : Bool := !missing v && truthy v
private def string (v : Json) : Bool := v.getStr?.isOk
private def nat (v : Json) : Nat := v.getNat?.toOption.getD 0
private def a (c : Json) (n : Nat) : Json := Twin.callArg c n
private def nullish (v fallback : Json) : Json := if missing v then fallback else v
private def ulen (s : String) : Nat := s.toList.foldl (fun n c => n + if c.toNat > 0xffff then 2 else 1) 0
private def utake (s : String) (n : Nat) : String :=
  String.ofList ((s.toList.foldl (fun (acc : List Char × Nat) c =>
    let width := if c.toNat > 0xffff then 2 else 1
    if acc.2 + width ≤ n then (c :: acc.1, acc.2 + width) else (acc.1, n + 1)) ([], 0)).1.reverse)

private def chunkLoop : Nat → String → Nat → List String
  | 0, _, _ => []
  | fuel + 1, s, limit =>
    if s.isEmpty then [] else
    let piece := utake s limit
    let piece := if piece.isEmpty then String.ofList (s.toList.take 1) else piece
    piece :: chunkLoop fuel (dropChars s piece.length) limit

private def splitLoop : Nat → String → List String
  | 0, _ => []
  | fuel + 1, s =>
    if ulen s ≤ 3500 then if s.isEmpty then [] else [s]
    else
      let candidate := utake s 3500
      let split := candidate.toList.zipIdx |>.foldl (fun best pair =>
        if pair.1 == '\n' || pair.1 == ' ' then pair.2 else best) 0
      let piece := if split > 1750 then String.ofList (candidate.toList.take split) else candidate
      jsTrim piece :: splitLoop fuel (jsTrim (dropChars s piece.length))

private def parseWebhook (c : Json) : Prog Json := do
  match Json.parse (text (a c 1)) with
  | .error _ => pure (Json.mkObj [("kind", .str "ignore"), ("reason", .str "invalid_payload")])
  | .ok value =>
    let result ← Prog.effect "WEBHOOK_BODY.safeParse" [value]
    if get result "success" == .bool true then
      pure (Json.mkObj [("kind", .str "payload"), ("payload", get result "data")])
    else pure (Json.mkObj [("kind", .str "ignore"), ("reason", .str "invalid_payload")])

private def bchar (n : Nat) : Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray.getD n 'A'
private def encode64 : List Nat → List Char
  | x :: y :: z :: rest =>
    [bchar (x / 4), bchar ((x % 4) * 16 + y / 16), bchar ((y % 16) * 4 + z / 64), bchar (z % 64)] ++ encode64 rest
  | [x, y] => [bchar (x / 4), bchar ((x % 4) * 16 + y / 16), bchar ((y % 16) * 4), '=']
  | [x] => [bchar (x / 4), bchar ((x % 4) * 16), '=', '=']
  | [] => []

private def readChunks (file : String) : Nat → List Nat → Prog Json
  | 0, _ => Prog.unsupported "stream exceeds model fuel"
  | fuel + 1, bytes => do
    let read ← Prog.effect "reader?.read"
    if missing read || get read "done" == .bool true then
      return Json.mkObj [("$bytes", .str (String.ofList (encode64 bytes)))]
    let value := get read "value"
    if !string (get value "$bytes") then return ← Prog.unsupported "unrecorded stream bytes"
    let bytes := bytes ++ (Spec.Sandbox.Tools.fromBase64 (text (get value "$bytes"))).toList
    if bytes.length > 25 * 1024 * 1024 then
      let _ ← Prog.effect "reader?.cancel"
      return ← Prog.throwError "Error" s!"Telegram file {file} exceeds the download limit"
    readChunks file fuel bytes

private def readCapped (c : Json) : Prog Json := do
  let headers := items (get (get (a c 0) "$response") "headers")
  let length := headers.find? (fun h => text (Twin.arg h 0) == "content-length")
  let size := length.bind (fun h => (text (Twin.arg h 1)).toNat?) |>.getD 0
  let file := text (a c 1)
  if size > 25 * 1024 * 1024 then
    let _ ← Prog.effect "response.body?.cancel"
    return ← Prog.throwError "Error" s!"Telegram file {file} exceeds the download limit"
  let reader ← Prog.effect "response.body?.getReader"
  if missing reader then return Json.mkObj [("$bytes", .str "")]
  readChunks file 4096 []

private def botApi (c : Json) : Prog Json := do
  let raw := text (nullish (a c 0) (.str "https://api.telegram.org"))
  match parseUrl raw with
  | .invalid => Prog.throwError "Error" "config.channels.telegram.apiUrl must be a valid URL"
  | .unknown => Prog.unsupported "URL syntax beyond shared parser"
  | .ok url =>
    if url.protocol != "https:" then
      return ← Prog.throwError "Error" "config.channels.telegram.apiUrl must use https"
    if (raw.splitOn "?").length > 1 || (raw.splitOn "#").length > 1 then
      return ← Prog.throwError "Error" "config.channels.telegram.apiUrl must not carry a query or fragment"
    if (raw.splitOn "@").length > 1 then return ← Prog.unsupported "credential URL serialization"
    let path := String.ofList ((url.pathname.toList.reverse.dropWhile (· == '/')).reverse)
    return .str s!"https://{url.hostname}{if url.port == "" then "" else ":" ++ url.port}{path}/bot{text (a c 1)}/{text (a c 2)}"

private def acceptsNative (c : Json) : Prog Json := do
  let media := text (a c 1)
  if media.startsWith "image/" then return .bool true
  let top ← Prog.effect "getTopLevelMediaType" [a c 1]
  let provider := text (a c 0)
  let known := ["anthropic", "azure", "bedrock", "google", "openai", "vertex"].contains provider
  return .bool (known && (media == "application/pdf" ||
    (["google", "vertex"].contains provider && ["audio", "video"].contains (text top))))

private def resolveType (c : Json) : Prog Json := do
  let sniffed ← Prog.effect "detectMediaType" [Json.mkObj [("data", a c 0)]]
  let generic := fun v => ["application/octet-stream", "application/x-zip-compressed", "application/zip"].contains (text v)
  if live sniffed && !generic sniffed then return sniffed
  let claimed := a c 1
  if live claimed && !generic claimed then return claimed
  return nullish sniffed (nullish claimed (.str "application/octet-stream"))

private def sourceFields (c : Json) (required optionalKeys : List String) (message : String) : Prog Json := do
  let value := a c 0
  if !(required.all (fun k => string (get value k))) then return ← Prog.throwError "Error" message
  return Json.mkObj ((required ++ optionalKeys).filterMap fun key =>
    if string (get value key) then some (key, get value key) else none)

private def discordSource (c : Json) : Prog Json := do
  let source := a c 0
  if !string (get source "applicationId") ||
    !(["channelId", "threadId", "interactionId"].any (fun k => string (get source k) && live (get source k))) then
    return ← Prog.throwError "Error" "Invalid Discord source payload"
  sourceFields c ["applicationId"]
    ["interactionToken", "interactionId", "guildId", "channelId", "threadId", "messageId", "commandToken", "userId"]
    "Invalid Discord source payload"

private def pureTwin (source : String) (run : Json → Json) : Twin :=
  Twin.traced source (fun c => pure (run c))
private def core (file name : String) : String := s!"apps/core/src/shared/{file}.ts#{name}"
private def media (name : String) : String := s!"apps/core/src/harness/channel-media.ts#{name}"

private def replaceMatches (re : Spec.Sandbox.Tools.Re) (s : String)
    (replacement : Spec.Sandbox.Tools.Re.Match → String) : String :=
  let chars := s.toList.toArray
  let rec loop : Nat → Nat → String
    | 0, pos => String.ofList (chars.toList.drop pos)
    | fuel + 1, pos =>
      match Spec.Sandbox.Tools.Re.execFrom re chars pos with
      | none => String.ofList (chars.toList.drop pos)
      | some found =>
        String.ofList ((chars.toList.drop pos).take (found.start - pos)) ++ replacement found ++
          loop fuel (max found.stop (found.start + 1))
  loop (s.length + 1) 0

private def cleanText (s : String) : String := Id.run do
  let punctuation := seqs [plus (oneOf " \t"), .group 1 (oneOf ",.!?;:")]
  let chars := s.toList.toArray
  let s := replaceMatches punctuation s (fun m => (groupText chars m 1).getD "")
  let repeated := seqs [oneOf " \t", plus (oneOf " \t")]
  return jsTrim (replaceMatches repeated s (fun _ => " "))

private def discordText (c : Json) : Prog Json := do
  let content := text (a c 0)
  let data := a c 1
  let omitted := items (get (a c 2) "$set")
  let names := (items (get data "mentions")).foldl (fun acc m =>
    let name := if live (get m "global_name") then get m "global_name" else get m "username"
    if live (get m "id") && live name then setField acc (text (get m "id")) name else acc) (Json.mkObj [])
  let mention := seqs [lit "<@", opt (lit "!"), .group 1 (plus (.chr (fun ch => ch != '>' && !jsSpace ch))), lit ">"]
  let chars := content.toList.toArray
  let normalized := cleanText (replaceMatches mention content (fun m =>
    let id := (groupText chars m 1).getD ""
    let name := get names id
    if omitted.contains (.str id) then "" else if live name then "@" ++ text name
      else String.ofList ((chars.toList.drop m.start).take (m.stop - m.start))))
  let author := get data "author"
  let name := if live (get author "global_name") then get author "global_name" else get author "username"
  if normalized == "" || !live name then return .str normalized
  let command ← Prog.effect "parseCommand" [.str normalized]
  return .str (if live command then normalized else text name ++ ": " ++ normalized)

private def parseQuestion (c : Json) : Json :=
  let fields := (text (a c 0)).splitOn ":"
  let status := fields[1]?.getD ""
  let validStatus := status.startsWith "async_tool_" && status.length == 47 &&
    (dropChars status 11).toList.all (fun ch => ('0' ≤ ch && ch ≤ '9') || ('a' ≤ ch && ch ≤ 'f') || ch == '-')
  let decimal := fun (s : String) => !s.isEmpty && s.toList.all (fun ch => '0' ≤ ch && ch ≤ '9')
  if fields.length == 4 && fields.headD "" == "q" && validStatus && decimal (fields[2]?.getD "") && decimal (fields[3]?.getD "") then
    Json.mkObj [("statusId", .str status), ("questionIndex", toJson ((fields[2]?.getD "").toNat!.toFloat)),
      ("optionIndex", toJson ((fields[3]?.getD "").toNat!.toFloat))]
  else Twin.undefinedJson

private def parseKey (c : Json) : Prog Json := do
  match Json.parse (text (a c 0)) with
  | .error _ => pure .null
  | .ok value =>
    let result ← Prog.effect "SERVICE_ACCOUNT_KEY.safeParse" [value]
    return if get result "success" == .bool true then get result "data" else .null

private def fromForm (s : String) : String :=
  (decodeComponent? (s.replace "+" " ")).getD s
private def formPairs (s : String) : List (String × String) :=
  (s.splitOn "&").filterMap fun pair =>
    if pair == "" then none else
    let parts := pair.splitOn "="
    some (fromForm (parts.headD ""), fromForm (String.intercalate "=" (parts.drop 1)))
private def formEncode (s : String) : String :=
  (encodeComponent s).replace "%20" "+" |>.replace "!" "%21" |>.replace "'" "%27" |>.replace "(" "%28" |>.replace ")" "%29" |>.replace "~" "%7E"

private def parseReference (c : Json) : Prog Json := do
  let value := a c 0
  let raw := text value
  if !string value || !raw.startsWith "broods-media://" then return .null
  let raw := ((dropChars raw 15).splitOn "#").headD ""
  let urlParts := raw.splitOn "?"
  let pathParts := (urlParts.headD "").splitOn "/"
  let host := pathParts.headD ""
  if host == "" || host.toList.any (fun ch => jsSpace ch || ch == '@' || ch == ':') then
    return ← Prog.unsupported "non-simple media reference authority"
  let name := String.intercalate "/" (pathParts.drop 1)
  let some name := decodeComponent? name | return ← Prog.throwError "URIError" "URI malformed"
  let pairs := formPairs (String.intercalate "?" (urlParts.drop 1))
  let first := fun key => (pairs.find? (fun p => p.1 == key)).map (·.2)
  let kind := (first "type").getD ""
  let metadata := pairs.foldl (fun acc p =>
    if p.1 == "mediaType" || p.1 == "type" then acc else setField acc p.1 (.str p.2)) (Json.mkObj [])
  return Json.mkObj [("channelName", .str host), ("mediaType", .str ((first "mediaType").getD "application/octet-stream")),
    ("name", .str name), ("metadata", metadata), ("type", .str (if ["image", "audio", "video"].contains kind then kind else "file")), ("url", value)]

private def referenceUrl (c : Json) : Prog Json := do
  let att := a c 0
  let metadata := nullish (get att "fetchMetadata")
    (if live (get att "url") then Json.mkObj [("url", get att "url")] else Twin.undefinedJson)
  if missing metadata || (entries metadata).isEmpty then return Twin.undefinedJson
  if (entries metadata).length > 1 then return ← Prog.unsupported "metadata property insertion order unavailable"
  let pairs := (entries metadata).filter (fun p => p.1 != "mediaType" && p.1 != "type") ++
    [("mediaType", a c 1), ("type", get att "type")]
  let query := String.intercalate "&" (pairs.map fun p => formEncode p.1 ++ "=" ++ formEncode (text p.2))
  return .str s!"broods-media://{text (a c 3)}/{encodeComponent (text (a c 2))}?{query}"

private def mediaBytesValue : Nat → Json → Prog Json
  | 0, _ => Prog.unsupported "nested byte wrappers exceed fuel"
  | fuel + 1, v => do
    if string (get v "$bytes") then return v
    if string v then
      let s := text v
      let prefixEnd := indexOf? s ","
      let dataUrl := s.toLower.startsWith "data:" &&
        ((s.splitOn ",").headD "").toLower.endsWith ";base64"
      let scheme := Spec.Sandbox.Tools.Re.test
        (Spec.Sandbox.Tools.Re.seqs [.bol, .chr (fun ch => ch.isAlpha),
          .rep (.chr (fun ch => ch.isAlphanum || "+.-".toList.contains ch)) true,
          Spec.Sandbox.Tools.Re.lit ":"]) s
      if !dataUrl && scheme then return .null
      let encoded := if dataUrl then dropChars s (prefixEnd.getD 0 + 1) else s
      return Json.mkObj [("$bytes", .str (String.ofList (encode64 (Spec.Sandbox.Tools.fromBase64 encoded).toList)))]
    if get v "type" == .str "data" then return ← mediaBytesValue fuel (get v "data")
    return .null

private def numberFields (v : Json) (names : List String) : List (String × Json) :=
  names.filterMap fun k => if (get v k).getNum?.isOk then some (k, get v k) else none

private def telegramSource (c : Json) : Prog Json := do
  let v := a c 0
  if !(get v "chatId").getNum?.isOk || !string (get v "messageId") || !string (get v "threadId") then
    return ← Prog.throwError "Error" "Invalid Telegram source payload"
  return Json.mkObj ([("chatId", get v "chatId"), ("messageId", get v "messageId"), ("threadId", get v "threadId")] ++
    numberFields v ["messageThreadId", "fromUserId"] ++
    (if string (get v "fromUsername") then [("fromUsername", get v "fromUsername")] else []))

private def forwarder (file name : String) : String := s!"apps/discord-forwarder/src/{file}.ts#{name}"

private def moreTwins : List Twin := [
  Twin.traced (core "discord-channel" "formatDiscordMessageText") discordText,
  Twin.traced (media "parseMediaReference") parseReference,
  Twin.traced (media "mediaReferenceUrl") referenceUrl,
  Twin.traced (media "mediaBytes") (fun c => mediaBytesValue 64 (a c 0)),
  Twin.traced (core "telegram-channel" "toTelegramSource") telegramSource,
  Twin.traced (core "gchat-channel" "parseServiceAccountKey") parseKey,
  pureTwin (core "channels" "parseQuestionButtonId") parseQuestion,
  pureTwin (core "slack-channel" "cleanSlackText") (fun c => .str (cleanText (text (a c 0)))),
  pureTwin (core "slack-channel" "hasSlackMention") (fun c => .bool
    (Spec.Sandbox.Tools.Re.test (Spec.Sandbox.Tools.Re.seqs [Spec.Sandbox.Tools.Re.lit "<@",
      Spec.Sandbox.Tools.Re.plus (Spec.Sandbox.Tools.Re.noneOf ">"), Spec.Sandbox.Tools.Re.lit ">"])
      (text (a c 0)))),
  pureTwin (core "discord-channel" "isVoiceMessage") (fun c => .bool
    (get (a c 0) "duration_secs" != Twin.undefinedJson || get (a c 0) "waveform" != Twin.undefinedJson)),
  pureTwin (core "discord-channel" "mentionsDiscordBot") (fun c =>
    let data := a c 0
    let opts := a c 1
    .bool ((live (get opts "botUserId") && (items (get data "mentions")).any (fun v => get v "id" == get opts "botUserId")) ||
      (items (get data "mention_roles")).any (fun role => (items (get opts "mentionRoleIds")).contains role))),
  pureTwin (core "discord-channel" "isGatewayMessage") (fun c =>
    let data := a c 0
    let author := get data "author"
    .bool (["id", "channel_id", "content"].all (fun k => string (get data k)) &&
      (string (get data "guild_id") || get data "guild_id" == .null) &&
      ["id", "username"].all (fun k => string (get author k)) &&
      (get author "bot" == Twin.undefinedJson || (get author "bot").getBool?.isOk))),
  pureTwin (core "discord-channel" "toDiscordGatewayThread") (fun c =>
    let d := a c 0
    let thread := get d "thread"
    Json.mkObj ([("guildId", nullish (get d "guild_id") (.str "@me")),
      ("channelId", if live (get thread "id") && live (get thread "parent_id") then get thread "parent_id" else get d "channel_id")] ++
      if live (get thread "id") && live (get thread "parent_id") then [("threadId", get thread "id")] else [])),
  pureTwin (core "discord-channel" "toDiscordInteractionThread") (fun c =>
    let d := a c 0
    let channel := get d "channel"
    let thread := live (get channel "parent_id") && [10, 11, 12].contains (nat (get channel "type"))
    Json.mkObj ([("guildId", nullish (get d "guild_id") (.str "@me")),
      ("channelId", if thread then get channel "parent_id" else nullish (get d "channel_id") (.str "@me"))] ++
      if thread then [("threadId", nullish (get d "channel_id") (.str "@me"))] else [])),
  pureTwin (core "telegram-channel" "normalizeBotUsername") (fun c =>
    let s := jsTrim (text (a c 0))
    let s := if s.startsWith "@" then dropChars s 1 else s
    if s == "" then .null else .str s.toLower),
  pureTwin (core "telegram-channel" "telegramEntities") (fun c =>
    let m := a c 0
    nullish (get m (if get m "text" != Twin.undefinedJson then "entities" else "caption_entities")) (jarr [])),
  pureTwin (core "telegram-channel" "telegramMessageText") (fun c =>
    nullish (get (a c 0) "text") (nullish (get (a c 0) "caption") (.str ""))),
  pureTwin (core "telegram-channel" "extractInboundMessage") (fun c =>
    nullish (get (a c 0) "message") (nullish (get (a c 0) "edited_message") .null)),
  pureTwin (core "telegram-channel" "stickerText") (fun c =>
    .str (jsTrim s!"{text (get (a c 0) "emoji")} [sticker file_id: {text (get (a c 0) "file_id")}]")),
  pureTwin (core "whatsapp-channel" "replyText") (fun c =>
    let m := a c 0
    if get m "type" == .str "button" then get (get m "button") "text"
    else if get m "type" == .str "interactive" then
      nullish (get (get (get m "interactive") "button_reply") "title") (get (get (get m "interactive") "list_reply") "title")
    else Twin.undefinedJson),
  Twin.traced (core "whatsapp-channel" "toWhatsAppSource") (fun c => sourceFields c
    ["messageId", "phoneNumberId", "threadId", "userWaId"] ["userName"] "Invalid WhatsApp source payload"),
  Twin.traced (core "gchat-channel" "toGoogleChatSource") (fun c => sourceFields c
    ["messageName", "spaceName", "threadId"] ["threadName", "userId", "userName"] "Invalid Google Chat source payload"),
  pureTwin (core "gchat-channel" "addOnEvent") (fun c =>
    let e := a c 0
    if live (get (get e "chat") "messagePayload") then e
    else if get e "type" != .str "MESSAGE" || !live (get e "message") || !live (get e "space") then .null
    else Json.mkObj [("chat", Json.mkObj (
      (if live (get e "user") then [("user", get e "user")] else []) ++
      [("messagePayload", Json.mkObj [("message", get e "message"), ("space", get e "space")])]))]),
  pureTwin (core "gchat-channel" "googleChatIdentity") (fun c =>
    let space := a c 0
    let message := a c 1
    let dm := get space "type" == .str "DM" || get space "spaceType" == .str "DIRECT_MESSAGE"
    let thread := if dm then Twin.undefinedJson else nullish (get (get message "thread") "name") (get message "name")
    Json.mkObj ([("channelId", get space "name")] ++
      (if live thread then [("threadId", thread)] else []) ++
      ([ ("userId", get (get message "sender") "name"), ("userName", get (get message "sender") "displayName")].filter (fun p => live p.2)))),
  pureTwin (core "whatsapp-channel" "findInboundMessages") (fun c =>
    jarr ((items (get (a c 0) "entry")).flatMap fun entry =>
      (items (get entry "changes")).flatMap fun change =>
        let value := get change "value"
        if get change "field" != .str "messages" || get (get value "metadata") "phone_number_id" != a c 1 then [] else
        (items (get value "messages")).map fun message =>
          Json.mkObj ([("message", message)] ++
            match (items (get value "contacts")).find? (fun ct => get ct "wa_id" == get message "from") with
            | some contact => [("contact", contact)]
            | none => []))),
  Twin.traced (forwarder "connections" "combinePlaneAnswers") (fun c => do
    let answers := items (a c 1)
    if answers.all (· == .null) then
      return ← Prog.throwError "Error" ("No config plane answered: " ++ String.intercalate ", " ((items (a c 0)).map text))
    return jarr (answers.flatMap items)),
  pureTwin (forwarder "connections" "planeConnections") (fun c => jarr ((items (a c 1)).map fun row =>
    Json.mkObj [("agentId", get row "agentId"), ("agentName", get row "agentName"), ("botToken", get row "botToken"),
      ("webhookUrl", .str (text (get (a c 0) "webhookBaseUrl") ++ text (get row "webhookPath")))])),
  pureTwin (media "formatBytes") (fun c => .str s!"{(nat (a c 0) + 524288) / 1048576} MB"),
  pureTwin "packages/convex/model/cronRules.ts#isOneTimeSchedule" (fun c => .bool ((text (a c 0)).startsWith "at("))
]

private def nativePart (c : Json) : Prog Json := do
  let item := a c 0
  let source := a c 2
  if !live source then return .null
  let mediaType := get item "mediaType"
  if (text mediaType).startsWith "image/" then
    return Json.mkObj [("type", .str "image"), ("image", source), ("mediaType", mediaType)]
  let accepts ← Prog.effect "acceptsNativeMedia" [a c 1, mediaType]
  if !live accepts then return .null
  return Json.mkObj [("type", .str "file"), ("data", source), ("mediaType", mediaType), ("filename", get item "name")]

private def transcriptLine (c : Json) : Prog Json := do
  let item := a c 0
  let transcript := get item "transcript"
  if !live transcript then return .str ""
  if get transcript "status" == .str "transcribed" then
    return .str (if live (get transcript "text") then "\n  Transcript: " ++ text (get transcript "text") else "\n  Transcript: no speech in the recording.")
  let advice ← Prog.effect "transcriptAdvice" [get transcript "recovery", get item "path"]
  return .str s!"\n  Not transcribed: {text (get transcript "reason")}. {text advice}"

private def questionKeyboard (c : Json) : Prog Json := do
  let prompt := a c 0
  let questions := items (get prompt "questions")
  let mut rows := []
  for (question, qi) in questions.zipIdx do
    for (option, oi) in (items (get question "options")).zipIdx do
      let id ← Prog.effect "questionButtonId" [get prompt "statusId", toJson qi, toJson oi]
      let label := if questions.length == 1 then text (get option "label")
        else text (get question "header") ++ ": " ++ text (get option "label")
      rows := rows ++ [jarr [Json.mkObj [("text", .str label), ("callback_data", id)]]]
  return jarr rows

private def attachmentNote (c : Json) : Prog Json := do
  let mut lines := []
  for ingested in items (a c 0) do
    let item := get ingested "stored"
    let label := s!"- {text (get item "name")} ({text (get item "mediaType")}) "
    if live (get item "failure") then
      lines := lines ++ [label ++ "could not be read: " ++ text (get item "failure")]
    else
      let landed ← Prog.effect "whereItLanded" [item, get ingested "part", a c 2]
      let transcript ← Prog.effect "transcriptLine" [item]
      lines := lines ++ [label ++ text landed ++ text transcript]
  if nat (a c 1) > 0 then
    lines := lines ++ [s!"- {nat (a c 1)} further attachment(s) were left with the provider; this message carries at most 10."]
  if lines.isEmpty then return .null
  return .str (String.intercalate "\n" ([s!"Attachments received on {text (a c 2)}:"] ++ lines ++
    ["Open any file you have not been shown directly with your own tools before answering; do not ask the sender to paste its contents."]))

private def slackMention : Spec.Sandbox.Tools.Re :=
  seqs [lit "<@", .group 1 (plus (noneOf ">")), lit ">"]

private def thirdTwins : List Twin := [
  Twin.traced (media "nativePart") nativePart,
  Twin.traced (media "transcriptLine") transcriptLine,
  Twin.traced (media "attachmentNote") attachmentNote,
  Twin.traced (core "telegram-channel" "questionKeyboard") questionKeyboard,
  Twin.traced (core "channels" "readFetchedBytes") (fun _ => Prog.effect "fetchData"),
  Twin.traced (core "channels" "sendChannelFailure") (fun c => do
    if live (get (a c 0) "sendReplyButtons") then
      let _ ← Prog.effect "channel.sendReplyButtons" [a c 1, jstrs ["Retry"]]
      return Twin.undefinedJson
    let _ ← Prog.effect "channel.sendText" [.str (text (a c 1) ++ "\nReply \"retry\" to try again.")]
    return Twin.undefinedJson),
  Twin.traced (core "slack-channel" "sendSlackWebhookResponse") (fun c => do
    let result ← Prog.attempt "sendSlackResponseUrl" [a c 0, Json.mkObj (
      [("text", a c 1), ("responseType", .str "in_channel")] ++
      if live (a c 2) then [("blocks", a c 2)] else [])]
    match result with
    | .ok _ => return Twin.undefinedJson
    | .threw err _ =>
      if get (get err "$error") "name" == .str "SlackApiError" then
        Prog.throwError "Error" s!"Slack response_url failed ({nat (get (get (get err "$error") "fields") "status")})"
      else .fail err
    | .pending => Prog.unsupported "unfinished webhook request"),
  Twin.traced (core "slack-channel" "postSlackCard") (fun c => do
    let fallback ← Prog.effect "cardToFallbackText" [a c 2]
    let body := if live fallback then fallback else .str "Image"
    let blocks ← Prog.effect "cardToBlockKit" [a c 2]
    let source := a c 1
    if live (get source "responseUrl") then
      let _ ← Prog.effect "sendSlackWebhookResponse" [get source "responseUrl", body, blocks]
      return Twin.undefinedJson
    let _ ← Prog.effect "postSlackMessage" [Json.mkObj ((entries (a c 0)) ++ [
      ("channel", get source "channelId"), ("text", body), ("blocks", blocks)] ++
      (if get source "threadTs" != Twin.undefinedJson then [("threadTs", get source "threadTs")] else []) ++
      [("unfurlLinks", .bool false), ("unfurlMedia", .bool false)])]
    return Twin.undefinedJson),
  Twin.traced (core "slack-channel" "taskId") (fun c => do
    let id ← Prog.effect "stringValue" [a c 1]
    return .str (text (a c 0) ++ ":" ++ text (nullish id (.str "default")))),
  Twin.traced (core "slack-channel" "resolveSlackUserName") (fun c => do
    let resolved ← Prog.effect "resolveUserName" [a c 0]
    let name ← Prog.effect "cleanSlackName" [resolved]
    return if live name then name else a c 0),
  Twin.traced (core "slack-channel" "isSupportedSlackEvent") (fun c => do
    let e := a c 0
    if live (get e "bot_id") || (live (get e "subtype") && get e "subtype" != .str "file_share") then return .bool false
    if get e "type" == .str "app_mention" then return .bool true
    if get e "type" != .str "message" then return .bool false
    Prog.effect "isSupportedSlackMessageChannel" [get e "channel_type"]),
  Twin.traced (core "slack-channel" "mentionsSlackBot") (fun c => do
    let ids ← Prog.effect "getSlackBotUserIds" [a c 1]
    let known := items (get ids "$set")
    if known.isEmpty then return .bool false
    let mentioned ← Prog.effect "hasSlackMention" [a c 0]
    if !live mentioned then return .bool false
    return .bool ((allGroups slackMention (text (a c 0))).any (fun id => known.contains (.str id)))),
  pureTwin (core "telegram-channel" "hasTelegramMedia") (fun c => .bool
    (!(items (get (a c 0) "photo")).isEmpty ||
      ["audio", "document", "rich_message", "sticker", "video", "video_note", "voice"].any (fun k => live (get (a c 0) k)))),
  pureTwin (core "telegram-channel" "repliesToTelegramBot") (fun c =>
    let author := get (get (a c 0) "reply_to_message") "from"
    .bool (get author "is_bot" == .bool true && string (get author "username") &&
      (text (get author "username")).toLower == text (a c 1))),
  Twin.traced (core "telegram-channel" "telegramCommandToken") (fun c => do
    let entities ← Prog.effect "telegramEntities" [a c 0]
    let some entity := (items entities).find? (fun e => get e "type" == .str "bot_command" && get e "offset" == toJson (0 : Nat))
      | return Twin.undefinedJson
    let content ← Prog.effect "telegramMessageText" [a c 0]
    let parts := (utake (text content) (nat (get entity "length"))).splitOn "@"
    let target := parts[1]?.getD ""
    if target != "" && live (a c 1) && target.toLower != text (a c 1) then return Twin.undefinedJson
    return .str (parts.headD "")),
  Twin.traced (core "telegram-channel" "mentionsTelegramBot") (fun c => do
    let content ← Prog.effect "telegramMessageText" [a c 0]
    let entities ← Prog.effect "telegramEntities" [a c 0]
    return .bool ((items entities).any fun e =>
      let start := nat (get e "offset")
      let end_ := start + nat (get e "length")
      let value := (dropChars (utake (text content) end_) (utake (text content) start).length).toLower
      if get e "type" == .str "mention" then value == "@" ++ text (a c 1)
      else if get e "type" != .str "bot_command" then false
      else (value.splitOn "@")[1]?.isNone || (value.splitOn "@")[1]? == some (text (a c 1)))),
  Twin.traced (core "telegram-channel" "addressesTelegramBot") (fun c => do
    if live (get (get (a c 0) "from") "is_bot") then return .bool false
    if get (get (a c 0) "chat") "type" == .str "private" then return .bool true
    let mentions ← Prog.effect "mentionsTelegramBot" [a c 0, a c 1]
    if live mentions then return .bool true
    Prog.effect "repliesToTelegramBot" [a c 0, a c 1]),
  Twin.traced (core "telegram-channel" "postTelegramAttachments") (fun c => do
    let attachments := items (a c 2)
    for idx in List.range ((attachments.length + 9) / 10) do
      let _ ← Prog.effect "transport.postMessage" [a c 1, Json.mkObj [
        ("raw", if idx == 0 then nullish (a c 3) (.str "") else .str ""),
        ("attachments", jarr ((attachments.drop (idx * 10)).take 10))]]
    return Twin.undefinedJson),
  Twin.traced (core "discord-channel" "BroodsDiscordAdapter.parseCommand") (fun c =>
    Prog.effect "this.parseSlashCommand" [a c 0, a c 1]),
  Twin.traced (core "discord-channel" "BroodsDiscordAdapter.runWithSlashCommandContext") (fun c =>
    Prog.effect "this.requestContext.run" [Json.mkObj [("slashCommand", a c 0)], a c 1]),
  Twin.traced (core "whatsapp-channel" "BroodsWhatsAppAdapter.verifyWebhookSignature") (fun c =>
    Prog.effect "this.verifySignature" [a c 0, nullish (a c 1) .null]),
  Twin.traced (core "whatsapp-channel" "BroodsWhatsAppAdapter.sendTypingIndicator") (fun c => do
    let _ ← Prog.effect "this.graphApiRequest" [
      .str ("/" ++ text (Twin.field (Twin.self c) "phoneNumberId") ++ "/messages"),
      Json.mkObj [("messaging_product", .str "whatsapp"), ("status", .str "read"), ("message_id", a c 0),
        ("typing_indicator", Json.mkObj [("type", .str "text")])]]
    return Twin.undefinedJson),
  Twin.traced (core "discord-channel" "discordMediaType") (fun c => do
    let voice ← Prog.effect "isVoiceMessage" [a c 0]
    return if live voice then Twin.undefinedJson else get (a c 0) "content_type"),
  Twin.traced (core "discord-channel" "discordAttachmentType") (fun c => do
    let voice ← Prog.effect "isVoiceMessage" [a c 0]
    if live voice then return .str "audio"
    return .str (if (text (a c 1)).startsWith "image/" then "image" else
      if (text (a c 1)).startsWith "video/" then "video" else
      if (text (a c 1)).startsWith "audio/" then "audio" else "file")),
  Twin.traced (media "mediaReferenceOf") (fun c =>
    let p := a c 0
    if get p "type" == .str "image" then Prog.effect "parseMediaReference" [get p "image"]
    else if get p "type" == .str "file" then Prog.effect "parseMediaReference" [get p "data"] else pure .null),
  Twin.traced (media "isStoredMediaPart") (fun c => do
    let reference ← Prog.effect "mediaReferenceOf" [a c 0]
    if reference != .null then return .bool true
    let sealed ← Prog.effect "sealedMediaLink" [a c 0]
    return .bool (sealed != .null)),
  Twin.traced (media "sealedImageLink") (fun c =>
    if get (a c 0) "type" == .str "image" then Prog.effect "sealedMediaLink" [a c 0] else pure .null),
  Twin.traced (media "assertWithinLimit") (fun c => do
    let limit ← Prog.effect "limitForMediaType" [if (a c 1) == .null then Twin.undefinedJson else a c 1]
    if nat (a c 0) > nat limit then
      return ← Prog.throwError "Error" s!"file is larger than {(nat limit + 524288) / 1048576} MB"
    return Twin.undefinedJson),
  Twin.traced (media "audioTranscript") (fun c => do
    if !live (a c 2) || !(text (a c 1)).startsWith "audio/" then return Twin.undefinedJson
    let accepts ← Prog.effect "acceptsNativeMedia" [get (get (a c 2) "model") "provider", a c 1]
    if live accepts then return Twin.undefinedJson
    Prog.effect "transcribeAudio" [a c 2, a c 0, toJson (0 : Nat)]),
  pureTwin (forwarder "supervisor" "groupConnectionsByToken") (fun c =>
    let rows := items (a c 0)
    let tokens := uniq (rows.map (fun r => get r "botToken"))
    Json.mkObj [("$map", jarr (tokens.map fun token => jarr [token, jarr
      ((rows.filter (fun r => get r "botToken" == token)).map fun r => Json.mkObj
        [("agentId", get r "agentId"), ("agentName", get r "agentName"), ("webhookUrl", get r "webhookUrl")])]))]),
  pureTwin (core "discord-channel" "gatewayAck") (fun _ => Json.mkObj [
    ("kind", .str "response"), ("response", Json.mkObj [("statusCode", toJson (200 : Nat)),
      ("headers", Json.mkObj [("Content-Type", .str "application/json")]), ("body", .str "{\"ok\":true}")])]),
  pureTwin (core "discord-channel" "unsupportedInteractionResponse") (fun _ => Json.mkObj [
    ("kind", .str "response"), ("response", Json.mkObj [("statusCode", toJson (200 : Nat)),
      ("headers", Json.mkObj [("Content-Type", .str "application/json")]),
      ("body", .str "{\"type\":4,\"data\":{\"content\":\"Unsupported interaction.\",\"flags\":64}}")])])
]


private def obj (pairs : List (String × Json)) : Json :=
  Json.mkObj (pairs.filter (fun p => p.2 != Twin.undefinedJson))

private def headerOf (response : Json) (name : String) : Option String :=
  ((items (get (get response "$response") "headers")).find?
    (fun h => text (Twin.arg h 0) == name)).map (fun h => text (Twin.arg h 1))

private def statusOf (response : Json) : Nat := nat (get (get response "$response") "status")

/-- `Number(header) * 1000` for decimal seconds with at most millisecond precision. `none` is NaN. -/
private def retryMillis? (value : String) : Option Nat :=
  match value.splitOn "." with
  | [""] => some 0
  | [whole] => whole.toNat?.map (· * 1000)
  | [whole, fraction] =>
    if fraction.length > 3 || fraction.isEmpty then none else
    let scaled := fraction ++ String.ofList (List.replicate (3 - fraction.length) '0')
    match (if whole.isEmpty then some 0 else whole.toNat?), scaled.toNat? with
    | some w, some f => some (w * 1000 + f)
    | _, _ => none
  | _ => none

private def replaceFirst (re : Spec.Sandbox.Tools.Re) (s : String) : String :=
  let chars := s.toList.toArray
  match Spec.Sandbox.Tools.Re.execFrom re chars 0 with
  | none => s
  | some found =>
    String.ofList (chars.toList.take found.start) ++ String.ofList (chars.toList.drop found.stop)

private def numFloat (v : Json) : Float :=
  match v.getNum? with
  | .ok n => n.toFloat
  | .error _ => 0

private def backoff (c : Json) : Prog Json := do
  let random ← Prog.effect "random"
  let attempt := numFloat (a c 0)
  let growth := 1000 * Float.pow 2 (if attempt < 0 then 0 else attempt)
  let ceiling := numFloat (a c 1)
  let capped := if ceiling < growth then ceiling else growth
  let exact := capped - capped * 0.2 * numFloat random
  return toJson (Float.floor (exact + 0.5)).toUInt64.toNat

private def stickerExtension (sticker : Json) : Option String :=
  if !live (get sticker "id") then none else
  match nat (nullish (get sticker "format_type") (toJson (1 : Nat))) with
  | 1 | 2 => some "png"
  | 4 => some "gif"
  | _ => none

private def discordStickersValue (stickers : Json) : Json :=
  jarr ((items stickers).filterMap fun sticker =>
    (stickerExtension sticker).map fun extension =>
      Json.mkObj [("type", .str "image"),
        ("url", .str s!"https://media.discordapp.net/stickers/{text (get sticker "id")}.{extension}"),
        ("name", .str s!"{text (nullish (get sticker "name") (.str "sticker"))}.{extension}"),
        ("mimeType", .str (if extension == "gif" then "image/gif" else "image/png")),
        ("fetchData", Json.mkObj [("$fn", .str "fetchData")])])

private def scalarText (v : Json) : String :=
  match v with
  | .str s => s
  | other => other.compress

private def telegramEnvelopeValue (c : Json) : Json :=
  let message := a c 0
  let parsed := a c 1
  let sender := a c 2
  let chatId := get (get message "chat") "id"
  let topic := get message "message_thread_id"
  Json.mkObj [
    ("source", obj [("chatId", chatId), ("messageId", Twin.field parsed "id"),
      ("messageThreadId", topic), ("threadId", Twin.field parsed "threadId"),
      ("fromUserId", get sender "id"), ("fromUsername", get sender "username")]),
    ("identity", obj [("channelId", .str (scalarText chatId)),
      ("threadId", if topic == Twin.undefinedJson then topic else .str (scalarText topic)),
      ("userId", if live (get sender "id") then .str (scalarText (get sender "id")) else Twin.undefinedJson),
      ("userName", if live (get sender "username") then get sender "username" else Twin.undefinedJson)])]

private def assertSlackUrl (c : Json) : Prog Json :=
  match parseUrl (text (a c 0)) with
  | .invalid => Prog.unsupported "URL constructor message"
  | .unknown => Prog.unsupported "URL syntax beyond shared parser"
  | .ok url =>
    if url.protocol != "https:" then
      Prog.throwError "Error" s!"refusing to send the Slack token over {url.protocol}"
    else
      let host := url.hostname.toLower
      if host != "slack.com" && ![".slack.com", ".slack-edge.com", ".slack-files.com"].any (fun suffix => host.endsWith suffix) then
        Prog.throwError "Error" s!"refusing to send the Slack token to {host}"
      else Prog.unsupported "URL instance result"

private def mediaSafeName (name : String) : Option String :=
  if name.toList.any (fun ch => ch.toNat > 127) then none else
  let allowed := fun (ch : Char) => ch.isAlphanum || ['.', '_', '-'].contains ch
  let collapsed := (name.toList.foldl (fun (acc : List Char × Bool) ch =>
    if allowed ch then (ch :: acc.1, false)
    else if acc.2 then acc else ('-' :: acc.1, true)) ([], false)).1.reverse
  let trimmed := (collapsed.dropWhile (· == '-')).reverse.dropWhile (· == '-') |>.reverse
  some (String.ofList (trimmed.take 80))

private def mediaPathValue (c : Json) : Prog Json := do
  let _ ← Prog.effect "createHash" [.str "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\") .update" [a c 1]
  let digest ← Prog.effect "createHash(\"sha256\") .update(eventId) .digest" [.str "hex"]
  let some safe := mediaSafeName (text (a c 0))
    | return ← Prog.unsupported "Unicode letters in a media name"
  let folder := String.ofList ((text digest).toList.take 12)
  return .str s!"media/{folder}/{nat (a c 2)}-{if safe.isEmpty then "attachment" else safe}"

private def mediaFileNameValue (c : Json) : Prog Json := do
  let att := a c 0
  if live (get att "name") then return get att "name"
  let extension ← Prog.effect "mediaTypeToExtension" [a c 1]
  let suffix := if live extension then "." ++ text extension else ""
  return .str s!"{text (get att "type")}-{nat (a c 2) + 1}{suffix}"

private def nowOf (c : Json) : Option Json :=
  let now := if a c 1 == Twin.undefinedJson then Twin.param c 1 else a c 1
  if now == Twin.undefinedJson then none else some now

private def trimEndChars (chars : List Char) : List Char :=
  (chars.reverse.dropWhile Char.isWhitespace).reverse

/-- `withReplyContext` past its guards. `slice` counts UTF-16 units, so astral text is not modelled. -/
private def replyContext (body replied : Json) : Prog Json :=
  let quoted := jsTrim (text (Twin.field replied "text"))
  let quoteMax := 500
  if quoted.toList.any (fun ch => ch.toNat > 0xFFFF) then
    Prog.unsupported "a quote with astral characters needs UTF-16 slicing"
  else
    let from_ := String.ofList
      ((text (get (Twin.field replied "author") "fullName")).toList.filter (· != '"'))
    let shortened := if quoted.length > quoteMax
      then String.ofList (trimEndChars (quoted.toList.take quoteMax)) ++ "..."
      else quoted
    pure (.str s!"<replying-to from=\"{from_}\">\n{shortened}\n</replying-to>\n\n{text body}")

private def budgetLive (c : Json) (body : List Json → Nat → Nat → Json) : Prog Json := do
  let some now := nowOf c | return ← Prog.unsupported "the default clock is not recorded"
  let stamps ← Prog.effect "this.live" [a c 0, now]
  let self := Twin.self c
  return body (items stamps) (nat (Twin.field self "limit")) (nat (Twin.field self "windowMs"))

private def postAttempts (target body token : Json) : Nat → Nat → Option Nat → Prog Json
  | 0, _, _ => pure Twin.undefinedJson
  | remaining + 1, attempt, retry => do
    if attempt > 1 then
      let delay ← match retry with
        | some ms => pure (toJson (min ms 4000))
        | none => Prog.effect "backoffDelayMs" [toJson (attempt - 2), toJson (4000 : Nat)]
      let _ ← Prog.effect "Bun.sleep" [delay]
    let last := attempt == 3
    let signal ← Prog.effect "AbortSignal.timeout" [toJson (10000 : Nat)]
    let outcome ← Prog.attempt "fetch" [get target "webhookUrl", Json.mkObj [
      ("method", .str "POST"),
      ("headers", Json.mkObj [("Content-Type", .str "application/json"),
        ("x-discord-gateway-token", token)]),
      ("body", body), ("redirect", .str "error"), ("signal", signal)]]
    match outcome with
    | .pending => Prog.unsupported "unfinished forward"
    | .threw _ _ =>
      if last then
        let _ ← Prog.effect "tokenHint" [token]
      postAttempts target body token remaining (attempt + 1) none
    | .ok response =>
      let status := statusOf response
      if 200 ≤ status && status < 300 then return Twin.undefinedJson
      let retryable := status ≥ 500 || status == 408 || status == 429
      if last || !retryable then
        let _ ← Prog.effect "tokenHint" [token]
        return Twin.undefinedJson
      let next := (headerOf response "retry-after").bind retryMillis?
      postAttempts target body token remaining (attempt + 1) next

private def fetchChannel (c : Json) : Prog Json := do
  Spec.Channels.Wavechannels8a.threadInFlightStarted (Twin.self c) (a c 0)
  let signal ← Prog.effect "AbortSignal.timeout" [toJson (10000 : Nat)]
  let id := text (a c 0)
  let response ← Prog.effect "fetch" [.str s!"https://discord.com/api/v10/channels/{id}",
    Json.mkObj [("headers", Json.mkObj
      [("Authorization", .str s!"Bot {text (Twin.field (Twin.self c) "botToken")}")]),
      ("signal", signal)]]
  let status := statusOf response
  if 200 ≤ status && status < 300 then return ← Prog.effect "response.json"
  if status == 429 && !live (a c 1) then
    let waited := ((headerOf response "retry-after").bind retryMillis?).getD 0
    let delay := if waited == 0 then 1000 else waited
    let _ ← Prog.effect "Bun.sleep" [toJson (min 10000 delay)]
    return ← Prog.effect "this.fetchChannel" [a c 0, .bool true]
  Prog.throwError "Error" s!"Discord channel {id} lookup failed: HTTP {status}"

private def questionClick (c : Json) : Prog Json := do
  let payload := a c 0
  let action := (items (get payload "actions")).headD Twin.undefinedJson
  let answer ← Prog.effect "parseQuestionButtonId" [get action "actionId"]
  let channelId := get payload "channelId"
  let teamId := get payload "teamId"
  if action == Twin.undefinedJson || !live answer || !live channelId || !live teamId then
    return Json.mkObj [("kind", .str "ignore"), ("reason", .str "unsupported_slack_action")]
  let notAllowed := Json.mkObj [("kind", .str "ignore"), ("reason", .str "not allowed")]
  let channelOk ← Prog.effect "isAllowedId" [a c 1, channelId]
  if !live channelOk then return notAllowed
  let userOk ← Prog.effect "isAllowedId" [a c 2, get payload "userId"]
  if !live userOk then return notAllowed
  let label := nullish (get action "label") (.str "Answered")
  if live (get payload "responseUrl") then
    let blocks ← Prog.effect "answeredSlackInputBlocks" [obj [("answer", label),
      ("promptBlock", get payload "messagePromptBlock"), ("userId", get payload "userId")]]
    Prog.spawn "sendSlackResponseUrl" [get payload "responseUrl", Json.mkObj
      [("replaceOriginal", .bool true), ("text", label), ("blocks", blocks)]]
  let value := get action "value"
  let channel := text channelId
  let team := text teamId
  let thread := if channel.startsWith "D" || value == .str "channel" then Twin.undefinedJson
    else nullish value (get payload "threadTs")
  let hasThread := live thread
  let threadPairs (keys : List String) : List (String × Json) :=
    if hasThread then keys.map (fun k => (k, thread)) else []
  let source := obj ([("teamId", teamId), ("channelId", channelId)] ++
    threadPairs ["threadTs", "inThreadTs"] ++ [("userId", get payload "userId")])
  let trigger := nullish (get payload "triggerId") (get payload "messageTs")
  return Json.mkObj [("kind", .str "message"),
    ("ack", Json.mkObj [("statusCode", toJson (200 : Nat))]),
    ("message", Json.mkObj [
      ("eventId", .str s!"slack:{team}:{channel}:action:{text trigger}"),
      ("conversationKey", .str (if hasThread then s!"slack:{team}:{channel}:{text thread}"
        else s!"slack:{team}:{channel}")),
      ("channelName", .str "slack"), ("content", .str "[button answer]"),
      ("identity", obj ([("workspaceRef", teamId), ("channelId", channelId)] ++
        threadPairs ["threadId"] ++ [("userId", get payload "userId")] ++
        (if live (get payload "userName") then [("userName", get payload "userName")] else []))),
      ("source", source), ("answer", answer)])]

private def slashCommand (c : Json) : Prog Json := do
  let payload := a c 0
  let teamId := get payload "teamId"
  let channelId := get payload "channelId"
  let command := get payload "command"
  let ignore := fun (reason : String) => Json.mkObj [("kind", .str "ignore"), ("reason", .str reason)]
  if !live teamId || !live channelId || !live command then return ignore "invalid_slash_command"
  let channelOk ← Prog.effect "isAllowedId" [a c 1, channelId]
  if !live channelOk then return ignore "slash_command_channel_not_allowed"
  let userOk ← Prog.effect "isAllowedId" [a c 2, get payload "userId"]
  if !live userOk then return ignore "slash_command_user_not_allowed"
  let body := nullish (get payload "text") (.str "")
  let scope := s!"{text teamId}:{text channelId}"
  let trigger := if missing (get payload "triggerId")
    then s!"{scope}:{text command}:{text body}" else text (get payload "triggerId")
  return Json.mkObj [("kind", .str "message"),
    ("ack", Json.mkObj [("statusCode", toJson (200 : Nat))]),
    ("message", Json.mkObj [
      ("eventId", .str ("slack-command:" ++ trigger)),
      ("conversationKey", .str ("slack:" ++ scope)),
      ("channelName", .str "slack"),
      ("content", jarr [Json.mkObj [("type", .str "text"), ("text", body)]]),
      ("identity", obj ([("workspaceRef", teamId), ("channelId", channelId)] ++
        (if live (get payload "userId") then [("userId", get payload "userId")] else []))),
      ("source", obj [("teamId", teamId), ("channelId", channelId),
        ("responseUrl", get payload "responseUrl"), ("commandToken", command),
        ("userId", get payload "userId")])])]

private def parseInboundValue (c : Json) : Prog Json := do
  let inbound := a c 0
  let message := get inbound "message"
  let options := a c 2
  let ignore := fun (reason : String) => Json.mkObj [("kind", .str "ignore"), ("reason", .str reason)]
  if get message "type" == .str "reaction" then return ignore "no message for this number"
  let sender := get message "from"
  if !live sender then return ignore "no sender phone number"
  let channelOk ← Prog.effect "isAllowedId" [get options "allowedChannelIds", sender]
  if !live channelOk then return ignore "not allowed"
  let userOk ← Prog.effect "isAllowedId" [get options "allowedUserIds", sender]
  if !live userOk then return ignore "not allowed"
  let parsed ← Prog.effect "transport.parseMessage" [obj [("contact", get inbound "contact"),
    ("message", message), ("phoneNumberId", get options "phoneNumberId")]]
  let reply ← Prog.effect "replyText" [message]
  let body := nullish reply (Twin.field parsed "text")
  if !live body then return ← Prog.unsupported "parsed.attachments is not recorded"
  let inboundMessage ← Prog.effect "toInboundMessage" [message, sender, parsed, body]
  return Json.mkObj [("kind", .str "message"), ("redelivers", .bool true),
    ("message", inboundMessage)]

private def slackAttachmentsValue (c : Json) : Prog Json := do
  let mut out : List Json := []
  for file in items (a c 0) do
    let url := get file "url_private"
    if live url then
      let mime ← Prog.effect "slackFileMediaType" [file]
      let kind ← Prog.effect "slackAttachmentType" [mime]
      out := out ++ [obj [("type", kind), ("url", url),
        ("name", if live (get file "name") then get file "name" else Twin.undefinedJson),
        ("mimeType", if live mime then mime else Twin.undefinedJson),
        ("size", get file "size"), ("width", get file "original_w"),
        ("height", get file "original_h"),
        ("fetchData", Json.mkObj [("$fn", .str "fetchData")])]]
  return jarr out

private def discordAttachmentsValue (c : Json) : Prog Json := do
  let data := a c 0
  let mut out : List Json := []
  for attachment in items (get data "attachments") do
    let url := get attachment "url"
    if live url then
      let mime ← Prog.effect "discordMediaType" [attachment]
      let kind ← Prog.effect "discordAttachmentType" [attachment, mime]
      out := out ++ [obj [("type", kind), ("url", url),
        ("name", if live (get attachment "filename") then get attachment "filename" else Twin.undefinedJson),
        ("mimeType", if live mime then mime else Twin.undefinedJson),
        ("size", get attachment "size"), ("width", get attachment "width"),
        ("height", get attachment "height"),
        ("fetchData", Json.mkObj [("$fn", .str "fetchData")])]]
  let stickers ← Prog.effect "discordStickers" [nullish (get data "sticker_items") (jarr [])]
  return jarr (out ++ items stickers)

private def normalizeMentions (c : Json) : Prog Json := do
  let content := text (a c 0)
  let omitted := items (get (a c 1) "$set")
  let ids := uniq ((allGroups slackMention content).filter (!·.isEmpty))
  let wanted := ids.filter (fun id => !omitted.contains (.str id))
  let outcomes ← if wanted.isEmpty then pure [] else
    Prog.all (wanted.map fun id => ("resolveSlackUserName", [.str id, a c 2]))
  let mut names : List (String × String) := []
  for (id, outcome) in wanted.zip outcomes do
    match outcome with
    | .ok name => names := names ++ [(id, text name)]
    | .threw error _ => return ← Prog.fail error
    | .pending => return ← Prog.unsupported "unfinished name lookup"
  let chars := content.toList.toArray
  let replaced := replaceMatches slackMention content (fun found =>
    let id := (groupText chars found 1).getD ""
    if omitted.contains (.str id) then ""
    else "@" ++ ((names.find? (·.1 == id)).map (·.2)).getD id)
  Prog.effect "cleanSlackText" [.str replaced]

private def formatSlackText (c : Json) : Prog Json := do
  let normalized ← Prog.effect "normalizeSlackMentions" [a c 0, a c 3, a c 4]
  if !live (a c 2) || !live (a c 1) || !live normalized then return normalized
  let command ← Prog.effect "parseCommand" [normalized]
  if live command then return normalized
  let name ← Prog.effect "resolveSlackUserName" [a c 1, a c 4]
  return .str s!"{text name}: {text normalized}"

private def sealedLink (c : Json) : Prog Json := do
  let base ← Prog.effect "getHarnessPublicUrl"
  if !live base then
    return Twin.undefinedJson
  let secrets ← Prog.effect "requireSecretsEnv" [.str "MEDIA_TICKET_SECRET"]
  let token ← Prog.effect "sealMediaTicket" [a c 0, (items secrets).headD Twin.undefinedJson]
  return .str s!"{text base}/v1/media/{text token}"

private def sealedInMessage (part : Json) : Json :=
  let kind := text (get part "type")
  let value := get part (if kind == "image" then "image" else "data")
  if ["image", "file"].contains kind && string value &&
    ((text value).splitOn "/v1/media/").length > 1 then value else .null

private def sealedInTool (part : Json) : Json :=
  let value := get part "url"
  if get part "type" == .str "file-url" && (text (get part "mediaType")).startsWith "image" &&
    ((text value).splitOn "/v1/media/").length > 1 then value else .null

private def imageLinksValue (c : Json) : Prog Json := do
  let message := a c 0
  let role := get message "role"
  let links ←
    if role == .str "user" && !string (get message "content") then
      pure ((items (get message "content")).map fun part =>
        if get part "type" == .str "image" then sealedInMessage part else .null)
    else if role == .str "tool" then do
      let parts ← Prog.effect "toolContentItems" [message]
      pure ((items parts).map sealedInTool)
    else pure []
  return jarr (links.filter (· != .null))

private def fourthTwins : List Twin := [
  Twin.traced (core "channels" "formatChannelErrorText") (fun c => do
    let commands ← Prog.effect "supportsInlineCommands" [a c 1]
    let simple ← Prog.effect "simplifyErrorText" [a c 0, commands]
    return .str ("⚠️ " ++ text simple)),
  Twin.traced (forwarder "backoff" "backoffDelayMs") backoff,
  pureTwin (core "discord-channel" "discordStickers") (fun c => discordStickersValue (a c 0)),
  pureTwin (core "telegram-channel" "telegramEnvelope") telegramEnvelopeValue,
  Twin.traced (core "telegram-channel" "withReplyContext") (fun c =>
    if a c 1 == Twin.undefinedJson then pure (a c 0)
    else if (jsTrim (text (Twin.field (a c 1) "text"))).isEmpty then pure (a c 0)
    else replyContext (a c 0) (a c 1)),
  Twin.traced (core "slack-channel" "assertSlackFileUrl") assertSlackUrl,
  Twin.traced (media "mediaPath") mediaPathValue,
  Twin.traced (media "mediaFileName") mediaFileNameValue,
  pureTwin (core "slack-channel" "formatToolOutput") (fun c =>
    let value := a c 0
    if missing value then .str "" else if string value then value
    else match value with
      | .obj _ => Json.mkObj [("$unsupported", .str "object key order is not recorded")]
      | other => .str other.compress),
  pureTwin (core "whatsapp-channel" "handshakeParams") (fun c =>
    Json.mkObj [("$params", jarr ((formPairs (text (get (a c 0) "rawQueryString"))).map
      fun p => jstrs [p.1, p.2]))]),
  Twin.traced "packages/convex/model/cronRules.ts#runPayloadToEvents" (fun c =>
    let payload := a c 0
    let hasInput := get payload "input" != Twin.undefinedJson
    let hasEvents := get payload "events" != Twin.undefinedJson
    if hasInput == hasEvents then do
      let error ← Prog.effect "new ClientError" [.str "Provide exactly one of input or events"]
      Prog.fail error
    else if hasInput then
      if string (get payload "input") then
        pure (jarr [Json.mkObj [("role", .str "user"), ("content", jarr
          [Json.mkObj [("type", .str "text"), ("text", get payload "input")]])]])
      else Prog.unsupported "String() of a non-string input"
    else pure (get payload "events")),
  Twin.traced "packages/convex/model/cronRules.ts#timezoneFormatter" (fun c =>
    let cached := (items (get (Twin.moduleValue c "timezoneFormatters") "$map")).find?
      fun entry => Twin.arg entry 0 == a c 0
    match cached with
    | some entry => pure (Twin.arg entry 1)
    | none => do
      let formatter ← Prog.effect "new Intl.DateTimeFormat" [.str "en-US", Json.mkObj [
        ("timeZone", a c 0), ("hour12", .bool false), ("year", .str "numeric"),
        ("month", .str "2-digit"), ("day", .str "2-digit"), ("hour", .str "2-digit"),
        ("minute", .str "2-digit"), ("second", .str "2-digit")]]
      let before := Twin.moduleValue c "timezoneFormatters"
      Spec.Channels.Wavechannels8a.stateChange "module.timezoneFormatters" before
        (Spec.Channels.Wavechannels8a.mapSet before (a c 0) formatter)
      return formatter),
  Twin.traced (forwarder "identify-budget" "IdentifyBudget.consume") (fun c => do
    let some now := nowOf c | return ← Prog.unsupported "the default clock is not recorded"
    let live ← Prog.effect "this.live" [a c 0, now]
    let self := Twin.self c
    let allowed := (items live).length < nat (Twin.field self "limit")
    let cutoff := (now.getInt?.toOption.getD 0) -
      (Twin.field self "windowMs").getInt?.toOption.getD 0
    let before := Twin.field self "stamps"
    let kept := (Spec.Channels.Wavechannels8a.mapEntries before).filter fun entry =>
      let stamps := items (Twin.arg entry 1)
      match stamps.getLast? with
      | none => false
      | some last => last.getInt?.toOption.getD 0 > cutoff
    let stamps := jarr (items live ++ if allowed then [now] else [])
    let after := Spec.Channels.Wavechannels8a.mapSet
      (Spec.Channels.Wavechannels8a.mapValue kept) (a c 0) stamps
    Spec.Channels.Wavechannels8a.stateChange "self.stamps" before after
    return .bool allowed),
  Twin.traced (forwarder "identify-budget" "IdentifyBudget.retryAt") (fun c =>
    budgetLive c fun stamps limit window =>
      match stamps with
      | oldest :: _ => if stamps.length < limit then .null else toJson (nat oldest + window)
      | [] => .null),
  Twin.traced (forwarder "identify-budget" "IdentifyBudget.remaining") (fun c =>
    budgetLive c fun stamps limit _ => toJson (limit - stamps.length)),
  Twin.traced (forwarder "forward" "post") (fun c =>
    postAttempts (a c 0) (a c 1) (a c 2) 3 1 none),
  Twin.traced (forwarder "threads" "ThreadDirectory.fetchChannel") fetchChannel,
  Twin.traced (forwarder "supervisor" "warnOnSharedToken") (fun c => do
    if (items (a c 1)).length < 2 then return Twin.undefinedJson
    let _ ← Prog.effect "tokenHint" [a c 0]
    return Twin.undefinedJson),
  Twin.traced (core "slack-channel" "parseQuestionClick") questionClick,
  Twin.traced (core "slack-channel" "parseSlashCommand") slashCommand,
  Twin.traced (core "whatsapp-channel" "parseInbound") parseInboundValue,
  Twin.traced (core "slack-channel" "slackAttachments") slackAttachmentsValue,
  Twin.traced (core "discord-channel" "discordAttachments") discordAttachmentsValue,
  Twin.traced (core "slack-channel" "normalizeSlackMentions") normalizeMentions,
  Twin.traced (core "slack-channel" "formatSlackMessageText") formatSlackText,
  Twin.traced (media "sealedLinkFor") sealedLink,
  Twin.traced (media "imageLinks") imageLinksValue
]

private def byteLength (value : Json) : Nat :=
  (Spec.Sandbox.Tools.fromBase64 (text (get value "$bytes"))).toList.length

private def anonymousFn : Json := Json.mkObj [("$fn", .str "")]

private def textPart (body : String) : Json :=
  Json.mkObj [("type", .str "text"), ("text", .str body)]

private def lookupThread (c : Json) : Prog Json := do
  let channel ← Prog.effect "this.fetchChannel" [a c 0]
  let thread :=
    if [10, 11, 12].contains (nat (get channel "type")) && live (get channel "parent_id") then
      Json.mkObj [("id", get channel "id"), ("parent_id", get channel "parent_id")]
    else .null
  let before := Twin.field (Twin.self c) "cache"
  Spec.Channels.Wavechannels8a.stateChange "self.cache" before
    (Spec.Channels.Wavechannels8a.threadCacheSet before (a c 0) thread)
  return thread

private def gatewayEvent (c : Json) : Prog Json := do
  let event := a c 1
  let kind := get event "type"
  if !string kind || !(text kind).startsWith "GATEWAY_" then return .null
  if kind != .str "GATEWAY_MESSAGE_CREATE" then return ← Prog.effect "gatewayAck"
  let data := get event "data"
  let valid ← Prog.effect "isGatewayMessage" [data]
  if !live valid then return ← Prog.effect "gatewayAck"
  let refuse := fun (reason : String) => do
    let ack ← Prog.effect "gatewayAck"
    return Json.mkObj [("kind", .str "ignore"), ("reason", .str reason),
      ("response", get ack "response")]
  let author := get data "author"
  if live (get author "bot") then return ← refuse "bot_message"
  if !live (get data "guild_id") then return ← refuse "dm_disabled"
  let userOk ← Prog.effect "isAllowedId" [a c 3, get author "id"]
  if !live userOk then return ← refuse "user_not_allowed"
  let thread ← Prog.effect "toDiscordGatewayThread" [data]
  let channelOk ← Prog.effect "isAllowedId" [a c 2, get thread "channelId"]
  if !live channelOk then return ← refuse "channel_not_allowed"
  let threadId ← Prog.effect "discord.encodeThreadId" [thread]
  let attachments ← Prog.effect "discordAttachments" [data]
  let noFiles := (items attachments).isEmpty
  let content := jsTrim (text (get data "content"))
  if content.isEmpty && noFiles then return ← refuse "empty_message"
  let options := a c 4
  let botUserId := get options "botUserId"
  let runAgent ←
    if !live botUserId then pure true
    else do
      let mentioned ← Prog.effect "mentionsDiscordBot" [data, options]
      pure (live mentioned)
  let omitted := Json.mkObj [("$set", jarr (if live botUserId && runAgent then [botUserId] else []))]
  let body ← Prog.effect "formatDiscordMessageText" [.str content, data, omitted]
  if !live body && noFiles then return ← refuse "empty_message"
  let inThread := live (get thread "threadId")
  let name := if live (get author "global_name") then get author "global_name" else get author "username"
  let source := obj ([("applicationId", .str "broods-discord-gateway"), ("guildId", get data "guild_id"),
    ("channelId", get thread "channelId")] ++ (if inThread then [("threadId", threadId)] else []) ++
    [("messageId", get data "id"), ("userId", get author "id")])
  let ack ← Prog.effect "gatewayAck"
  return Json.mkObj [("kind", .str (if runAgent then "message" else "context")),
    ("ack", get ack "response"),
    ("message", Json.mkObj ([
      ("eventId", .str ("discord:" ++ text (get data "id"))), ("conversationKey", threadId),
      ("channelName", .str "discord"),
      ("content", jarr [Json.mkObj [("type", .str "text"), ("text", body)]])] ++
      (if noFiles then [] else [("attachments", attachments)]) ++ [
      ("identity", obj ([("workspaceRef", get data "guild_id"), ("channelId", get thread "channelId")] ++
        (if inThread then [("threadId", get thread "threadId")] else []) ++
        [("userId", get author "id")] ++ (if live name then [("userName", name)] else []))),
      ("source", source)]))]

private def eventCallback (c : Json) : Prog Json := do
  let parsed ← Prog.effect "parseChannelWebhookBody" [.str "slack", a c 0]
  if get parsed "kind" == .str "ignore" then return parsed
  let payload := get parsed "payload"
  let ignore := fun (reason : String) => Json.mkObj [("kind", .str "ignore"), ("reason", .str reason)]
  if get payload "type" == .str "url_verification" && string (get payload "challenge") then
    return Json.mkObj [("kind", .str "response"), ("reason", .str "url_verification"),
      ("response", Json.mkObj [("statusCode", toJson (200 : Nat)),
        ("headers", Json.mkObj [("Content-Type", .str "application/json")]),
        ("body", .str (Json.mkObj [("challenge", get payload "challenge")]).compress)])]
  let event := get payload "event"
  if get payload "type" != .str "event_callback" then return ignore "invalid_event_callback"
  let isMessage ← Prog.effect "isSlackMessageEvent" [event]
  if !live isMessage || !live (get payload "event_id") || !live (get payload "team_id") then
    return ignore "invalid_event_callback"
  let supported ← Prog.effect "isSupportedSlackEvent" [event]
  if !live supported then
    let reason ← Prog.effect "getUnsupportedSlackEventReason" [event]
    return Json.mkObj [("kind", .str "ignore"), ("reason", reason)]
  let channelId := get event "channel"
  let ts := get event "ts"
  if !live channelId || !live ts then return ignore "missing_channel_or_timestamp"
  let channelOk ← Prog.effect "isAllowedId" [a c 2, channelId]
  if !live channelOk then return ignore "channel_not_allowed"
  let user := get event "user"
  let userOk ← Prog.effect "isAllowedId" [a c 3, user]
  if !live userOk then return ignore "user_not_allowed"
  let content := nullish (get event "text") (.str "")
  let kind := get event "type"
  if kind == .str "message" then
    let mentioned ← Prog.effect "mentionsSlackBot" [content, payload]
    if live mentioned then return ignore "message_with_mention_wait_for_app_mention"
  let channelType := get event "channel_type"
  let direct := channelType == .str "im" || channelType == .str "app_home"
  let runAgent := kind == .str "app_mention" || direct
  let botIds ← if runAgent then Prog.effect "getSlackBotUserIds" [payload]
    else pure (Json.mkObj [("$set", jarr [])])
  let raw := if kind == .str "app_mention" && (items (get botIds "$set")).isEmpty
    then .str (replaceFirst (seqs [lit "<@", plus (noneOf ">"), lit ">", star space]) (text content))
    else content
  let body ← Prog.effect "formatSlackMessageText" [raw, user, .bool (!direct), botIds, a c 4]
  let threadTs := nullish (get event "thread_ts") ts
  let replyTs ← Prog.effect "getSlackReplyThreadTs" [event, ts]
  let userName ← if live user then Prog.effect "resolveSlackUserName" [user, a c 4]
    else pure Twin.undefinedJson
  let attachments ← Prog.effect "slackAttachments"
    [nullish (get event "files") (jarr []), a c 1]
  let team := get payload "team_id"
  let key ← Prog.effect "getSlackConversationKey" [team, channelId, event, threadTs]
  return Json.mkObj [("kind", .str (if runAgent then "message" else "context")),
    ("redelivers", .bool true), ("ack", Json.mkObj [("statusCode", toJson (200 : Nat))]),
    ("message", Json.mkObj ([
      ("eventId", .str s!"slack:{text team}:{text channelId}:{text ts}"),
      ("conversationKey", key), ("channelName", .str "slack"),
      ("content", jarr [Json.mkObj [("type", .str "text"), ("text", body)]])] ++
      (if (items attachments).isEmpty then [] else [("attachments", attachments)]) ++ [
      ("identity", obj ([("workspaceRef", team), ("channelId", channelId)] ++
        (if live (get event "thread_ts") then [("threadId", get event "thread_ts")] else []) ++
        (if live user then [("userId", user)] else []) ++
        (if live userName then [("userName", userName)] else []))),
      ("source", obj [("teamId", team), ("channelId", channelId), ("messageTs", ts),
        ("threadTs", replyTs), ("inThreadTs", get event "thread_ts"), ("userId", user)])]))]

private def sealBytesValue (c : Json) : Prog Json := do
  let bytes ← Prog.effect "mediaBytes" [a c 0]
  if !live bytes || byteLength bytes == 0 then return Twin.undefinedJson
  let mediaType ← Prog.effect "resolveMediaType" [bytes, a c 1]
  Prog.catchFail (do
    let _ ← Prog.effect "assertWithinLimit" [toJson (byteLength bytes), mediaType]
    let extension ← Prog.effect "mediaTypeToExtension" [mediaType]
    let _ ← Prog.effect "createHash" [.str "sha256"]
    let _ ← Prog.effect "createHash(\"sha256\").update" [bytes]
    let digest ← Prog.effect "createHash(\"sha256\").update(bytes).digest" [.str "hex"]
    let hash := String.ofList ((text digest).toList.take 32)
    let suffix := if live extension then "." ++ text extension else ""
    let ticket := Json.mkObj [("accountId", a c 2), ("path", .str s!"media/{hash}{suffix}")]
    let link ← Prog.effect "sealedLinkFor" [ticket]
    if !live link then return Twin.undefinedJson
    let bucket ← Prog.effect "requireEnv" [.str "FILESYSTEM_BUCKET_NAME"]
    let key ← Prog.effect "attachmentStoreKey" [ticket]
    let _ ← Prog.effect "writeS3Object" [bucket, key, bytes,
      Json.mkObj [("contentType", mediaType)]]
    let _ ← Prog.effect "cacheMedia" [link, bytes]
    return Json.mkObj [("link", link), ("mediaType", mediaType)])
    (fun _ => pure Twin.undefinedJson)

private def fetchAttachmentUrlValue (c : Json) : Prog Json := do
  let response ← Prog.effect "guardedFetch" [a c 0, Twin.undefinedJson, Json.mkObj ((if missing (a c 1) then [] else entries (a c 1)) ++
    [("binary", .bool true), ("bodyLimitBytes", toJson (26214400 : Nat)), ("timeoutMs", toJson (30000 : Nat))])]
  let status := nat (get response "status")
  if status < 200 || status ≥ 300 then
    return ← Prog.throwError "Error" s!"provider answered {status}"
  let bytes := get response "bodyBytes"
  let _ ← Prog.effect "assertWithinLimit"
    [toJson (byteLength bytes), nullish (get (get response "headers") "content-type") .null]
  return bytes

private def channelBytes (c : Json) : Prog Json := do
  let att := a c 0
  if live (get att "fetchData") then return ← Prog.effect "readFetchedBytes" [get att "fetchData"]
  let response ← Prog.effect "guardedFetch" [get att "url", Twin.undefinedJson,
    Json.mkObj [("binary", .bool true), ("bodyLimitBytes", toJson (26214400 : Nat))]]
  let status := nat (get response "status")
  if status < 200 || status ≥ 300 then
    let label := if missing (get att "name") then text (get att "url") else text (get att "name")
    return ← Prog.throwError "Error" s!"Could not read {label} to upload it ({status})"
  return get response "bodyBytes"

private def attachmentBytes (c : Json) : Prog Json := do
  let att := a c 0
  if live (get att "data") then return ← Prog.unsupported "inline attachment data"
  if live (get att "fetchData") then return ← Prog.effect "readFetchedBytes" [get att "fetchData"]
  if !live (get att "url") then
    return ← Prog.throwError "Error" "attachment carries neither data, a reader, nor a URL"
  Prog.effect "fetchAttachmentUrl" [get att "url", a c 1]

private def outcomeValue : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "unfinished concurrent effect"

private def discordUploadsValue (c : Json) : Prog Json := do
  let attachments := items (a c 0)
  let outcomes ← Prog.all (attachments.map fun att => ("channelAttachmentBytes", [att]))
  let mut out : List Json := []
  for (att, outcome) in attachments.zip outcomes do
    let data ← outcomeValue outcome
    let name ← Prog.effect "channelAttachmentName" [att]
    out := out ++ [Json.mkObj ([("data", data), ("filename", name)] ++
      (if live (get att "mimeType") then [("mimeType", get att "mimeType")] else []))]
  return jarr out

private def ingressGb (bytes : Nat) : Json :=
  let reduced := (List.range 9).foldl (fun (acc : Nat × Nat) _ =>
    if acc.2 > 0 && acc.1 % 10 == 0 then (acc.1 / 10, acc.2 - 1) else acc) (bytes, 9)
  .num ⟨reduced.1, reduced.2⟩

private def ingest (c : Json) : Prog Json := do
  let attachments := items (a c 0)
  let context := a c 1
  if attachments.isEmpty then
    return Json.mkObj [("stored", jarr []), ("turn", jarr [])]
  let accepted := attachments.take 10
  let outcomes ← Prog.all (accepted.zipIdx.map fun (att, index) =>
    ("storeAttachment", [att, toJson index, context]))
  let read ← outcomes.mapM outcomeValue
  let received := read.foldl (fun sum item => sum + nat (get item "receivedBytes")) 0
  if live (get context "accountId") && received > 0 then
    let _ ← Prog.effect "recordUsage" [get context "accountId",
      Json.mkObj [("ingressGb", ingressGb received)],
      if get context "agentId" == Twin.undefinedJson then Twin.undefinedJson
      else Json.mkObj [("agentId", get context "agentId")]]
  let provider := get (get (get context "agentConfig") "model") "provider"
  let mut ingested : List (Json × Json) := []
  for item in read do
    let part ← Prog.effect "nativePart" [item, provider, nullish (get item "url") (get item "data")]
    ingested := ingested ++ [(item, part)]
  let mut stored : List Json := []
  let mut turn : List Json := []
  for (item, part) in ingested do
    if live part then
      turn := turn ++ [part]
      let kept ← if live (get item "url") then pure part
        else Prog.effect "nativePart" [item, provider, get item "reference"]
      if live kept then stored := stored ++ [kept]
  let overflow := attachments.length - accepted.length
  let note ← Prog.effect "attachmentNote" [
    jarr (ingested.map fun (item, part) => Json.mkObj [("stored", item), ("part", part)]),
    toJson overflow, get context "channelName"]
  if live note then
    let added := Json.mkObj [("type", .str "text"), ("text", note)]
    stored := stored ++ [added]
    turn := turn ++ [added]
  return Json.mkObj [("stored", jarr stored), ("turn", jarr turn)]

private def maxImageBytes : Nat := 6 * 1024 * 1024

private def readSealed (c : Json) : Prog Json := do
  let link := a c 0
  if !live link then return .null
  let raw := text link
  let marker := "/v1/media/"
  let start := (indexOf? raw marker).map (· + marker.length) |>.getD (marker.length - 1)
  let secrets ← Prog.effect "requireSecretsEnv" [.str "MEDIA_TICKET_SECRET"]
  let ticket ← Prog.effect "openMediaTicket" [.str (dropChars raw start), secrets]
  if !live ticket then
    let base ← Prog.effect "getHarnessPublicUrl"
    return if raw.startsWith (scalarText base ++ marker)
      then Json.mkObj [("gone", .str "a linked file")] else .null
  let replay := a c 1
  if get ticket "accountId" != get replay "accountId" then return .null
  let budget := min maxImageBytes (nat (get replay "remainingBytes"))
  let cached ← Prog.effect "cachedMedia" [link]
  if live cached then
    return if byteLength cached > budget then .null else Json.mkObj [("bytes", cached)]
  Prog.catchFail (do
    let located ← Prog.effect "locateMediaObject" [ticket]
    if !live located then
      let name ← Prog.effect "basename" [get ticket "path"]
      return Json.mkObj [("gone", name)]
    let size := get (get located "head") "contentLength"
    if size == Twin.undefinedJson || nat size > budget then return .null
    let bytes ← Prog.effect "readMediaObject" [located, ticket]
    let _ ← Prog.effect "cacheMedia" [link, bytes]
    return Json.mkObj [("bytes", bytes)])
    (fun _ => pure .null)

private def resolveReference (c : Json) : Prog Json := do
  let reference := a c 0
  let cached ← Prog.effect "cachedMedia" [get reference "url"]
  if live cached then return cached
  Prog.catchFail (do
    let metadataUrl := get (get reference "metadata") "url"
    let attachment := Json.mkObj ([("type", get reference "type"), ("name", get reference "name"),
      ("mimeType", get reference "mediaType"), ("fetchMetadata", get reference "metadata")] ++
      (if live metadataUrl then [("url", metadataUrl)] else []))
    let adapter ← Prog.effect "channelAdapterFromConfig" [a c 1, get reference "channelName"]
    let rehydrated ← if live adapter
      then Prog.effect "adapter?.rehydrateAttachment" [attachment] else pure Twin.undefinedJson
    let bytes ← Prog.effect "readAttachmentBytes" [nullish rehydrated attachment]
    let _ ← Prog.effect "assertWithinLimit" [toJson (byteLength bytes), get reference "mediaType"]
    let _ ← Prog.effect "cacheMedia" [get reference "url", bytes]
    return bytes)
    (fun _ => pure .null)

private def withBytes (part bytes : Json) : Json :=
  setField part (if get part "type" == .str "image" then "image" else "data") bytes

private def rehydratePart (provider config replay part : Json) : Prog Json := do
  let kind := get part "type"
  if kind != .str "image" && kind != .str "file" then return part
  if kind == .str "file" then
    let stored ← Prog.effect "isStoredMediaPart" [part]
    if live stored then
      let accepted ← Prog.effect "acceptsNativeMedia" [provider, get part "mediaType"]
      if !live accepted then
        let note ← Prog.effect "unreadableMediaNote" [get part "filename", get part "mediaType"]
        return Json.mkObj [("type", .str "text"), ("text", note)]
  let reference ← Prog.effect "mediaReferenceOf" [part]
  if !live reference then
    let link ← Prog.effect "sealedMediaLink" [part]
    let sealed ← Prog.effect "readSealedMedia" [link, replay]
    if !live sealed then return part
    if get sealed "gone" != Twin.undefinedJson then
      return textPart s!"[{text (get sealed "gone")} is no longer available]"
    return withBytes part (get sealed "bytes")
  let bytes ← Prog.effect "resolveMediaReference" [reference, config]
  if !live bytes then
    return textPart s!"[{text (get reference "name")} is no longer available from {text (get reference "channelName")}]"
  return withBytes part bytes

private def rehydrateMessageValue (c : Json) : Prog Json := do
  let message := a c 0
  if get message "role" == .str "tool" then
    return ← Prog.effect "rehydrateToolMessage" [message, a c 2]
  if get message "role" != .str "user" || string (get message "content") then return message
  let parts := items (get message "content")
  let media := parts.filter fun p => get p "type" == .str "image" || get p "type" == .str "file"
  if media.length > 1 then return ← Prog.unsupported "concurrent media parts interleave"
  let provider := get (get (a c 1) "model") "provider"
  let content ← parts.mapM (rehydratePart provider (a c 1) (a c 2))
  return setField message "content" (jarr content)

/-- Runs a `mapToolItems` callback for every item entered, threading state through. -/
private def toolEntries {σ : Type} (handle : σ → Json → Prog (σ × Json)) :
    Nat → σ → List Json → Prog (σ × List Json)
  | 0, state, done => pure (state, done.reverse)
  | limit + 1, state, done =>
    .input fun
      | none => pure (state, done.reverse)
      | some (_, args) => do
        let (next, result) ← handle state (Twin.arg args 0)
        toolEntries handle limit next (result :: done)

/-- `mapToolItems`' result: each tool-result's content items replaced in visiting order. -/
private def rebuildTool (message : Json) (results : List Json) : Json :=
  let step := fun (acc : List Json × List Json) (part : Json) =>
    let output := get part "output"
    if get part "type" == .str "tool-result" && get output "type" == .str "content" then
      let count := (items (get output "value")).length
      (acc.1 ++ [setField part "output" (setField output "value" (jarr (acc.2.take count)))],
        acc.2.drop count)
    else (acc.1 ++ [part], acc.2)
  setField message "content" (jarr ((items (get message "content")).foldl step ([], results)).1)

private def mapTool {σ : Type} (message : Json) (state : σ)
    (handle : σ → Json → Prog (σ × Json)) : Prog (σ × Json) := do
  let (next, results) ← toolEntries handle 1024 state []
  let _ ← Prog.effect "mapToolItems" [message, anonymousFn]
  return (next, rebuildTool message results)

private def rehydrateTool (c : Json) : Prog Json := do
  let message := a c 0
  let links ← Prog.effect "imageLinks" [message]
  if (items links).isEmpty then return message
  let (_, rebuilt) ← mapTool message () fun _ item => do
    let link ← Prog.effect "sealedToolLink" [item]
    if get item "type" != .str "file-url" || !live link then return ((), item)
    let sealed ← Prog.effect "readSealedMedia" [link, a c 1]
    if !live sealed then return ((), textPart "[an earlier image is not shown here]")
    if get sealed "gone" != Twin.undefinedJson then
      return ((), textPart s!"[{text (get sealed "gone")} is no longer available]")
    return ((), Json.mkObj [("type", .str "file"),
      ("mediaType", nullish (get item "mediaType") (.str "application/octet-stream")),
      ("data", Json.mkObj [("type", .str "data"), ("data", get sealed "bytes")])])
  return rebuilt

private def toolItems (message : Json) : List Json :=
  (items (get message "content")).flatMap fun part =>
    let output := get part "output"
    if get part "type" == .str "tool-result" && get output "type" == .str "content"
      then items (get output "value") else []

private def linksOf (message : Json) : List Json :=
  let role := get message "role"
  if role == .str "user" && !string (get message "content") then
    (items (get message "content")).map (fun part =>
      if get part "type" == .str "image" then sealedInMessage part else .null)
      |>.filter (· != .null)
  else if role == .str "tool" then (toolItems message).map sealedInTool |>.filter (· != .null)
  else []

private def omittedNote : Json := textPart "[an earlier image is not shown here]"

private def omitLink (toOmit : Nat) (link original : Json) : Nat × Json :=
  if link == .null || toOmit == 0 then (toOmit, original) else (toOmit - 1, omittedNote)

private def withOldOmitted (c : Json) : Prog Json := do
  let messages := items (a c 0)
  let total := (messages.flatMap linksOf).length
  if total ≤ 20 then return a c 0
  if (messages.filter (fun message => get message "role" == .str "tool")).length > 1 then
    return ← Prog.unsupported "concurrent tool omissions overlap other message mappings"
  let over := total - 20
  let mut toOmit := ((over + 9) / 10) * 10
  let mut out : List Json := []
  for message in messages do
    let role := get message "role"
    if role == .str "user" && !string (get message "content") then
      let mut parts : List Json := []
      for part in items (get message "content") do
        let link ← Prog.effect "sealedImageLink" [part]
        let (left, shown) := omitLink toOmit link part
        toOmit := left
        parts := parts ++ [shown]
      out := out ++ [setField message "content" (jarr parts)]
    else if role == .str "tool" then
      let (left, rebuilt) ← mapTool message toOmit fun state item => do
        let link ← Prog.effect "sealedToolLink" [item]
        return omitLink state link item
      toOmit := left
      out := out ++ [rebuilt]
    else out := out ++ [message]
  return jarr out

private def sealMessage (c : Json) : Prog Json := do
  let message := a c 0
  let account := a c 1
  if get message "role" == .str "user" && !string (get message "content") then
    let parts := items (get message "content")
    let isMedia := fun (p : Json) => get p "type" == .str "image" || get p "type" == .str "file"
    let value := fun (p : Json) => get p (if get p "type" == .str "image" then "image" else "data")
    let outcomes ← Prog.all ((parts.filter isMedia).map fun p =>
      ("sealBytes", [value p, get p "mediaType", account]))
    let sealedParts ← outcomes.mapM outcomeValue
    let step := fun (acc : List Json × List Json) (p : Json) =>
      if !isMedia p then (acc.1 ++ [p], acc.2) else
      let sealed := acc.2.headD Twin.undefinedJson
      let done := if !live sealed then p
        else setField (withBytes p (get sealed "link")) "mediaType" (get sealed "mediaType")
      (acc.1 ++ [done], acc.2.drop 1)
    return setField message "content" (jarr (parts.foldl step ([], sealedParts)).1)
  if get message "role" != .str "tool" then return message
  let (_, rebuilt) ← mapTool message () fun _ item => do
    let isBytes ← Prog.effect "isToolImageBytes" [item]
    if !live isBytes then return ((), item)
    let sealed ← Prog.effect "sealBytes" [get item "data", get item "mediaType", account]
    if !live sealed then return ((), item)
    return ((), Json.mkObj [("type", .str "file-url"), ("url", get sealed "link"),
      ("mediaType", get sealed "mediaType")])
  return rebuilt

private def toolImageBytes (part : Json) : Bool :=
  ["image-data", "file-data", "file"].contains (text (get part "type")) &&
    (text (get part "mediaType")).startsWith "image"

private def sealConversation (c : Json) : Prog Json := do
  let messages := items (a c 0)
  let mut carries := false
  for message in messages do
    if !carries then
      let role := get message "role"
      if role == .str "user" && !string (get message "content") then
        carries := (items (get message "content")).any fun p =>
          get p "type" == .str "image" || get p "type" == .str "file"
      else if role == .str "tool" then
        let parts ← Prog.effect "toolContentItems" [message]
        carries := (items parts).any toolImageBytes
  if !carries then return a c 0
  let base ← Prog.effect "getHarnessPublicUrl"
  if !live base then return a c 0
  let outcomes ← Prog.all (messages.map fun m => ("sealMessageMedia", [m, a c 1]))
  return jarr (← outcomes.mapM outcomeValue)

private def storedInMessage (part : Json) : Bool :=
  let kind := text (get part "type")
  let value := get part (if kind == "image" then "image" else "data")
  ["image", "file"].contains kind && string value &&
    ((text value).startsWith "broods-media://" || sealedInMessage part != .null)

/-- Bytes a rehydrated message charged to the budget: only sealed links are charged. -/
private def replayCharge (original result : Json) : Nat :=
  if get original "role" == .str "tool" then
    ((toolItems original).zip (toolItems result)).foldl (fun sum pair =>
      if sealedInTool pair.1 != .null && get pair.2 "type" == .str "file"
        then sum + byteLength (get (get pair.2 "data") "data") else sum) 0
  else
    ((items (get original "content")).zip (items (get result "content"))).foldl (fun sum pair =>
      let key := if get pair.1 "type" == .str "image" then "image" else "data"
      if sealedInMessage pair.1 != .null then sum + byteLength (get pair.2 key) else sum) 0

private def rehydrateStored (c : Json) : Prog Json := do
  let messages := items (a c 0)
  let mut carries := false
  for message in messages do
    if !carries then
      let role := get message "role"
      if role == .str "user" && !string (get message "content") then
        carries := (items (get message "content")).any storedInMessage
      else if role == .str "tool" then
        let links ← Prog.effect "imageLinks" [message]
        carries := !(items links).isEmpty
  if !carries then return a c 0
  let mut remaining : Nat := 20971520
  let trimmed ← Prog.effect "withOldMediaOmitted" [a c 0]
  let mut out : List Json := []
  for message in (items trimmed).reverse do
    let replay := obj [("accountId", a c 2), ("remainingBytes", toJson remaining)]
    let result ← Prog.effect "rehydrateMessage" [message, a c 1, replay]
    remaining := remaining - replayCharge message result
    out := result :: out
  return jarr out

private def fifthTwins : List Twin := [
  Twin.traced (forwarder "threads" "ThreadDirectory.lookup") lookupThread,
  Twin.traced (core "discord-channel" "parseForwardedGatewayEvent") gatewayEvent,
  Twin.traced (core "slack-channel" "parseEventCallback") eventCallback,
  Twin.traced (media "sealBytes") sealBytesValue,
  Twin.traced (media "fetchAttachmentUrl") fetchAttachmentUrlValue,
  Twin.traced (core "channels" "channelAttachmentBytes") channelBytes,
  Twin.traced (media "readAttachmentBytes") attachmentBytes,
  Twin.traced (core "discord-channel" "discordUploads") discordUploadsValue,
  Twin.traced (media "ingestInboundAttachments") ingest,
  Twin.traced (media "readSealedMedia") readSealed,
  Twin.traced (media "resolveMediaReference") resolveReference,
  Twin.traced (media "rehydrateMessage") rehydrateMessageValue,
  Twin.traced (media "rehydrateToolMessage") rehydrateTool,
  Twin.traced (media "withOldMediaOmitted") withOldOmitted,
  Twin.traced (media "sealMessageMedia") sealMessage,
  Twin.traced (media "sealConversationMedia") sealConversation,
  Twin.traced (media "rehydrateStoredMedia") rehydrateStored
]

/-- This author's twins. -/
def twins : List Spec.Twin := fifthTwins ++ fourthTwins ++ moreTwins ++ thirdTwins ++ [
  Twin.traced (core "telegram-channel" "readCappedFile") readCapped,
  pureTwin (core "telegram-channel" "splitTelegramRawText") (fun c =>
    let s := jsTrim (text (a c 0))
    jstrs (if s.isEmpty then ["..."] else splitLoop (s.length + 1) s)),
  pureTwin (core "channels" "chunkChannelText") (fun c =>
    let s := text (a c 0)
    if nat (a c 1) == 0 then Json.mkObj [("$unsupported", .str "nonpositive chunk limit")]
    else jstrs (if s.isEmpty then [""] else chunkLoop (s.length + 1) s (nat (a c 1)))),
  Twin.traced (core "channels" "parseChannelWebhookBody") parseWebhook,
  Twin.traced (core "telegram-channel" "telegramBotApiUrl") botApi,
  pureTwin (media "whereItLanded") (fun c =>
    let item := a c 0
    .str (if live (get item "path") then s!"saved to {text (get item "path")}"
      else if live (get item "reference") then s!"is read from {text (a c 2)} whenever it is needed; it lasts as long as {text (a c 2)} keeps the file."
      else if live (a c 1) then "is available for this message only; no workspace is attached to store it."
      else "could not be shown: this model does not accept the type, and there is no workspace to store it in.")),
  Twin.traced (core "discord-channel" "toDiscordSource") discordSource,
  Twin.traced (media "acceptsNativeMedia") acceptsNative,
  Twin.traced (media "resolveMediaType") resolveType,
  pureTwin (core "channels" "extractText") (fun c =>
    let content := a c 0
    if string content then content else .str (String.join ((items content).filterMap fun p =>
      if get p "type" == .str "text" then some (text (get p "text")) else none))),
  pureTwin (core "channels" "isAllowedId") (fun c =>
    let allowed := a c 0
    let ids := items (get allowed "$set")
    .bool (missing allowed || ids.contains (.str "*") || (live (a c 1) && ids.contains (a c 1)))),
  pureTwin (core "channels" "channelAttachmentName") (fun c =>
    let att := a c 0
    let name := get att "name"
    if live name then name else
    let url := ((text (get att "url")).splitOn "?").head!
    let tail := (url.splitOn "/").getLast!
    .str (if tail != "" && (tail.splitOn ".").length > 1 then tail
      else if get att "type" == .str "image" then "file.png" else "file")),
  pureTwin (media "sealedMediaLink") (fun c =>
    let p := a c 0
    let t := text (get p "type")
    let v := get p (if t == "image" then "image" else "data")
    if ["image", "file"].contains t && string v && ((text v).splitOn "/v1/media/").length > 1 then v else .null),
  pureTwin (media "sealedToolLink") (fun c =>
    let p := a c 0
    let v := get p "url"
    if get p "type" == .str "file-url" && (text (get p "mediaType")).startsWith "image" &&
      ((text v).splitOn "/v1/media/").length > 1 then v else .null),
  pureTwin (media "isToolImageBytes") (fun c =>
    let p := a c 0
    .bool (["image-data", "file-data", "file"].contains (text (get p "type")) &&
      (text (get p "mediaType")).startsWith "image")),
  pureTwin (media "limitForMediaType") (fun c =>
    toJson (if (text (a c 0)).startsWith "image/" then 6 * 1024 * 1024 else 25 * 1024 * 1024 : Nat)),
  pureTwin (core "channels" "questionButtonId") (fun c => .str s!"q:{text (a c 0)}:{nat (a c 1)}:{nat (a c 2)}"),
  pureTwin (core "channels" "reachSet") (fun c =>
    if missing (a c 0) then .null else Json.mkObj [("$set", jarr (uniq (items (a c 0))))]),
  pureTwin (core "channels" "supportsInlineCommands") (fun c => .bool
    (["discord", "gchat", "instagram", "messenger", "slack", "teams", "telegram", "twilio", "whatsapp", "zalo"].contains (text (a c 0)))),
  Twin.traced (core "slack-channel" "toSlackSource") (fun c => sourceFields c ["teamId", "channelId"]
    ["threadTs", "inThreadTs", "messageTs", "responseUrl", "commandToken", "userId"] "Invalid Slack source payload"),
  pureTwin (core "slack-channel" "appendBufferedSlackText") (fun c => .str
    (text (a c 0) ++ (if live (a c 1) && live (a c 2) && live (a c 0) then "\n\n" else "") ++ text (a c 1))),
  pureTwin (core "slack-channel" "cleanSlackName") (fun c => .str (jsTrim (String.ofList ((text (a c 0)).toList.dropWhile (· == '@'))))),
  pureTwin (core "slack-channel" "getSlackBotUserIds") (fun c => Json.mkObj [("$set", jarr (uniq
    ((items (get (a c 0) "authorizations")).filterMap fun v =>
      let id := get v "user_id"
      if get v "is_bot" != .bool false && string id && live id then some id else none)))]),
  pureTwin (core "slack-channel" "getSlackConversationKey") (fun c => .str
    (s!"slack:{text (a c 0)}:{text (a c 1)}" ++
      if ["im", "app_home"].contains (text (get (a c 2) "channel_type")) then "" else ":" ++ text (a c 3))),
  pureTwin (core "slack-channel" "getSlackReplyThreadTs") (fun c =>
    let e := a c 0
    let thread := get e "thread_ts"
    if get e "type" == .str "app_mention" || (get e "type" == .str "message" &&
      !["im", "app_home"].contains (text (get e "channel_type"))) then nullish thread (a c 1) else thread),
  pureTwin (core "slack-channel" "slackAttachmentType") (fun c => .str
    (if (text (a c 0)).startsWith "image/" then "image" else if (text (a c 0)).startsWith "video/" then "video"
      else if (text (a c 0)).startsWith "audio/" then "audio" else "file")),
  pureTwin (core "slack-channel" "slackFileMediaType") (fun c =>
    let mime := get (a c 0) "mimetype"
    if get (a c 0) "subtype" == .str "slack_audio" && (text mime).startsWith "video/"
      then .str ("audio/" ++ dropChars (text mime) 6) else mime),
  pureTwin (core "slack-channel" "getUnsupportedSlackEventReason") (fun c =>
    let e := a c 0
    .str (if live (get e "bot_id") then "bot_message"
      else if live (get e "subtype") then "unsupported_subtype:" ++ text (get e "subtype")
      else if get e "type" == .str "message" then "unsupported_message_channel:" ++ text (nullish (get e "channel_type") (.str "unknown"))
      else "unsupported_event:" ++ text (nullish (get e "type") (.str "unknown")))),
  pureTwin (core "slack-channel" "isSlackMessageEvent") (fun c => .bool (string (get (a c 0) "type"))),
  pureTwin (core "slack-channel" "isSupportedSlackMessageChannel") (fun c => .bool
    (["channel", "group", "mpim", "im", "app_home"].contains (text (a c 0)))),
  pureTwin (core "slack-channel" "isStreamChunk") (fun c =>
    let v := a c 0
    .bool (match text (get v "type") with
      | "markdown_text" => string (get v "text")
      | "task_update" => ["id", "title", "status"].all (fun k => string (get v k))
      | "plan_update" => string (get v "title")
      | _ => false)),
  pureTwin (core "slack-channel" "stringValue") (fun c =>
    if string (a c 0) && jsTrim (text (a c 0)) != "" then a c 0 else Twin.undefinedJson),
  pureTwin (core "slack-channel" "truncateText") (fun c =>
    let s := jsTrim (text (a c 0))
    .str (if ulen s ≤ nat (a c 1) then s else utake s (nat (a c 1) - 3) ++ "..."))
]

end Spec.Channels.Wavechannels2
