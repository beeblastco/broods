import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign6/agent6b.tsv`.
-/

namespace Spec.Agent.Waveagent6b

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def isTrue (value : Json) : Bool :=
  value == toJson true

private def thisField (call : Json) (name : String) : Json :=
  Twin.field (Twin.self call) name

/-- Reads a property of something that is a `Session` instance or a test's plain object. -/
private def member (value : Json) (name : String) : Json :=
  let viaFields := Twin.field value name
  if isUndef viaFields then field value name else viaFields

private def fnJson (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

private def present (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

private def isUnsupported (error : Json) : Bool :=
  !isUndef (field error "$unsupported")

/-- `SUBAGENT_BUDGET_MS`, `subagents.ts:122`. -/
private def budgetMs : Nat := 15 * 60 * 1000

/-- `DEADLINE_WIND_DOWN_MS`, `harness.ts:173`. -/
private def windDownMs : Nat := 3 * 60 * 1000

/-- `PARENT_STOP_MESSAGE`, `harness.ts:196`. -/
private def parentStopMessage : String := "Stopped by the parent agent at the model boundary"

private def maxCallbacks : Nat := 64

/-- What `runTask`'s callbacks record. -/
structure RunTaskState where
  finalResponse : Json := undef
  approvalRequested : Bool := false

/-- `onErrorText` throws back into whoever called it, so it changes nothing here. -/
private def drainRunTask : Nat → RunTaskState → Prog RunTaskState
  | 0, state => pure state
  | limit + 1, state =>
    .input fun
      | none => pure state
      | some ("onFinalText", args) =>
        drainRunTask limit { state with finalResponse := Twin.arg args 0 }
      | some ("onErrorText", _) => drainRunTask limit state
      | some ("onApprovalRequired", _) =>
        drainRunTask limit { state with approvalRequested := true }
      | some (other, _) => Prog.unsupported s!"callback {other}"

private def childSessionOptions (task parent generation : Json) (accountId : Json) : Json :=
  let credential :=
    let direct := member parent "userCredential"
    if isUndef direct then Twin.field parent "#userCredential" else direct
  present
    [("eventId", field task "eventId"),
     ("conversationKey", field task "conversationKey"),
     ("accountId", accountId),
     ("agentId", field task "agentId"),
     ("agentConfig", field task "agentConfig"),
     ("endpointId", member parent "endpointId"),
     ("projectSlug", member parent "projectSlug"),
     ("stageSlug", member parent "stageSlug"),
     ("ownerGeneration", generation),
     ("trigger", member parent "trigger"),
     ("persist", field task "persistent"),
     ("policyDelivery", member parent "policyDelivery"),
     ("userConversationKey", member parent "userConversationKey"),
     ("userCredential", credential)]

private def runLoopOptions (task subagentParent deadline signal : Json) (lastTurn : Bool) : Json :=
  let persistent := isTrue (field task "persistent")
  present
    ([("subagentParent", subagentParent),
      ("isolatedSandbox", field task "isolatedSandbox"),
      ("deadlineMs", deadline),
      ("abortSignal", signal)] ++
     (if persistent && !lastTurn then
       [("parentLink", Json.mkObj [("note", fnJson "note")])] else []) ++
     (if persistent then
       [("stopMessage", toJson parentStopMessage),
        ("subagentWatch", Json.mkObj [("takeParentMessages", fnJson "takeParentMessages")])]
      else []))

/-- The `try` body of `runTask`, from the turn context to the finished run. -/
private def runTaskBody (task subagentParent publisher child deadline : Json)
    (lastTurn : Bool) (incoming : Json) : Prog Json := do
  let turnContext ← Prog.effect "this.createChildTurnContext" [child, task, incoming]
  let signal ← Prog.effect "AbortSignal.any"
    [.arr #[Json.mkObj [("$signal", toJson false)], Json.mkObj [("$signal", toJson false)],
      Json.mkObj [("$signal", toJson false)]]]
  let callbacks := Json.mkObj
    [("onFinalText", fnJson "onFinalText"), ("onErrorText", fnJson "onErrorText"),
     ("onApprovalRequired", fnJson "onApprovalRequired")]
  let stream ← Prog.effect "runAgentLoop"
    [child, turnContext, field task "agentConfig", callbacks,
     runLoopOptions task subagentParent deadline signal lastTurn]
  let state ← drainRunTask maxCallbacks {}
  let consumed ←
    if isUndef publisher then Prog.attempt "stream.consumeStream"
    else Prog.attempt "pipeSubagentNatsStream" [stream, publisher]
  let state ← drainRunTask maxCallbacks state
  match consumed with
  | .threw error _ => throw error
  | _ => pure ()
  if state.approvalRequested then
    return ← Prog.throwError "Error" "Subagent task stopped for tool approval"
  if isTrue (← Prog.effect "stream.didFail") then
    let text ← Prog.effect "stream.failureText"
    return ← Prog.throwError "Error"
      (if isUndef text then "Subagent task failed" else (text.getStr?).toOption.getD "")
  let question ← Prog.effect "stream.parentQuestion"
  let finish :=
    if !isUndef question then
      some (Json.mkObj [("status", toJson "awaiting_input"), ("message", question)])
    else if isUndef state.finalResponse then none
    else some (Json.mkObj [("status", toJson "completed"), ("response", state.finalResponse)])
  match finish with
  | none => Prog.throwError "Error" "Subagent task returned an empty response"
  | some value => Prog.effect "this.completeRun" [child, task, value]

/-- `SubagentCoordinator.runTask`. The three abort signals are never aborted in the recordings, and
`AbortController` state is not recorded, so they are written as not aborted. -/
def runTask (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let subagentParent := Twin.callArg call 1
  let publisher := Twin.callArg call 2
  let preOwned := Twin.callArg call 3
  let parent := thisField call "parentSession"
  let promptMessage ← Prog.effect "userText" [field task "prompt"]
  let incoming :=
    if isUndef preOwned then Json.arr #[promptMessage] else field preOwned "events"
  let persistent := isTrue (field task "persistent")
  let admitted ←
    if !isUndef preOwned then
      pure (Json.mkObj
        [("ownerGeneration", field preOwned "ownerGeneration"), ("charged", toJson false)])
    else if persistent then
      Prog.effect "this.admitChildConversation" [task, promptMessage]
    else pure undef
  let lastTurn := isTrue (field task "lastTurn") && !isTrue (field admitted "charged")
  let accountId ← Prog.effect "requireParentAccountId" [parent]
  if !isUndef (member parent "principal") then
    return ← Prog.unsupported "a delegated principal is not modelled"
  let child ← Prog.effect "new Session"
    [childSessionOptions task parent (field admitted "ownerGeneration") accountId]
  let now ← Prog.effect "Date.now"
  let deadline := match now.getNat? with
    | .ok value => toJson (value + budgetMs)
    | .error _ => undef
  let timer ← Prog.effect "setTimeout" [fnJson "", toJson (budgetMs + windDownMs)]
  let _ ← Prog.effect "budgetTimer.unref"
  let result ← Prog.catchFail
    (do
      let value ← runTaskBody task subagentParent publisher child deadline lastTurn incoming
      let _ ← Prog.effect "clearTimeout" [timer]
      return value)
    (fun error => do
      if isUnsupported error then throw error
      let message ← Prog.effect "toErrorMessage" [error]
      let recorded ← Prog.attempt "this.recordOutcome"
        [child, task, Json.mkObj [("status", toJson "failed"), ("error", message)]]
      match recorded with
      | .threw recordError _ =>
        let _ ← Prog.effect "toErrorMessage" [recordError]
      | _ => pure ()
      let _ ← Prog.attempt "childSession.releaseConversationLease"
      let _ ← Prog.effect "clearTimeout" [timer]
      throw error)
  return result

private def mapGet (value key : Json) : Option Json :=
  let pairs := (field value "$map").getArr?.toOption.getD #[]
  (pairs.toList.find? (fun pair => Twin.arg pair 0 == key)).map (Twin.arg · 1)

private def liveFor (call : Json) (conversationKey taskId : Json) : Option Json :=
  match mapGet (Twin.moduleValue call "liveChildren") conversationKey with
  | some live => if field live "taskId" == taskId then some live else none
  | none => none

/-- `MESSAGE_TURN_BUDGET`. -/
private def messageTurnBudget : Nat := 40

/-- `MESSAGE_TURNS_SPENT`. -/
private def messageTurnsSpent : String :=
  "Agents in this run already started 40 turns by messaging each other. Finish with what you have."

/-- `SubagentCoordinator.admitChildConversation`. Reads the abort signals as not aborted, because
the recorder does not keep `AbortController` state: a stop during admission is not modelled. The
`payer?.` release after a failure is an optional-chain call, which the recorder does not trace. -/
def admitChildConversation (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let promptMessage := Twin.callArg call 1
  let payer := field task "payer"
  let key := field task "conversationKey"
  let ours := liveFor call key (field task "taskId")
  let settle (admitted : Bool) : Prog Unit := do
    if let some live := ours then
      let _ ← Prog.effect "settleLive" [key, live, toJson admitted]
  let hasPayer := !isUndef payer
  let claimed ←
    if hasPayer then Prog.attempt "payer.parentSession.claimMessageTurn" [toJson messageTurnBudget]
    else pure (.ok (toJson false))
  match claimed with
  | .threw error _ =>
    settle false
    throw error
  | _ => pure ()
  let charged := match claimed with
    | .ok value => isTrue value
    | _ => false
  let release : Prog Unit := settle false
  if hasPayer && !charged && !isTrue (field task "lastTurn") then
    release
    return ← Prog.throwError "Error" messageTurnsSpent
  Prog.catchFail
    (do
      let accepted ←
        if ours.isSome then do
          let candidate ← Prog.effect "this.childCandidate" [task, .arr #[promptMessage]]
          Prog.effect "acceptIngress" [candidate]
        else pure (Json.mkObj [("outcome", toJson "rejected")])
      let generation ← Prog.effect "ownedGeneration" [accepted]
      settle true
      return Json.mkObj [("ownerGeneration", generation), ("charged", toJson charged)])
    (fun error => do
      if isUnsupported error then throw error
      release
      throw error)

/-- `SubagentCoordinator.takeFollowUp`. The abort signals read as not aborted, as above. -/
def takeFollowUp (call : Json) : Prog Json := do
  let turn := Twin.callArg call 0
  let completion := Twin.callArg call 1
  let key := field turn "conversationKey"
  let taskId := field turn "taskId"
  let some live := liveFor call key taskId | return undef
  let self := Twin.self call
  let payer := if isUndef (field live "sender") then self else field live "sender"
  let inbox := (field live "inbox").getArr?.toOption.getD #[]
  let stop : Prog Bool := do
    if inbox.isEmpty then return true
    return isTrue (← Prog.effect "stoppedOnPurpose" [completion])
  if ← stop then
    let _ ← Prog.effect "settleLive" [key, live, toJson false]
    return undef
  let _ ← Prog.effect "pendingAdmission"
  let parent := thisField call "parentSession"
  let accountId ← Prog.effect "requireParentAccountId" [parent]
  let subTask ← Prog.effect "createSubagentTaskId" [member parent "eventId"]
  let eventId ← Prog.effect "scopedDirectEventId" [accountId, field turn "agentId", subTask]
  let runId ← Prog.effect "createRunId"
  let prompt := "\n\n".intercalate
    (inbox.toList.map fun item => (item.getStr?).toOption.getD "")
  let next := [("eventId", eventId), ("runId", runId), ("prompt", toJson prompt),
      ("payer", payer), ("inheritedContext", toJson false), ("resuming", toJson true),
      ("lastTurn", toJson true)].foldl (fun acc (entry : String × Json) =>
        acc.setObjVal! entry.1 entry.2) turn
  for name in ["pendingMetadata", "detached"] do
    if (mapGet (thisField call name) taskId).isSome then
      let _ ← Prog.effect "taskMetadata" [next]
  return next

/-- `NOTE_DELIVERED`. -/
private def noteDelivered : List String := ["owner","queued","duplicate","conflict"]

/-- `SubagentCoordinator.noteFromChild`. `closed` is the value at entry: a close during the claim
is not visible to the twin. -/
def noteFromChild (call : Json) : Prog Json := do
  let taskId := Twin.callArg call 0
  let message := Twin.callArg call 1
  let metadata := Twin.param call 2
  let exchange := field message "exchangeId"
  let refused (note : String) : Json :=
    Json.mkObj [("status", toJson "not_delivered"), ("exchangeId", exchange), ("note", toJson note)]
  let notReading :=
    refused "Your parent is not reading messages now. Put it in your final answer instead."
  if isTrue (thisField call "closed") || isUndef metadata then return notReading
  let session := thisField call "parentSession"
  if !isTrue (← Prog.effect "this.parentSession.claimMessageTurn" [toJson messageTurnBudget]) then
    return refused messageTurnsSpent
  let nonce ← Prog.effect "noteNonce" [taskId, field message "text"]
  let send : Prog Outcome := do
    let id ← Prog.effect "createSubagentTaskId" [member session "eventId", nonce]
    let body ← Prog.effect "noteToParentMessage" [metadata, message, nonce]
    Prog.attempt "this.resumeParent" [session, id, body, undef]
  let first ← send
  let final ← match first with
    | .threw _ _ => send
    | other => pure other
  let outcome ← match final with
    | .ok value => pure value
    | .threw error _ => Prog.effect "toErrorMessage" [error]
    | .pending => Prog.unsupported "resumeParent never finished"
  let text := (outcome.getStr?).toOption.getD ""
  if !noteDelivered.contains text then
    let _ ← Prog.effect "this.parentSession.releaseMessageTurn"
    return if text == "closed" then notReading
      else refused s!"Your parent could not take the note: {text}."
  return Json.mkObj
    [("status", toJson "delivered"), ("exchangeId", exchange),
     ("note", toJson "Your parent reads it at its next step.")]

/-- `Session.ensureResolvedRuntime`. A later call awaits the first call's promise, whose value is
what `resolvedRuntime` holds by then. -/
def ensureResolvedRuntime (call : Json) : Prog Json := do
  let key := thisField call "conversationKey"
  let scope ← Prog.effect "channelScopeKeyFromConversation" [key]
  let conversation ← Prog.effect "channelScopeKeyFromConversation" [key, toJson "conversation"]
  if !isUndef (thisField call "resolvedRuntimePromise") then
    let resolved := thisField call "resolvedRuntime"
    if isUndef resolved || (resolved.compress.splitOn "too-deep").length > 1 then
      return ← Prog.unsupported "the first call's result is not in the recording"
    return resolved
  if ((thisField call "agentConfig").compress.splitOn "too-deep").length > 1 then
    return ← Prog.unsupported "agentConfig is cut off in the recording"
  let partition ← Prog.effect "this.channelPartition"
  let delivery := thisField call "delivery"
  let channelName :=
    if field delivery "kind" == toJson "channel" then field delivery "channelName" else undef
  let userKey := thisField call "userConversationKey"
  Prog.effect "resolveAgentRuntime"
    [thisField call "agentConfig",
     Json.mkObj [("accountId", thisField call "accountId"), ("agentId", thisField call "agentId")],
     present
       [("channelName", channelName), ("channelScopeKey", scope),
        ("conversationKey", conversation), ("partition", partition),
        ("userConversationKey", if userKey == toJson "" then undef else userKey)]]

/-- `messageTurnsKey`. -/
def messageTurnsKey (call : Json) : Prog Json := do
  let root ← Prog.effect "rootEventId" [Twin.callArg call 0]
  return toJson s!"message-turns:{(root.getStr?).toOption.getD ""}"

private def coord (name : String) : String :=
  s!"apps/core/src/harness/subagents.ts#SubagentCoordinator.{name}"

private def session (name : String) : String :=
  s!"apps/core/src/harness/session.ts#{name}"

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [ Twin.traced (session "messageTurnsKey") messageTurnsKey ]

/-- Written and right on the calls they can see, but each has recordings that depend on what the
recorder does not keep. They stay out of `twins` until it does; see the findings file. -/
def blockedOnRecorder : List Spec.Twin :=
  [ Twin.traced (session "Session.ensureResolvedRuntime") ensureResolvedRuntime
  , Twin.traced (coord "runTask") runTask
  , Twin.traced (coord "admitChildConversation") admitChildConversation
  , Twin.traced (coord "noteFromChild") noteFromChild
  , Twin.traced (coord "takeFollowUp") takeFollowUp ]

end Spec.Agent.Waveagent6b
