import Spec.Channels.Twins.Support

/-!
Twins for the functions listed in `.lake/worklist/assign5/channels5a.tsv`.
-/

namespace Spec.Channels.Wavechannels5a

open Lean Spec Spec.Channels

private def get (v : Json) (k : String) : Json := (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def text (v : Json) : String := v.getStr?.toOption.getD ""
private def items (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def undef : Json := Twin.undefinedJson
private def isUndef (v : Json) : Bool := v == Twin.undefinedJson
private def live (v : Json) : Bool := !isUndef v && v != .null && truthy v
private def a (c : Json) (n : Nat) : Json := Twin.callArg c n
private def num (n : Nat) : Json := toJson n
private def integrations (name : String) : String := s!"apps/core/src/harness/integrations.ts#{name}"
private def forwarder (file name : String) : String := s!"apps/discord-forwarder/src/{file}.ts#{name}"

/-- An object literal as the recorder sees it: keys holding `undefined` are absent. -/
private def obj (pairs : List (String × Json)) : Json :=
  Json.mkObj (pairs.filter (fun pair => !isUndef pair.2))

private def nullishOr (v fallback : Json) : Json := if isUndef v || v == .null then fallback else v

/-! ## Adapter factories -/

private def channelOf (c : Json) (name : String) : Json := get (get (a c 0) "channels") name

private def reach (channel : Json) : Prog (Json × Json) := do
  let channels ← Prog.effect "reachSet" [get channel "allowedChannelIds"]
  let users ← Prog.effect "reachSet" [get channel "allowedUserIds"]
  pure (channels, users)

private def allLive (channel : Json) (names : List String) : Bool :=
  names.all fun name => live (get channel name)

private def createTelegram (c : Json) : Prog Json := do
  let ch := channelOf c "telegram"
  if !allLive ch ["botToken", "webhookSecret"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createTelegramChannel"
    [get ch "botToken", get ch "webhookSecret", channels, users,
     nullishOr (get ch "reactionEmoji") (.str "👀"), get ch "apiUrl",
     if live (get ch "botUsername") then obj [("botUsername", get ch "botUsername")] else obj []]

private def createGoogleChat (c : Json) : Prog Json := do
  let ch := channelOf c "gchat"
  if !live (get ch "credentials") ||
      !(live (get ch "endpointUrl") || live (get ch "googleChatProjectNumber")) then
    return .null
  let credentials ← Prog.effect "parseServiceAccountKey" [get ch "credentials"]
  if !live credentials then return .null
  let (channels, users) ← reach ch
  Prog.effect "createGoogleChatChannel"
    [obj [("allowedChannelIds", channels), ("allowedUserIds", users), ("credentials", credentials),
      ("endpointUrl", get ch "endpointUrl"),
      ("googleChatProjectNumber", get ch "googleChatProjectNumber"),
      ("userName", get ch "userName"),
      ("workspaceAddOnServiceAccountEmail", get ch "workspaceAddOnServiceAccountEmail")]]

private def createGitHub (c : Json) : Prog Json := do
  let ch := channelOf c "github"
  if !allLive ch ["webhookSecret", "appId", "privateKey"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createGitHubChannel"
    [get ch "webhookSecret", get ch "appId", get ch "privateKey", channels, users, get ch "apiUrl",
     get ch "botUserName", get ch "botUserId",
     obj [("triggerOnIssueOpen", get ch "triggerOnIssueOpen"),
          ("triggerOnPROpen", get ch "triggerOnPROpen")]]

private def createLinear (c : Json) : Prog Json := do
  let ch := channelOf c "linear"
  if !allLive ch ["apiKey", "webhookSecret", "userName"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createLinearChannel"
    [obj [("allowedChannelIds", channels), ("allowedUserIds", users), ("apiKey", get ch "apiKey"),
      ("apiUrl", get ch "apiUrl"), ("userName", get ch "userName"),
      ("webhookSecret", get ch "webhookSecret")]]

private def createSlack (c : Json) : Prog Json := do
  let ch := channelOf c "slack"
  if !allLive ch ["botToken", "signingSecret"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createSlackChannel"
    [get ch "botToken", get ch "signingSecret", channels, users,
     nullishOr (get ch "reactionEmoji") (.str "eyes"), get ch "apiUrl"]

private def createDiscord (c : Json) : Prog Json := do
  let ch := channelOf c "discord"
  if !allLive ch ["botToken", "publicKey"] then return .null
  let (channels, users) ← reach ch
  let keep (name : String) : List (String × Json) :=
    if live (get ch name) then [(name, get ch name)] else []
  Prog.effect "createDiscordChannel"
    [get ch "botToken", get ch "publicKey", channels, users, get ch "apiUrl",
     obj (keep "botUserId" ++ keep "mentionRoleIds")]

private def createPancake (c : Json) : Prog Json := do
  let ch := channelOf c "pancake"
  if !allLive ch ["pageId", "pageAccessToken", "webhookSecret"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createPancakeChannel"
    [get ch "pageId", get ch "pageAccessToken", get ch "webhookSecret", channels, users,
     get ch "senderId"]

private def createTeams (c : Json) : Prog Json := do
  let ch := channelOf c "teams"
  if !allLive ch ["appId", "appPassword"] ||
      (get ch "appType" != .str "MultiTenant" && !live (get ch "appTenantId")) then
    return .null
  let (channels, users) ← reach ch
  Prog.effect "createTeamsChannel"
    [obj [("allowedChannelIds", channels), ("allowedUserIds", users), ("apiUrl", get ch "apiUrl"),
      ("appId", get ch "appId"), ("appPassword", get ch "appPassword"),
      ("appTenantId", get ch "appTenantId"), ("appType", get ch "appType"),
      ("userName", get ch "userName")]]

private def createTwilio (c : Json) : Prog Json := do
  let ch := channelOf c "twilio"
  if !allLive ch ["accountSid", "authToken"] then return .null
  let (channels, users) ← reach ch
  let publicBaseUrl ← Prog.effect "getHarnessPublicUrl"
  Prog.effect "createTwilioChannel"
    [obj [("accountSid", get ch "accountSid"), ("allowedChannelIds", channels),
      ("allowedUserIds", users), ("apiUrl", get ch "apiUrl"), ("authToken", get ch "authToken"),
      ("messagingServiceSid", get ch "messagingServiceSid"), ("phoneNumber", get ch "phoneNumber"),
      ("publicBaseUrl", publicBaseUrl), ("statusCallbackUrl", get ch "statusCallbackUrl"),
      ("userName", get ch "userName"), ("webhookUrl", get ch "webhookUrl")]]

private def createZalo (c : Json) : Prog Json := do
  let ch := channelOf c "zalo"
  if !allLive ch ["botToken", "webhookSecret"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createZaloChannel"
    [get ch "botToken", get ch "webhookSecret",
     obj [("allowedChannelIds", channels), ("allowedUserIds", users)]]

private def createInstagram (c : Json) : Prog Json := do
  let ch := channelOf c "instagram"
  if !allLive ch ["accessToken", "accountId", "appSecret", "verifyToken"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createInstagramChannel"
    [obj [("accessToken", get ch "accessToken"), ("accountId", get ch "accountId"),
      ("allowedChannelIds", channels), ("allowedUserIds", users),
      ("apiVersion", get ch "apiVersion"), ("appSecret", get ch "appSecret"),
      ("userName", get ch "userName"), ("verifyToken", get ch "verifyToken")]]

private def createMessenger (c : Json) : Prog Json := do
  let ch := channelOf c "messenger"
  if !allLive ch ["appSecret", "pageAccessToken", "verifyToken"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createMessengerChannel"
    [obj [("allowedChannelIds", channels), ("allowedUserIds", users),
      ("apiVersion", get ch "apiVersion"), ("appSecret", get ch "appSecret"),
      ("pageAccessToken", get ch "pageAccessToken"), ("userName", get ch "userName"),
      ("verifyToken", get ch "verifyToken")]]

private def createWhatsApp (c : Json) : Prog Json := do
  let ch := channelOf c "whatsapp"
  if !allLive ch ["accessToken", "appSecret", "phoneNumberId", "verifyToken"] then return .null
  let (channels, users) ← reach ch
  Prog.effect "createWhatsAppChannel"
    [obj [("accessToken", get ch "accessToken"), ("allowedChannelIds", channels),
      ("allowedUserIds", users), ("apiUrl", get ch "apiUrl"), ("apiVersion", get ch "apiVersion"),
      ("appSecret", get ch "appSecret"), ("phoneNumberId", get ch "phoneNumberId"),
      ("userName", get ch "userName"), ("verifyToken", get ch "verifyToken")]]

private def channelAdapterFromConfig (c : Json) : Prog Json := do
  let registry ← Prog.effect "createChannelRegistry" [a c 0]
  let found := (items (get registry "webhookChannels")).find? fun adapter =>
    get adapter "name" == a c 1
  pure (found.getD .null)

private def channelActionsFromConfig (c : Json) : Prog Json := do
  let adapter ← Prog.effect "channelAdapterFromConfig" [a c 0, a c 1]
  if !live adapter then return .null
  Prog.effect "adapter.actions"
    [obj [("eventId", .str ""), ("conversationKey", .str ""), ("channelName", a c 1),
      ("content", .str ""), ("source", a c 2)]]

private def resolveCommandToken (c : Json) : Prog Json := do
  let token := get (a c 1) "commandToken"
  if token.getStr?.toOption.isSome then
    return ← Prog.effect "parseCommand" [token]
  let inline ← Prog.effect "supportsInlineCommands" [a c 2]
  if !live inline then return .null
  let content ← Prog.effect "extractText" [a c 0]
  let command ← Prog.effect "parseCommand" [content]
  pure (if live command then command else .null)

/-- `ackInbound`: `send` runs on a task of its own, so its outcome only reaches the log. -/
private def ackInbound (_ : Json) : Prog Json := do
  Prog.spawn "send"
  pure undef

/-! ## `handleConversationFilesRequest` -/

/-- `MAX_CONVERSATION_FILES_BODY_BYTES` in `harness/conversation-files.ts`. -/
private def maxFilesBody : Nat := 6 * 1024 * 1024

/-- `URLSearchParams.get`: the first value under `key`. -/
private def queryGet (query : Json) (key : String) : Option String :=
  (items (get query "$params")).findSome? fun pair =>
    match items pair with
    | [name, value] => if name == .str key then value.getStr?.toOption else none
    | _ => none

/-- `String.length` in JavaScript counts UTF-16 units. -/
private def utf16Length (s : String) : Nat :=
  s.toList.foldl (fun total ch => total + if ch.val > 0xFFFF then 2 else 1) 0

private def constructed (label : String) (args : List Json) : Prog Json := do
  let error ← Prog.effect label args
  throw error

private def outcomeValue : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => throw error
  | .pending => Prog.unsupported "an unfinished loader"

private def filesBody (request auth : Json) : Prog Json := do
  let query := get request "query"
  let accountId := get (get auth "account") "accountId"
  let agentId ← Prog.effect "normalizeDirectIdentifier"
    [.str "agentId", .str ((queryGet query "agentId").getD "")]
  let loaded ← Prog.all
    [("context.agentLoader", [accountId, agentId]),
     ("context.deploymentLoader", [accountId, agentId])]
  let (agent, deployment) ← match loaded with
    | [first, second] => do
      let agent ← outcomeValue first
      let deployment ← outcomeValue second
      pure (agent, deployment)
    | _ => Prog.unsupported "Promise.all of two"
  if !live agent then
    let _ ← constructed "new DirectNotFoundError" [.str "Agent not found"]
  let admitted ← Prog.effect "admitStageCredential" [auth, agent, deployment]
  let user := if live admitted then get auth "user" else undef
  if !live user then
    let _ ← constructed "new DirectForbiddenError"
      [.str "Conversation files need the runtime key with a user token: they are that user's folder.",
       obj [("code", .str "user_token_required")]]
  let keys ← Prog.effect "directConversationKeys"
    [.str ((queryGet query "conversationKey").getD ""), toJson false, accountId,
     get agent "agentId", obj [("user", user)]]
  let config ← Prog.effect "toRuntimeAgentConfig" [get agent "config"]
  let runtime ← Prog.effect "resolveAgentRuntime"
    [config, obj [("accountId", accountId), ("agentId", get agent "agentId")],
     obj [("userConversationKey", get keys "conversationKey")]]
  let name := (queryGet query "workspace").getD ""
  let chosen := (items (get runtime "workspaces")).find? fun entry =>
    name.isEmpty || get entry "name" == .str name
  let target ← match chosen with
    | some entry => if live (get entry "sandbox") then pure entry else notFound name
    | none => notFound name
  if get request "method" == .str "GET" then
    let files ← Prog.effect "readConversationFiles" [target]
    return ← Prog.effect "jsonResponse" [num 200, obj [("files", files)]]
  let body ← match (get request "body").getStr?.toOption with
    | some value => pure value
    | none => Prog.unsupported "body too big to record, so its length is unknown"
  if utf16Length body > maxFilesBody then
    return ← Prog.effect "errorResponse"
      [num 413, .str "A conversation files body is capped at 6 MiB"]
  let parsed ← match Json.parse body with
    | .ok value => pure value
    | .error _ => Prog.unsupported "the JSON.parse message is the engine's own"
  let result ← Prog.effect "conversationFilesSchema.safeParse" [parsed]
  if !live (get result "success") then
    throw (Prog.errorJson "Error" "Body must be { files: [{ path, contentBase64 }] }")
  let files := get (get result "data") "files"
  let _ ← Prog.effect "writeConversationFiles" [target, files]
  Prog.effect "jsonResponse" [num 200, obj [("files", num (items files).length)]]
where
  notFound (name : String) : Prog Json :=
    constructed "new DirectNotFoundError"
      [.str (if name.isEmpty then "This agent has no workspace with a sandbox"
             else s!"No workspace {name} with a sandbox on this agent")]

private def handleConversationFilesRequest (c : Json) : Prog Json := do
  let request := a c 0
  let context := a c 2
  let method := get request "method"
  if method != .str "GET" && method != .str "PUT" then
    return ← Prog.effect "methodNotAllowed" [.arr #[.str "GET", .str "PUT"]]
  if !live (get context "directApiEnabled") then
    return ← Prog.effect "directApiDisabledResponse"
  let auth ← Prog.effect "context.authResolver" [get request "headers"]
  if get auth "kind" != .str "deployment" then
    return ← Prog.effect "unauthorizedResponse"
  let matches_ ← Prog.effect "deploymentMatchesPath" [auth, a c 1]
  if !live matches_ then
    return ← Prog.effect "unauthorizedResponse"
  Prog.catchFail (filesBody request auth) fun error =>
    match error.getObjVal? "$unsupported" with
    | .ok _ => throw error
    | .error _ => Prog.effect "badRequestResponse" [error]

/-! ## Telegram stickers -/

private def stickerError : String := "Telegram sendSticker needs an absolute http(s) sticker URL"

/-- `new URL` throwing and a scheme other than http(s) give the same error. -/
private def assertTelegramStickerUrl (args : Json) : Json :=
  match parseUrl (text (Twin.arg args 0)) with
  | .ok url =>
    if url.protocol == "http:" || url.protocol == "https:" then .null
    else Twin.threw stickerError
  | .invalid => Twin.threw stickerError
  | .unknown => Twin.unsupported "a URL the parser model leaves open"

/-! ## Forwarder configuration -/

/-- `deployKeyEnvName`: plane names are checked ASCII by `parseConfigPlanes`. -/
private def deployKeyEnvName (args : Json) : Json :=
  let upper := (text (Twin.arg args 0)).toList.map fun ch => if ch == '-' then '_' else ch.toUpper
  .str ("CONVEX_DEPLOY_KEY_" ++ String.ofList upper)

private def configPlanesEnv (_ : Json) : Prog Json := do
  let raw ← Prog.effect "requireEnv" [.str "BROODS_CONFIG_PLANES"]
  let planes ← Prog.effect "parseConfigPlanes" [raw]
  let mut out : Array Json := #[]
  for plane in items planes do
    let name ← Prog.effect "deployKeyEnvName" [get plane "name"]
    let deployKey ← Prog.effect "requireEnv" [name]
    out := out.push (obj [("convexUrl", get plane "convexUrl"), ("deployKey", deployKey),
      ("name", get plane "name"), ("webhookBaseUrl", get plane "webhookBaseUrl")])
  pure (.arr out)

private def forwarderConfigFromEnv (_ : Json) : Prog Json := do
  let ceiling ← Prog.effect "positiveIntegerEnv" [.str "DISCORD_BACKOFF_CEILING_MS", num 300000]
  let identify ← Prog.effect "positiveIntegerEnv" [.str "DISCORD_IDENTIFY_LIMIT", num 500]
  let planes ← Prog.effect "configPlanesEnv"
  let port ← Prog.effect "positiveIntegerEnv" [.str "PORT", num 3000]
  pure (obj [("backoffCeilingMs", ceiling), ("identifyLimit", identify), ("planes", planes),
    ("port", port)])

/-! ## Config plane subscriptions -/

private def setAdminAuth : String :=
  "(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth"

private def planeClient (c : Json) : Prog Json := do
  let plane := a c 0
  let client ← Prog.effect "new ConvexClient" [get plane "convexUrl"]
  let _ ← Prog.effect setAdminAuth [get plane "deployKey"]
  pure client

private abbrev Latest := List (String × Json)

private def latestOf (latest : Latest) (name : String) : Json :=
  ((latest.find? (·.1 == name)).map (·.2)).getD .null

private def setLatest (latest : Latest) (name : String) (value : Json) : Latest :=
  (name, value) :: latest.filter (·.1 != name)

/-- `onRows` updates this plane's answer and publishes every plane's; `onError` only logs. -/
private def onCallback (c plane : Json) (latest : Latest) (label : String) (args : Json) :
    Prog Latest := do
  match label with
  | "arg2" =>
    let name := text (get plane "name")
    let resolved ← Prog.effect "resolve" [plane, Twin.arg args 0]
    let next := setLatest latest name resolved
    let planes := items (a c 1)
    let answers := planes.map fun entry => latestOf next (text (get entry "name"))
    let _ ← Prog.effect "onChange" [jarr (answers.flatMap items)]
    pure next
  | "arg3" => pure latest
  | other => Prog.unsupported s!"callback {other}"

private def drainPlane (c plane : Json) : Nat → Latest → Prog Latest
  | 0, latest => pure latest
  | fuel + 1, latest =>
    .input fun
      | none => pure latest
      | some (label, args) =>
        (onCallback c plane latest label args).bind (drainPlane c plane fuel)

private def watchChannelConnections (c : Json) : Prog Json := do
  let mut latest : Latest := []
  for plane in items (a c 1) do
    let _ ← Prog.effect "planeClient" [plane]
    let _ ← Prog.effect "client.onUpdate"
      [(Json.mkObj [("$convexFunction", toJson "channel/connections:listConnections")]), obj [("channel", a c 0)], Json.mkObj [("$fn", .str "")],
       Json.mkObj [("$fn", .str "")]]
    latest ← drainPlane c plane 64 latest
  pure (obj [("close", Json.mkObj [("$fn", .str "close")])])

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (integrations "createTelegramChannelFromConfig") createTelegram,
   Twin.traced (integrations "createGoogleChatChannelFromConfig") createGoogleChat,
   Twin.traced (integrations "createGitHubChannelFromConfig") createGitHub,
   Twin.traced (integrations "createLinearChannelFromConfig") createLinear,
   Twin.traced (integrations "createSlackChannelFromConfig") createSlack,
   Twin.traced (integrations "createDiscordChannelFromConfig") createDiscord,
   Twin.traced (integrations "createPancakeChannelFromConfig") createPancake,
   Twin.traced (integrations "createTeamsChannelFromConfig") createTeams,
   Twin.traced (integrations "createTwilioChannelFromConfig") createTwilio,
   Twin.traced (integrations "createZaloChannelFromConfig") createZalo,
   Twin.traced (integrations "createInstagramChannelFromConfig") createInstagram,
   Twin.traced (integrations "createMessengerChannelFromConfig") createMessenger,
   Twin.traced (integrations "createWhatsAppChannelFromConfig") createWhatsApp,
   Twin.traced (integrations "channelAdapterFromConfig") channelAdapterFromConfig,
   Twin.traced (integrations "channelActionsFromConfig") channelActionsFromConfig,
   Twin.traced (integrations "resolveCommandToken") resolveCommandToken,
   Twin.traced (integrations "ackInbound") ackInbound,
   Twin.traced (integrations "handleConversationFilesRequest") handleConversationFilesRequest,
   { source := "apps/core/src/shared/telegram-channel.ts#assertTelegramStickerUrl"
     run := assertTelegramStickerUrl },
   { source := forwarder "config" "deployKeyEnvName", run := deployKeyEnvName },
   Twin.traced (forwarder "config" "configPlanesEnv") configPlanesEnv,
   Twin.traced (forwarder "config" "forwarderConfigFromEnv") forwarderConfigFromEnv,
   Twin.traced (forwarder "connections" "planeClient") planeClient,
   Twin.traced (forwarder "connections" "watchChannelConnections") watchChannelConnections]

end Spec.Channels.Wavechannels5a
