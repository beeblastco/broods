import Spec.Twin
import Spec.Access.Twins.Js

namespace Spec.Agent.Waveagent2

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

private def nullish (value : Json) : Bool :=
  undef value || value == Json.null

private def text (value : Json) : String :=
  value.getStr?.toOption.getD ""

private def items (value : Json) : List Json :=
  value.getArr?.toOption.getD #[] |>.toList

private def props (value : Json) : List (String × Json) :=
  value.getObj?.toOption.map (·.toList) |>.getD []

private def truthy (value : Json) : Bool :=
  !nullish value && value != toJson false && value != toJson (0 : Nat) && value != toJson ""

private def str (value : Json) : String :=
  if undef value then "undefined" else
  match value with
  | .str s => s
  | .null => "null"
  | .obj _ => "[object Object]"
  | _ => value.compress

private def num (value : Json) : Int :=
  value.getInt?.toOption.getD 0

private def member (value : Json) (key : String) : Json :=
  if undef (field value "$opaque") then field value key else Twin.field value key

private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun (_, value) => !undef value)

private def fallback (value alternative : Json) : Json :=
  if nullish value then alternative else value

private def returned (value : Json) : Json :=
  if undef value then Json.null else value

private def plain (source : String) (run : Json → Json) : Twin :=
  { source := source, run := fun args => returned (run args) }

private def normalizeJson : Nat → Json → Json
  | 0, _ => Json.null
  | fuel + 1, value =>
    if !undef (field value "$error") then normalizeJson fuel (field (field value "$error") "fields")
    else if !undef (field value "$opaque") then normalizeJson fuel (field value "$fields")
    else match value with
      | .arr xs => .arr (xs.map fun x => if undef x || !undef (field x "$fn") then Json.null else normalizeJson fuel x)
      | .obj _ => obj ((props value).filterMap fun (k, v) =>
          if undef v || !undef (field v "$fn") then none else some (k, normalizeJson fuel v))
      | _ => value

private def toLifecycleValue (args : Json) : Json :=
  let value := Twin.arg args 0
  if !undef (field value "$bigint") then field value "$bigint"
  else if !undef (field value "$fn") then
    toJson s!"[function {if text (field value "$fn") == "" then "anonymous" else text (field value "$fn")}]"
  else if !undef (field value "$symbol") then fallback (field value "$symbol") (toJson "symbol")
  else if undef value then value else normalizeJson 128 value

private def serializeError (args : Json) : Json :=
  let value := Twin.arg args 0
  let error := field value "$error"
  if !undef error then
    let fields := field error "fields"
    obj ([("name", field error "name"), ("message", field error "message")] ++
      (["status", "statusCode", "requestId"].map fun k => (k, field fields k)) ++
      (if truthy (field fields "stack") then
        [("stack", toJson (String.intercalate "\n" ((text (field fields "stack")).splitOn "\n" |>.take 8)))] else []))
  else if !truthy value || (match value with | .obj _ => false | .arr _ => false | _ => true) then
    obj [("message", toJson (str value))]
  else if undef (field value "message") then Twin.unsupported "object error needs contextual errorMessage"
  else obj ([("name", field value "name"), ("message", field value "message"), ("raw", value)] ++
    ["status", "statusCode", "requestId"].map fun k => (k, field value k))

private def shouldAutoCompact (args : Json) : Json :=
  let config := field (field (Twin.arg args 0) "session") "autoCompaction"
  toJson (if field config "enabled" == toJson false then false
    else if truthy (Twin.arg args 2) then true
    else if nullish (Twin.arg args 1) then false
    else num (Twin.arg args 1) >= num (fallback (field config "maxContextLength") (toJson (500000 : Nat))))

private def summarizeToolsUsed (args : Json) : Json := Id.run do
  let calls := ((items (field (Twin.arg args 0) "$map")).map fun pair => Twin.arg pair 1).mergeSort fun a b =>
    let left := num (field a "stepNumber")
    let right := num (field b "stepNumber")
    left < right || (left == right && text (field a "toolCallId") <= text (field b "toolCallId"))
  let mut counts : List (String × Nat) := []
  for call in calls do
    let name := text (field call "toolName")
    let count := (counts.lookup name).getD 0
    counts := counts.filter (fun (k, _) => k != name) ++ [(name, count + 1)]
  return obj [("toolsUsed", toJson ((counts.map Prod.fst).mergeSort (· <= ·))),
    ("toolUsage", obj (counts.map fun (k,v) => (k,toJson v))), ("toolCalls", toJson calls)]

private def toolImage (args : Json) : Json :=
  let item := Twin.arg args 0
  let kind := text (field item "type")
  let image := if kind == "file" then field (field item "data") "data" else field item "data"
  let keepImage := kind == "image-data" ||
    ((text (field item "mediaType")).startsWith "image" &&
      (kind == "file-data" || (kind == "file" && field (field item "data") "type" == toJson "data")))
  toJson (if keepImage then [obj [("type", toJson "image"), ("image", image), ("mediaType", field item "mediaType")]] else [])

private def requireHarnessProviderSettings (args : Json) : Json :=
  let name := str (Twin.arg args 1)
  let settings := field (field (Twin.arg args 0) "provider") name
  if !truthy settings then Twin.threw s!"config.provider.{name} is required for config.harness"
  else if !truthy (field settings "apiKey") then Twin.threw s!"config.provider.{name}.apiKey is required for config.harness"
  else returned settings

private def requireHarnessProviderName (args : Json) : Json :=
  let name := field (field (Twin.arg args 0) "model") "provider"
  if !truthy name then Twin.threw "config.model.provider is required for config.harness" else returned name

private def accountString (required : Bool) (args : Json) : Json :=
  let value := Twin.arg args 0
  let name := str (Twin.arg args 1)
  if !required && value == Json.null then returned Twin.undefinedJson
  else match value with
  | .str s =>
    let trimmed := s.trimAscii.toString
    if required && trimmed.isEmpty then Twin.threw s!"{name} must be a non-empty string"
    else returned (if trimmed.isEmpty then Twin.undefinedJson else toJson trimmed)
  | _ => Twin.threw (if required then s!"{name} must be a non-empty string" else s!"{name} must be a string")

private def ownedGeneration (args : Json) : Json :=
  let admission := Twin.arg args 0
  if field admission "outcome" != toJson "owner" || undef (field admission "ownerGeneration") then
    Twin.threw s!"Subagent conversation is busy ({str (field admission "outcome")}). Message it with message-agents, or try again in a few minutes."
  else returned (field admission "ownerGeneration")

private def hasPendingToolApprovalResponse (args : Json) : Json :=
  let last := (items (Twin.arg args 0)).getLast?.getD Json.null
  let content := items (field last "content")
  toJson (field last "role" == toJson "tool" && !content.isEmpty &&
    content.all fun part => field part "type" == toJson "tool-approval-response")

private def harnessEffort (args : Json) : Json :=
  let reasoning := Twin.arg args 0
  if reasoning == toJson "minimal" then toJson "low"
  else if ["low", "medium", "high", "xhigh"].contains (text reasoning) then reasoning else Twin.undefinedJson

private def rowOutcome (args : Json) : Json :=
  let row := Twin.arg args 0
  obj [("status", if ["completed", "awaiting_input"].contains (text (field row "status")) then field row "status" else toJson "failed"),
    ("response", field row "response"), ("error", field row "error"), ("question", field row "question")]

private def taskMetadata (args : Json) : Json :=
  let task := Twin.arg args 0
  obj ([("taskId", field task "taskId"), ("eventId", field task "eventId"), ("agentId", field task "agentId"),
    ("conversationKey", field task "publicConversationKey")] ++
    if truthy (field task "description") then [("description", field task "description")] else [])

private def sessionObservabilityScope (args : Json) : Json :=
  let session := Twin.arg args 0
  obj (([("accountId", "accountId"), ("project", "projectSlug"), ("stage", "stageSlug"),
    ("endpointId", "endpointId"), ("agentId", "agentId")].map fun (k,v) => (k, fallback (member session v) (toJson ""))) ++
    [("conversationKey", member session "conversationKey")])

private def formatInstructions (args : Json) : Json :=
  let trimmed := (text (Twin.arg args 0)).trimAscii.toString
  toJson (if trimmed.isEmpty then "" else
    "\n\nThe user requested this compaction with instructions. Follow them when choosing what to preserve and emphasize:\n" ++ trimmed)

private def createCompactionSummaryMessage (args : Json) : Json :=
  obj [("role", toJson "system"), ("content", toJson
    ("<session-compaction-summary>\nThe following is a compacted summary of earlier conversation history. Treat it as context for this conversation and prefer newer explicit messages when they conflict.\n\n" ++
      (text (Twin.arg args 0)).trimAscii.toString ++ "\n</session-compaction-summary>"))]

private def resolveSandboxLifecycle (args : Json) : Json :=
  let lifecycle := Twin.arg args 0
  obj [("idleTimeoutSeconds", fallback (field lifecycle "idleTimeoutSeconds") (toJson (900 : Nat))),
    ("maxLifetimeSeconds", field lifecycle "maxLifetimeSeconds")]

private def hookArgs (call : Json) : Prog Json := do
  let schema ← Prog.effect "asSchema" [field (Twin.callArg call 0) "inputSchema"]
  if !truthy (field schema "validate") then return Twin.callArg call 2
  let result ← Prog.effect "validate" [Twin.callArg call 2]
  if !truthy (field result "success") then
    let error := field result "error"
    let message := if undef (field error "$error") then field error "message" else field (field error "$error") "message"
    if message == Twin.undefinedJson || message == .null then
      return ← Prog.unsupported "ZodError.message is an accessor the recorder does not read"
    return ← Prog.throwError "Error" s!"Tool \"{str (Twin.callArg call 1)}\" got invalid args from hook: {str message}"
  return field result "value"

private def harnessReadsMedia (call : Json) : Prog Json := do
  let outcome ← Prog.attempt "extractHarnessPromptContent"
    [obj [("prompt", obj [("role", toJson "user"), ("content", toJson [Twin.callArg call 0])])]]
  match outcome with
  | .ok _ => return toJson true
  | .threw error _ =>
    let unsupported ← Prog.effect "HarnessCapabilityUnsupportedError.isInstance" [error]
    if truthy unsupported then return toJson false else throw error
  | .pending => Prog.unsupported "unfinished media extraction"

private def systemTraceAttributes (call : Json) : Prog Json := do
  let messages := items (Twin.callArg call 0)
  let content := messages.map fun message => text (field message "content")
  let serialized ← Prog.effect "serialize" [toJson (String.intercalate "\n\n" content)]
  return obj [("model.system", serialized), ("model.system_part_count", toJson messages.length),
    ("model.system_chars", toJson ((content.map fun s => s.toList.foldl (fun n c => n + if c.toNat > 65535 then 2 else 1) 0).foldl (· + ·) 0))]

private def publishSpan (_call : Json) : Prog Json := do
  let conn ← Prog.effect "getSharedNatsConn"
  if truthy conn then Prog.unsupported "observability context is not recorded" else pure Twin.undefinedJson

private def applyMessageSendingHook (call : Json) : Prog Json := do
  let mutation ← Prog.effect "hooks.runMutation" [toJson "channel.message.sending",
    obj [("channel", Twin.callArg call 1), ("text", Twin.callArg call 2)]]
  if field mutation "drop" == toJson true then return Json.null
  match field mutation "text" with
  | .str s => return toJson s
  | _ => return Twin.callArg call 2

private def foldAgentFinished (call : Json) : Prog Json := do
  let hasHooks ← Prog.effect "hooks.hasHooksFor" [toJson "agent.finished"]
  if !truthy hasHooks then return Twin.callArg call 1
  let response ← Prog.effect "toLifecycleValue" [Twin.callArg call 1]
  let mutation ← Prog.effect "hooks.runMutation" [toJson "agent.finished",
    obj [("finishReason", Twin.callArg call 2), ("response", response)]]
  return if !undef (field mutation "output") then field mutation "output" else Twin.callArg call 1

private def compactionSpanAttributes (call : Json) : Prog Json := do
  let result := Twin.callArg call 0
  let attributes ← Prog.effect "modelTokenAttributes" [field result "usage"]
  return obj ([("compaction.message_count", field result "messageCount"), ("compaction.model_calls", field result "modelCalls")] ++ props attributes)

private def giveUpLostSubagentResult (call : Json) : Prog Json := do
  let _ ← Prog.effect "markAsyncAgentHandback" [Twin.callArg call 0, toJson "stored"]
  return Twin.undefinedJson

private def rowTaskId (call : Json) : Prog Json := do
  let eventId := Twin.callArg call 0
  let child ← Prog.effect "parseAccountAgentScopedKey" [eventId]
  if !truthy child then return toJson ""
  Prog.effect "publicEventIdForScope" [eventId, field child "accountId", field child "agentId", toJson ""]

private def resolveAuthEnv (kind : String) (call : Json) : Prog Json := do
  let provider := Twin.callArg call 0
  let base ← Prog.effect "resolveHarnessProviderBaseUrl" [provider]
  let envPrefix := if kind == "anthropic" then "ANTHROPIC" else if kind == "openai" then "OPENAI" else "AI_GATEWAY"
  return obj ([(envPrefix ++ "_API_KEY", field provider "apiKey")] ++
    (if truthy base then [(envPrefix ++ "_BASE_URL", base)] else []) ++
    (if kind == "openai" then
      (if truthy (field provider "organization") then [("OPENAI_ORGANIZATION", field provider "organization")] else []) ++
      (if truthy (field provider "project") then [("OPENAI_PROJECT", field provider "project")] else []) else []))

private def stoppedOnPurpose (args : Json) : Json :=
  let error := field (Twin.arg args 0) "error"
  toJson (["Stopped by user at the model boundary", "Stopped by the parent agent at the model boundary"].contains (text error))

private def requireParentAccountId (args : Json) : Json :=
  let account := member (Twin.arg args 0) "accountId"
  if truthy account then returned account else Twin.threw "Subagents require an account-scoped parent session"

private def cryptoHash (call : Json) : Prog Json := do
  let _ ← Prog.effect "createHash" [toJson "sha256"]
  let _ ← Prog.effect "createHash(\"sha256\").update" [Twin.callArg call 0]
  Prog.effect "createHash(\"sha256\").update(secret).digest" [toJson "hex"]

private def createWebhookSignature (call : Json) : Prog Json := do
  let _ ← Prog.effect "createHmac" [toJson "sha256", Twin.callArg call 0]
  let _ ← Prog.effect "createHmac(\"sha256\", secret).update" [Twin.callArg call 1]
  let digest ← Prog.effect "createHmac(\"sha256\", secret).update(body).digest" [toJson "hex"]
  return toJson ("sha256=" ++ text digest)

private def noteNonce (call : Json) : Prog Json := do
  let _ ← Prog.effect "createHash" [toJson "sha256"]
  let joined := str (Twin.callArg call 0) ++ String.singleton (Char.ofNat 0) ++ str (Twin.callArg call 1)
  let _ ← Prog.effect "createHash(\"sha256\").update" [toJson joined]
  let digest ← Prog.effect "createHash(\"sha256\").update(`${taskId}\\0${text}`).digest" [toJson "hex"]
  let chars := (text digest).toList
  let part := fun start count => String.ofList ((chars.drop start).take count)
  return toJson (part 0 8 ++ "-" ++ part 8 4 ++ "-5" ++ part 13 3 ++ "-8" ++ part 17 3 ++ "-" ++ part 20 12)

private def positiveIntegerEnv (call : Json) : Prog Json := do
  let name := Twin.callArg call 0
  let value ← Prog.effect "optionalEnv" [name]
  if undef value then return Twin.callArg call 1
  let parsed := Access.Js.numberOfString (text value)
  if Access.Js.isSafeInteger parsed && parsed >= 1 then return toJson parsed.toUInt64.toNat
  else Prog.throwError "Error" s!"{str name} must be a positive integer"

private def outlivedMaxLifetime (call : Json) : Prog Json := do
  let limit := field (Twin.callArg call 0) "maxLifetimeSeconds"
  if undef limit then return toJson false
  let now ← Prog.effect "Date.now"
  return toJson (decide (num now - num (Twin.callArg call 1) >= num limit * 1000))

private def resolveAnthropicOrVercelAuthEnv (call : Json) : Prog Json :=
  Prog.effect (if Twin.callArg call 0 == toJson "anthropic" then "resolveAnthropicAuthEnv" else "resolveGatewayAuthEnv") [Twin.callArg call 1]

private def legacyClaude (model : String) : Bool :=
  ((model.splitOn "claude-").drop 1).any fun suffix =>
    suffix.startsWith "3" ||
    ["haiku-4.5", "haiku-4-5", "sonnet-4.5", "sonnet-4-5", "opus-4.1", "opus-4-1"].any (fun stem => suffix.startsWith stem) ||
    ["opus-4", "sonnet-4"].any fun stem =>
      if !suffix.startsWith stem then false else
      let rest := String.ofList (suffix.toList.drop stem.length)
      rest.isEmpty || rest.startsWith ".0" || rest.startsWith "-0" ||
        (rest.startsWith "-20" && (rest.toList.drop 3 |>.take 6).length == 6 &&
          (rest.toList.drop 3 |>.take 6).all Char.isDigit)

private def anthropicHarnessReasoning (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let model := field config "model"
  let reasoning := field model "reasoning"
  let level ← if reasoning == toJson "none" then pure (toJson "low") else Prog.effect "harnessEffort" [reasoning]
  let effort := if legacyClaude (text (field model "modelId")) then Twin.undefinedJson
    else if level == toJson "xhigh" then toJson "high" else level
  let _ ← Prog.effect "warnReasoningChanged" [config, effort]
  return obj (if truthy effort then [("effort", effort)] else [])

private def applySteering : Nat → Json → Json → Json → Nat → Prog Json
  | 0, _, _, _, _ => Prog.unsupported "steering exceeds 256 batches"
  | fuel + 1, session, context, config, count => do
    let steering ← Prog.effect "session.applySteeringIngress"
    if !truthy steering then
      if count == 0 then return Twin.undefinedJson
      let _ ← Prog.effect "session.loadRefreshedSystemPromptParts" [obj [
        ("systemContextSnapshot", field context "systemContextSnapshot"),
        ("ephemeralSystem", field context "ephemeralSystem")]]
      return Twin.undefinedJson
    let events := field steering "events"
    let ephemeral ← Prog.effect "session.appendIngressEvents" [events]
    let _ ← Prog.effect "steeringModelMessages" [events, config, member session "accountId"]
    let next := obj ((props context).filter (fun (k,_) => k != "ephemeralSystem") ++
      [("ephemeralSystem", toJson (items (field context "ephemeralSystem") ++ items ephemeral))])
    applySteering fuel session next config (count + (items (field steering "contributingEventIds")).length)

private def createAgentHookDispatcher (call : Json) : Prog Json := do
  let refs := (items (field (field (Twin.callArg call 1) "hooks") "code")).filter fun ref => field ref "enabled" != toJson false
  if !truthy (Twin.callArg call 0) || refs.isEmpty then
    return obj [("hasHooksFor", Json.mkObj [("$fn", toJson "hasHooksFor")]), ("runMutation", Json.mkObj [("$fn", toJson "runMutation")])]
  Prog.unsupported "configured hooks need the event index model"

private def traced (path name : String) (run : Json → Prog Json) : Twin :=
  Twin.traced ("apps/core/src/" ++ path ++ "#" ++ name) run

private def pureTwin (path name : String) (run : Json → Json) : Twin :=
  plain ("apps/core/src/" ++ path ++ "#" ++ name) run

private def fnRef (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

private def opaqueRef (name : String) : Json :=
  Json.mkObj [("$opaque", toJson name)]

/-- Runs the `new Promise` executor the recording entered. -/
private def enterExecutor : Prog Unit :=
  Prog.drain (fun _ _ => pure ()) 1

private def pad (width : Nat) (n : Int) : String :=
  let digits := toString n.toNat
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `new Date(ms).toISOString()`, by the days-to-civil algorithm. -/
private def isoFromMillis (ms : Int) : String :=
  let day := ms / 86400000
  let rest := ms - day * 86400000
  let z := day + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let d := doy - (153 * mp + 2) / 5 + 1
  let m := if mp < 10 then mp + 3 else mp - 9
  let y := yoe + era * 400 + (if m <= 2 then 1 else 0)
  s!"{pad 4 y}-{pad 2 m}-{pad 2 d}T{pad 2 (rest / 3600000)}:{pad 2 (rest / 60000 % 60)}:{pad 2 (rest / 1000 % 60)}.{pad 3 (rest % 1000)}Z"

private def hexUpper (n : Nat) : Char :=
  "0123456789ABCDEF".toList.getD n '0'

/-- `encodeURIComponent` over the string's UTF-8 bytes. -/
private def encodeUriComponent (value : String) : String :=
  let keep := "-_.!~*'()".toList
  String.ofList (value.toList.flatMap fun c =>
    if c.isAlphanum && c.toNat < 128 || keep.contains c then [c]
    else (String.singleton c).toUTF8.toList.flatMap fun b =>
      ['%', hexUpper (b.toNat / 16), hexUpper (b.toNat % 16)])

/-- Standard base64 of the string's UTF-8 bytes, as the recorder writes a `Buffer`. -/
private def base64 (value : String) : String :=
  let alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList
  let at_ := fun (n : Nat) => alphabet.getD n 'A'
  let rec go : Nat → List Nat → List Char
    | 0, _ => []
    | fuel + 1, a :: b :: c :: rest =>
      [at_ (a / 4), at_ ((a % 4) * 16 + b / 16), at_ ((b % 16) * 4 + c / 64), at_ (c % 64)] ++ go fuel rest
    | _, [a, b] => [at_ (a / 4), at_ ((a % 4) * 16 + b / 16), at_ ((b % 16) * 4), '=']
    | _, [a] => [at_ (a / 4), at_ ((a % 4) * 16), '=', '=']
    | _, [] => []
  let bytes := value.toUTF8.toList.map (·.toNat)
  String.ofList (go (bytes.length + 1) bytes)

private def isLowerHex (c : Char) : Bool :=
  c.isDigit || (c.toNat >= 97 && c.toNat <= 102)

/-- The uuid capture of `PERSISTENT_SUBAGENT_KEY`, or none when the key does not match. -/
private def persistentKeyUuid (key : String) : Option String :=
  let prefixChars := "subagent-persistent-".toList
  let chars := key.toList
  if chars.take prefixChars.length != prefixChars then none else
  match (String.ofList (chars.drop prefixChars.length)).splitOn "-" with
  | [a, b, c, d, e, tag] =>
    let shaped := [(a, 8), (b, 4), (c, 4), (d, 4), (e, 12), (tag, 32)].all fun (part, size) =>
      part.length == size && part.toList.all isLowerHex
    if shaped then some s!"{a}-{b}-{c}-{d}-{e}" else none
  | _ => none

private def lostResultWindows (args : Json) : Json :=
  let now := num (Twin.arg args 0)
  let grace : Int := 2 * 60000
  let maxAge : Int := 24 * 3600000
  let abandon : Int := max (15 * 60000) (10 * 60000) + 3 * 60000 + grace
  obj [("updatedAfter", toJson (isoFromMillis (now - maxAge))),
    ("finishedBefore", fnRef "finishedBefore"),
    ("abandonedBefore", toJson (isoFromMillis (now - abandon)))]

private def toDispatch (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let address ←
    if truthy (field task "persistent") then
      let value ← Prog.effect "childAddress"
        [obj [("agentId", field task "agentId"), ("conversationKey", field task "publicConversationKey")]]
      pure [("address", value)]
    else pure []
  let statusPath ← Prog.effect "subagentStatusPath" [task]
  return obj ([("taskId", field task "taskId"), ("agentId", field task "agentId")] ++
    (if truthy (field task "description") then [("description", field task "description")] else []) ++
    [("conversationKey", field task "publicConversationKey")] ++ address ++
    [("runId", field task "runId"), ("statusPath", statusPath), ("status", toJson "running")])

/-- The entries of a recorded `Map`, in insertion order. -/
private def liveEntries (value : Json) : List (Json × Json) :=
  (items (field value "$map")).map fun entry => (Twin.arg entry 0, Twin.arg entry 1)

private def liveMap (entries : List (Json × Json)) : Json :=
  Json.mkObj [("$map", .arr (entries.map fun entry => Json.arr #[entry.1, entry.2]).toArray)]

private def reserveLive (call : Json) : Prog Json := do
  let admission ← Prog.effect "pendingAdmission"
  let live := obj ([("taskId", field (Twin.callArg call 1) "taskId"), ("inbox", .arr #[])] ++ props admission)
  let key := Twin.callArg call 0
  let entries := liveEntries (Twin.moduleValue call "liveChildren")
  let updated := if entries.any (·.1 == key) then
      entries.map fun entry => if entry.1 == key then (key, live) else entry
    else entries ++ [(key, live)]
  Prog.setState "module.liveChildren" (liveMap updated)
  return live

/-- `settleLive`. Only a child that never started leaves the map, and only if still this one. -/
private def settleLive (call : Json) : Prog Json := do
  let key := Twin.callArg call 0
  let live := Twin.callArg call 1
  let entries := liveEntries (Twin.moduleValue call "liveChildren")
  let current := entries.find? (·.1 == key)
  if !truthy (Twin.callArg call 2) && current.any (·.2.compress == live.compress) then
    Prog.setState "module.liveChildren" (liveMap (entries.filter (·.1 != key)))
  let _ ← Prog.effect "live.settle" [Twin.callArg call 2]
  return Twin.undefinedJson

private def mintedChildKey (call : Json) : Prog Json := do
  let key := text (Twin.callArg call 1)
  match persistentKeyUuid key with
  | none => return toJson false
  | some uuid =>
    let expected := text (← Prog.effect "this.mintChildKey" [Twin.callArg call 0, toJson uuid])
    if key.utf8ByteSize != expected.utf8ByteSize then return toJson false
    Prog.effect "timingSafeEqual"
      [Json.mkObj [("$bytes", toJson (base64 key))], Json.mkObj [("$bytes", toJson (base64 expected))]]

private def parentVisibleCompletion (call : Json) : Prog Json := do
  let completion := Twin.callArg call 0
  if truthy (← Prog.effect "stoppedOnPurpose" [completion]) then return Json.null
  if field completion "status" != toJson "completed" then return completion
  let visible ← Prog.catchFail
    (do
      let response := field completion "response"
      let result ← if undef response then pure Json.null else Prog.effect "toLifecycleValue" [response]
      let mutation ← Prog.effect "( await hooks ).runMutation" [toJson "subagent.task.finished",
        obj [("taskId", field completion "taskId"), ("agentId", field completion "agentId"), ("result", result)]]
      Prog.effect "toLifecycleValue" [field mutation "visibleResult"])
    (fun error => do
      let _ ← Prog.effect "toErrorMessage" [error]
      pure Twin.undefinedJson)
  if !undef visible then
    return obj (props completion ++ [("visibleResult", visible)])
  let visibility := fallback (field (field (Twin.callArg call 1) "subagent") "visibility") (toJson "result")
  return if visibility == toJson "none" then Json.null else completion

private def completionToParentMessage (call : Json) : Prog Json := do
  let completion := Twin.callArg call 0
  let status := field completion "status"
  let metadata := String.intercalate "\n"
    ([s!"taskId: {str (field completion "taskId")}", s!"agentId: {str (field completion "agentId")}"] ++
      (if truthy (field completion "description") then
        [s!"agentDescription: {str (field completion "description")}"] else []) ++
      [s!"conversationKey: {str (field completion "conversationKey")}", s!"status: {str status}"])
  let visible := fallback (field completion "visibleResult") (field completion "response")
  let parts ←
    if status == toJson "completed" && !undef visible then
      Prog.effect "modelValueToUserParts" [visible]
    else pure (.arr #[])
  let dedupeKey ← Prog.effect "subagentResultDedupeKey" [field completion "eventId", status]
  let message := fun (content : Json) =>
    obj [("role", toJson "user"), ("dedupeKey", dedupeKey), ("content", content)]
  let textPart := fun (body : String) =>
    toJson [obj [("type", toJson "text"), ("text", toJson body)]]
  if status == toJson "awaiting_input" then
    let address ← Prog.effect "childAddress" [completion]
    let exchange := if truthy (field completion "exchangeId")
      then s!" (exchange {str (field completion "exchangeId")})" else ""
    return message (textPart
      s!"Subagent message for the parent{exchange}. The subagent ended its turn waiting on your reply. Reply with message-agents to \"{str address}\"; it resumes with its work so far.\n{metadata}\n\nMessage:\n{str (fallback (field completion "question") (toJson "(no message)"))}")
  let header := s!"Subagent and async agent result injected into parent conversation.\n{metadata}\n\nResult:\n"
  if !(items parts).isEmpty then
    return message (← Prog.effect "prependTextToUserParts" [toJson header, parts])
  let detail := if status == toJson "running"
    then "Still working. Its result will arrive in this conversation as a new message when it finishes, so do not redo this task."
    else str (fallback (field completion "error") (toJson "(no result)"))
  return message (textPart (header ++ detail))

private def noteToParentMessage (call : Json) : Prog Json := do
  let child := Twin.callArg call 0
  let note := Twin.callArg call 1
  let address ← Prog.effect "childAddress" [child]
  let followUp := if truthy (field note "followUp") then ", follow-up" else ""
  return obj [("role", toJson "user"), ("dedupeKey", toJson s!"subagent-note:{str (Twin.callArg call 2)}"),
    ("content", toJson [obj [("type", toJson "text"), ("text", toJson
      s!"Subagent note for the parent (exchange {str (field note "exchangeId")}{followUp}). It keeps working; no reply is needed, but you can send one with message-agents to \"{str address}\".\ntaskId: {str (field child "taskId")}\nagentId: {str (field child "agentId")}\n\nNote:\n{str (field note "text")}")]])]

private def emitTaskFinished (call : Json) : Prog Json := do
  match ← Prog.attempt "this.lifecycle .emit" [toJson "subagent.task.finished", Twin.callArg call 0] with
  | .threw error true => throw error
  | .pending => Prog.unsupported "unfinished lifecycle emit"
  | _ => return Twin.undefinedJson

private def float (value : Json) : Float :=
  (value.getNum?.toOption.map (·.toFloat)).getD 0

private def budgetExhausted (status : Json) : Bool :=
  truthy (field status "enforced") && float (field status "usedPercent") >= 100

private def admitRun (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let options := Twin.callArg call 1
  let allow := obj [("refusal", Json.null), ("warning", Json.null)]
  let status ← Prog.effect "budgetFor" [account]
  if !truthy (field status "enforced") then return allow
  if budgetExhausted status then
    return obj [("refusal", ← Prog.effect "budgetRefusal" [status]), ("warning", Json.null)]
  let now ← Prog.effect "Date.now"
  let counts := field options "count" != toJson false
  let window ← Prog.effect "currentWindow" [account, now, toJson counts]
  let started := field window "startedAt"
  if num (field window "runs") >= num (field status "runsPerMinute") then
    return obj [("refusal", obj [("kind", toJson "rate"),
        ("message", toJson s!"Rate limit reached: the {str (field status "plan")} plan admits {str (field status "runsPerMinute")} runs per minute."),
        ("limit", field status "runsPerMinute"),
        ("retryAfterSeconds", toJson (-((num now - num started - 60000) / 1000)))]),
      ("warning", Json.null)]
  if !counts then return allow
  let warning ←
    if truthy (field options "claimWarning") then Prog.effect "claimWarning" [account, status]
    else pure Json.null
  return obj [("refusal", Json.null), ("countedIn", started), ("warning", warning)]

private def assertSandboxBudget (call : Json) : Prog Json := do
  let status ← Prog.effect "budgetFor" [Twin.callArg call 0]
  if !budgetExhausted status then return Twin.undefinedJson
  let refusal ← Prog.effect "budgetRefusal" [status]
  throw (← Prog.effect "new BudgetExhaustedError" [field refusal "message"])

private def planRefusalResponse (call : Json) : Prog Json := do
  let refusal := Twin.callArg call 0
  let message := field refusal "message"
  if field refusal "kind" == toJson "budget" then
    return ← Prog.effect "errorResponse"
      [toJson (402 : Nat), message, obj [("code", toJson "budget_exhausted")]]
  let headers ← Prog.effect "rateLimitHeaders"
    [fallback (field refusal "limit") (toJson (0 : Nat)),
     fallback (field refusal "retryAfterSeconds") (toJson (1 : Nat))]
  Prog.effect "errorResponse"
    [toJson (429 : Nat), message, obj [("code", toJson "plan_limit_exceeded")], headers]

private def claimWarning (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let status := Twin.callArg call 1
  if truthy (field status "warned") || float (field status "usedPercent") < 80 then return Json.null
  Prog.setState "args.1.warned" (toJson true)
  let marked := obj (props status |>.filter (·.1 != "warned") |>.append [("warned", toJson true)])
  let _ ← Prog.effect "getStorage"
  let claimed ←
    match ← Prog.attempt "getStorage() .budgets.claimWarning" [account] with
    | .ok value => pure (truthy value)
    | .threw error true => throw error
    | .threw _ false => pure false
    | .pending => Prog.unsupported "unfinished warning claim"
  if !claimed then return Json.null
  let reached ← Prog.effect "capsReached" [field status "shares", toJson (80 : Nat)]
  let plan := str (field status "plan")
  if truthy (field reached "storage") then
    let limit ← Prog.effect "storageLimit" [marked]
    return toJson s!"This account has used 80% of its storage limit of {str limit} on the {plan} plan. Runs stop when it is full."
  return toJson s!"This account has used 80% of one of its monthly resource caps on the {plan} plan. Runs stop when a cap is reached."

private def recordUsage (call : Json) : Prog Json := do
  let _ ← Prog.effect "getStorage"
  Prog.spawn "getStorage().budgets.record"
    [Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2]
  Prog.effect "waitUntil" [Json.mkObj [("$opaque", toJson "Promise")]]

private def recordTaskUsage (call : Json) : Prog Json :=
  Prog.catchFail
    (do
      let storage ← Prog.effect "getStorage"
      if undef (field (field storage "taskUsage") "record") then return Twin.undefinedJson
      let _ ← Prog.effect "getStorage().taskUsage.record" [Twin.callArg call 0]
      return Twin.undefinedJson)
    (fun _ => pure Twin.undefinedJson)

private def hookMutableFields (event : String) : List String :=
  match event with
  | "agent.started" => ["system", "messages"]
  | "agent.finished" | "tool.result" => ["output"]
  | "agent.approval.required" => ["approve"]
  | "tool.call.started" => ["decision", "args", "denyReason"]
  | "subagent.task.finished" => ["visibleResult"]
  | "channel.message.received" => ["drop", "text", "metadata"]
  | "channel.message.sending" => ["drop", "text"]
  | _ => []

private def parseRecord (value : Json) : Prog Json :=
  Prog.effect "parseOr" [opaqueRef "ZodMiniRecord", value]

private def sanitizeHookResult (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  if !truthy (← Prog.effect "isHookMutableEvent" [event]) then return Twin.undefinedJson
  let returned ← parseRecord (Twin.callArg call 1)
  if !truthy returned then return Twin.undefinedJson
  let serialized ← Prog.effect "safeStringify" [returned]
  if undef serialized then return Twin.undefinedJson
  match serialized with
  | .str body =>
    let limit := num (fallback (Twin.callArg call 2) (toJson (0 : Nat))) + 131072
    if (body.utf8ByteSize : Int) > limit then
      return ← Prog.throwError "Error" s!"code hook return exceeds {limit} bytes"
    let kept := (hookMutableFields (text event)).filterMap fun key =>
      if undef (field returned key) then none else some (key, field returned key)
    return if kept.isEmpty then Twin.undefinedJson else obj kept
  | _ => Prog.unsupported "the serialized result was too big to record"

private def sanitizeHookState (call : Json) : Prog Json := do
  let fallbackState := Twin.callArg call 1
  let parsed ← parseRecord (Twin.callArg call 0)
  if !truthy parsed then return fallbackState
  if (props parsed).isEmpty then return parsed
  let serialized ← Prog.effect "safeStringify" [parsed]
  match serialized with
  | .str body => return if body.utf8ByteSize > 131072 then fallbackState else parsed
  | _ => if undef serialized then return fallbackState else Prog.unsupported "state too big to record"

private def stringBytes (value : String) : Nat :=
  value.toList.foldl (fun total c =>
    total + (if c == '"' || c == '\\' || [8, 9, 10, 12, 13].contains c.toNat then 2
      else if c.toNat < 32 then 6 else c.utf8Size)) 2

/-- Byte length of `JSON.stringify(value)`, which key order cannot change. -/
private def jsonBytes : Nat → Json → Option Nat
  | 0, _ => none
  | fuel + 1, value =>
    let skipped := fun (item : Json) => undef item || !undef (field item "$fn")
    match value with
    | .str s => some (stringBytes s)
    | .arr xs => do
      let sizes ← xs.toList.mapM fun x => if skipped x then some 4 else jsonBytes fuel x
      return sizes.foldl (· + ·) 0 + 2 + (sizes.length - 1)
    | .obj _ =>
      if (props value).any (fun (k, _) => k.startsWith "$") then none else do
      let kept := (props value).filter fun (_, v) => !skipped v
      let sizes ← kept.mapM fun (k, v) => (stringBytes k + 1 + ·) <$> jsonBytes fuel v
      return sizes.foldl (· + ·) 0 + 2 + (sizes.length - 1)
    | _ => some value.compress.length

private def runCodeHook (call : Json) : Prog Json := do
  let params := Twin.callArg call 0
  let incoming := field params "state"
  let failed : Json := obj [("mutation", Twin.undefinedJson), ("state", incoming)]
  Prog.catchFail
    (do
      let payload ← Prog.effect "createHookRunnerPayload" [params]
      let raw ← Prog.effect "runForResult" [field params "accountId", payload]
      match jsonBytes 128 (field params "payload") with
      | none => Prog.unsupported "payload holds a value the recorder tagged"
      | some size =>
        let mutation ← Prog.effect "sanitizeHookResult"
          [field params "event", field raw "result", toJson size]
        let state ← Prog.effect "sanitizeHookState" [field raw "state", incoming]
        return obj [("mutation", mutation), ("state", state)])
    (fun error =>
      if !undef (field error "$unsupported") then throw error else pure failed)

private def stripReasoningFromMessages (call : Json) : Prog Json :=
  Prog.effect "pruneMessages"
    [obj [("messages", Twin.callArg call 0), ("reasoning", toJson "all"), ("emptyMessages", toJson "remove")]]

private def anyToolImage (values : List Json) : Prog Bool := do
  for item in values do
    if !(items (← Prog.effect "toolImage" [item])).isEmpty then return true
  return false

private def carriesImages (messages : List Json) (before : Int) : Prog Bool := do
  for (message, index) in messages.zipIdx do
    if (index : Int) < before && field message "role" == toJson "tool" then
      for part in items (field message "content") do
        if field part "type" == toJson "tool-result" && field (field part "output") "type" == toJson "content" then
          if ← anyToolImage (items (field (field part "output") "value")) then return true
  return false

private def withToolImagesKept (call : Json) : Prog Json := do
  let original := Twin.callArg call 0
  let messages := items original
  let before := num (Twin.callArg call 1)
  if !(← carriesImages messages before) then return original
  let mut out : List Json := []
  for (message, index) in messages.zipIdx do
    if field message "role" != toJson "tool" || (index : Int) >= before then
      out := out ++ [message]
    else
      let contentItems ← Prog.effect "toolContentItems" [message]
      -- `flatMap(toolImage)` passes the helper by reference, so it is not an effect here.
      let images := (items contentItems).flatMap fun item => items (toolImage (.arr #[item]))
      out := out ++ [message]
      if !images.isEmpty then
        out := out ++ [obj [("role", toJson "user"), ("content", toJson
          (obj [("type", toJson "text"), ("text", toJson "Images a tool returned earlier:")] :: images))]]
  return toJson out

private def pruneSessionMessages (call : Json) : Prog Json := do
  let messages := Twin.callArg call 0
  let config := Twin.callArg call 1
  let approvalResume := truthy (← Prog.effect "hasPendingToolApprovalResponse" [messages])
  let retains := truthy (← Prog.effect "retainsReasoningParts" [config])
  let model ←
    if approvalResume || retains then pure messages
    else Prog.effect "stripReasoningFromMessages" [messages]
  let kept : Int := if approvalResume then 2 else 1
  if field (field (field config "session") "pruning") "enabled" == toJson false then return model
  let input ←
    if retains then pure model
    else Prog.effect "withToolImagesKept" [model, toJson ((items model).length - kept)]
  Prog.effect "pruneMessages"
    [obj [("messages", input), ("reasoning", toJson "none"),
      ("toolCalls", toJson (if retains then "none" else s!"before-last-{kept}-messages")),
      ("emptyMessages", toJson "remove")]]

private def workspaceSandboxLimits (call : Json) : Prog Json := do
  let timeout ← Prog.effect "positiveIntegerEnv"
    [toJson "WORKSPACE_SANDBOX_DEFAULT_TIMEOUT_SECONDS", toJson (30 : Nat)]
  let output ← Prog.effect "positiveIntegerEnv"
    [toJson "WORKSPACE_SANDBOX_DEFAULT_OUTPUT_LIMIT_BYTES", toJson (65536 : Nat)]
  let limits ← Prog.effect "configPlaneLimits"
    [if undef (Twin.callArg call 0) then toJson "lambda" else Twin.callArg call 0]
  return obj ([("defaultTimeoutSeconds", timeout), ("defaultOutputLimitBytes", output)] ++ props limits)

private def normalizeCreateAccountInput (call : Json) : Prog Json := do
  let input ← parseRecord (Twin.callArg call 0)
  if !truthy input then return ← Prog.throwError "Error" "Request body must include username"
  if (props input).any (·.1 == "config") then
    return ← Prog.throwError "Error" "Agent config is created through /v1/agents"
  let username ← Prog.effect "requireString" [field input "username", toJson "username"]
  let description ← Prog.effect "optionalString" [field input "description", toJson "description"]
  return obj ([("username", username)] ++ if truthy description then [("description", description)] else [])

private def withScheduledRunContext (call : Json) : Prog Json := do
  let job := Twin.callArg call 0
  let header ← Prog.effect "scheduledRunHeader" [job, Twin.callArg call 1]
  let mut framed := false
  let mut events : List Json := []
  for event in items (field job "events") do
    if framed || field event "role" != toJson "user" then
      events := events ++ [event]
    else
      framed := true
      let content := match field event "content" with
        | .str body => toJson (text header ++ "\n\n" ++ body)
        | other => toJson (obj [("type", toJson "text"), ("text", header)] :: items other)
      events := events ++ [obj ((props event).filter (·.1 != "content") ++ [("content", content)])]
  return toJson (if framed then events else obj [("role", toJson "user"), ("content", header)] :: events)

private def moreTwins : List Twin :=
  let sub := "harness/subagents.ts"
  let limits := "harness/plan-limits.ts"
  let hooks := "harness/hook-runner.ts"
  let pruning := "harness/pruning.ts"
  [traced sub "lostResultWindows" (fun call => pure (lostResultWindows (field call "args"))),
   traced sub "pendingAdmission" (fun _ => do
     enterExecutor
     return obj [("started", opaqueRef "Promise"), ("settle", fnRef "")]),
   traced sub "SubagentCoordinator.nextStateChange" (fun _ => do
     enterExecutor
     return Twin.undefinedJson),
   traced sub "sleep" (fun call => do
     enterExecutor
     let _ ← Prog.effect "setTimeout" [fnRef "", Twin.callArg call 0]
     return Twin.undefinedJson),
   traced sub "settleLive" settleLive,
   traced sub "SubagentCoordinator.stopChildren" (fun _ => do
     let _ ← Prog.effect "this.childStop.abort"
       [Json.mkObj [("$error", Json.mkObj
         [("$class", toJson "Error"), ("name", toJson "Error"),
          ("message", toJson "Stopped by user at the model boundary"),
          ("fields", Json.mkObj [])])]]
     return Twin.undefinedJson),
   traced sub "SubagentCoordinator.enqueue" (fun call => do
     let message ← Prog.effect "completionToParentMessage" [Twin.callArg call 0]
     let before := Twin.field (Twin.self call) "outbox"
     if !undef (field before "$big") then return ← Prog.unsupported "the outbox was too big to record"
     -- Past about twenty entries the recorder keeps each one as a size marker only.
     if (items before).length ≥ 18 then return ← Prog.unsupported "the outbox outgrew the recorder's budget"
     -- The recorder keeps the message's content parts as one marker each.
     let recorded := Json.mkObj
       [("message", Json.mkObj
         [("role", field message "role"), ("dedupeKey", field message "dedupeKey"),
          ("content", Json.arr ((items (field message "content")).map fun _ =>
            Json.mkObj [("$opaque", toJson "too-deep")]).toArray)]),
        ("completion", Twin.callArg call 0)]
     Prog.setChanged "self.outbox" before (Json.arr ((items before).toArray.push recorded))
     return Twin.undefinedJson),
   traced sub "SubagentCoordinator.emitTaskFinished" emitTaskFinished,
   traced sub "SubagentCoordinator.mintedChildKey" mintedChildKey,
   pureTwin sub "subagentStatusPath" (fun args =>
     toJson s!"/v1/runs/{encodeUriComponent (str (field (Twin.arg args 0) "runId"))}"),
   traced sub "toDispatch" toDispatch,
   traced sub "reserveLive" reserveLive,
   traced sub "parentVisibleCompletion" parentVisibleCompletion,
   traced sub "completionToParentMessage" completionToParentMessage,
   traced sub "noteToParentMessage" noteToParentMessage,
   traced limits "admitRun" admitRun,
   traced limits "assertSandboxBudget" assertSandboxBudget,
   traced limits "planRefusalResponse" planRefusalResponse,
   traced limits "claimWarning" claimWarning,
   traced limits "recordUsage" recordUsage,
   traced "shared/telemetry.ts" "recordTaskUsage" recordTaskUsage,
   traced hooks "sanitizeHookResult" sanitizeHookResult,
   traced hooks "sanitizeHookState" sanitizeHookState,
   traced hooks "runCodeHook" runCodeHook,
   traced pruning "stripReasoningFromMessages" stripReasoningFromMessages,
   traced pruning "withToolImagesKept" withToolImagesKept,
   traced pruning "pruneSessionMessages" pruneSessionMessages,
   traced "shared/sandbox.ts" "workspaceSandboxLimits" workspaceSandboxLimits,
   traced "shared/domain/accounts.ts" "normalizeCreateAccountInput" normalizeCreateAccountInput,
   traced "shared/domain/cron.ts" "withScheduledRunContext" withScheduledRunContext]

private def utf16Length (value : String) : Nat :=
  value.toList.foldl (fun total c => total + if c.toNat > 65535 then 2 else 1) 0

private def summarizeBlocks (minSplit : Nat) (call : Json) : Prog Json := do
  let blocks := Twin.callArg call 0
  let requestSummary := Twin.callArg call 1
  match ← Prog.attempt "requestSummary" [blocks] with
  | .ok value => return value
  | .pending => Prog.unsupported "unfinished summary request"
  | .threw error _ =>
    let message ← Prog.effect "toErrorMessage" [error]
    if !truthy (← Prog.effect "isContextLengthError" [message]) then throw error
    let list := items blocks
    match list with
    | [block] =>
      let body := text block
      if utf16Length body < minSplit then throw error
      if body.toList.any (·.toNat > 65535) then
        return ← Prog.unsupported "halving a block with surrogate pairs"
      Prog.effect "summarizeBlocks"
        [toJson [String.ofList (body.toList.take (body.length / 2))], requestSummary]
    | _ =>
      let middle := (list.length + 1) / 2
      let older ← Prog.effect "summarizeBlocks" [toJson (list.take middle), requestSummary]
      let newer ← Prog.effect "summarizeBlocks" [toJson (list.drop middle), requestSummary]
      Prog.effect "requestSummary"
        [toJson [s!"Older part:\n{str older}", s!"Newer part:\n{str newer}"]]

private def formatMessagesForCompaction (call : Json) : Prog Json := do
  let mut out : List String := []
  for (message, index) in (items (Twin.callArg call 0)).zipIdx do
    let body ← Prog.effect "stringifyMessageContent" [field message "content"]
    out := out ++ [s!"Message {index + 1} ({str (field message "role")}):\n{str body}"]
  return toJson out

private def parseInput (value : Json) (path : String) : Prog Json :=
  Prog.effect "parseInput" [opaqueRef "ZodMiniObject", value, toJson path]

private def trimmed (value : Json) : String :=
  (text value).trimAscii.toString

private def normalizePolicyRule (call : Json) : Prog Json := do
  let index := num (Twin.callArg call 1)
  let path := s!"policy rules[{index}]"
  let allowed := Twin.callArg call 2
  let rule ← parseInput (Twin.callArg call 0) path
  for action in items (field rule "actions") do
    if !undef action && !(items allowed).contains action then
      return ← Prog.throwError "ConvexError"
        s!"{path}.actions[] must be one of: {String.intercalate ", " ((items allowed).map str)}"
    match action with
    | .str _ => pure ()
    | _ => return ← Prog.throwError "ConvexError" s!"{path}.actions[] must be strings"
  let id := trimmed (field rule "id")
  return obj ([("id", toJson (if id.isEmpty then s!"rule-{index + 1}" else id)),
      ("effect", field rule "effect"), ("actions", field rule "actions"),
      ("resources", field rule "resources")] ++
    (if undef (field rule "conditions") then [] else
      [("conditions", toJson ((items (field rule "conditions")).map fun condition =>
        obj [("attribute", toJson (trimmed (field condition "attribute"))),
          ("operator", field condition "operator"), ("value", field condition "value")]))]))

private def agentPolicyActions : List String :=
  ["agent.invoke", "tool.call", "workspace.read", "workspace.write", "workspace.exec", "subagent.run", "skill.load"]

private def normalizePolicyDocument (call : Json) : Prog Json := do
  let allowed := if undef (Twin.callArg call 1) then toJson agentPolicyActions else Twin.callArg call 1
  let document ← parseInput (Twin.callArg call 0) "policy document "
  let mut rules : List Json := []
  for (rule, index) in (items (field document "rules")).zipIdx do
    rules := rules ++ [← Prog.effect "normalizePolicyRule" [rule, toJson index, allowed]]
  return obj [("version", toJson (1 : Nat)), ("mode", field document "mode"), ("rules", toJson rules)]

private def normalizeCreatePolicyInput (call : Json) : Prog Json := do
  let input ← parseInput (Twin.callArg call 0) ""
  let description := trimmed (field input "description")
  let document ← Prog.effect "normalizePolicyDocument" [field input "document"]
  return obj ([("name", toJson (trimmed (field input "name")))] ++
    (if description.isEmpty then [] else [("description", toJson description)]) ++
    [("document", document)])

private def scheduledRunHeader (call : Json) : Prog Json := do
  let job := Twin.callArg call 0
  let schedule := field job "scheduleExpression"
  let timezone := field job "timezone"
  let zone := if truthy timezone then s!" timezone=\"{str timezone}\"" else ""
  let once ← Prog.effect "isOneTimeSchedule" [schedule]
  let cadence := if truthy once
    then "This was a one-time task: it is spent now and will not fire again."
    else "It keeps firing on this schedule until someone cancels it."
  let description := field job "description"
  let why := if truthy description then s!"Why it exists: {str description}\n" else ""
  let firedAt := isoFromMillis (num (field (Twin.callArg call 1) "$date"))
  return toJson (s!"<scheduled-task name=\"{str (field job "name")}\" schedule=\"{str schedule}\"{zone}>\n" ++
    s!"The scheduler started this run at {firedAt}. The instructions below are the ones stored when the task was set up on {str (field job "createdAt")} — nobody typed them just now, and nobody is waiting on a prompt. Carry them out, then answer in this conversation the way you normally would.\n" ++
    s!"{why}{cadence}\n" ++
    "A scheduled run has no scheduling tools at all: it cannot list, create, change, or cancel a schedule. Say what needs changing and leave it to the next person who asks.\n</scheduled-task>")

private def steeringModelMessages (call : Json) : Prog Json := do
  let kept := (items (Twin.callArg call 0)).filter fun event => field event "role" != toJson "system"
  let stripped ← Prog.effect "stripEnvelopeFieldsFromMessages" [toJson kept]
  Prog.effect "rehydrateStoredMedia" [stripped, Twin.callArg call 1, Twin.callArg call 2]

private def createConfiguredDeepAgentsAdapter (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let name ← Prog.effect "requireHarnessProviderName" [config]
  if name != toJson "anthropic" && name != toJson "vercel" then
    return ← Prog.throwError "Error" "config.harness.type deepagents requires the anthropic or vercel model provider"
  let provider ← Prog.effect "requireHarnessProviderSettings" [config, name]
  let reasoning ← Prog.effect "anthropicHarnessReasoning" [config]
  let auth ← Prog.effect "resolveAnthropicOrVercelAuthEnv" [name, provider]
  let limit ← Prog.effect "configuredMaxTurn" [config]
  Prog.effect "createDeepAgents" [obj (props reasoning ++ [("auth", auth), ("recursionLimit", limit),
    ("startupTimeoutMs", field (field config "harness") "startupTimeoutMs")])]

private def evenMoreTwins : List Twin :=
  let compaction := "harness/compaction.ts"
  let policy := "packages/convex/model/policyRules.ts#"
  [traced compaction "summarizeBlocks" (summarizeBlocks 1000),
   traced compaction "formatMessagesForCompaction" formatMessagesForCompaction,
   Twin.traced (policy ++ "normalizePolicyRule") normalizePolicyRule,
   Twin.traced (policy ++ "normalizePolicyDocument") normalizePolicyDocument,
   Twin.traced (policy ++ "normalizeCreatePolicyInput") normalizeCreatePolicyInput,
   traced "shared/domain/cron.ts" "scheduledRunHeader" scheduledRunHeader,
   traced "harness/harness.ts" "steeringModelMessages" steeringModelMessages,
   traced "harness/ai-sdk-harness/adapters/deepagents.ts" "createConfiguredDeepAgentsAdapter" createConfiguredDeepAgentsAdapter]

def twins : List Twin :=
  [traced "harness/lifecycle.ts" "toLifecycleValue" (fun call => pure (toLifecycleValue (field call "args"))),
   traced "harness/harness.ts" "serializeError" (fun call =>
     let value := serializeError (field call "args")
     if !undef (field value "unsupported") then Prog.unsupported "object error needs contextual errorMessage" else pure value),
   pureTwin "harness/compaction.ts" "shouldAutoCompact" shouldAutoCompact,
   traced "harness/hook-dispatcher.ts" "hookArgs" hookArgs,
   traced "harness/harness.ts" "harnessReadsMedia" harnessReadsMedia,
   traced "harness/harness.ts" "summarizeToolsUsed" (fun call => pure (summarizeToolsUsed (field call "args"))),
   pureTwin "harness/ai-sdk-harness/provider.ts" "warnReasoningChanged" (fun _ => Twin.undefinedJson),
   traced "harness/pruning.ts" "toolImage" (fun call => pure (toolImage (field call "args"))),
   { source := "apps/core/src/harness/ai-sdk-harness/provider.ts#requireHarnessProviderSettings", run := requireHarnessProviderSettings },
   { source := "apps/core/src/shared/domain/accounts.ts#optionalString", run := accountString false },
   { source := "apps/core/src/harness/subagents.ts#ownedGeneration", run := ownedGeneration },
   traced "harness/harness.ts" "systemTraceAttributes" systemTraceAttributes,
   traced "harness/harness.ts" "publishSpan" publishSpan,
   pureTwin "harness/pruning.ts" "hasPendingToolApprovalResponse" hasPendingToolApprovalResponse,
   pureTwin "harness/ai-sdk-harness/provider.ts" "harnessEffort" harnessEffort,
   { source := "apps/core/src/harness/ai-sdk-harness/provider.ts#requireHarnessProviderName", run := requireHarnessProviderName },
   traced "harness/hook-dispatcher.ts" "applyMessageSendingHook" applyMessageSendingHook,
   traced "harness/subagents.ts" "giveUpLostSubagentResult" giveUpLostSubagentResult,
   { source := "apps/core/src/harness/subagents.ts#requireParentAccountId", run := requireParentAccountId },
   traced "harness/subagents.ts" "rowTaskId" rowTaskId,
   traced "harness/harness.ts" "foldAgentFinished" foldAgentFinished,
   pureTwin "harness/compaction.ts" "formatInstructions" formatInstructions,
   pureTwin "harness/pruning.ts" "retainsReasoningParts" (fun args => toJson (["azure", "openai"].contains (text (field (field (Twin.arg args 0) "model") "provider")))),
   { source := "apps/core/src/shared/domain/accounts.ts#requireString", run := accountString true },
   pureTwin "harness/subagents.ts" "childAddress" (fun args => toJson s!"{str (field (Twin.arg args 0) "agentId")}/{str (field (Twin.arg args 0) "conversationKey")}"),
   pureTwin "harness/subagents.ts" "rowOutcome" rowOutcome,
   pureTwin "harness/subagents.ts" "stoppedOnPurpose" stoppedOnPurpose,
   pureTwin "harness/subagents.ts" "taskMetadata" taskMetadata,
   pureTwin "harness/subagents.ts" "userText" (fun args => obj [("role", toJson "user"), ("content", toJson [obj [("type", toJson "text"), ("text", Twin.arg args 0)]])]),
   traced "harness/harness.ts" "sessionObservabilityScope" (fun call => pure (sessionObservabilityScope (field call "args"))),
   pureTwin "harness/hook-runner.ts" "isHookMutableEvent" (fun args => toJson (["agent.started", "agent.finished", "agent.approval.required", "tool.call.started", "tool.result", "subagent.task.finished", "channel.message.received", "channel.message.sending"].contains (text (Twin.arg args 0)))),
   traced "harness/compaction.ts" "compactionSpanAttributes" compactionSpanAttributes,
   pureTwin "harness/compaction.ts" "isCompactionSummaryMessage" (fun args => toJson ((text (field (Twin.arg args 0) "content")).startsWith "<session-compaction-summary>")),
   pureTwin "harness/compaction.ts" "createCompactionSummaryMessage" createCompactionSummaryMessage,
   { source := "apps/core/src/harness/compaction.ts#stringifyMessageContent", run := fun args => match Twin.arg args 0 with | .str s => toJson s | _ => Twin.unsupported "JSON property insertion order is not retained by Lean Json" },
   pureTwin "harness/ai-sdk-harness/provider.ts" "resolveHarnessProviderBaseUrl" (fun args => fallback (field (Twin.arg args 0) "base_url") (field (Twin.arg args 0) "baseURL")),
   pureTwin "shared/sandbox.ts" "resolveSandboxLifecycle" resolveSandboxLifecycle,
   pureTwin "shared/sandbox.ts" "workspaceNamespacePrefix" (fun args => Twin.arg args 0),
   pureTwin "harness/ai-sdk-harness/adapters/index.ts" "harnessSteersMidTurn" (fun args => toJson (["claude-code", "codex", "opencode", "pi"].contains (text (Twin.arg args 0)))),
   pureTwin "harness/ai-sdk-harness/adapters/index.ts" "harnessSessionParking" (fun args => toJson (if Twin.arg args 0 == toJson "deepagents" then "detach" else "stop")),
   pureTwin "harness/ai-sdk-harness/adapters/index.ts" "harnessSharesSandbox" (fun args => toJson (Twin.arg args 0 == toJson "pi")),
   pureTwin "harness/ai-sdk-harness/adapters/index.ts" "harnessTextBeforeImages" (fun args => toJson (Twin.arg args 0 == toJson "pi")),
   plain "packages/convex/model/subagentResults.ts#asyncToolResultDedupeKey" (fun args => toJson s!"async-tool:{str (Twin.arg args 0)}:{str (Twin.arg args 1)}"),
   plain "packages/convex/model/subagentResults.ts#subagentResultDedupeKey" (fun args => toJson s!"subagent:{str (Twin.arg args 0)}:{str (Twin.arg args 1)}"),
   traced "harness/ai-sdk-harness/provider.ts" "resolveAnthropicAuthEnv" (resolveAuthEnv "anthropic"),
   traced "harness/ai-sdk-harness/provider.ts" "resolveGatewayAuthEnv" (resolveAuthEnv "gateway"),
   traced "harness/ai-sdk-harness/provider.ts" "resolveOpenAiAuthEnv" (resolveAuthEnv "openai"),
   traced "shared/domain/accounts.ts" "hashAccountSecret" cryptoHash,
   traced "shared/webhook.ts" "createWebhookSignature" createWebhookSignature,
   traced "harness/subagents.ts" "noteNonce" noteNonce,
   traced "shared/sandbox.ts" "positiveIntegerEnv" positiveIntegerEnv,
   traced "shared/sandbox.ts" "outlivedMaxLifetime" outlivedMaxLifetime,
   traced "harness/ai-sdk-harness/provider.ts" "resolveAnthropicOrVercelAuthEnv" resolveAnthropicOrVercelAuthEnv,
   traced "harness/ai-sdk-harness/provider.ts" "anthropicHarnessReasoning" anthropicHarnessReasoning,
   traced "harness/harness.ts" "applyHarnessSteeringBeforeTurn" (fun call => applySteering 256 (Twin.callArg call 0) (Twin.callArg call 1) (Twin.callArg call 2) 0),
   traced "harness/hook-dispatcher.ts" "createAgentHookDispatcher" createAgentHookDispatcher,
   traced "shared/domain/cron.ts" "normalizeUpdateCronInput" (fun call => Prog.effect "normalizeUpdateCronInputRule" [Twin.callArg call 0]) ] ++ moreTwins ++ evenMoreTwins

end Spec.Agent.Waveagent2
