import Spec.Twin

/-!
Twins of the agent subsystem's functions added in wave 12.
-/

namespace Spec.Agent.Wave12

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def nullish (value : Json) : Bool :=
  isUndef value || value == Json.null

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def text (value : Json) : String :=
  value.getStr?.toOption.getD ""

private def fn (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

/-- An object whose members are the named functions, as the AI SDK middleware and closures are. -/
private def members (names : List String) : Json :=
  Json.mkObj (names.map fun name => (name, fn name))

/-- The entries of an object, without the recorder's `$keys`. -/
private def entries (value : Json) : List (String × Json) :=
  match value with
  | .obj fields => fields.toList.filter fun entry => entry.1 != "$keys"
  | _ => []

/-! ### provider.ts -/

private def providerFile : String := "apps/core/src/harness/provider.ts"

/-- The providers whose stored response items the retry middleware repairs (`STORED_ITEM_PROVIDERS`). -/
private def storedItemProviders : List String := ["azure", "openai"]

/-- `modelOutputFromModelConfig`: a structured output type builds its spec; none or text leaves the
reply as text. -/
def modelOutputFromModelConfig (call : Json) : Prog Json := do
  let output := field (field (Twin.callArg call 0) "model") "output"
  if nullish output || field output "type" == toJson "text" then
    return undef
  Prog.effect "createModelOutput" [output]

/-- The transcription model each provider uses unless `transcriptionModelId` says otherwise
(`PROVIDER_TRANSCRIPTION`). -/
private def defaultTranscriptionModel (provider : String) : Option String :=
  match provider with
  | "groq" => some "whisper-large-v3-turbo"
  | "mistral" => some "voxtral-mini-latest"
  | "openai" => some "whisper-1"
  | _ => none

/-- `resolveTranscriptionModel`: a provider with a transcription model builds it, and any failure
means the agent has none. -/
def resolveTranscriptionModel (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let model := field config "model"
  let provider := field model "provider"
  match defaultTranscriptionModel (text provider) with
  | none => return undef
  | some fallback =>
    Prog.catchFail
      (do
        let settings ← Prog.effect "requireProviderSettings" [config, provider]
        let withFetch ← Prog.effect "withModelFetch" [settings]
        let _ ← Prog.effect "source.factory" [withFetch]
        let configured := field model "transcriptionModelId"
        Prog.effect "provider.transcription"
          [if nullish configured then toJson fallback else configured])
      (fun _ => pure undef)

/-- `resolveOpenAICompatibleModel`: a compatible client for a custom endpoint, wrapped in the
middleware stack, the tool image move built for this endpoint and model. -/
def resolveOpenAICompatibleModel (call : Json) : Prog Json := do
  let providerName := Twin.callArg call 0
  let settings := Twin.callArg call 1
  let modelId := Twin.callArg call 2
  let withFetch ← Prog.effect "withModelFetch" [settings]
  let openAIConfig := (entries withFetch).filter fun entry => entry.1 != "base_url"
  let configuredBase ← Prog.effect "customProviderBaseURL" [settings]
  let baseURL := if nullish configuredBase then toJson "" else configuredBase
  let name ← Prog.effect "customProviderName" [settings]
  let provider ← Prog.effect "createOpenAICompatible"
    [Json.mkObj ([("supportsMultiPartToolContent", toJson true)] ++ openAIConfig ++
      [("baseURL", baseURL), ("name", name), ("includeUsage", toJson true)])]
  let base ← Prog.effect "provider" [modelId]
  let moved ← Prog.effect "moveRefusedToolImagesMiddleware" [toJson s!"{text baseURL} {text modelId}"]
  let model ← Prog.effect "wrapLanguageModel"
    [Json.mkObj
      [("model", base),
       ("middleware", .arr #[members ["transformParams"], members ["wrapStream"],
         members ["wrapGenerate", "wrapStream"], moved,
         members ["wrapGenerate", "wrapStream"], members ["transformParams"]])]]
  return Json.mkObj [("providerName", providerName), ("provider", provider), ("model", model)]

/-- `resolveConfiguredModel`: the provider's factory builds the model and the retry middleware wraps
it; ChatGPT and custom endpoints have their own resolvers. -/
def resolveConfiguredModel (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let providerName ← Prog.effect "requireModelProvider" [config]
  let modelId ← Prog.effect "requireModelId" [config]
  if providerName == toJson "chatgpt" then
    return ← Prog.effect "resolveChatGPTModel" [modelId, Twin.callArg call 1]
  let providerConfig ← Prog.effect "requireProviderSettings" [config, providerName]
  if providerName == toJson "custom" then
    return ← Prog.effect "resolveOpenAICompatibleModel" [providerName, providerConfig, modelId]
  let factories ← Prog.effect "modelProviderFactories"
  if isUndef (field factories (text providerName)) then
    return ← Prog.unsupported "no factory is registered for this provider"
  let settings ← Prog.effect "withModelFetch" [providerConfig]
  let provider ← Prog.effect "createProvider" [settings]
  let base ← Prog.effect "provider" [modelId]
  let retry := if storedItemProviders.contains (text providerName)
    then [members ["wrapGenerate", "wrapStream"]] else []
  let model ← Prog.effect "wrapLanguageModel"
    [Json.mkObj
      [("model", base),
       ("middleware", .arr (#[members ["wrapGenerate", "wrapStream"]] ++ retry.toArray))]]
  return Json.mkObj [("providerName", providerName), ("provider", provider), ("model", model)]

/-- `createRunFinalizer`: the two closures that settle the run once and report whether they have. -/
def createRunFinalizer (_call : Json) : Prog Json :=
  pure (members ["finalize", "finalized"])

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [ Twin.traced "apps/core/src/harness/run-finalizer.ts#createRunFinalizer" createRunFinalizer
  , Twin.traced s!"{providerFile}#resolveTranscriptionModel" resolveTranscriptionModel
  , Twin.traced s!"{providerFile}#modelOutputFromModelConfig" modelOutputFromModelConfig
  , Twin.traced s!"{providerFile}#resolveOpenAICompatibleModel" resolveOpenAICompatibleModel
  , Twin.traced s!"{providerFile}#resolveConfiguredModel" resolveConfiguredModel ]

end Spec.Agent.Wave12
