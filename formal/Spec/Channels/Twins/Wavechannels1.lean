import Spec.Channels.Twins.Wavechannels8a
import Spec.Channels.Twins.Commands
import Spec.Access.Twins.Crypto
import Spec.Channels.Twins.Wavechannels1.Socket
import Spec.Channels.Twins.Wavechannels1.Delivery
import Spec.Channels.Twins.Wavechannels1.Providers
import Spec.Channels.Twins.Wavechannels1.GitHub
import Spec.Channels.Twins.Wavechannels1.Routing

namespace Spec.Channels.Wavechannels1

open Lean Spec

private def get (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def missing (value : Json) : Bool := value == Twin.undefinedJson
private def nullish (value : Json) : Bool := missing value || value == .null
private def jsTruthy (value : Json) : Bool := !missing value && truthy value
private def text (value : Json) : String := value.getStr?.toOption.getD ""
private def stringValue (value : Json) : String :=
  match value with
  | .str s => s
  | _ => if missing value then "undefined" else value.compress
private def items (value : Json) : List Json := (arr? value).getD []

private def utf16Size (value : String) : Nat :=
  value.toList.foldl (fun total c => total + if c.toNat > 65535 then 2 else 1) 0

private def splitMetaText (args : Json) : Json := Id.run do
  let input := jsTrim (text (Twin.arg args 0))
  let limit := Twin.arg args 1
  let maxSize := (get limit "max").getNat?.toOption.getD 0
  let size := fun (s : String) =>
    if get limit "unit" == .str "bytes" then s.toUTF8.size else utf16Size s
  let mut chunks : List String := []
  let mut current := ""
  let mut currentSize := 0
  for c in input.toList do
    let point := String.singleton c
    let pointSize := size point
    if currentSize + pointSize > maxSize then
      let lastSpace := (current.toList.zipIdx.filter fun pair =>
        pair.1 == '\n' || pair.1 == ' ').getLast?
      let cut := match lastSpace with
        | some (_, at') => if at' * 2 > current.length then at' else current.length
        | none => current.length
      chunks := chunks ++ [String.ofList (current.toList.take cut)]
      current := String.ofList (current.toList.drop cut)
      currentSize := size current
    current := current ++ point
    currentSize := currentSize + pointSize
  chunks := chunks ++ [current]
  return jstrs ((chunks.map jsTrim).filter (· != ""))

private def pancakeDropReason (args : Json) : Json :=
  let message := Twin.arg args 0
  let sender := get message "from"
  if jsTruthy (get message "is_hidden") then .str "hidden_message"
  else if jsTruthy (get message "is_removed") then .str "removed_message"
  else if get sender "id" == Twin.arg args 1 then .str "page_originated_message"
  else if !jsTruthy (get sender "page_customer_id") then .str "missing_page_customer_id"
  else .null

private def pancakeAttachments (args : Json) : Json :=
  jarr ((items (Twin.arg args 0)).flatMap fun attachment =>
    let isPhoto := get attachment "type" == .str "photo"
    let url := if isPhoto then get attachment "url" else get (get attachment "video_data") "url"
    if (!isPhoto && get attachment "type" != .str "video") || jsTrim (text url) == "" then []
    else [Json.mkObj ([("type", .str (if isPhoto then "image" else "video")), ("url", url)] ++
      (if jsTruthy (get attachment "title") then [("name", get attachment "title")] else []) ++
      (if jsTruthy (get attachment "mime_type") then [("mimeType", get attachment "mime_type")] else []))])

private def parseBody (pancake : Bool) (args : Json) : Json :=
  match Json.parse (text (Twin.arg args 0)) with
  | .error _ => .null
  | .ok parsed =>
    if !(match parsed with | .obj _ | .arr _ => true | _ => false) then .null
    else if !pancake then parsed
    else Json.mkObj (
      (if (str? (get parsed "id")).isSome && jsTruthy (get parsed "id") then [("id", get parsed "id")] else []) ++
      (if (get parsed "success").getBool?.isOk then [("success", get parsed "success")] else []) ++
      (if (str? (get parsed "message")).isSome then [("message", get parsed "message")] else []))

private def messageEvents (args : Json) : Json :=
  jarr ((items (get (Twin.arg args 0) "entry")).flatMap fun entry =>
    (items (get entry "messaging")).filterMap fun event =>
      let message := get event "message"
      if (!missing message && !jsTruthy (get message "is_echo") &&
        !jsTruthy (get message "is_deleted") && !jsTruthy (get message "is_unsupported")) ||
        !missing (get event "postback") then
        some (Json.mkObj [("event", event), ("recipientId", get entry "id")])
      else none)

private def formatTitleAndBody (args : Json) : Json :=
  let title := Twin.arg args 1
  let body := jsTrim (text (Twin.arg args 2))
  .str (text (Twin.arg args 0) ++ ": " ++ (if nullish title then "(untitled)" else text title) ++
    (if body == "" then "" else "\n\n" ++ body))

private def normalizePancakeTagIds (args : Json) : Json :=
  jarr ((items (Twin.arg args 0)).filterMap fun tag =>
    match tag with
    | .str _ | .num _ => some (.str (stringValue tag))
    | _ => none)

private def unwrapZaloUpdate (args : Json) : Json :=
  let raw := Twin.arg args 0
  let objectLike := fun (v : Json) => match v with | .obj _ | .arr _ => true | _ => false
  if objectLike raw then
    if get raw "ok" == .bool true && objectLike (get raw "result") then get raw "result" else raw
  else Json.mkObj []

private def channelReplySource (call : Json) : Prog Json := do
  let adapter := Twin.callArg call 0
  let source := get (Twin.callArg call 1) "source"
  let replyIn := get (get (Twin.callArg call 2) "config") "replyIn"
  if !jsTruthy replyIn || !jsTruthy (get adapter "applyReplyIn") then return source
  Prog.effect "adapter.applyReplyIn" [source, replyIn]

private def resolveChannelTarget (call : Json) : Prog Json := do
  let account := Twin.callArg call 1
  let agent := Twin.callArg call 2
  let identity := Twin.callArg call 4
  let resolved := fun (chosen : Json) (record : Option Json) =>
    Json.mkObj ([("kind", .str "resolved"), ("agent", chosen)] ++ optEntry "record" record)
  if !jsTruthy (get identity "channelId") then return resolved agent none
  let loaded ← Prog.attempt "context.channelRecordLoader"
    [get account "accountId", Twin.callArg call 3, get identity "channelId"]
  match loaded with
  | .threw _ _ => return Json.mkObj [("kind", .str "unavailable")]
  | .pending => return ← Prog.unsupported "unfinished record lookup"
  | .ok _ => pure ()
  let record := match loaded with | .ok value => value | _ => .null
  if !jsTruthy record then return resolved agent none
  let workspaceMatches ← Prog.effect "channelRecordMatchesWorkspace"
    [get record "workspaceRef", get identity "workspaceRef"]
  if !jsTruthy workspaceMatches then return resolved agent none
  let boundId ← Prog.effect "resolveChannelAgentId" [record]
  if !jsTruthy boundId || boundId == get agent "agentId" then return resolved agent (some record)
  let bound ← Prog.effect "context.agentLoader" [get account "accountId", boundId]
  return resolved (if jsTruthy bound then bound else agent) (some record)

private def loadIdentity (call : Json) : Prog Json := do
  let existing := Twin.field (Twin.self call) "defaultBotUserId"
  if jsTruthy existing then return existing
  let client ← Prog.effect "this.getClient"
  let identity ← Prog.effect "this.fetchClientIdentity" [client]
  Spec.Channels.Wavechannels8a.stateChange "self.defaultBotUserId"
    existing (get identity "botUserId")
  Spec.Channels.Wavechannels8a.stateChange "self.defaultOrganizationId"
    (Twin.field (Twin.self call) "defaultOrganizationId") (get identity "organizationId")
  return get identity "botUserId"

private def isPriorGitHubComment (args : Json) : Json :=
  let comment := Twin.arg args 0
  if get comment "id" == Twin.arg args 1 then .bool false
  else if jsTruthy (Twin.arg args 2) && jsTruthy (get comment "createdAt") then
    .bool (text (get comment "createdAt") < text (Twin.arg args 2))
  else .bool true

private def teamsIdentity (args : Json) : Json :=
  let activity := Twin.arg args 0
  let fallback := fun (a b : Json) => if nullish a then b else a
  let sender := get activity "from"
  let data := get activity "channelData"
  let userId := fallback (get sender "aadObjectId") (get sender "id")
  let workspace := fallback (get (get data "team") "id")
    (fallback (get (get data "tenant") "id") (get (get activity "conversation") "tenantId"))
  Json.mkObj ([("channelId", fallback (get (get data "channel") "id")
    (.str ((text (Twin.arg args 1)).splitOn ";").head!))] ++
    (if jsTruthy workspace then [("workspaceRef", workspace)] else []) ++
    (if jsTruthy userId then [("userId", userId)] else []) ++
    (if jsTruthy (get sender "name") then [("userName", get sender "name")] else []))

private def withoutBotMention (args : Json) : Json :=
  let activity := Twin.arg args 0
  let bot := get (get activity "recipient") "id"
  .str (jsTrim ((items (get activity "entities")).foldl (fun result entity =>
    if get entity "type" == .str "mention" && jsTruthy (get entity "text") && jsTruthy bot &&
      get (get entity "mentioned") "id" == bot then
      match indexOf? result (text (get entity "text")) with
      | some at' => String.ofList (result.toList.take at' ++ result.toList.drop (at' + (text (get entity "text")).length))
      | none => result
    else result) (text (get activity "text"))))

private def formatIssueContext (args : Json) : Json :=
  let issue := Twin.arg args 0
  let quote := fun (key : String) => (text (get issue key)).replace "linear_issue_context" "linear-issue-context"
  .str ("<linear_issue_context>\nIssue: " ++ quote "identifier" ++ " " ++ quote "title" ++
    "\nURL: " ++ quote "url" ++ "\n</linear_issue_context>")

private def githubIdentity (args : Json) : Json :=
  let repo := text (Twin.arg args 0)
  let owner := (repo.splitOn "/").head!
  let login := get (Twin.arg args 2) "login"
  Json.mkObj ((if owner != "" then [("workspaceRef", .str owner)] else []) ++
    [("channelId", .str repo), ("threadId", .str (stringValue (Twin.arg args 1)))] ++
    (if jsTruthy login then [("userId", login), ("userName", login)] else []))

private def sourceObject (args : Json) (index : Nat) (keys : List String) (error : String) : Json :=
  let source := Twin.arg args index
  if keys.all (fun key => (str? (get source key)).isSome) then
    Json.mkObj (keys.map fun key => (key, get source key))
  else Twin.threw error

private def urlAttachments (args : Json) : Json :=
  jarr ((items (Twin.arg args 0)).filterMap fun attachment =>
    if jsTruthy (get attachment "url") then
      some (Json.mkObj [("type", get attachment "type"), ("url", get attachment "url")])
    else none)

private def hashEventContent (call : Json) : Prog Json := do
  let identity := String.intercalate "\n" ((items (Twin.callArg call 0)).map fun attachment =>
      let url := get attachment "url"
      if nullish url then "" else text url)
  let _ ← Prog.effect "createHash" [.str "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\") .update" [.str identity]
  let digest ← Prog.effect
    "createHash(\"sha256\") .update(attachments.map((attachment) => attachment.url ?? \"\").join(\"\\n\")) .digest"
    [.str "hex"]
  return .str (String.ofList ((text digest).toList.take 12))

private def buildStatusUrl (call : Json) : Prog Json := do
  let base ← Prog.effect "getHarnessPublicUrl"
  if !jsTruthy base then
    Prog.throwError "StatusUrlConfigError" "PUBLIC_BASE_URL is not configured"
  else pure (.str (text base ++ "/v1/runs/" ++ encodeComponent (text (Twin.callArg call 0))))

private def withIngressClearLease (call : Json) : Prog Json := do
  let ctx := Twin.callArg call 0
  let verb := text (Twin.callArg call 1)
  if ["accountId", "agentId", "eventId"].any (fun key => !jsTruthy (get ctx key)) then
    return ← Prog.throwError "Error" (verb ++ " requires account, agent, and event scope")
  let generation ← Prog.effect "runtime.mutate" [.str "acquireIngressClear", Json.mkObj
    [("accountId", get ctx "accountId"), ("agentId", get ctx "agentId"),
      ("conversationKey", get ctx "conversationKey"), ("ownerEventId", get ctx "eventId"),
      ("leaseTtlMs", toJson (900000 : Nat))]]
  if generation == .null then
    return .str ("Cannot " ++ verb ++ " while a turn or queued message is active. Try again after it finishes.")
  let outcome ← Prog.attempt "run" [get ctx "eventId", generation]
  let _ ← Prog.effect "runtime.mutate" [.str "releaseIngressOwner", Json.mkObj
    [("conversationKey", get ctx "conversationKey"), ("ownerEventId", get ctx "eventId"),
      ("ownerGeneration", generation)]]
  match outcome with
  | .ok result => pure result
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "unfinished run"

private def jsType (value : Json) : String :=
  if missing value then "undefined" else
  match value with
  | .null | .arr _ | .obj _ => "object"
  | _ => zodType value

private def objectKeys (value : Json) : List String :=
  match value with
  | .arr values => (List.range values.size).map toString
  | .obj _ => if missing value then [] else keys value
  | .str value => (List.range (utf16Size value)).map toString
  | _ => []

private def orderedJson (fields : List (String × Json)) : String :=
  "{" ++ String.intercalate "," (fields.map fun (key, value) =>
    (Json.str key).compress ++ ":" ++ value.compress) ++ "}"

private def takeUtf16 (value : String) (count : Nat) : String :=
  String.ofList ((value.toList.foldl (fun (state : Nat × List Char) c =>
    let size := if c.toNat > 65535 then 2 else 1
    if state.1 + size ≤ count then (state.1 + size, state.2 ++ [c])
    else (count + 1, state.2)) (0, [])).2)

private def describeZaloUpdate (args : Json) : Json :=
  let update := Twin.arg args 0
  let message := get update "message"
  let fields := if jsType message == "object" && jsTruthy message then objectKeys message else []
  let content := get message "text"
  let event := get update "event_name"
  let nullable := fun (value : Json) => if nullish value then Json.null else value
  let fieldsJson := Json.mkObj (fields.map fun key =>
    let value := get message key
    (key, .str (match value with | .arr _ => "array" | .null => "null" | _ => jsType value)))
  let nested := Json.mkObj (fields.filterMap fun key =>
    let value := get message key
    match value with
    | .obj _ => if missing value then none else some (key, jstrs (objectKeys value))
    | _ => none)
  .str ("details=" ++ orderedJson
    [("updateFields", jstrs (objectKeys update)),
     ("eventName", if (str? event).isSome then .str (takeUtf16 (text event) 128) else .null),
     ("eventNameType", .str (jsType event)), ("messageFields", jstrs fields),
     ("messageFieldTypes", fieldsJson), ("nestedMessageFields", nested),
     ("messageIdPresent", .bool (jsTruthy (get message "message_id"))),
     ("chatIdPresent", .bool (jsTruthy (get (get message "chat") "id"))),
     ("senderIdPresent", .bool (jsTruthy (get (get message "from") "id"))),
     ("chatType", nullable (get (get message "chat") "chat_type")),
     ("isBot", nullable (get (get message "from") "is_bot")),
     ("textType", .str (match content with | .arr _ => "array" | _ => jsType content)),
     ("textFields", jstrs (if jsType content == "object" && jsTruthy content then objectKeys content else [])),
     ("textLength", if (str? content).isSome then toJson (utf16Size (text content)) else .null)])

private def replaceInsensitive (needle replacement : String) (input : String) : String :=
  String.ofList (go (input.length + 1) input.toList)
where
  go : Nat → List Char → List Char
  | 0, rest => rest
  | fuel + 1, rest =>
    if (rest.take needle.length).map Char.toLower == needle.toList then
      replacement.toList ++ go fuel (rest.drop needle.length)
    else match rest with
    | [] => []
    | c :: tail => c :: go fuel tail

private def safeText (args : Json) : Json :=
  let value := replaceInsensitive "github_thread_context" "github-thread-context"
    (jsTrim (text (Twin.arg args 0)))
  .str (String.ofList ((List.range value.length).flatMap fun at' =>
    let rest := value.toList.drop at'
    match rest with
    | '<' :: tail =>
      let afterSpace := tail.dropWhile jsSpace
      let afterSlash := if afterSpace.head? == some '/' then afterSpace.drop 1 else afterSpace
      if "github-thread-context".toList.isPrefixOf (afterSlash.dropWhile jsSpace) then "&lt;".toList else ['<']
    | c :: _ => [c]
    | [] => []))

private def truncateText (args : Json) : Json :=
  let value := text (Twin.arg args 0)
  let limit := (Twin.arg args 1).getNat?.toOption.getD 0
  if utf16Size value > limit then
    .str (String.ofList (((takeUtf16 value limit).toList.reverse.dropWhile jsSpace).reverse) ++ "\n...(truncated)")
  else .str value

private def decodeUtf8 (bytes : List UInt8) : String :=
  String.ofList (go (bytes.length + 1) bytes)
where
  go : Nat → List UInt8 → List Char
  | 0, _ => []
  | fuel + 1, bytes =>
    match bytes with
    | [] => []
    | first :: tail =>
      let lead := first.toNat
      if lead < 128 then Char.ofNat lead :: go fuel tail
      else
        let count := if lead >= 194 && lead <= 223 then 2
          else if lead >= 224 && lead <= 239 then 3
          else if lead >= 240 && lead <= 244 then 4 else 0
        if count == 0 then '�' :: go fuel tail
        else
          let secondOk := match tail.head? with
            | none => false
            | some b => b.toNat >= (if lead == 224 then 160 else if lead == 240 then 144 else 128) &&
                b.toNat <= (if lead == 237 then 159 else if lead == 244 then 143 else 191)
          let continuations := if secondOk then
            1 + ((tail.drop 1).take (count - 2) |>.takeWhile fun b => b.toNat >= 128 && b.toNat <= 191).length
            else 0
          if continuations + 1 == count then
            let decoded := String.fromUTF8? (ByteArray.mk (bytes.take count).toArray)
            (decoded.getD "�").toList ++ go fuel (bytes.drop count)
          else '�' :: go fuel (tail.drop continuations)

private def normalizePrivateKey (args : Json) : Json :=
  let value := text (Twin.arg args 0)
  if (indexOf? value "BEGIN").isSome then .str value
  else .str (decodeUtf8 (Access.Crypto.base64Decode value))

private def base64UrlEncode (args : Json) : Json :=
  let value := Twin.arg args 0
  let bytes := match value with
    | .str value => value.toUTF8.toList
    | _ => Access.Crypto.base64Decode (text (get value "$bytes"))
  .str (Access.Crypto.base64UrlEncode bytes)

private def zaloHttpUrl (args : Json) : Json :=
  match Twin.arg args 0 with
  | .str raw =>
    match parseUrl raw with
    | .invalid => .null
    | .unknown => Twin.unsupported "URL syntax outside the shared parser"
    | .ok url =>
      if url.protocol != "http:" && url.protocol != "https:" then .null
      else if raw.toList.any (fun c => c.toNat <= 32 || c.toNat >= 127 || c == '@' || c == '\\') then
        Twin.unsupported "URL escaping or credentials outside the serializer"
      else
        let suffix := String.ofList (raw.toList.dropWhile fun c => c != '?' && c != '#')
        .str (url.protocol ++ "//" ++ url.hostname ++
          (if url.port == "" then "" else ":" ++ url.port) ++ url.pathname ++ suffix)
  | _ => .null

private def toTeamsSource (args : Json) : Json :=
  let result := sourceObject args 0 ["conversationId", "messageId", "threadId"] "Invalid Teams source payload"
  if (result.getObjVal? "threw").isOk then result else
    let source := Twin.arg args 0
    Json.mkObj (entries result ++ (["userId", "userName"].filterMap fun key =>
      if (str? (get source key)).isSome then some (key, get source key) else none))

private def pageId (_call : Json) : Prog Json := do
  let page ← Prog.effect "this.graphApiFetch"
    [.str "me", .str "GET", Twin.undefinedJson, Json.mkObj [("fields", .str "id")]]
  return get page "id"

private def ignoreZaloUpdate (call : Json) : Prog Json := do
  let details ← Prog.effect "describeZaloUpdate" [Twin.callArg call 0]
  return Json.mkObj [("kind", .str "ignore"), ("reason", .str
    (text (Twin.callArg call 1) ++ " " ++ text details))]

private def formatReviewCommentLabel (call : Json) : Prog Json := do
  let comment := Twin.callArg call 0
  let path ← Prog.effect "safeText" [get comment "path"]
  let line := if nullish (get comment "line") then get comment "original_line" else get comment "line"
  return .str (if jsTruthy path then "review comment on " ++ text path ++
    (if jsTruthy line then ":" ++ stringValue line else "") else "review comment")

private def isBotAssignee (call : Json) : Prog Json := do
  let bot := Twin.callArg call 1
  let assignee := get (Twin.callArg call 0) "assignee"
  if !jsTruthy bot || !jsTruthy (get assignee "login") then return .bool false
  let isBot ← Prog.effect "isBotActor" [get assignee "type"]
  if jsTruthy isBot then return .bool false
  return .bool ((text (get assignee "login")).toLower == (text bot).toLower)

private def toZaloSource (call : Json) : Prog Json := do
  let source := Twin.callArg call 0
  if !(str? (get source "chatId")).isSome then
    return ← Prog.throwError "Error" "Invalid Zalo source payload"
  let validType ← Prog.effect "isZaloChatType" [get source "chatType"]
  if !jsTruthy validType || !["messageId", "senderId", "eventName"].all
    (fun key => (str? (get source key)).isSome) then
    return ← Prog.throwError "Error" "Invalid Zalo source payload"
  return Json.mkObj (((["chatId", "chatType", "messageId", "senderId", "eventName"].map
    fun key => (key, get source key)) ++
    [("senderName", if (str? (get source "senderName")).isSome then get source "senderName" else Twin.undefinedJson),
     ("date", if (get source "date").getNum?.isOk then get source "date" else Twin.undefinedJson)]).filter (fun entry => !missing entry.2))

private def toPancakeSource (call : Json) : Prog Json := do
  let source := Twin.callArg call 0
  if !["pageId", "conversationId", "messageId"].all (fun key => (str? (get source key)).isSome) then
    return ← Prog.throwError "Error" "Invalid Pancake source payload"
  let validType ← Prog.effect "isPancakeMessageType" [get source "messageType"]
  if !jsTruthy validType then return ← Prog.throwError "Error" "Invalid Pancake source payload"
  return Json.mkObj (((["pageId", "conversationId", "messageId", "messageType"].map
    fun key => (key, get source key)) ++
    (["postId", "fromId", "fromName", "pageCustomerId"].map fun key =>
      (key, if (str? (get source key)).isSome then get source key else Twin.undefinedJson))).filter (fun entry => !missing entry.2))

private def toGitHubSource (call : Json) : Prog Json := do
  let source := Twin.callArg call 0
  if !["owner", "repo", "threadId"].all (fun key => (str? (get source key)).isSome) ||
    !(get source "installationId").getNum?.isOk then
    return ← Prog.throwError "Error" "Invalid GitHub source payload"
  let validTarget ← Prog.effect "isGitHubTarget" [get source "target"]
  if !jsTruthy validTarget then return ← Prog.throwError "Error" "Invalid GitHub source payload"
  return Json.mkObj (((["owner", "repo", "installationId", "threadId", "target"].map
    fun key => (key, get source key)) ++
    [("messageId", if (str? (get source "messageId")).isSome then get source "messageId" else Twin.undefinedJson)] ++
    (["issueNumber", "pullNumber", "commentId"].map fun key =>
      (key, if (get source key).getNum?.isOk then get source key else Twin.undefinedJson))).filter (fun entry => !missing entry.2))

private def formDecode (value : String) : String :=
  decodeUtf8 (go (value.length + 1) value.toList)
where
  go : Nat → List Char → List UInt8
  | 0, _ => []
  | fuel + 1, chars =>
    match chars with
    | [] => []
    | '+' :: rest => 32 :: go fuel rest
    | '%' :: a :: b :: rest =>
      match hexValue a, hexValue b with
      | some x, some y => (x * 16 + y).toUInt8 :: go fuel rest
      | _, _ => 37 :: go fuel (a :: b :: rest)
    | c :: rest => (String.singleton c).toUTF8.toList ++ go fuel rest

private def formParams (query : String) : List (String × String) :=
  let query := if query.startsWith "?" then dropChars query 1 else query
  (query.splitOn "&").filterMap fun pair =>
    if pair == "" then none else
      let (key, rest) := pair.toList.span (· != '=')
      some (formDecode (String.ofList key), formDecode (String.ofList (rest.drop 1)))

private def paramsJson (pairs : List (String × String)) : Json :=
  Json.mkObj [("$params", jarr (pairs.map fun (key, value) => jstrs [key, value]))]

private def readTwilioForm (call : Json) : Prog Json := do
  let pairs := formParams (text (Twin.callArg call 0))
  let received := ["MessageStatus", "SmsStatus"].filter fun key =>
    (pairs.find? (·.1 == key)).map (·.2) == some "received"
  Prog.effect "parseTwilioWebhookBody" [paramsJson (pairs.filter fun pair => !received.contains pair.1)]

private def encodeForm (value : String) : String :=
  String.join (value.toUTF8.toList.map fun b =>
    let c := Char.ofNat b.toNat
    if c.isAlphanum && c.toNat < 128 || "*-._".toList.contains c then String.singleton c
    else if c == ' ' then "+" else
      let digits := "0123456789ABCDEF".toList.toArray
      String.ofList ['%', digits.getD (b.toNat / 16) '0', digits.getD (b.toNat % 16) '0'])

private def pancakeApiUrl (call : Json) : Prog Json := do
  let path := text (Twin.callArg call 0)
  if path.startsWith "/" || path.toList.any (fun c => ":?#\\".toList.contains c || c.toNat <= 32 || c.toNat >= 127) ||
    (path.splitOn "/").any (fun segment => segment == "." || segment == "..") then
    return ← Prog.unsupported "relative URL resolution outside the simple path model"
  return Json.mkObj [("$url", .str ("https://pages.fm/api/public_api/v1/" ++ path ++
    "?page_access_token=" ++ encodeForm (text (Twin.callArg call 1))))]

private def mentions (call : Json) : Prog Json := do
  let name := text (Twin.callArg call 1)
  let _ ← Prog.effect "RegExp.escape" [.str name]
  let body := (text (Twin.callArg call 0)).toLower.toList
  let name := name.toLower
  let isWord := fun (c : Char) => c.toNat < 128 && (c.isAlphanum || c == '_' || c == '-')
  return .bool ((List.range (body.length + 1)).any fun at' =>
    ["@", "/profiles/"].any fun marker =>
      let target := (marker ++ name).toList
      target.isPrefixOf (body.drop at') &&
      !((body.drop (at' + target.length)).head?).any isWord)

private def zaloMessageMedia (call : Json) : Prog Json := do
  let event := text (Twin.callArg call 0)
  let message := Twin.callArg call 1
  let caption := jsTrim (text (get message "caption"))
  let result := fun (content : String) (attachments : List Json) =>
    Json.mkObj [("text", .str content), ("attachments", jarr attachments)]
  if event == "message.text.received" then
    let content := jsTrim (text (get message "text"))
    return if content == "" then .null else result content []
  let key := if event == "message.image.received" then "photo"
    else if event == "message.sticker.received" then "url"
    else if event == "message.voice.received" then "voice_url" else ""
  if key == "" then return .null
  let url ← Prog.effect "zaloHttpUrl" [get message key]
  if !jsTruthy url then return .null
  if event == "message.voice.received" then
    let path := match parseUrl (text url) with
      | .ok parsed => some parsed.pathname
      | _ => none
    if path.isNone then return ← Prog.unsupported "voice URL pathname outside shared parser"
    if !(path.getD "").toLower.endsWith ".aac" then
      return result ("Voice message: " ++ text url) []
    return result caption [Json.mkObj [("type", .str "audio"), ("url", url),
      ("name", .str "voice.aac"), ("mimeType", .str "audio/aac")]]
  return result (if key == "url" then "" else caption)
    [Json.mkObj [("type", .str "image"), ("url", url),
      ("name", .str (if key == "url" then "sticker" else "photo"))]]

private def webhookTimestamp (call : Json) : Prog Json := do
  let body ← Prog.effect "parseChannelWebhookBody" [.str "linear", get (Twin.callArg call 0) "body"]
  let timestamp := get (get body "payload") "webhookTimestamp"
  return if get body "kind" == .str "payload" && timestamp.getNum?.isOk then timestamp else Twin.undefinedJson

private def renderTwilioText (call : Json) : Prog Json := do
  let formatted ← Prog.effect "TWILIO_FORMAT.fromMarkdown" [Twin.callArg call 0]
  Prog.effect "chunkChannelText" [formatted, toJson (1600 : Nat)]

private def executeCommand (call : Json) : Prog Json := do
  let handler := commandTable.find? fun candidate =>
    (jstrs candidate.aliases |> items).contains (Twin.callArg call 0)
  match handler with
  | none => pure Twin.undefinedJson
  | some _ =>
    let outcome ← Prog.attempt "handler.execute" [Twin.callArg call 1]
    let result ← match outcome with
      | .ok reply => pure (Json.mkObj [("reply", reply)])
      | .threw error _ =>
        let message := get (get error "$error") "message"
        pure (Json.mkObj [("reply", .str "Something went wrong. Please try again."),
          ("error", if missing message then .str (stringValue error) else message)])
      | .pending => Prog.unsupported "unfinished command"
    if jsTruthy (get (Twin.callArg call 1) "channel") then
      let _ ← Prog.effect "ctx.channel?.sendText" [get result "reply"]
    return result

private def errorResponse (status : Nat) (message : Json) (extra : List Json := []) : Prog Json :=
  Prog.effect "errorResponse" ([toJson status, message] ++ extra)

private def pureTwin (path name : String) (run : Json → Json) : Twin :=
  { source := "apps/core/src/" ++ path ++ ".ts#" ++ name, run := run }
private def inStrings (value : Json) (allowed : List String) : Json :=
  .bool (allowed.any fun candidate => value == .str candidate)

/-- Counterparts of the assigned channel helpers. -/
def twins : List Twin :=
  [pureTwin "shared/meta-channel" "splitMetaText" splitMetaText,
   Twin.traced "apps/core/src/harness/integrations.ts#resolveChannelTarget" resolveChannelTarget,
   pureTwin "shared/pancake-channel" "pancakeDropReason" pancakeDropReason,
   pureTwin "shared/pancake-channel" "pancakeAttachments" pancakeAttachments,
   pureTwin "shared/pancake-channel" "parseJsonBody" (parseBody true),
   pureTwin "shared/meta-channel" "messageEvents" messageEvents,
   Twin.traced "apps/core/src/shared/commands.ts#withIngressClearLease" withIngressClearLease,
   pureTwin "shared/github-channel" "formatTitleAndBody" formatTitleAndBody,
   pureTwin "shared/pancake-channel" "normalizePancakeTagIds" normalizePancakeTagIds,
   pureTwin "shared/zalo-channel" "unwrapZaloUpdate" unwrapZaloUpdate,
   Twin.traced "apps/core/src/shared/linear-channel.ts#BroodsLinearAdapter.loadIdentity" loadIdentity,
   Twin.traced "apps/core/src/harness/integrations.ts#channelReplySource" channelReplySource,
   pureTwin "shared/github-channel" "isPriorGitHubComment" isPriorGitHubComment,
   pureTwin "shared/zalo-channel" "parseJsonBody" (parseBody false),
   pureTwin "shared/teams-channel" "teamsIdentity" teamsIdentity,
   Twin.traced "apps/core/src/harness/integrations.ts#buildStatusUrl" buildStatusUrl,
   Twin.traced "apps/core/src/shared/pancake-channel.ts#hashEventContent" hashEventContent,
   Twin.traced "apps/core/src/shared/teams-channel.ts#withGuardedRead" (fun call => pure (
     let args := get call "args"
     let attachment := Twin.arg args 0
     if get (get attachment "fetchMetadata") "auth" == .str "bot" then attachment
     else dropField attachment "fetchData")),
   pureTwin "shared/teams-channel" "withoutBotMention" withoutBotMention,
   pureTwin "shared/linear-channel" "formatIssueContext" formatIssueContext,
   pureTwin "shared/github-channel" "githubIdentity" githubIdentity,
   pureTwin "shared/meta-channel" "toMetaSource" (fun args =>
     sourceObject args 1 ["messageId", "recipientId", "senderId", "threadId"]
       ("Invalid " ++ text (Twin.arg args 0) ++ " source payload")),
   pureTwin "shared/meta-channel" "urlAttachments" urlAttachments,
   pureTwin "shared/linear-channel" "toLinearSource" (fun args =>
     sourceObject args 0 ["commentId", "issueId", "threadId"] "Invalid Linear source payload"),
   pureTwin "shared/pancake-channel" "isPancakeMessageType" (fun args =>
     inStrings (Twin.arg args 0) ["INBOX", "COMMENT"]),
   pureTwin "shared/zalo-channel" "isZaloChatType" (fun args =>
     inStrings (Twin.arg args 0) ["PRIVATE", "GROUP"]),
   pureTwin "shared/github-channel" "isBotActor" (fun args => .bool (Twin.arg args 0 == .str "Bot")),
   pureTwin "shared/github-channel" "isGitHubTarget" (fun args =>
     inStrings (Twin.arg args 0) ["issue", "issue_comment", "pull_request", "pull_request_review_comment"]),
   pureTwin "shared/github-channel" "isRelevantAction" (fun args =>
     inStrings (Twin.arg args 0) ["opened", "reopened", "created"]),
   pureTwin "shared/pancake-channel" "formatPancakeError" (fun args =>
     let message := get (Twin.arg args 0) "message"
     if !nullish message then message else
       if jsTruthy (Twin.arg args 1) then Twin.arg args 1 else .str "unknown_error"),
   pureTwin "shared/zalo-channel" "formatZaloError" (fun args =>
     let body := Twin.arg args 0
     let description := get body "description"
     let code := get body "error_code"
     if !nullish description then description else if !nullish code then .str (stringValue code)
     else if jsTruthy (Twin.arg args 1) then Twin.arg args 1 else .str "unknown_error"),
   pureTwin "shared/zalo-channel" "describeZaloUpdate" describeZaloUpdate,
   pureTwin "shared/zalo-channel" "zaloHttpUrl" zaloHttpUrl,
   pureTwin "shared/github-channel" "safeText" safeText,
   pureTwin "shared/github-channel" "truncateText" truncateText,
   pureTwin "shared/github-channel" "normalizePrivateKey" normalizePrivateKey,
   pureTwin "shared/github-channel" "base64UrlEncode" base64UrlEncode,
   pureTwin "shared/teams-channel" "toTeamsSource" toTeamsSource,
   pureTwin "shared/twilio-channel" "toTwilioSource" (fun args =>
     sourceObject args 0 ["from", "messageSid", "to"] "Invalid Twilio source payload"),
   pureTwin "media" "routesToMedia" (fun args => .bool (
     (text (Twin.arg args 1)).startsWith "/v1/media/" &&
     ["GET", "HEAD"].contains (text (Twin.arg args 0)).toUpper)),
   Twin.traced "apps/core/src/shared/messenger-channel.ts#BroodsMessengerAdapter.pageId" pageId,
   Twin.traced "apps/core/src/shared/zalo-channel.ts#ignoreZaloUpdate" ignoreZaloUpdate,
   Twin.traced "apps/core/src/shared/github-channel.ts#formatReviewCommentLabel" formatReviewCommentLabel,
   Twin.traced "apps/core/src/shared/github-channel.ts#isBotAssignee" isBotAssignee,
   Twin.traced "apps/core/src/shared/zalo-channel.ts#toZaloSource" toZaloSource,
   Twin.traced "apps/core/src/shared/pancake-channel.ts#toPancakeSource" toPancakeSource,
   Twin.traced "apps/core/src/shared/github-channel.ts#toGitHubSource" toGitHubSource,
   { source := "apps/discord-forwarder/src/log.ts#tokenHint", run := fun args =>
       let token := text (Twin.arg args 0)
       .str ("…" ++ String.ofList (token.toList.drop (token.length - 4))) },
   Twin.traced "apps/core/src/shared/twilio-channel.ts#readTwilioForm" readTwilioForm,
   Twin.traced "apps/core/src/shared/meta-channel.ts#handshakeParams" (fun call =>
     pure (paramsJson (formParams (text (get (Twin.callArg call 0) "rawQueryString"))))),
   Twin.traced "apps/core/src/shared/pancake-channel.ts#pancakeApiUrl" pancakeApiUrl,
   Twin.traced "apps/core/src/shared/linear-channel.ts#mentions" mentions,
   Twin.traced "apps/core/src/shared/zalo-channel.ts#zaloMessageMedia" zaloMessageMedia,
   Twin.traced "apps/core/src/shared/linear-channel.ts#webhookTimestamp" webhookTimestamp,
   Twin.traced "apps/core/src/shared/twilio-channel.ts#renderTwilioText" renderTwilioText,
   Twin.traced "apps/core/src/shared/commands.ts#executeCommand" executeCommand,
   Twin.traced "apps/core/src/shared/github-channel.ts#BroodsGitHubAdapter.verifyWebhookSignature" (fun call =>
     Prog.effect "this.verifySignature" [Twin.callArg call 0, Twin.callArg call 1]),
   Twin.traced "apps/core/src/harness/integrations.ts#integrationNotConfigured" (fun call =>
     errorResponse 503 (.str (text (Twin.callArg call 0) ++ " integration is not configured"))),
   Twin.traced "apps/core/src/harness/integrations.ts#directApiDisabledResponse" (fun _ =>
     errorResponse 404 (.str "Direct API is disabled")),
   Twin.traced "apps/core/src/harness/integrations.ts#unauthorizedResponse" (fun _ =>
     errorResponse 401 (.str "Unauthorized")),
   Twin.traced "apps/core/src/harness/integrations.ts#notFoundResponse" (fun _ =>
     errorResponse 404 (.str "Not found")),
   Twin.traced "apps/core/src/harness/integrations.ts#runTokenScopeResponse" (fun call =>
     errorResponse 403 (.str ("A run token may only GET /v1/runs/{runId} for agent " ++
       text (Twin.callArg call 0) ++ "'s runs. Starting runs with a run token is not enabled yet."))
       [Json.mkObj [("code", .str "run_token_scope")]])] ++
  Socket.twins ++ Delivery.twins ++ Providers.twins ++ GitHub.twins ++ Routing.twins

end Spec.Channels.Wavechannels1
