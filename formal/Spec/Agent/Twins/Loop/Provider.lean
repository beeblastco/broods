import Spec.Agent.Twins.Loop.Js

/-!
Twins of `apps/core/src/harness/provider.ts`: model settings, cache breakpoints and prompt rewrites.
-/

namespace Spec.Agent

open Lean Js

/-- `{ ...item, providerOptions }`, merging each provider's options from the breakpoint. -/
def markedForCache (item breakpoint : Json) : Json :=
  let merged := (entries breakpoint).foldl
    (fun (current : Json) (entry : String × Json) =>
      spread current [(entry.fst, spread (get current entry.fst) (entries entry.snd))])
    (Json.mkObj (entries (get item "providerOptions")))
  spread item [("providerOptions", merged)]

/-- `withCacheBreakpoint`: marks the item at `index`, when there is one and a breakpoint. -/
def withCacheBreakpoint (values : List Json) (breakpoint : Json) (index : Nat) : List Json :=
  if breakpoint == .null || index ≥ values.length then values
  else values.set index (markedForCache (values.getD index .null) breakpoint)

/-- The last index holding a value that passes the test. -/
def lastIndexWhere (test : Json → Bool) (values : List Json) : Option Nat :=
  ((values.zipIdx).filter fun pair => test pair.fst).getLast?.map Prod.snd

/-- `withCacheBreakpoint` at the default index, the last item. -/
def withLastBreakpoint (values : List Json) (breakpoint : Json) : List Json :=
  withCacheBreakpoint values breakpoint (values.length - 1)

/-- `withEnvironment`: the turn's environment text after the messages, with its cache mark. -/
def withEnvironment (messages : List Json) (environment : String) (breakpoint : Json) : List Json :=
  let userEnvironment := Json.mkObj [("role", "user"), ("content", toJson environment)]
  match messages.getLast? with
  | none => withLastBreakpoint messages breakpoint ++ [userEnvironment]
  | some last =>
    if get last "role" == .str "tool" && breakpoint != .null then
      let parts := items (get last "content")
      let index := lastIndexWhere (fun part => get part "type" == .str "tool-result") parts
      let marked := parts.zipIdx.map fun pair =>
        if some pair.snd == index then markedForCache pair.fst breakpoint else pair.fst
      messages.dropLast ++
        [spread last [("content", .arr marked.toArray)], userEnvironment]
    else if get last "role" != .str "user" then
      withLastBreakpoint messages breakpoint ++ [userEnvironment]
    else
      let content :=
        match get last "content" with
        | .str text => [Json.mkObj [("type", "text"), ("text", .str text)]]
        | other => items other
      messages.dropLast ++
        [spread last [("content", .arr (withLastBreakpoint content breakpoint ++
          [Json.mkObj [("type", "text"), ("text", toJson environment)]]).toArray)]]

/-- `/^(?:ft:)?gpt-(\d+)(?:\.(\d+))?(?:[-:]|$)/i`, with the version's major and minor. -/
def gptVersion (modelId : String) : Option (Nat × Nat) :=
  let lower := modelId.toList.map Char.toLower
  let afterFt := if "ft:".toList.isPrefixOf lower then lower.drop 3 else lower
  if !"gpt-".toList.isPrefixOf afterFt then none
  else
    let body := afterFt.drop 4
    let major := body.takeWhile Char.isDigit
    let rest := body.dropWhile Char.isDigit
    let ends (tail : List Char) : Bool :=
      match tail with
      | [] => true
      | c :: _ => c == '-' || c == ':'
    let number (digits : List Char) : Nat := (String.ofList digits).toNat?.getD 0
    if major.isEmpty then none
    else
      match rest with
      | '.' :: tail =>
        let minor := tail.takeWhile Char.isDigit
        let after := tail.dropWhile Char.isDigit
        if !minor.isEmpty && ends after then some (number major, number minor) else none
      | tail => if ends tail then some (number major, 0) else none

/-- The pattern for a Claude id: `claude-` at the start or after a dot, in any case. -/
def isClaudeModel (modelId : String) : Bool :=
  let lower := modelId.toLower
  startsWith lower "claude-" || includes lower ".claude-"

/-- `servedModelId`: what follows the id's last slash. -/
def servedModelId (modelId : Json) : String :=
  match modelId with
  | .str text => (text.splitOn "/").getLast?.getD ""
  | _ => ""

/-- `promptCacheKey`: 32 hex digits of the conversation key's hash. -/
def promptCacheKey (conversationKey : String) : String :=
  take (sha256Hex conversationKey) 32

/-- `withDefaultOption`: a configured value wins over the default. -/
def withDefaultOption (configured : Json) (provider field : String) (value : Json) : Json :=
  if has (get configured provider) field then configured
  else spread configured [(provider, spread (get configured provider) [(field, value)])]

/-- `customProviderName`. -/
def customProviderName (settings : Json) : String :=
  (str? (get settings "name")).getD "custom"

private def ephemeral : Json := Json.mkObj [("type", "ephemeral")]

/-- `customCacheOptions`: GPT takes a body key, and Claude a message mark. -/
def customCacheOptions (agentConfig : Json) (conversationKey : String) : Json :=
  let model := get agentConfig "model"
  let configured := get model "providerOptions"
  let modelId := servedModelId (get model "modelId")
  if (gptVersion modelId).isSome then
    withDefaultOption configured (customProviderName (get (get agentConfig "provider") "custom"))
      "prompt_cache_key" (toJson (promptCacheKey conversationKey))
  else if isClaudeModel modelId then
    withDefaultOption configured "openaiCompatible" "cache_control" ephemeral
  else configured

private def storedItemProviders : List String :=
  ["openai", "azure"]

/-- `providerOptionsFromModelConfig`, given a conversation key when the caller has one. -/
def providerOptionsFromModelConfig (agentConfig : Json) (conversationKey : Json) : Json :=
  let model := get agentConfig "model"
  let configured := get model "providerOptions"
  match conversationKey, get model "provider" with
  | .str key, .str provider =>
    if provider == "anthropic" then
      withDefaultOption configured "anthropic" "cacheControl" ephemeral
    else if provider == "custom" then customCacheOptions agentConfig key
    else if !storedItemProviders.contains provider && provider != "chatgpt" then configured
    else withDefaultOption configured "openai" "promptCacheKey" (toJson (promptCacheKey key))
  | _, _ => configured

/-- `takesPromptCacheBreakpoints`: from GPT 5.6 on. -/
def takesPromptCacheBreakpoints (modelId : Json) : Bool :=
  match gptVersion ((str? modelId).getD "") with
  | none => false
  | some (major, minor) => major > 5 || (major == 5 && minor ≥ 6)

/-- `cacheBreakpointFromProviderOptions`. -/
def cacheBreakpoint (agentConfig providerOptions : Json) : Json :=
  let provider := get (get agentConfig "model") "provider"
  let custom := get providerOptions "openaiCompatible"
  if provider == .str "custom" && has custom "cache_control" then
    Json.mkObj [("openaiCompatible", Json.mkObj [("cache_control", get custom "cache_control")])]
  else if provider == .str "openai" && has (get providerOptions "openai") "promptCacheKey" &&
      takesPromptCacheBreakpoints (get (get agentConfig "model") "modelId") then
    Json.mkObj [("openai", Json.mkObj
      [("promptCacheBreakpoint", Json.mkObj [("mode", "explicit")])])]
  else
    let anthropic := get providerOptions "anthropic"
    if has anthropic "cacheControl" then
      Json.mkObj [("anthropic", Json.mkObj [("cacheControl", get anthropic "cacheControl")])]
    else .null

/-- `customProviderBaseURL`: `base_url`, then `baseURL`, trimmed, with blank read as absent. -/
def customProviderBaseURL (settings : Json) : Option String :=
  let raw :=
    match get settings "base_url" with
    | .str text => some text
    | _ => str? (get settings "baseURL")
  match raw with
  | none => none
  | some text =>
    let trimmed := trim text
    if trimmed.isEmpty then none else some trimmed

/-- `requireProviderSettings`: the error text is the only outcome besides the settings. -/
def requireProviderSettings (agentConfig : Json) (provider : String) : Except String Json :=
  let settings := get (get agentConfig "provider") provider
  if !truthy settings then .error s!"config.provider.{provider} is required"
  else if !truthy (get settings "apiKey") then
    .error s!"config.provider.{provider}.apiKey is required"
  else if provider == "custom" && (customProviderBaseURL settings).isNone then
    let hint := if has settings "baseUrl" then " (found \"baseUrl\", use \"base_url\" or \"baseURL\")"
      else ""
    .error s!"config.provider.custom.base_url is required{hint}"
  else .ok settings

/-- `Except` as a twin's output: a value or a throw. -/
def outcome : Except String Json → Json
  | .ok value => value
  | .error message => Twin.threw message

/-- `requireModelProvider`. -/
def requireModelProvider (agentConfig : Json) : Except String Json :=
  let provider := get (get agentConfig "model") "provider"
  if truthy provider then .ok provider else .error "config.model.provider is required"

/-- `requireModelId`. -/
def requireModelId (agentConfig : Json) : Except String Json :=
  let modelId := get (get agentConfig "model") "modelId"
  if truthy modelId then .ok modelId else .error "config.model.modelId is required"

/-- `mergedSystemMessage`: system prompts joined, keeping the last one's options. -/
def mergedSystemMessage (systems : List Json) : Json :=
  let options := match systems.getLast? with
    | some last => get last "providerOptions"
    | none => .null
  Json.mkObj ([("role", .str "system"),
    ("content", toJson (String.intercalate "\n\n"
      (systems.map fun message => primitiveText (get message "content"))))] ++
    (if truthy options then [("providerOptions", options)] else []))

/-- `withoutStoredItemId`. -/
def withoutStoredItemId (part : Json) : Json :=
  let options := get part "providerOptions"
  let openai := get options "openai"
  if !has openai "itemId" then part
  else spread part [("providerOptions", spread options [("openai", without openai ["itemId"])])]

/-- `withoutStoredItemState`: no previous response id, reasoning or stored item ids. -/
def withoutStoredItemState (params : Json) : Json :=
  let options := get params "providerOptions"
  let openai := get options "openai"
  let prompt := (items (get params "prompt")).map fun message =>
    if get message "role" != .str "assistant" then message
    else spread message [("content", .arr
      (((items (get message "content")).filter fun part => get part "type" != .str "reasoning").map
        withoutStoredItemId).toArray)]
  spread params (
    (if has openai "previousResponseId" then
      [("providerOptions", spread options [("openai", without openai ["previousResponseId"])])]
     else []) ++
    [("prompt", .arr prompt.toArray)])

/-- `withTextToolResultsAsText`: an all-text content result becomes plain text. -/
def withTextToolResultsAsText (prompt : List Json) : List Json :=
  prompt.map fun message =>
    if get message "role" != .str "tool" then message
    else
      spread message [("content", .arr ((items (get message "content")).map fun part =>
        let output := get part "output"
        let value := items (get output "value")
        if get part "type" != .str "tool-result" || get output "type" != .str "content" ||
            !value.all (fun item => get item "type" == .str "text") then part
        else
          spread part [("output", Json.mkObj [("type", "text"),
            ("value", toJson (String.intercalate "\n"
              (value.map fun item => primitiveText (get item "text"))))])]).toArray)]

/-- `isImage` and `isDroppableMedia` share this test of a file part's media type. -/
private def fileIsImage (part : Json) : Option Bool :=
  match get part "mediaType" with
  | .str mediaType => some (startsWith mediaType "image/")
  | _ => none

/-- `isMovableImage`. -/
def isMovableImage (item : Json) : Bool :=
  get item "type" == .str "file" && (fileIsImage item).getD false &&
    (get (get item "data") "type" == .str "data" || get (get item "data") "type" == .str "url")

/-- `toolImagesAsUserMessages`: images in tool results move to a following user message. -/
def toolImagesAsUserMessages (prompt : List Json) : List Json :=
  prompt.flatMap fun message =>
    if get message "role" != .str "tool" then [message]
    else
      let step (state : List Json × List Json) (part : Json) : List Json × List Json :=
        if get part "type" != .str "tool-result" || get (get part "output") "type" != .str "content"
        then (state.fst, state.snd ++ [part])
        else
          let inner := (items (get (get part "output") "value")).foldl
            (fun (acc : List Json × List Json) (item : Json) =>
              if isMovableImage item then
                let images := acc.fst ++ [item]
                (images, acc.snd ++ [Json.mkObj [("type", "text"),
                  ("text", toJson s!"[image {images.length} is in the next message]")]])
              else (acc.fst, acc.snd ++ [item]))
            (state.fst, [])
          (inner.fst, state.snd ++
            [spread part [("output", spread (get part "output") [("value", .arr inner.snd.toArray)])]])
      let result := (items (get message "content")).foldl step ([], [])
      if result.fst.isEmpty then withTextToolResultsAsText [message]
      else
        withTextToolResultsAsText [spread message [("content", .arr result.snd.toArray)]] ++
          [Json.mkObj [("role", "user"), ("content", .arr
            ((Json.mkObj [("type", "text"), ("text", "Images from the tool results above:")]) ::
              result.fst).toArray)]]

/-- `withLatestPartMarked`. -/
def withLatestPartMarked (message breakpoint : Json) : Json :=
  let content := items (get message "content")
  if get message "role" == .str "user" then
    spread message [("content", .arr (withLastBreakpoint content breakpoint).toArray)]
  else if get message "role" == .str "tool" then
    let marked :=
      match lastIndexWhere (fun part => get part "type" == .str "tool-result") content with
      | some index => withCacheBreakpoint content breakpoint index
      | none => content
    spread message [("content", .arr marked.toArray)]
  else markedForCache message breakpoint

/-- The provider twins. -/
def providerTwinList : List Spec.Twin := [
  { source := "apps/core/src/harness/provider.ts#markedForCache"
    run := fun args => markedForCache (Twin.arg args 0) (Twin.arg args 1) },
  { source := "apps/core/src/harness/provider.ts#withCacheBreakpoint"
    run := fun args =>
      let values := items (Twin.arg args 0)
      match Twin.arg args 2 with
      | .null => .arr (withLastBreakpoint values (Twin.arg args 1)).toArray
      | index =>
        match natOf? index with
        | some at_ => .arr (withCacheBreakpoint values (Twin.arg args 1) at_).toArray
        | none => .arr values.toArray },
  { source := "apps/core/src/harness/provider.ts#providerOptionsFromModelConfig"
    run := fun args => providerOptionsFromModelConfig (Twin.arg args 0) (Twin.arg args 1) },
  { source := "apps/core/src/harness/provider.ts#cacheBreakpointFromProviderOptions"
    run := fun args => cacheBreakpoint (Twin.arg args 0) (Twin.arg args 1) },
  { source := "apps/core/src/harness/provider.ts#customCacheOptions"
    run := fun args =>
      match Twin.arg args 1 with
      | .str key => customCacheOptions (Twin.arg args 0) key
      | _ => Twin.unsupported "conversation key is not a string" },
  { source := "apps/core/src/harness/provider.ts#customCacheBreakpoint"
    run := fun args =>
      Json.mkObj [("openaiCompatible", Json.mkObj [("cache_control", Twin.arg args 0)])] },
  { source := "apps/core/src/harness/provider.ts#withDefaultOption"
    run := fun args =>
      match Twin.arg args 1, Twin.arg args 2 with
      | .str provider, .str name =>
        withDefaultOption (Twin.arg args 0) provider name (Twin.arg args 3)
      | _, _ => Twin.unsupported "provider and field are not strings" },
  { source := "apps/core/src/harness/provider.ts#customProviderBaseURL"
    run := fun args => ((customProviderBaseURL (Twin.arg args 0)).map toJson).getD .null },
  { source := "apps/core/src/harness/provider.ts#customProviderName"
    run := fun args => toJson (customProviderName (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#modelSettingsFromModelConfig"
    run := fun args =>
      let settings := without (get (Twin.arg args 0) "model")
        ["provider", "modelId", "providerOptions", "output"]
      Json.mkObj ([("maxRetries", nat 5)] ++ entries settings) },
  { source := "apps/core/src/harness/provider.ts#modelIdentityFromModelConfig"
    run := fun args =>
      let model := get (Twin.arg args 0) "model"
      if has model "provider" && has model "modelId" then
        toJson (primitiveText (get model "provider") ++ "/" ++ primitiveText (get model "modelId"))
      else .null },
  { source := "apps/core/src/harness/provider.ts#requireProviderSettings"
    run := fun args =>
      match Twin.arg args 1 with
      | .str provider => outcome (requireProviderSettings (Twin.arg args 0) provider)
      | _ => Twin.unsupported "provider is not a string" },
  { source := "apps/core/src/harness/provider.ts#requireModelProvider"
    run := fun args => outcome (requireModelProvider (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#requireModelId"
    run := fun args => outcome (requireModelId (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#takesPromptCacheBreakpoints"
    run := fun args => toJson (takesPromptCacheBreakpoints (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#promptCacheKey"
    run := fun args =>
      match Twin.arg args 0 with
      | .str key => toJson (promptCacheKey key)
      | _ => Twin.unsupported "conversation key is not a string" },
  { source := "apps/core/src/harness/provider.ts#servedModelId"
    run := fun args => toJson (servedModelId (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#workersAIModelId"
    run := fun args =>
      match Twin.arg args 0 with
      | .str id =>
        toJson (if startsWith id "workers-ai/" then drop id "workers-ai/".length else id)
      | _ => Twin.unsupported "model id is not a string" },
  { source := "apps/core/src/harness/provider.ts#isImage"
    run := fun args =>
      let part := Twin.arg args 0
      if get part "type" != .str "file" then toJson false
      else
        match fileIsImage part with
        | some image => toJson image
        | none => Twin.threw "undefined is not an object (evaluating 'part.mediaType.startsWith')" },
  { source := "apps/core/src/harness/provider.ts#isDroppableMedia"
    run := fun args =>
      let part := Twin.arg args 0
      if get part "type" != .str "file" then toJson false
      else
        match fileIsImage part with
        | some image => toJson (!image)
        | none => Twin.threw "undefined is not an object (evaluating 'part.mediaType.startsWith')" },
  { source := "apps/core/src/harness/provider.ts#isMovableImage"
    run := fun args => toJson (isMovableImage (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#mergedSystemMessage"
    run := fun args => mergedSystemMessage (items (Twin.arg args 0)) },
  { source := "apps/core/src/harness/provider.ts#withoutStoredItemState"
    run := fun args => withoutStoredItemState (Twin.arg args 0) },
  { source := "apps/core/src/harness/provider.ts#withoutStoredItemId"
    run := fun args => withoutStoredItemId (Twin.arg args 0) },
  { source := "apps/core/src/harness/provider.ts#withTextToolResultsAsText"
    run := fun args => .arr (withTextToolResultsAsText (items (Twin.arg args 0))).toArray },
  { source := "apps/core/src/harness/provider.ts#withLatestPartMarked"
    run := fun args => withLatestPartMarked (Twin.arg args 0) (Twin.arg args 1) },
  { source := "apps/core/src/harness/provider.ts#toolImagesAsUserMessages"
    run := fun args => .arr (toolImagesAsUserMessages (items (Twin.arg args 0))).toArray }]

end Spec.Agent
