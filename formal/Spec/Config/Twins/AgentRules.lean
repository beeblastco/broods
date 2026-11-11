import Spec.Twin
import Spec.Config.Model
import Spec.Config.Twins.Zod

/-!
Twins of `packages/convex/model/agentRules.ts`: the `AGENT_CONFIG` schema as `Spec.Zod` data, and the rules
that run after it.
-/

namespace Spec.Config

open Lean Spec.Js Spec.Zod

/-- `ACCOUNT_MODEL_PROVIDER_NAMES`. -/
def providerNames : List String :=
  ["alibaba", "anthropic", "azure", "baseten", "bedrock", "cerebras", "chatgpt", "cloudflare", "cohere",
   "custom", "deepinfra", "deepseek", "fireworks", "google", "groq", "huggingface", "llmgateway", "minimax",
   "mistral", "moonshotai", "ollama", "openai", "openrouter", "perplexity", "togetherai", "v0", "vercel",
   "vertex", "xai", "zai"]

/-- `AGENT_LIFECYCLE_EVENT_NAMES`. -/
def lifecycleEvents : List String :=
  ["agent.started", "agent.step.finished", "agent.finished", "agent.failed", "agent.approval.required",
   "tool.call.started", "tool.call.finished", "tool.result", "subagent.task.started",
   "subagent.task.finished"]

/-- `AGENT_HOOK_EVENT_NAMES`. -/
def hookEvents : List String :=
  lifecycleEvents ++ ["channel.message.received", "channel.message.sending"]

/-- `MODEL_CONFIG_SETTING_KEYS`. -/
def modelSettingKeys : List String :=
  ["provider", "modelId", "providerOptions", "output", "maxOutputTokens",
   "temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "stopSequences", "seed",
   "reasoning", "maxRetries", "timeout"]

/-- `MODEL_TIMEOUT_KEYS`. -/
def modelTimeoutKeys : List String :=
  ["totalMs", "stepMs", "firstChunkMs", "chunkMs", "toolMs", "tools"]

/-- `isNativeConvexDocumentId`. -/
def isConvexId (value : String) : Bool :=
  value.length ≥ 20 && value.toList.all fun c => ('a' ≤ c && c ≤ 'z') || isAsciiDigit c

/-- `/^[A-Za-z0-9._-]+$/`. -/
def isDotted (value : String) : Bool :=
  allChars (fun c => isAsciiAlnum c || c == '.' || c == '_' || c == '-') value

/-- `/^\d+$/`. -/
def isDigits (value : String) : Bool :=
  allChars isAsciiDigit value

/-- `/^v\d+\.\d+$/`. -/
def isGraphVersion (value : String) : Bool :=
  match value.toList with
  | 'v' :: rest =>
    match String.ofList rest |>.splitOn "." with
    | [major, minor] => isDigits major && isDigits minor
    | _ => false
  | _ => false

/-- `/^MG[0-9a-fA-F]{32}$/`. -/
def isMessagingSid (value : String) : Bool :=
  match value.toList with
  | 'M' :: 'G' :: rest => rest.length == 32 && rest.all isHexDigit
  | _ => false

/-- `/^\+[1-9]\d{1,14}$/`. -/
def isE164 (value : String) : Bool :=
  match value.toList with
  | '+' :: first :: rest =>
    '1' ≤ first && first ≤ '9' && 1 ≤ rest.length && rest.length ≤ 14 && rest.all isAsciiDigit
  | _ => false

/-- `/^.+Ms$/`: at least one character before `Ms`, none a line terminator. -/
def isToolMsKey (value : String) : Bool :=
  let chars := value.toList
  value.endsWith "Ms" && chars.length ≥ 3 &&
    (chars.take (chars.length - 2)).all fun c =>
      c != '\n' && c != '\r' && c.toNat != 0x2028 && c.toNat != 0x2029

/-- The URL parse behind `publicHttpsUrlProblem`, for callers that need the verdict. -/
def urlProblem (value : String) : Except String (Option String) :=
  match Spec.Url.parse value with
  | .invalid => .ok (publicHttpsProblem none)
  | .ok url => .ok (publicHttpsProblem (some (url.protocol, url.hostname)))
  | .unknown reason => .error reason

/-- A `publicHttpsUrlProblem` check, as a parse result. -/
def urlCheck (path : List Seg) (value : String) (next : Unit → Parsed) : Parsed :=
  match urlProblem value with
  | .error reason => .unknown reason
  | .ok (some problem) => fail path problem
  | .ok none => next ()

/-- `providerBaseURL`, on validated settings. -/
def providerBaseUrl (settings : Json) : Option String :=
  let raw := match field? settings "base_url" with
    | some (.str s) => some s
    | _ => (field? settings "baseURL").bind str?
  raw.bind fun s =>
    let trimmed := trim s
    if trimmed.isEmpty then none else some trimmed

def publicHttpsUrl : Schema :=
  .check (.string none) fun value =>
    match value with
    | .str s => urlCheck [] s fun _ => .ok (some value)
    | _ => .ok (some value)

def optionalString : Schema := .optional (.string none)
def optionalBoolean : Schema := .optional .bool

def timerMs : Schema := Spec.Zod.positiveInteger 2147483647

/-- `eventList(events)`. -/
def eventList (events : List String) : Schema :=
  .whole (.array (.enum events none)) s!"must be an array of: {", ".intercalate events}"

def workspaceName : Schema :=
  .check nonEmptyString fun value =>
    match value with
    | .str s =>
      if isDotted s then .ok (some value)
      else fail [] "must use only letters, numbers, dots, underscores, or hyphens"
    | _ => .ok (some value)

def systemMessage : Schema :=
  .object false
    [("role", .enum ["system"] none), ("content", .string none),
     ("providerOptions", .optional (.record (.string none) (.record (.string none) .unknown none) none))]
    none

def agentBehavior : Schema :=
  let turnsError := "must be a non-negative integer (0 lifts the cap)"
  .object false
    [("maxTurn", .optional (.check (.number (some turnsError)) fun value =>
        match safeInt? value with
        | some n => if 0 ≤ n then .ok (some value) else fail [] turnsError
        | none => fail [] turnsError)),
     ("system", .optional (.whole (.union [.string none, systemMessage, .array systemMessage] none)
        "must be a string, SystemModelMessage, or SystemModelMessage[]: invalid system message"))]
    none

def harnessSchema : Schema :=
  .check
    (.object true
      [("type", .enum ["claude-code", "codex", "deepagents", "opencode", "pi"] none),
       ("permissionMode", .optional (.enum ["allow-reads", "allow-edits", "allow-all"] none)),
       ("startupTimeoutMs", .optional (Spec.Zod.positiveInteger 600000)),
       ("webSearch", optionalBoolean),
       ("activeTools", .optional nonEmptyStrings),
       ("inactiveTools", .optional nonEmptyStrings),
       ("debug", .optional (.object true
          [("enabled", optionalBoolean),
           ("level", .optional (.enum ["error", "warn", "info", "debug", "trace"] none)),
           ("subsystems", .optional nonEmptyStrings)] none))]
      none)
    fun harness =>
      let kind := (field? harness "type").bind str?
      let mode := field? harness "permissionMode"
      if has harness "activeTools" && has harness "inactiveTools" then
        fail [] "must use either activeTools or inactiveTools, not both"
      else if kind == some "codex" && mode.isSome && mode != some (.str "allow-all") then
        fail [.key "permissionMode"] "must be allow-all for the codex harness"
      else if kind != some "codex" && has harness "webSearch" then
        fail [.key "webSearch"] "is only supported by the codex harness"
      else if kind == some "pi" && has harness "startupTimeoutMs" then
        fail [.key "startupTimeoutMs"] "is not supported by the pi harness"
      else .ok (some harness)

/-- `Object.keys(value)` outside `known` must be empty, the first reported with `message`. -/
def noOtherKeys (known : List String) (message : String) (value : Json) : Parsed :=
  match (Spec.Js.entries value).map Prod.fst |>.filter (fun key => !known.contains key) with
  | [] => .ok (some value)
  | [key] => fail [.key key] message
  | _ => .unknown "two unsupported keys: the first is not visible"

def modelTimeout : Schema :=
  let keys := ", ".intercalate modelTimeoutKeys
  .union
    [timerMs,
     .check
      (.object false
        [("totalMs", .optional timerMs), ("stepMs", .optional timerMs),
         ("firstChunkMs", .optional timerMs), ("chunkMs", .optional timerMs),
         ("toolMs", .optional timerMs),
         ("tools", .optional (.record
            (patternString isToolMsKey "must be named {toolName}Ms, like bashMs")
            (.optional timerMs)
            (some "must be an object of {toolName}Ms limits")))]
        none)
      (noOtherKeys modelTimeoutKeys s!"is not supported; use one of: {keys}")]
    (some s!"must be a number of milliseconds or an object with {keys}")

def modelOutput : Schema :=
  let named (extra : List (String × Schema)) : Schema :=
    .object false ([("name", optionalString), ("description", optionalString)] ++ extra) none
  .discriminated "type"
    [("text", named []),
     ("object", named [("schema", .record (.string none) .unknown none)]),
     ("array", named [("element", .record (.string none) .unknown none)]),
     ("choice", named [("options", .whole
        (.check (.array (.string none)) fun value =>
          match value with
          | .arr items => if items.isEmpty then fail [] "too small" else .ok (some value)
          | _ => .ok (some value))
        "must be a non-empty array of strings")]),
     ("json", named [])]
    "must be one of: text, object, array, choice, json"

def modelSchema : Schema :=
  .check
    (.object false
      [("provider", .optional (.enum providerNames none)),
       ("modelId", optionalString),
       ("reasoning", .optional (.enum
          ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"] none)),
       ("providerOptions", .optional (.record (.string none) .unknown none)),
       ("timeout", .optional modelTimeout),
       ("output", .optional modelOutput)]
      none)
    (fun model =>
      if has model "transcriptionModelId" then
        fail [.key "transcriptionModelId"] "was renamed to config.transcription.modelId"
      else
        noOtherKeys modelSettingKeys
          "is not supported; use {parent}.providerOptions for provider-specific settings" model)

/-- `TRANSCRIPTION`. -/
def transcriptionSchema : Schema :=
  .object true
    [("provider", .optional (.enum providerNames none)), ("modelId", optionalString)]
    none

def gatewayIdError : String := "must be an AI Gateway id (letters, digits, - and _)"

/-- The keys `PROVIDER_SETTINGS` declares, first in the parsed object's key order. -/
def declaredSettings : List String := ["apiKey", "gatewayId", "base_url", "baseURL", "headers"]

/-- The settings' keys, in the parsed object's order. -/
def endpointKeys (settings : Json) : List String :=
  let others := (Spec.Js.entries settings).map Prod.fst |>.filter
    (fun key => !declaredSettings.contains key)
  (declaredSettings ++ others).filter (has settings)

/-- `PROVIDER_ENDPOINT_SETTING`: `/url$/i`. -/
def isEndpointKey (key : String) : Bool :=
  (lower key).endsWith "url"

/-- The refinement on `PROVIDER_SETTINGS`: every URL-named setting, `base_url` and `baseURL`
included, is a string that is blank or a public https URL. Declared keys come first in order;
the order of other keys is not visible, so two failing ones are unknown. -/
def providerSettingsCheck (settings : Json) : Parsed :=
  let results := (endpointKeys settings).filterMap fun key =>
    if !isEndpointKey key then none
    else match field? settings key with
      | some (.str s) =>
        if (trim s).isEmpty then none
        else match urlCheck [.key key] (trim s) (fun _ => .ok none) with
          | .ok _ => none
          | other => some (key, other)
      | some _ => some (key, fail [.key key] "must be a string")
      | none => none
  match results with
  | [] => .ok (some settings)
  | (key, first) :: rest =>
    if rest.isEmpty || declaredSettings.contains key then first
    else .unknown "two endpoint settings fail: the first is not visible"

def providerSettings : Schema :=
  .transform
    (.check
      (.object false
        [("apiKey", optionalString),
         ("gatewayId", .optional (.check (.string (some gatewayIdError)) fun value =>
            match value with
            | .str s => if gatewayIdValid s then .ok (some value) else fail [] gatewayIdError
            | _ => .ok (some value))),
         ("base_url", optionalString),
         ("baseURL", optionalString),
         ("headers", .optional (stringRecord "must be an object with string values"))]
        none)
      providerSettingsCheck)
    fun settings =>
      match providerBaseUrl settings with
      | some url => del (set settings "baseURL" (.str url)) "base_url"
      | none => settings

def providersSchema : Schema :=
  refusingProtoKey
    (.check
      (.record (.enum providerNames (some "is not a supported provider")) providerSettings none)
      fun providers =>
        match field? providers "custom" with
        | none => .ok (some providers)
        | some custom =>
          if (providerBaseUrl custom).isSome then .ok (some providers)
          else
            let found := if has custom "baseUrl"
              then " (found \"baseUrl\", use \"base_url\" or \"baseURL\")" else ""
            fail [.key "custom", .key "base_url"] s!"is required{found}")
    "is not a supported provider"

def nonBlankRefinement (error : String) (inner : Schema) : Schema :=
  .check inner fun value =>
    match value with
    | .str s => if (trim s).isEmpty then fail [] error else .ok (some value)
    | _ => .ok (some value)

def workspaceRef : Schema :=
  .object false
    [("name", workspaceName),
     ("workspaceId", nonBlankRefinement "must be a non-empty string" (.custom fun input =>
        match input with
        | some (.str s) => .ok (some (.str s))
        | none => invalidType "string" (some "must be a non-empty string")
        | _ => invalidType "string" (some "must be a string"))),
     ("sandbox", .nullish (nonBlankRefinement "must be a non-empty string or null"
        (.string (some "must be a non-empty string or null"))))]
    none

/-- The first name repeated in the list, which runs in list order. -/
def workspaceRefs : Schema :=
  .check (.array workspaceRef) fun refs =>
    let names := ((arr? refs).getD []).map fun ref => (field? ref "name").bind str?
    let rec scan (seen : List String) (index : Nat) : List (Option String) → Parsed
      | [] => .ok (some refs)
      | some name :: rest =>
        if seen.contains name then
          fail [.index index, .key "name"] s!"\"{name}\" is used more than once"
        else scan (name :: seen) (index + 1) rest
      | none :: rest => scan seen (index + 1) rest
    scan [] 0 names

def webhookHook : Schema :=
  .check
    (.object false
      [("enabled", optionalBoolean),
       ("url", .optional nonEmptyString),
       ("secret", .optional nonEmptyString),
       ("events", .optional (eventList lifecycleEvents))]
      none)
    fun hook =>
      let required := "is required when {parent}.enabled is true"
      if field? hook "enabled" == some (.bool true) && !has hook "url" then fail [.key "url"] required
      else if field? hook "enabled" == some (.bool true) && !has hook "secret" then
        fail [.key "secret"] required
      else match field? hook "url" with
        | some (.str url) =>
          if url.isEmpty then .ok (some hook)
          else urlCheck [.key "url"] url fun _ => .ok (some hook)
        | _ => .ok (some hook)

def codeHook : Schema :=
  let error := "must be a native Convex document id"
  .object false
    [("hookId", .check (.string (some error)) fun value =>
        match value with
        | .str s => if isConvexId s then .ok (some value) else fail [] error
        | _ => .ok (some value)),
     ("enabled", optionalBoolean),
     ("events", .optional (eventList hookEvents))]
    none

def hooksSchema : Schema :=
  .object false
    [("webhooks", .optional (.array webhookHook)), ("code", .optional (.array codeHook))] none

def partitionSchema : Schema :=
  .check
    (.object false [("by", .enum ["shared", "conversation"] none), ("alias", .optional .unknown)] none)
    fun partition =>
      let alias := field? partition "alias"
      if field? partition "by" == some (.str "shared") then
        if alias.isSome then fail [.key "alias"] "is only supported when {parent}.by is conversation"
        else .ok (some partition)
      else
        match alias with
        | some (.str s) =>
          if (trim s).isEmpty then fail [.key "alias"] "must be a non-empty string"
          else if isDotted s then .ok (some partition)
          else fail [.key "alias"] "must use only letters, numbers, dots, underscores, or hyphens"
        | _ => fail [.key "alias"] "must be a non-empty string"

/-- `RETIRED_CHANNEL_KEYS`, in the order the check walks them. -/
def retiredChannelKeys : List (String × String) :=
  [("allowedChatIds", "allowedChannelIds"), ("allowedGroupIds", "allowedChannelIds"),
   ("allowedGuildIds", "allowedChannelIds"), ("allowedRepos", "allowedChannelIds"),
   ("workspaceIsolationScope", "partition"), ("workspaceScope", "partition")]

/-- `channelSchema(shape)`. -/
def channelSchema (shape : List (String × Schema)) : Schema :=
  .check
    (.object false
      ([("id", nonEmptyString),
        ("trace", .optional (.enum ["enabled", "disabled"] none)),
        ("allowedChannelIds", .optional nonEmptyStrings),
        ("allowedUserIds", .optional nonEmptyStrings),
        ("partition", .optional partitionSchema)] ++ shape)
      none)
    fun channel =>
      match retiredChannelKeys.find? (fun entry => has channel entry.1) with
      | some (retired, replacement) =>
        fail [.key retired] s!"is no longer supported; use \{parent}.{replacement}"
      | none => .ok (some channel)

def optUrl : Schema := .optional publicHttpsUrl
def optPattern (matches_ : String → Bool) (error : String) : Schema :=
  .optional (patternString matches_ error)
def graphVersion : Schema := optPattern isGraphVersion "must look like \"v21.0\""

def channelsSchema : Schema :=
  .object false
    [("telegram", .nullish (channelSchema
        [("apiUrl", optUrl), ("botToken", optionalString), ("webhookSecret", optionalString),
         ("botUsername", optionalString), ("reactionEmoji", optionalString)])),
     ("gchat", .nullish (channelSchema
        [("credentials", optionalString), ("endpointUrl", optUrl),
         ("googleChatProjectNumber", optPattern isDigits "must be the numeric project number"),
         ("workspaceAddOnServiceAccountEmail", optionalString), ("userName", optionalString)])),
     ("github", .nullish (channelSchema
        [("apiUrl", optUrl), ("webhookSecret", optionalString), ("appId", optionalString),
         ("privateKey", optionalString), ("botUserName", optionalString),
         ("botUserId", .optional (Spec.Zod.positiveInteger 9007199254740991))])),
     ("linear", .nullish (channelSchema
        [("apiKey", optionalString), ("apiUrl", optUrl), ("userName", optionalString),
         ("webhookSecret", optionalString)])),
     ("slack", .nullish (channelSchema
        [("apiUrl", optUrl), ("botToken", optionalString), ("signingSecret", optionalString),
         ("reactionEmoji", optionalString)])),
     ("discord", .nullish (channelSchema
        [("apiUrl", optUrl), ("botToken", optionalString), ("publicKey", optionalString),
         ("botUserId", optionalString), ("mentionRoleIds", .optional nonEmptyStrings)])),
     ("pancake", .nullish (channelSchema
        [("pageId", optionalString), ("pageAccessToken", optionalString),
         ("webhookSecret", optionalString), ("senderId", optionalString)])),
     ("teams", .nullish (channelSchema
        [("apiUrl", optUrl), ("appId", optionalString), ("appPassword", optionalString),
         ("appTenantId", optionalString),
         ("appType", .optional (.enum ["MultiTenant", "SingleTenant"] none)),
         ("userName", optionalString)])),
     ("twilio", .nullish (channelSchema
        [("accountSid", optionalString), ("authToken", optionalString), ("apiUrl", optUrl),
         ("statusCallbackUrl", optUrl), ("webhookUrl", optUrl),
         ("messagingServiceSid", optPattern isMessagingSid
            "must be a Messaging Service sid (\"MG\" and 32 hex digits)"),
         ("phoneNumber", optPattern isE164 "must be an E.164 number, e.g. \"+15551234567\""),
         ("userName", optionalString)])),
     ("zalo", .nullish (channelSchema
        [("botToken", optionalString),
         ("webhookSecret", .optional (.check (.string none) fun value =>
            match value with
            | .str s =>
              let size := s.utf8ByteSize
              if s.length == size && 8 ≤ size && size ≤ 256 then .ok (some value)
              else if s.length != size then .unknown "non-ASCII secret: JS counts UTF-16 units"
              else fail [] "must be 8 to 256 characters"
            | _ => .ok (some value)))])),
     ("instagram", .nullish (channelSchema
        [("accessToken", optionalString),
         ("accountId", optPattern isDigits "must be the numeric Instagram account id"),
         ("apiVersion", graphVersion), ("appSecret", optionalString), ("userName", optionalString),
         ("verifyToken", optionalString)])),
     ("messenger", .nullish (channelSchema
        [("apiVersion", graphVersion), ("appSecret", optionalString),
         ("pageAccessToken", optionalString), ("userName", optionalString),
         ("verifyToken", optionalString)])),
     ("whatsapp", .nullish (channelSchema
        [("accessToken", optionalString), ("apiUrl", optUrl),
         ("apiVersion", optPattern isGraphVersion "must look like \"v25.0\""),
         ("appSecret", optionalString),
         ("phoneNumberId", optPattern isDigits "must be the number's digits-only ID"),
         ("userName", optionalString), ("verifyToken", optionalString)]))]
    none

def toolsSchema : Schema :=
  .check
    (.record
      (.check (.string none) fun value =>
        match value with
        | .str s => if providerToolName s then .ok (some value) else fail [] "is not a supported tool"
        | _ => .ok (some value))
      (.object false
        [("enabled", optionalBoolean), ("needsApproval", optionalBoolean),
         ("config", .optional (.record (.string none) .unknown none))]
        none)
      none)
    fun tools =>
      let reserved := (Spec.Js.entries tools).filter fun (name, entry) =>
        reservedTools.contains name && field? entry "type" != some (.str "provider")
      match reserved with
      | [] => .ok (some tools)
      | [(name, _)] =>
        fail [.key name] s!"is a Broods tool name; only a provider tool that runs as {name} may use it"
      | _ => .unknown "two reserved tool names: the first is not visible"

def mcpSchema : Schema :=
  let error := "must be keyed by an MCP server id"
  refusingProtoKey
    (.record
      (.check (.string (some error)) fun value =>
        match value with
        | .str s => if isConvexId s then .ok (some value) else fail [] error
        | _ => .ok (some value))
      (.object false
        [("enabled", optionalBoolean), ("needsApproval", optionalBoolean),
         ("headers", .optional (stringRecord "must be an object of string values")),
         ("oauth", .optional (stringRecord "must be an object of string values"))]
        none)
      none)
    error

/-- `MAX_CONFIGURED_SKILLS`. -/
def maxConfiguredSkills : Nat := 32

def skillsSchema : Schema :=
  .check
    (.object false [("enabled", optionalBoolean), ("allowed", .optional nonEmptyStrings)] none)
    fun skills =>
      let allowed := ((field? skills "allowed").bind arr?).getD []
      if (dedupe allowed).length > maxConfiguredSkills then
        fail [.key "allowed"] s!"must list at most {maxConfiguredSkills} skills"
      else .ok (some skills)

def subagentSchema : Schema :=
  .object false
    [("enabled", optionalBoolean), ("stream", optionalBoolean), ("allowed", .optional nonEmptyStrings),
     ("context", .optional (.enum ["new", "inherited"] none)),
     ("mode", .optional (.enum ["ephemeral", "persistent"] none)),
     ("visibility", .optional (.enum ["full", "result", "none"] none)),
     ("model", .nullish modelSchema)]
    none

def enabledSwitch : Schema :=
  .object false [("enabled", optionalBoolean)] none

def sessionSchema : Schema :=
  .check
    (.object false
      [("pruning", .nullish (.object false [("enabled", optionalBoolean)] none)),
       ("autoCompaction", .nullish (.object false
          [("enabled", optionalBoolean),
           ("maxContextLength", .optional (Spec.Zod.positiveInteger 10000000))] none))]
      none)
    fun session =>
      if has session "compaction" then
        fail [.key "compaction"]
          "was renamed to {parent}.autoCompaction, and maxContextLength now counts input tokens"
      else .ok (some session)

/-- `AGENT_CONFIG`. -/
def agentConfig : Schema :=
  .object false
    [("agent", .nullish agentBehavior),
     ("harness", .nullish harnessSchema),
     ("model", .nullish modelSchema),
     ("transcription", .nullish transcriptionSchema),
     ("provider", .nullish providersSchema),
     ("workspaces", .nullish workspaceRefs),
     ("sandboxes", .optional nonEmptyStrings),
     ("session", .nullish sessionSchema),
     ("hooks", .nullish hooksSchema),
     ("channels", .nullish channelsSchema),
     ("tools", .nullish toolsSchema),
     ("mcp", .nullish mcpSchema),
     ("denyTools", .optional nonEmptyStrings),
     ("skills", .nullish skillsSchema),
     ("subagent", .nullish subagentSchema),
     ("scheduler", .nullish enabledSwitch),
     ("browser", .nullish enabledSwitch),
     ("policies", .nullish nonEmptyStrings),
     ("publicAccess", optionalBoolean),
     ("allowRunOverrides", optionalBoolean)]
    none

/-- `AGENT_RUNTIME_REFS`. -/
def agentRuntimeRefs : Schema :=
  .object false
    [("harness", .optional .unknown), ("workspaces", .nullish workspaceRefs),
     ("sandboxes", .optional nonEmptyStrings)]
    none

/-- `resourceCreateInput`. -/
def resourceCreateInput : Schema :=
  .object false
    [("name", nonEmptyString), ("description", optionalString), ("config", .optional .unknown)]
    (some "Request body must be an object")

/-- `UPDATE_AGENT_INPUT`. -/
def updateAgentInput : Schema :=
  .object false
    [("name", .optional nonEmptyString),
     ("description", .optional (.nullable (.string none))),
     ("config", .optional .unknown),
     ("status", .optional (.enum ["active", "disabled"] none))]
    (some "Request body must be an object")

/-- `POLICY_REMOVED_MESSAGE`. -/
def policyRemovedMessage : String :=
  "config.policy is no longer supported; use config.policies, and set mode on the policy itself"

/-- `SANDBOX_REMOVED_MESSAGE`. -/
def sandboxRemovedMessage : String :=
  "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default"

/-- `workspaceOnLaterSandbox` on JSON refs: `ref.sandbox === sandboxes[index]`. -/
def workspaceOnLater (sandboxes : List Json) (index : Nat) (workspaces : Json) : Option Json :=
  if index == 0 then none
  else ((arr? workspaces).getD []).find? fun ref =>
    (field? ref "sandbox") == sandboxes[index]?

/-- `assertRuntimeRefs`, with `sandboxes` read as `config.sandboxes ?? []`. -/
def runtimeRefsProblem (config : Json) (patch : Bool) : Out :=
  if has config "sandbox" then .threw sandboxRemovedMessage else
  let sandboxes := orElse (get config "sandboxes") (.arr #[])
  match arr? sandboxes with
  | none => .unknown "sandboxes is not a list"
  | some ids =>
    let rec scan (seen : List Json) (index : Nat) : List Json → Option String
      | [] => none
      | id :: rest =>
        let shown := (string? (some id)).getD ""
        if seen.contains id then
          some s!"config.sandboxes[{index}] \"{shown}\" is listed more than once"
        else match workspaceOnLater ids index (get config "workspaces") with
          | some mounted =>
            let name := (string? (field? mounted "name")).getD ""
            some (s!"config.sandboxes[{index}] \"{shown}\" also backs workspace \"{name}\"; " ++
              "only the first sandbox can back a workspace")
          | none => scan (id :: seen) (index + 1) rest
    match scan [] 0 ids with
    | some message => .threw message
    | none =>
      if patch || !ids.isEmpty || nullish (field? config "harness") then .ok .null
      else match get config "harness" with
        | .obj kvs =>
          match string? (kvs.get? "type") with
          | some kind =>
            .threw s!"config.sandboxes needs at least one sandbox for the {kind} harness; the first runs it"
          | none => .unknown "harness type is an object"
        | _ => .ok .null

/-- `assertMetaCredentials`. A `trim` on a non-string cannot happen: the check is `typeof` first. -/
def metaCredentialsProblem (config : Json) (path : String) (fields : List String) : Option String :=
  match fields.find? (has config) with
  | none => none
  | some present =>
    let blank := fields.find? fun field =>
      match field? config field with
      | some (.str s) => (trim s).isEmpty
      | _ => false
    match blank with
    | some empty => some s!"{path}.{empty} must be a non-empty string"
    | none =>
      (fields.find? (fun field => !has config field)).map fun missing =>
        s!"{path}.{missing} is required when {path}.{present} is set"

/-- `assertCompleteChannels`. -/
def completeChannelsProblem (channels : Json) : Out :=
  let gchat := get channels "gchat"
  let linear := get channels "linear"
  let teams := get channels "teams"
  let blankOrAbsent (value : Option Json) : Option Bool :=
    match value with
    | none | some .null => some true
    | some (.str s) => some (trim s).isEmpty
    | _ => none
  if has gchat "credentials" && !has gchat "endpointUrl" && !has gchat "googleChatProjectNumber" then
    .threw "config.channels.gchat needs endpointUrl or googleChatProjectNumber to verify webhooks"
  else
    let linearStep : Out :=
      if has linear "apiKey" then
        match blankOrAbsent (field? linear "userName") with
        | none => .unknown "linear.userName is not a string"
        | some true =>
          .threw ("config.channels.linear.userName is required: the display name of the member " ++
            "the API key belongs to")
        | some false =>
          if !truthy (get linear "webhookSecret") then
            .threw ("config.channels.linear.webhookSecret is required when " ++
              "config.channels.linear.apiKey is set")
          else .ok .null
      else .ok .null
    linearStep.bind fun _ =>
      let teamsStep : Out :=
        if has teams "appId" && field? teams "appType" != some (.str "MultiTenant") then
          match blankOrAbsent (field? teams "appTenantId") with
          | none => .unknown "teams.appTenantId is not a string"
          | some true =>
            .threw "config.channels.teams.appTenantId is required unless appType is \"MultiTenant\""
          | some false => .ok .null
        else .ok .null
      teamsStep.bind fun _ =>
        let instagram := get channels "instagram"
        let messenger := get channels "messenger"
        let instagramProblem :=
          if truthy instagram then
            metaCredentialsProblem instagram "config.channels.instagram"
              ["accessToken", "accountId", "appSecret", "verifyToken"]
          else none
        Out.unless_ instagramProblem fun _ =>
          let messengerProblem :=
            if truthy messenger then
              metaCredentialsProblem messenger "config.channels.messenger"
                ["appSecret", "pageAccessToken", "verifyToken"]
            else none
          Out.unless_ messengerProblem fun _ => .ok .null

/-- `assertHarnessSupports`, with the policy count passed in. -/
def harnessSupportProblem (config : Json) (policies : List Json) : Option String :=
  if !policies.isEmpty then some "config.policies is not supported with config.harness" else
  let check (model : Json) (label : String) : Option String :=
    let output := get model "output"
    if truthy output && field? output "type" != some (.str "text") then
      some s!"{label}.output structured output is not supported with config.harness"
    else if has model "providerOptions" then
      some s!"{label}.providerOptions is not supported with config.harness; set {label}.reasoning"
    else none
  match check (get config "model") "config.model" with
  | some message => some message
  | none => check (get (get config "subagent") "model") "config.subagent.model"

/-- `normalizeAgentConfig`. -/
def normalizeAgentConfig (value : Option Json) (patch : Bool) : Out :=
  if nullish value then .ok empty else
  (parseInput agentConfig value "config").bind fun config =>
    let policyIds := dedupe (((field? config "policies").bind arr?).getD [])
    let config := del config "policies"
    (runtimeRefsProblem config patch).bind fun _ =>
      let channelsStep :=
        if !patch && truthy (get config "channels") then completeChannelsProblem (get config "channels")
        else .ok .null
      channelsStep.bind fun _ =>
        if has config "policy" then .threw policyRemovedMessage else
        let harnessProblem :=
          if truthy (get config "harness") then harnessSupportProblem config policyIds else none
        Out.unless_ harnessProblem fun _ =>
          let skills := get config "skills"
          let config :=
            if truthy (get skills "allowed") then
              set config "skills" (set skills "allowed"
                (.arr (dedupe ((arr? (get skills "allowed")).getD [])).toArray))
            else config
          .ok (if policyIds.isEmpty then config else set config "policies" (.arr policyIds.toArray))

/-- `removeNullConfigValues`. -/
def removeNulls : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    Json.mkObj ((Spec.Js.entries value).filterMap fun (key, entry) =>
      match entry with
      | .null => none
      | .obj _ => some (key, removeNulls fuel entry)
      | other => some (key, other))

/-- `isObjectInput`: `Object.entries` on a recorded array or string is out of reach. -/
def agentConfigPatch (value : Option Json) : Out :=
  (parseInput configObject value "config").bind fun patch =>
    (normalizeAgentConfig (some (removeNulls depth patch)) true).bind fun _ => .ok patch

/-- `mergeConfigValue`, where `none` is `undefined`. -/
def mergeConfigValue : Nat → Option Json → Option Json → Option Json
  | 0, existing, _ => existing
  | fuel + 1, existing, patch =>
    match patch with
    | none => existing
    | some (.str "********") => existing
    | some .null => none
    | some (.obj raw) =>
      let patchObject := (Json.obj raw |> fun v => del v "__proto__")
      let existingObject := match existing with
        | some (.obj kvs) => del (.obj kvs) "__proto__"
        | _ => empty
      some ((Spec.Js.entries patchObject).foldl (fun merged (key, value) =>
        if key == "__proto__" || key == "constructor" || key == "prototype" then merged
        else match mergeConfigValue fuel (field? existingObject key) (some value) with
          | none => del merged key
          | some next => set merged key next) existingObject)
    | some other => some other

/-- `mergeConfigObjects`. -/
def mergeConfigObjects (existing patch : Json) : Json :=
  match mergeConfigValue depth (some existing) (some patch) with
  | some (.obj kvs) => del (.obj kvs) "__proto__"
  | _ => empty

/-- The `patch` option of a recorded call. -/
def patchOption (options : Json) : Bool :=
  truthy (get options "patch")

/-- Argument positions as they arrive: a recorded `undefined` is null. -/
def present (value : Json) : Option Json :=
  if value == .null then none else some value

private def source (name : String) : String :=
  s!"packages/convex/model/agentRules.ts#{name}"

def assertCompleteChannelsTwin : Spec.Twin where
  source := source "assertCompleteChannels"
  run := fun args => (completeChannelsProblem (Spec.Twin.arg args 0)).json

def assertRuntimeRefsTwin : Spec.Twin where
  source := source "assertRuntimeRefs"
  run := fun args =>
    (runtimeRefsProblem (Spec.Twin.arg args 0) (patchOption (Spec.Twin.arg args 1))).json

def normalizeAgentConfigTwin : Spec.Twin where
  source := source "normalizeAgentConfig"
  run := fun args =>
    (normalizeAgentConfig (present (Spec.Twin.arg args 0)) (patchOption (Spec.Twin.arg args 1))).json

def normalizeAgentConfigPatchTwin : Spec.Twin where
  source := source "normalizeAgentConfigPatch"
  run := fun args => (agentConfigPatch (present (Spec.Twin.arg args 0))).json

def mergeAgentConfigTwin : Spec.Twin where
  source := source "mergeAgentConfig"
  run := fun args =>
    (normalizeAgentConfig (some (mergeConfigObjects (Spec.Twin.arg args 0) (Spec.Twin.arg args 1))) false).json

/-- `normalizeCreateAgentInput`. -/
def createAgentInput (value : Option Json) : Out :=
  (parseInput resourceCreateInput value "").bind fun input =>
    (normalizeAgentConfig (field? input "config") false).bind fun config =>
      let description := ((field? input "description").bind str?).map trim
      let name := trim (((field? input "name").bind str?).getD "")
      let base := Json.mkObj [("name", .str name), ("config", config)]
      .ok (match description with
        | some text => if text.isEmpty then base else set base "description" (.str text)
        | none => base)

def normalizeCreateAgentInputTwin : Spec.Twin where
  source := source "normalizeCreateAgentInput"
  run := fun args => (createAgentInput (present (Spec.Twin.arg args 0))).json

/-- `normalizeUpdateAgentInput`. -/
def updateAgentConfig (existing : Json) (value : Option Json) : Out :=
  (parseInput updateAgentInput value "").bind fun input =>
    let configOut : Out :=
      if has input "config" then
        (agentConfigPatch (field? input "config")).bind fun patch =>
          normalizeAgentConfig (some (mergeConfigObjects existing patch)) false
      else .ok existing
    configOut.bind fun config =>
      let result := Json.mkObj [("config", config)]
      let result := match field? input "name" with
        | some (.str name) => set result "name" (.str (trim name))
        | _ => result
      let result := match field? input "description" with
        | some .null => set result "description" .null
        | some (.str text) =>
          let trimmed := trim text
          if trimmed.isEmpty then result else set result "description" (.str trimmed)
        | _ => result
      .ok (setOpt result "status" (field? input "status"))

def normalizeUpdateAgentInputTwin : Spec.Twin where
  source := source "normalizeUpdateAgentInput"
  run := fun args =>
    (updateAgentConfig (Spec.Twin.arg args 0) (present (Spec.Twin.arg args 1))).json

def assertAgentRuntimeRefsTwin : Spec.Twin where
  source := source "assertAgentRuntimeRefs"
  run := fun args =>
    let parsed := parseInput agentRuntimeRefs (present (Spec.Twin.arg args 0)) "config"
    (parsed.bind fun config => runtimeRefsProblem config (patchOption (Spec.Twin.arg args 1))).json

/-- `assertHarnessSupports`, on recorded configs and policy lists. -/
def assertHarnessSupportsTwin : Spec.Twin where
  source := source "assertHarnessSupports"
  run := fun args =>
    match arr? (Spec.Twin.arg args 1) with
    | some policies =>
      match harnessSupportProblem (Spec.Twin.arg args 0) policies with
      | some message => Spec.Twin.threw message
      | none => .null
    | none => Spec.Twin.unsupported "policies is not a list"

def assertMetaCredentialsTwin : Spec.Twin where
  source := source "assertMetaCredentials"
  run := fun args =>
    match Spec.Twin.arg args 1, arr? (Spec.Twin.arg args 2) with
    | .str path, some fields =>
      match metaCredentialsProblem (Spec.Twin.arg args 0) path (fields.filterMap str?) with
      | some message => Spec.Twin.threw message
      | none => .null
    | _, _ => Spec.Twin.unsupported "path or fields missing"

def removeNullConfigValuesTwin : Spec.Twin where
  source := source "removeNullConfigValues"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .obj kvs => removeNulls depth (.obj kvs)
    | _ => Spec.Twin.unsupported "not an object"

def isPrivateHostnameTwin : Spec.Twin where
  source := source "isPrivateHostname"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str host => toJson (privateHostname host)
    | _ => Spec.Twin.unsupported "hostname is not a string"

def isPrivateIpv4Twin : Spec.Twin where
  source := source "isPrivateIpv4"
  run := fun args =>
    match nat? (Spec.Twin.arg args 0), nat? (Spec.Twin.arg args 1) with
    | some a, some b => toJson (privateIpv4 a b)
    | _, _ => Spec.Twin.unsupported "octets are not natural numbers"

def isPrivateIpv6Twin : Spec.Twin where
  source := source "isPrivateIpv6"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str host =>
      toJson (host == "::" || host == "::1" || host.startsWith "::ffff:" || host.startsWith "fc" ||
        host.startsWith "fd" || ["fe8", "fe9", "fea", "feb"].any (fun pre => host.startsWith pre))
    | _ => Spec.Twin.unsupported "host is not a string"

def publicHttpsUrlProblemTwin : Spec.Twin where
  source := source "publicHttpsUrlProblem"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str value =>
      match urlProblem value with
      | .ok (some problem) => .str problem
      | .ok none => .null
      | .error reason => Spec.Twin.unsupported reason
    | _ => Spec.Twin.unsupported "value is not a string"

/-- `assertPublicHttpsUrl`. A trace can carry the `URL` it returns, so every call is compared. -/
def assertPublicHttpsUrlTwin : Spec.Twin :=
  Spec.Twin.traced (source "assertPublicHttpsUrl") fun call => do
    let value := Spec.Twin.callArg call 0
    let label := Spec.Twin.callArg call 1
    match ← Spec.Prog.effect "publicHttpsUrlProblem" [value], value, label with
    | .str problem, _, .str name =>
      let error ← Spec.Prog.effect "new ClientError" [.str s!"{name} {problem}"]
      .fail error
    | _, .str raw, _ =>
      match Spec.Url.parse raw with
      | .ok url =>
        if Spec.Url.plainHref url then
          return Lean.Json.mkObj [("$url", .str (Spec.Url.href url))]
        else Spec.Prog.unsupported "path needs re-encoding"
      | _ => Spec.Prog.unsupported "a URL the checker passed but the parser does not read"
    | _, _, _ => Spec.Prog.unsupported "value or label is not a string"

/-- `providerBaseURL` on unvalidated settings: a defined non-string has no `trim`. -/
def providerBaseURLTwin : Spec.Twin where
  source := source "providerBaseURL"
  run := fun args =>
    let settings := Spec.Twin.arg args 0
    let raw := match get settings "base_url" with
      | .str s => some (Json.str s)
      | _ => field? settings "baseURL"
    match raw with
    | none | some .null => .null
    | some (.str s) =>
      let trimmed := trim s
      if trimmed.isEmpty then .null else .str trimmed
    | some _ => Spec.Twin.unsupported "baseURL is not a string"

def isProviderToolNameTwin : Spec.Twin where
  source := source "isProviderToolName"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str name => toJson (providerToolName name)
    | _ => Spec.Twin.unsupported "name is not a string"

def isHarnessToolNameTwin : Spec.Twin where
  source := source "isHarnessToolName"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str name => toJson (reservedTools.contains name)
    | _ => Spec.Twin.unsupported "name is not a string"

def harnessToolNameProblemTwin : Spec.Twin where
  source := source "harnessToolNameProblem"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str name => .str s!"is a Broods tool name; only a provider tool that runs as {name} may use it"
    | _ => Spec.Twin.unsupported "name is not a string"

def normalizeWebhookHookConfigTwin : Spec.Twin where
  source := source "normalizeWebhookHookConfig"
  run := fun args =>
    match Spec.Twin.arg args 1 with
    | .str path => (parseInput webhookHook (present (Spec.Twin.arg args 0)) path).json
    | _ => Spec.Twin.unsupported "path is not a string"

def normalizeModelConfigTwin : Spec.Twin where
  source := source "normalizeModelConfig"
  run := fun args =>
    match Spec.Twin.arg args 1 with
    | .str label =>
      (parseInput (.nullish modelSchema) (present (Spec.Twin.arg args 0)) label).json
    | _ => Spec.Twin.unsupported "label is not a string"

/-- The twins in this file. -/
def agentRuleTwins : List Spec.Twin :=
  [normalizeAgentConfigTwin,
   normalizeAgentConfigPatchTwin, mergeAgentConfigTwin, normalizeCreateAgentInputTwin,
   normalizeUpdateAgentInputTwin, assertAgentRuntimeRefsTwin,
   removeNullConfigValuesTwin, isPrivateHostnameTwin, isPrivateIpv4Twin,
   isPrivateIpv6Twin, assertPublicHttpsUrlTwin,
   isProviderToolNameTwin, isHarnessToolNameTwin, harnessToolNameProblemTwin,
   normalizeWebhookHookConfigTwin, normalizeModelConfigTwin]

end Spec.Config
