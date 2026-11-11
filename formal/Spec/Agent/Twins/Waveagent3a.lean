import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign3/agent3a.tsv`.
-/

namespace Spec.Agent.Waveagent3a

open Lean Spec

private def field (v : Json) (k : String) : Json :=
  (v.getObjVal? k).toOption.getD Twin.undefinedJson

private def str (v : Json) : String := v.getStr?.toOption.getD ""
private def arr (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def undef (v : Json) : Bool := v == Twin.undefinedJson
private def truth (v : Json) : Bool :=
  !(undef v || v == Json.null || v == toJson false || v == toJson (0 : Nat) || v == toJson "")
private def obj (xs : List (String × Json)) : Json :=
  Json.mkObj (xs.filter fun p => !undef p.2)
private def num (v : Json) : Float :=
  match v.getNum? with
  | .ok n => n.toFloat
  | _ => 0
private def isBig (v : Json) : Bool := (v.getObjVal? "$big").toOption.isSome

/-- `Object.entries` order: the recorded `$keys`, else the sorted keys the recorder left implicit. -/
private def entries (v : Json) : List (String × Json) :=
  match v with
  | .obj kvs =>
    let order : List String := match v.getObjVal? "$keys" with
      | .ok (.arr keys) => keys.toList.filterMap fun key => key.getStr?.toOption
      | _ => kvs.toList.map (·.1)
    order.filterMap fun key =>
      if key == "$keys" || key == "$fields" then none
      else (v.getObjVal? key).toOption.map fun item => (key, item)
  | _ => []

/-- `Map.get` on a recorded `{"$map": [[key, value], ...]}`. -/
private def mapGet (m : Json) (key : Json) : Option Json :=
  ((arr (field m "$map")).find? fun pair => Twin.arg pair 0 == key).map fun pair => Twin.arg pair 1

private def mapSet (m key value : Json) : Json :=
  let pairs := arr (field m "$map")
  let pair := Json.arr #[key, value]
  let next := if pairs.any (fun p => Twin.arg p 0 == key) then
    pairs.map (fun p => if Twin.arg p 0 == key then pair else p)
    else pairs ++ [pair]
  Json.mkObj [("$map", Json.arr next.toArray)]

/-- The spread `{...base, ...over}`, for records whose keys are compared sorted. -/
private def spread (base over : Json) : Json :=
  let later := entries over
  obj ((entries base).filter (fun p => !later.any (·.1 == p.1)) ++ later)

private def dedupe (xs : List Json) : List Json :=
  (xs.foldl (fun seen x => if seen.contains x then seen else x :: seen) []).reverse

private def windowMs : Float := 60000

/-- `currentWindow`: reuses an account's window while it is younger than a minute. -/
private def currentWindow (call : Json) : Prog Json := do
  let now := Twin.callArg call 1
  match mapGet (Twin.moduleValue call "windows") (Twin.callArg call 0) with
  | some existing =>
    if num now - num (field existing "startedAt") < windowMs then
      return existing
  | none => pure ()
  let fresh := obj [("startedAt", now), ("runs", toJson (0 : Nat))]
  if truth (Twin.callArg call 2) then
    Prog.setState "module.windows"
      (mapSet (Twin.moduleValue call "windows") (Twin.callArg call 0) fresh)
  return fresh

/-- The capture of `/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/`. -/
private def frontmatterCapture (markdown : String) : Option String :=
  let closes (rest : List Char) : Bool :=
    let afterBreak := match rest with
      | '\r' :: '\n' :: tail => some tail
      | '\n' :: tail => some tail
      | _ => none
    match afterBreak with
    | some ('-' :: '-' :: '-' :: tail) =>
      match tail with
      | [] | '\n' :: _ | '\r' :: '\n' :: _ => true
      | _ => false
    | _ => false
  let rec scan (rest taken : List Char) : Option String :=
    if closes rest then some (String.ofList taken.reverse)
    else match rest with
      | [] => none
      | c :: tail => scan tail (c :: taken)
  let body := match markdown.toList with
    | '-' :: '-' :: '-' :: '\r' :: '\n' :: tail => some tail
    | '-' :: '-' :: '-' :: '\n' :: tail => some tail
    | _ => none
  body.bind fun rest => scan rest []

private def parseSkillMarkdown (call : Json) : Prog Json := do
  let markdown := Twin.callArg call 0
  if isBig markdown then
    return ← Prog.unsupported "markdown too big to record"
  match frontmatterCapture (str markdown) with
  | none | some "" => Prog.throwError "Error" "SKILL.md must start with YAML frontmatter"
  | some capture =>
    let frontmatter ← Prog.effect "parseSimpleYamlFrontmatter" [toJson capture]
    let name := field frontmatter "name"
    let description := field frontmatter "description"
    let _ ← Prog.effect "validateSkillName" [name]
    let _ ← Prog.effect "validateSkillDescription" [description]
    return obj [("name", name), ("description", description)]

private def base64Value (c : Char) : Option Nat :=
  if 'A' ≤ c && c ≤ 'Z' then some (c.toNat - 'A'.toNat)
  else if 'a' ≤ c && c ≤ 'z' then some (c.toNat - 'a'.toNat + 26)
  else if '0' ≤ c && c ≤ '9' then some (c.toNat - '0'.toNat + 52)
  else if c == '+' then some 62
  else if c == '/' then some 63
  else none

/-- Whether base64 text decodes to bytes containing a zero. -/
private def base64HasZero (text : String) : Bool :=
  let sextets := text.toList.filterMap base64Value
  let rec go : List Nat → Bool
    | a :: b :: c :: d :: tail =>
      (a * 4 + b / 16) == 0 || ((b % 16) * 16 + c / 4) == 0 ||
        ((c % 4) * 64 + d) == 0 || go tail
    | [a, b, c] => (a * 4 + b / 16) == 0 || ((b % 16) * 16 + c / 4) == 0
    | [a, b] => (a * 4 + b / 16) == 0
    | _ => false
  go sextets

private def isSupportedTextFile (call : Json) : Prog Json := do
  let extension ← Prog.effect "path.extname" [Twin.callArg call 0]
  let allowed := arr (field (Twin.moduleValue call "TEXT_EXTENSIONS") "$set")
  if !allowed.contains (toJson (str extension).toLower) then
    return toJson false
  let bytes := field (Twin.callArg call 1) "$bytes"
  if undef bytes then
    return ← Prog.unsupported "bytes not recorded"
  return toJson (!base64HasZero (str bytes))

private def budgetTtlMs : Float := 30000

/-- `budgetFor`: a live cache entry wins, and any failure admits by answering null. -/
private def budgetFor (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  if let some cached := mapGet (Twin.moduleValue call "budgets") accountId then
    let now ← Prog.effect "Date.now"
    if num (field cached "expiresAt") > num now then
      return field cached "status"
  Prog.catchFail
    (do
      let storage ← Prog.effect "getStorage"
      if undef (field (field storage "budgets") "get") then
        return ← Prog.throwError "TypeError" "storage has no budgets.get"
      let status ← Prog.effect "getStorage().budgets.get" [accountId]
      let now ← Prog.effect "Date.now"
      let expiresAt := toJson (num now + budgetTtlMs)
      Prog.setState "module.budgets" (mapSet (Twin.moduleValue call "budgets") accountId
        (obj [("status", status), ("expiresAt", expiresAt)]))
      return status)
    (fun _ => pure Json.null)

private def maxConfiguredSkills : Nat := 32

private def ownedSkillPaths (call : Json) : Prog Json := do
  let used := (dedupe (arr (Twin.callArg call 1))).take maxConfiguredSkills
  for skillPath in used do
    let _ ← Prog.effect "parseOwnedSkillPath" [Twin.callArg call 0, skillPath]
  return .arr used.toArray

private def piTrim (call : Json) : Prog Json := do
  let result ← Prog.effect "truncateText" [Twin.callArg call 0, toJson (32768 : Nat)]
  return field result "value"

private def trimMediaPart (call : Json) : Prog Json := do
  let part := Twin.callArg call 0
  if field part "type" == toJson "image" then
    return obj [("type", toJson "text"), ("text", toJson "[attachment not retained]")]
  let text ← Prog.effect "trim" [field part "text"]
  return spread part (obj [("text", text)])

private def hookArgs (call : Json) : Prog Json := do
  let schema ← Prog.effect "asSchema" [field (Twin.callArg call 0) "inputSchema"]
  if undef (field schema "validate") then
    return Twin.callArg call 2
  let result ← Prog.effect "validate" [Twin.callArg call 2]
  if !truth (field result "success") then
    let body := field (field result "error") "$error"
    if undef (field body "message") then
      return ← Prog.unsupported "ZodError.message is an accessor the recorder does not read"
    let message := str (field body "message")
    return ← Prog.throwError "Error"
      s!"Tool \"{str (Twin.callArg call 1)}\" got invalid args from hook: {message}"
  return field result "value"

private def planRefusalResponse (call : Json) : Prog Json := do
  let refusal := Twin.callArg call 0
  let message := field refusal "message"
  if field refusal "kind" == toJson "budget" then
    return ← Prog.effect "errorResponse"
      [toJson (402 : Nat), message, obj [("code", toJson "budget_exhausted")]]
  let orElse (v d : Json) : Json := if undef v || v == Json.null then d else v
  let headers ← Prog.effect "rateLimitHeaders"
    [orElse (field refusal "limit") (toJson (0 : Nat)),
     orElse (field refusal "retryAfterSeconds") (toJson (1 : Nat))]
  Prog.effect "errorResponse"
    [toJson (429 : Nat), message, obj [("code", toJson "plan_limit_exceeded")], headers]

private def listConfiguredSkillMetadata (call : Json) : Prog Json := do
  let skills := field (Twin.callArg call 1) "skills"
  if field skills "enabled" != toJson true || !truth (Twin.callArg call 0) then
    return .arr #[]
  let allowed := field skills "allowed"
  Prog.effect "listSkillMetadataForConfig"
    [Twin.callArg call 0, if undef allowed || allowed == Json.null then .arr #[] else allowed]

private def toChannelRuntimeAgentConfig (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let runtime ← Prog.effect "toRuntimeAgentConfig" [config]
  let channels := field config "channels"
  if !truth (field channels (str (Twin.callArg call 1))) then
    return runtime
  return spread runtime (obj [("channels", channels)])

private def channelPartitionOf (call : Json) : Prog Json := do
  let channel := field (field (Twin.callArg call 0) "channels") (str (Twin.callArg call 1))
  let parsed ← Prog.effect "parseOr" [Json.mkObj [("$opaque", toJson "ZodMiniObject")], channel]
  return field parsed "partition"

/-- A float as JSON. Only integral values have a text that surely equals the JavaScript one. -/
private def integral (x : Float) : Option Json :=
  if x.floor == x && x.abs < 9007199254740992 then
    some (toJson x.toInt64.toInt)
  else
    none

/-- `estimateModelTokenCost`, over results that stay integral. -/
private def estimateModelTokenCost (call : Json) : Prog Json := do
  let rates := Twin.callArg call 0
  let usage := Twin.callArg call 1
  if !truth rates then
    return Json.null
  let cached := num (field usage "cachedInputTokens")
  let written := num (field usage "cacheWriteTokens")
  let charge (tokens : Float) (rate : String) : Float :=
    tokens * num (field rates rate) / 1000000
  let uncached := max 0 (num (field usage "inputTokens") - cached - written)
  let input := charge uncached "input"
  let output := charge (num (field usage "outputTokens")) "output"
  let cacheRead := charge cached "cacheRead"
  let cacheWrite := charge written "cacheWrite"
  match integral input, integral output, integral cacheRead, integral cacheWrite,
      integral (input + output + cacheRead + cacheWrite) with
  | some a, some b, some c, some d, some e =>
    return obj [("input", a), ("output", b), ("cacheRead", c), ("cacheWrite", d), ("total", e)]
  | _, _, _, _, _ => Prog.unsupported "non-integral cost"

private def normalizeModelId (call : Json) : Prog Json :=
  pure (toJson (str (Twin.callArg call 0)).toLower)

/-- Drops a trailing `-YYYYMMDD` or `-YYYY-MM-DD`. -/
private def undatedModelId (id : String) : String :=
  let chars := id.toList.reverse
  let digits (xs : List Char) : Bool := xs.all Char.isDigit
  let short := chars.take 8
  let long := chars.take 10
  if chars.length ≥ 9 && short.length == 8 && digits short && chars.getD 8 ' ' == '-' then
    String.ofList (chars.drop 9).reverse
  else if chars.length ≥ 11 && digits (long.take 2) && long.getD 2 ' ' == '-' &&
      digits ((long.drop 3).take 2) && long.getD 5 ' ' == '-' && digits (long.drop 6) &&
      chars.getD 10 ' ' == '-' then
    String.ofList (chars.drop 11).reverse
  else id

private def priceLookupIds (call : Json) : Prog Json := do
  let exact ← Prog.effect "normalizeModelId" [Twin.callArg call 0]
  let undated := undatedModelId (str exact)
  return if undated == str exact then .arr #[exact] else .arr #[exact, toJson undated]

/-- The keys of `MODEL_PROVIDERS` in `packages/convex/model/modelProviders.ts`. -/
private def modelProviders : List String :=
  ["alibaba", "anthropic", "azure", "baseten", "bedrock", "cerebras", "chatgpt", "cloudflare",
   "cohere", "custom", "deepinfra", "deepseek", "fireworks", "google", "groq", "huggingface",
   "llmgateway", "minimax", "mistral", "moonshotai", "ollama", "openai", "openrouter", "perplexity",
   "togetherai", "vercel", "vertex", "xai", "zai"]

private def isAccountModelProviderName (call : Json) : Prog Json :=
  pure (toJson (modelProviders.contains (str (Twin.callArg call 0))))

private def isAgentProviderName (call : Json) : Prog Json :=
  let name := str (Twin.callArg call 0)
  pure (toJson (name == "v0" || name == "fishaudio" || modelProviders.contains name))

private def providerApiKeyEnvName (call : Json) : Prog Json :=
  let provider := str (Twin.callArg call 0)
  pure (if provider == "chatgpt" then Json.null else toJson s!"{provider.toUpper}_API_KEY")

private def core (path : String) : String := s!"apps/core/src/{path}"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [ Twin.traced (core "harness/plan-limits.ts#currentWindow") currentWindow,
    Twin.traced (core "harness/plan-limits.ts#budgetFor") budgetFor,
    Twin.traced (core "shared/skills.ts#parseSkillMarkdown") parseSkillMarkdown,
    Twin.traced (core "shared/skills.ts#isSupportedTextFile") isSupportedTextFile,
    Twin.traced (core "harness/skills.ts#ownedSkillPaths") ownedSkillPaths,
    Twin.traced (core "harness/ai-sdk-harness/adapters/pi.ts#trim") piTrim,
    Twin.traced (core "harness/ai-sdk-harness/adapters/pi.ts#trimMediaPart") trimMediaPart,
    Twin.traced (core "harness/hook-dispatcher.ts#hookArgs") hookArgs,
    Twin.traced (core "harness/plan-limits.ts#planRefusalResponse") planRefusalResponse,
    Twin.traced (core "harness/skills.ts#listConfiguredSkillMetadata") listConfiguredSkillMetadata,
    Twin.traced (core "shared/domain/agent-config.ts#toChannelRuntimeAgentConfig")
      toChannelRuntimeAgentConfig,
    Twin.traced (core "shared/domain/agent-config.ts#channelPartitionOf") channelPartitionOf,
    Twin.traced "packages/convex/model/modelPricing.ts#estimateModelTokenCost" estimateModelTokenCost,
    Twin.traced "packages/convex/model/modelPricing.ts#normalizeModelId" normalizeModelId,
    Twin.traced "packages/convex/model/modelPricing.ts#priceLookupIds" priceLookupIds,
    Twin.traced "packages/convex/model/modelProviders.ts#isAccountModelProviderName"
      isAccountModelProviderName,
    Twin.traced "packages/convex/model/modelProviders.ts#isAgentProviderName"
      isAgentProviderName,
    Twin.traced "packages/convex/model/modelProviders.ts#providerApiKeyEnvName"
      providerApiKeyEnvName ]

end Spec.Agent.Waveagent3a
