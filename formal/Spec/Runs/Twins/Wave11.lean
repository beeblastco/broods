import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of the row converters in `apps/core/src/shared/convex/storage.ts`: each turns a Convex document
into the record core uses, with ISO dates and optional fields present only when set.
-/

namespace Spec.Runs.Wave11

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def defined (value : Json) : Bool := value != Twin.undefinedJson

private def truthy (value : Json) : Bool := defined value && Access.Js.truthy value

private def pad (width value : Nat) : String :=
  let digits := toString value
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `new Date(ms).toISOString()` for an epoch time from 1970 on, by the days-to-civil algorithm. -/
def isoOfMillis (ms : Nat) : String :=
  let days := ms / 86400000
  let rest := ms % 86400000
  let z := days + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let day := doy - (153 * mp + 2) / 5 + 1
  let month := if mp < 10 then mp + 3 else mp - 9
  let year := yoe + era * 400 + (if month <= 2 then 1 else 0)
  s!"{pad 4 year}-{pad 2 month}-{pad 2 day}T{pad 2 (rest / 3600000)}:{pad 2 (rest / 60000 % 60)}:{pad 2 (rest / 1000 % 60)}.{pad 3 (rest % 1000)}Z"

private def iso (doc : Json) (key : String) : Json :=
  toJson (isoOfMillis ((field doc key).getNat?.toOption.getD 0))

/-- `...(doc.key ? { name: doc.key } : {})`. -/
private def whenTruthy (doc : Json) (key name : String) : List (String × Json) :=
  if truthy (field doc key) then [(name, field doc key)] else []

/-- `...(doc.key !== undefined ? { key: doc.key } : {})`. -/
private def whenDefined (doc : Json) (key : String) : List (String × Json) :=
  if defined (field doc key) then [(key, field doc key)] else []

/-- `...(doc.deletedAt ? { deletedAt: iso } : {})`, and its siblings. -/
private def isoWhenTruthy (doc : Json) (key : String) : List (String × Json) :=
  if truthy (field doc key) then [(key, iso doc key)] else []

/-- `doc ?? fallback`. -/
private def orElse (value fallback : Json) : Json :=
  if !defined value || value == Json.null then fallback else value

private def text (value : Json) : String := value.getStr?.toOption.getD ""

private def doc (call : Json) : Json := Twin.callArg call 0

private def convert (call : Json) (build : Json → Json) : Json :=
  if truthy (doc call) then build (doc call) else Json.null

/-- `accountFromConvex`. -/
def accountFromConvex (call : Json) : Prog Json :=
  pure (convert call fun d => Json.mkObj (
    [("accountId", field d "_id"), ("username", field d "username")] ++
    whenTruthy d "description" "description" ++
    [("secretHash", field d "secretHash"), ("status", field d "status"),
     ("createdAt", iso d "createdAt"), ("updatedAt", iso d "updatedAt")]))

/-- `cronFromConvex`. -/
def cronFromConvex (call : Json) : Prog Json :=
  pure (convert call fun d => Json.mkObj (
    [("accountId", field d "accountId"), ("cronId", field d "_id"), ("name", field d "name")] ++
    whenTruthy d "description" "description" ++
    [("agentId", field d "agentId"), ("events", field d "events")] ++
    whenTruthy d "conversationKey" "conversationKey" ++
    [("scheduleExpression", field d "scheduleExpression")] ++
    whenTruthy d "timezone" "timezone" ++
    [("status", field d "status"), ("createdAt", iso d "createdAt"),
     ("updatedAt", iso d "updatedAt")] ++
    isoWhenTruthy d "lastInvokedAt" ++
    whenTruthy d "lastStatus" "lastStatus" ++
    whenTruthy d "lastError" "lastError"))

/-- The decrypted blob of a row, or the fallback when the row stores none. -/
private def storedConfig (d : Json) (scope : String) (fallback : Json) : Prog Json :=
  if truthy (field d "encryptedConfig") && truthy (field d "encryptionIv") &&
      truthy (field d "encryptionTag") then
    Prog.effect "decryptAccountBlob"
      [field d "accountId", toJson scope,
       Json.mkObj [("ciphertext", field d "encryptedConfig"), ("iv", field d "encryptionIv"),
         ("tag", field d "encryptionTag")]]
  else pure fallback

/-- `agentFromConvex`. -/
def agentFromConvex (call : Json) : Prog Json := do
  let d := doc call
  if !truthy d then return Json.null
  let config ← storedConfig d "agents:encryptedConfig" (Json.mkObj [])
  return Json.mkObj (
    [("accountId", field d "accountId"), ("agentId", field d "_id"), ("name", field d "name")] ++
    whenTruthy d "description" "description" ++
    [("config", config)] ++
    (if field d "requireUserToken" == toJson true then [("requireUserToken", toJson true)] else []) ++
    [("createdAt", iso d "createdAt"), ("updatedAt", iso d "updatedAt")])

private def denyAll : Json :=
  Json.mkObj [("provider", toJson "sandbox"), ("permissionMode", toJson "ask"),
    ("network", Json.mkObj [("mode", toJson "deny-all")])]

/-- `sandboxConfigFromConvex`. -/
def sandboxConfigFromConvex (call : Json) : Prog Json := do
  let d := doc call
  if !truthy d then return Json.null
  let config ← storedConfig d "sandboxConfigs:encryptedConfig" denyAll
  return Json.mkObj (
    [("accountId", field d "accountId"), ("sandboxId", field d "_id")] ++
    whenTruthy d "projectId" "projectId" ++ whenTruthy d "stageId" "stageId" ++
    [("name", field d "name")] ++ whenTruthy d "description" "description" ++
    [("config", config), ("createdAt", iso d "createdAt"), ("updatedAt", iso d "updatedAt")])

/-- `workspaceConfigFromConvex`: r2 and assumeRole storage learn the owning account and workspace. -/
def workspaceConfigFromConvex (call : Json) : Prog Json := do
  let d := doc call
  if !truthy d then return Json.null
  let fallback := Json.mkObj [("storage", Json.mkObj [("provider", toJson "s3")])]
  let config := orElse (field d "config") fallback
  let storage := field config "storage"
  let authType := text (field (field storage "auth") "type")
  let owner := Json.mkObj [("accountId", field d "accountId"), ("workspaceId", field d "_id")]
  let settled :=
    if authType == "r2" || authType == "assumeRole" then
      let kept := (Access.Js.entries storage).filter (·.1 != "owner")
      let others := (Access.Js.entries config).filter (·.1 != "storage")
      Json.mkObj (others ++ [("storage", Json.mkObj (kept ++ [("owner", owner)]))])
    else config
  return Json.mkObj (
    [("accountId", field d "accountId"), ("workspaceId", field d "_id"), ("name", field d "name")] ++
    whenTruthy d "description" "description" ++
    [("config", settled), ("createdAt", iso d "createdAt"), ("updatedAt", iso d "updatedAt")])

/-- `channelRecordFromConvex`. -/
def channelRecordFromConvex (call : Json) : Prog Json :=
  pure (convert call fun d => Json.mkObj (
    [("accountId", field d "accountId"), ("channelRecordId", field d "_id"),
     ("platform", field d "platform"), ("externalId", field d "externalId")] ++
    whenTruthy d "workspaceRef" "workspaceRef" ++
    [("name", field d "name")] ++ whenTruthy d "description" "description" ++
    [("config", orElse (field d "config") (Json.mkObj [("agentBindings", Json.arr #[])])),
     ("status", field d "status"), ("createdAt", iso d "createdAt"),
     ("updatedAt", iso d "updatedAt")]))

/-- `mcpFromConvex`: a field set to anything but `undefined` is copied, falsy values included. -/
def mcpFromConvex (call : Json) : Prog Json :=
  pure (convert call fun d => Json.mkObj (
    [("accountId", field d "accountId"), ("serverId", field d "_id"),
     ("projectId", field d "projectId"), ("stageId", field d "stageId"),
     ("name", field d "name")] ++
    ["description", "transport", "workersCompatible", "runtime", "url", "sandbox", "command",
     "bundleStorageKey", "sha256", "headers", "oauth", "allowedTools", "disabled"].flatMap
      (whenDefined d) ++
    [("status", field d "status"), ("createdAt", iso d "createdAt"),
     ("updatedAt", iso d "updatedAt")] ++
    isoWhenTruthy d "deletedAt"))

/-- `agentPolicyFromConvex`. -/
def agentPolicyFromConvex (call : Json) : Prog Json :=
  pure (convert call fun d => Json.mkObj (
    [("accountId", field d "accountId"), ("policyId", field d "_id"), ("name", field d "name")] ++
    whenTruthy d "description" "description" ++
    [("document", field d "document"), ("status", field d "status"),
     ("createdAt", iso d "createdAt"), ("updatedAt", iso d "updatedAt")]))

/-- `accountHookFromConvex`. -/
def accountHookFromConvex (call : Json) : Prog Json :=
  pure (convert call fun d => Json.mkObj (
    [("accountId", field d "accountId"), ("hookId", field d "_id"), ("name", field d "name")] ++
    whenDefined d "description" ++
    [("events", field d "events"), ("bundleStorageKey", field d "bundleStorageKey"),
     ("sha256", field d "sha256"), ("status", field d "status"),
     ("createdAt", iso d "createdAt"), ("updatedAt", iso d "updatedAt")] ++
    isoWhenTruthy d "deletedAt"))

/-- `loadFromConvex`: the account's wrapped keys, by the admin query. -/
def loadFromConvex (call : Json) : Prog Json :=
  Prog.effect "adminQuery" [Json.mkObj [], Json.mkObj [("accountId", Twin.callArg call 0)]]

/-- `settleQuestion`: completes the row with the answers while it is still processing. -/
def settleQuestion (call : Json) : Prog Json :=
  Prog.effect "settleAsyncToolResultFromCallback"
    [Json.mkObj [("resultId", field (Twin.callArg call 0) "resultId"),
      ("status", toJson "completed"), ("response", Twin.callArg call 1)]]

/-- `recoveryScope`: the conversation, plus the deployment's endpoint and stage when it has one. -/
def recoveryScope (call : Json) : Prog Json := do
  let entry := Twin.callArg call 0
  let delivery := field (field entry "applied") "delivery"
  let deployment :=
    if field delivery "kind" == toJson "channel" then Twin.undefinedJson
    else field delivery "publicDeploymentIngress"
  let publicKey ← Prog.effect "publicConversationKeyFromScoped"
    [field entry "conversationKey", field entry "accountId", field entry "agentId"]
  return Json.mkObj (
    [("accountId", field entry "accountId"), ("agentId", field entry "agentId"),
     ("conversationKey", field entry "conversationKey"), ("publicConversationKey", publicKey)] ++
    (if truthy deployment then
      [("endpointId", field deployment "endpointId"), ("projectSlug", field deployment "projectSlug"),
       ("stageSlug", field deployment "stageSlug")]
     else []))

/-- `invokeNatsWorker`: hands the event to the harness worker as a websocket run. -/
def invokeNatsWorker (call : Json) : Prog Json := do
  let _ ← Prog.effect "invokeHarnessWorker"
    [Json.mkObj [("kind", toJson "nats-worker"), ("event", Twin.callArg call 0)]]
  return Twin.undefinedJson

/-- `invokeContinuationWorker`: a websocket parent resumes on its own socket, any other by async worker. -/
def invokeContinuationWorker (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let delivery := Twin.callArg call 1
  if field delivery "kind" == toJson "nats" then
    let socket ← Prog.effect "onSocket" [event, delivery]
    let _ ← Prog.effect "invokeNatsWorker" [socket]
    return Twin.undefinedJson
  let _ ← Prog.effect "invokeAsyncWorker" [event]
  return Twin.undefinedJson

/-- `URLSearchParams` serialisation of one name or value. -/
private def formEncode (value : String) : String :=
  String.join (value.toUTF8.toList.map fun byte =>
    let c := Char.ofNat byte.toNat
    if byte.toNat < 128 && (c.isAlphanum || "*-._".contains c) then c.toString
    else if c == ' ' then "+"
    else "%" ++ Access.Js.upperHexByte byte.toNat)

/-- `DEFAULT_DASHBOARD_URL` in `harness/handler.ts`. -/
def defaultDashboardUrl : String := "https://dashboard.broods.app"

/-- `dashboardTraceUrl`: a link to the run's trace, or null without a trace id or deployment. -/
def dashboardTraceUrl (call : Json) : Prog Json := do
  let traceId := Twin.callArg call 0
  let event := Twin.callArg call 1
  if !truthy traceId || !truthy (field event "projectSlug") || !truthy (field event "stageSlug") then
    return Json.null
  let configured ← Prog.effect "optionalEnv" [toJson "BROODS_DASHBOARD_URL"]
  let base := Access.Js.stripTrailingSlashes
    (if defined configured && configured != Json.null then text configured else defaultDashboardUrl)
  let params := [("project", text (field event "projectSlug")), ("stage", text (field event "stageSlug")),
    ("tab", "tracing"), ("trace", text traceId)]
  return toJson (base ++ "?" ++ "&".intercalate (params.map fun (key, value) =>
    formEncode key ++ "=" ++ formEncode value))

/-- `CHANNEL_APPROVAL_DENIAL_REASON` in `harness/handler.ts`. -/
def channelApprovalDenialReason : String := "Tool approval is only supported through the direct API."

/-- `createChannelApprovalDenial`: one refusal per pending approval. -/
def createChannelApprovalDenial (call : Json) : Prog Json :=
  pure (Json.mkObj [("role", toJson "tool"),
    ("content", Json.arr ((Twin.callArg call 0).getArr?.toOption.getD #[] |>.map fun approval =>
      Json.mkObj [("type", toJson "tool-approval-response"), ("approvalId", field approval "approvalId"),
        ("approved", toJson false), ("reason", toJson channelApprovalDenialReason)]))])

/-- `handleDirectAnswers` for one answer, the only shape whose reads and settles do not interleave:
a missing question is a 404, an answer someone else made first a 409, and a settled one resumes. -/
def handleDirectAnswers (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let supplied := field event "answers"
  let answers := if truthy supplied then (supplied.getArr?.toOption.getD #[]).toList else []
  match answers with
  | [entry] =>
    let row ← Prog.effect "getAsyncToolResult" [field entry "statusId"]
    let open_ ← Prog.effect "openQuestion" [row, field event "conversationKey"]
    if !defined open_ then
      return ← Prog.effect "errorResponse"
        [toJson (404 : Nat),
         toJson ("No open question " ++ text (field entry "statusId") ++ " on this conversation"),
         Json.mkObj [("code", toJson "question_not_found"), ("param", toJson "statusId")]]
    let settled ← Prog.effect "settleQuestion"
      [field open_ "record",
       Json.mkObj [("status", toJson "answered"), ("answers", field entry "answers")]]
    let skip := Json.mkObj [("kind", toJson "skip")]
    let outcome ← if truthy settled then
        Prog.effect "continueAfterAsyncToolSettlement" [settled]
      else pure skip
    if !truthy settled then
      return ← Prog.effect "errorResponse"
        [toJson (409 : Nat),
         toJson ("Questions already answered: " ++ text (field (field open_ "record") "resultId")),
         Json.mkObj [("code", toJson "question_already_answered"), ("param", toJson "answers")]]
    if truthy (field event "connectionId") then
      if field outcome "kind" == toJson "ready" then
        return ← Prog.effect "natsStartResponse" [event, field outcome "publicEventId", Json.null]
      return ← Prog.effect "jsonResponse"
        [toJson (202 : Nat),
         Json.mkObj [("eventId", field settled "resultId"), ("status", toJson "completed")]]
    Prog.effect "continuationResponse" [settled, outcome]
  | _ => Prog.unsupported "several answers read and settle together"

/-- `formatUnknown`: a string as it is, anything else as `JSON.stringify` writes it, keys in the
order the object was built. -/
def formatUnknown (call : Json) : Prog Json :=
  match Twin.callArg call 0 with
  | .str value => pure (.str value)
  | value =>
    if value == Twin.undefinedJson then pure Twin.undefinedJson
    else pure (toJson (Twin.jsonStringify 64 value))

/-- `CONTINUE_TURN_TEXT` in `harness/handler.ts`. -/
def continueTurnText : String :=
  "Your previous turn was cut off before it finished. Continue the task from where you left off."

/-- `{...base, ...overrides}`: a later key replaces an earlier one. -/
private def merged (base overrides : Json) : Json :=
  let later := Access.Js.entries overrides
  Json.mkObj ((Access.Js.entries base).filter (fun entry => !later.any (·.1 == entry.1)) ++ later)

/-- `handleContinueRequest`: re-enters the conversation with a follow-up turn, which the caller's
worker starts when this request owns the conversation. -/
def handleContinueRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let lookup := Json.mkObj ((["accountId", "agentId", "publicConversationKey", "agentConfig",
    "configRef"].map fun key => (key, field event key)).filter fun entry => defined entry.2)
  let target ← Prog.effect "resolveReentryTarget" [lookup]
  if field event "conversationKey" != field target "conversationKey" then
    return ← Prog.effect "errorResponse"
      [toJson (404 : Nat), toJson "Conversation not found",
       Json.mkObj [("code", toJson "conversation_not_found"), ("param", toJson "conversationKey")]]
  let continuation := merged (merged event target)
    (Json.mkObj [("events", toJson [Json.mkObj [("role", toJson "user"),
      ("content", toJson continueTurnText)]]), ("requestedMode", toJson "followup")])
  let delivery ← Prog.effect "continuationDelivery" [continuation]
  let admitted ← Prog.effect "admitInternalContinuation" [continuation, delivery]
  let owned := field admitted "owned"
  if truthy owned then
    let _ ← Prog.effect "startOwnedAsyncRun" [owned]
  let admission := field admitted "admission"
  Prog.effect "directAdmissionResponse"
    [continuation,
     if truthy owned then merged admission (Json.mkObj [("status", toJson "processing")]) else admission,
     toJson true]

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/shared/convex/storage.ts#accountFromConvex" accountFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#agentFromConvex" agentFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#cronFromConvex" cronFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#sandboxConfigFromConvex" sandboxConfigFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#workspaceConfigFromConvex" workspaceConfigFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#channelRecordFromConvex" channelRecordFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#mcpFromConvex" mcpFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#agentPolicyFromConvex" agentPolicyFromConvex,
   Twin.traced "apps/core/src/shared/convex/storage.ts#accountHookFromConvex" accountHookFromConvex,
   Twin.traced "apps/core/src/shared/convex/account-keys.ts#loadFromConvex" loadFromConvex,
   Twin.traced "apps/core/src/harness/questions.ts#settleQuestion" settleQuestion,
   Twin.traced "apps/core/src/harness/ingress-recovery.ts#recoveryScope" recoveryScope,
   Twin.traced "apps/core/src/harness/handler.ts#invokeNatsWorker" invokeNatsWorker,
   Twin.traced "apps/core/src/harness/handler.ts#invokeContinuationWorker" invokeContinuationWorker,
   Twin.traced "apps/core/src/harness/handler.ts#dashboardTraceUrl" dashboardTraceUrl,
   Twin.traced "apps/core/src/harness/handler.ts#createChannelApprovalDenial" createChannelApprovalDenial,
   Twin.traced "apps/core/src/harness/handler.ts#handleDirectAnswers" handleDirectAnswers,
   Twin.traced "apps/core/src/harness/async-tools.ts#formatUnknown" formatUnknown,
   Twin.traced "apps/core/src/harness/handler.ts#handleContinueRequest" handleContinueRequest]

end Spec.Runs.Wave11
