import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins for the functions listed in `.lake/worklist/assign6/runs6a.tsv`.
-/

namespace Spec.Runs.Waveruns6a

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def truthy (value : Json) : Bool := !undef value && Access.Js.truthy value
private def nullish (value : Json) : Bool := undef value || value == Json.null
private def anon : Json := Json.mkObj [("$fn", .str "")]
private def named (name : String) : Json := Json.mkObj [("$fn", .str name)]
private def items (value : Json) : List Json := value.getArr?.toOption.getD #[] |>.toList
private def nat (value : Json) : Nat := (value.getNat?).toOption.getD 0
private def text (value : Json) : String := (value.getStr?).toOption.getD ""

/-- An object literal. The recorder drops `undefined` values from plain objects. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

/-- A property of a plain object or of a recorded class instance. -/
private def prop (value : Json) (key : String) : Json :=
  let direct := field value key
  if undef direct then Twin.field value key else direct

/-- `{...a, ...b}` over recorded objects, leaving out the recorder's own keys. -/
private def merge (layers : List (List (String × Json))) : Json :=
  let step := fun (acc : List (String × Json)) (layer : List (String × Json)) =>
    acc.filter (fun entry => !layer.any (·.1 == entry.1)) ++ layer
  obj (layers.foldl step [])

private def entriesOf (value : Json) : List (String × Json) :=
  if undef value then [] else
    (Access.Js.entries value).filter fun entry => entry.1 != "$keys"

private def errorMessage (error : Json) : Json :=
  (((error.getObjVal? "$error").toOption.bind fun inner =>
    (inner.getObjVal? "message").toOption)).getD Twin.undefinedJson

/-- `MAX_INPROCESS_WORKERS` at its default. -/
private def maxInProcessWorkers : Nat := 8

/-- `WORKER_TIMEOUT_BUDGET_MS`. -/
private def workerTimeoutBudgetMs : Nat := 600000

/-- `WORKER_SLOT_GRACE_MS`. -/
private def workerSlotGraceMs : Nat := 5000

/-- `dispatchInProcessWorker`: builds the run's context and queues it. With a free slot the entry
starts inside `enqueueWorker`: `takeSlot` sets the deadline and arms the overrun timer, then the run
starts and nothing waits for it. -/
def dispatchInProcessWorker (call : Json) : Prog Json := do
  let kind := Twin.callArg call 0
  let lease := Twin.callArg call 2
  let requestId ← Prog.effect "crypto.randomUUID"
  let _ ← Prog.effect "Date.now"
  let place ← Prog.effect "queuePlace.getStore"
  let placed := field place "held" == toJson true
  if placed then
    Prog.setState "module.heldQueuePlaces"
      (toJson (nat (Twin.moduleValue call "heldQueuePlaces") - 1))
  let _ ← Prog.effect "enqueueWorker" [.arr #[kind, anon, lease], toJson !placed]
  let active := nat (Twin.moduleValue call "activeInProcessWorkers")
  if active >= maxInProcessWorkers then
    return Twin.undefinedJson
  Prog.setState "module.activeInProcessWorkers" (toJson (active + 1))
  let tracked := (field (Twin.moduleValue call "inProcessWorkers") "$set").getArr?.toOption.getD #[]
  Prog.setState "module.inProcessWorkers"
    (obj [("$set", .arr (tracked.push (obj [("$opaque", .str "Promise")])))])
  let now ← Prog.effect "Date.now"
  let _ ← Prog.effect "setTimeout" [anon, toJson (workerTimeoutBudgetMs + workerSlotGraceMs)]
  let _ ← Prog.effect "slotTimer.unref"
  Prog.spawn "run"
    [obj [("requestId", requestId),
          ("deadlineMs", toJson (nat now + workerTimeoutBudgetMs)),
          ("waitUntil", Json.mkObj [("$fn", toJson "waitUntil")]),
          ("abortSignal", Json.mkObj [("$signal", toJson false)]),
          ("yieldSlot", anon)]]
  Prog.drain (fun _ _ => pure ()) 4
  return Twin.undefinedJson

/-- `USAGE_INPUT_PREVIEW_CHARS`. -/
private def usageInputPreviewChars : Nat := 160

/-- `Math.round(rss / 1024 / 1024)` over a whole number of bytes. -/
private def roundedMb (rss : Nat) : Nat :=
  (rss * 2 + 1048576) / 2097152

/-- `settleRun`: the root span and the usage row of a finished run. -/
def settleRun (call : Json) : Prog Json := do
  let inputs := Twin.callArg call 0
  let status := Twin.callArg call 1
  let toolCalls := Twin.callArg call 2
  let durationMs := Twin.callArg call 3
  let error := Twin.callArg call 4
  let root := field inputs "root"
  let session := field inputs "session"
  let _ ← Prog.effect "inputs.release"
  let usage ← Prog.effect "inputs.taskTotals.usage"
  let tokens ← Prog.effect "usageTokenTotals" [usage]
  let steps ← Prog.effect "inputs.taskTotals.steps"
  let failed := status == .str "failed"
  let work ← if failed then pure (obj [("questions", .arr #[])]) else Prog.effect "inputs.openWork"
  let waitingOn := field work "waitingOn"
  let questions := field work "questions"
  let rootStatus ← Prog.effect "rootSpanStatus" [status, waitingOn]
  let context := Twin.observabilityContext call
  let sanitized ←
    if truthy error then
      Prog.effect "redactSensitiveText" [errorMessage error, field context "secretValues"]
    else pure Twin.undefinedJson
  let hasError := truthy error
  let endTimeMs := toJson (nat (field root "startTimeMs") + nat durationMs)
  let _ ← Prog.effect "inputs.spans.closeOrphans"
    [endTimeMs, status, sanitized, field (field inputs "stepTiming") "attemptAttributes"]
  let _ ← Prog.effect "inputs.stepTiming.clear"
  let rootAttributes ← Prog.effect "inputs.rootAttributes"
  let questionAttributes ←
    if (items questions).isEmpty then pure []
    else do
      let formatted ← Prog.effect "formatQuestionsText" [questions]
      let serialized ← Prog.effect "inputs.serialize" [formatted]
      pure [("task.questions", serialized)]
  let cpuAttributes ← Prog.effect "inputs.sandboxCpu.typeAttributes"
  let tokenField := fun (key : String) => field tokens key
  let attributes := merge [entriesOf rootAttributes,
    if truthy waitingOn then [("task.state", rootStatus), ("task.waiting_on", waitingOn)]
    else [("task.state", status)],
    questionAttributes,
    [("agent.step_count", steps), ("agent.tool_call_count", toolCalls),
     ("agent.model_provider", field inputs "modelProvider"),
     ("agent.model_id", field inputs "modelId"),
     ("usage.input_tokens", tokenField "inputTokens"),
     ("usage.output_tokens", tokenField "outputTokens"),
     ("usage.reasoning_tokens", tokenField "reasoningTokens"),
     ("usage.cached_input_tokens", tokenField "cachedInputTokens"),
     ("usage.total_tokens", tokenField "totalTokens")],
    entriesOf cpuAttributes]
  let row := obj ([("traceId", field root "traceId"), ("spanId", field root "spanId"),
    ("name", field root "name"), ("kind", field root "kind"),
    ("startTimeMs", field root "startTimeMs"), ("endTimeMs", endTimeMs),
    ("durationMs", durationMs), ("status", rootStatus),
    ("endpointId", prop session "endpointId"), ("agentId", prop session "agentId"),
    ("conversationKey", prop session "conversationKey"), ("attributes", attributes)] ++
    (if hasError then [("error", sanitized)] else []))
  Prog.catchFail (do
    let _ ← Prog.effect "root.span.setAttributes" [attributes]
    if failed then
      if hasError then
        let _ ← Prog.effect "root.span.recordException" [Prog.errorJson "Error" (text sanitized)]
      let _ ← Prog.effect "root.span.setStatus" [obj [("code", toJson (2 : Nat)), ("message", sanitized)]]
    else
      let _ ← Prog.effect "root.span.setStatus" [obj [("code", toJson (1 : Nat))]]
    let _ ← Prog.effect "root.span.end" [endTimeMs]
    pure ()) (fun _ => pure ())
  Prog.drain (fun label _ => do
    if label != "arg0" then Prog.unsupported s!"callback {label}"
    let cacheWrite ← Prog.effect "inputs.taskTotals.cacheWriteTokens"
    let memory ← Prog.effect "process.memoryUsage"
    let sandboxUsage ← Prog.effect "inputs.sandboxCpu.usage"
    let accountId := prop session "accountId"
    let agentId := prop session "agentId"
    let modelId := field inputs "modelId"
    Prog.spawn "inputs.recordUsage" [obj [
      ("accountId", if nullish accountId then .str "" else accountId),
      ("endpointId", prop session "endpointId"),
      ("agentId", if nullish agentId then .str "unknown" else agentId),
      ("principalChain", field (prop session "principal") "chain"),
      ("conversationKey", prop session "conversationKey"),
      ("taskId", .str s!"{text (prop session "eventId")}#{text (field root "traceId")}"),
      ("modelProvider", field inputs "modelProvider"),
      ("modelId", if nullish modelId then .str "unknown" else modelId),
      ("finishedAt", endTimeMs), ("durationMs", durationMs), ("status", status),
      ("inputTokens", tokenField "inputTokens"), ("outputTokens", tokenField "outputTokens"),
      ("reasoningTokens", tokenField "reasoningTokens"),
      ("cachedInputTokens", tokenField "cachedInputTokens"),
      ("cacheWriteTokens", cacheWrite), ("totalTokens", tokenField "totalTokens"),
      ("runtimeKind", .str "container"), ("runtimeWallMs", durationMs),
      ("runtimeMemoryMb", toJson (roundedMb (nat (field memory "rss")))),
      ("sandboxUsage", sandboxUsage), ("stepCount", steps), ("toolCallCount", toolCalls),
      ("inputPreview", .str (String.ofList ((text (field inputs "taskInput")).toList.take usageInputPreviewChars)))]]) 1
  Prog.spawn "inputs.publish" [row]
  let _ ← Prog.effect "waitUntil" [Json.mkObj [("$opaque", .str "Promise")]]
  return Twin.undefinedJson

/-- `MAX_RECOVERY_PAGES`. -/
private def maxRecoveryPages : Nat := 50

/-- `MAX_RECOVERED_PER_SWEEP`. -/
private def maxRecoveredPerSweep : Nat := 100

/-- The page loop of `sweepQueuedIngress`, up to `pages` more pages. Gives the count so far. -/
private def sweepPages : Nat → Json → Nat → Prog Nat
  | 0, _, count => pure count
  | pages + 1, resumeAfter, count => do
    if count >= maxRecoveredPerSweep then return count
    let page ← Prog.effect "recoverQueuedIngress" [resumeAfter]
    let recovered := items (field page "recovered")
    if !recovered.isEmpty then Prog.unsupported "dispatching recovered entries"
    let count := count + recovered.length
    let continueAfter := field page "continueAfter"
    if continueAfter == Json.null then return count
    sweepPages pages continueAfter count

/-- `sweepQueuedIngress`: one recovery pass; each stage's failure is logged and the next runs.
Not registered: two recordings come from tests that mock `handler.ts`, so the function references it
passes on are recorded under a different name, which the arguments check cannot accept. -/
def sweepQueuedIngress (call : Json) : Prog Json := do
  if truthy (Twin.moduleValue call "sweeping") then return Twin.undefinedJson
  let _ ← Prog.catchFail
    (sweepPages maxRecoveryPages (Twin.moduleValue call "resumeAfter") 0)
    (fun error =>
      if (error.getObjVal? "$unsupported").toOption.isSome then .fail error else pure 0)
  let _ ← Prog.attempt "resumeLostSubagentResults"
    [named "loadReentryTarget", named "resumeAfterSubagentResult"]
  let _ ← Prog.attempt "resumeLostAsyncToolResults" [named "continueAfterAsyncToolSettlement"]
  return Twin.undefinedJson

/-- `RECOVERY_INTERVAL_MS`. -/
private def recoveryIntervalMs : Nat := 30000

/-- `startIngressRecovery`: starts one sweep and the timer, once. -/
def startIngressRecovery (call : Json) : Prog Json := do
  if truthy (Twin.moduleValue call "recovery") then return Twin.undefinedJson
  Prog.spawn "sweepQueuedIngress"
  let timer ← Prog.effect "setInterval" [anon, toJson recoveryIntervalMs]
  Prog.setState "module.recovery" timer
  let _ ← Prog.effect "recovery.unref"
  return Twin.undefinedJson

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/worker-queue.ts#dispatchInProcessWorker" dispatchInProcessWorker,
   Twin.traced "apps/core/src/harness/run-finalizer.ts#settleRun" settleRun,
   Twin.traced "apps/core/src/harness/ingress-recovery.ts#startIngressRecovery" startIngressRecovery]

end Spec.Runs.Waveruns6a
