import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign3/agent3b.tsv`.
-/

namespace Spec.Agent.Waveagent3b

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool :=
  value.compress == undef.compress

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD undef

private def isStr (value : Json) (expected : String) : Bool :=
  value == toJson expected

private def isTrue (value : Json) : Bool :=
  value == toJson true

private def items (value : Json) : List Json :=
  (value.getArr?.toOption.getD #[]).toList

private def isString (value : Json) : Bool :=
  (value.getStr?).toOption.isSome

private def text (value : Json) : String :=
  (value.getStr?).toOption.getD ""

private def arr (values : List Json) : Json :=
  .arr values.toArray

private def setKey (value : Json) (key : String) (next : Json) : Json :=
  value.setObjVal! key next

private def thisField (call : Json) (name : String) : Json :=
  Twin.field (Twin.self call) name

private def mapPairs (value : Json) : List (Json × Json) :=
  (items (field value "$map")).map fun pair =>
    (Twin.arg pair 0, Twin.arg pair 1)

private def mapGet (value : Json) (key : Json) : Option Json :=
  ((mapPairs value).find? (·.1 == key)).map (·.2)

private def setItems (value : Json) : List Json :=
  items (field value "$set")

private def filterEffect (fn : Json → Prog Bool) : List Json → Prog (List Json)
  | [] => pure []
  | head :: rest => do
    let keep ← fn head
    let tail ← filterEffect fn rest
    return if keep then head :: tail else tail

private def undeliveredOutputs : List String :=
  ["error-text", "error-json", "execution-denied"]

private def plain (source : String) (run : Json → Prog Json) : Twin :=
  Twin.traced source run

private def stored (name : String) : String :=
  "apps/core/src/harness/session.ts#" ++ name

private def coord (name : String) : String :=
  "apps/core/src/harness/subagents.ts#SubagentCoordinator." ++ name

/-- `withoutUnresolvedToolCalls` -/
def withoutUnresolvedToolCalls (call : Json) : Prog Json := do
  let messages := items (Twin.callArg call 0)
  let last := messages.getLast?.getD undef
  let isApproval ← Prog.effect "isToolApprovalResponseMessage" [last]
  let pending : List Json :=
    if isTrue isApproval then
      (items (field last "content")).filterMap fun part =>
        if isStr (field part "type") "tool-approval-response" then some (field part "approvalId")
        else none
    else []
  let resolved : List Json :=
    messages.flatMap fun message =>
      if isString (field message "content") then []
      else (items (field message "content")).filterMap fun part =>
        if isStr (field part "type") "tool-result" ||
            (isStr (field part "type") "tool-approval-request" &&
              pending.contains (field part "approvalId"))
        then some (field part "toolCallId") else none
  let keepPart (part : Json) : Bool :=
    let kind := field part "type"
    (!isStr kind "tool-call" && !isStr kind "tool-approval-request") ||
    (isStr kind "tool-call" && isTrue (field part "providerExecuted")) ||
    resolved.contains (field part "toolCallId")
  let rec go : List Json → Prog (List Json)
    | [] => pure []
    | message :: rest => do
      let parts := items (field message "content")
      if !isStr (field message "role") "assistant" || isString (field message "content") then
        return message :: (← go rest)
      let content := parts.filter keepPart
      if content.length == parts.length then
        return message :: (← go rest)
      let repaired ← Prog.effect "withoutStoredItems" [setKey message "content" (arr content)]
      let tail ← go rest
      return if (items (field repaired "content")).isEmpty then tail else repaired :: tail
  return arr (← go messages)

/-- `Session.toolResultIdsOf` -/
def toolResultIdsOf (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let reads := thisField call "toolResultReads"
  if !isStr (field message "role") "tool" || (mapPairs reads).isEmpty then
    return arr []
  return arr ((items (field message "content")).filterMap fun part =>
    if isStr (field part "type") "tool-result" &&
        !undeliveredOutputs.contains (text (field (field part "output") "type"))
    then mapGet reads (field part "toolCallId") else none)

/-- `sanitizeAssistantMessage` -/
def sanitizeAssistantMessage (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let retains := isTrue (Twin.callArg call 1)
  if isString (field message "content") then return message
  let content ← filterEffect (fun part => do
    let kept ← Prog.effect "isPersistedAssistantContentPart" [part]
    return isTrue kept && (retains || !isStr (field part "type") "reasoning"))
    (items (field message "content"))
  return if content.isEmpty then Json.null else setKey message "content" (arr content)

/-- `safeStringify`. A value the recorder could not carry is outside the model. -/
def safeStringify (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if isUndef value then return undef
  return toJson (Twin.jsonStringify 128 value)

/-- `harnessEntryBytes` -/
def harnessEntryBytes (call : Json) : Prog Json :=
  Prog.effect "getConvexSize" [Twin.callArg call 0]

private def latestCompactionThen (call : Json) (offset : Nat) : Prog Json := do
  let entries := Twin.callArg call 0
  let index ← Prog.effect "findLatestCompactionSummaryIndex" [entries]
  if index == toJson (-1 : Int) then return entries
  let at_ := (index.getNat?).toOption.getD 0
  return arr ((items entries).drop (at_ + offset))

/-- `toStoredConversationEvent` -/
def toStoredConversationEvent (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  if message == Json.null then return Json.null
  let metadata := Twin.callArg call 2
  let model := Twin.callArg call 3
  return Json.mkObj
    ([("version", toJson (1 : Nat)), ("sourceEventId", Twin.callArg call 1)] ++
      (if isUndef metadata then [] else [("metadata", metadata)]) ++
      (if isUndef model then [] else [("model", model)]) ++
      [("message", message)])

/-- `Session.channelLabel` -/
def channelLabel (call : Json) : Prog Json := do
  let delivery := thisField call "delivery"
  if isStr (thisField call "trigger") "cron" then
    return toJson "none, this is a scheduled run"
  if isStr (field delivery "kind") "channel" then return field delivery "channelName"
  return toJson (if isStr (field delivery "kind") "nats" then "live session" else "direct API")

/-- True when the recorder cut this value off at its depth limit, so a twin cannot rebuild it. -/
private def truncated (value : Json) : Bool :=
  (value.compress.splitOn "too-deep").length > 1

private def resolvedListChecked (call : Json) (key : String) (list : Json) : Prog Json :=
  if truncated list then Prog.unsupported s!"resolvedRuntime.{key} is cut off in the recording"
  else pure list

private def resolvedList (call : Json) (key : String) : Json :=
  let resolved := thisField call "resolvedRuntime"
  if isUndef resolved then arr [] else
    let list := field resolved key
    if isUndef list then arr [] else list

/-- `Session.enableDefaultHarness` -/
def enableDefaultHarness (call : Json) : Prog Json := do
  if !isUndef (field (thisField call "agentConfig") "harness") then return toJson false
  let rec any : List Json → Prog Bool
    | [] => pure false
    | workspace :: rest => do
      let enabled ← Prog.effect "workspaceGuidanceEnabled" [field workspace "config"]
      if isTrue enabled then return true
      any rest
  let workspaces ← resolvedListChecked call "workspaces" (resolvedList call "workspaces")
  return toJson (← any (items workspaces))

/-- `Session.assertRecentOwner`. The owner check interval is `OWNER_CHECK_INTERVAL_MS`. -/
def assertRecentOwner (call : Json) : Prog Json := do
  if !isTrue (thisField call "ownerHandedOff") then
    let now ← Prog.effect "performance.now"
    let confirmed := thisField call "ownerConfirmedAt"
    let fresh : Bool :=
      if field confirmed "$number" == toJson "-Infinity" then false
      else match now.getNum?, confirmed.getNum? with
        | .ok a, .ok b => (a.toFloat - b.toFloat) < 2000
        | _, _ => false
    if fresh then return undef
  let _ ← Prog.effect "this.assertCurrentOwner"
  return undef

private def member (value : Json) (key : String) : Json :=
  if isUndef (field value "$opaque") then field value key else Twin.field value key

private def truthy (value : Json) : Bool :=
  !isUndef value && value != Json.null && value != toJson false && value != toJson "" &&
    value != toJson (0 : Nat)

private def nullish (value : Json) : Bool :=
  isUndef value || value == Json.null

/-- Object entries from an optional `...(cond ? {k: v} : {})` spread. -/
private def optKey (present : Bool) (key : String) (value : Json) : List (String × Json) :=
  if present then [(key, value)] else []

/-- `value` with every entry of `extra` set on it, later entries winning. -/
private def spread (value : Json) (extra : List (String × Json)) : Json :=
  extra.foldl (fun acc entry => acc.setObjVal! entry.1 entry.2) value

/-- `Session.writeFenced`. The pending rows are taken at entry and put back, with the ones given, when
anything fails. Rows another caller queues during the write are not stated. -/
def writeFenced (call : Json) : Prog Json := do
  let before := thisField call "pendingStoredEvents"
  let pending := items before
  let rows := (pending ++ items (Twin.callArg call 0)).map fun row =>
    let key := field row "dedupeKey"
    setKey row "dedupeKey" (if nullish key then field row "cursor" else key)
  let result ← Prog.catchFail
    (do
      let batches ← Prog.effect "storedEventBatches" [arr rows]
      let all := items batches
      let inline := all.getLast?.getD (arr [])
      for batch in all.dropLast do
        let _ ← Prog.effect "this.appendConversationEvents" [batch]
      Prog.effect "write" [inline, arr rows])
    (fun error => do
      Prog.setChanged "self.pendingStoredEvents" before (arr rows)
      throw error)
  Prog.setChanged "self.pendingStoredEvents" before (arr [])
  return result

/-- `Session.flushPendingStoredEvents` -/
def flushPendingStoredEvents (call : Json) : Prog Json := do
  if (items (thisField call "pendingStoredEvents")).isEmpty then return undef
  let _ ← Prog.effect "this.writeFenced"
    [arr [], Json.mkObj [("$fn", toJson "")]]
  return undef

/-- `SubagentCoordinator.runningTaskFor` -/
def runningTaskFor (call : Json) : Prog Json := do
  let publicKey := Twin.callArg call 0
  let found := (mapPairs (thisField call "pendingMetadata")).find? fun entry =>
    field entry.2 "conversationKey" == publicKey
  return (found.map fun entry => field entry.2 "taskId").getD undef

private def outbox (call : Json) : List Json :=
  (items (thisField call "outbox")).map (field · "completion")

/-- `SubagentCoordinator.answered` -/
def answered (call : Json) : Prog Json := do
  let eventId := field (Twin.callArg call 0) "eventId"
  return toJson ((outbox call).any fun completion => field completion "eventId" == eventId)

/-- `SubagentCoordinator.hasChildMessage` -/
def hasChildMessage (call : Json) : Prog Json :=
  pure (toJson ((outbox call).any fun completion =>
    isStr (field completion "status") "awaiting_input"))

/-- `SubagentCoordinator.detachOverdueWaits` -/
def detachOverdueWaits (call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  for (taskId, at_) in mapPairs (thisField call "waitDeadlines") do
    let overdue : Bool := match at_.getNum?, now.getNum? with
      | .ok a, .ok b => a.toFloat <= b.toFloat
      | _, _ => false
    if overdue then
      let _ ← Prog.effect "this.detachTask" [taskId, toJson true]
  return undef

/-- `SubagentCoordinator.notifyCompletion` -/
def notifyCompletion (call : Json) : Prog Json := do
  let waiters := thisField call "waiters"
  if !isUndef (field waiters "$big") then
    return ← Prog.unsupported "the waiter set was too big to record"
  for _ in setItems waiters do
    let _ ← Prog.effect "waiter"
  if !(setItems waiters).isEmpty then
    Prog.setState "self.waiters" (Json.mkObj [("$set", arr [])])
  return undef

private def parentSession (call : Json) : Json := thisField call "parentSession"

private def parentConfig (call : Json) : Json := thisField call "parentAgentConfig"

private def isPersistent (call : Json) : Bool :=
  let subagent := field (parentConfig call) "subagent"
  !isStr (field subagent "mode") "ephemeral"

/-- `SubagentCoordinator.mintChildKey` -/
def mintChildKey (call : Json) : Prog Json := do
  let accountId := text (Twin.callArg call 0)
  let uuid := text (Twin.callArg call 1)
  let session := parentSession call
  let agent := member session "agentId"
  let agentText := if nullish agent then "" else text agent
  let keyField := member session "conversationKey"
  let keyText := if isUndef keyField then "undefined" else text keyField
  let scope := s!"{accountId}:{agentText}:{keyText}:{uuid}"
  let tag ← Prog.effect "subagentKeyTag" [toJson scope]
  return toJson s!"subagent-persistent-{uuid}-{text tag}"

/-- `SubagentCoordinator.childTask` -/
def childTask (call : Json) : Prog Json := do
  let child := Twin.callArg call 0
  let turn := Twin.callArg call 1
  let runId ← Prog.effect "createRunId"
  let accountId ← Prog.effect "requireParentAccountId" [parentSession call]
  let eventId ← Prog.effect "scopedDirectEventId"
    [accountId, field child "agentId", field turn "taskId"]
  let payer := field turn "payer"
  return spread child
    (optKey (truthy payer) "payer" payer ++
      [("taskId", field turn "taskId"),
       ("runId", runId),
       ("eventId", eventId),
       ("prompt", field turn "prompt"),
       ("inheritedContext",
         toJson (isStr (field (field (parentConfig call) "subagent") "context") "inherited")),
       ("parentMessages", field turn "parentMessages"),
       ("parentEphemeralSystem", field turn "parentEphemeralSystem"),
       ("persistent", toJson (isPersistent call)),
       ("resuming", field turn "resuming"),
       ("isolatedSandbox", field turn "isolated"),
       ("lastTurn", field turn "lastTurn")])

/-- `SubagentCoordinator.childCandidate` -/
def childCandidate (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let accountId ← Prog.effect "requireParentAccountId" [parentSession call]
  let statusUrl ← Prog.effect "subagentStatusPath" [task]
  return Json.mkObj
    [("accountId", accountId),
     ("agentId", field task "agentId"),
     ("eventId", field task "eventId"),
     ("runId", field task "runId"),
     ("ownerTaskId", field task "taskId"),
     ("conversationKey", field task "conversationKey"),
     ("events", Twin.callArg call 1),
     ("requestedMode", toJson "reject"),
     ("idempotencyKey", field task "eventId"),
     ("delivery", Json.mkObj
       [("kind", toJson "async"),
        ("publicEventId", field task "taskId"),
        ("publicConversationKey", field task "publicConversationKey"),
        ("statusUrl", statusUrl)])]

/-- `SubagentCoordinator.createChildResultRow` -/
def createChildResultRow (call : Json) : Prog Json := do
  let task := Twin.callArg call 0
  let session := parentSession call
  let delivery := member session "delivery"
  Prog.effect "createPendingAsyncAgentResult"
    [Json.mkObj
      [("eventId", field task "eventId"),
       ("conversationKey", field task "conversationKey"),
       ("subagent", Json.mkObj
         (optKey (truthy (field task "description")) "description" (field task "description") ++
          [("parentConversationKey", member session "conversationKey")] ++
          optKey (truthy delivery) "parentDelivery" delivery))]]

/-- `SubagentCoordinator.createPublisher` -/
def createPublisher (call : Json) : Prog Json := do
  if !isTrue (field (field (parentConfig call) "subagent") "stream") then return undef
  match ← Prog.attempt "this.publisherFactory" [Twin.callArg call 0] with
  | .ok value => return value
  | _ => return undef

private def virtualPrefix : String := "virtual_subagent_"

private def isHex (c : Char) : Bool :=
  c.isDigit || ('a' ≤ c && c ≤ 'f')

/-- Group 1 of `PERSISTENT_SUBAGENT_KEY`, or none when the key does not match. -/
private def persistentKeyUuid (key : String) : Option String :=
  let marker := "subagent-persistent-"
  if !key.startsWith marker then none else
  let rest := (key.drop marker.length).toString.toList
  let uuid := rest.take 36
  let tail := rest.drop 36
  let dashAt (i : Nat) : Bool := i == 8 || i == 13 || i == 18 || i == 23
  let uuidOk := uuid.length == 36 &&
    (List.range 36).all fun i =>
      let c := uuid.getD i ' '
      if dashAt i then c == '-' else isHex c
  let tagOk := tail.length == 33 && tail.head? == some '-' && (tail.drop 1).all isHex
  if uuidOk && tagOk then some (String.ofList uuid) else none

/-- `SubagentCoordinator.resolveChild` -/
def resolveChild (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let publicKey := Twin.callArg call 1
  let agentId := Twin.callArg call 2
  let taskId := Twin.callArg call 3
  let config := parentConfig call
  if truthy agentId then
    let agent ← Prog.effect "this.resolveAllowedAgent" [accountId, agentId]
    let runtimeConfig ← Prog.effect "toRuntimeAgentConfig" [field agent "config"]
    let merged ← Prog.effect "subagentConfig" [runtimeConfig, config]
    let conversationKey ← Prog.effect "scopedDirectConversationKey"
      [accountId, field agent "agentId", publicKey]
    return Json.mkObj
      ([("agentId", field agent "agentId"), ("agentConfig", merged)] ++
        optKey (truthy (field agent "description")) "description" (field agent "description") ++
        [("publicConversationKey", publicKey), ("conversationKey", conversationKey)])
  let suffix := (persistentKeyUuid (text publicKey)).getD (text taskId)
  let virtualId := toJson (virtualPrefix ++ suffix)
  let merged ← Prog.effect "virtualSubagentConfig" [config]
  let conversationKey ← Prog.effect "scopedDirectConversationKey"
    [accountId, virtualId, publicKey]
  return Json.mkObj
    [("agentId", virtualId),
     ("agentConfig", merged),
     ("publicConversationKey", publicKey),
     ("conversationKey", conversationKey)]

private def userText (value : Json) : Json :=
  Json.mkObj
    [("role", toJson "user"),
     ("content", arr [Json.mkObj [("type", toJson "text"), ("text", value)]])]

/-- `SubagentCoordinator.takeInbox`. -/
def takeInbox (call : Json) : Prog Json := do
  let task := Twin.callArg call 1
  let live := (mapGet (Twin.moduleValue call "liveChildren") (field task "conversationKey")).getD undef
  let inbox := items (field live "inbox")
  if field live "taskId" != field task "taskId" || inbox.isEmpty then return arr []
  let messages := arr (inbox.map userText)
  let _ ← Prog.effect "childSession .persistModelMessages" [messages]
  let cleared := Json.mkObj ((live.getObj?.toOption.map (·.toList) |>.getD [])
    |>.filter (fun pair => pair.1 != "sender")
    |>.map (fun pair => if pair.1 == "inbox" then ("inbox", arr []) else pair))
  let children := (mapPairs (Twin.moduleValue call "liveChildren")).map fun pair =>
    arr [pair.1, if pair.1 == field task "conversationKey" then cleared else pair.2]
  Prog.setState "module.liveChildren" (Json.mkObj [("$map", arr children)])
  return messages

private def lower (value : String) : String := value.toLower

private def hasText (value pattern : String) : Bool :=
  (value.splitOn pattern).length > 1

/-- `CONTEXT_LIMIT_PATTERN`, case-insensitive. -/
private def contextLimitPhrases : List String :=
  ["request too large", "context length", "context window", "prompt is too long",
   "input is too long", "exceeds the maximum number of tokens"]

/-- `isContextLengthError` -/
def isContextLengthError (call : Json) : Prog Json :=
  let message := lower (text (Twin.callArg call 0))
  pure (toJson (contextLimitPhrases.any (hasText message)))

private def errorBody (value : Json) : Json := field value "$error"

private def isError (value : Json) : Bool := !isUndef (errorBody value)

/-- A property of a value that may be a recorded `Error`. -/
private def prop (value : Json) (key : String) : Json :=
  if isError value then
    if key == "message" || key == "name" then field (errorBody value) key
    else field (field (errorBody value) "fields") key
  else field value key

/-- `isTimeoutError` -/
def isTimeoutError (call : Json) : Prog Json :=
  let error := Twin.callArg call 0
  pure (toJson (isError error && isStr (prop error "name") "TimeoutError"))

private def unreachableCodes : List String :=
  ["ConnectionRefused", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
   "FailedToOpenSocket"]

/-- `isUnreachableError` -/
def isUnreachableError (call : Json) : Prog Json :=
  let error := Twin.callArg call 0
  let code := prop error "code"
  pure (toJson (isError error && isString code && unreachableCodes.contains (text code)))

private def isObject (value : Json) : Bool :=
  match value with
  | .obj _ => !isUndef value
  | .arr _ => true
  | _ => false

/-- What `String(value)` renders for a recorded scalar. -/
private def jsString (value : Json) : String :=
  if isUndef value then "undefined" else
  match value with
  | .str inner => inner
  | other => other.compress

/-- `nestedErrorMessage` -/
def nestedErrorMessage (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let depth := ((Twin.callArg call 1).getNat?).toOption.getD 0
  if !truthy value || !isObject value then return undef
  let message := prop value "message"
  if isString message && text message != "" then
    let code := prop value "code"
    let isNumber := match code with
      | .num _ => true
      | _ => false
    let suffix := if isString code || isNumber then s!" ({jsString code})" else ""
    return toJson (text message ++ suffix)
  if depth >= 2 then return undef
  for child in [prop value "error", prop value "response"] do
    let found ← Prog.effect "nestedErrorMessage" [child, toJson (depth + 1)]
    if truthy found then return found
  return undef

/-- A `$ref` is a reference to an enclosing object: a cycle, so `JSON.stringify` throws. -/
private def containsRef : Nat → Json → Bool
  | 0, _ => false
  | fuel + 1, value =>
    match value with
    | .arr values => values.toList.any (containsRef fuel)
    | .obj entries =>
      entries.keys.contains "$ref" ||
        entries.keys.any fun key => containsRef fuel (field value key)
    | _ => false

/-- `toErrorMessage` -/
def toErrorMessage (call : Json) : Prog Json := do
  let error := Twin.callArg call 0
  if isError error then return prop error "message"
  let nested ← Prog.effect "nestedErrorMessage" [error, toJson (0 : Nat)]
  if truthy nested then return nested
  if !truthy error || !isObject error then return toJson (jsString error)
  if containsRef 64 error then return toJson "Unserializable error"
  return toJson (Twin.jsonStringify 128 error)

private def base64Value (c : Char) : Nat :=
  if 'A' ≤ c && c ≤ 'Z' then c.toNat - 'A'.toNat
  else if 'a' ≤ c && c ≤ 'z' then c.toNat - 'a'.toNat + 26
  else if '0' ≤ c && c ≤ '9' then c.toNat - '0'.toNat + 52
  else if c == '+' then 62
  else 63

/-- The bytes of a standard base64 string. -/
private def base64Bytes (encoded : String) : List Nat :=
  let digits := (encoded.toList.filter (· != '=')).map base64Value
  let bits := digits.flatMap fun d => (List.range 6).reverse.map fun i => (d >>> i) &&& 1
  let rec take (fuel : Nat) (rest : List Nat) : List Nat :=
    match fuel with
    | 0 => []
    | fuel + 1 =>
      if rest.length < 8 then [] else
        (rest.take 8).foldl (fun acc bit => acc * 2 + bit) 0 :: take fuel (rest.drop 8)
  take bits.length bits

private def hexByte (byte : Nat) : String :=
  let digit (d : Nat) : Char := if d < 10 then Char.ofNat (48 + d) else Char.ofNat (87 + d)
  String.ofList [digit (byte / 16), digit (byte % 16)]

private def bytesOf (value : Json) : String := text (field value "$bytes")

/-- `createAccountId` -/
def createAccountId (_ : Json) : Prog Json := do
  let bytes ← Prog.effect "randomBytes" [toJson (12 : Nat)]
  return toJson ("acct_" ++ String.join ((base64Bytes (bytesOf bytes)).map hexByte))

/-- `createAccountSecret` -/
def createAccountSecret (_ : Json) : Prog Json := do
  let bytes ← Prog.effect "randomBytes" [toJson (32 : Nat)]
  let url := (bytesOf bytes).toList.filterMap fun c =>
    if c == '=' then none else if c == '+' then some '-' else if c == '/' then some '_' else some c
  return toJson ("bask_" ++ String.ofList url)

/-- `isManagedService` -/
def isManagedService (call : Json) : Prog Json :=
  pure (toJson (isStr (Twin.env call "BROODS_MANAGED_SERVICE") "true"))

/-- `accountOrg` -/
def accountOrg (call : Json) : Prog Json := do
  let account ← Prog.effect "ctx.db.get" [Twin.callArg call 1]
  if !truthy account then return Json.null
  let orgId ← Prog.effect "ctx.db.normalizeId" [toJson "orgs", field account "orgId"]
  if !truthy orgId then return Json.null
  Prog.effect "ctx.db.get" [orgId]

/-- `budgetLevel` -/
def budgetLevel (call : Json) : Prog Json :=
  let percent := ((Twin.callArg call 0).getNum?).toOption.map (·.toFloat) |>.getD 0
  pure (toJson (if percent >= 100 then "exhausted"
    else if percent >= 0.8 * 100 then "warning" else "ok"))

/-- `encodeURIComponent`, over the string's UTF-8 bytes. -/
private def encodeUriComponent (value : String) : String :=
  let keep (b : Nat) : Bool :=
    (48 ≤ b && b ≤ 57) || (65 ≤ b && b ≤ 90) || (97 ≤ b && b ≤ 122) ||
      [45, 95, 46, 33, 126, 42, 39, 40, 41].contains b
  let upper (b : Nat) : String := (hexByte b).toUpper
  String.join (value.toUTF8.toList.map fun b =>
    let n := b.toNat
    if keep n then String.singleton (Char.ofNat n) else "%" ++ upper n)

/-- `accountHookBundleStorageKey` -/
def accountHookBundleStorageKey (call : Json) : Prog Json :=
  pure (toJson
    s!"account-hooks/{encodeUriComponent (text (Twin.callArg call 0))}/bundles/{text (Twin.callArg call 1)}.mjs")

/-- `parseHandbackDedupeKey` -/
def parseHandbackDedupeKey (call : Json) : Prog Json := do
  let key := text (Twin.callArg call 0)
  let found := ["subagent:", "async-tool:"].find? (fun head => key.startsWith head)
  match found with
  | none => return undef
  | some head =>
    let parts := key.splitOn ":"
    let status := parts.getLast?.getD ""
    if !["completed", "failed", "awaiting_input"].contains status then return undef
    let idLength := key.length - head.length - status.length - 1
    let id := String.ofList ((key.toList.drop head.length).take idLength)
    if head.length + status.length + 1 > key.length || id.isEmpty then return undef
    return if head == "subagent:" then
      Json.mkObj [("kind", toJson "subagent"), ("eventId", toJson id), ("status", toJson status)]
    else
      Json.mkObj [("kind", toJson "async-tool"), ("resultId", toJson id), ("status", toJson status)]

private def opaqueRef (name : String) : Json :=
  Json.mkObj [("$opaque", toJson name)]

/-- Calls `new ClientError(message)` and throws what it built. -/
private def clientError (message : String) : Prog Json := do
  let built ← Prog.effect "new ClientError" [toJson message]
  throw built

private def trimmed (value : String) : String := value.trimAscii.toString

private def hookEvents : List String :=
  ["agent.started", "agent.step.finished", "agent.finished", "agent.failed",
   "agent.approval.required", "tool.call.started", "tool.call.finished", "tool.result",
   "subagent.task.started", "subagent.task.finished", "channel.message.received",
   "channel.message.sending"]

/-- `HOOK_NAME_PATTERN` -/
private def validHookName (name : String) : Bool :=
  let isHead (c : Char) : Bool := c.isAlpha || c == '_'
  let isTail (c : Char) : Bool := c.isAlphanum || c == '_' || c == '-'
  match name.toList with
  | [] => false
  | head :: rest =>
    isHead head && rest.all isTail && decide (rest.length ≤ 63)

/-- `normalizeHookName` -/
def normalizeHookName (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if !isString value || (trimmed (text value)).isEmpty then
    return ← clientError "hook.name must be a non-empty string"
  let name := trimmed (text value)
  if !validHookName name then
    return ← clientError
      "hook.name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens"
  return toJson name

/-- `normalizeDescription` -/
def normalizeDescription (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if !isString value || (trimmed (text value)).isEmpty then
    return ← clientError "hook.description must be a non-empty string"
  return toJson (trimmed (text value))

/-- `normalizeEvents` -/
def normalizeEvents (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let isArray := match value with
    | .arr _ => true
    | _ => false
  if !isArray || (items value).isEmpty then
    return ← clientError "hook.events must be a non-empty array"
  let mut events : List Json := []
  for event in items value do
    if !isString event || !hookEvents.contains (text event) then
      return ← clientError
        s!"hook.events must contain only: {String.intercalate ", " hookEvents}"
    if !events.contains event then events := events ++ [event]
  return arr events

/-- `normalizeBundle` -/
def normalizeBundle (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if !isString value || (text value).isEmpty then
    return ← clientError "hook.bundle must be a non-empty string"
  if (text value).utf8ByteSize > 1000000 then
    return ← clientError "hook.bundle must be 1000000 bytes or smaller"
  let safe ← Prog.effect "isIsolateSafeBundle" [value]
  if !truthy safe then
    return ← clientError
      "hook.bundle must be isolate-safe: node: imports, bare package imports, require(), process, and __dirname are not allowed"
  return value

/-- `normalizeAccountHookUpload` -/
def normalizeAccountHookUpload (call : Json) : Prog Json := do
  let required := isTrue (field (Twin.callArg call 1) "requireBundle")
  let value ← Prog.effect "parseInput" [opaqueRef "ZodMiniObject", Twin.callArg call 0, toJson ""]
  let mut result : List (String × Json) := []
  if !isUndef (field value "name") then
    result := result ++ [("name", ← Prog.effect "normalizeHookName" [field value "name"])]
  else if required then
    return ← clientError "hook.name is required"
  if !isUndef (field value "description") then
    result := result ++
      [("description", ← Prog.effect "normalizeDescription" [field value "description"])]
  if !isUndef (field value "events") then
    result := result ++ [("events", ← Prog.effect "normalizeEvents" [field value "events"])]
  else if required then
    return ← clientError "hook.events is required"
  if !isUndef (field value "bundle") then
    let bundle ← Prog.effect "normalizeBundle" [field value "bundle"]
    let sha ← Prog.effect "sha256Hex" [bundle]
    result := result ++ [("bundle", bundle), ("sha256", sha)]
  else if required then
    return ← clientError "hook.bundle is required"
  return Json.mkObj result

/-- `normalizeUpdatePolicyInput` -/
def normalizeUpdatePolicyInput (call : Json) : Prog Json := do
  let input ← Prog.effect "parseInput" [opaqueRef "ZodMiniObject", Twin.callArg call 0, toJson ""]
  let description := field input "description"
  let describe : List (String × Json) :=
    if isUndef description then []
    else if description == Json.null then [("description", Json.null)]
    else
      let cleaned := trimmed (text description)
      if cleaned.isEmpty then [] else [("description", toJson cleaned)]
  let document ← if isUndef (field input "document") then pure []
    else do
      let parsed ← Prog.effect "normalizePolicyDocument" [field input "document"]
      pure [("document", parsed)]
  return Json.mkObj
    (optKey (!isUndef (field input "name")) "name" (toJson (trimmed (text (field input "name")))) ++
      describe ++ document ++
      optKey (!isUndef (field input "status")) "status" (field input "status"))

private def isNull (value : Json) : Bool := value == Json.null

private def withoutKeys (value : Json) (keys : List String) : Json :=
  let entries : List (String × Json) :=
    (value.getObj?.toOption.map (·.toList)).getD []
  Json.mkObj (entries.filter fun entry => !keys.contains entry.1)

private def ownerRef (call : Json) : Json :=
  Json.mkObj
    [("conversationKey", thisField call "conversationKey"),
     ("ownerEventId", thisField call "eventId"),
     ("ownerGeneration", thisField call "ownerGeneration")]

private def fnNamed (name : String) : Json := Json.mkObj [("$fn", toJson name)]

private def fnRef : Json := fnNamed ""

private def confirmOwner (call : Json) : Prog Json := do
  let old := thisField call "ownerConfirmedAt"
  let started := Twin.callArg call 0
  let next := if field old "$number" == toJson "-Infinity" then started
    else match old.getNum?, started.getNum? with
      | .ok a, .ok b => if a.toFloat < b.toFloat then started else old
      | _, _ => old
  if next != old then Prog.setState "self.ownerConfirmedAt" next
  return undef

private def recordToolResultRead (call : Json) : Prog Json := do
  let key := Twin.callArg call 0
  let value := Twin.callArg call 1
  let pairs := mapPairs (thisField call "toolResultReads")
  let updated := if pairs.any (·.1 == key) then
      pairs.map (fun pair => if pair.1 == key then (key, value) else pair)
    else pairs ++ [(key, value)]
  if updated != pairs then
    Prog.setState "self.toolResultReads"
      (Json.mkObj [("$map", arr (updated.map fun pair => arr [pair.1, pair.2]))])
  return undef

private def attachHooks (_call : Json) : Prog Json := do
  Prog.setState "self.hooksPromise" (Json.mkObj [("$opaque", toJson "Promise")])
  return undef

/-- `Session.releaseConversationLease`. A failed flush is only logged. -/
def releaseConversationLease (call : Json) : Prog Json := do
  if isUndef (thisField call "ownerGeneration") || isTrue (thisField call "ownerHandedOff") then
    return undef
  let _ ← Prog.attempt "this.flushPendingStoredEvents"
  let _ ← Prog.effect "releaseIngressOwner" [ownerRef call]
  Prog.setState "self.ownerHandedOff" (toJson true)
  return undef

/-- `Session.takeNextIngress` -/
def takeNextIngress (call : Json) : Prog Json := do
  if isUndef (thisField call "ownerGeneration") then return Json.null
  let settle := Twin.callArg call 0
  let _ ← (Prog.drain (fun _ args => do
      let _ ← Prog.attempt "takeNextIngress" [ownerRef call, settle, Twin.arg args 0]
      pure ()) 4)
  let outcome ← Prog.attempt "this.writeFenced" [arr [], fnRef]
  match outcome with
  | .ok value => return value
  | .threw error _ =>
    if truthy settle then
      let _ ← Prog.attempt "this.settleIngress"
        [field settle "status", withoutKeys settle ["status"]]
    throw error
  | .pending => Prog.unsupported "unfinished write"

/-- `Session.loadSubagentMetadata`. A cached promise's value is not recorded. -/
def loadSubagentMetadata (call : Json) : Prog Json := do
  let subagent := field (thisField call "agentConfig") "subagent"
  let accountId := thisField call "accountId"
  if !isTrue (field subagent "enabled") || !truthy accountId then return arr []
  if !isUndef (thisField call "subagentMetadataPromise") then
    return ← Prog.unsupported "cached metadata promise"
  let mut found : List Json := []
  for agentId in items (field subagent "allowed") do
    let _ ← Prog.effect "getStorage"
    let agent ← Prog.effect "getStorage().agents.getById" [accountId, agentId]
    if truthy agent then
      found := found ++ [Json.mkObj
        ([("agentId", field agent "agentId"), ("name", field agent "name")] ++
          optKey (truthy (field agent "description")) "description" (field agent "description"))]
  return arr found

/-- `Session.channelPartition` -/
def channelPartition (call : Json) : Prog Json := do
  let delivery := thisField call "delivery"
  if !isStr (field delivery "kind") "channel" then return undef
  Prog.effect "channelPartitionOf" [thisField call "agentConfig", field delivery "channelName"]

/-- `Session.persistModelMessages` -/
def persistModelMessages (call : Json) : Prog Json := do
  let options := Twin.param call 1
  let events ← Prog.effect "this.storedEvents" [Twin.callArg call 0, field options "dedupeKeys"]
  let _ ← Prog.effect "this.appendStoredEvents" [events, field options "onSaved"]
  return arr ((items events).map (field · "cursor"))

/-- `Session.createEphemeralTurnContext` -/
def createEphemeralTurnContext (call : Json) : Prog Json := do
  let ephemeral := Twin.param call 1
  if truncated (thisField call "agentConfig") then
    return ← Prog.unsupported "agentConfig is cut off in the recording"
  let _ ← Prog.effect "this.ensureResolvedRuntime"
  let messages ← Prog.effect "pruneSessionMessages"
    [Twin.callArg call 0, thisField call "agentConfig"]
  let parts ← Prog.effect "this.buildSystemPromptParts" [arr [], ephemeral]
  return Json.mkObj
    [("messages", messages),
     ("system", field parts "system"),
     ("ephemeralSystem", ephemeral),
     ("systemContextSnapshot",
       Json.mkObj [("cursor", Json.null), ("messages", arr [])])]

/-- `createSystemContextSnapshot` -/
def createSystemContextSnapshot (call : Json) : Prog Json := do
  let entries := Twin.callArg call 0
  let systemEntries ← Prog.effect "entriesSinceLatestCompactionSummary" [entries]
  let messages ← Prog.effect "projectSystemContextMessages" [systemEntries]
  let cursorOf (list : Json) : Option Json :=
    (items list).getLast?.bind fun last =>
      let at_ := field last "createdAt"
      if nullish at_ then none else some at_
  return Json.mkObj
    [("cursor", (cursorOf systemEntries <|> cursorOf entries).getD Json.null),
     ("messages", messages)]

/-- `missingHarnessRole` -/
def missingHarnessRole (call : Json) : Prog Json := do
  let config := Twin.callArg call 1
  let active ← Prog.effect "projectActiveConversationEntries" [Twin.callArg call 0]
  let model ← Prog.effect "modelIdentityFromModelConfig" [config]
  let projected ← Prog.effect "projectEntriesToMessages" [active, model]
  let messages := items (← Prog.effect "pruneSessionMessages" [projected, config])
  let hasRole (list : List Json) (role : String) : Bool :=
    list.any fun message => isStr (field message "role") role
  if !hasRole messages.dropLast "assistant" then return toJson "assistant"
  return if hasRole messages "user" then undef else toJson "user"

/-- `createStoredEventFromModelMessage` -/
def createStoredEventFromModelMessage (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let source := Twin.callArg call 1
  let producer := Twin.param call 2
  if !truthy message then return Json.null
  let role := text (field message "role")
  match role with
  | "user" =>
    let clean ← Prog.effect "sanitizeUserMessage" [withoutKeys message ["metadata", "dedupeKey"]]
    Prog.effect "toStoredConversationEvent" [clean, source, field message "metadata"]
  | "assistant" =>
    let clean ← Prog.effect "sanitizeAssistantMessage"
      [message, toJson (isTrue (field producer "retainsReasoning"))]
    Prog.effect "toStoredConversationEvent" [clean, source, undef, field producer "model"]
  | "tool" =>
    let clean ← Prog.effect "sanitizeToolMessage" [message]
    Prog.effect "toStoredConversationEvent" [clean, source]
  | "system" =>
    let clean ← Prog.effect "systemModelMessageSchema.parse" [message]
    Prog.effect "toStoredConversationEvent" [clean, source]
  | _ => return Json.null

/-- `SubagentCoordinator.recordOutcome` -/
def recordOutcome (call : Json) : Prog Json := do
  let childSession := Twin.callArg call 0
  let task := Twin.callArg call 1
  let outcome := Twin.callArg call 2
  let eventId := field task "eventId"
  if (setItems (thisField call "recorded")).contains eventId then return undef
  let settlement ← Prog.effect "outcomeSettlement" [outcome]
  let asyncResult := Json.mkObj [("eventIds", arr [eventId]), ("outcome", outcome)]
  let settled ← Prog.attempt "childSession .settleIngress"
    [field settlement "status",
     setKey (withoutKeys settlement ["status"]) "asyncResult" asyncResult]
  let wasSettled : Bool := match settled with
    | .ok value => truthy value
    | _ => false
  let ids : List Json :=
    if !isTrue (field task "persistent") && isStr (field outcome "status") "completed" then
      setItems (Twin.field childSession "unsavedToolResults")
    else []
  if !wasSettled then
    let _ ← Prog.effect "recordAsyncAgentResult"
      [eventId, outcome,
       if ids.isEmpty then Json.mkObj [] else Json.mkObj [("toolResultIds", arr ids)]]
  let _ ← Prog.effect "this.notifyCompletion"
  return undef

private def runningNotice (metadata : Json) : Json :=
  setKey metadata "status" (toJson "running")

/-- `SubagentCoordinator.detachTask` -/
def detachTask (call : Json) : Prog Json := do
  let taskId := Twin.callArg call 0
  let notify := isTrue (Twin.callArg call 1)
  match mapGet (thisField call "pendingMetadata") taskId with
  | none => return undef
  | some metadata =>
    if isTrue (← Prog.effect "this.answered" [metadata]) then return undef
    if notify then
      let _ ← Prog.effect "this.enqueue" [runningNotice metadata]
    if !(setItems (thisField call "handled")).contains (field metadata "eventId") then
      let _ ← Prog.effect "markAsyncAgentHandback"
        [field metadata "eventId", toJson "detached"]
    let _ ← Prog.effect "this.notifyCompletion"
    return undef

/-- `SubagentCoordinator.detachPending` -/
def detachPending (call : Json) : Prog Json := do
  let all := (mapPairs (thisField call "pendingMetadata")).map (·.2)
  let detaching ← filterEffect
    (fun metadata => do return !isTrue (← Prog.effect "this.answered" [metadata])) all
  let handled := setItems (thisField call "handled")
  let toMark := detaching.filter fun metadata => !handled.contains (field metadata "eventId")
  let emptied := Json.mkObj [("$map", arr [])]
  if !(mapPairs (thisField call "pending")).isEmpty then
    Prog.setState "self.pending" emptied
  if !(mapPairs (thisField call "pendingMetadata")).isEmpty then
    Prog.setState "self.pendingMetadata" emptied
  let outcomes ← Prog.all (toMark.map fun metadata =>
    ("markAsyncAgentHandback", [field metadata "eventId", toJson "detached"]))
  for outcome in outcomes do
    match outcome with
    | .threw error _ => throw error
    | _ => pure ()
  return arr detaching

/-- `SubagentCoordinator.resolveAddress` -/
def resolveAddress (call : Json) : Prog Json := do
  let to_ := text (Twin.callArg call 0)
  let accountId ← Prog.effect "requireParentAccountId" [parentSession call]
  let notOurs := s!"{to_} is not the address of one of your persistent subagents. Use the address run_subagent returned."
  let pieces := to_.splitOn "/"
  let agentId := pieces.headD ""
  let hasSlash := pieces.length > 1
  let publicKey := String.ofList (to_.toList.drop (agentId.length + 1))
  if !isPersistent call || !hasSlash || agentId.isEmpty then
    return ← Prog.throwError "Error" notOurs
  if !isTrue (← Prog.effect "this.mintedChildKey" [accountId, toJson publicKey]) then
    return ← Prog.throwError "Error" notOurs
  let child ← Prog.effect "this.resolveChild"
    [accountId, toJson publicKey,
     if agentId.startsWith virtualPrefix then undef else toJson agentId, toJson ""]
  if field child "agentId" != toJson agentId then
    return ← Prog.throwError "Error" notOurs
  return child

/-- `SubagentCoordinator.completeRun` -/
def completeRun (call : Json) : Prog Json := do
  let childSession := Twin.callArg call 0
  let task := Twin.callArg call 1
  let finish := Twin.callArg call 2
  let completed := isStr (field finish "status") "completed"
  let message := field finish "message"
  if !completed then
    let line := s!"I messaged my parent and am waiting for the reply (exchange {text (field message "exchangeId")}): {text (field message "text")}"
    let saved ← Prog.attempt "childSession .persistModelMessages"
      [arr [Json.mkObj
        [("role", toJson "assistant"),
         ("content", arr [Json.mkObj [("type", toJson "text"), ("text", toJson line)]])]]]
    match saved with
    | .threw error _ =>
      let _ ← Prog.effect "toErrorMessage" [error]
    | _ => pure ()
  let waiting := Json.mkObj
    [("status", toJson "awaiting_input"), ("question", field message "text")]
  let _ ← Prog.effect "this.recordOutcome" [childSession, task, if completed then finish else waiting]
  let _ ← Prog.attempt "childSession.releaseConversationLease"
  let metadata ← Prog.effect "taskMetadata" [task]
  let extra : List (String × Json) :=
    if completed then [("status", field finish "status"), ("response", field finish "response")]
    else
      [("status", toJson "awaiting_input"),
       ("question", field message "text"),
       ("exchangeId", field message "exchangeId")]
  return spread metadata extra

/-- `SubagentCoordinator.drainCompletionsToParent` -/
def drainCompletionsToParent (_ : Json) : Prog Json := do
  match ← Prog.attempt "this.takeParentMessages" with
  | .ok value => return toJson (items value).length
  | .threw error _ =>
    let _ ← Prog.effect "this.handOverToParent"
    throw error
  | .pending => Prog.unsupported "unfinished write"

/-- `SubagentCoordinator.drainCompletionsAndDetachToParent` -/
def drainCompletionsAndDetachToParent (call : Json) : Prog Json := do
  if (outbox call).isEmpty && (mapPairs (thisField call "pending")).isEmpty then
    return toJson (0 : Nat)
  for metadata in items (← Prog.effect "this.detachPending") do
    let _ ← Prog.effect "this.enqueue" [runningNotice metadata]
  Prog.effect "this.drainCompletionsToParent"

/-- `SubagentCoordinator.closePasses` -/
def closePasses (call : Json) : Prog Json := do
  let _ ← Prog.effect "this.handOverToParent"
  let unanswered := Twin.moduleValue call "unanswered"
  let waiting := ((mapPairs (thisField call "asked")).map (·.2)).filter fun question =>
    mapGet unanswered (field question "conversationKey") == some (field question "eventId")
  let outcomes ← Prog.all (waiting.map fun question => ("this.wakeChild", [question]))
  for outcome in outcomes do
    match outcome with
    | .threw error _ => throw error
    | _ => pure ()
  return undef

private def containsTooDeep : Nat → Json → Bool
  | 0, _ => false
  | fuel + 1, value =>
    match value with
    | .arr values => values.toList.any (containsTooDeep fuel)
    | .obj entries =>
      field value "$opaque" == toJson "too-deep" ||
        entries.keys.any fun key => containsTooDeep fuel (field value key)
    | _ => false

private def asText (value : Json) : Option String :=
  (value.getStr?).toOption

private def orUndef (value fallback : Json) : Json :=
  if isUndef value then fallback else value

/-- The content of `completionToParentMessage`, for a result that is text or absent. -/
private def parentMessageContent (completion : Json) : Option Json :=
  let status := field completion "status"
  let description := field completion "description"
  let metadata := String.intercalate "\n"
    ([s!"taskId: {text (field completion "taskId")}", s!"agentId: {text (field completion "agentId")}"] ++
      (if isUndef description || description == toJson "" then []
        else [s!"agentDescription: {text description}"]) ++
      [s!"conversationKey: {text (field completion "conversationKey")}", s!"status: {text status}"])
  let textContent (body : String) : Json :=
    arr [Json.mkObj [("type", toJson "text"), ("text", toJson body)]]
  if isStr status "awaiting_input" then
    let exchangeId := field completion "exchangeId"
    let exchange :=
      if isUndef exchangeId || exchangeId == toJson "" then ""
      else s!" (exchange {text exchangeId})"
    let address := s!"{text (field completion "agentId")}/{text (field completion "conversationKey")}"
    let question := text (orUndef (field completion "question") (toJson "(no message)"))
    some (textContent
      s!"Subagent message for the parent{exchange}. The subagent ended its turn waiting on your reply. Reply with message-agents to \"{address}\"; it resumes with its work so far.\n{metadata}\n\nMessage:\n{question}")
  else
    let header := s!"Subagent and async agent result injected into parent conversation.\n{metadata}\n\nResult:\n"
    let visible := orUndef (field completion "visibleResult") (field completion "response")
    if isStr status "completed" && !isUndef visible then
      (asText visible).map fun value => textContent (header ++ value)
    else if isStr status "running" then
      some (textContent (header ++ "Still working. Its result will arrive in this conversation as a new message when it finishes, so do not redo this task."))
    else
      some (textContent (header ++ text (orUndef (field completion "error") (toJson "(no result)"))))

/-- A queued message. Only `completionToParentMessage(completion)` enters `outbox`, so content the
recorder cut off is the same function of the completion stored beside it. -/
private def queuedMessage (entry : Json) : Prog Json :=
  let message := field entry "message"
  if !containsTooDeep 8 message then pure message
  else match parentMessageContent (field entry "completion") with
    | some content => pure (setKey message "content" content)
    | none => Prog.unsupported "a structured subagent result cut off by the recorder's depth limit"

/-- `SubagentCoordinator.handOverToParent` -/
def handOverToParent (call : Json) : Prog Json := do
  let _ ← Prog.effect "this.detachPending"
  for entry in items (thisField call "outbox") do
    let completion := field entry "completion"
    if isStr (field completion "status") "running" then continue
    let _ ← Prog.effect "markAsyncAgentHandback" [field completion "eventId", toJson "detached"]
    let message ← queuedMessage entry
    let _ ← Prog.effect "this.resumeParentWith" [message, completion]
  return undef

private def savedCount : Nat → Nat → Prog Nat
  | 0, count => pure count
  | fuel + 1, count => .input fun
    | none => pure count
    | some ("onSaved", args) => savedCount fuel ((Twin.arg args 0).getNat?.toOption.getD 0)
    | some (label, _) => Prog.unsupported s!"callback {label}"

private def parentMessageState (call : Json) (queued : List Json) (saved : Nat)
    (remaining : List Json) : Prog Unit := do
  if arr remaining != thisField call "outbox" then
    Prog.setState "self.outbox" (arr remaining)
  let old := mapPairs (thisField call "asked")
  let asked := (queued.take saved).foldl (fun pairs entry =>
    let completion := field entry "completion"
    if !isStr (field completion "status") "awaiting_input" then pairs
    else
      let key := field completion "conversationKey"
      if pairs.any (·.1 == key) then
        pairs.map (fun pair => if pair.1 == key then (key, completion) else pair)
      else pairs ++ [(key, completion)]) old
  if asked != old then
    Prog.setState "self.asked" (Json.mkObj [("$map", arr (asked.map fun pair => arr [pair.1, pair.2]))])

/-- `SubagentCoordinator.takeParentMessages`. -/
def takeParentMessages (call : Json) : Prog Json := do
  let detached := thisField call "detached"
  let queued := (items (thisField call "outbox")).filter fun entry =>
    let completion := field entry "completion"
    !isStr (field completion "status") "running" ||
      (mapGet detached (field completion "taskId")).isSome
  let messages ← queued.mapM queuedMessage
  if messages.isEmpty then
    parentMessageState call queued 0 []
    return arr []
  let count ← savedCount 16 0
  let saved ← Prog.attempt "this.parentSession .persistModelMessages"
    [arr messages, Json.mkObj [("onSaved", Json.mkObj [("$fn", toJson "onSaved")])]]
  match saved with
  | .threw error _ =>
    parentMessageState call queued count (queued.drop count)
    throw error
  | .pending => Prog.unsupported "persistModelMessages never finished"
  | .ok _ =>
    parentMessageState call queued queued.length []
    return arr messages

private def noReplyNote : String :=
  "No reply from your parent: it ended its turn or stopped waiting on you. Carry on with your best judgment and say what you assumed. A late reply still arrives as a later message."

private def noTurnsLeftNote : String :=
  "No reply from your parent, and this run has no message turns left, so you cannot message your parent again. Finish now with your best judgment and say what you assumed."

/-- `SubagentCoordinator.wakeChild`. A failure is logged, and the log's message is an effect. Not registered:
it re-reads the module map `unanswered` after its awaits, and a recording holds only the value at entry. -/
def wakeChild (call : Json) : Prog Json := do
  if Twin.abortedRead call 0 then return undef
  let question := Twin.callArg call 0
  let unanswered := Twin.moduleValue call "unanswered"
  Prog.catchFail
    (do
      let address ← Prog.effect "childAddress" [question]
      let child ← Prog.effect "this.resolveAddress" [address]
      let charged ← Prog.effect "this.parentSession.claimMessageTurn" [toJson (40 : Nat)]
      if mapGet unanswered (field question "conversationKey") != some (field question "eventId") then
        if isTrue charged then
          let _ ← Prog.effect "this.parentSession.releaseMessageTurn"
        return undef
      let resumed ← Prog.effect "this.resumeChild"
        [child, toJson (if isTrue charged then noReplyNote else noTurnsLeftNote), charged]
      if isStr (field resumed "outcome") "owner" then
        let _ ← Prog.effect "this.detachTask" [field (field resumed "task") "taskId", toJson false]
      return undef)
    (fun error => do
      let _ ← Prog.effect "toErrorMessage" [error]
      return undef)

/-- `SubagentCoordinator.resumeParentWith` -/
def resumeParentWith (call : Json) : Prog Json := do
  let message := Twin.callArg call 0
  let completion := Twin.callArg call 1
  let question := isStr (field completion "status") "awaiting_input"
  if question then
    let _ ← Prog.attempt "this.parentSession .claimMessageTurn" [toJson (40 : Nat)]
  let rowId ← Prog.effect "rowTaskId" [field completion "eventId"]
  let taskId := if truthy rowId then rowId else field completion "taskId"
  let _ ← Prog.attempt "this.resumeParent"
    [parentSession call, taskId, message, field completion "eventId"]
  if question then
    let _ ← Prog.effect "this.wakeChild" [completion]
  return undef

/-- `bestEffortSubagentPublisher`: its logic lives in the closures it returns. -/
def bestEffortSubagentPublisher (_ : Json) : Prog Json :=
  pure (Json.mkObj [("publish", fnNamed "publish"), ("close", fnNamed "close")])

/-- `createAgentLifecycleEmitter`: filtering is read only when `emit` runs. -/
def createAgentLifecycleEmitter (_ : Json) : Prog Json :=
  pure (Json.mkObj [("emit", fnNamed "emit")])

private def isImagePart (part : Json) : Bool :=
  isStr (field part "type") "file" && (text (field part "mediaType")).startsWith "image/"

/-- `carriesUserMedia`. The matcher is named by the recording. -/
def carriesUserMedia (call : Json) : Prog Json := do
  let matcher := field (Twin.callArg call 1) "$fn"
  let matches_ : Json → Bool :=
    if isStr matcher "isImage" then isImagePart
    else fun part =>
      isStr (field part "type") "file" && !(text (field part "mediaType")).startsWith "image/"
  if !isStr matcher "isImage" && !isStr matcher "isDroppableMedia" then
    return ← Prog.unsupported "unknown matcher"
  return toJson ((items (field (Twin.callArg call 0) "prompt")).any fun message =>
    isStr (field message "role") "user" && (items (field message "content")).any matches_)

private def voidTwin (source : String) : Twin :=
  plain source fun _ => pure undef

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [ plain (stored "withoutUnresolvedToolCalls") withoutUnresolvedToolCalls
  , plain (stored "Session.toolResultIdsOf") toolResultIdsOf
  , plain (stored "sanitizeAssistantMessage") sanitizeAssistantMessage
  , plain "apps/core/src/harness/hook-runner.ts#safeStringify" safeStringify
  , plain "packages/convex/model/harnessSessionEntries.ts#harnessEntryBytes" harnessEntryBytes
  , plain (stored "entriesSinceLatestCompactionSummary") (latestCompactionThen · 0)
  , plain (stored "projectActiveConversationEntries") (latestCompactionThen · 1)
  , plain (stored "toStoredConversationEvent") toStoredConversationEvent
  , plain (stored "Session.channelLabel") channelLabel
  , plain (stored "Session.enableDefaultHarness") enableDefaultHarness
  , plain (stored "Session.assertRecentOwner") assertRecentOwner
  , plain (stored "Session.sandboxes") (fun call => resolvedListChecked call "sandboxes" (resolvedList call "sandboxes"))
  , plain (stored "Session.resolvedWorkspaces") (fun call => resolvedListChecked call "workspaces" (resolvedList call "workspaces"))
  , plain (stored "Session.isWorkspaceEnabled")
      (fun call => pure (toJson (!(items (resolvedList call "workspaces")).isEmpty)))
  , plain (stored "Session.writeFenced") writeFenced
  , plain (stored "Session.flushPendingStoredEvents") flushPendingStoredEvents
  , voidTwin (stored "Session.appendHarnessSessionEntries")
  , plain (stored "Session.recordToolResultRead") recordToolResultRead
  , plain (stored "Session.confirmOwner") confirmOwner
  , plain (coord "attachHooks") attachHooks
  , plain (coord "runningTaskFor") runningTaskFor
  , plain (coord "answered") answered
  , plain (coord "hasChildMessage") hasChildMessage
  , plain (coord "detachOverdueWaits") detachOverdueWaits
  , plain (coord "notifyCompletion") notifyCompletion
  , plain (coord "mintChildKey") mintChildKey
  , plain (coord "childTask") childTask
  , plain (coord "childCandidate") childCandidate
  , plain (coord "createChildResultRow") createChildResultRow
  , plain (coord "createPublisher") createPublisher
  , plain (coord "resolveChild") resolveChild
  , plain (coord "takeInbox") takeInbox
  , plain "apps/core/src/shared/errors.ts#isContextLengthError" isContextLengthError
  , plain "apps/core/src/shared/errors.ts#isTimeoutError" isTimeoutError
  , plain "apps/core/src/shared/errors.ts#isUnreachableError" isUnreachableError
  , plain "apps/core/src/shared/errors.ts#nestedErrorMessage" nestedErrorMessage
  , plain "apps/core/src/shared/errors.ts#toErrorMessage" toErrorMessage
  , plain "apps/core/src/shared/domain/accounts.ts#createAccountId" createAccountId
  , plain "apps/core/src/shared/domain/accounts.ts#createAccountSecret" createAccountSecret
  , plain "apps/core/src/shared/in-flight.ts#inFlightForTests"
      (fun call => pure (Twin.moduleValue call "inFlight"))
  , voidTwin "apps/core/src/shared/in-flight.ts#drainInFlight"
  , plain "packages/convex/model/planLimits.ts#isManagedService" isManagedService
  , plain "packages/convex/model/planLimits.ts#accountOrg" accountOrg
  , plain "packages/convex/model/planLimits.ts#budgetLevel" budgetLevel
  , plain "packages/convex/model/accountHooks.ts#accountHookBundleStorageKey" accountHookBundleStorageKey
  , plain "packages/convex/model/accountHooks.ts#normalizeHookName" normalizeHookName
  , plain "packages/convex/model/accountHooks.ts#normalizeDescription" normalizeDescription
  , plain "packages/convex/model/accountHooks.ts#normalizeEvents" normalizeEvents
  , plain "packages/convex/model/accountHooks.ts#normalizeBundle" normalizeBundle
  , plain "packages/convex/model/accountHooks.ts#normalizeAccountHookUpload" normalizeAccountHookUpload
  , plain "packages/convex/model/subagentResults.ts#parseHandbackDedupeKey" parseHandbackDedupeKey
  , plain "packages/convex/model/policyRules.ts#normalizeUpdatePolicyInput" normalizeUpdatePolicyInput
  , plain (stored "Session.releaseConversationLease") releaseConversationLease
  , plain (stored "Session.takeNextIngress") takeNextIngress
  , plain (stored "Session.loadSubagentMetadata") loadSubagentMetadata
  , plain (stored "Session.channelPartition") channelPartition
  , plain (stored "Session.persistModelMessages") persistModelMessages
  , plain (stored "Session.createEphemeralTurnContext") createEphemeralTurnContext
  , plain (stored "createSystemContextSnapshot") createSystemContextSnapshot
  , plain (stored "missingHarnessRole") missingHarnessRole
  , plain (stored "createStoredEventFromModelMessage") createStoredEventFromModelMessage
  , plain (coord "recordOutcome") recordOutcome
  , plain (coord "detachTask") detachTask
  , plain (coord "detachPending") detachPending
  , plain (coord "resolveAddress") resolveAddress
  , plain (coord "completeRun") completeRun
  , plain (coord "drainCompletionsToParent") drainCompletionsToParent
  , plain (coord "drainCompletionsAndDetachToParent") drainCompletionsAndDetachToParent
  , plain (coord "closePasses") closePasses
  , plain (coord "handOverToParent") handOverToParent
  , plain (coord "takeParentMessages") takeParentMessages
  , plain (coord "resumeParentWith") resumeParentWith
  , plain "apps/core/src/harness/subagents.ts#bestEffortSubagentPublisher" bestEffortSubagentPublisher
  , plain "apps/core/src/harness/lifecycle.ts#createAgentLifecycleEmitter" createAgentLifecycleEmitter
  , plain "apps/core/src/harness/provider.ts#carriesUserMedia" carriesUserMedia
  ]

end Spec.Agent.Waveagent3b
