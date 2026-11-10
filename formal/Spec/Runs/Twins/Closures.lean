import Spec.Twin
import Spec.Access.Twins.Js
import Spec.Runs.Twins.Waveruns8a

/-!
Twins of closures that outlive their maker in the runs subsystem. See `AUTHORING.md`.
-/

namespace Spec.Runs.Closures

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def text (value : Json) : String := value.getStr?.toOption.getD ""
private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def truthy (value : Json) : Bool := !undef value && Access.Js.truthy value
private def emptyMap : Json := Json.mkObj [("$map", .arr #[])]

private def mapEntries (value : Json) : List Json :=
  (field value "$map").getArr?.toOption.getD #[] |>.toList

/-- An object literal. The recorder drops `undefined` values from plain objects. -/
private def obj (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !undef entry.2)

/-- `{...base, ...over}`, leaving out the recorder's own bookkeeping keys. -/
private def merge (base over : Json) : Json :=
  let keep (value : Json) : List (String × Json) :=
    if undef value then [] else
      (Access.Js.entries value).filter fun entry => entry.1 != "$keys" && entry.1 != "$class"
  let over := keep over
  obj ((keep base).filter (fun entry => !over.any (·.1 == entry.1)) ++ over)

/-- `a - b` as JavaScript numbers. -/
private def minus (a b : Json) : Float :=
  match a, b with
  | .num x, .num y => Access.Js.numFloat x - Access.Js.numFloat y
  | _, _ => Access.Js.nan

/-- `Math.max(0, value)`. -/
private def atLeastZero (value : Float) : Json :=
  Access.Js.floatJson (if value.isNaN then value else if value < 0.0 then 0.0 else value)

/-- A published row's fields that come from the identity's session. -/
private def sessionFields (identity : Json) : List (String × Json) :=
  let session := field identity "session"
  [("endpointId", field session "endpointId"), ("agentId", field session "agentId"),
   ("conversationKey", field session "conversationKey")]

/-- `observabilityAttributes` in `shared/otel.ts`. -/
private def scopeAttributes (scope : Json) : Json :=
  obj [("account_id", field scope "accountId"), ("project", field scope "project"),
       ("stage", field scope "stage"), ("endpoint_id", field scope "endpointId"),
       ("agent_id", field scope "agentId"), ("conversation_key", field scope "conversationKey")]

/-- `rowIds`: the span's ids, falling back to the run's trace id and a minted span id for all zeros. -/
private def rowIds (identity : Json) : Prog (Json × Json) := do
  let context ← Prog.effect "span.spanContext" []
  let isReal (id : Json) : Bool := (text id).any fun c => c != '0'
  let traceId := if isReal (field context "traceId") then field context "traceId"
    else field identity "traceId"
  let spanId ← if isReal (field context "spanId") then pure (field context "spanId")
    else Prog.effect "mintSpanId" []
  return (traceId, spanId)

/-- A real tracer keeps every finished span in its exporter, which the recorder cannot carry. -/
private def retainsSpans (identity : Json) : Bool :=
  field (field identity "tracer") "$opaque" == toJson "Tracer"

/-- Stops a call whose module state the recorder cannot carry past a span's end. -/
private def requireCarried (identity : Json) : Prog Unit :=
  if undef identity then Prog.unsupported "module state too big to record"
  else if retainsSpans identity then
    Prog.unsupported "a tracer that keeps finished spans changes state the recorder cannot carry"
  else pure ()

/-- `start`: opens an OpenTelemetry span under `parentContext` and describes it. -/
private def start (identity : Json) (name : Json) (startMs parentContext parentSpanId attributes : Json) :
    Prog Json := do
  let span ← Prog.effect "identity.tracer.startSpan"
    [name, obj [("startTime", startMs),
      ("attributes", merge (scopeAttributes (field identity "scope")) attributes)], parentContext]
  let otelContext ← Prog.effect "otelTraceApi.setSpan" [parentContext, span]
  let (traceId, spanId) ← rowIds identity
  return obj [("otelSpan", span), ("otelContext", otelContext), ("name", name), ("traceId", traceId),
    ("spanId", spanId), ("parentSpanId", parentSpanId), ("startTimeMs", startMs),
    ("attributes", attributes)]

/-- The row `close`, `closeOrphans` and `open` publish. -/
private def row (tracked : Json) (extra : List (String × Json)) : Json :=
  obj ([("traceId", field tracked "traceId"), ("spanId", field tracked "spanId"),
        ("parentSpanId", field tracked "parentSpanId"), ("name", field tracked "name"),
        ("kind", field tracked "name")] ++ extra)

/-- `createRunSpanTracker`'s `close`: ends the span, publishes its row and forgets it. -/
def close (call : Json) : Prog Json := do
  let identity := Twin.moduleValue call "identity"
  requireCarried identity
  let tracked := Twin.callArg call 0
  let endMs := Twin.callArg call 1
  let status := text (Twin.callArg call 2)
  let attributes := Twin.callArg call 3
  let error := Twin.callArg call 4
  let durationMs := Access.Js.floatJson (minus endMs (field tracked "startTimeMs"))
  let closed := merge (field tracked "attributes") attributes
  let isTool := field tracked "name" == toJson "tool.call"
  let _ ← Prog.effect "tracked.otelSpan.setAttributes"
    [if isTool then
      merge (obj [("tool.duration_ms", durationMs), ("tool.success", toJson (status == "ok"))]) closed
     else closed]
  if status == "ok" then
    let _ ← Prog.effect "tracked.otelSpan.setStatus" [obj [("code", toJson 1)]]
  else
    let _ ← Prog.effect "tracked.otelSpan.recordException" [Prog.errorJson "Error" (text error)]
    let _ ← Prog.effect "tracked.otelSpan.setStatus" [obj [("code", toJson 2), ("message", error)]]
  let _ ← Prog.effect "tracked.otelSpan.end" [endMs]
  Prog.spawn "identity.publish"
    [row tracked
      ([("startTimeMs", field tracked "startTimeMs"), ("endTimeMs", endMs),
        ("durationMs", durationMs), ("status", toJson status)] ++
       sessionFields identity ++
       [("attributes", closed)] ++
       (if truthy error then [("error", error)] else []))]
  let key := field tracked "key"
  if !undef key then
    let kept := Twin.moduleValue call "kept"
    Waveruns8a.changed "module.kept" kept (Waveruns8a.mapDelete kept key)
  return Twin.undefinedJson

/-- `closeOrphans`: ends every span still kept, tool calls before the steps that parent them. -/
def closeOrphans (call : Json) : Prog Json := do
  let identity := Twin.moduleValue call "identity"
  let kept := Twin.moduleValue call "kept"
  let endMs := Twin.callArg call 0
  let status := text (Twin.callArg call 1)
  let error := Twin.callArg call 2
  let isStep (entry : Json) : Bool := match Twin.arg entry 0 with | .num _ => true | _ => false
  let entries := mapEntries kept
  let orphans := entries.filter (!isStep ·) ++ entries.filter isStep
  if undef kept then Prog.unsupported "module state too big to record"
  if !orphans.isEmpty then requireCarried identity
  for entry in orphans do
    let key := Twin.arg entry 0
    let tracked := Twin.arg entry 1
    let extra ← match key with
      | .num _ => Prog.effect "stepAttributes" [key]
      | _ => pure Twin.undefinedJson
    if status == "failed" then
      let _ ← Prog.effect "tracked.otelSpan.setStatus"
        [obj [("code", toJson 2), ("message", error)]]
    if !undef extra && Access.Js.truthy extra then
      let _ ← Prog.effect "tracked.otelSpan.setAttributes" [extra]
    let _ ← Prog.effect "tracked.otelSpan.end" [endMs]
    let stateKey := match key with | .num _ => "step.state" | _ => "tool.state"
    Prog.spawn "identity.publish"
      [row tracked
        ([("startTimeMs", field tracked "startTimeMs"), ("endTimeMs", endMs),
          ("durationMs", atLeastZero (minus endMs (field tracked "startTimeMs"))),
          ("status", toJson (if status == "completed" then "ok" else "error"))] ++
         sessionFields identity ++
         [("attributes", merge (merge (field tracked "attributes") extra)
            (obj [(stateKey, toJson status)]))] ++
         (if undef error then [] else [("error", error)]))]
  Waveruns8a.changed "module.kept" kept emptyMap
  return Twin.undefinedJson

/-- `get`: the kept span under a key, if any. -/
def get (call : Json) : Prog Json := do
  let kept := Twin.moduleValue call "kept"
  if undef kept then Prog.unsupported "module state too big to record"
  let key := Twin.callArg call 0
  return ((mapEntries kept).find? fun entry => Twin.arg entry 0 == key).map
    (fun entry => Twin.arg entry 1) |>.getD Twin.undefinedJson

/-- `late`: a span whose start hook never ran, parented on the run's root and never kept. -/
def late (call : Json) : Prog Json := do
  let identity := Twin.moduleValue call "identity"
  if undef identity then Prog.unsupported "module state too big to record"
  start identity (Twin.callArg call 0) (Twin.callArg call 1) (field identity "rootOtelContext")
    (field identity "rootSpanId") (Twin.callArg call 2)

/-- `open`: starts a span under its parent (or the root), keeps it and publishes a running row. -/
def open_ (call : Json) : Prog Json := do
  let identity := Twin.moduleValue call "identity"
  if !(mapEntries (Twin.moduleValue call "kept")).isEmpty then requireCarried identity
  let name := Twin.callArg call 0
  let key := Twin.callArg call 1
  let startMs := Twin.callArg call 2
  let parent := Twin.callArg call 3
  let attributes := Twin.callArg call 4
  let nullish := undef parent || parent == Json.null
  let started ← start identity name startMs
    (if nullish then field identity "rootOtelContext" else field parent "otelContext")
    (if nullish then field identity "rootSpanId" else field parent "spanId") attributes
  let tracked := merge started (obj [("key", key)])
  let kept := Twin.moduleValue call "kept"
  Waveruns8a.changed "module.kept" kept (Waveruns8a.mapPut kept key tracked)
  Prog.spawn "identity.publish"
    [row tracked
      ([("startTimeMs", startMs), ("endTimeMs", startMs), ("durationMs", toJson 0),
        ("status", toJson "running")] ++ sessionFields identity ++ [("attributes", attributes)])]
  return tracked

/-- `phase`: a finished phase span and its row; any failure is swallowed. -/
def phase (call : Json) : Prog Json := do
  let identity := Twin.moduleValue call "identity"
  requireCarried identity
  let phaseName := Twin.callArg call 0
  let label := Twin.callArg call 1
  let startMs := Twin.callArg call 2
  let endMs := Twin.callArg call 3
  let extra := if undef (Twin.callArg call 4) then obj [] else Twin.callArg call 4
  let _ ← Prog.catchFail
    (do
      let durationMs := atLeastZero (minus endMs startMs)
      let attributes := merge (obj [("phase.name", label), ("phase.duration_ms", durationMs)]) extra
      let _ ← Prog.effect "identity.tracer.startSpan"
        [phaseName, obj [("startTime", startMs),
          ("attributes", merge (scopeAttributes (field identity "scope")) attributes)],
         field identity "rootOtelContext"]
      let _ ← Prog.effect "phaseSpan.end" [endMs]
      let (traceId, spanId) ← rowIds identity
      Prog.spawn "identity.publish"
        [obj ([("traceId", traceId), ("spanId", spanId),
          ("parentSpanId", field identity "rootSpanId"), ("name", phaseName), ("kind", toJson "phase"),
          ("startTimeMs", startMs), ("endTimeMs", endMs), ("durationMs", durationMs),
          ("status", toJson "ok")] ++ sessionFields identity ++ [("attributes", attributes)])]
      pure Json.null)
    (fun error =>
      if undef (field error "$unsupported") then pure Json.null else Prog.fail error)
  return Twin.undefinedJson

/-- `createRunFinalizer`'s `finalize`: the first call settles the run, later ones wait for it. -/
def finalize (call : Json) : Prog Json := do
  if !undef (Twin.moduleValue call "settling") then return Twin.undefinedJson
  let inputs := Twin.moduleValue call "inputs"
  if undef inputs then Prog.unsupported "module state too big to record"
  if field (field (field inputs "root") "span") "$opaque" == toJson "SpanImpl" then
    Prog.unsupported "a real span keeps finished spans in its exporter, state the recorder cannot carry"
  Prog.setState "module.settling"
    (Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [])])
  let settled ← Prog.attempt "settleRun"
    [inputs, Twin.callArg call 0, Twin.callArg call 1, Twin.callArg call 2, Twin.callArg call 3]
  let restored ← Prog.attempt "inputs.restoreObservabilityContext" []
  match restored, settled with
  | .threw error _, _ => Prog.fail error
  | _, .threw error _ => Prog.fail error
  | _, _ => return Twin.undefinedJson

/-- `createRunFinalizer`'s `finalized`: whether a settlement has started. -/
def finalized (call : Json) : Prog Json :=
  pure (toJson (!undef (Twin.moduleValue call "settling")))

/-- `ownerCheckForStream`'s returned check: proves the owner before any frame but `start`. -/
def ownerCheck (call : Json) : Prog Json := do
  let frameType := field (Twin.callArg call 0) "type"
  if frameType == toJson "start" then return Twin.undefinedJson
  let exact := match frameType, field (Twin.moduleValue call "OWNER_CHECK_EXACT_FRAME_TYPES") "$set" with
    | .str _, .arr types => types.contains frameType
    | _, _ => false
  let _ ← Prog.effect (if exact then "session.assertCurrentOwner" else "session.assertRecentOwner") []
  return Twin.undefinedJson

/-- `invokeHarnessWorker`'s worker: runs the handler on the payload with the slot's context. -/
def invokeWorker (call : Json) : Prog Json :=
  Prog.effect "handler" [Twin.moduleValue call "payload", Twin.callArg call 0]

/-- `directTurnResponse`'s `cancel`: the client went away. -/
def cancelStream (_call : Json) : Prog Json := do
  Prog.setState "module.cancelled" (toJson true)
  return Twin.undefinedJson

/-- `directTurnResponse`'s run body. Only the run a client cancelled before it started is modelled:
the others pass the stream controller and slot context, which are not carried to this closure. -/
def directTurnBody (call : Json) : Prog Json := do
  if Twin.moduleValue call "cancelled" != toJson true then
    Prog.unsupported "the stream controller and slot context are not carried to this closure"
  Prog.drain (fun entered _ => if entered == "arg0" then pure () else Prog.unsupported entered) 1
  let failure ← Prog.catchFail
    (do
      let _ ← Prog.effect "failOwnedIngress"
        [Twin.moduleValue call "ownedEvent", toJson "The client disconnected before the run started"]
      pure none)
    (fun error => pure (some error))
  let _ ← Prog.effect "clearInterval" [Twin.moduleValue call "keepalive"]
  let _ ← Prog.attempt "controller.close" []
  match failure with
  | some error => Prog.fail error
  | none => return Twin.undefinedJson

/-- The headers `new Headers(init?.headers)` holds, as `[name, value]` pairs sorted by name. -/
private def headerPairs (headers : Json) : List (String × String) :=
  let pairs : List (String × String) :=
    if undef headers then [] else
    match field headers "$headers", headers with
    | .arr items, _ => items.toList.map fun pair => (text (Twin.arg pair 0), text (Twin.arg pair 1))
    | _, .arr items => items.toList.map fun pair => (text (Twin.arg pair 0), text (Twin.arg pair 1))
    | _, .obj _ =>
      (Access.Js.entries headers).filterMap fun entry =>
        if entry.1 == "$keys" then none else some (entry.1.toLower, text entry.2)
    | _, _ => []
  pairs

/-- `connectionFetch`'s returned fetch: sends with the account's token, and on a 401 refreshes once. -/
def connectionFetchReturn (call : Json) : Prog Json := do
  let accountId := Twin.moduleValue call "accountId"
  let type := Twin.moduleValue call "type"
  let input := Twin.callArg call 0
  let init := Twin.callArg call 1
  let spread := if undef init then obj [] else init
  let send (token : Json) : Prog Json := do
    let others := (headerPairs (field init "headers")).filter fun pair => pair.1 != "authorization"
    let pairs := ((("authorization", s!"Bearer {text token}") :: others).toArray.qsort
      fun a b => a.1 < b.1).toList
    Prog.effect "baseFetch"
      [input, merge spread (obj [("headers", Json.mkObj [("$headers",
        toJson (pairs.map fun pair => toJson [pair.1, pair.2]))])])]
  let token ← Prog.effect "accessToken" [accountId, type]
  let response ← send token
  if field (field response "$response") "status" != toJson 401 then return response
  let fresh ← Prog.effect "accessToken" [accountId, type]
  send fresh

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/run-finalizer.ts#createRunFinalizer/finalize" finalize,
   Twin.traced "apps/core/src/harness/run-finalizer.ts#createRunFinalizer/finalized" finalized,
   Twin.traced "apps/core/src/harness/handler.ts#ownerCheckForStream/return" ownerCheck,
   Twin.traced "apps/core/src/harness/handler.ts#invokeHarnessWorker/arg1" invokeWorker,
   Twin.traced "apps/core/src/harness/handler.ts#directTurnResponse/cancel" cancelStream,
   Twin.traced "apps/core/src/harness/handler.ts#directTurnResponse/arg0~2" directTurnBody,
   Twin.traced "apps/core/src/harness/connections.ts#connectionFetch/return" connectionFetchReturn,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker/close" close,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker/closeOrphans" closeOrphans,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker/get" get,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker/late" late,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker/open" open_,
   Twin.traced "apps/core/src/harness/run-spans.ts#createRunSpanTracker/phase" phase]

end Spec.Runs.Closures
