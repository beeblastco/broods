import Spec.Agent.Twins.Loop.Provider
import Spec.Agent.Model

/-!
Twins of `harness.ts`, `usage-metering.ts` and `plan-limits.ts`: prompt shaping and token totals.
-/

namespace Spec.Agent

open Lean Js

private def isRole (message : Json) (role : String) : Bool :=
  get message "role" == .str role

/-- `extractText` on a user message's content. -/
def extractText (content : Json) : String :=
  match content with
  | .str text => text
  | other =>
    String.join (((items other).filter fun part => get part "type" == .str "text").map
      fun part => template (get part "text"))

/-- `harnessPromptMessages`: none when a media part needs the SDK's capability check. -/
def harnessPromptMessages (messages : List Json) (environment : String) :
    Except String (Option (List Json)) :=
  match messages.getLast? with
  | some last =>
    if isRole last "tool" then
      match lastIndexWhere (fun message => isRole message "assistant") messages.dropLast with
      | some index => .ok (some [messages.getD index .null, last])
      | none => .ok (some [last])
    else fromUsers
  | none => fromUsers
where
  fromUsers : Except String (Option (List Json)) :=
    let afterAssistant :=
      match lastIndexWhere (fun message => isRole message "assistant") messages with
      | some index => messages.drop (index + 1)
      | none => messages
    let users := afterAssistant.filter fun message => isRole message "user"
    if users.isEmpty then
      .error "AI SDK Harness turn requires a new user message or an unfinished tool continuation"
    else
      let content := users.flatMap fun message =>
        match get message "content" with
        | .str text => [Json.mkObj [("type", "text"), ("text", .str text)]]
        | other => items other
      if content.any fun part => get part "type" != .str "text" then .ok none
      else
        .ok (some [Json.mkObj [("role", "user"), ("content", .arr
          (content ++ [Json.mkObj [("type", "text"), ("text", toJson environment)]]).toArray)]])

/-- `toToolCallPart`. -/
def toToolCallPart (toolCall : Json) : Json :=
  Json.mkObj ([("type", .str "tool-call")] ++ copied toolCall "toolCallId" ++
    copied toolCall "toolName" ++ copied toolCall "input")

/-- `withApprovalToolCalls`: an approval request gets its tool call in front, once per id. -/
def withApprovalToolCalls (messages approvalRequests : List Json) : List Json :=
  let calls := approvalRequests.map fun request => get request "toolCall"
  let lookup (id : Json) : Option Json :=
    calls.reverse.find? fun call => get call "toolCallId" == id
  messages.map fun message =>
    if !isRole message "assistant" || !isArr (get message "content") then message
    else
      let parts := items (get message "content")
      let existing := (parts.filter fun part => get part "type" == .str "tool-call").map
        fun part => get part "toolCallId"
      let step (state : List Json × List Json) (part : Json) : List Json × List Json :=
        let id := get part "toolCallId"
        if get part "type" != .str "tool-approval-request" || state.fst.contains id then
          (state.fst, state.snd ++ [part])
        else
          match lookup id with
          | none => (state.fst, state.snd ++ [part])
          | some call => (id :: state.fst, state.snd ++ [toToolCallPart call, part])
      spread message [("content", .arr (parts.foldl step (existing, [])).snd.toArray)]

/-- `Math.round(length * 3 / 4 / 1024)`. -/
private def base64KiloBytes (units : Nat) : Nat :=
  (units * 3 + 2048) / 4096

/-- `toolOutputWithoutMediaBytes`: base64 media reads as a short note. -/
def toolOutputWithoutMediaBytes (output : Json) : Json :=
  if get output "type" != .str "content" then output
  else
    spread output [("value", .arr ((items (get output "value")).map fun part =>
      if get part "type" == .str "image-data" || get part "type" == .str "file-data" then
        let size := base64KiloBytes (length ((str? (get part "data")).getD ""))
        spread part [("data", toJson s!"[{template (get part "mediaType")} base64, {size} KB]")]
      else part).toArray)]

/-- `messagesWithoutMediaBytes`. Byte arrays cannot be recorded, so only tool output changes. -/
def messagesWithoutMediaBytes (messages : List Json) : List Json :=
  messages.map fun message =>
    if !isRole message "tool" then message
    else
      spread message [("content", .arr ((items (get message "content")).map fun part =>
        if get part "type" == .str "tool-result" then
          spread part [("output", toolOutputWithoutMediaBytes (get part "output"))]
        else part).toArray)]

/-- `usageTokenTotals`. -/
def usageTokenTotals (usage : Json) : Json :=
  let orZero (value : Json) : Json := if value == .null then nat 0 else value
  Json.mkObj [
    ("inputTokens", orZero (get usage "inputTokens")),
    ("outputTokens", orZero (get usage "outputTokens")),
    ("reasoningTokens", orZero (get (get usage "outputTokenDetails") "reasoningTokens")),
    ("cachedInputTokens", orZero (get (get usage "inputTokenDetails") "cacheReadTokens")),
    ("cacheWriteTokens", orZero (get (get usage "inputTokenDetails") "cacheWriteTokens")),
    ("totalTokens", orZero (get usage "totalTokens"))]

private def tokenFields : List String :=
  ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteTokens",
    "totalTokens"]

/-- `addUsageTokenTotals` on whole token counts. -/
def addUsageTokenTotals (a b : Json) : Option Json :=
  (tokenFields.mapM fun name =>
    match intOf? (get a name), intOf? (get b name) with
    | some x, some y => some (name, Json.num ⟨x + y, 0⟩)
    | _, _ => none).map Json.mkObj

/-- `extractCacheWriteTokens`: the provider's own field, then Bedrock's two nestings. -/
def extractCacheWriteTokens (providerName metadata : Json) : Json :=
  match providerName with
  | .str name =>
    if !truthy metadata || name.isEmpty then nat 0
    else
      let provider := canonicalProvider name
      if provider != "anthropic" && provider != "bedrock" then nat 0
      else
        let field := "cacheCreationInputTokens"
        let positive (value : Json) : Option Json :=
          match value with
          | .num number => if numPositive number then some value else none
          | _ => none
        let bedrock := if provider == "bedrock" then get metadata "bedrock" else .null
        let found := (positive (get (get metadata provider) field)) <|>
          (if truthy bedrock then
            (positive (get (get bedrock "anthropic") field)) <|> (positive (get bedrock field))
           else none)
        found.getD (nat 0)
  | _ => nat 0

/-- `capsReached`, on exact decimals. -/
def capsReachedDecimal (shares : Json) (percent : JsonNumber) : Option (Bool × Bool) :=
  let share (name : String) : Option JsonNumber := num? (get shares name)
  match share "storageGb", share "sandboxHours", share "hostedMcpHours", share "egressGb" with
  | some storage, some sandbox, some mcp, some egress =>
    some (numGe storage percent, numGe sandbox percent || numGe mcp percent || numGe egress percent)
  | _, _, _, _ => none

/-- `storageLimit`, from `PLAN_LIMITS`. -/
def storageLimit (plan : Json) : Option String :=
  match plan with
  | .str "free" => some "10 GB of workspaces and files"
  | .str "pro" => some "50 GB of workspaces and files"
  | _ => none

/-- `budgetRefusal`. -/
def budgetRefusal (status : Json) : Option Json := do
  let reached ← capsReachedDecimal (get status "shares") ⟨100, 0⟩
  let limit ← storageLimit (get status "plan")
  let plan := template (get status "plan")
  let storage := "its storage limit of " ++ limit
  let monthly := s!"one of its monthly resource caps for {template (get status "month")}"
  let canUpgrade := plan == "free"
  let message :=
    if !reached.fst then
      s!"This account has reached {monthly} on the {plan} plan. Upgrade to keep running agents, or wait for next month."
    else if reached.snd then
      s!"This account has reached {storage} and {monthly} on the {plan} plan. Delete files, then {if canUpgrade then "upgrade or " else ""}wait for next month, to keep running agents; storage is measured once a day."
    else
      s!"This account has reached {storage} on the {plan} plan. Delete files{if canUpgrade then " or upgrade" else ""} to keep running agents; storage is measured once a day."
  return Json.mkObj [("kind", "budget"), ("message", toJson message)]

/-- The harness, metering and plan twins. -/
def harnessTwinList : List Spec.Twin := [
  { source := "apps/core/src/harness/harness.ts#harnessPromptMessages"
    run := fun args =>
      match Twin.arg args 1 with
      | .str environment =>
        match harnessPromptMessages (items (Twin.arg args 0)) environment with
        | .error message => Twin.threw message
        | .ok (some result) => .arr result.toArray
        | .ok none => Twin.unsupported "media support is the SDK's check"
      | _ => Twin.unsupported "environment is not a string" },
  { source := "apps/core/src/harness/harness.ts#withEnvironment"
    run := fun args =>
      match Twin.arg args 1 with
      | .str environment =>
        .arr (withEnvironment (items (Twin.arg args 0)) environment (Twin.arg args 2)).toArray
      | _ => Twin.unsupported "environment is not a string" },
  { source := "apps/core/src/harness/harness.ts#withApprovalToolCalls"
    run := fun args =>
      .arr (withApprovalToolCalls (items (Twin.arg args 0)) (items (Twin.arg args 1))).toArray },
  { source := "apps/core/src/harness/harness.ts#messagesWithoutMediaBytes"
    run := fun args => .arr (messagesWithoutMediaBytes (items (Twin.arg args 0))).toArray },
  { source := "apps/core/src/harness/harness.ts#toolOutputWithoutMediaBytes"
    run := fun args => toolOutputWithoutMediaBytes (Twin.arg args 0) },
  { source := "apps/core/src/harness/harness.ts#outputWithoutMediaBytes"
    run := fun args =>
      let output := Twin.arg args 0
      -- Only a content output changes; any other returns as it came, parsed or not.
      let media := (items (get output "value")).any fun part =>
        get part "type" == .str "image-data" || get part "type" == .str "file-data"
      if get output "type" == .str "content" && media then
        Twin.unsupported "whether media parts parse is the SDK's schema"
      else output },
  { source := "apps/core/src/harness/harness.ts#extractApprovalRequests"
    run := fun args =>
      .arr ((items (Twin.arg args 0)).flatMap fun step =>
        (items (get step "content")).filter fun part =>
          get part "type" == .str "tool-approval-request").toArray },
  { source := "apps/core/src/harness/harness.ts#summarizeApprovalRequest"
    run := fun args =>
      let request := Twin.arg args 0
      let call := get request "toolCall"
      Json.mkObj (copied request "approvalId" ++ copied call "toolCallId" ++
        copied call "toolName" ++ copied call "input") },
  { source := "apps/core/src/harness/harness.ts#toToolCallPart"
    run := fun args => toToolCallPart (Twin.arg args 0) },
  { source := "apps/core/src/harness/harness.ts#toolSpanDurationMs"
    run := fun args =>
      match Twin.arg args 2 with
      | .num execution =>
        if execution.mantissa < 0 then nat 0 else .num execution
      | _ =>
        match intOf? (Twin.arg args 0), intOf? (Twin.arg args 1) with
        | some start, some now => .num ⟨max 0 (now - start), 0⟩
        | _, _ => Twin.unsupported "times are not whole numbers" },
  { source := "apps/core/src/harness/harness.ts#toolOutputErrorText"
    run := fun args =>
      let output := Twin.arg args 0
      match get output "type", get output "value" with
      | .str "error-text", .str value => .str value
      | _, _ => .null },
  { source := "apps/core/src/harness/harness.ts#latestUserText"
    run := fun args =>
      match (items (Twin.arg args 0)).reverse.find? (fun message => isRole message "user") with
      | some message => toJson (trim (extractText (get message "content")))
      | none => toJson "" },
  { source := "apps/core/src/harness/harness.ts#formatUsageSummary"
    run := fun args =>
      let totals := usageTokenTotals (Twin.arg args 0)
      toJson s!"{template (get totals "inputTokens")} in / {template (get totals "outputTokens")} out / {template (get totals "totalTokens")} total token(s)" },
  { source := "apps/core/src/harness/harness.ts#formatDuration"
    run := fun args =>
      match Twin.arg args 0 with
      | .num duration => toJson (numText duration ++ "ms")
      | _ => toJson "unknown duration" },
  { source := "apps/core/src/harness/usage-metering.ts#usageTokenTotals"
    run := fun args => usageTokenTotals (Twin.arg args 0) },
  { source := "apps/core/src/harness/usage-metering.ts#addUsageTokenTotals"
    run := fun args =>
      match addUsageTokenTotals (Twin.arg args 0) (Twin.arg args 1) with
      | some total => total
      | none => Twin.unsupported "token counts are not whole numbers" },
  { source := "apps/core/src/harness/usage-metering.ts#modelTokenAttributes"
    run := fun args =>
      let tokens := Twin.arg args 0
      Json.mkObj [
        ("model.input_tokens", get tokens "inputTokens"),
        ("model.output_tokens", get tokens "outputTokens"),
        ("model.reasoning_tokens", get tokens "reasoningTokens"),
        ("model.cached_input_tokens", get tokens "cachedInputTokens"),
        ("model.cache_write_tokens", get tokens "cacheWriteTokens"),
        ("model.total_tokens", get tokens "totalTokens")] },
  { source := "apps/core/src/harness/usage-metering.ts#extractCacheWriteTokens"
    run := fun args => extractCacheWriteTokens (Twin.arg args 0) (Twin.arg args 1) },
  { source := "apps/core/src/harness/usage-metering.ts#windowMs"
    run := fun args =>
      let window := Twin.arg args 0
      if window == .null then .null
      else
        match intOf? (get window "first"), intOf? (get window "last") with
        | some first, some last => .num ⟨max 0 (last - first), 0⟩
        | _, _ => Twin.unsupported "window times are not whole numbers" },
  { source := "packages/convex/model/modelPricing.ts#canonicalModelProvider"
    run := fun args =>
      match Twin.arg args 0 with
      | .str provider => toJson (canonicalProvider provider)
      | _ => Twin.unsupported "provider is not a string" },
  { source := "packages/convex/model/planLimits.ts#capsReached"
    run := fun args =>
      let percent := (num? (Twin.arg args 1)).getD ⟨100, 0⟩
      match capsReachedDecimal (Twin.arg args 0) percent with
      | some (storage, monthly) =>
        Json.mkObj [("storage", toJson storage), ("monthly", toJson monthly)]
      | none => Twin.unsupported "shares are not numbers" },
  { source := "apps/core/src/harness/plan-limits.ts#storageLimit"
    run := fun args =>
      match storageLimit (get (Twin.arg args 0) "plan") with
      | some limit => toJson limit
      | none => Twin.unsupported "plan is not one of PLAN_LIMITS" },
  { source := "apps/core/src/harness/plan-limits.ts#budgetRefusal"
    run := fun args =>
      match budgetRefusal (Twin.arg args 0) with
      | some refusal => refusal
      | none => Twin.unsupported "status has no plan or shares" },
  { source := "apps/core/src/harness/plan-limits.ts#planRefusalText"
    run := fun args =>
      let refusal := Twin.arg args 0
      let message := template (get refusal "message")
      if has refusal "retryAfterSeconds" then
        toJson s!"{message} Try again in {template (get refusal "retryAfterSeconds")} seconds."
      else toJson message }]

end Spec.Agent
