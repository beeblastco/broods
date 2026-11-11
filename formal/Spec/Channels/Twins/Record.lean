import Spec.Channels.Twins.Support

/-!
Twins of `apps/core/src/shared/domain/channel-record.ts`, and of the per-run model checks that
`normalizeModelConfig` (`packages/convex/model/agentRules.ts`) applies, which the record's agent config and
`parseRunOverrides` share.
-/

namespace Spec.Channels

open Lean

private def recordSource : String := "apps/core/src/shared/domain/channel-record.ts"

/-- `MODEL_CONFIG_SETTING_KEYS` in `packages/convex/model/agentRules.ts:99`. -/
def modelSettingKeys : List String :=
  ["provider", "modelId", "providerOptions", "output", "maxOutputTokens",
    "temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "stopSequences", "seed",
    "reasoning", "maxRetries", "timeout"]

private def reasoningLevels : List String :=
  ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]

private def timeoutKeys : List String :=
  ["totalMs", "stepMs", "firstChunkMs", "chunkMs", "toolMs", "tools"]

private def timerError : String :=
  "must be an integer from 1 to 2147483647"

/-- `timerMs`: a safe integer from 1 to `MAX_TIMER_MS`. -/
def timerOk : Json → Bool
  | .num n =>
    match numInt? n with
    | some value => value ≥ 1 && value ≤ 2147483647
    | none => false
  | _ => false

/-- The first issue of `MODEL_TIMEOUT`, as path and message, or `none` when it passes. The second
result is `false` where the schema goes beyond this model: the per-tool `tools` limits. -/
def timeoutIssue (value : Json) : Option (List String × String) × Bool :=
  match value with
  | .num _ => (if timerOk value then none else some ([], timerError), true)
  | .obj _ =>
    let timers := ["totalMs", "stepMs", "firstChunkMs", "chunkMs", "toolMs"]
    let badTimer := timers.find? fun key =>
      match field? value key with
      | some item => !timerOk item
      | none => false
    match badTimer with
    | some key => (some ([key], timerError), true)
    | none =>
      if (field? value "tools").isSome then (none, false)
      else
        match (keys value).filter (fun key => !timeoutKeys.contains key) with
        | [] => (none, true)
        | [key] =>
          (some ([key], s!"is not supported; use one of: {", ".intercalate timeoutKeys}"), true)
        | _ => (none, false)
  | _ =>
    (some ([], s!"must be a number of milliseconds or an object with {", ".intercalate timeoutKeys}"),
      true)

private def renderPath (root : String) (path : List String) : String :=
  ".".intercalate (root :: path)

/-- The outcome of the `MODEL` schema on a value with no reserved key. -/
inductive ModelCheck where
  | ok
  | threw (message : String)
  | outside (reason : String)

/-- `normalizeModelConfig`'s verdict for keys other than `provider`, `modelId` and `output`. Field
issues come in shape order. Unknown keys come after them, in an order this JSON cannot see, so two
unknown keys stop the model. -/
def checkModel (root : String) (model : Json) : ModelCheck :=
  let reasoning := field? model "reasoning"
  let providerOptions := field? model "providerOptions"
  let timeout := field? model "timeout"
  if (field? model "transcriptionModelId").isSome then
    .threw s!"{root}.transcriptionModelId was renamed to config.transcription.modelId"
  else
    let badReasoning := match reasoning with
      | some (.str level) => !reasoningLevels.contains level
      | some _ => true
      | none => false
    if badReasoning then
      .threw s!"{root}.reasoning must be one of: {", ".intercalate reasoningLevels}"
    else
      match providerOptions with
      | some (.obj _) | none =>
        match timeout with
        | none => checkUnknown
        | some value =>
          match timeoutIssue value with
          | (_, false) => .outside "per-tool timeout limits"
          | (some (path, message), true) =>
            .threw s!"{renderPath root ("timeout" :: path)} {message}"
          | (none, true) => checkUnknown
      | some _ => .threw s!"{root}.providerOptions must be an object"
where
  checkUnknown : ModelCheck :=
    match (keys model).filter (fun key => !modelSettingKeys.contains key) with
    | [] => .ok
    | [key] =>
      .threw (s!"{root}.{key} is not supported; use {root}.providerOptions " ++
        "for provider-specific settings")
    | _ => .outside "several unknown keys, whose order JSON here does not keep"

/-- `appendSystemInstructions`. `system` is `none` for `undefined`. -/
def appendSystemInstructions (system : Option Json) (instructions : String) : Json :=
  let appended := Json.mkObj [("role", toJson "system"), ("content", toJson instructions)]
  match system with
  | none => jarr [appended]
  | some (.str text) =>
    jarr [Json.mkObj [("role", toJson "system"), ("content", toJson text)], appended]
  | some (.arr items) => jarr (items.toList ++ [appended])
  | some other => jarr [other, appended]

/-- `selectWorkspaceRefs`: a record only picks among the agent's own refs. `none` is `undefined`. -/
def selectWorkspaceRefs (agentRefs channelRefs : Json) : Option Json :=
  match channelRefs with
  | .arr refs =>
    if refs.isEmpty then none
    else
      let named := refs.toList.map fun ref => field ref "workspaceId"
      let own := (arr? agentRefs).getD []
      some (jarr (own.filter fun ref => named.contains (field ref "workspaceId")))
  | _ => none

/-- `applyChannelRecord`: a record narrows and adds, and never grants what the agent lacks. -/
def applyChannelRecord (config record : Json) (channelName : String) : Json :=
  let channelConfig := field record "config"
  let channelSettings := field (field config "channels") channelName
  let workspaces := selectWorkspaceRefs (field config "workspaces") (field channelConfig "workspaces")
  let policies := uniq
    (((arr? (field config "policies")).getD []) ++ ((arr? (field channelConfig "policies")).getD []))
  let denyTools := match field channelConfig "denyTools" with
    | .arr denied =>
      if denied.isEmpty then none
      else some (uniq (((arr? (field config "denyTools")).getD []) ++ denied.toList))
    | _ => none
  let withAgent := match field channelConfig "instructions" with
    | .str "" => config
    | .str instructions =>
      setField config "agent"
        (setField (Json.mkObj (entries (field config "agent"))) "system"
          (appendSystemInstructions (field? (field config "agent") "system") instructions))
    | _ => config
  let withWorkspaces := match workspaces with
    | some refs => setField withAgent "workspaces" refs
    | none => withAgent
  let withPolicies :=
    if policies.isEmpty then withWorkspaces else setField withWorkspaces "policies" (jarr policies)
  let withDeny := match denyTools with
    | some denied => setField withPolicies "denyTools" (jarr denied)
    | none => withPolicies
  if fieldTruthy channelConfig "partition" then
    let settings := match channelSettings with
      | .obj _ => channelSettings
      | _ => Json.mkObj []
    setField withDeny "channels"
      (setField (Json.mkObj (entries (field config "channels"))) channelName
        (setField settings "partition" (field channelConfig "partition")))
  else withDeny

/-- `channelActorRoles`. -/
def channelActorRoles (record : Json) (userId : Json) : List Json :=
  if !truthy userId then []
  else
    let roles := (arr? (field (field record "config") "tagRoles")).getD []
    (roles.filter fun role => ((arr? (field role "userIds")).getD []).contains userId).map
      fun role => field role "roleId"

private def appendSystemTwin : Spec.Twin where
  source := recordSource ++ "#appendSystemInstructions"
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
    | .null, .str text => appendSystemInstructions none text
    | system, .str text => appendSystemInstructions (some system) text
    | _, _ => Spec.Twin.unsupported "instructions is not a string"

private def selectRefsTwin : Spec.Twin where
  source := recordSource ++ "#selectWorkspaceRefs"
  run := fun args =>
    (selectWorkspaceRefs (Spec.Twin.arg args 0) (Spec.Twin.arg args 1)).getD .null

private def applyRecordTwin : Spec.Twin where
  source := recordSource ++ "#applyChannelRecord"
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 2 with
    | config@(.obj _), .str channelName =>
      applyChannelRecord config (Spec.Twin.arg args 1) channelName
    | _, _ => Spec.Twin.unsupported "config is not an object or the channel name is not a string"

private def actorRolesTwin : Spec.Twin where
  source := recordSource ++ "#channelActorRoles"
  run := fun args => jarr (channelActorRoles (Spec.Twin.arg args 0) (Spec.Twin.arg args 1))

private def matchesWorkspaceTwin : Spec.Twin where
  source := recordSource ++ "#channelRecordMatchesWorkspace"
  run := fun args =>
    let recordRef := Spec.Twin.arg args 0
    let messageRef := Spec.Twin.arg args 1
    if !truthy recordRef || !truthy messageRef then toJson true
    else toJson (recordRef == messageRef)

private def resolveAgentTwin : Spec.Twin where
  source := recordSource ++ "#resolveChannelAgentId"
  run := fun args =>
    match field (field (Spec.Twin.arg args 0) "config") "agentBindings" with
    | .arr bindings =>
      let bindings := bindings.toList
      match bindings.find? (fun binding => fieldTruthy binding "isDefault") with
      | some binding => field binding "agentId"
      | none =>
        match bindings.head? with
        | some binding => field binding "agentId"
        | none => .null
    | _ => Spec.Twin.unsupported "agentBindings is not an array"

private def accountProviders : List String :=
  ["alibaba", "anthropic", "azure"]

/-- `channelRuntimeAgentConfig` for an agent whose runtime branches are absent or a checked `model`:
the full `AGENT_CONFIG` schema belongs to the config subsystem, so any other branch is left out. -/
private def runtimeConfigTwin : Spec.Twin where
  source := recordSource ++ "#channelRuntimeAgentConfig"
  run := fun args =>
    let target := Spec.Twin.arg args 0
    let holder := Spec.Twin.arg args 2
    match Spec.Twin.arg args 1 with
    | .str channelName =>
      let agentConfig := field (field target "agent") "config"
      let branches := (keys agentConfig).filter (· != "channels")
      if branches.any (· != "model") then
        Spec.Twin.unsupported "a runtime branch the config subsystem's schema decides"
      else
        let model := field? agentConfig "model"
        let modelOutside := match model with
          | some value =>
            (field? value "output").isSome || (field? value "provider").isNone ||
              (match checkModel "config.model" value with
                | .ok => false
                | _ => true)
          | none => false
        if modelOutside then Spec.Twin.unsupported "a model the full schema must judge"
        else
          let runtime := Json.mkObj (optEntry "model" model)
          let targetConfig :=
            if truthy (field (field agentConfig "channels") channelName) then
              setField runtime "channels" (field agentConfig "channels")
            else runtime
          let credential := field (field holder "channels") channelName
          let config :=
            if truthy credential then
              setField targetConfig "channels"
                (setField (Json.mkObj (entries (field targetConfig "channels"))) channelName credential)
            else targetConfig
          match field? target "record" with
          | some record => applyChannelRecord config record channelName
          | none => config
    | _ => Spec.Twin.unsupported "channel name is not a string"

/-- The twins in this file. -/
def recordTwins : List Spec.Twin :=
  [appendSystemTwin, selectRefsTwin, applyRecordTwin, actorRolesTwin, matchesWorkspaceTwin,
    resolveAgentTwin, runtimeConfigTwin]

end Spec.Channels
