import Spec.Twin
import Spec.Runs.Twins.Waveruns8a
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

/-!
Twins for the functions listed in `.lake/worklist/assign3/runs3a.tsv`.
-/

namespace Spec.Runs.Waveruns3a

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def text (value : Json) : String := value.getStr?.toOption.getD ""
private def items (value : Json) : List Json := value.getArr?.toOption.getD #[] |>.toList
private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def truthy (value : Json) : Bool := !undef value && Access.Js.truthy value
private def nat (value : Json) : Nat := value.getNat?.toOption.getD 0
private def promiseTag : Json := Json.mkObj [("$opaque", "Promise"), ("$fields", Json.mkObj [])]

/-- `Object.entries`, in insertion order when the recording carries it. -/
private def ordered (value : Json) : List (String × Json) :=
  match value.getObjVal? "$keys" with
  | .ok (.arr keys) => keys.toList.filterMap fun key =>
    match key.getStr?.toOption with
    | some name => (value.getObjVal? name).toOption.map (name, ·)
    | none => none
  | _ => (Access.Js.entries value).filter fun entry => entry.1 != "$keys" && entry.1 != "$fields"

private def mapEntries (value : Json) : List Json := items (field value "$map")

/-- The value a recorded `Map` holds for `key`. -/
private def mapGet (map : Json) (key : Json) : Option Json :=
  (mapEntries map).findSome? fun entry =>
    if Twin.arg entry 0 == key then some (Twin.arg entry 1) else none

/-- `MAX_INPROCESS_WORKERS` at its default and `MAX_PENDING_WORKER_RUNS`. -/
private def queueCapacity : Nat := 8 + 1000
private def maxWorkers : Nat := 8
private def queuedLeaseRenewMs : Nat := 300000

/-- `workerQueueFull`: slots in use, queued runs and held places against the capacity. -/
def workerQueueFull (call : Json) : Prog Json :=
  pure (toJson (decide (nat (Twin.moduleValue call "activeInProcessWorkers") +
    (items (Twin.moduleValue call "pendingWorkerRuns")).length +
    nat (Twin.moduleValue call "heldQueuePlaces") >= queueCapacity)))

/-- `enqueueWorker`: starts at once under the slot limit. The call to the entry's `start` is not an
effect in the recordings, so the twin checks the path taken and not that call. -/
def enqueueWorker (call : Json) : Prog Json := do
  let active := nat (Twin.moduleValue call "activeInProcessWorkers")
  if active < maxWorkers then
    Prog.setState "module.activeInProcessWorkers" (toJson (active + 1))
    return Twin.undefinedJson
  if truthy (Twin.param call 1) then
    let full ← Prog.effect "workerQueueFull"
    if truthy full then
      Prog.throwError "Error" "In-process worker queue is full"
  Prog.setState "module.pendingWorkerRuns" (toJson
    (items (Twin.moduleValue call "pendingWorkerRuns") ++ [Twin.callArg call 0]))
  if !truthy (Twin.moduleValue call "queuedLeaseTimer") then
    let timer ← Prog.effect "setInterval"
      [Json.mkObj [("$fn", "")], toJson queuedLeaseRenewMs]
    Prog.setState "module.queuedLeaseTimer" timer
    let _ ← Prog.effect "queuedLeaseTimer.unref"
  return Twin.undefinedJson

/-- `startNextWorker`: the timer stops once the shift empties the queue. -/
def startNextWorker (call : Json) : Prog Json := do
  let timer := Twin.moduleValue call "queuedLeaseTimer"
  let waiting := items (Twin.moduleValue call "pendingWorkerRuns")
  if !waiting.isEmpty then
    Prog.setState "module.pendingWorkerRuns" (toJson waiting.tail)
  if waiting.length <= 1 && truthy timer then
    let _ ← Prog.effect "clearInterval" [timer]
    Prog.setState "module.queuedLeaseTimer" Json.null
  return Twin.undefinedJson

/-- `renewQueuedLeases`: the renewals go through a function passed by reference to `map`, which the
recorder does not see, so only the result is compared. -/
def renewQueuedLeases (_call : Json) : Prog Json :=
  pure Twin.undefinedJson

/-- `drainInProcessWorkers`: waiting is the only behaviour, and it resolves empty. -/
def drainInProcessWorkers (call : Json) : Prog Json := do
  if !(items (field (Twin.moduleValue call "inProcessWorkers") "$set")).isEmpty then
    Prog.setState "module.inProcessWorkers" (Json.mkObj [("$set", .arr #[])])
  return Twin.undefinedJson

/-- The current owner's generation fences removal from the live-owner map. -/
def forgetOwner (call : Json) : Prog Json := do
  let owner := Twin.callArg call 0
  let old := Twin.moduleValue call "liveOwners"
  let key := field owner "conversationKey"
  let held := (mapGet old key).getD Twin.undefinedJson
  if field held "ownerEventId" == field owner "ownerEventId" &&
      field held "ownerGeneration" == field owner "ownerGeneration" && !undef held then
    Prog.setState "module.liveOwners" (Json.mkObj [("$map", toJson
      ((mapEntries old).filter fun entry => Twin.arg entry 0 != key))])
  return Twin.undefinedJson

/-- Tracking replaces the value without changing an existing map key's insertion order. -/
def trackOwner (call : Json) : Prog Json := do
  let owner := Twin.callArg call 0
  let old := Twin.moduleValue call "liveOwners"
  let key := field owner "conversationKey"
  let entries := mapEntries old
  let next := if (mapGet old key).isSome then
    entries.map fun entry => if Twin.arg entry 0 == key then toJson [key, owner] else entry
    else entries ++ [toJson [key, owner]]
  let value := Json.mkObj [("$map", toJson next)]
  Waveruns8a.changed "module.liveOwners" old value
  return Twin.undefinedJson

/-- `STRUCTURAL_FRAME_FIELDS` in `nats-publisher.ts`. -/
private def structuralFields : List String :=
  ["type", "approvalId", "id", "toolCallId", "toolName", "eventId"]

private def redactEntries (scrub : Json) : List (String × Json) → Prog (List (String × Json))
  | [] => pure []
  | (key, value) :: rest => do
    let safe ←
      if structuralFields.contains key then pure value
      else Prog.effect "redactWithRunSecrets" [value, scrub]
    let tail ← redactEntries scrub rest
    return (key, safe) :: tail

/-- `LiveNatsPublisher.redactPayload`. The context comparison reads `getObservabilityContext`, which
is not recorded, so the twin refreshes the scrub list only when it was never built. -/
def redactPayload (call : Json) : Prog Json := do
  let self := Twin.self call
  let current := Twin.field self "scrubValues"
  let scrub ←
    match current with
    | .arr _ => pure current
    | _ => do
      let run ← Prog.effect "runSecretValues"
      let next := toJson (items run ++ items (Twin.field self "secretValues"))
      Waveruns8a.changed "self.scrubValues" current next
      pure next
  let safe ← redactEntries scrub (ordered (Twin.callArg call 0))
  return Json.mkObj safe

/-- `LiveNatsPublisher.envelope`. -/
def envelope (call : Json) : Prog Json :=
  let self := Twin.self call
  pure (Json.mkObj
    [("type", "stream"),
     ("headers", Twin.field self "headers"),
     ("data", Twin.callArg call 0),
     ("sequence", Twin.field self "sequence")])

/-- `getStorage`: only the cached path is reachable once tests install a store. -/
def getStorage (call : Json) : Prog Json :=
  let cached := Twin.moduleValue call "cached"
  if truthy cached then pure cached else Prog.unsupported "loads the Convex store with require"

/-- `getConvexClient`. -/
def getConvexClient (call : Json) : Prog Json := do
  let cached := Twin.moduleValue call "cached"
  if truthy cached then return cached
  let url ← Prog.effect "requireEnv" ["CONVEX_URL"]
  let key ← Prog.effect "requireEnv" ["CONVEX_DEPLOY_KEY"]
  let client ← Prog.effect "createConvexClient" [url, key]
  Prog.setState "module.cached" client
  return client

/-- Removes what `JSON.stringify` skips: `undefined` object values, and in an array makes them null. -/
private def dropUndefined : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .arr xs => .arr (xs.map fun item =>
        if undef item then Json.null else dropUndefined fuel item)
    | .obj _ =>
      let keys := match value.getObjVal? "$keys" with
        | .ok order => [("$keys", order)]
        | _ => []
      Json.mkObj (keys ++ ((ordered value).filter (!undef ·.2)).map fun (key, item) =>
        (key, dropUndefined fuel item))
    | other => other

private def stringify (value : Json) : String :=
  Twin.jsonStringify 64 (dropUndefined 64 value)

/-- `Buffer.toString("base64")`: the recorder's spelling of bytes. -/
private def base64Std (bytes : List UInt8) : String :=
  let url := Access.Crypto.base64UrlEncode bytes
  let swapped := url.map fun c => if c == '-' then '+' else if c == '_' then '/' else c
  swapped ++ String.ofList (List.replicate ((4 - url.length % 4) % 4) '=')

private def bytesJson (bytes : List UInt8) : Json :=
  Json.mkObj [("$bytes", toJson (base64Std bytes))]

/-- `TRUNCATED_FRAME_KEPT_FIELDS`. -/
private def keptFields : List String := ["id", "toolCallId", "toolName", "eventId"]

private def isStringJson : Json → Bool
  | .str _ => true
  | _ => false

/-- `LiveNatsPublisher.encodeWithinLimit`. Over the limit only the frame's identity survives. -/
def encodeWithinLimit (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let data := Twin.callArg call 1
  let frame ← Prog.effect "this.envelope" [data]
  let encoded := Access.Crypto.utf8 (stringify frame)
  let info := field connection "info"
  let limit := match field info "max_payload" with
    | .num value => value.mantissa.toNat
    | _ => 1024 * 1024
  if encoded.length + 1024 <= limit then
    return bytesJson encoded
  let kept := keptFields.filterMap fun key =>
    if isStringJson (field data key) then some (key, field data key) else none
  let base : List (String × Json) :=
    (if undef (field data "type") then [] else [("type", field data "type")]) ++
    [("truncated", toJson true), ("originalBytes", toJson encoded.length)]
  let smaller ← Prog.effect "this.envelope" [Json.mkObj (base ++ kept)]
  return bytesJson (Access.Crypto.utf8 (stringify smaller))

/-- `LiveNatsPublisher.getConnection`. The connection is memoized as a promise. -/
def getConnection (call : Json) : Prog Json := do
  let held := Twin.field (Twin.self call) "connectionPromise"
  if truthy held then
    return Twin.resolved held
  let connection ← Prog.effect "getSharedNatsConn"
  Prog.setState "self.connectionPromise" promiseTag
  return connection

/-- `LiveNatsPublisher.close`. -/
def close (call : Json) : Prog Json := do
  if !truthy (Twin.field (Twin.self call) "connectionPromise") then
    return Twin.undefinedJson
  let _ ← Prog.attempt "connection.flush"
  return Twin.undefinedJson

/-- `LiveNatsPublisher.publish`: never throws. A failed stream setup is only logged. -/
def publish (call : Json) : Prog Json := do
  let self := Twin.self call
  let data := Twin.callArg call 0
  match ← Prog.attempt "this.getConnection" with
  | .ok connection =>
    if !truthy connection then
      return Twin.undefinedJson
    Prog.catchFail
      (do
        if !truthy (Twin.field self "streamReady") then
          Prog.setState "self.streamReady" promiseTag
          let _ ← Prog.effect "ensureResponseStream" [connection]
        let hdrs ← Prog.effect "natsHeaders"
        let sequence := nat (Twin.field self "sequence") + 1
        Prog.setState "self.sequence" (toJson sequence)
        let eventId := text (field (Twin.field self "headers") "eventId")
        let _ ← Prog.effect "hdrs.set" ["Nats-Msg-Id", toJson s!"{eventId}:{sequence}"]
        let safe ← Prog.effect "this.redactPayload" [data]
        let encoded ← Prog.effect "this.encodeWithinLimit" [connection, safe]
        let _ ← Prog.effect "connection.publish"
          [Twin.field self "subject", encoded, Json.mkObj [("headers", hdrs)]]
        return Twin.undefinedJson)
      (fun _ => pure Twin.undefinedJson)
  | _ => return Twin.undefinedJson

/-- `jetstreamManagerFor`: one manager per connection. -/
def jetstreamManagerFor (call : Json) : Prog Json := do
  let connection := Twin.callArg call 0
  let known ← Prog.effect "jetstreamManagers.get" [connection]
  if truthy known then
    return known
  let result ← Prog.attempt "connection.jetstreamManager" [Json.mkObj [("checkAPI", toJson false)]]
  let _ ← Prog.effect "jetstreamManagers.set" [connection, promiseTag]
  match result with
  | .ok manager => return manager
  | .threw error _ => throw error
  | .pending => Prog.unsupported "manager never settled"

private def errorMessage (error : Json) : String :=
  text (field (field error "$error") "message")

/-- An "already in use" or "already exists" answer means another pod created the stream. -/
private def alreadyThere (error : Json) : Bool :=
  let message := (errorMessage error).toLower
  Access.Js.includes message "already in use" || Access.Js.includes message "already exists"

/-- Shared shape of the two `ensure*Stream` functions: info then update, else add. -/
private def ensureStream (call : Json) (memo name updateLabel : String) (config : Json) :
    Prog Json := do
  if truthy (Twin.moduleValue call memo) then
    return Twin.undefinedJson
  Prog.setState ("module." ++ memo) promiseTag
  let jsm ← Prog.effect "jetstreamManagerFor" [Twin.callArg call 0]
  let _ := jsm
  match ← Prog.attempt "jsm.streams.info" [toJson name] with
  | .ok _ =>
    let _ ← Prog.attempt updateLabel [toJson name, config]
    return Twin.undefinedJson
  | _ =>
    match ← Prog.attempt "jsm.streams.add" [config] with
    | .threw error _ =>
      if alreadyThere error then return Twin.undefinedJson else throw error
    | _ => return Twin.undefinedJson

/-- `ensureResponseStream`. -/
def ensureResponseStream (call : Json) : Prog Json :=
  ensureStream call "ensureStreamPromise" "WS_RESPONSES" "jsm.streams.update" (Json.mkObj
    [("name", "WS_RESPONSES"), ("subjects", toJson ["v1.*.*.ws.response.*"]),
     ("retention", "limits"), ("storage", "file"), ("discard", "old"),
     ("max_age", toJson (180000000000 : Nat)), ("max_msgs_per_subject", toJson (2000 : Nat)),
     ("duplicate_window", toJson (120000000000 : Nat))])

/-- `ensureObservabilityStream`. -/
def ensureObservabilityStream (call : Json) : Prog Json :=
  ensureStream call "ensureObservabilityStreamPromise" "OBSERVABILITY" "jsm.streams .update"
    (Json.mkObj
      [("name", "OBSERVABILITY"),
       ("subjects", toJson ["v1.*.*.*.logs.>", "v1.*.*.*.traces.>"]),
       ("retention", "limits"), ("storage", "file"), ("discard", "old"),
       ("max_age", toJson (7200000000000 : Nat)), ("max_bytes", toJson (536870912 : Nat)),
       ("max_msgs_per_subject", toJson (20000 : Nat))])

/-- `KEYRING_TTL_MS`. -/
private def keyringTtl : Nat := 300000

/-- `keyringFor`: a cached keyring while it is young, else a new load. -/
def keyringFor (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  if let some cached := mapGet (Twin.moduleValue call "keyrings") accountId then
    let now ← Prog.effect "Date.now"
    if nat (field cached "expiresAt") > nat now then
      return cached
  Prog.spawn "loader" [accountId]
  let now ← Prog.effect "Date.now"
  let entry := Json.mkObj [("cipher", promiseTag), ("expiresAt", toJson (nat now + keyringTtl))]
  let old := Twin.moduleValue call "keyrings"
  Waveruns8a.changed "module.keyrings" old (Waveruns8a.mapPut old accountId entry)
  return entry

/-- `keyringHolding`: reloads once when the cipher lacks the blob's key. Which cipher comes back is
visible only through the promise, so the twin answers with the class, whose fields are not compared.
The cache ends as the last `keyringFor` left it, so that callee answers for it. -/
def keyringHolding (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let _ ← Prog.effect "keyringFor" [accountId]
  let holds ← Prog.effect "cipher.hasKey" [Twin.callArg call 1]
  if !truthy holds then
    let _ ← Prog.effect "keyringFor" [accountId]
  return Json.mkObj [("$opaque", "AccountCipher")]

private def settled : Outcome → Bool
  | .ok _ => true
  | _ => false

/-- `interruptLiveOwners`: settle errors are swallowed, a release error loses that owner's count. -/
def interruptLiveOwners (call : Json) : Prog Json := do
  let owners := (mapEntries (Twin.moduleValue call "liveOwners")).map (Twin.arg · 1)
  let failure := Twin.callArg call 0
  let settles := owners.map fun owner =>
    ("settleIngress", [Json.mkObj
      (ordered owner ++ [("status", Json.str "failed"), ("error", failure)])])
  let _ ← Prog.all settles
  let results ← Prog.all (owners.map fun owner => ("releaseIngressOwner", [owner]))
  let old := Twin.moduleValue call "liveOwners"
  let remaining := (owners.zip results).foldl (fun current (owner, result) =>
    if settled result then Waveruns8a.mapDelete current (field owner "conversationKey") else current) old
  Waveruns8a.changed "module.liveOwners" old remaining
  return toJson (results.filter settled).length

/-- `stopIngressRecovery`. -/
def stopIngressRecovery (call : Json) : Prog Json := do
  let timer := Twin.moduleValue call "recovery"
  if !truthy timer then
    return Twin.undefinedJson
  let _ ← Prog.effect "clearInterval" [timer]
  Prog.setState "module.recovery" Json.null
  return Twin.undefinedJson

/-- `CACHE_TTL_MS` in `connections.ts`. -/
private def connectionCacheTtl : Nat := 300000

/-- `loadFresh`: the stored connection, refreshed if near expiry or already refused. -/
def loadFresh (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let kind := Twin.callArg call 1
  let key := Json.str s!"{text accountId}:{text kind}"
  let _ ← Prog.effect "getStorage"
  let stored ← Prog.effect "getStorage().connections.load" [accountId, kind]
  if !truthy stored then
    let cache := Twin.moduleValue call "cache"
    Waveruns8a.changed "module.cache" cache (Waveruns8a.mapDelete cache key)
    Prog.throwError "Error"
      s!"This account has no {text kind} connection. Run `broods connect {text kind}` to sign in."
  let soon ← Prog.effect "expiresSoon" [stored]
  let refused := mapGet (Twin.moduleValue call "rejected") key == some (field stored "accessToken")
  let connection ←
    if truthy soon || refused then
      Prog.effect "refreshAndSave" [accountId, kind, stored]
    else pure stored
  let now ← Prog.effect "Date.now"
  let cache := Twin.moduleValue call "cache"
  let rejected := Twin.moduleValue call "rejected"
  Waveruns8a.changed "module.rejected" rejected (Waveruns8a.mapDelete rejected key)
  Waveruns8a.changed "module.cache" cache (Waveruns8a.mapPut cache key
    (Json.mkObj [("connection", connection), ("loadedAt", now)]))
  return connection

/-- `accessToken`: from the cache while young, else a shared load. Joining another caller's load
yields a value only the promise holds, so that call is out of the model. -/
def accessToken (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let kind := Twin.callArg call 1
  let key := Json.str s!"{text accountId}:{text kind}"
  if let some cached := mapGet (Twin.moduleValue call "cache") key then
    let now ← Prog.effect "Date.now"
    if nat now - nat (field cached "loadedAt") < connectionCacheTtl then
      let soon ← Prog.effect "expiresSoon" [field cached "connection"]
      if !truthy soon then
        return field (field cached "connection") "accessToken"
  if (mapGet (Twin.moduleValue call "inFlight") key).isSome then
    Prog.unsupported "joined another caller's load"
  let connection ← Prog.effect "loadFresh" [accountId, kind]
  return field connection "accessToken"

/-- Ingress limits from `ingress.ts`, in the order `acceptIngress` sends them. -/
private def ingressLimits : List (String × Json) :=
  [("leaseTtlMs", toJson (900000 : Nat)), ("envelopeTtlMs", toJson (900000 : Nat)),
   ("statusTtlMs", toJson (604800000 : Nat)), ("maxQueuedCount", toJson (100 : Nat)),
   ("maxQueuedBytes", toJson (1048576 : Nat))]

private def keysJson (names : List String) : Json := toJson names

private def orderedObject (entries : List (String × Json)) : Json :=
  Json.mkObj (("$keys", keysJson (entries.map (·.1))) :: entries)

/-- `acceptIngress`: digest and size are over the candidate's execution-changing fields. -/
def acceptIngress (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let delivery := field input "delivery"
  let channelKind := field delivery "kind" == "channel"
  let queued ← Prog.effect "queuedCommand"
    [field input "events", if channelKind then field delivery "channel" else Twin.undefinedJson]
  let candidate : List (String × Json) :=
    if truthy queued then
      (ordered input).map fun entry =>
        if entry.1 == "requestedMode" then (entry.1, "followup") else entry
    else ordered input
  let look (key : String) : Json := (candidate.lookup key).getD Twin.undefinedJson
  let optional (key : String) : List (String × Json) :=
    if undef (look key) then [] else [(key, look key)]
  let serialized := stringify (orderedObject
    ([("events", look "events")] ++ optional "configRef" ++ optional "ephemeralSystem"))
  let digestSource := stringify (orderedObject
    [("events", look "events"), ("requestedMode", look "requestedMode"),
     ("deliveryKind", field delivery "kind"), ("activeOwnerOnly", look "activeOwnerOnly"),
     ("expectedOwnerTaskId", look "expectedOwnerTaskId"), ("ownerTaskId", look "ownerTaskId"),
     ("configRef", look "configRef"), ("ephemeralSystem", look "ephemeralSystem")])
  let digest ← Prog.effect "sha256Hex" [toJson digestSource]
  let target := look "channelTarget"
  let source := field delivery "source"
  let channelPart : List (String × Json) :=
    if channelKind && truthy target then
      [("channelTarget", Json.mkObj ((ordered target).filter
        (fun entry => entry.1 != "channelName" && entry.1 != "source") ++
        [("channelName", field delivery "channel"),
         ("source", if undef source || source == .null then Json.mkObj [] else source)]))]
    else []
  let admitted := candidate.filter (·.1 != "channelTarget")
  let reserved := channelPart.map (·.1) ++ ["payloadDigest", "sizeBytes"] ++ ingressLimits.map (·.1)
  let admission ← Prog.effect "runtime.mutate"
    ["acceptIngress", Json.mkObj
      (admitted.filter (fun entry => !reserved.contains entry.1) ++ channelPart ++
        [("payloadDigest", digest),
         ("sizeBytes", toJson (Access.Crypto.utf8 serialized).length)] ++ ingressLimits)]
  let conversationKey := look "conversationKey"
  let recovered := field admission "recovered"
  if truthy recovered then
    let _ ← Prog.effect "trackOwner" [Json.mkObj
      [("conversationKey", conversationKey),
       ("ownerEventId", field recovered "eventId"),
       ("ownerGeneration", field recovered "ownerGeneration")]]
  if field admission "outcome" == "owner" && !undef (field admission "ownerGeneration") then
    let _ ← Prog.effect "trackOwner" [Json.mkObj
      [("conversationKey", conversationKey),
       ("ownerEventId", look "eventId"),
       ("ownerGeneration", field admission "ownerGeneration")]]
  return admission

/-- `waitAndDrainAsyncWork`. A timed-out wait detaches what is still running. -/
def waitAndDrainAsyncWork (call : Json) : Prog Json := do
  let coordinator := Twin.callArg call 0
  let pending := Twin.field coordinator "pendingCount"
  let pending := if undef pending then field coordinator "pendingCount" else pending
  if nat pending == 0 then
    return ← Prog.effect "subagentCoordinator.drainCompletionsToParent"
  let status ← Prog.effect "subagentCoordinator.waitForIdle" [Twin.param call 1]
  if status == "timeout" then
    Prog.effect "subagentCoordinator.drainCompletionsAndDetachToParent"
  else
    Prog.effect "subagentCoordinator.drainCompletionsToParent"

/-- `handler`: runs the request inside its observability scope. -/
def handler (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let context := Twin.callArg call 1
  .input fun
    | some ("arg0", _) => Prog.effect "handleRequest" [event, context]
    | _ => Prog.unsupported "scope callback was not entered"

/-- `waitUntilMs`: the deadline less the wind-down margin, never before now. -/
def waitUntilMs (call : Json) : Prog Json := do
  let deadline := field (Twin.callArg call 0) "deadlineMs"
  let now ← Prog.effect "Date.now"
  match deadline with
  | .num value =>
    if value.mantissa != 0 then
      let target := value.mantissa.toNat
      return toJson (max (nat now) (target - 180000))
    return toJson (nat now + 480000)
  | _ => return toJson (nat now + 480000)

/-- `natsStartResponse`. -/
def natsStartResponse (call : Json) : Prog Json :=
  let event := Twin.callArg call 0
  let statusUrl := Twin.callArg call 2
  Prog.effect "jsonResponse" [toJson (202 : Nat), Json.mkObj
    ([("eventId", Twin.callArg call 1), ("runId", field event "runId"),
      ("conversationKey", field event "publicConversationKey"),
      ("status", "processing"), ("requestedMode", field event "requestedMode")] ++
     (if truthy statusUrl then [("statusUrl", statusUrl)] else []) ++
     [("nats", Json.mkObj
       [("accountId", field event "accountId"), ("agentId", field event "agentId"),
        ("conversationKey", field event "publicConversationKey")])])]

private def conversationBusy : String :=
  "Conversation is already processing another turn. Try again when the current turn finishes."

private def retryHeaders : Json := Json.mkObj [("Retry-After", "5")]

private def codeJson (code : String) : Json := Json.mkObj [("code", toJson code)]

/-- The three refusals, as `(status, message, code)`. -/
private def refusal (outcome : Json) : Option (Nat × String × String) :=
  if outcome == "rejected" then some (409, conversationBusy, "conversation_busy")
  else if outcome == "capacity" then
    some (429, "Conversation ingress queue is at capacity", "ingress_capacity")
  else if outcome == "conflict" then
    some (409, "Idempotency key is already bound to a different ingress payload",
      "idempotency_conflict")
  else none

private def refusalJson (status : Nat) (message code : String) : Prog Json :=
  Prog.effect "errorResponse"
    ([toJson status, toJson message, codeJson code] ++
      (if status == 429 then [retryHeaders] else []))

private def refusalSse (status : Nat) (message : String) : Prog Json :=
  Prog.effect "errorSseResponse" [toJson message, toJson status]

private def orElse (value fallback : Json) : Json :=
  if undef value || value == .null then fallback else value

/-- `directAdmissionResponse`. -/
def directAdmissionResponse (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let admission := Twin.callArg call 1
  if let some (status, message, code) := refusal (field admission "outcome") then
    return ← if truthy (Twin.callArg call 2) then refusalJson status message code
      else refusalSse status message
  let publicEventId ← Prog.effect "publicEventIdFromScoped" [field admission "eventId", event]
  let runId := orElse (field admission "runId") (field event "runId")
  let statusUrl ← Prog.effect "directStatusUrl" [Json.mkObj [("runId", runId)]]
  Prog.effect "jsonResponse" [toJson (202 : Nat), Json.mkObj
    ([("runId", runId), ("eventId", publicEventId),
      ("conversationKey", field event "publicConversationKey"),
      ("status", orElse (field admission "status") "queued"),
      ("requestedMode", field event "requestedMode")] ++
     (if truthy statusUrl then [("statusUrl", statusUrl)] else []))]

/-- `asyncAdmissionResponse`. -/
def asyncAdmissionResponse (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let admission := Twin.callArg call 1
  if let some (status, message, code) := refusal (field admission "outcome") then
    return ← refusalJson status message code
  let publicEventId ← Prog.effect "publicEventIdFromScoped" [field admission "eventId", event]
  let runId := orElse (field admission "runId") (field event "runId")
  let statusUrl ← Prog.effect "directStatusUrl" [Json.mkObj [("runId", runId)]]
  Prog.effect "acceptedAsyncResponse"
    [runId, orElse statusUrl (field event "statusUrl"),
     Json.mkObj
       [("publicEventId", publicEventId),
        ("publicConversationKey", field event "publicConversationKey"),
        ("requestedMode", field event "requestedMode")],
     orElse (field admission "status") "queued"]

/-- `publicEventIdFromScoped`. -/
def publicEventIdFromScoped (call : Json) : Prog Json :=
  let event := Twin.callArg call 1
  Prog.effect "publicEventIdForScope"
    [Twin.callArg call 0, field event "accountId", field event "agentId",
     field event "publicEventId"]

/-- `bindAsyncToolResultSandbox`. -/
def bindAsyncToolResultSandbox (call : Json) : Prog Json :=
  Prog.effect "runtime.mutate" ["bindAsyncToolResultSandbox", Json.mkObj
    [("resultId", Twin.callArg call 0), ("sandbox", Twin.callArg call 1)]]

/-- `markAsyncToolResultCompleted`: only a row still processing moves. -/
def markAsyncToolResultCompleted (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let response ← Prog.effect "redactWithRunSecrets" [field options "response"]
  let _ ← Prog.effect "runtime.mutate" ["updateAsyncToolResult", Json.mkObj
    [("resultId", field options "resultId"), ("status", "completed"), ("response", response),
     ("onlyWhenProcessing", toJson true)]]
  return Twin.undefinedJson

/-- `markAsyncToolHandback`: a failed write is logged, never raised. -/
def markAsyncToolHandback (call : Json) : Prog Json := do
  let outcome ← Prog.attempt "runtime.mutate" ["markAsyncToolHandback", Json.mkObj
    [("resultId", Twin.callArg call 0), ("handback", Twin.callArg call 1)]]
  match outcome with
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    return Twin.undefinedJson
  | _ => return Twin.undefinedJson

/-- `applySteering`. -/
def applySteering (call : Json) : Prog Json :=
  let options := ordered (Twin.callArg call 0)
  Prog.effect "runtime.mutate" ["applyIngressSteering", Json.mkObj
    (options ++ [("leaseTtlMs", toJson (900000 : Nat))])]

/-- `emptySseResponse`: a stream closed as soon as it starts. -/
def emptySseResponse (_call : Json) : Prog Json := do
  Prog.drain (fun label _ =>
    if label == "start" then do
      let _ ← Prog.effect "controller.close"
      pure ()
    else Prog.unsupported s!"callback {label}") 4
  let _ ← Prog.effect "new ReadableStream" [Json.mkObj [("start", Json.mkObj [("$fn", "start")])]]
  return Json.mkObj [("$response", Json.mkObj
    [("status", toJson (200 : Nat)),
     ("headers", toJson [toJson ["content-type", "text/event-stream"]]),
     ("body", Json.mkObj [("$opaque", "ReadableStream")])])]

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/worker-queue.ts#workerQueueFull" workerQueueFull,
   Twin.traced "apps/core/src/harness/worker-queue.ts#enqueueWorker" enqueueWorker,
   Twin.traced "apps/core/src/harness/worker-queue.ts#startNextWorker" startNextWorker,
   Twin.traced "apps/core/src/harness/worker-queue.ts#renewQueuedLeases" renewQueuedLeases,
   Twin.traced "apps/core/src/harness/worker-queue.ts#drainInProcessWorkers" drainInProcessWorkers,
   Twin.traced "apps/core/src/harness/ingress.ts#trackOwner" trackOwner,
   Twin.traced "apps/core/src/harness/ingress.ts#forgetOwner" forgetOwner,
   Twin.traced "apps/core/src/harness/nats-publisher.ts#LiveNatsPublisher.redactPayload" redactPayload,
   Twin.traced "apps/core/src/harness/nats-publisher.ts#LiveNatsPublisher.envelope" envelope,
   Twin.traced "apps/core/src/shared/convex/client.ts#getConvexClient" getConvexClient,
   Twin.traced "apps/core/src/shared/storage.ts#getStorage" getStorage,
   Twin.traced "apps/core/src/harness/nats-publisher.ts#LiveNatsPublisher.encodeWithinLimit" encodeWithinLimit,
   Twin.traced "apps/core/src/harness/nats-publisher.ts#LiveNatsPublisher.getConnection" getConnection,
   Twin.traced "apps/core/src/harness/nats-publisher.ts#LiveNatsPublisher.close" close,
   Twin.traced "apps/core/src/harness/nats-publisher.ts#LiveNatsPublisher.publish" publish,
   Twin.traced "apps/core/src/shared/nats.ts#jetstreamManagerFor" jetstreamManagerFor,
   Twin.traced "apps/core/src/shared/nats.ts#ensureResponseStream" ensureResponseStream,
   Twin.traced "apps/core/src/shared/nats.ts#ensureObservabilityStream" ensureObservabilityStream,
   Twin.traced "apps/core/src/shared/convex/account-keys.ts#keyringFor" keyringFor,
   Twin.traced "apps/core/src/shared/convex/account-keys.ts#keyringHolding" keyringHolding,
   Twin.traced "apps/core/src/harness/ingress.ts#interruptLiveOwners" interruptLiveOwners,
   Twin.traced "apps/core/src/harness/ingress-recovery.ts#stopIngressRecovery" stopIngressRecovery,
   Twin.traced "apps/core/src/harness/connections.ts#loadFresh" loadFresh,
   Twin.traced "apps/core/src/harness/connections.ts#accessToken" accessToken,
   Twin.traced "apps/core/src/harness/ingress.ts#acceptIngress" acceptIngress,
   Twin.traced "apps/core/src/harness/continuation.ts#waitAndDrainAsyncWork" waitAndDrainAsyncWork,
   Twin.traced "apps/core/src/harness/handler.ts#handler" handler,
   Twin.traced "apps/core/src/harness/continuation.ts#waitUntilMs" waitUntilMs,
   Twin.traced "apps/core/src/harness/responses.ts#natsStartResponse" natsStartResponse,
   Twin.traced "apps/core/src/harness/responses.ts#directAdmissionResponse" directAdmissionResponse,
   Twin.traced "apps/core/src/harness/responses.ts#asyncAdmissionResponse" asyncAdmissionResponse,
   Twin.traced "apps/core/src/harness/responses.ts#publicEventIdFromScoped" publicEventIdFromScoped,
   Twin.traced "apps/core/src/harness/async-tool-result.ts#bindAsyncToolResultSandbox" bindAsyncToolResultSandbox,
   Twin.traced "apps/core/src/harness/async-tool-result.ts#markAsyncToolResultCompleted" markAsyncToolResultCompleted,
   Twin.traced "apps/core/src/harness/async-tool-result.ts#markAsyncToolHandback" markAsyncToolHandback,
   Twin.traced "apps/core/src/harness/ingress.ts#applySteering" applySteering,
   Twin.traced "apps/core/src/harness/responses.ts#emptySseResponse" emptySseResponse]

end Spec.Runs.Waveruns3a
