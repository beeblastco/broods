import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign8/agent8a.tsv`.
-/

namespace Spec.Agent.Waveagent8a

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def number (value : Json) : Float :=
  value.getNum?.toOption.map (·.toFloat) |>.getD 0

private def booleanEnv (call : Json) : Prog Json := do
  let name := Twin.callArg call 0
  let value ← Prog.effect "optionalEnv" [name]
  if value == Twin.undefinedJson then
    return Twin.param call 1
  let normalized := value.getStr?.toOption.getD "" |>.trimAscii.toString.toLower
  if ["1", "true", "yes", "on"].contains normalized then
    return toJson true
  if ["0", "false", "no", "off"].contains normalized then
    return toJson false
  Prog.throwError "Error" s!"{name.getStr?.toOption.getD ""} must be a boolean-like value"

private def getHarnessPublicUrl (_ : Json) : Prog Json := do
  let configured ← Prog.effect "optionalEnv" [toJson "PUBLIC_BASE_URL"]
  if configured == Twin.undefinedJson then
    return Twin.undefinedJson
  let text := configured.getStr?.toOption.getD ""
  return toJson (String.ofList ((text.toList.reverse.dropWhile (· == '/')).reverse))

/-- `UNIT_RATES_EUR` and `USAGE_CATEGORY` in `packages/convex/model/pricing.ts`, in key order. -/
private def unitRates : List (String × Float × String) :=
  [("sandboxVcpuSeconds", 0.00003, "sandboxes"), ("sandboxGbSeconds", 0.000004, "sandboxes"),
   ("sandboxSnapshotGb", 0.005, "sandboxes"), ("sandboxSnapshotGbMonths", 0.075, "sandboxes"),
   ("hostedMcpGbSeconds", 0.000012, "hostedMcp"), ("hostedMcpRequests", 0.0000002, "hostedMcp"),
   ("workerMs", 0.00000002, "sandboxes"), ("workerRequests", 0.0000003, "sandboxes"),
   ("storageGbMonths", 0.021, "storage"), ("egressGb", 0.08, "egress"), ("ingressGb", 0, "egress")]

/-- A double as JSON the way `JSON.stringify` writes it: the fewest decimals that read back equal. -/
private def shortestJson (value : Float) : Json :=
  let bits : Nat := value.abs.toBits.toNat
  let biased : Nat := bits / 2 ^ 52
  let fraction : Nat := bits % 2 ^ 52
  let significand : Nat := if biased == 0 then fraction else fraction + 2 ^ 52
  let exponent : Int := if biased == 0 then -1074 else (biased : Int) - 1075
  let numerator : Nat := significand * 2 ^ exponent.toNat
  let denominator : Nat := 2 ^ (-exponent).toNat
  if value.isNaN || value.isInf then Json.null else
    let rounded (places : Nat) : Nat :=
      (2 * numerator * 10 ^ places + denominator) / (2 * denominator)
    let places := (List.range 341).find? fun places =>
      Float.ofScientific (rounded places) true places == value.abs
    match places with
    | none => Json.null
    | some count =>
      let size : Int := Int.ofNat (rounded count)
      .num ⟨if value < 0 then -size else size, count⟩

private def meterCostByCategoryEur (call : Json) : Prog Json := do
  let usage := Twin.callArg call 0
  let costs := unitRates.foldl (fun totals (key, rate, category) =>
    totals.map fun (name, cost) =>
      (name, if name == category then cost + number (field usage key) * rate else cost))
    [("sandboxes", (0 : Float)), ("hostedMcp", 0), ("storage", 0), ("egress", 0)]
  return Json.mkObj (costs.map fun (key, value) => (key, shortestJson value))

private def meterCostEur (call : Json) : Prog Json := do
  let costs ← Prog.effect "meterCostByCategoryEur" [Twin.callArg call 0]
  return shortestJson (number (field costs "sandboxes") + number (field costs "hostedMcp") +
    number (field costs "storage") + number (field costs "egress"))

private def isUndefined (value : Json) : Bool :=
  value == Twin.undefinedJson

/-- An object literal: a key holding `undefined` is dropped, as the recorder drops it. -/
private def literal (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndefined entry.2)

private def str (value : String) : Json := toJson value

private def text (value : Json) : String :=
  value.getStr?.toOption.getD ""

private def items (value : Json) : List Json :=
  match value with
  | .arr values => values.toList
  | _ => []

private def arr (values : List Json) : Json :=
  .arr values.toArray

private def fnRef (name : String) : Json :=
  Json.mkObj [("$fn", str name)]

/-- Own enumerable keys, without the recorder's bookkeeping. -/
private def keysOf (value : Json) : List String :=
  match value with
  | .obj entries => entries.toList.map (·.1) |>.filter fun key => key != "$keys" && key != "$fields"
  | _ => []

private def hasKey (value : Json) (key : String) : Bool :=
  (keysOf value).contains key

private def dedupe (values : List Json) : List Json :=
  values.foldl (fun seen value => if seen.contains value then seen else seen ++ [value]) []

private def orElse (value fallback : Json) : Json :=
  if isUndefined value || value == Json.null then fallback else value

/-- Copies `base` with these keys replaced, as a spread followed by named properties does. -/
private def withKeys (base : Json) (entries : List (String × Json)) : Json :=
  literal ((keysOf base |>.filter (fun key => !(entries.any (·.1 == key)))).map
    (fun key => (key, field base key)) ++ entries)

private def harnessQuestionTool : String := "askUserQuestions"

private def resolveHarnessToolFiltering (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let harness := field config "harness"
  let denied := items (field config "denyTools")
  let active := field harness "activeTools"
  if !isUndefined active then
    return Json.mkObj [("activeTools", arr ((items active).filter fun name => !denied.contains name))]
  let inactive := items (field harness "inactiveTools") ++ denied
  return if inactive.isEmpty then Json.mkObj []
    else Json.mkObj [("inactiveTools", arr (dedupe inactive))]

private def withoutHarnessBuiltinTools (call : Json) : Prog Json := do
  let tools := Twin.callArg call 0
  let builtin := field (Twin.callArg call 1) "builtinTools"
  return Json.mkObj ((keysOf tools).filter (fun key => !hasKey builtin key) |>.map
    fun key => (key, field tools key))

private def withoutHarnessQuestionPrompt (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let active := field options "activeTools"
  if !isUndefined active then
    return Json.mkObj
      [("activeTools", arr ((items active).filter (· != str harnessQuestionTool)))]
  let inactive := field options "inactiveTools"
  if !hasKey (field (field options "adapter") "builtinTools") harnessQuestionTool then
    return literal [("inactiveTools", inactive)]
  return Json.mkObj
    [("inactiveTools", arr (dedupe (items inactive ++ [str harnessQuestionTool])))]

private def createHarnessAgent (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let type := field options "type"
  let mode := field options "permissionMode"
  if type == str "codex" && !isUndefined mode && mode != str "allow-all" then
    Prog.throwError "Error" "Codex Harness requires permissionMode allow-all"
  let adapter := field options "adapter"
  let tools ← Prog.effect "withoutHarnessBuiltinTools"
    [orElse (field options "tools") (Json.mkObj []), adapter]
  let filtering ← Prog.effect "withoutHarnessQuestionPrompt" [options]
  let copied := ["debug", "id", "instructions", "model", "permissionMode", "skills", "toolApproval"]
  Prog.effect "new HarnessAgent"
    [literal ([("harness", adapter), ("onLog", fnRef "logHarnessDiagnostic"),
      ("telemetry", Json.mkObj
        [("functionId", str s!"harness.{text type}"), ("recordInputs", toJson false),
         ("recordOutputs", toJson false)]),
      ("tools", tools),
      ("activeTools", field filtering "activeTools"),
      ("inactiveTools",
        if isUndefined (field filtering "activeTools") then field filtering "inactiveTools"
        else Twin.undefinedJson)] ++
      copied.map fun key => (key, field options key))]

private def createHarnessRuntime (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let provisioned ← Prog.effect "createAiSdkHarnessSandbox"
    [literal (["bridgePort", "compute", "metadata", "onUsage", "reservationKey", "shared", "type"].map
      fun key => (key, field options key))]
  let agent ← Prog.effect "createHarnessAgent" [options]
  return Json.mkObj
    [("agent", agent), ("bridgePort", field provisioned "bridgePort"),
     ("reservationKey", field provisioned "reservationKey"),
     ("sandbox", field provisioned "sandbox")]

private def createConfiguredHarnessAgent (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let config := field options "agentConfig"
  let harness := field config "harness"
  if isUndefined harness then
    Prog.throwError "Error" "config.harness is required"
  let compute ← Prog.effect "requireAiSdkHarnessCompute" [field options "compute"]
  let model ← Prog.effect "requireHarnessModelId" [config]
  let filtering ← Prog.effect "resolveHarnessToolFiltering" [config]
  let adapter ← Prog.effect "createConfiguredAiSdkHarnessAdapter" [config, field options "session"]
  let copied := ["id", "instructions", "metadata", "onUsage", "reservationKey", "shared", "skills",
    "toolApproval", "tools"]
  Prog.effect "createHarnessRuntime"
    [literal ((keysOf filtering).map (fun key => (key, field filtering key)) ++
      [("adapter", adapter), ("debug", field harness "debug"), ("model", model),
       ("permissionMode", field harness "permissionMode"), ("type", field harness "type"),
       ("compute", compute)] ++
      copied.map fun key => (key, field options key))]

/-- `createMicrovmHarnessAgent` and `createWorkdirHarnessAgent` differ only in their option types. -/
private def createAdapterRuntime (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let adapter ← Prog.effect "createAiSdkHarnessAdapter"
    [field options "type", field options "harnessSettings"]
  Prog.effect "createHarnessRuntime" [withKeys options [("adapter", adapter)]]

private def createAiSdkHarnessSandbox (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  if field (field options "compute") "provider" == str "lambda" then
    Prog.effect "createMicrovmHarnessSandbox" [options]
  else
    Prog.effect "createWorkdirHarnessSandbox" [options]

private def versionScopedReservationKey (call : Json) : Prog Json := do
  let type := Twin.callArg call 1
  let version ← Prog.effect "harnessAdapterVersion" [type]
  return str s!"{text (Twin.callArg call 0)}:{text type}:{text version}"

private def ensurePnpmCommand : String :=
  "command -v pnpm >/dev/null 2>&1 || npm install --global pnpm@10.34.5 --no-audit --no-fund"

/-- The two sandbox builders: only the first commands, the driver and the provider id differ. -/
private def createHarnessSandbox (driverLabel providerPrefix : String) (setup : List String)
    (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let bridgePort := orElse (field options "bridgePort") (toJson (4321 : Nat))
  let type := field options "type"
  let reservationKey ← Prog.effect "versionScopedReservationKey"
    [field options "reservationKey", type]
  let compute := field options "compute"
  let onCreate := setup.map str ++ items (field compute "onCreate")
  let driver ← Prog.effect driverLabel
    [literal [("reservationKey", reservationKey),
      ("config", withKeys compute [("onCreate", arr onCreate)]),
      ("metadata", field options "metadata"), ("onUsage", field options "onUsage"),
      ("ports", arr [bridgePort]), ("shared", field options "shared")]]
  let sandbox ← Prog.effect "createBroodsSandbox"
    [Json.mkObj [("driver", driver), ("providerId", str s!"{providerPrefix}{text type}"),
      ("bridgePorts", arr [bridgePort])]]
  return Json.mkObj
    [("bridgePort", bridgePort), ("reservationKey", reservationKey), ("sandbox", sandbox)]

private def createConfiguredClaudeCodeAdapter (call : Json) : Prog Json := do
  let config := Twin.callArg call 0
  let harness := field config "harness"
  let providerName ← Prog.effect "requireHarnessProviderName" [config]
  if providerName != str "anthropic" && providerName != str "vercel" then
    Prog.throwError "Error"
      "config.harness.type claude-code requires the anthropic or vercel model provider"
  let provider ← Prog.effect "requireHarnessProviderSettings" [config, providerName]
  let reasoning ← Prog.effect "anthropicHarnessReasoning" [config]
  let auth ← Prog.effect "resolveAnthropicOrVercelAuthEnv" [providerName, provider]
  let maxTurns ← Prog.effect "configuredMaxTurn" [config]
  Prog.effect "createClaudeCode"
    [withKeys reasoning
      [("auth", auth), ("maxTurns", maxTurns),
       ("startupTimeoutMs", field harness "startupTimeoutMs")]]

private def skillFile : String := "SKILL.md"
private def maxSkillFileBytes : Nat := 5242880
private def maxSkillBundleBytes : Nat := 31457280
/-- `skillReadLimit`'s limiter runs eight at once; the ninth starts as the first settles. -/
private def limiterHead : Nat := 9

private def limitCall : String × List Json := ("limit", [fnRef ""])

private def sizeOf (file : Json) : Nat :=
  (field file "size").getNat?.toOption.getD 0

private def outcomeValue : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => .fail error
  | .pending => Prog.unsupported "a skill read never settled"

/-- Enters one limiter slot: the callback, then the listing it runs. -/
private def listInSlot (path : Json) : Prog Json := do
  Prog.drain (fun _ _ => pure ()) 1
  Prog.effect "listSkillSourceFiles" [path]

/-- Lists every skill under the limiter. Past the first nine, each new slot opens as a limit settles. -/
private def listAllSkills (paths : List Json) : Prog (List Json) := do
  let mut listed : List Json := []
  for path in paths.take limiterHead do
    listed := listed ++ [← listInSlot path]
  let overflow := paths.drop limiterHead
  for path in overflow do
    let _ ← Prog.effect "limit" [fnRef ""]
    listed := listed ++ [← listInSlot path]
  let remaining := paths.length - overflow.length
  if remaining > 0 then
    let _ ← Prog.all (List.replicate remaining limitCall)
  return listed

private def checkSkillSizes (listed : List (Json × Json)) : Prog Unit := do
  let mut total : Nat := 0
  for (path, files) in listed do
    for file in items files do
      if sizeOf file > maxSkillFileBytes then
        Prog.throwError "Error"
          s!"Skill file exceeds {maxSkillFileBytes} bytes: {text path}/{text (field file "path")}"
      total := total + sizeOf file
  if total > maxSkillBundleBytes then
    Prog.throwError "Error" s!"Configured harness skills exceed {maxSkillBundleBytes} bytes"

/-- Builds one skill from its text: its resources are read under the limiter. -/
private def buildHarnessSkill (path : Json) (files : List Json) (skillText : Json) : Prog Json := do
  let skill ← Prog.effect "parseSkillMarkdown" [skillText]
  let resources := files.drop 1
  for file in resources do
    Prog.drain (fun _ _ => pure ()) 1
    let _ ← Prog.attempt "readSkillText" [path, field file "path", field file "size"]
  let bodies ← Prog.all (resources.map fun _ => limitCall)
  let mut built : List Json := []
  for (file, body) in resources.zip bodies do
    built := built ++
      [Json.mkObj [("path", field file "path"), ("content", ← outcomeValue body)]]
  let content ← Prog.effect "skillInstructionsFromMarkdown" [skillText]
  return literal
    [("name", field skill "name"), ("description", field skill "description"),
     ("content", content),
     ("files", if built.isEmpty then Twin.undefinedJson else arr built)]

private def loadConfiguredHarnessSkills (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let config := Twin.callArg call 1
  let skills := field config "skills"
  if field skills "enabled" != toJson true || text accountId == "" then
    return arr []
  let _ ← Prog.effect "skillReadLimit"
  let allowed := orElse (field skills "allowed") (arr [])
  let paths := items (← Prog.effect "ownedSkillPaths" [accountId, allowed])
  let listed := paths.zip (← listAllSkills paths)
  checkSkillSizes listed
  let promise := Json.mkObj [("$opaque", str "Promise"), ("$fields", Json.mkObj [])]
  let mut readable : List (Json × Json) := []
  for (path, files) in listed do
    let first := (items files).head?.getD Json.null
    if field first "path" != str skillFile then
      if listed.length > 1 then
        Prog.unsupported "a missing SKILL.md among several skills races the other reads"
      .fail (← Prog.effect "new SkillNotFoundError" [path])
    Prog.drain (fun _ _ => pure ()) 1
    let _ ← Prog.attempt "readSkillText" [path, str skillFile, field first "size"]
    readable := readable ++ [(path, files)]
  let reads ← Prog.all (readable.flatMap fun (path, _) =>
    [limitCall, ("readSkillOrSkip", [path, promise])])
  let mut out : List Json := []
  for ((path, files), index) in readable.zipIdx do
    let skillText ← outcomeValue (reads[index * 2 + 1]?.getD .pending)
    if skillText != Json.null then
      out := out ++ [← buildHarnessSkill path (items files) skillText]
  return arr out

/-- This author's twins. -/
def twins : List Spec.Twin :=
  let runtime := "apps/core/src/harness/ai-sdk-harness/runtime.ts#"
  let sandbox := "apps/core/src/harness/ai-sdk-harness/sandbox.ts#"
  [Twin.traced "apps/core/src/shared/env.ts#booleanEnv" booleanEnv,
   Twin.traced "apps/core/src/shared/env.ts#getHarnessPublicUrl" getHarnessPublicUrl,
   Twin.traced "packages/convex/model/pricing.ts#meterCostByCategoryEur" meterCostByCategoryEur,
   Twin.traced "packages/convex/model/pricing.ts#meterCostEur" meterCostEur,
   Twin.traced (runtime ++ "resolveHarnessToolFiltering") resolveHarnessToolFiltering,
   Twin.traced (runtime ++ "withoutHarnessBuiltinTools") withoutHarnessBuiltinTools,
   Twin.traced (runtime ++ "withoutHarnessQuestionPrompt") withoutHarnessQuestionPrompt,
   Twin.traced (runtime ++ "createHarnessAgent") createHarnessAgent,
   Twin.traced (runtime ++ "createHarnessRuntime") createHarnessRuntime,
   Twin.traced (runtime ++ "createConfiguredHarnessAgent") createConfiguredHarnessAgent,
   Twin.traced (runtime ++ "createMicrovmHarnessAgent") createAdapterRuntime,
   Twin.traced (runtime ++ "createWorkdirHarnessAgent") createAdapterRuntime,
   Twin.traced (sandbox ++ "createAiSdkHarnessSandbox") createAiSdkHarnessSandbox,
   Twin.traced (sandbox ++ "versionScopedReservationKey") versionScopedReservationKey,
   Twin.traced (sandbox ++ "createWorkdirHarnessSandbox")
     (createHarnessSandbox "createWorkdirHarnessDriver" "broods-workdir-" [ensurePnpmCommand]),
   Twin.traced "apps/core/src/harness/ai-sdk-harness/adapters/claude-code.ts#createConfiguredClaudeCodeAdapter"
     createConfiguredClaudeCodeAdapter,
   Twin.traced "apps/core/src/harness/skills.ts#loadConfiguredHarnessSkills"
     loadConfiguredHarnessSkills]

end Spec.Agent.Waveagent8a
