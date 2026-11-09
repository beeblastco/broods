import Spec.Twin
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

/-!
Twins for the functions listed in `.lake/worklist/assign4/runs4a.tsv`.
-/

namespace Spec.Runs.Waveruns4a

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def text (value : Json) : String := value.getStr?.toOption.getD ""
private def items (value : Json) : List Json := value.getArr?.toOption.getD #[] |>.toList
private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def truthy (value : Json) : Bool := !undef value && Access.Js.truthy value
private def nullish (value : Json) : Bool := undef value || value == Json.null
private def anon : Json := Json.mkObj [("$fn", .str "")]
private def named (name : String) : Json := Json.mkObj [("$fn", .str name)]

/-- An object literal. The recorder drops `undefined` values from plain objects. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

/-- `{...base, ...entries}`, leaving out the recorder's own bookkeeping keys. -/
private def spread (base : Json) (entries : List (String × Json)) : Json :=
  let source := if undef base then [] else Access.Js.entries base
  let kept := source.filter fun entry =>
    entry.1 != "$keys" && !entries.any (·.1 == entry.1)
  obj (kept ++ entries)

/-- `...(cond ? { key: value } : {})` for a truthy value. -/
private def whenTruthy (key : String) (value : Json) : List (String × Json) :=
  if truthy value then [(key, value)] else []

/-- `err instanceof Error ? err.message : fallback`. -/
private def errorMessageOr (error : Json) (fallback : String) : String :=
  match (error.getObjVal? "$error").toOption with
  | some body => text (field body "message")
  | none => fallback

/-- Runs the only callback a call can enter. Its failure goes back to whoever called it. -/
private def drainOne (label : String) (body : Json → Prog Unit) : Prog Unit :=
  Prog.drain (fun entered args =>
    if entered == label then Prog.catchFail (body args) (fun _ => pure ())
    else Prog.unsupported s!"callback {entered}") 8

/-- `commandOutcome`: `send` frames follow the reply; a throw becomes a failed outcome. -/
def commandOutcome (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let command := Twin.callArg call 1
  let send := Twin.callArg call 2
  let eventId := Twin.field session "eventId"
  let context := obj
    [("conversationKey", Twin.field session "conversationKey"),
     ("channel", Twin.field session "channelActions"),
     ("accountId", Twin.field session "accountId"),
     ("agentId", Twin.field session "agentId"),
     ("eventId", eventId),
     ("text", field command "text"),
     ("compact", named "compact")]
  drainOne "compact" fun args => do
    let _ ← Prog.effect "runCompactCommand" [session, field command "text", Twin.arg args 0]
  let executed ← Prog.attempt "executeCommand" [field command "commandToken", context]
  match executed with
  | .threw error _ =>
    return obj [("status", .str "failed"),
      ("error", .str (errorMessageOr error "Queued command failed"))]
  | .pending => Prog.unsupported "command never finished"
  | .ok result =>
    let reply := field result "reply"
    let reply := if nullish reply then Json.str "" else reply
    let framed : Prog Unit := do
      if !undef send then
        let _ ← Prog.effect "send" [obj [("type", .str "text-start"), ("id", eventId)]]
        let _ ← Prog.effect "send"
          [obj [("type", .str "text-delta"), ("id", eventId), ("text", reply)]]
        let _ ← Prog.effect "send" [obj [("type", .str "text-end"), ("id", eventId)]]
    Prog.catchFail
      (do
        framed
        if undef (field result "error") then
          return obj [("status", .str "completed"), ("response", reply)]
        return obj [("status", .str "failed"), ("error", field result "error")])
      (fun error => return obj [("status", .str "failed"),
        ("error", .str (errorMessageOr error "Queued command failed"))])

/-- `prepareDirectTurn`: a failed preparation settles the run, drains the queue and rethrows. -/
def prepareDirectTurn (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let session ← Prog.effect "directSession" [event]
  let startedAt ← Prog.effect "Date.now"
  match ← Prog.attempt "session.createTurnContext" [field event "ephemeralSystem", field event "events"] with
  | .ok turnContext => return obj [("session", session), ("turnContext", turnContext)]
  | .pending => Prog.unsupported "turn context never finished"
  | .threw error _ =>
    let _ ← Prog.effect "recordFailedTurn" [session, startedAt, error]
    drainOne "arg2" fun _ => do
      let _ ← Prog.effect "dispatchNextIngress" [session, event]
    let settled ← Prog.attempt "settleFailedIngressAndDrain"
      [session, .str (errorMessageOr error "Direct turn preparation failed"), anon]
    match settled with
    | .threw settleError _ => throw settleError
    | _ => throw error

/-- The checks `handleDirectRequest` and `handleAsyncRequest` share. `none` means keep going. -/
private def admissionGate (event : Json) : Prog (Option Json) := do
  let admitted ← Prog.effect "admitRun" [field event "accountId"]
  if truthy (field admitted "refusal") then
    return some (← Prog.effect "planRefusalResponse" [field admitted "refusal"])
  if !(items (field event "answers")).isEmpty then
    return some (← Prog.effect "handleDirectAnswers" [event])
  if truthy (field event "continuation") then
    return some (← Prog.effect "handleContinueRequest" [event])
  return none

/-- The `acceptIngress` argument both request kinds build. -/
private def ingressRequest (event delivery : Json) : Json :=
  obj ([("accountId", field event "accountId"),
        ("agentId", field event "agentId"),
        ("eventId", field event "eventId"),
        ("runId", field event "runId"),
        ("conversationKey", field event "conversationKey"),
        ("events", field event "events"),
        ("requestedMode", field event "requestedMode"),
        ("idempotencyKey", field event "idempotencyKey"),
        ("delivery", delivery),
        ("configRef", field event "configRef")] ++
       whenTruthy "ephemeralSystem" (field event "ephemeralSystem"))

private def publicIds (event : Json) : List (String × Json) :=
  [("publicEventId", field event "publicEventId"),
   ("publicConversationKey", field event "publicConversationKey")]

/-- `handleDirectRequest`. `directStatusUrl` runs once to test and again to read when set. -/
def handleDirectRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  if let some response ← admissionGate event then
    return response
  if !truthy (← Prog.effect "hasRunnableDirectEvents" [event]) then
    return ← Prog.effect "emptySseResponse"
  let connectionId := field event "connectionId"
  let statusProbe ← Prog.effect "directStatusUrl" [event]
  let statusEntry ←
    if truthy statusProbe then
      pure [("statusUrl", ← Prog.effect "directStatusUrl" [event])]
    else pure []
  let head : List (String × Json) :=
    if truthy connectionId then
      [("kind", .str "websocket")] ++ publicIds event ++ [("connectionId", connectionId)]
    else
      [("kind", .str "http")] ++ publicIds event
  let delivery := obj (head ++ statusEntry ++
    whenTruthy "publicDeploymentIngress" (field event "publicDeploymentIngress"))
  let admission ← Prog.effect "acceptIngress" [ingressRequest event delivery]
  let _ ← Prog.effect "dispatchRecoveredIngress" [event, admission]
  if text (field admission "outcome") != "owner" then
    return ← Prog.effect "directAdmissionResponse" [event, admission, .bool (truthy connectionId)]
  let owned := spread event [("ownerGeneration", field admission "ownerGeneration")]
  if truthy connectionId then
    match ← Prog.attempt "invokeNatsWorker" [owned] with
    | .threw error _ =>
      let _ ← Prog.effect "failOwnedIngress"
        [owned, .str (errorMessageOr error "Failed to start WebSocket worker")]
      throw error
    | .pending => Prog.unsupported "worker start never finished"
    | .ok _ =>
      let url ← Prog.effect "directStatusUrl" [event]
      return ← Prog.effect "natsStartResponse" [event, field event "publicEventId", url]
  Prog.effect "directTurnResponse" [owned]

/-- `handleAsyncRequest`. -/
def handleAsyncRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  if let some response ← admissionGate event then
    return response
  if !truthy (← Prog.effect "hasRunnableDirectEvents" [event]) then
    return ← Prog.effect "errorResponse"
      [toJson (400 : Nat), .str "Request must include at least one user event or tool approval response"]
  let delivery := obj ([("kind", .str "async")] ++ publicIds event ++
    [("statusUrl", field event "statusUrl")] ++
    whenTruthy "publicDeploymentIngress" (field event "publicDeploymentIngress"))
  let admission ← Prog.effect "acceptIngress" [ingressRequest event delivery]
  let _ ← Prog.effect "dispatchRecoveredIngress" [event, admission]
  if text (field admission "outcome") != "owner" then
    return ← Prog.effect "asyncAdmissionResponse" [event, admission]
  let _ ← Prog.effect "startOwnedAsyncRun"
    [spread event [("ownerGeneration", field admission "ownerGeneration")]]
  Prog.effect "acceptedAsyncResponse"
    [field event "runId", field event "statusUrl", event, .str "processing"]

/-- `handleChannelRequest`: a command reply skips the queue; a full queue tells the channel or throws. -/
def handleChannelRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let command ← Prog.effect "resolveChannelCommand" [event]
  if text (field command "kind") == "reply" then
    return ← Prog.effect "admitChannelMessage" [event]
  drainOne "arg0" fun _ => do
    let _ ← Prog.effect "admitChannelMessage" [event]
  let placed ← Prog.attempt "withQueuePlace" [anon]
  let held ← match placed with
    | .ok value => pure value
    | .threw error _ => throw error
    | .pending => Prog.unsupported "queue place never finished"
  if truthy held then
    return Twin.undefinedJson
  let refusal ←
    if truthy (field event "accountId") then do
      let admitted ← Prog.effect "admitRun"
        [field event "accountId", obj [("count", .bool false)]]
      pure (field admitted "refusal")
    else pure Json.null
  if !truthy refusal then
    Prog.throwError "Error" "In-process worker queue is full"
  let message ← Prog.effect "planRefusalText" [refusal]
  let _ ← Prog.effect "event.channel.sendText" [message]
  return Twin.undefinedJson

/-- `OUTPUT_TAIL` in `apply-runs.ts`. -/
private def outputTail : Nat := 4000

private def isWordChar (c : Char) : Bool := c.isAlphanum || c == '_'

/-- `/^::phase (\w+) (\d+)$/` on a trimmed line: the phase name and its number. -/
private def phaseLine (line : String) : Option (String × Nat) :=
  match line.splitOn " " with
  | ["::phase", name, digits] =>
    if !name.isEmpty && name.all isWordChar && !digits.isEmpty && digits.all Char.isDigit then
      digits.toNat?.map (name, ·)
    else none
  | _ => none

/-- `handleApplyRunRequest`. The two `JSON.parse` calls are computed; everything else is an effect. -/
def handleApplyRunRequest (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  if text (field request "method") != "POST" then
    return ← Prog.effect "methodNotAllowed" [.arr #[.str "POST"]]
  let headers := field request "headers"
  let token ← Prog.effect "extractBearerToken" [field headers "authorization"]
  let unauthorized : Json := toJson (401 : Nat)
  if !truthy token then
    return ← Prog.effect "errorResponse" [unauthorized, .str "Unauthorized"]
  if !truthy (← Prog.effect "isServiceToken" [headers, token]) then
    return ← Prog.effect "errorResponse" [unauthorized, .str "Unauthorized"]
  let sandboxJson ← Prog.effect "optionalEnv" [.str "APPLY_SANDBOX"]
  let baseUrl ← Prog.effect "getHarnessPublicUrl"
  if !truthy sandboxJson || !truthy baseUrl then
    return ← Prog.effect "errorResponse"
      [toJson (503 : Nat), .str "Apply needs APPLY_SANDBOX and PUBLIC_BASE_URL on core"]
  let some body := (Json.parse (text (field request "body"))).toOption
    | Prog.unsupported "body is not JSON"
  let parsed ← Prog.effect "applyRunSchema.safeParse" [body]
  if !truthy (field parsed "success") then
    return ← Prog.effect "errorResponse" [toJson (400 : Nat), .str "Invalid apply run"]
  let run := field parsed "data"
  let some rawSandbox := (Json.parse (text sandboxJson)).toOption
    | Prog.unsupported "APPLY_SANDBOX is not JSON"
  let sandbox ← Prog.effect "normalizeSandboxConfig" [rawSandbox]
  if text (field sandbox "provider") == "worker" then
    return ← Prog.effect "errorResponse"
      [toJson (503 : Nat), .str "APPLY_SANDBOX needs a sandbox that runs bun, not a shell-only one"]
  let startedAt ← Prog.effect "Date.now"
  let reservation ← Prog.effect "normalizeFilesystemNamespace"
    [.str s!"apply:{text (field run "accountId")}:{text (field run "stageId")}:{text (field run "lockHash")}"]
  let specs ← Prog.effect "resolveSandboxSpecs"
    [obj [("provider", field sandbox "provider"), ("size", field sandbox "size")]]
  let config := spread sandbox
    [("persistent", .bool true),
     ("options", spread (field sandbox "options") [("reservationKey", reservation)]),
     ("envVars", spread (field sandbox "envVars")
       [("BROODS_TOKEN", field run "ticket"),
        ("APPLY_BASE_URL", baseUrl),
        ("BROODS_PROJECT", field run "project"),
        ("BROODS_STAGE", field run "stage"),
        ("CI", .str "true")]),
     ("controlPlane", obj
       [("accountId", field run "accountId"),
        ("projectId", field run "projectId"),
        ("stageId", field run "stageId"),
        ("name", .str "apply"),
        ("specs", specs)])]
  let scripts ← Prog.effect "applyScripts" [run]
  let result ← Prog.effect "runScripts" [config, scripts]
  let lines := (text (field result "stdout") ++ "\n" ++ text (field result "stderr")).splitOn "\n"
  let phases := lines.filterMap fun line => phaseLine (Access.Js.trim line)
  let output := Access.Js.trim
    ("\n".intercalate (lines.filter fun line => (phaseLine (Access.Js.trim line)).isNone))
  if !Access.Js.isAscii output then
    Prog.unsupported "slice counts UTF-16 units"
  let finishedAt ← Prog.effect "Date.now"
  let exitCode := field result "exitCode"
  let elapsed : Int :=
    (finishedAt.getInt?.toOption.getD 0) - (startedAt.getInt?.toOption.getD 0)
  Prog.effect "jsonResponse"
    [toJson (200 : Nat),
     Json.mkObj
      [("ok", field result "ok"),
       ("exitCode", if nullish exitCode then Json.null else exitCode),
       ("durationMs", toJson elapsed),
       ("phases", Json.mkObj (phases.map fun (name, value) => (name, toJson value))),
       ("output", .str (String.ofList (output.toList.drop (output.length - outputTail))))]]

/-- What `handleAsyncWorkerRequest` remembers across its callbacks and its failure path. -/
private structure AsyncRun where
  session : Json := Twin.undefinedJson
  outcome : Option Json := none
  recorded : Bool := false
  cronSettled : Bool := false
  transferred : Bool := false

private def failed (error : String) : Json :=
  obj [("status", .str "failed"), ("error", .str error)]

/-- `finish`: the first outcome wins and a later call only retries a failed write. -/
private def finish (event : Json) (run : AsyncRun) (result : Json) :
    Prog (AsyncRun × Option Json) := do
  if run.recorded then
    return (run, none)
  let outcome := run.outcome.getD result
  let run := { run with outcome := some outcome }
  match ← Prog.attempt "settleAsyncRun" [run.session, event, outcome] with
  | .threw error _ => return (run, some error)
  | _ => return ({ run with recorded := true }, none)

/-- The `formatChannelFinalText` arguments both reply callbacks share. -/
private def formatArgs (body traceId event channelName config : Json) : List Json :=
  [body, traceId, event, channelName, config]

/-- One callback handed to the agent loop. The harness swallows whatever a callback throws. -/
private def asyncCallback (event : Json) (run : AsyncRun) (label : String) (args : Json) :
    Prog AsyncRun := do
  let first := (args.getArr?.toOption.getD #[]).getD 0 Twin.undefinedJson
  let second := (args.getArr?.toOption.getD #[]).getD 1 Twin.undefinedJson
  let channelName := field (field event "replyTarget") "channelName"
  let config := field event "agentConfig"
  let push (run : AsyncRun) (body : Prog Json) : Prog AsyncRun :=
    Prog.catchFail
      (do
        let formatted ← body
        let _ ← Prog.effect "pushReplyToChannel" [run.session, event, formatted]
        pure run)
      (fun _ => pure run)
  match label with
  | "onFinalText" =>
    let (run, error) ← finish event run (obj [("status", .str "completed"), ("response", first)])
    if error.isSome then return run
    match ← Prog.attempt "channelReplyText" [first] with
    | .ok Json.null => return run
    | .ok responseText =>
      push run (Prog.effect "formatChannelFinalText"
        (formatArgs responseText second event channelName config))
    | _ => return run
  | "onErrorText" =>
    let (run, error) ← finish event run (failed (text first))
    if error.isSome then return run
    push run (do
      let body ← Prog.effect "formatChannelErrorText" [first, channelName]
      Prog.effect "formatChannelFinalText" (formatArgs body second event channelName config))
  | "onApprovalRequired" =>
    return (← finish event run (obj [("status", .str "awaiting_approval"), ("approvals", first)])).1
  | "onQuestionsPending" =>
    return (← finish event run (obj [("status", .str "awaiting_input"), ("questions", first)])).1
  | other => Prog.unsupported s!"callback {other}"

/-- Runs the callbacks the agent loop entered, whose effects come before the loop's own answer. -/
private def drainAsyncCallbacks (event : Json) : Nat → AsyncRun → Prog AsyncRun
  | 0, run => pure run
  | limit + 1, run =>
    .input fun
      | none => pure run
      | some (label, args) =>
        (Prog.catchFail (asyncCallback event run label args) fun error =>
          if (error.getObjVal? "$unsupported").isOk then .fail error else pure run).bind
          (drainAsyncCallbacks event limit)

/-- `finally`: the lease goes back unless another run took it over. -/
private def releaseIfKept (run : AsyncRun) : Prog Unit := do
  if truthy run.session && !run.transferred then
    let _ ← Prog.attempt "session.releaseConversationLease"

/-- The `catch` block, then `finally`, then the rethrow. -/
private def asyncFailure {α : Type} (event : Json) (run : AsyncRun) (error : Json) : Prog α := do
  let produced := run.outcome.getD (failed (errorMessageOr error "Async request failed"))
  if !run.recorded then
    match ← Prog.attempt "settleAsyncRun" [run.session, event, produced] with
    | .threw _ _ =>
      let _ ← Prog.attempt "recordAsyncRun" [event, produced]
    | _ => pure ()
  if !run.cronSettled then
    let _ ← Prog.attempt "settleCronRun" [field event "accountId", field event "cronRun", produced]
  let run ←
    if truthy run.session then
      match ← Prog.attempt "dispatchNextIngress" [run.session, event] with
      | .ok value => pure { run with transferred := truthy value }
      | _ => pure { run with transferred := false }
    else pure run
  releaseIfKept run
  throw error

/-- What runs after the turn: the recorded outcome settles the cron, then the queue drains. -/
private def asyncSuccess (event : Json) (run : AsyncRun) : Prog Json := do
  let some outcome := if run.recorded then run.outcome else none
    | asyncFailure event run
        (Prog.errorJson "Error" "Async run ended without recording its outcome")
  match ← Prog.attempt "settleCronRun" [field event "accountId", field event "cronRun", outcome] with
  | .threw error _ => asyncFailure event run error
  | _ =>
    let run := { run with cronSettled := true }
    match ← Prog.attempt "dispatchNextIngress" [run.session, event] with
    | .threw error _ => asyncFailure event run error
    | .ok value =>
      let run := { run with transferred := truthy value }
      releaseIfKept run
      return Twin.undefinedJson
    | .pending => Prog.unsupported "drain never finished"

/-- The last element, for `messages.at(-1)`. -/
private def lastOf (value : Json) : Json := (items value).getLast?.getD Twin.undefinedJson

/-- `handleAsyncWorkerRequest`. Failures carry the run state so the `catch` block sees it. -/
def handleAsyncWorkerRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let context := Twin.callArg call 1
  let asyncId := field event "asyncResultEventId"
  let pendingId := if nullish asyncId then field event "eventId" else asyncId
  let start : AsyncRun := {}
  match ← Prog.attempt "createPendingAsyncAgentResult"
      [obj [("eventId", pendingId), ("conversationKey", field event "conversationKey")]] with
  | .threw error _ => asyncFailure event start error
  | .pending => Prog.unsupported "pending row never finished"
  | .ok _ =>
    let command ← Prog.effect "queuedCommand"
      [field event "events", field (field event "replyTarget") "channelName"]
    if truthy command then
      let session ← Prog.effect "directSession" [event]
      let run := { start with session := session }
      match ← Prog.attempt "commandOutcome" [session, command] with
      | .threw error _ => asyncFailure event run error
      | .pending => Prog.unsupported "command never finished"
      | .ok outcome =>
        let (run, error) ← finish event run outcome
        match error with
        | some error => asyncFailure event run error
        | none => asyncSuccess event run
    else
      match ← Prog.attempt "prepareDirectTurn" [event] with
      | .threw error _ => asyncFailure event start error
      | .pending => Prog.unsupported "preparation never finished"
      | .ok Json.null => return Twin.undefinedJson
      | .ok turn =>
        let session := field turn "session"
        let run := { start with session := session }
        let turnContext := field turn "turnContext"
        let runnable ← Prog.effect "isRunnableModelInput" [lastOf (field turnContext "messages")]
        if !truthy runnable then
          let (run, error) ← finish event run (failed "Request did not produce pending model input")
          match error with
          | some error => asyncFailure event run error
          | none => asyncSuccess event run
        else
          let reply := obj
            [("onFinalText", named "onFinalText"),
             ("onErrorText", named "onErrorText"),
             ("onApprovalRequired", named "onApprovalRequired"),
             ("onQuestionsPending", named "onQuestionsPending")]
          let loop : String × List Json := ("runAgentLoopUntilSubagentsIdle",
            [session, turnContext, field event "agentConfig", context, reply,
             Twin.moduleValue call "CONTINUATION_DEPENDENCIES"])
          let run ← drainAsyncCallbacks event 32 run
          match ← Prog.attempt loop.1 loop.2 with
          | .threw error _ => asyncFailure event run error
          | _ => asyncSuccess event run

/-- Standard base64 of a string's UTF-8, what the recorder writes for a `Uint8Array`. -/
private def base64 (value : String) : String :=
  let encoded := (Access.Crypto.base64UrlEncode value.toUTF8.toList).replace "-" "+" |>.replace "_" "/"
  encoded ++ String.ofList (List.replicate ((4 - encoded.length % 4) % 4) '=')

/-- `streamDirectContinuation`. Only a loop that throws is recorded, so a returning loop opts out:
its `consumeStream` closure and `turnSettlement` never ran under a test. -/
def streamDirectContinuation (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let session := Twin.callArg call 1
  let context := Twin.callArg call 4
  let dependencies := Twin.moduleValue call "CONTINUATION_DEPENDENCIES"
  let coordinator ← Prog.effect "new SubagentCoordinator"
    [session, field event "agentConfig", anon, field dependencies "subagents"]
  let _ ← Prog.effect "ownerCheckForStream" [session]
  let looped ← Prog.attempt "runParentContinuationLoop"
    [obj [("session", session),
          ("subagentCoordinator", coordinator),
          ("initialTurnContext", Twin.callArg call 2),
          ("agentConfig", field event "agentConfig"),
          ("dependencies", dependencies),
          ("context", context),
          ("consumeStream", named "consumeStream"),
          ("onHeartbeat", named "onHeartbeat")]]
  match looped with
  | .threw thrown _ =>
    let error := match (thrown.getObjVal? "$error").toOption with
      | some body => text (field body "message")
      | none => text thrown
    let frame := "data: {\"type\":\"error\",\"error\":" ++ Access.Js.quoteJson error ++ "}\n\n"
    let owned ← Prog.attempt "session .assertCurrentOwner"
    match owned with
    | .ok _ =>
      let _ ← Prog.attempt "controller.enqueue"
        [obj [("$bytes", .str (base64 frame))]]
    | _ => pure ()
    drainOne "arg2" fun _ => do
      let _ ← Prog.effect "dispatchNextIngress" [session, event]
    let settled ← Prog.attempt "settleFailedIngressAndDrain" [session, .str error, anon]
    match settled with
    | .threw settleError _ =>
      let _ ← Prog.attempt "session.releaseConversationLease"
      throw settleError
    | _ => return Twin.undefinedJson
  | _ => Prog.unsupported "a returning loop runs closures no recording exercises"

/-- What one `runChannelTurns` iteration starts from. -/
private structure ChannelTurn where
  session : Json
  incoming : Json
  ephemeral : Json
  config : Json

/-- What the reply callbacks of one turn leave behind: `terminal`, `finalResult`, `approvalRequired`. -/
private structure TurnReply where
  terminal : String := ""
  finalResult : Json := Twin.undefinedJson
  approvalRequired : Bool := false

/-- One reply callback the agent loop entered: `onFinalText` sends the text, `onApprovalRequired`
denies every pending tool call. The others are not exercised by a recording. -/
private def replyCallback (event hooks : Json) (turn : ChannelTurn) (state : TurnReply)
    (label : String) (args : Json) : Prog TurnReply := do
  match label with
  | "onFinalText" =>
    let response := Twin.arg args 0
    let _ ← Prog.effect "session.assertCurrentOwner"
    let state := { state with terminal := "completed", finalResult := response }
    let reply ← Prog.effect "channelReplyText" [response]
    if reply == Json.null then return state
    let formatted ← Prog.effect "formatChannelFinalText"
      [reply, Twin.arg args 1, event, field event "channelName", turn.config]
    let sending ← Prog.effect "applyMessageSendingHook"
      [hooks, field event "channelName", formatted]
    if sending != Json.null then
      let _ ← Prog.effect "event.channel.sendText" [sending]
    return state
  | "onApprovalRequired" =>
    let state := { state with approvalRequired := true }
    let denial ← Prog.effect "createChannelApprovalDenial" [Twin.arg args 0]
    let _ ← Prog.effect "session.persistModelMessages" [toJson [denial]]
    return state
  | other => Prog.unsupported s!"callback {other}"

/-- Enters the reply callbacks in order. A callback's own failure goes back to the loop that called it. -/
private def drainReply (event hooks : Json) (turn : ChannelTurn) : Nat → TurnReply → Prog TurnReply
  | 0, state => pure state
  | limit + 1, state =>
    .input fun
      | none => pure state
      | some (label, args) =>
        (Prog.catchFail (replyCallback event hooks turn state label args) fun error =>
          if (error.getObjVal? "$unsupported").isOk then throw error else pure state).bind
          (drainReply event hooks turn limit)

/-- The `try` around one turn: gives the settlement (`undefined` when there is none) and whether the
turn was cut short by pending approvals, which restarts it with no new input. -/
private def channelSettlement (event hooks context dependencies : Json) (turn : ChannelTurn) :
    Prog (Json × Bool) :=
  Prog.catchFail
    (do
      let command ← Prog.effect "queuedCommand" [turn.incoming, field event "channelName"]
      if truthy command then
        let outcome ← Prog.effect "commandOutcome" [turn.session, command]
        return (← Prog.effect "outcomeSettlement" [outcome], false)
      let startedAt ← Prog.effect "Date.now"
      let turnContext ←
        match ← Prog.attempt "session .createTurnContext" [turn.ephemeral, turn.incoming] with
        | .ok value => pure value
        | .threw error _ =>
          let _ ← Prog.effect "recordFailedTurn" [turn.session, startedAt, error]
          throw error
        | .pending => Prog.unsupported "turn context never finished"
      let runnable ← Prog.effect "isRunnableModelInput" [lastOf (field turnContext "messages")]
      if !truthy runnable then
        return (failed "Request did not produce pending model input", false)
      let streaming :=
        if undef (field (field event "channel") "stream") then []
        else [("streamMessage", named "streamMessage")]
      let reply := obj (streaming ++
        [("onFinalText", named "onFinalText"),
         ("onErrorText", named "onErrorText"),
         ("onApprovalRequired", named "onApprovalRequired"),
         ("onQuestionsPending", named "onQuestionsPending")])
      let state ← drainReply event hooks turn 16 {}
      let looped ← Prog.attempt "runAgentLoopUntilSubagentsIdle"
        [turn.session, turnContext, turn.config, context, reply, dependencies, hooks]
      match looped with
      | .threw error _ => throw error
      | .pending => Prog.unsupported "the agent loop never finished"
      | .ok result =>
        if state.approvalRequired then return (Twin.undefinedJson, true)
        let terminal := if truthy (field result "didFail") then "failed" else state.terminal
        if terminal == "failed" then
          let failure := field result "failureText"
          if nullish failure then Prog.unsupported "no recording has a failed loop without text"
          else return (failed (text failure), false)
        else if terminal == "completed" then
          return (obj ([("status", .str "completed")] ++
            (if undef state.finalResult then [] else [("result", state.finalResult)])), false)
        else return (Twin.undefinedJson, false))
    (fun error =>
      if (error.getObjVal? "$unsupported").isOk then throw error
      else return (failed (errorMessageOr error "Channel turn failed"), false))

/-- The `while (next)` loop: a queued turn whose config will not load is failed and skipped. -/
private def nextLoadable (event scope : Json) : Nat → Json → Prog (Json × Json)
  | 0, _ => Prog.unsupported "more unloadable turns than the model allows"
  | fuel + 1, next => do
    if !truthy next then
      return (next, Twin.undefinedJson)
    match ← Prog.attempt "loadAppliedIngressConfig"
        [obj [("accountId", field scope "accountId"),
              ("agentId", field scope "agentId"),
              ("configRef", field next "configRef")]] with
    | .ok config => return (next, config)
    | .pending => Prog.unsupported "config load never finished"
    | .threw thrown _ =>
      let error ← Prog.effect "toErrorMessage" [thrown]
      let taken ← Prog.effect "takeNextIngress"
        [obj [("conversationKey", field event "conversationKey"),
              ("ownerEventId", field next "eventId"),
              ("ownerGeneration", field next "ownerGeneration")],
         obj [("status", .str "failed"), ("error", error)]]
      nextLoadable event scope fuel taken

/-- `Session` construction for a queued turn. -/
private def queuedSession (event next config : Json) : Prog Json := do
  let delivery := field next "delivery"
  let isChannel := text (field delivery "kind") == "channel"
  let queuedSource := field delivery "source"
  let source := if isChannel && !nullish queuedSource then queuedSource else field event "source"
  let identity := if isChannel then field delivery "identity" else Twin.undefinedJson
  if !undef (field event "channelFactory") then
    Prog.unsupported "no recording has a channel factory"
  let chain ← Prog.effect "channelPrincipalChain" [identity, field event "channelName"]
  let principal ← Prog.effect "runPrincipal" [event, chain]
  Prog.effect "new Session"
    [obj [("eventId", field next "eventId"),
          ("conversationKey", field event "conversationKey"),
          ("accountId", field event "accountId"),
          ("agentId", field event "agentId"),
          ("agentConfig", config),
          ("delivery", obj ([("kind", .str "channel"), ("channelName", field event "channelName")] ++
            whenTruthy "identity" identity ++ [("source", source)])),
          ("endpointId", field event "endpointId"),
          ("projectSlug", field event "projectSlug"),
          ("stageSlug", field event "stageSlug"),
          ("ownerGeneration", field next "ownerGeneration"),
          ("channelActions", field event "channel"),
          ("principal", principal)]]

/-- One `for (;;)` pass. `finally` releases the lease of whichever session the pass ran on. -/
private def channelTurns (event scope hooks context dependencies : Json) :
    Nat → ChannelTurn → Prog Json
  | 0, _ => Prog.unsupported "more queued turns than the model allows"
  | fuel + 1, turn => do
    let step : Prog (Option ChannelTurn) := do
      let (settlement, again) ← channelSettlement event hooks context dependencies turn
      if again then
        return some { turn with incoming := .arr #[], ephemeral := .arr #[] }
      let first ← Prog.effect "session.takeNextIngress" [settlement]
      let (next, config) ← nextLoadable event scope 16 first
      if !truthy next then
        let _ ← Prog.effect "session.releaseConversationLease"
        return none
      let session ← queuedSession event next config
      let ephemeral := field next "ephemeralSystem"
      return some
        { session := session
          incoming := field next "events"
          ephemeral := if nullish ephemeral then .arr #[] else ephemeral
          config := config }
    let outcome ← Prog.catchFail step fun error => do
      if (error.getObjVal? "$unsupported").isOk then throw error
      let _ ← Prog.attempt "session.releaseConversationLease"
      throw error
    match outcome with
    | none => return Twin.undefinedJson
    | some following => channelTurns event scope hooks context dependencies fuel following

/-- `runChannelTurns`: settle the turn, take the next queued one, repeat until the queue is empty.
Only `onFinalText` and `onApprovalRequired` replies are modelled: error replies, question prompts,
streaming, a channel factory, a failed loop with no failure text, and long queues opt out. -/
def runChannelTurns (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let supplied := field event "agentConfig"
  let config := if nullish supplied then Json.mkObj [] else supplied
  let hooks ← Prog.effect "createAgentHookDispatcher" [field event "accountId", config]
  channelTurns event (Twin.callArg call 1) hooks (Twin.callArg call 4)
    (Twin.moduleValue call "CONTINUATION_DEPENDENCIES") 16
    { session := Twin.callArg call 2
      incoming := Twin.callArg call 3
      ephemeral := .arr #[]
      config := config }

/-- `ownerCheckForStream` only builds its closure; the closure body is not compared. -/
def ownerCheckForStream (_call : Json) : Prog Json := pure anon

/-- `connectionFetch` only builds its closure; the closure body is not compared. -/
def connectionFetch (_call : Json) : Prog Json := pure anon

/-- `createRunFinalizer` builds the two closures that share `settling`. -/
def createRunFinalizer (_call : Json) : Prog Json :=
  pure (obj [("finalize", named "finalize"), ("finalized", named "finalized")])

/-- `createRunSpanTracker` builds the closures that share its span table. -/
def createRunSpanTracker (_call : Json) : Prog Json :=
  pure (obj (["close", "closeOrphans", "get", "late", "open", "phase", "retry"].map
    fun name => (name, named name)))

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/handler.ts#commandOutcome" commandOutcome,
   Twin.traced "apps/core/src/harness/apply-runs.ts#handleApplyRunRequest" handleApplyRunRequest,
   Twin.traced "apps/core/src/harness/handler.ts#prepareDirectTurn" prepareDirectTurn,
   Twin.traced "apps/core/src/harness/handler.ts#handleDirectRequest" handleDirectRequest,
   Twin.traced "apps/core/src/harness/handler.ts#handleAsyncRequest" handleAsyncRequest,
   Twin.traced "apps/core/src/harness/handler.ts#handleChannelRequest" handleChannelRequest,
   Twin.traced "apps/core/src/harness/handler.ts#handleAsyncWorkerRequest" handleAsyncWorkerRequest,
   Twin.traced "apps/core/src/harness/handler.ts#streamDirectContinuation" streamDirectContinuation,
   Twin.traced "apps/core/src/harness/handler.ts#runChannelTurns" runChannelTurns,
   Twin.traced "apps/core/src/harness/handler.ts#ownerCheckForStream" ownerCheckForStream,
   Twin.traced "apps/core/src/harness/connections.ts#connectionFetch" connectionFetch,
   Twin.traced "apps/core/src/harness/run-finalizer.ts#createRunFinalizer" createRunFinalizer,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker" createRunSpanTracker]

end Spec.Runs.Waveruns4a
