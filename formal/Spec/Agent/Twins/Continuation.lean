import Spec.Twin

/-!
Twins of `apps/core/src/harness/continuation.ts`. `runParentPasses` is the worked example of a traced
twin over orchestration: a loop with concurrent work, callbacks the model loop drives, and failure paths.
-/

namespace Spec.Agent.Continuation

open Lean Spec

/-- `USER_STOP_MESSAGE` in `harness.ts`. -/
def userStopMessage : String := "Stopped by user at the model boundary"

/-- The most passes one run makes in the recordings' model. The TypeScript loop has no bound. -/
def maxPasses : Nat := 64

/-- The most callbacks one pass enters. -/
def maxCallbacks : Nat := 256

/-- What callbacks and passes accumulate. -/
structure PassState where
  finalResponse : Option Json := none
  traceId : Option Json := none
  approvals : Json := .arr #[]

private def isUndefined (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

private def present (value : Option Json) : Option Json :=
  value.bind fun item => if isUndefined item then none else some item

/-- `passResult`: optional keys appear only when set, then the overrides win. -/
private def passResult (state : PassState) (overrides : List (String × Json)) : Json :=
  let base : List (String × Json) :=
    [("didFail", toJson false), ("failureText", Json.null)] ++
    (match state.finalResponse with | some value => [("finalResponse", value)] | none => []) ++
    (match present state.traceId with | some value => [("traceId", value)] | none => []) ++
    [("approvals", .arr #[]), ("questions", .arr #[])]
  Json.mkObj (base.filter (fun entry => !(overrides.any (·.1 == entry.1))) ++ overrides)

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def isTrue (value : Json) : Bool :=
  value.compress == (toJson true).compress

private def isEmptyArray (value : Json) : Bool :=
  match value with
  | .arr items => items.isEmpty
  | _ => false

private def fn (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

private def options (call : Json) : Json := Twin.callArg call 0

private def hasFn (value : Json) (name : String) : Bool :=
  !isUndefined (field value name)

private def lastOf (value : Json) : Json :=
  match value with
  | .arr items => items.back?.getD Twin.undefinedJson
  | _ => Twin.undefinedJson

/-- Enters the callbacks handed to `runAgentLoop`. A callback the caller did not supply does nothing. -/
private def handleCallback (opts : Json) (stateRef : PassState) (label : String) (args : Json) :
    Prog PassState := do
  let first := Twin.arg args 0
  match label with
  | "onFinalText" => pure { stateRef with finalResponse := some first }
  | "onErrorText" =>
    if hasFn opts "onLoopErrorText" then
      let _ ← Prog.effect "options.onLoopErrorText" [first]
    pure stateRef
  | "onApprovalRequired" =>
    let next := { stateRef with approvals := first }
    if hasFn opts "onApprovalRequired" then
      let _ ← Prog.effect "options.onApprovalRequired" [first]
    pure next
  | "onQuestionsPending" =>
    if hasFn opts "onQuestionsPending" then
      let _ ← Prog.effect "options.onQuestionsPending" [first]
    pure stateRef
  | "onHeartbeat" =>
    if hasFn opts "onHeartbeat" then
      let _ ← Prog.effect "options.onHeartbeat" [first]
    pure stateRef
  | other => Prog.unsupported s!"callback {other}"

/-- A callback's own failure goes back to whoever called it, so the twin keeps going. -/
private def drainCallbacks (opts : Json) : Nat → PassState → Prog PassState
  | 0, state => pure state
  | limit + 1, state =>
    .input fun
      | none => pure state
      | some (label, args) =>
        Prog.catchFail (handleCallback opts state label args) (fun _ => pure state) |>.bind
          (drainCallbacks opts limit)

private def agentLoopOptions (opts hooks : Json) : Json :=
  let context := field opts "context"
  let contextKeys : List (String × Json) :=
    if isUndefined context then [] else
      (if isUndefined (field context "abortSignal") then []
        else [("abortSignal", field context "abortSignal")]) ++
      [("deadlineMs", field context "deadlineMs"),
       ("canYield", toJson (!isUndefined (field context "yieldSlot")))]
  Json.mkObj
    ([("dispatchSubagents", fn "dispatch"),
      ("messageChild", fn "messageChild"),
      ("subagentWatch", field opts "subagentCoordinator"),
      ("dispatchSessionMessage", fn "dispatchSessionMessage"),
      ("pendingWork", fn "pendingWork"),
      ("hooks", hooks)] ++ contextKeys)

private def callbacksArgument : Json :=
  Json.mkObj
    [("onFinalText", fn "onFinalText"),
     ("onErrorText", fn "onErrorText"),
     ("onApprovalRequired", fn "onApprovalRequired"),
     ("onQuestionsPending", fn "onQuestionsPending")]

private def heartbeatArgument : Json :=
  Json.mkObj [("onHeartbeat", fn "onHeartbeat")]

private def aborted (opts : Json) : Bool :=
  isTrue (field (field (field opts "context") "abortSignal") "aborted") ||
  isTrue (Twin.field (field (field opts "context") "abortSignal") "aborted")

/-- `keepAsyncResultsOnFailure`: a failure while waiting is logged, not raised. -/
private def keepAsyncResults (opts : Json) (failed stopped : Bool) (state : PassState) :
    Prog PassState := do
  if !failed || stopped || aborted opts then
    return state
  let next ← Prog.catchFail
    (do
      let _ ← Prog.effect "waitAndDrainAsyncWork"
        [field opts "subagentCoordinator", heartbeatArgument]
      drainCallbacks opts maxCallbacks state)
    (fun _ => pure state)
  return next

/-- One pass of the `for (;;)` loop, repeated at most `maxPasses` times. -/
private def passes (opts hooks : Json) : Nat → Json → PassState → Prog Json
  | 0, _, _ => Prog.unsupported "more passes than the model allows"
  | fuel + 1, turnContext, state => do
    let state ← drainCallbacks opts maxCallbacks state
    let stream ← Prog.effect "runAgentLoop"
      [field opts "session", turnContext, field opts "agentConfig", callbacksArgument,
       agentLoopOptions opts hooks]
    let state ← drainCallbacks opts maxCallbacks state
    let traceId ← Prog.effect "stream.traceId"
    let state := { state with traceId := some traceId }
    let state ← drainCallbacks opts maxCallbacks state
    let _ ← Prog.effect "options.consumeStream" [stream]
    let yielded ← Prog.effect "stream.yielded"
    if isTrue yielded then
      let next ← Prog.effect "resumeAfterYield"
        [field opts "session", field opts "context", field turnContext "ephemeralSystem"]
      return ← passes opts hooks fuel next state
    if !isEmptyArray state.approvals then
      return passResult state [("approvals", state.approvals)]
    let questions ← Prog.effect "stream.questionSummaries"
    if !isEmptyArray questions then
      return passResult state [("questions", questions)]
    let failureText ← Prog.effect "stream.failureText"
    let stopped := failureText.compress == (toJson userStopMessage).compress
    if stopped then
      let _ ← Prog.effect "options.subagentCoordinator.stopChildren"
    let didFail ← Prog.effect "stream.didFail"
    let state ← keepAsyncResults opts (isTrue didFail) stopped state
    let didFailAgain ← Prog.effect "stream.didFail"
    if isTrue didFailAgain then
      let text ← Prog.effect "stream.failureText"
      return passResult state [("didFail", toJson true), ("failureText", text)]
    let state ← drainCallbacks opts maxCallbacks state
    let injected ← Prog.effect "waitAndDrainAsyncWork"
      [field opts "subagentCoordinator", heartbeatArgument]
    let state ← drainCallbacks opts maxCallbacks state
    if injected.compress == (toJson (0 : Nat)).compress then
      return passResult state []
    let next ← Prog.effect "options.session.createTurnContext"
    let runnable ← Prog.effect "isRunnableModelInput" [lastOf (field next "messages")]
    if !isTrue runnable then
      return passResult state []
    passes opts hooks fuel next state

/-- `runParentPasses`. -/
def runParentPasses (call : Json) : Prog Json := do
  let opts := options call
  let suppliedHooks := field opts "hooks"
  let hooks ←
    if isUndefined suppliedHooks then
      Prog.effect "createAgentHookDispatcher"
        [Twin.field (field opts "session") "accountId", field opts "agentConfig"]
    else
      pure suppliedHooks
  let _ ← Prog.effect "options.subagentCoordinator.attachHooks" [hooks]
  passes opts hooks maxPasses (field opts "initialTurnContext") {}

/-- This file's twins. -/
def continuationTwins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/continuation.ts#runParentPasses" runParentPasses]

end Spec.Agent.Continuation
