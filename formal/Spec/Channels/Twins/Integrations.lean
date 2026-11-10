import Spec.Channels.Twins.Commands
import Spec.Channels.Twins.Record

/-!
Twins of the decisions in `apps/core/src/harness/integrations.ts`: request paths, direct-API payloads,
conversation keys, and which channel adapters a config can build. An adapter holds functions, so a
factory call that builds one has no JSON outcome and the twin says `unsupported`.
-/

namespace Spec.Channels

open Lean

private def source : String := "apps/core/src/harness/integrations.ts"

/-- `USER_CONVERSATION_PREFIX` in `packages/convex/model/userToken.ts:17`. -/
def userConversationPrefixText : String := "bsu:"

/-- `RESERVED_CONVERSATION_PREFIXES` in `apps/core/src/shared/runtime-keys.ts:53`. -/
def reservedConversationPrefixes : List String :=
  ["bsu:", "conversation-lease:", "acct:", "api:", "gchat:", "gh:", "linear:", "slack:", "teams:",
    "tg:", "twilio:", "discord:", "pancake:", "zalo:", "instagram:", "messenger:", "whatsapp:"]

/-- `RESERVED_EVENT_ID_PREFIXES` in `apps/core/src/shared/runtime-keys.ts:36`. -/
def reservedEventIdPrefixes : List String :=
  ["bsu:", "conversation-lease:", "acct:", "api:", "gchat:", "gh:", "linear:", "slack:",
    "slack-command:", "teams:", "tg:", "twilio:", "discord:", "pancake:", "subagent~", "zalo:",
    "instagram:", "messenger:", "whatsapp:"]

/-- `userConversationPrefix`. -/
def userConversationPrefix (userId : String) : String :=
  s!"{userConversationPrefixText}{userId}:"

/-- `normalizeDirectIdentifier`. -/
def normalizeDirectIdentifier (name value : String) : Except String String :=
  let normalized := jsTrim value
  if normalized.isEmpty then .error s!"{name} must not be empty" else .ok normalized

/-- `assertValidPublicConversationKey`. -/
def validPublicConversationKey (value : String) : Except String String := do
  let normalized ← normalizeDirectIdentifier "conversationKey" value
  if reservedConversationPrefixes.any (fun pre => normalized.startsWith pre) then
    .error "conversationKey uses a reserved channel or internal prefix"
  else .ok normalized

/-- `assertValidPublicEventId`. -/
def validPublicEventId (value : String) : Except String String := do
  let normalized ← normalizeDirectIdentifier "eventId" value
  if reservedEventIdPrefixes.any (fun pre => normalized.startsWith pre) then
    .error "eventId uses a reserved internal prefix"
  else .ok normalized

/-- `userOwnsConversation`. `token` is the JSON `UserToken`. -/
def userOwnsConversation (token : Json) (publicKey : String) : Bool :=
  let pre := userConversationPrefix ((str? (field token "userId")).getD "")
  match stripPrefix? publicKey pre with
  | none => false
  | some bare =>
    !bare.isEmpty &&
      match field? token "conversations" with
      | none => true
      | some allowed => ((arr? allowed).getD []).contains (.str bare)

/-- `userConversationKey`. -/
def userConversationKey (token : Json) (requested : String) : Option String :=
  let pre := userConversationPrefix ((str? (field token "userId")).getD "")
  let key := if requested.startsWith pre then requested else pre ++ requested
  if userOwnsConversation token key then some key else none

/-- `embeddableKeyReaches`, with the user token as JSON and null for `undefined`. -/
def embeddableKeyReaches (user : Json) (publicKey : String) : Bool :=
  if truthy user then userOwnsConversation user publicKey
  else !publicKey.startsWith userConversationPrefixText

/-- The groups of `/^acct:([^:]+):agent:([^:]+):(.+)$/`: account, agent and key. `.` excludes line
terminators, and `[^:]+` cannot cross a colon, so the first split is the only match. -/
def parseAccountAgentScopedKey (value : String) : Option (String × String × String) :=
  match stripPrefix? value "acct:" with
  | none => none
  | some rest =>
    let (account, afterAccount) := rest.toList.span (· != ':')
    if account.isEmpty then none
    else
      let afterMarker := ":agent:".toList.isPrefixOf afterAccount
      if !afterMarker then none
      else
        let (agent, afterAgent) := (afterAccount.drop 7).span (· != ':')
        if agent.isEmpty then none
        else
          match afterAgent with
          | ':' :: key =>
            let lineEnd := fun (c : Char) =>
              c == '\n' || c == '\r' || c.toNat == 0x2028 || c.toNat == 0x2029
            if key.isEmpty || key.any lineEnd then none
            else some (String.ofList account, String.ofList agent, String.ofList key)
          | _ => none

/-- `publicConversationKeyFromScoped`. -/
def publicConversationKeyFromScoped (key accountId agentId : String) : String :=
  let accountPrefix :=
    if agentId.isEmpty then s!"acct:{accountId}:" else s!"acct:{accountId}:agent:{agentId}:"
  let unscoped := (stripPrefix? key accountPrefix).getD key
  (stripPrefix? unscoped "api:").getD unscoped

/-- `directConversationKeys`: the stored and public keys, or the thrown message. -/
def directConversationKeys (requested : String) (continuation : Bool) (accountId agentId : String)
    (embeddable : Json) : Except String Json :=
  let user := field embeddable "user"
  let notFound := Except.error "Conversation not found"
  if continuation && requested.startsWith "acct:" then
    let publicKey := publicConversationKeyFromScoped requested accountId agentId
    match parseAccountAgentScopedKey requested with
    | none => notFound
    | some (account, agent, key) =>
      if account != accountId || agent != agentId ||
          (truthy embeddable &&
            (!key.startsWith "api:" || !embeddableKeyReaches user publicKey)) then
        notFound
      else
        .ok (Json.mkObj
          [("conversationKey", toJson requested), ("publicConversationKey", toJson publicKey)])
  else do
    let requestedKey ← normalizeDirectIdentifier "conversationKey" requested
    let publicKey? :=
      if truthy user then userConversationKey user requestedKey else some requestedKey
    match publicKey? with
    | none => .error "The user token does not list this conversationKey."
    | some publicKey =>
      let bare :=
        if truthy user then
          dropChars publicKey (userConversationPrefix ((str? (field user "userId")).getD "")).length
        else publicKey
      let checked ← validPublicConversationKey bare
      if checked != bare then .error "conversationKey must not start or end with whitespace"
      else
        .ok (Json.mkObj
          [("conversationKey", toJson s!"acct:{accountId}:agent:{agentId}:api:{publicKey}"),
            ("publicConversationKey", toJson publicKey)])

/-- A twin's output for a computed value or a thrown message. -/
def fromExcept : Except String Json → Json
  | .ok value => value
  | .error message => Spec.Twin.threw message

/-- `decodeURIComponent` over a list, or `none` where any segment throws. -/
def decodePathSegments (segments : List String) : Option (List String) :=
  segments.mapM decodeComponent?

/-- `matchWebhookPath`: account, endpoint and channel of either webhook shape. -/
def matchWebhookPath (rawPath : String) : Option Json :=
  match rawPath.splitOn "/" with
  | ["", "v1", "webhooks", account, "dev", endpoint, channel] =>
    if account.isEmpty || endpoint.isEmpty || channel.isEmpty then none
    else
      match decodePathSegments [account, endpoint, channel] with
      | some [a, e, c] =>
        some (Json.mkObj
          [("accountId", toJson a), ("channelName", toJson c), ("endpointId", toJson e)])
      | _ => none
  | ["", "v1", "webhooks", account, channel] =>
    if account.isEmpty || channel.isEmpty then none
    else
      match decodePathSegments [account, channel] with
      | some [a, c] => some (Json.mkObj [("accountId", toJson a), ("channelName", toJson c)])
      | _ => none
  | _ => none

/-- `parsePublicEndpointPath`. A malformed escape throws `decodeURIComponent`'s message. -/
def parsePublicEndpointPath (rawPath : String) : Except String Json :=
  let decode := fun (segment : String) =>
    match decodeComponent? segment with
    | some text => Except.ok text
    | none => Except.error "URI error"
  match rawPath.splitOn "/" with
  | ["", "v1", "projects", project, "stages", stage, "agents", endpoint] =>
    if project.isEmpty || stage.isEmpty || endpoint.isEmpty then .ok .null
    else do
      let p ← decode project
      let s ← decode stage
      let e ← decode endpoint
      .ok (Json.mkObj [("projectSlug", toJson p), ("stageSlug", toJson s), ("endpointId", toJson e)])
  | ["", "v1", "agents", endpoint] =>
    if endpoint.isEmpty then .ok .null
    else do
      let e ← decode endpoint
      .ok (Json.mkObj [("endpointId", toJson e)])
  | _ => .ok .null

/-- `isRunId`: `run_` and 32 lowercase hex digits. -/
def isRunId (value : String) : Bool :=
  match stripPrefix? value "run_" with
  | some hex =>
    hex.length == 32 && hex.toList.all fun c => ('0' ≤ c && c ≤ '9') || ('a' ≤ c && c ≤ 'f')
  | none => false

/-- `deploymentScopeMatches`: `===` on each field, where two absent fields are equal. -/
def deploymentScopeMatches (auth deployment : Json) : Bool :=
  field? deployment "accountId" == field? (field auth "account") "accountId" &&
    field? deployment "endpointId" == field? auth "endpointId" &&
    field? deployment "projectSlug" == field? auth "projectSlug" &&
    field? deployment "stageSlug" == field? auth "stageSlug"

/-- The first issue of a `providerMetadataSchema` value, as zod words it. -/
def providerOptionsIssue (value : Json) : Option String :=
  let notRecord := fun (item : Json) => s!"Invalid input: expected record, received {zodType item}"
  match value with
  | .obj _ =>
    (entries value).findSome? fun entry =>
      match entry.2 with
      | .obj _ => none
      | other => some (notRecord other)
  | other => some (notRecord other)

private def withProviderOptions (out message : Json) : Json :=
  match field? message "providerOptions" with
  | some options => setField out "providerOptions" options
  | none => out

private def expectedObject (value : Json) : String :=
  s!"Invalid input: expected object, received {zodType value}"

/-- `systemModelMessageSchema.safeParse`: the stripped message, or the first issue's message. -/
def systemMessage (value : Json) : Except String Json :=
  match value with
  | .obj _ =>
    if field value "role" != .str "system" then .error "Invalid input: expected \"system\""
    else
      match field? value "content" with
      | some (.str content) =>
        match (field? value "providerOptions").bind providerOptionsIssue with
        | some issue => .error issue
        | none =>
          .ok (withProviderOptions
            (Json.mkObj [("role", toJson "system"), ("content", toJson content)]) value)
      | some other => .error s!"Invalid input: expected string, received {zodType other}"
      | none => .error "Invalid input: expected string, received undefined"
  | other => .error (expectedObject other)

/-- What the union of user content parts does with one part. Image and file parts carry binary
data schemas this model leaves out, so they are `none`. -/
private def userPart (part : Json) : Option (Except String Json) :=
  match field part "type" with
  | .str "image" | .str "file" => none
  | .str "text" =>
    match field? part "text" with
    | some (.str text) =>
      match (field? part "providerOptions").bind providerOptionsIssue with
      | some _ => some (.error "Invalid input")
      | none =>
        some (.ok (withProviderOptions
          (Json.mkObj [("type", toJson "text"), ("text", toJson text)]) part))
    | _ => some (.error "Invalid input")
  | _ => some (.error "Invalid input")

/-- `userModelMessageSchema.safeParse`. `none` where a part is outside the model. -/
def userMessage (value : Json) : Option (Except String Json) :=
  let finish := fun (content : Json) =>
    match (field? value "providerOptions").bind providerOptionsIssue with
    | some issue => Except.error issue
    | none =>
      Except.ok (withProviderOptions
        (Json.mkObj [("role", toJson "user"), ("content", content)]) value)
  match field value "content" with
  | .str text => some (finish (.str text))
  | .arr parts =>
    let results := parts.toList.map userPart
    if results.any Option.isNone then none
    else
      let done := results.filterMap id
      if done.any (fun result => match result with | .error _ => true | .ok _ => false) then
        some (.error "Invalid input")
      else
        some (finish (jarr (done.filterMap fun result =>
          match result with
          | .ok item => some item
          | .error _ => none)))
  | _ => some (.error "Invalid input")

/-- What the union of tool content parts does with one part. Only the text form of a tool result's
`output` is modelled, since refusing a result does not need the others' shapes. -/
private def toolPart (part : Json) : Option (Except String Json) :=
  match field part "type" with
  | .str "tool-approval-response" =>
    match field? part "approvalId", field? part "approved", field? part "reason" with
    | some (.str approvalId), some (.bool approved), reason =>
      let reasonOk := match reason with
        | some (.str _) | none => true
        | _ => false
      if reasonOk then
        some (.ok (Json.mkObj
          ([("type", toJson "tool-approval-response"), ("approvalId", toJson approvalId),
              ("approved", toJson approved)] ++ optEntry "reason" reason)))
      else some (.error "Invalid input")
    | _, _, _ => some (.error "Invalid input")
  | .str "tool-result" =>
    match field? part "toolCallId", field? part "toolName", field? part "output" with
    | some (.str _), some (.str _), some output =>
      if field output "type" == .str "text" && (str? (field output "value")).isSome then
        some (.ok part)
      else none
    | _, _, _ => none
  | _ => some (.error "Invalid input")

/-- The `parseDirectIngressEvent` branches for a tool event. -/
private def toolEvent (value : Json) : Json :=
  match field? value "content" with
  | some (.arr parts) =>
    let results := parts.toList.map toolPart
    if results.any Option.isNone then Spec.Twin.unsupported "a tool result outside the model"
    else
      let done := results.filterMap id
      if done.any (fun result => match result with | .error _ => true | .ok _ => false) then
        Spec.Twin.threw "Invalid direct event: Invalid input"
      else
        match (field? value "providerOptions").bind providerOptionsIssue with
        | some issue => Spec.Twin.threw s!"Invalid direct event: {issue}"
        | none =>
          let items := done.filterMap fun result =>
            match result with
            | .ok item => some item
            | .error _ => none
          if items.isEmpty ||
              !items.all (fun item => field item "type" == .str "tool-approval-response") then
            Spec.Twin.threw "Direct API tool events may include only tool-approval-response parts"
          else
            withProviderOptions (Json.mkObj [("role", toJson "tool"), ("content", jarr items)]) value
  | some other =>
    Spec.Twin.threw s!"Invalid direct event: Invalid input: expected array, received {zodType other}"
  | none => Spec.Twin.threw "Invalid direct event: Invalid input: expected array, received undefined"

private def isOutcomeFailure (output : Json) : Bool :=
  (field? output "threw").isSome || (field? output "unsupported").isSome

/-- `parseDirectIngressEvent`: the event as stored, or the twin output for a throw. -/
def parseDirectIngressEvent (raw : Json) : Json :=
  match raw with
  | .obj _ | .arr _ =>
    let persist := field? raw "persist"
    let role := field raw "role"
    let badPersist := match persist with
      | some (.bool _) | none => false
      | _ => true
    if badPersist then Spec.Twin.threw "Event field 'persist' must be a boolean when provided"
    else if persist.isSome && role != .str "system" then
      Spec.Twin.threw "Only system-role events may set persist"
    else if role == .str "user" then
      match userMessage raw with
      | none => Spec.Twin.unsupported "an image or file part"
      | some (.error issue) => Spec.Twin.threw s!"Invalid direct event: {issue}"
      | some (.ok message) => message
    else if role == .str "tool" then toolEvent raw
    else if role != .str "system" then
      Spec.Twin.threw "Direct API accepts only user, tool approval, and ephemeral system events"
    else if persist == some (.bool true) then
      Spec.Twin.threw "Direct API system events cannot be persisted"
    else
      match systemMessage raw with
      | .error issue => Spec.Twin.threw s!"Invalid direct event: {issue}"
      | .ok message => setField message "persist" (toJson false)
  | _ => Spec.Twin.threw "Each direct event must be an object"

/-- The first failure among mapped outcomes, or all the values. -/
private def collect (outcomes : List Json) : Json :=
  match outcomes.find? isOutcomeFailure with
  | some failure => failure
  | none => jarr outcomes

/-- `parseSystemOverride`. -/
def parseSystemOverride (raw : Json) : Json :=
  let values := match raw with
    | .arr items => items.toList
    | other => [other]
  if values.isEmpty then Spec.Twin.threw "system must include at least one SystemModelMessage"
  else
    collect <| values.map fun value =>
      match systemMessage value with
      | .ok message => message
      | .error issue =>
        Spec.Twin.threw
          s!"system must be a SystemModelMessage or array of SystemModelMessage: {issue}"

private def reservedModelKeys : List String :=
  ["provider", "modelId", "output", "apiKey"]

/-- `parseRunOverrides`. Two reserved keys depend on an order this JSON does not keep. -/
def parseRunOverrides (record : Json) : Json :=
  if (field? record "params").isSome then
    Spec.Twin.threw "Request body params is not supported; use top-level system and model"
  else
    let system := (field? record "system").map parseSystemOverride
    match system with
    | some failure@(.obj _) => failure
    | _ =>
      let withSystem := optEntry "system" system
      match field? record "model" with
      | none => if withSystem.isEmpty then .null else Json.mkObj withSystem
      | some model@(.obj _) =>
        match (keys model).filter reservedModelKeys.contains with
        | [key] => Spec.Twin.threw s!"model.{key} cannot be overridden per run"
        | _ :: _ :: _ => Spec.Twin.unsupported "several reserved keys, in an unknown order"
        | [] =>
          match checkModel "model" model with
          | .threw message => Spec.Twin.threw message
          | .outside reason => Spec.Twin.unsupported reason
          | .ok =>
            let entries' := withSystem ++ (if (keys model).isEmpty then [] else [("model", model)])
            if entries'.isEmpty then .null else Json.mkObj entries'
      | some _ => Spec.Twin.threw "model must be an object"

/-- `rewriteUserContentText`. `none` when `content` is neither text nor parts. -/
def rewriteUserContentText (content : Json) (text : String) : Option Json :=
  match content with
  | .str _ => some (.str text)
  | .arr parts =>
    let attachments := parts.toList.filter fun part => field part "type" != .str "text"
    if attachments.isEmpty then some (.str text)
    else
      some (jarr (Json.mkObj [("type", toJson "text"), ("text", toJson text)] :: attachments))
  | _ => none

private def replaceLatestUser (events : List Json) (change : Json → Option Json) : Option (List Json) :=
  let reversed := events.reverse
  match reversed.span (fun event => field event "role" != .str "user") with
  | (_, []) => some events
  | (after, event :: before) =>
    (change event).map fun next => before.reverse ++ next :: after.reverse

/-- One channel's fields a factory requires, by `config.channels` key. -/
structure AdapterGuard where
  name : String
  required : List String

/-- The factories' required fields, in `createChannelRegistry` order. Teams and Google Chat have
further conditions, in `adapterBuilt`. -/
def adapterGuards : List AdapterGuard :=
  [ { name := "telegram", required := ["botToken", "webhookSecret"] },
    { name := "gchat", required := ["credentials"] },
    { name := "github", required := ["webhookSecret", "appId", "privateKey"] },
    { name := "linear", required := ["apiKey", "webhookSecret", "userName"] },
    { name := "slack", required := ["botToken", "signingSecret"] },
    { name := "discord", required := ["botToken", "publicKey"] },
    { name := "pancake", required := ["pageId", "pageAccessToken", "webhookSecret"] },
    { name := "teams", required := ["appId", "appPassword"] },
    { name := "twilio", required := ["accountSid", "authToken"] },
    { name := "zalo", required := ["botToken", "webhookSecret"] },
    { name := "instagram", required := ["accessToken", "accountId", "appSecret", "verifyToken"] },
    { name := "messenger", required := ["appSecret", "pageAccessToken", "verifyToken"] },
    { name := "whatsapp", required := ["accessToken", "appSecret", "phoneNumberId", "verifyToken"] } ]

/-- `parseServiceAccountKey` accepts: JSON naming a non-empty `client_email` and `private_key`. -/
def serviceAccountKeyOk (credentials : Json) : Bool :=
  let nonEmpty := fun (value : Json) =>
    match value with
    | .str text => !text.isEmpty
    | _ => false
  match credentials with
  | .str text =>
    match Json.parse text with
    | .ok key@(.obj _) => nonEmpty (field key "client_email") && nonEmpty (field key "private_key")
    | _ => false
  | _ => false

/-- Whether the factory for this channel builds an adapter from the config. -/
def adapterBuilt (config : Json) (guard : AdapterGuard) : Bool :=
  let channel := field (field config "channels") guard.name
  guard.required.all (fieldTruthy channel) &&
    (guard.name != "teams" ||
      field channel "appType" == .str "MultiTenant" || fieldTruthy channel "appTenantId") &&
    (guard.name != "gchat" ||
      ((fieldTruthy channel "endpointUrl" || fieldTruthy channel "googleChatProjectNumber") &&
        serviceAccountKeyOk (field channel "credentials")))

private def factoryTwin (function name : String) : Spec.Twin where
  source := source ++ "#" ++ function
  run := fun args =>
    match adapterGuards.find? (·.name == name) with
    | some guard =>
      if adapterBuilt (Spec.Twin.arg args 0) guard then
        Spec.Twin.unsupported "the factory built an adapter, which holds functions"
      else .null
    | none => Spec.Twin.unsupported "no such channel"

private def factoryTwins : List Spec.Twin :=
  [ factoryTwin "createTelegramChannelFromConfig" "telegram",
    factoryTwin "createGoogleChatChannelFromConfig" "gchat",
    factoryTwin "createGitHubChannelFromConfig" "github",
    factoryTwin "createLinearChannelFromConfig" "linear",
    factoryTwin "createSlackChannelFromConfig" "slack",
    factoryTwin "createDiscordChannelFromConfig" "discord",
    factoryTwin "createPancakeChannelFromConfig" "pancake",
    factoryTwin "createTeamsChannelFromConfig" "teams",
    factoryTwin "createTwilioChannelFromConfig" "twilio",
    factoryTwin "createZaloChannelFromConfig" "zalo",
    factoryTwin "createInstagramChannelFromConfig" "instagram",
    factoryTwin "createMessengerChannelFromConfig" "messenger",
    factoryTwin "createWhatsAppChannelFromConfig" "whatsapp" ]

/-- The registry's channels when nothing is built, since a built adapter has no JSON form. -/
private def registryOutcome (config : Json) (empty : Json) : Json :=
  if adapterGuards.any (adapterBuilt config) then
    Spec.Twin.unsupported "the registry built an adapter, which holds functions"
  else empty

private def pathTwins : List Spec.Twin :=
  [ { source := source ++ "#socketScopePath"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .str "/v1/internal/observability-scope" => toJson "observability"
        | .str "/v1/internal/agent-socket-scope" => toJson "agent"
        | _ => .null },
    { source := source ++ "#decodePathSegments"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .arr segments =>
          match segments.toList.mapM str? with
          | some items =>
            match decodePathSegments items with
            | some decoded => jstrs decoded
            | none => .null
          | none => Spec.Twin.unsupported "a segment is not a string"
        | _ => Spec.Twin.unsupported "segments is not an array" },
    { source := source ++ "#matchWebhookPath"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .str path => (matchWebhookPath path).getD .null
        | _ => Spec.Twin.unsupported "path is not a string" },
    { source := source ++ "#parsePublicEndpointPath"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .str path => fromExcept (parsePublicEndpointPath path)
        | _ => Spec.Twin.unsupported "path is not a string" },
    { source := source ++ "#parseStatusPath"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .str path =>
          let raw : Except String String :=
            match path.splitOn "/" with
            | ["", "v1", "runs", segment] =>
              if segment.isEmpty then .ok ""
              else
                match decodeComponent? segment with
                | some text => .ok text
                | none => .error "URI error"
            | _ => .ok ""
          match raw with
          | .error message => Spec.Twin.threw message
          | .ok runId =>
            if !isRunId runId then Spec.Twin.threw "Run id is not one this API issued"
            else
              Json.mkObj
                [("accountId", field (Spec.Twin.arg args 1) "accountId"), ("runId", toJson runId)]
        | _ => Spec.Twin.unsupported "path is not a string" } ]

private def authTwins : List Spec.Twin :=
  [ { source := source ++ "#deploymentMatchesPath"
      run := fun args =>
        let auth := Spec.Twin.arg args 0
        let endpoint := Spec.Twin.arg args 1
        let sameOptional := fun (key : String) =>
          match field? endpoint key with
          | none => true
          | some value => field? auth key == some value
        toJson (field? auth "endpointId" == field? endpoint "endpointId" &&
          sameOptional "projectSlug" && sameOptional "stageSlug") },
    { source := source ++ "#publicDeploymentIngress"
      run := fun args =>
        let auth := Spec.Twin.arg args 0
        Json.mkObj
          (optEntry "accountId" (field? (field auth "account") "accountId") ++
            optEntry "endpointId" (field? auth "endpointId") ++
            optEntry "stageSlug" (field? auth "stageSlug") ++
            optEntry "projectSlug" (field? auth "projectSlug")) },
    { source := source ++ "#admitStageCredential"
      run := fun args =>
        let auth := Spec.Twin.arg args 0
        let agent := Spec.Twin.arg args 1
        if !truthy auth then toJson false
        else if !deploymentScopeMatches auth (Spec.Twin.arg args 2) then
          Spec.Twin.threw "Agent not found"
        else if fieldTruthy auth "stageTicket" then toJson false
        else if field (field agent "config") "publicAccess" != .bool true then
          let agentId := (str? (field agent "agentId")).getD "undefined"
          Spec.Twin.threw (s!"Agent {agentId} is not publicly accessible. Enable public access and " ++
            "redeploy, or reach it through an internal endpoint or channel webhook.")
        else toJson true },
    { source := source ++ "#assertRunOverridesAllowed"
      run := fun args =>
        let agent := Spec.Twin.arg args 1
        let overrides := Spec.Twin.arg args 2
        let events := (arr? (Spec.Twin.arg args 3)).getD []
        let systemEvent := events.any fun event => field event "role" == .str "system"
        if truthy (Spec.Twin.arg args 0) &&
            field (field agent "config") "allowRunOverrides" != .bool true &&
            (overrides != .null || systemEvent) then
          let agentId := (str? (field agent "agentId")).getD "undefined"
          Spec.Twin.threw (s!"Agent {agentId} does not accept system messages or model overrides " ++
            "from a runtime key. Set allowRunOverrides: true and redeploy to allow them.")
        else .null },
    { source := source ++ "#userTokenRequiredMessage"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .str agentId =>
          toJson (s!"Agent {agentId} requires a signed user token with the runtime key. Send it in " ++
            "the X-Broods-User-Token header (signUserToken in the broods SDK), or turn the " ++
            "requirement off for this agent.")
        | _ => Spec.Twin.unsupported "agent id is not a string" },
    { source := source ++ "#channelAgentListKey"
      run := fun args =>
        match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
        | .str accountId, .str endpointId =>
          if endpointId.isEmpty then toJson accountId
          else toJson (accountId ++ String.singleton (Char.ofNat 0) ++ endpointId)
        | .str accountId, .null => toJson accountId
        | _, _ => Spec.Twin.unsupported "ids are not strings" },
    { source := source ++ "#userScopedEventId"
      run := fun args =>
        match field (Spec.Twin.arg args 0) "userId", Spec.Twin.arg args 1 with
        | .str userId, .str requested =>
          let pre := userConversationPrefix userId
          fromExcept do
            let bare ← normalizeDirectIdentifier "eventId" requested
            let checked ← validPublicEventId ((stripPrefix? bare pre).getD bare)
            .ok (toJson (pre ++ checked))
        | _, _ => Spec.Twin.unsupported "user id or event id is not a string" },
    { source := source ++ "#directConversationKeys"
      run := fun args =>
        match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2, Spec.Twin.arg args 3 with
        | .str requested, .bool continuation, .str accountId, .str agentId =>
          fromExcept (directConversationKeys requested continuation accountId agentId
            (Spec.Twin.arg args 4))
        | _, _, _, _ => Spec.Twin.unsupported "arguments of the wrong type" } ]

private def assertShapeTwin : Spec.Twin where
  source := source ++ "#assertOneDirectPayloadShape"
  run := fun args =>
    let body := Spec.Twin.arg args 1
    let count := fun (key : String) =>
      match field body key with
      | .num n => n.mantissa != 0
      | _ => false
    let continuation := truthy (Spec.Twin.arg args 0)
    let events := count "eventCount"
    let answers := count "answerCount"
    if continuation && (events || answers) then
      Spec.Twin.threw "Request body cannot combine continue with events or answers"
    else if continuation && fieldTruthy body "hasOverrides" then
      Spec.Twin.threw "Request body cannot combine continue with system or model overrides"
    else if !continuation && !events && !answers then
      Spec.Twin.threw "Request body must include a non-empty events or answers array"
    else if events && answers then
      Spec.Twin.threw "Request body cannot combine events with answers; send the answers first"
    else .null

private def answerOutcome (value : Json) : Json :=
  let refused := Spec.Twin.threw "Each answer must be an object with statusId and answers"
  match value, field value "statusId", field value "answers" with
  | .obj _, .str statusId, answers@(.obj _) =>
    let invalid := (entries answers).filter fun entry =>
      match entry.2 with
      | .arr labels => !labels.toList.all fun label => (str? label).isSome
      | _ => true
    match invalid with
    | [] => Json.mkObj [("statusId", toJson statusId), ("answers", answers)]
    | [(questionId, _)] =>
      Spec.Twin.threw s!"Answer for question '{questionId}' must be an array of strings"
    | _ => Spec.Twin.unsupported "several invalid answers, in an unknown order"
  | _, _, _ => refused

private def payloadTwins : List Spec.Twin :=
  [ assertShapeTwin,
    { source := source ++ "#parseBooleanField"
      run := fun args =>
        match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
        | .null, _ => toJson false
        | .bool value, _ => toJson value
        | _, .str name => Spec.Twin.threw s!"Request body field '{name}' must be a boolean"
        | _, _ => Spec.Twin.unsupported "name is not a string" },
    { source := source ++ "#parseIngressMode"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .null => .null
        | mode@(.str "reject") | mode@(.str "followup") | mode@(.str "collect")
        | mode@(.str "steer") => mode
        | _ => Spec.Twin.threw "mode must be reject, followup, collect, or steer" },
    { source := source ++ "#parseDirectQuestionAnswers"
      run := fun args =>
        match Spec.Twin.arg args 0 with
        | .null => jarr []
        | .arr items => collect (items.toList.map answerOutcome)
        | _ => Spec.Twin.threw "Request body field 'answers' must be an array" },
    { source := source ++ "#parseSandboxJobCompletionPayload"
      run := fun args =>
        match Spec.Twin.arg args 0, Spec.Twin.arg args 2 with
        | .str rawResultId, .str bodyText =>
          let token := jsTrim ((str? (field (Spec.Twin.arg args 1) "x-job-token")).getD "")
          if token.isEmpty then
            Spec.Twin.threw "Background job completion requires the x-job-token header"
          else
            match Json.parse bodyText with
            | .error _ =>
              -- JavaScriptCore names a leading bare word; its other parse errors are not modelled.
              match (jsTrim bodyText).toList with
              | first :: rest =>
                if first.isAlpha || first == '_' || first == '$' then
                  let word := String.ofList (first :: rest.takeWhile fun c => c.isAlphanum || c == '_' || c == '$')
                  if ["true", "false", "null"].contains word then
                    Spec.Twin.unsupported "the engine words the JSON parse error"
                  else Spec.Twin.threw s!"Invalid request JSON: JSON Parse error: Unexpected identifier \"{word}\""
                else Spec.Twin.unsupported "the engine words the JSON parse error"
              | [] => Spec.Twin.unsupported "the engine words the JSON parse error"
            | .ok record@(.obj _) =>
              match field record "status" with
              | status@(.str "completed") | status@(.str "failed") =>
                match decodeComponent? rawResultId with
                | none => Spec.Twin.threw "URI error"
                | some resultId =>
                  let errorEntry := match field record "error" with
                    | error@(.str _) => [("error", error)]
                    | _ => []
                  Json.mkObj
                    ([("resultId", toJson resultId), ("token", toJson token), ("status", status)] ++
                      optEntry "response" (field? record "response") ++ errorEntry)
              | _ => Spec.Twin.threw "Background job completion status must be completed or failed"
            | .ok _ => Spec.Twin.threw "Background job completion body must be an object"
        | _, _ => Spec.Twin.unsupported "result id or body is not a string" },
    { source := source ++ "#parseSystemOverride"
      run := fun args => parseSystemOverride (Spec.Twin.arg args 0) },
    { source := source ++ "#parseRunOverrides"
      run := fun args => parseRunOverrides (Spec.Twin.arg args 0) },
    { source := source ++ "#parseDirectIngressEvent"
      run := fun args => parseDirectIngressEvent (Spec.Twin.arg args 0) },
    { source := source ++ "#parseDirectIngressEvents"
      run := fun args =>
        match field (Spec.Twin.arg args 0) "events" with
        | .null => jarr []
        | .arr items => collect (items.toList.map parseDirectIngressEvent)
        | _ => Spec.Twin.threw "Request body field 'events' must be an array" } ]

private def ingressTwins : List Spec.Twin :=
  [ { source := source ++ "#rewriteUserContentText"
      run := fun args =>
        match Spec.Twin.arg args 1 with
        | .str text =>
          (rewriteUserContentText (Spec.Twin.arg args 0) text).getD
            (Spec.Twin.unsupported "content is neither text nor parts")
        | _ => Spec.Twin.unsupported "text is not a string" },
    { source := source ++ "#rewriteLatestUserIngressText"
      run := fun args =>
        match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
        | .arr events, .str text =>
          let next := replaceLatestUser events.toList fun event =>
            (rewriteUserContentText (field event "content") text).map (setField event "content")
          match next with
          | some items => jarr items
          | none => Spec.Twin.unsupported "content is neither text nor parts"
        | _, _ => Spec.Twin.unsupported "events or text of the wrong type" },
    { source := source ++ "#attachMetadataToLatestUserIngress"
      run := fun args =>
        match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
        | .arr _, .null => Spec.Twin.unsupported "null and undefined metadata look the same here"
        | .arr events, metadata =>
          match replaceLatestUser events.toList (fun event => some (setField event "metadata" metadata)) with
          | some items => jarr items
          | none => .null
        | _, _ => Spec.Twin.unsupported "events is not an array" },
    { source := source ++ "#resolveCommandToken"
      run := fun args =>
        let optionalToken := fun (token : Option String) =>
          match token with
          | some value => Json.str value
          | none => Json.null
        match field (Spec.Twin.arg args 1) "commandToken" with
        | .str token => optionalToken (parseCommand token)
        | _ =>
          match Spec.Twin.arg args 2 with
          | .str channelName =>
            if !inlineCommandChannels.contains channelName then .null
            else
              match extractText? (Spec.Twin.arg args 0) with
              | some text => optionalToken (parseCommand text)
              | none => Spec.Twin.unsupported "content is neither text nor parts"
          | _ => Spec.Twin.unsupported "channel name is not a string" },
    { source := source ++ "#identityWithChannelRoles"
      run := fun args =>
        let identity := Spec.Twin.arg args 0
        let record := Spec.Twin.arg args 1
        if !truthy identity || !truthy record then identity
        else
          match channelActorRoles record (field identity "userId") with
          | [] => identity
          | roles => setField identity "userRoles" (jarr roles) },
    { source := source ++ "#channelAdapterFromConfig"
      run := fun args => registryOutcome (Spec.Twin.arg args 0) .null },
    { source := source ++ "#channelActionsFromConfig"
      run := fun args => registryOutcome (Spec.Twin.arg args 0) .null } ]

/-- The twins in this file. -/
def integrationTwins : List Spec.Twin :=
  factoryTwins ++ pathTwins ++ authTwins ++ payloadTwins ++ ingressTwins

end Spec.Channels
