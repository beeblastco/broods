import Spec.Twin

/-!
Twins of `mirror-writes.ts`, the per-account queue every sandbox executor sends its row writes
through. A queued write's promise settles only once the write landed, so the recorder keeps
`enqueue`, `place` and the queue entry points open while later writes on the account run.
-/

namespace Spec.Sandbox.Wave15

open Lean Spec

private def mirror (name : String) : String :=
  "apps/core/src/harness/sandbox/mirror-writes.ts#" ++ name

/-! ## JSON helpers -/

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool := value.compress == undef.compress

private def nullish (value : Json) : Bool := isUndef value || value == .null

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def str (value : Json) : String := value.getStr?.toOption.getD ""

private def truthy (value : Json) : Bool :=
  match value with
  | .null | .bool false | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def items (value : Json) : List Json := (value.getArr?.toOption.getD #[]).toList

private def intOf (value : Json) : Int := value.getInt?.toOption.getD 0

/-- Template-literal text of a string or number. -/
private def jsText (value : Json) : String :=
  match value with
  | .str text => text
  | other => if isUndef other then "undefined" else other.compress

/-- Entries of an object in the key order the recorder saw. -/
private def entriesOf (value : Json) : List (String × Json) :=
  match isUndef value, value with
  | false, .obj kvs =>
    let keys : List String :=
      match value.getObjVal? "$keys" with
      | .ok (.arr names) => names.toList.filterMap fun name => name.getStr?.toOption
      | _ => kvs.toArray.toList.map (·.1)
    keys.filterMap fun key =>
      match value.getObjVal? key with
      | .ok item => if key == "$keys" || key == "$fields" then none else some (key, item)
      | _ => none
  | _, _ => []

/-- Object spread: later keys replace the value but keep the first position. -/
private def spreadAll (objects : List Json) : List (String × Json) :=
  objects.foldl
    (fun acc object =>
      (entriesOf object).foldl
        (fun inner entry =>
          if inner.any (·.1 == entry.1) then
            inner.map fun existing => if existing.1 == entry.1 then entry else existing
          else inner ++ [entry])
        acc)
    []

private def lookup (entries : List (String × Json)) (key : String) : Json :=
  ((entries.find? (·.1 == key)).map (·.2)).getD undef

/-- An object literal; a key holding `undefined` is absent, as the recorder writes it. -/
private def defined (entries : List (String × Json)) : Json :=
  Json.mkObj (entries.filter fun entry => !isUndef entry.2)

private def withKey (value : Json) (key : String) (item : Json) : Json :=
  Json.mkObj (spreadAll [value, Json.mkObj [(key, item)]])

private def fnRef (name : String) : Json := Json.mkObj [("$fn", toJson name)]

private def promiseRef : Json := Json.mkObj [("$opaque", toJson "Promise")]

/-- An object the call handed to an effect, as the recorder writes it afterwards. -/
private def handed : Json := Json.mkObj [("$handed", toJson true)]

/-- `Promise.withResolvers<void>()`. -/
private def resolvers : Json :=
  Json.mkObj [("resolve", fnRef ""), ("reject", fnRef ""), ("promise", promiseRef)]

/-- A value as the recorder writes an argument when the call ends: every promise reads as handed. -/
private def afterCall : Nat → Json → Json
  | 0, value => value
  | fuel + 1, value =>
    match value with
    | .arr members => .arr (members.map (afterCall fuel))
    | .obj _ =>
      if field value "$opaque" == toJson "Promise" then handed
      else Json.mkObj ((entriesOf value).map fun entry => (entry.1, afterCall fuel entry.2))
    | other => other

private def mapEntries (value : Json) : List (String × Json) :=
  (items (field value "$map")).filterMap fun entry =>
    match entry with
    | .arr #[.str key, item] => some (key, item)
    | _ => none

private def mapJson (entries : List (String × Json)) : Json :=
  Json.mkObj [("$map", Json.arr (entries.map fun entry => Json.arr #[toJson entry.1, entry.2]).toArray)]

private def setItems (value : Json) : List Json := items (field value "$set")

private def setJson (members : List Json) : Json := Json.mkObj [("$set", Json.arr members.toArray)]

private def coalesce (value fallback : Json) : Json := if nullish value then fallback else value

/-! ## Constants (`mirror-writes.ts:17-25`, `shared/sandbox.ts:8`) -/

private def writeTimeoutMs : Nat := 10000
private def writeSlowMs : Int := 2000
private def warnEveryMs : Int := 30000
private def refreshEveryMs : Int := 60000
private def refreshIdlePart : Int := 15
private def defaultIdleSeconds : Int := 900

/-! ## Pure parts -/

private def laneKey (accountId rowKey : Json) : String := s!"{jsText accountId} {jsText rowKey}"

private def isChange (write : Json) : Bool :=
  field write "kind" == toJson "remove" || field write "kind" == toJson "status"

/-- `mergedUpsert`: the newer upsert, with each run field it lacks taken from the older one. -/
private def merge (older newer : Json) : Json :=
  let was := spreadAll [field older "metadata", field older "options"]
  let now := spreadAll [field newer "metadata", field newer "options"]
  let pick (key : String) : String × Json := (key, coalesce (lookup now key) (lookup was key))
  let metadata := defined
    (["traceId", "taskId", "agentId", "conversationKey", "workspaceName", "workspaceId"].map pick)
  let options := defined (["ephemeral", "logStream", "specs"].map pick)
  Json.mkObj (spreadAll [newer, Json.mkObj [("metadata", metadata), ("options", options)]])

private def sameLane (a b : Json) : Bool := field a "id" == field b "id"

/-- Whether `park` moves a lane to the urgent set: it holds a status, removal or burst. -/
private def holdsUrgent (lane : Json) : Bool :=
  (items (field lane "writes")).any fun write => isChange write || field write "kind" == toJson "burst"

/-- The sender after `park(sender, lane)`. -/
private def parked (sender lane : Json) (urgent : Bool) : Json :=
  let urgentSet := setItems (field sender "urgent")
  let readySet := setItems (field sender "ready")
  if urgent then
    let nextUrgent := if urgentSet.any (sameLane lane) then urgentSet else urgentSet ++ [lane]
    withKey (withKey sender "ready" (setJson (readySet.filter (!sameLane lane ·)))) "urgent"
      (setJson nextUrgent)
  else if urgentSet.any (sameLane lane) then sender
  else if readySet.any (sameLane lane) then sender
  else withKey sender "ready" (setJson (readySet ++ [lane]))

/-- The lane after `place(lane, write)` ran its synchronous part. -/
private def placed (lane write : Json) : Json :=
  let writes := items (field lane "writes")
  let push := withKey lane "writes" (Json.arr (writes ++ [write]).toArray)
  match writes.getLast? with
  | none => push
  | some last =>
    if field write "kind" == toJson "status" || field last "kind" != field write "kind" ||
        field last "externalId" != field write "externalId" then push
    else
      let replaced :=
        if truthy (field last "upsert") && truthy (field write "upsert") then
          withKey (withKey last "upsert" (merge (field last "upsert") (field write "upsert")))
            "send" (fnRef "")
        else withKey last "send" (field write "send")
      withKey lane "writes" (Json.arr (writes.dropLast ++ [replaced]).toArray)

private def upsertArgs (upsert : Json) : List Json :=
  [field upsert "controlPlane", field upsert "provider", field upsert "reservationKey",
   field upsert "externalId", field upsert "metadata", field upsert "options"]

/-- Whether the outside just entered this function's callback `label`. -/
private def entered (label : String) : Prog Bool :=
  .input fun
    | some (name, _) => pure (name == label)
    | none => pure false

/-- The send closure a queue entry point made, if `enqueue` ran it before returning. -/
private def drainSend (send : Prog Unit) : Prog Unit :=
  Prog.drain (fun label _ => if label == "send" then send else pure ()) 1

/-! ## Leaves -/

/-- `laneId`. -/
private def laneId (call : Json) : Prog Json :=
  pure (toJson (laneKey (Twin.callArg call 0) (Twin.callArg call 1)))

/-- `changesRow`. -/
private def changesRow (call : Json) : Prog Json :=
  pure (toJson (isChange (Twin.callArg call 0)))

/-- `mergedUpsert`. -/
private def mergedUpsert (call : Json) : Prog Json :=
  pure (merge (Twin.callArg call 0) (Twin.callArg call 1))

/-- `sendUpsert`. -/
private def sendUpsert (call : Json) : Prog Json :=
  Prog.effect "upsertSandboxInstance" (upsertArgs (Twin.callArg call 0))

/-- `mirrorQueueStats`. -/
private def mirrorQueueStats (call : Json) : Prog Json := do
  let now := intOf (← Prog.effect "Date.now")
  let lanes := mapEntries (Twin.moduleValue call "lanes")
  let writes := lanes.flatMap fun entry => items (field entry.2 "writes")
  let oldest := writes.foldl (fun acc write => min acc (intOf (field write "queuedAt"))) now
  return Json.mkObj
    [("rows", toJson lanes.length), ("pending", toJson writes.length),
     ("oldestPendingMs", toJson (now - oldest))]

/-- `lane.writes.some(...)` in `park`: each write goes to the `changesRow` effect until one is urgent.
Gives whether one was, and how many writes were handed out. -/
private def urgentScan : List Json → Prog (Bool × Nat)
  | [] => pure (false, 0)
  | write :: rest => do
    let changes ← Prog.effect "changesRow" [write]
    if truthy changes || field write "kind" == toJson "burst" then return (true, 1)
    let (found, count) ← urgentScan rest
    return (found, count + 1)

/-- `park`. -/
private def park (call : Json) : Prog Json := do
  let sender := Twin.callArg call 0
  let lane := Twin.callArg call 1
  let writes := items (field lane "writes")
  let (urgent, count) ← urgentScan writes
  let shown := withKey lane "writes"
    (Json.arr ((writes.take count).map (fun _ => handed) ++ writes.drop count).toArray)
  let after := parked sender shown urgent
  for key in ["urgent", "ready"] do
    let before := setItems (field sender key)
    let now := setItems (field after key)
    if before.map (field · "id") != now.map (field · "id") then
      Prog.setState s!"args.0.{key}.$set" (afterCall 32 (Json.arr now.toArray))
  return undef

/-! ## Sending -/

/-- `land`: races the send against the timeout, then records a landed refresh and warns when slow.
`lane.writes` is read again after the await, where only a later write can have joined it (the lane
is sending, so nothing leaves it); the twin sees it at entry, so it opts out where that read decides (L17). -/
private def land (call : Json) : Prog Json := do
  let lane := Twin.callArg call 0
  let write := Twin.callArg call 1
  let _ ← entered "arg0"
  let timer ← Prog.effect "setTimeout" [fnRef "", toJson writeTimeoutMs]
  let _ ← entered "arg0"
  let sent : Option Bool ←
    match ← Prog.attempt "write.send" with
    | .threw _ true => pure (some false)
    | .threw _ false => do
      let _ ← Prog.effect "resolve" [promiseRef]
      pure (some false)
    | .ok value => do
      let _ ← Prog.effect "resolve" [promiseRef]
      pure (some (value == toJson true))
    | .pending => do
      let _ ← Prog.effect "resolve" [promiseRef]
      pure none
  let fired ← entered "arg0"
  if fired then
    let _ ← Prog.effect "resolve" [undef]
  let landed : Option Bool := if fired then none else sent
  if !fired && sent.isNone then
    return ← Prog.unsupported "neither the send nor the timer settled in the recording"
  let _ ← Prog.attempt "clearTimeout" [timer]
  let now := intOf (← Prog.effect "Date.now")
  -- A status or removal at entry is still there after the await, so no refresh is recorded.
  if truthy (field write "upsert") && landed == some true &&
      !(items (field lane "writes")).any isChange then
    return ← Prog.unsupported "lane.writes read after the await may hold a write queued since (L17)"
  let waited := now - intOf (field write "queuedAt")
  let lastWarnAt := intOf (Twin.moduleValue call "lastWarnAt")
  if (landed.isNone || waited > writeSlowMs) && now - lastWarnAt ≥ warnEveryMs then
    if now != lastWarnAt then Prog.setState "module.lastWarnAt" (toJson now)
    let _ ← Prog.effect "mirrorQueueStats"
  return undef

/-- `pump`: when the account's sender is free, sends the first write of its first urgent, else ready,
lane; with none left the sender goes. -/
private def pump (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let sender := Twin.callArg call 1
  if truthy (field sender "busy") then return undef
  let first ← Prog.effect "sender.urgent.values().next"
  let lane ←
    if nullish (field first "value") then
      pure (field (← Prog.effect "sender.ready.values().next") "value")
    else pure (field first "value")
  let senders := mapEntries (Twin.moduleValue call "senders")
  match (if nullish lane then [] else items (field lane "writes")) with
  | [] =>
    let rest := senders.filter (·.1 != jsText account)
    if rest.length != senders.length then Prog.setState "module.senders" (mapJson rest)
    let _ ← Prog.effect "sender.idle.resolve"
    return undef
  | write :: tail =>
    let sending (value : Json) : Json :=
      withKey (withKey value "writes" (Json.arr tail.toArray)) "sending" (toJson true)
    let freed (value : Json) : Json :=
      withKey
        (withKey
          (withKey value "urgent" (setJson ((setItems (field value "urgent")).filter (!sameLane lane ·))))
          "ready" (setJson ((setItems (field value "ready")).filter (!sameLane lane ·))))
        "busy" (toJson true)
    let after := freed sender
    Prog.setState "args.1.busy" (toJson true)
    for key in ["urgent", "ready"] do
      if (setItems (field sender key)).length != (setItems (field after key)).length then
        Prog.setState s!"args.1.{key}.$set" (afterCall 32 (Json.arr (setItems (field after key)).toArray))
    let lanes := mapEntries (Twin.moduleValue call "lanes")
    let id := str (field lane "id")
    let nextLanes := lanes.map fun entry => if entry.1 == id then (entry.1, sending entry.2) else entry
    if (mapJson nextLanes).compress != (mapJson lanes).compress then
      Prog.setState "module.lanes" (mapJson nextLanes)
    let nextSenders :=
      senders.map fun entry => if entry.1 == jsText account then (entry.1, freed entry.2) else entry
    if (mapJson nextSenders).compress != (mapJson senders).compress then
      Prog.setState "module.senders" (mapJson nextSenders)
    Prog.spawn "land" [sending lane, write]
    return undef

/-! ## Queueing -/

/-- `place`. Its promise is the queued write's: a merged write is sent by the closure `place` leaves
behind, which runs inside this call only if no later write replaced it. -/
private def place (call : Json) : Prog Json := do
  let lane := Twin.callArg call 0
  let write := Twin.callArg call 1
  match (items (field lane "writes")).getLast? with
  | some last =>
    if field write "kind" != toJson "status" && field last "kind" == field write "kind" &&
        field last "externalId" == field write "externalId" &&
        truthy (field last "upsert") && truthy (field write "upsert") then
      let _ ← Prog.effect "mergedUpsert" [field last "upsert", field write "upsert"]
      return ← Prog.unsupported "whether the merged send runs before this promise settles depends on later writes"
  | none => pure ()
  return undef

/-- `enqueue`. `place` answers with the write's promise, which settles only once the write landed. -/
private def enqueue (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let rowKey := Twin.callArg call 1
  let write := Twin.callArg call 2
  let id ← Prog.effect "laneId" [account, rowKey]
  let lane := coalesce (lookup (mapEntries (Twin.moduleValue call "lanes")) (str id))
    (Json.mkObj [("id", id), ("rowKey", rowKey), ("writes", Json.arr #[]), ("sending", toJson false)])
  let changes ← Prog.effect "changesRow" [write]
  let refreshed := mapEntries (Twin.moduleValue call "refreshed")
  let kept := if truthy changes then refreshed.filter (·.1 != str id) else refreshed
  if kept.length != refreshed.length then Prog.setState "module.refreshed" (mapJson kept)
  let landed ← Prog.effect "place" [lane, write]
  let after := placed lane write
  let existing := lookup (mapEntries (Twin.moduleValue call "senders")) (jsText account)
  let sender :=
    coalesce existing
      (Json.mkObj [("busy", toJson false), ("urgent", setJson []), ("ready", setJson []),
        ("idle", resolvers)])
  if isUndef existing then
    let _ ← Prog.effect "waitUntil" [promiseRef]
  let ready ←
    if !truthy (field lane "sending") then do
      let _ ← Prog.effect "park" [sender, after]
      pure (parked sender after (holdsUrgent after))
    else pure sender
  let _ ← Prog.effect "pump" [account, ready]
  return landed

/-- `queueMirrorWrite`. -/
private def queueMirrorWrite (call : Json) : Prog Json := do
  let write := Twin.callArg call 2
  let queuedAt ← Prog.effect "Date.now"
  Prog.effect "enqueue"
    [Twin.callArg call 0, Twin.callArg call 1,
     defined [("kind", field write "kind"), ("externalId", field write "externalId"),
       ("queuedAt", queuedAt), ("send", field write "send"), ("done", resolvers)]]

/-- `queueMirrorRemove`. -/
private def queueMirrorRemove (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let key := Twin.callArg call 1
  let externalId := Twin.callArg call 2
  let queuedAt ← Prog.effect "Date.now"
  drainSend do
    let _ ← Prog.attempt "removeSandboxInstance" [account, key, externalId]
  Prog.effect "enqueue"
    [account, key,
     defined [("kind", toJson "remove"), ("externalId", externalId), ("queuedAt", queuedAt),
       ("send", fnRef "send"), ("done", resolvers)]]

/-- `queueMirrorUpsert`: drops refresh records older than the window, skips an unchanged refresh
inside it, and queues the rest. -/
private def queueMirrorUpsert (call : Json) : Prog Json := do
  let upsert := Twin.callArg call 0
  let plane := field upsert "controlPlane"
  if !truthy plane then return undef
  let now := intOf (← Prog.effect "Date.now")
  let refreshed := mapEntries (Twin.moduleValue call "refreshed")
  let kept := refreshed.dropWhile fun entry => now - intOf (field entry.2 "at") ≥ refreshEveryMs
  let id ← Prog.effect "laneId" [field plane "accountId", field upsert "reservationKey"]
  let last := lookup kept (str id)
  let idle := field plane "idleTimeoutSeconds"
  let idleSeconds ←
    if nullish idle then pure defaultIdleSeconds
    else match idle.getInt? with
      | .ok seconds => pure seconds
      | .error _ => Prog.unsupported "a fractional idle timeout"
  let at_ := intOf (field last "at")
  let inWindow :=
    now - at_ < refreshEveryMs && (now - at_) * 1000 * refreshIdlePart < idleSeconds * 1000 * 1000
  if !isUndef last && str (field last "signature") == Twin.jsonStringify 64 upsert &&
      now ≥ at_ && inWindow then
    if kept.length != refreshed.length then Prog.setState "module.refreshed" (mapJson kept)
    return undef
  let queuedAt ← Prog.effect "Date.now"
  drainSend do
    let _ ← Prog.attempt "sendUpsert" [upsert]
  Prog.effect "enqueue"
    [field plane "accountId", field upsert "reservationKey",
     defined [("kind", toJson "upsert"), ("externalId", field upsert "externalId"),
       ("queuedAt", queuedAt), ("send", fnRef "send"), ("upsert", upsert), ("done", resolvers)]]

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (mirror "laneId") laneId,
   Twin.traced (mirror "changesRow") changesRow,
   Twin.traced (mirror "mergedUpsert") mergedUpsert,
   Twin.traced (mirror "sendUpsert") sendUpsert,
   Twin.traced (mirror "mirrorQueueStats") mirrorQueueStats,
   Twin.traced (mirror "park") park,
   Twin.traced (mirror "land") land,
   Twin.traced (mirror "pump") pump,
   Twin.traced (mirror "place") place,
   Twin.traced (mirror "enqueue") enqueue,
   Twin.traced (mirror "queueMirrorWrite") queueMirrorWrite,
   Twin.traced (mirror "queueMirrorRemove") queueMirrorRemove,
   Twin.traced (mirror "queueMirrorUpsert") queueMirrorUpsert]

end Spec.Sandbox.Wave15
