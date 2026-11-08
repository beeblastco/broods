import Spec.Twin
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto
import Spec.Agent.Twins.Continuation

namespace Spec.Runs.Waveruns1
open Lean Spec

private def field (v : Json) (k : String) : Json :=
  (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def text (v : Json) : String := v.getStr?.toOption.getD ""
private def items (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def undef (v : Json) : Bool := v == Twin.undefinedJson
private def truthy (v : Json) : Bool := !undef v && Access.Js.truthy v
private def obj (xs : List (String × Json)) : Json :=
  Json.mkObj (xs.filter fun x => !undef x.2)
private def spread (v : Json) (xs : List (String × Json)) : Json :=
  obj ((Access.Js.entries v).filter (fun x => !xs.any (·.1 == x.1)) ++ xs)
private def nat (v : Json) : Nat := v.getNat?.toOption.getD 0

private def answersFromChoice (args : Json) : Json := Id.run do
  let choice := Twin.arg args 1
  let some q := (items (field (Twin.arg args 0) "questions"))[nat (field choice "questionIndex")]?
    | return .null
  let some option := (items (field q "options"))[nat (field choice "optionIndex")]?
    | return .null
  return obj [(text (field q "id"), toJson [field option "label"])]

private def answersFromText (args : Json) : Json := Id.run do
  let qs := items (field (Twin.arg args 0) "questions")
  let some q := qs.head? | return .null
  let trimmed := Access.Js.trim (text (Twin.arg args 1))
  if trimmed == "" then return .null
  let opts := items (field q "options")
  let numbered := if trimmed.toList.all Char.isDigit then
    trimmed.toNat?.bind fun n => if n == 0 then none else opts[n - 1]?
    else none
  let label := opts.find? fun opt => (text (field opt "label")).toLower == trimmed.toLower
  let answer := (numbered.orElse fun _ => label).map (field · "label") |>.getD (.str trimmed)
  return obj ([("status", .str "answered"), ("answers", obj [(text (field q "id"), toJson [answer])])] ++
    if qs.length > 1 then [("note", .str
      "A typed reply answers the first question only; the rest are still open to the user.")] else [])

private def formatQuestionsText (args : Json) : Json :=
  .str ("\n\n".intercalate ((items (Twin.arg args 0)).map fun q =>
    "\n".intercalate ([text (field q "question")] ++
      ((items (field q "options")).zipIdx.map fun (opt, i) =>
        s!"{i + 1}. {text (field opt "label")}" ++
        if truthy (field opt "description") then " - " ++ text (field opt "description") else "") ++
      ["Or reply with your own answer."])))

private def outcomeSettlement (args : Json) : Json :=
  let o := Twin.arg args 0
  if field o "status" == .str "completed" then
    obj [("status", .str "completed"), ("result", field o "response")]
  else if field o "status" == .str "failed" then
    obj [("status", .str "failed"), ("error", field o "error")]
  else obj [("status", .str "completed"), ("result", o)]

private def rootSpanStatus (args : Json) : Json :=
  let w := Twin.arg args 1
  .str (if Twin.arg args 0 == .str "failed" then "error" else if !truthy w then "ok"
    else if w == .str "question" || w == .str "approval" then "needs_input" else "waiting")

private def consumerStartPolicy (args : Json) : Json :=
  let start := Twin.arg args 0
  let time := Twin.arg args 1
  match start with
  | .num _ => obj [("deliver_policy", .str "by_start_sequence"), ("opt_start_seq", start)]
  | _ => if truthy time then obj [("deliver_policy", .str "by_start_time"), ("opt_start_time", time)]
    else obj []

private def commandText (args : Json) : Json :=
  let command := text (Twin.arg args 0)
  let trimmed := Access.Js.trim (text (Twin.arg args 1))
  .str (if Access.Js.startsWith trimmed.toLower command.toLower then trimmed
    else Access.Js.trim (command ++ " " ++ trimmed))

private def onSocket (args : Json) : Json :=
  let event := Twin.arg args 0
  let delivery := Twin.arg args 1
  if field delivery "kind" != .str "nats" then event else
    spread event (["publicEventId", "publicConversationKey", "connectionId"].map fun k => (k, field delivery k))

private def parseAccountAgent (args : Json) : Json :=
  match (text (Twin.arg args 0)).splitOn ":" with
  | "acct" :: account :: "agent" :: agent :: _ :: _ =>
    if account == "" || agent == "" then .null
    else obj [("accountId", .str account), ("agentId", .str agent)]
  | _ => .null

private def isString : Json → Bool | .str _ => true | _ => false
private def invocation (kind : String) (args : Json) : Json :=
  let event := Twin.arg args 0
  toJson (Access.Js.isObjectLike event && field event "kind" == .str kind &&
    (kind != "cron" || (isString (field event "accountId") && isString (field event "cronId"))))

private def asyncResultEventIds (args : Json) : Json :=
  let event := Twin.arg args 0
  let id := field event "eventId"
  let first := field event "asyncResultEventId"
  let first := if undef first || first == .null then id else first
  toJson (if first == id then [id] else [first, id])

private def runnable (m : Json) : Bool :=
  let content := items (field m "content")
  field m "role" == .str "user" || (field m "role" == .str "tool" && !content.isEmpty &&
    content.all fun part => field part "type" == .str "tool-approval-response")

private def rootEventId (args : Json) : Json :=
  let value := text (Twin.arg args 0)
  let parts := value.splitOn ":"
  let tags := ["async-bg", "async-question", "async-subagent", "async-tools"]
  .str (match (parts.drop 1).findIdx? (tags.contains ·) with
    | none => value | some n => ":".intercalate (parts.take (n + 1)))

private def askingEventId (args : Json) : Json :=
  let row := Twin.arg args 0
  let parent := text (field row "parentEventId")
  let suffix := ":" ++ text (field row "resultId")
  let tagged := String.ofList (parent.toList.take (parent.length - suffix.length))
  let parts := tagged.splitOn ":"
  .str (if parts.length > 1 then ":".intercalate (parts.take (parts.length - 1))
    else String.ofList (tagged.toList.take (tagged.length - 1)))

private def directStatusUrl (call : Json) : Prog Json := do
  let base ← Prog.effect "getHarnessPublicUrl"
  if !truthy base then return .null
  return .str (text base ++ "/v1/runs/" ++
    Access.Js.encodeURIComponent (text (field (Twin.callArg call 0) "runId")))

private def resumeLostAsyncToolResult (call : Json) : Prog Json := do
  let row := Twin.callArg call 0
  let resumed ← Prog.attempt "resumeConversation" [row]
  match resumed with
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    return .bool false
  | .pending => Prog.unsupported "resume is unfinished"
  | .ok outcome =>
    let admission := if field outcome "kind" == .str "ready" then field outcome "admission" else .str "skip"
    if admission == .str "owner" || admission == .str "queued" then return .bool true
    if admission == .str "capacity" || admission == .str "duplicate" then return .bool false
    let _ ← Prog.effect "markAsyncToolHandback" [field row "resultId", .str "stored"]
    return .bool true

private def openWorkAfterRun (call : Json) : Prog Json := do
  let run := Twin.callArg call 0
  if truthy (field run "awaitingApproval") then
    return obj [("waitingOn", .str "approval"), ("questions", toJson ([] : List Json))]
  let ids := items (field run "detachedResultIds")
  let rows ← Prog.all (ids.map fun id => ("getAsyncToolResult", [id]))
  let rows := rows.map fun outcome => match outcome with | .ok row => row | _ => .null
  let openRows := rows.filter fun row => field row "status" == .str "processing"
  let mut questions : List Json := []
  for row in openRows do
    let question ← Prog.effect "openQuestion" [row, field run "conversationKey"]
    questions := questions ++ items (field (field question "pending") "questions")
  let unread := (items (field run "questionSummaries")).flatMap fun summary =>
    match ids.findIdx? (· == field summary "statusId") with
    | some i => if rows[i]? == some .null then items (field summary "questions") else []
    | none => []
  if !questions.isEmpty || !unread.isEmpty then
    return obj [("waitingOn", .str "question"), ("questions", toJson (questions ++ unread))]
  let pending ← if undef (field run "pendingWork") then pure Twin.undefinedJson else Prog.effect "run.pendingWork"
  return obj ((if truthy pending then [("waitingOn", pending)]
    else if !openRows.isEmpty then [("waitingOn", .str "tool")] else []) ++
    [("questions", toJson ([] : List Json))])

private def queryOptions (name : String) (call : Json) : Prog Json :=
  Prog.effect "runtime.query" [.str name, Twin.callArg call 0]
private def queryId (name : String) (call : Json) : Prog Json :=
  Prog.effect "runtime.query" [.str name, obj [("resultId", Twin.callArg call 0)]]

private def renewIngressOwner (call : Json) : Prog Json :=
  let owner := Twin.callArg call 0
  Prog.effect "runtime.mutate" [.str "renewIngressOwner", obj
    ((["conversationKey", "ownerEventId", "ownerGeneration"].map fun k => (k, field owner k)) ++
      [("leaseTtlMs", toJson (900000 : Nat))])]

private def recoverQueuedIngress (call : Json) : Prog Json := do
  let page ← Prog.effect "runtime.mutate" [.str "recoverQueuedIngress", obj
    [("leaseTtlMs", toJson (900000 : Nat)), ("afterConversationKey", Twin.callArg call 0)]]
  for entry in items (field page "recovered") do
    let _ ← Prog.effect "trackOwner" [obj [("conversationKey", field entry "conversationKey"),
      ("ownerEventId", field (field entry "applied") "eventId"),
      ("ownerGeneration", field (field entry "applied") "ownerGeneration")]]
  return page

private def markAsyncAgentHandback (call : Json) : Prog Json := do
  let outcome ← Prog.attempt "runtime.mutate" [.str "markAsyncAgentHandback", obj
    [("eventId", Twin.callArg call 0), ("handback", Twin.callArg call 1)]]
  match outcome with
  | .threw error _ => let _ ← Prog.effect "toErrorMessage" [error]; pure Twin.undefinedJson
  | _ => pure Twin.undefinedJson

private def createConvexClient (call : Json) : Prog Json := do
  let client ← Prog.effect "new ConvexHttpClient" [Twin.callArg call 0]
  let _ ← Prog.effect "(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth" [Twin.callArg call 1]
  return client

private def createDetachedAsyncToolResult (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let input ← Prog.effect "redactWithRunSecrets" [field options "input"]
  let row := obj ((Access.Js.entries options).filter fun x => x.1 != "eventId" && x.1 != "tag")
  Prog.effect "runtime.mutate" [.str "createAsyncToolResult", spread row
    [("input", input), ("parentEventId", .str (text (field options "eventId") ++ ":" ++
      text (field options "tag") ++ ":" ++ text (field options "resultId")))]]

private def markAsyncToolResultFailed (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let error ← Prog.effect "redactWithRunSecrets" [field options "error"]
  let _ ← Prog.effect "runtime.mutate" [.str "updateAsyncToolResult", obj
    [("resultId", field options "resultId"), ("status", .str "failed"),
      ("error", error), ("onlyWhenProcessing", .bool true)]]
  return Twin.undefinedJson

private def settleAsyncToolResultFromCallback (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let secrets ← Prog.effect "runSecretValues"
  let secrets := toJson (items secrets ++ items (field options "secretValues"))
  let completed := field options "status" == .str "completed"
  let error := field options "error"
  let value := if completed then field options "response"
    else if undef error || error == .null then .str "Async tool call failed" else error
  let safe ← Prog.effect "redactWithRunSecrets" [value, secrets]
  Prog.effect "runtime.mutate" [.str "updateAsyncToolResult", obj
    [("resultId", field options "resultId"), ("status", field options "status"),
      ("onlyWhenProcessing", .bool true), (if completed then "response" else "error", safe)]]

private def resumeAfterYield (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let context := Twin.callArg call 1
  let generation := Twin.field session "ownerGeneration"
  if !undef (field context "yieldSlot") then
    let lease := if undef generation then Twin.undefinedJson else obj
      [("conversationKey", Twin.field session "conversationKey"),
       ("ownerEventId", Twin.field session "eventId"), ("ownerGeneration", generation)]
    let _ ← Prog.effect "context?.yieldSlot" [lease]
  Prog.effect "session.createTurnContext" [Twin.callArg call 2]

private def expiresSoon (call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  match (field (Twin.callArg call 0) "expiresAt").getInt?, now.getInt? with
  | .ok expires, .ok now => pure (toJson (decide (expires - now < (60000 : Int))))
  | _, _ => Prog.unsupported "non-integer timestamp"

private def base64 (value : String) : String :=
  let encoded := (Access.Crypto.base64UrlEncode value.toUTF8.toList).replace "-" "+" |>.replace "_" "/"
  encoded ++ String.ofList (List.replicate ((4 - encoded.length % 4) % 4) '=')

private def chunks (value : String) : List String :=
  let chars := value.toList.toArray
  (List.range (max 1 ((chars.size + 94999) / 95000))).map fun i =>
    String.ofList ((chars.toList.drop (i * 95000)).take 95000)

private def writeCommand (q chunk : String) (first : Bool) : String :=
  (if first then "mkdir -p \"$(dirname " ++ q ++ ")\" && " else "") ++
    "printf '%s' " ++ chunk ++ " | base64 -d " ++ (if first then ">" else ">>") ++ " " ++ q

private def fileWrites (call : Json) : Prog Json := do
  let file := Twin.callArg call 0
  let relative ← Prog.effect "toWorkspaceRelative" [field file "path"]
  let q ← Prog.effect "shellQuote" [.str ("./" ++ text relative)]
  let encoded ← Prog.effect "toBase64" [field file "content"]
  let mut writes : List Json := []
  for (chunk, i) in (chunks (text encoded)).zipIdx do
    let quoted ← Prog.effect "shellQuote" [.str chunk]
    writes := writes ++ [.str (writeCommand (text q) (text quoted) (i == 0))]
  return toJson writes

private def shellQuote (value : String) : String :=
  "'" ++ value.replace "'" "'\\''" ++ "'"

private def fileWritesPure (file : Json) : Except String (List String) := do
  let path := Access.Js.trim (text (field file "path"))
  let parts := (path.splitOn "/").filter fun p => p != "" && p != "."
  if parts.contains ".." then throw "Invalid path: directory traversal not allowed"
  let relative := if parts.isEmpty then "." else "/".intercalate parts
  let q := shellQuote ("./" ++ relative)
  return (chunks (base64 (text (field file "content")))).zipIdx.map fun (chunk, i) =>
    writeCommand q (shellQuote chunk) (i == 0)

private def applyScripts (args : Json) : Json :=
  let head := ["set -e", "T0=$(date +%s%3N)",
    "mkdir -p \"$HOME/broods-apply\" && cd \"$HOME/broods-apply\""]
  let phase := fun name => "echo \"::phase " ++ name ++ " $(( $(date +%s%3N) - T0 ))\""
  let deploy := [
    "export PATH=\"$HOME/.bun/bin:$PATH\" BROODS_BASE_URL=\"$APPLY_BASE_URL\"",
    "command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1",
    phase "files",
    "if [ -f bun.lock ]; then bun install --frozen-lockfile >/dev/null; else bun install >/dev/null; fi",
    phase "install",
    "bunx broods deploy --base-url \"$BROODS_BASE_URL\" --project \"$BROODS_PROJECT\" --stage \"$BROODS_STAGE\" --prune",
    phase "deploy"]
  let result : Except String (List String) := do
    let writes ← (items (field (Twin.arg args 0) "files")).mapM fileWritesPure
    let mut finished : List (List String) := []
    let mut batch := head ++ ["rm -rf broods package.json bun.lock"]
    for write in writes.flatten do
      if Access.Js.utf16Length ("\n".intercalate batch) + Access.Js.utf16Length write > 96000 then
        finished := finished ++ [batch]
        batch := head ++ [write]
      else batch := batch ++ [write]
    return (finished ++ [batch ++ deploy]).map ("\n".intercalate ·)
  match result with | .ok scripts => toJson scripts | .error error => Twin.threw error

private def sha256Hex (call : Json) : Prog Json := do
  let digest ← Prog.effect "crypto.subtle.digest" [.str "SHA-256",
    obj [("$bytes", .str (base64 (text (Twin.callArg call 0))))]]
  return .str (Access.Crypto.hex (Access.Crypto.base64Decode (text (field digest "$bytes"))))

private def runScripts (call : Json) : Prog Json := do
  let scripts := items (Twin.callArg call 1)
  for script in scripts.take (scripts.length - 1) do
    let written ← Prog.effect "runSandbox" [Twin.callArg call 0, Twin.undefinedJson, script]
    if !truthy (field written "ok") then return written
  Prog.effect "runSandbox" [Twin.callArg call 0, Twin.undefinedJson, scripts.getLast?.getD (.str "")]

private def turnSettlement (call : Json) : Prog Json := do
  let result := Twin.callArg call 0
  if truthy (field result "didFail") then
    let failure := field result "failureText"
    return obj [("status", .str "failed"), ("error",
      if undef failure || failure == .null then .str "Agent processing failed" else failure)]
  if !(items (field result "approvals")).isEmpty then
    return ← Prog.effect "outcomeSettlement" [obj [("status", .str "awaiting_approval"),
      ("approvals", field result "approvals")]]
  if !(items (field result "questions")).isEmpty then
    return ← Prog.effect "outcomeSettlement" [obj [("status", .str "awaiting_input"),
      ("questions", field result "questions")]]
  return obj [("status", .str "completed"), ("result", field result "finalResponse")]

private def continuationDelivery (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let shared := ["publicEventId", "publicConversationKey"].map fun k => (k, field event k)
  let extra := if truthy (field event "publicDeploymentIngress") then
    [("publicDeploymentIngress", field event "publicDeploymentIngress")] else []
  if truthy (field event "connectionId") then
    let url ← Prog.effect "directStatusUrl" [event]
    let url ← if truthy url then Prog.effect "directStatusUrl" [event] else pure Twin.undefinedJson
    return obj ([("kind", .str "websocket"), ("connectionId", field event "connectionId"),
      ("statusUrl", url)] ++ shared ++ extra)
  let target := field event "replyTarget"
  if truthy target then
    return obj ([("kind", .str "channel"), ("channel", field target "channelName"),
      ("source", field target "source")] ++
      if truthy (field target "identity") then [("identity", field target "identity")] else [])
  let url ← Prog.effect "directStatusUrl" [event]
  let url := if url == .null || undef url then
    .str ("/v1/runs/" ++ Access.Js.encodeURIComponent (text (field event "runId"))) else url
  return obj ([("kind", .str "async"), ("statusUrl", url)] ++ shared ++ extra)

private def recordAsyncRun (call : Json) : Prog Json := do
  let ids ← Prog.effect "asyncResultEventIds" [Twin.callArg call 0]
  let results ← Prog.all ((items ids).map fun id => ("recordAsyncAgentResult", [id, Twin.callArg call 1]))
  for result in results do
    match result with | .threw error _ => throw error | _ => pure ()
  return Twin.undefinedJson

private def runParentContinuationLoop (call : Json) : Prog Json := do
  let result ← Prog.attempt "runParentPasses" [Twin.callArg call 0]
  let _ ← Prog.effect "options.subagentCoordinator.closePasses"
  match result with
  | .ok value => pure value
  | .threw error _ => throw error
  | .pending => Prog.unsupported "parent passes unfinished"

private def recordAsyncAgentResult (call : Json) : Prog Json := do
  let row := spread (obj [("eventId", Twin.callArg call 0)]) (Access.Js.entries (Twin.callArg call 1))
  let guard := Twin.callArg call 2
  let row := if undef guard then row else spread row (Access.Js.entries guard)
  let _ ← Prog.effect "runtime.mutate" [.str "updateAsyncAgentResult", row]
  return Twin.undefinedJson

private def completionToParentMessage (call : Json) : Prog Json := do
  let c := Twin.callArg call 0
  let parts ← if field c "status" == .str "completed" && !undef (field c "response") then
    Prog.effect "modelValueToUserParts" [field c "response"] else pure (toJson ([] : List Json))
  let input ← Prog.effect "formatUnknown" [field c "input"]
  let pre :=  "Async tool result injected into parent conversation.\nstatusId: " ++ text (field c "resultId") ++
    "\ntoolName: " ++ text (field c "toolName") ++ "\nstatus: " ++ text (field c "status") ++
    "\n\nInput:\n" ++ text input ++ "\n\nResult:\n"
  let dedupe ← Prog.effect "asyncToolResultDedupeKey" [field c "resultId", field c "status"]
  let content ← if !(items parts).isEmpty then Prog.effect "prependTextToUserParts" [.str pre, parts]
    else pure (toJson [obj [("type", .str "text"), ("text", .str (pre ++
      if undef (field c "error") || field c "error" == .null then "(no result)" else text (field c "error")))]] )
  return obj [("role", .str "user"), ("dedupeKey", dedupe), ("content", content)]

private def outcomeValue : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => throw error
  | .pending => Prog.unsupported "effect is unfinished"

private def cipherFromKeys (call : Json) : Prog Json := do
  let secrets ← Prog.effect "requireSecretsEnv" [.str "ACCOUNT_CONFIG_ENCRYPTION_SECRET"]
  let primitive := obj (["hmac", "open", "seal"].map fun name => (name, obj [("$fn", .str name)]))
  Prog.effect "new AccountCipher" [Twin.callArg call 0, secrets, Twin.callArg call 1,
    obj [("primitive", primitive)]]

private def decryptAccountBlob (call : Json) : Prog Json := do
  let _ ← Prog.effect "keyringHolding" [Twin.callArg call 0, Twin.callArg call 2]
  let value ← Prog.effect "cipher.decrypt" [Twin.callArg call 1, Twin.callArg call 2]
  if !truthy value then
    return ← Prog.throwError "Error" ("Stored " ++ text (Twin.callArg call 1) ++ " of account " ++
      text (Twin.callArg call 0) ++ " does not decrypt")
  return value

private def formatChannelFinalText (call : Json) : Prog Json := do
  let enabled ← Prog.effect "isChannelTraceEnabled" [Twin.callArg call 4, Twin.callArg call 3]
  if !truthy enabled then return Twin.callArg call 0
  let link ← Prog.effect "dashboardTraceUrl" [Twin.callArg call 1, Twin.callArg call 2]
  if !truthy link then return Twin.callArg call 0
  return .str (Access.Js.trim (text (Twin.callArg call 0)) ++ "\n\nTrace: " ++ text link)

private def prettyJson : Nat → Nat → Json → String
  | 0, _, value => value.compress
  | fuel + 1, depth, .arr values =>
    if values.isEmpty then "[]" else
      let indent := String.ofList (List.replicate ((depth + 1) * 2) ' ')
      "[\n" ++ ",\n".intercalate (values.toList.map fun v => indent ++ prettyJson fuel (depth + 1) v) ++
        "\n" ++ String.ofList (List.replicate (depth * 2) ' ') ++ "]"
  | fuel + 1, depth, .obj fields =>
    if fields.toList.isEmpty then "{}" else
      let indent := String.ofList (List.replicate ((depth + 1) * 2) ' ')
      "{\n" ++ ",\n".intercalate (fields.toList.map fun (k, v) =>
        indent ++ (Json.str k).compress ++ ": " ++ prettyJson fuel (depth + 1) v) ++
        "\n" ++ String.ofList (List.replicate (depth * 2) ' ') ++ "}"
  | _, _, value => value.compress

private def channelReplyText (args : Json) : Json :=
  let response := Twin.arg args 0
  let rendered := match response with | .str s => s | _ => prettyJson 256 0 response
  if Access.Js.trim rendered == "" then .null else .str rendered

private def scheduledMillis (s : String) : Option Int := do
  let pieces := (s.replace "T" "-" |>.replace ":" "-" |>.replace "Z" "").splitOn "-"
  let [ys, ms, ds, hs, mins, secs] := pieces | none
  let year ← ys.toNat?
  let month ← ms.toNat?
  let day ← ds.toNat?
  let hour ← hs.toNat?
  let minute ← mins.toNat?
  let secParts := secs.splitOn "."
  let second ← secParts.headD "" |>.toNat?
  let millis ← if secParts.length == 1 then some 0 else
    if secParts.length == 2 && (secParts[1]!).length == 3 then (secParts[1]!).toNat? else none
  if year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59 || !s.endsWith "Z" then none else
    let leap := year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    let monthDays := [31, if leap then 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    let leapBefore := fun y => y / 4 - y / 100 + y / 400
    let days := (year - 1970) * 365 + leapBefore (year - 1) - leapBefore 1969 +
      (monthDays.take (month - 1)).foldl (· + ·) 0 + day - 1
    some (Int.ofNat (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)

private def scheduledFireTime (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  if !truthy input then
    let now ← Prog.effect "new Date"
    return obj [("$date", now)]
  match scheduledMillis (text input) with
  | some timestamp => pure (obj [("$date", toJson timestamp)])
  | none => Prog.unsupported "Date parsing outside UTC ISO instants"

private def outcomeOr (fallback : Json) : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => throw error
  | .pending => pure fallback

private def subjectIdOk (value : String) : Bool :=
  value != "" && value.toList.all fun c => !Access.Js.isSpace c && c != '.' && c != '*' && c != '>'

private def streamResponseSubject (call : Json) : Prog Json := do
  let account := text (Twin.callArg call 0)
  let agent := text (Twin.callArg call 1)
  if !subjectIdOk account || !subjectIdOk agent then
    return ← Prog.throwError "Error" "Account and agent ids must be plain NATS subject tokens"
  let token ← Prog.effect "subjectToken" [Twin.callArg call 2]
  return .str ("v1." ++ account ++ "." ++ agent ++ ".ws.response." ++ text token)

private def wildcardSubject (kind : String) (call : Json) : Prog Json := do
  let token ← Prog.effect "subjectToken" [Twin.callArg call 2]
  return .str ("v1." ++ text (Twin.callArg call 0) ++ "." ++ text (Twin.callArg call 1) ++ "." ++
    text token ++ "." ++ kind ++ ".>")

private def readConversationStream (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let _ ← Prog.effect "ensureResponseStream" [field o "connection"]
  let _ ← Prog.effect "options.connection.jetstream"
  let subject ← Prog.effect "streamResponseSubject"
    [field o "accountId", field o "agentId", field o "conversationKey"]
  let policy ← Prog.effect "consumerStartPolicy" [field o "startSequence", field o "startTime"]
  let _ ← Prog.effect "js.consumers.get" [.str "WS_RESPONSES",
    spread (obj [("filterSubjects", subject)]) (Access.Js.entries policy)]
  Prog.effect "consumer.consume"

private def readObservabilityStream (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let _ ← Prog.effect "ensureObservabilityStream" [field o "connection"]
  let _ ← Prog.effect "options.connection.jetstream"
  let subject ← Prog.effect "wildcard" [field o "accountId", field o "project", field o "stage"]
  let policy ← Prog.effect "consumerStartPolicy" [Twin.undefinedJson, field o "startTime"]
  let _ ← Prog.effect "js.consumers.get" [.str "OBSERVABILITY",
    spread (obj [("filterSubjects", subject)]) (Access.Js.entries policy)]
  Prog.effect "consumer.consume"

private def conversationReplaySnapshot (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let _ ← Prog.effect "ensureResponseStream" [field o "connection"]
  let _ ← Prog.effect "jetstreamManagerFor" [field o "connection"]
  let subject ← Prog.effect "streamResponseSubject"
    [field o "accountId", field o "agentId", field o "conversationKey"]
  let info ← Prog.effect "jsm.streams.info" [.str "WS_RESPONSES", obj [("subjects_filter", subject)]]
  let created ← match field info "created" with
    | .str s => pure s
    | _ => Prog.unsupported "non-string stream creation time"
  let state := field info "state"
  let counted := field (field state "subjects") (text subject)
  let buffered := if undef counted || counted == .null then toJson (0 : Nat) else counted
  let positive := match buffered.getNat? with | .ok n => n > 0 | _ => false
  let finish := fun (seq count : Json) => obj [
    ("generation", .str (Access.Crypto.base64UrlEncode created.toUTF8.toList)),
    ("lastSequence", seq), ("bufferedCount", count)]
  if !positive then return finish (field state "last_seq") buffered
  match ← Prog.attempt "jsm.streams.getMessage" [.str "WS_RESPONSES", obj [("last_by_subj", subject)]] with
  | .ok last => return finish (field last "seq") buffered
  | .threw _ _ => return finish (field state "last_seq") (toJson (0 : Nat))
  | .pending => Prog.unsupported "getMessage is unfinished"

private def adminCall (method : String) (call : Json) (extra : List Json) : Prog Json := do
  let _ ← Prog.effect "getConvexClient"
  let name ← Prog.effect "getFunctionName" [Twin.callArg call 0]
  let reference ← Prog.effect "makeFunctionReference" [name]
  Prog.effect ("getConvexClient()." ++ method) ([reference, Twin.callArg call 1] ++ extra)

private def renewQueuedLease (call : Json) : Prog Json := do
  let entry := items (Twin.callArg call 0)
  let lease := entry.getD 2 Twin.undefinedJson
  if !truthy lease then return Twin.undefinedJson
  match ← Prog.attempt "renewIngressOwner" [lease] with
  | .ok renewal =>
    if renewal != .str "renewed" then
      let cleared := Json.arr (entry.set 2 Twin.undefinedJson).toArray
      Prog.setState "args.0" cleared
      -- `Array.map` passes the array too, and it holds this same entry.
      match Twin.callArg call 1, Twin.callArg call 2 with
      | index, .arr waiting =>
        Prog.setState "args.2"
          (.arr (waiting.toList.set (index.getNat?.toOption.getD 0) cleared).toArray)
      | _, _ => pure ()
  | _ => pure ()
  return Twin.undefinedJson

private def withQueuePlace (call : Json) : Prog Json := do
  let full ← Prog.effect "workerQueueFull"
  if truthy full then return Twin.undefinedJson
  Prog.effect "queuePlace.run" [obj [("held", .bool true)], Twin.callArg call 0]

private def sseHeaders (headers : Json) : List (String × Json) :=
  let lowered := (Access.Js.entries headers).map fun (k, v) => (k.toLower, v)
  (("content-type", Json.str "text/event-stream") ::
    lowered.filter (·.1 != "content-type")).mergeSort fun a b => a.1 <= b.1

private def errorSseResponse (call : Json) : Prog Json := do
  let error := text (Twin.callArg call 0)
  let status := Twin.callArg call 1
  let status := if undef status then toJson (200 : Nat) else status
  let headers := Twin.param call 2
  let body := "data: {\"type\":\"error\",\"error\":" ++ Access.Js.quoteJson error ++ "}\n\n"
  Prog.drain (fun label _ =>
    if label == "start" then do
      let _ ← Prog.effect "controller.enqueue" [obj [("$bytes", .str (base64 body))]]
      let _ ← Prog.effect "controller.close"
      pure ()
    else Prog.unsupported s!"callback {label}") 4
  let _ ← Prog.effect "new ReadableStream" [obj [("start", obj [("$fn", .str "start")])]]
  return obj [("$response", obj [("status", status),
    ("headers", toJson ((sseHeaders headers).map fun (k, v) => toJson [Json.str k, v])),
    ("body", obj [("$opaque", .str "ReadableStream")])])]

private def continuationResponse (call : Json) : Prog Json :=
  let settled := Twin.callArg call 0
  let outcome := Twin.callArg call 1
  Prog.effect "jsonResponse" [toJson (202 : Nat),
    if field outcome "kind" == .str "skip" then
      obj [("status", .str "accepted"), ("resultId", field settled "resultId"), ("invoked", .bool false)]
    else
      obj [("status", .str "accepted"), ("resultId", field settled "resultId"),
        ("eventId", field outcome "publicEventId"), ("invoked", field outcome "invoked")]]

private def acceptedAsyncResponse (call : Json) : Prog Json :=
  let event := Twin.callArg call 2
  Prog.effect "jsonResponse" [toJson (202 : Nat), obj [("runId", Twin.callArg call 0),
    ("eventId", field event "publicEventId"), ("conversationKey", field event "publicConversationKey"),
    ("status", Twin.callArg call 3), ("requestedMode", field event "requestedMode"),
    ("statusUrl", Twin.callArg call 1)]]

private def openQuestion (call : Json) : Prog Json := do
  let record := Twin.callArg call 0
  if !truthy record || field record "conversationKey" != Twin.callArg call 1 ||
      field record "toolName" != .str "ask_questions" || field record "status" != .str "processing" then
    return Twin.undefinedJson
  let pending := field record "input"
  let some answerBy := scheduledMillis (text (field pending "answerBy"))
    | Prog.unsupported "answerBy outside UTC ISO instants"
  let now ← Prog.effect "Date.now"
  let expired := match now.getInt? with | .ok n => decide (answerBy < n) | _ => false
  if expired then
    Prog.spawn "markAsyncToolResultFailed"
      [obj [("resultId", field record "resultId"), ("error", .str "no_answer")]]
    return Twin.undefinedJson
  return obj [("record", record), ("pending", pending)]

private def listOpenQuestions (call : Json) : Prog Json := do
  let key := Twin.callArg call 0
  let rows ← Prog.effect "runtime.query" [.str "listPendingAsyncToolResults",
    obj [("conversationKey", key), ("toolName", .str "ask_questions")]]
  let mut open_ : List Json := []
  for row in items rows do
    let one ← Prog.effect "openQuestion" [row, key]
    if !undef one then open_ := open_ ++ [one]
  return toJson open_

private def ownerOf (conversationKey eventId generation : Json) : Json :=
  obj [("conversationKey", conversationKey), ("ownerEventId", eventId), ("ownerGeneration", generation)]

private def takeNextIngress (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let settle := Twin.callArg call 1
  let events := Twin.callArg call 2
  let next ← Prog.effect "runtime.mutate" [.str "takeNextIngress", spread options
    ([("leaseTtlMs", toJson (900000 : Nat))] ++
      (if truthy settle then [("settle", settle)] else []) ++
      (if (items events).isEmpty then [] else [("events", events)]))]
  let _ ← Prog.effect "forgetOwner" [options]
  if truthy next then
    let _ ← Prog.effect "trackOwner"
      [ownerOf (field options "conversationKey") (field next "eventId") (field next "ownerGeneration")]
  return next

private def releaseIngressOwner (call : Json) : Prog Json := do
  let owner := Twin.callArg call 0
  let _ ← Prog.effect "runtime.mutate" [.str "releaseIngressOwner",
    ownerOf (field owner "conversationKey") (field owner "ownerEventId") (field owner "ownerGeneration")]
  let _ ← Prog.effect "forgetOwner" [owner]
  return Twin.undefinedJson

private def loadChannelSessionConfig (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let account := field o "accountId"
  let agentId := field o "agentId"
  let target := field o "target"
  let credential := field target "credentialAgentId"
  let recordId := field target "channelRecordId"
  let _ ← Prog.effect "getStorage"
  let outcomes ← Prog.all ([("storage.agents.getById", [account, agentId])] ++
    (if truthy credential then [("storage.agents.getById", [account, credential])] else []) ++
    (if truthy recordId then [("storage.channelRecords.getById", [account, recordId])] else []))
  let agent ← outcomeValue (outcomes.headD .pending)
  let holder ← if truthy credential then outcomeValue (outcomes.getD 1 .pending) else pure .null
  let record ← if truthy recordId then outcomeValue (outcomes.getLastD .pending) else pure .null
  if !truthy agent then
    return ← Prog.throwError "Error" ("Agent not found: " ++ text agentId)
  let active := field record "status" == .str "active"
  let bound ← if active then Prog.effect "resolveChannelAgentId" [record] else pure Twin.undefinedJson
  if (truthy recordId && !active) || (truthy bound && bound != agentId) ||
      (truthy credential && !truthy holder) then
    return ← Prog.throwError "Error" "Channel session is no longer bound to this agent"
  let config ← Prog.effect "channelRuntimeAgentConfig" [
    obj ([("agent", agent)] ++ if active then [("record", record)] else []),
    field target "channelName", field (if truthy holder then holder else agent) "config"]
  return obj [("agentConfig", config), ("configRef", obj [("channel", obj (
    [("channelName", field target "channelName")] ++
    (if truthy credential then [("credentialAgentId", credential)] else []) ++
    (if truthy recordId then [("channelRecordId", recordId)] else [])))])]

private def loadAppliedIngressConfig (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let account := field o "accountId"
  let agentId := field o "agentId"
  let ref := field o "configRef"
  if !truthy ref then
    return ← Prog.throwError "Error" "Queued turn was admitted before config refs; retry"
  if truthy (field ref "channel") then
    let loaded ← Prog.effect "loadChannelSessionConfig"
      [obj [("accountId", account), ("agentId", agentId), ("target", field ref "channel")]]
    return field loaded "agentConfig"
  let _ ← Prog.effect "getStorage"
  let agent ← Prog.effect "getStorage().agents.getById" [account, agentId]
  if !truthy agent then
    return ← Prog.throwError "Error" ("Agent not found: " ++ text agentId)
  let config ← Prog.effect "toRuntimeAgentConfig" [field agent "config"]
  Prog.effect "applyRunOverrides" [config,
    if truthy (field ref "model") then obj [("model", field ref "model")] else Twin.undefinedJson]

private def sweepPages (resume updatedAfter handback status : Json) :
    Nat → Json → Prog Unit
  | 0, _ => Prog.unsupported "more pages than the model allows"
  | fuel + 1, cursor => do
    let before ← Prog.effect "finishedBefore" [handback]
    let result ← Prog.effect "listOwedAsyncToolResults" [obj [("handback", handback), ("status", status),
      ("updatedAfter", updatedAfter), ("updatedBefore", before), ("cursor", cursor)]]
    for row in items (field result "page") do
      let _ ← Prog.effect "resumeLostAsyncToolResult" [row, resume]
    if field result "isDone" == .bool true then pure ()
    else sweepPages resume updatedAfter handback status fuel (field result "cursor")

private def resumeLostAsyncToolResults (call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  let windows ← Prog.effect "lostResultWindows" [now]
  for handback in ["detached", "pending"] do
    for status in ["completed", "failed"] do
      sweepPages (Twin.callArg call 0) (field windows "updatedAfter") (.str handback) (.str status) 256 .null
  return Twin.undefinedJson

/-- `new Date(ms).toISOString()` for instants from 1970 on, by the civil-from-days algorithm. -/
private def isoOfMillis (ms : Nat) : String :=
  let pad := fun (width value : Nat) =>
    let digits := toString value
    String.ofList (List.replicate (width - digits.length) '0') ++ digits
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
  pad 4 year ++ "-" ++ pad 2 month ++ "-" ++ pad 2 day ++ "T" ++ pad 2 (rest / 3600000) ++ ":" ++
    pad 2 (rest / 60000 % 60) ++ ":" ++ pad 2 (rest / 1000 % 60) ++ "." ++ pad 3 (rest % 1000) ++ "Z"

private def removeOneShotCron (call : Json) : Prog Json := do
  let _ ← Prog.effect "getStorage"
  let _ ← Prog.attempt "getStorage() .crons.remove" [Twin.callArg call 0, Twin.callArg call 1]
  return Twin.undefinedJson

private def settleCronRun (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let cronRun := Twin.callArg call 1
  let outcome := Twin.callArg call 2
  if !truthy cronRun then return Twin.undefinedJson
  let _ ← Prog.effect "getStorage"
  let ids := [account, field cronRun "cronId", field cronRun "runId"]
  if field outcome "status" == .str "failed" then
    let _ ← Prog.effect "crons.failRun" (ids ++ [field outcome "error"])
  else if field outcome "status" == .str "completed" then
    let _ ← Prog.effect "crons.completeRun" (ids ++ [field outcome "response"])
  else return Twin.undefinedJson
  if truthy (field cronRun "oneShot") then
    let _ ← Prog.effect "removeOneShotCron" [account, field cronRun "cronId"]
  return Twin.undefinedJson

private def pushReplyToChannel (call : Json) : Prog Json := do
  let event := Twin.callArg call 1
  let target := field event "replyTarget"
  if !truthy target then return Twin.undefinedJson
  match ← Prog.attempt "session.assertCurrentOwner" with
  | .threw _ _ => return Twin.undefinedJson
  | _ => pure ()
  let _ ← Prog.attempt "sendChannelReply" [obj [("config", field event "agentConfig"),
    ("accountId", field event "accountId"), ("channelName", field target "channelName"),
    ("source", field target "source"), ("text", Twin.callArg call 2)]]
  return Twin.undefinedJson

private def handleStatusRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let result := field event "ingress"
  let asyncResult ← Prog.effect "getAsyncAgentResult" [field event "eventId"]
  let held := field asyncResult "status"
  let status := if truthy asyncResult && (held == .str "awaiting_approval" || held == .str "awaiting_input" ||
      (held == .str "processing" && field result "status" != .str "failed")) then held
    else field result "status"
  let scope := [field event "accountId", field event "agentId"]
  let key ← Prog.effect "eventPublicConversationKey" ([field result "conversationKey"] ++ scope)
  let applied ← if undef (field result "appliedToEventId") then pure Twin.undefinedJson else
    Prog.effect "publicEventIdForScope" ([field result "appliedToEventId"] ++ scope ++ [field event "publicEventId"])
  let some updated := (field result "updatedAt").getNat?.toOption
    | Prog.unsupported "non-integer updatedAt"
  let some created := (field result "createdAt").getNat?.toOption
    | Prog.unsupported "non-integer createdAt"
  let some rowUpdated := if truthy asyncResult then
      (scheduledMillis (text (field asyncResult "updatedAt"))).map Int.toNat else some 0
    | Prog.unsupported "row updatedAt outside UTC ISO instants"
  let plainError := field result "error"
  let error := if undef plainError || plainError == .null then field asyncResult "error" else plainError
  let body ← Prog.effect "stripUndefined" [obj [("runId", field event "runId"),
    ("eventId", field event "publicEventId"), ("agentId", field event "agentId"),
    ("conversationKey", key), ("status", status), ("requestedMode", field result "requestedMode"),
    ("appliedMode", field result "appliedMode"), ("appliedToEventId", applied),
    ("result", field result "result"),
    ("stoppedByUser", if truthy (field result "stoppedByUser") then .bool true else Twin.undefinedJson),
    ("response", field asyncResult "response"), ("approvals", field asyncResult "approvals"),
    ("questions", field asyncResult "questions"),
    ("error", if truthy error then error else Twin.undefinedJson),
    ("createdAt", .str (isoOfMillis created)),
    ("lastUpdatedAt", .str (isoOfMillis (max updated rowUpdated)))]]
  Prog.effect "jsonResponse" [toJson (200 : Nat), body]

private def resolveReentryTarget (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let account := field o "accountId"
  let agent := field o "agentId"
  let publicKey := field o "publicConversationKey"
  let sessionKey ← Prog.effect "accountAgentScopedKey" [account, agent, publicKey]
  let storage ← Prog.effect "getStorage"
  let hasLookup := !undef (field (field storage "agentDeployments") "getByAgentId")
  let target := obj [("accountId", account), ("agentId", agent), ("conversationKey", sessionKey)]
  let outcomes ← Prog.all ((if hasLookup then
      [("getStorage().agentDeployments.getByAgentId", [account, agent])] else []) ++
    [("getConversationDispatchTarget", [target])])
  let deployment ← if hasLookup then outcomeValue (outcomes.headD .pending) else pure Twin.undefinedJson
  let channel ← outcomeValue (outcomes.getLastD .pending)
  let runConfig ← if truthy channel then
      Prog.effect "loadChannelSessionConfig"
        [obj [("accountId", account), ("agentId", agent), ("target", channel)]]
    else
      pure (obj [("agentConfig", field o "agentConfig"), ("configRef",
        if undef (field o "configRef") then obj [] else field o "configRef")])
  let key ← if truthy channel then pure sessionKey else
    Prog.effect "scopedDirectConversationKey" [account, agent, publicKey]
  return spread runConfig ([("conversationKey", key)] ++
    (if truthy channel then [("replyTarget", obj [("channelName", field channel "channelName"),
      ("source", field channel "source")])] else []) ++
    (if truthy deployment then ["endpointId", "projectSlug", "stageSlug"].map fun k => (k, field deployment k)
      else []))

private def loadReentryTarget (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let agentId := Twin.callArg call 1
  let _ ← Prog.effect "getStorage"
  let agent ← Prog.effect "getStorage().agents.getById" [account, agentId]
  if !truthy agent then return .null
  let key ← Prog.effect "eventPublicConversationKey" [Twin.callArg call 2, account, agentId]
  let config ← Prog.effect "toRuntimeAgentConfig" [field agent "config"]
  Prog.effect "resolveReentryTarget" [obj [("accountId", account), ("agentId", agentId),
    ("publicConversationKey", key), ("agentConfig", config)]]

private def directSession (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let target := field event "replyTarget"
  let delivery := if truthy (field event "connectionId") then
      obj [("kind", .str "nats"), ("connectionId", field event "connectionId"),
        ("publicEventId", field event "publicEventId"),
        ("publicConversationKey", field event "publicConversationKey")]
    else if truthy target then
      obj ([("kind", .str "channel"), ("channelName", field target "channelName"),
        ("source", field target "source")] ++
        if truthy (field target "identity") then [("identity", field target "identity")] else [])
    else obj [("kind", .str "async")]
  if undef (field event "ownerGeneration") then
    return ← Prog.throwError "Error" "Direct turn is missing its durable owner generation"
  let actions ← if truthy target then
      Prog.effect "channelActionsFromConfig"
        [field event "agentConfig", field target "channelName", field target "source"]
    else pure Twin.undefinedJson
  let chain ← Prog.effect "directPrincipalChain" [event]
  let principal ← Prog.effect "runPrincipal" [event, chain]
  Prog.effect "new Session" [obj
    ((["eventId", "conversationKey", "accountId", "agentId", "agentConfig"].map fun k => (k, field event k)) ++
    [("delivery", delivery)] ++
    (["endpointId", "projectSlug", "stageSlug", "ownerGeneration"].map fun k => (k, field event k)) ++
    [("channelActions", if actions == .null then Twin.undefinedJson else actions),
     ("trigger", if truthy (field event "cronRun") then .str "cron" else Twin.undefinedJson),
     ("principal", principal), ("userCredential", field event "userCredential")])]

private def settleFailedIngressAndDrain (call : Json) : Prog Json := do
  let _ ← Prog.attempt "session.settleIngress" [.str "failed", obj [("error", Twin.callArg call 1)]]
  let transferred ← match ← Prog.attempt "dispatchNext" with
    | .ok value => pure value
    | .threw _ _ => pure (.bool false)
    | .pending => Prog.unsupported "dispatchNext is unfinished"
  if !truthy transferred then
    let _ ← Prog.attempt "session.releaseConversationLease"
  return transferred

private def settleChannelQuestion (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let click := field event "answer"
  let key := field event "conversationKey"
  let opened ← if truthy click then do
      let row ← Prog.effect "getAsyncToolResult" [field click "statusId"]
      Prog.effect "openQuestion" [row, key]
    else do
      let listed ← Prog.effect "listOpenQuestions" [key]
      pure ((items listed).headD Twin.undefinedJson)
  let chosen ← if truthy opened && truthy click then
      Prog.effect "answersFromChoice" [field opened "pending", click]
    else pure Twin.undefinedJson
  if truthy click && !truthy chosen then
    let _ ← Prog.attempt "event.channel .sendText" [.str "That question is no longer open."]
    return .bool true
  if !truthy opened then return .bool false
  let answer ← if truthy chosen then
      pure (obj [("status", .str "answered"), ("answers", chosen)])
    else do
      let typed ← Prog.effect "extractText" [field event "content"]
      Prog.effect "answersFromText" [field opened "pending", typed]
  if !truthy answer then return .bool false
  let settled ← Prog.effect "settleQuestion" [field opened "record", spread answer
    (if truthy (field event "identity") then [("answeredBy", field event "identity")] else [])]
  if !truthy settled then return .bool false
  let _ ← Prog.effect "continueAfterAsyncToolSettlement" [settled]
  return .bool true

private def createCronDirectEvent (call : Json) : Prog Json := do
  let job := Twin.callArg call 0
  let firedAt := Twin.callArg call 1
  let account := field job "accountId"
  let agentId := field job "agentId"
  let uuid ← Prog.effect "crypto.randomUUID"
  let publicEventId := Json.str (text (field job "cronId") ++ "-" ++ text uuid)
  let publicKey := if truthy (field job "conversationKey") || field job "conversationKey" == .str "" then
    field job "conversationKey" else .str ("cron:" ++ text (field job "cronId"))
  let _ ← Prog.effect "getStorage"
  let agent ← Prog.effect "getStorage().agents.getById" [account, agentId]
  if !truthy agent then
    return ← Prog.throwError "Error" ("Agent not found: " ++ text agentId)
  let config ← Prog.effect "toRuntimeAgentConfig" [field agent "config"]
  let target ← Prog.effect "resolveReentryTarget" [obj [("accountId", account), ("agentId", agentId),
    ("publicConversationKey", publicKey), ("agentConfig", config)]]
  let runId ← Prog.effect "createRunId"
  let eventId ← Prog.effect "scopedDirectEventId" [account, agentId, publicEventId]
  let events ← Prog.effect "withScheduledRunContext" [job, firedAt]
  return spread (obj [("accountId", account), ("agentId", agentId), ("runId", runId), ("eventId", eventId),
    ("publicEventId", publicEventId), ("publicConversationKey", publicKey), ("events", events),
    ("requestedMode", .str "reject"), ("idempotencyKey", publicEventId)]) (Access.Js.entries target)

private def openCronRun (call : Json) : Prog Json := do
  let job := Twin.callArg call 0
  let event ← Prog.effect "createCronDirectEvent" [job, Twin.callArg call 1]
  let _ ← Prog.effect "getStorage"
  let run ← Prog.effect "getStorage().crons.createRun" [obj [("accountId", field job "accountId"),
    ("cronId", field job "cronId"), ("eventId", field event "publicEventId"),
    ("conversationKey", field event "publicConversationKey")], Twin.callArg call 1]
  return obj [("event", event), ("run", run)]

private def settleAsyncRun (call : Json) : Prog Json := do
  let session := Twin.callArg call 0
  let event := Twin.callArg call 1
  let outcome := Twin.callArg call 2
  let settlement ← Prog.effect "outcomeSettlement" [outcome]
  let settled ← if undef session then pure Twin.undefinedJson else do
    let ids ← Prog.effect "asyncResultEventIds" [event]
    let rest := obj ((Access.Js.entries settlement).filter (·.1 != "status"))
    Prog.effect "session?.settleIngress" [field settlement "status",
      spread rest [("asyncResult", obj [("eventIds", ids), ("outcome", outcome)])]]
  if !truthy settled then
    let _ ← Prog.effect "recordAsyncRun" [event, outcome]
  return Twin.undefinedJson

private def queueFullResponse (call : Json) : Prog Json := do
  let admitted ← Prog.effect "admitRun" [Twin.callArg call 0, obj [("count", .bool false)]]
  if truthy (field admitted "refusal") then
    return ← Prog.effect "planRefusalResponse" [field admitted "refusal"]
  Prog.effect "full"

private def errorMessageOr (fallback : String) (error : Json) : String :=
  match field (field error "$error") "message" with
  | .str message => message
  | _ => fallback

private def chatgptIssuer : String := "https://auth.openai.com"

private def refreshAndSave (call : Json) : Prog Json := do
  let account := Twin.callArg call 0
  let kind := Twin.callArg call 1
  let stored := Twin.callArg call 2
  if kind != .str "chatgpt" then return ← Prog.unsupported "connection type outside the model"
  let handle (label : String) (args : Json) : Prog Unit := do
    if label != "arg2" then return ← Prog.unsupported s!"callback {label}"
    let signal ← Prog.effect "AbortSignal.timeout" [toJson (15000 : Nat)]
    let _ ← Prog.effect "fetch" [Twin.arg args 0, spread (Twin.arg args 1) [("signal", signal)]]
    pure ()
  Prog.drain handle 4
  let grant ← Prog.attempt "refreshTokenGrant" [.str (chatgptIssuer ++ "/api/accounts/oauth/token"),
    obj [("client_id", field stored "clientId"), ("refresh_token", field stored "refreshToken"),
      ("resource", .str "https://api.openai.com/v1")], obj [("$fn", .str "")]]
  match grant with
  | .pending => Prog.unsupported "refresh is unfinished"
  | .threw error _ =>
    let _ ← Prog.effect "getStorage"
    let latest ← Prog.effect "getStorage().connections.load" [account, kind]
    if truthy latest && field latest "updatedAt" != field stored "updatedAt" then
      return ← Prog.effect "loadFresh" [account, kind]
    let reason ← Prog.effect "toErrorMessage" [error]
    Prog.throwError "Error" ("ChatGPT plan connection could not refresh: " ++ text reason ++
      ". Run `broods connect chatgpt` to sign in again.")
  | .ok refreshed =>
    let next := field refreshed "refreshToken"
    let rotated := obj [("accessToken", field refreshed "accessToken"),
      ("refreshToken", if undef next || next == .null then field stored "refreshToken" else next),
      ("expiresAt", field refreshed "expiresAt")]
    let _ ← Prog.effect "getStorage"
    let saved ← Prog.effect "getStorage().connections.saveRefreshed" [account, kind, stored, rotated]
    if !truthy saved then return ← Prog.effect "loadFresh" [account, kind]
    let now ← Prog.effect "Date.now"
    return spread (spread stored (Access.Js.entries rotated)) [("updatedAt", now)]

private def failOwnedIngress (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  if undef (field event "ownerGeneration") then return Twin.undefinedJson
  let delivery := if truthy (field event "connectionId") then
    obj [("kind", .str "nats"), ("connectionId", field event "connectionId"),
      ("publicEventId", field event "publicEventId"),
      ("publicConversationKey", field event "publicConversationKey")] else Twin.undefinedJson
  let session ← Prog.effect "new Session" [obj
    ((["eventId", "conversationKey", "accountId", "agentId", "agentConfig"].map fun k => (k, field event k)) ++
    [("delivery", delivery)] ++
    (["endpointId", "projectSlug", "stageSlug", "ownerGeneration"].map fun k => (k, field event k)))]
  Prog.drain (fun label _ =>
    if label == "arg2" then
      Prog.catchFail (do let _ ← Prog.effect "dispatchNextIngress" [session, event]; pure ()) (fun _ => pure ())
    else Prog.unsupported s!"callback {label}") 4
  let _ ← Prog.effect "settleFailedIngressAndDrain" [session, Twin.callArg call 1, obj [("$fn", .str "")]]
  return Twin.undefinedJson

private def admitInternalContinuation (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let fence := Twin.callArg call 2
  let base := if undef fence then obj [] else fence
  let admission ← Prog.effect "acceptIngress" [spread base (
    (["accountId", "agentId", "eventId", "runId", "conversationKey", "events", "requestedMode",
      "idempotencyKey"].map fun k => (k, field event k)) ++
    [("delivery", Twin.callArg call 1), ("configRef", field event "configRef")] ++
    (if truthy (field event "ephemeralSystem") then [("ephemeralSystem", field event "ephemeralSystem")] else []))]
  let _ ← Prog.effect "dispatchRecoveredIngress" [event, admission]
  if field admission "outcome" != .str "owner" then
    return obj [("admission", admission), ("owned", .null)]
  if undef (field admission "ownerGeneration") then
    return ← Prog.throwError "Error" "Continuation admission did not return an owner generation"
  return obj [("admission", admission),
    ("owned", spread event [("ownerGeneration", field admission "ownerGeneration")])]

private def dispatchNextIngress (call : Json) : Prog Json := do
  let next ← Prog.effect "session.takeNextIngress" [Twin.callArg call 2]
  if !truthy next then return .bool false
  let _ ← Prog.effect "dispatchAppliedIngress" [Twin.callArg call 1, next]
  return .bool true

private def dispatchRecoveredIngress (call : Json) : Prog Json := do
  let recovered := field (Twin.callArg call 1) "recovered"
  if !truthy recovered then return Twin.undefinedJson
  let _ ← Prog.attempt "dispatchAppliedIngress" [Twin.callArg call 0, recovered]
  return Twin.undefinedJson

private def invokeHarnessWorker (call : Json) : Prog Json := do
  let payload := Twin.callArg call 0
  let event := field payload "event"
  let lease := if undef (field event "ownerGeneration") then Twin.undefinedJson else
    ownerOf (field event "conversationKey") (field event "eventId") (field event "ownerGeneration")
  let _ ← Prog.effect "dispatchInProcessWorker" [field payload "kind", obj [("$fn", .str "")], lease]
  Prog.drain (fun label args =>
    if label == "arg1" then Prog.spawn "handler" [payload, Twin.arg args 0]
    else Prog.unsupported s!"callback {label}") 4
  return Twin.undefinedJson

private def startOwnedAsyncRun (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let created ← Prog.effect "createPendingAsyncAgentResult" [obj [("eventId", field event "eventId"),
    ("conversationKey", field event "conversationKey")]]
  if !truthy created then return Twin.undefinedJson
  match ← Prog.attempt "invokeAsyncWorker" [event] with
  | .threw error _ =>
    let message := Json.str (errorMessageOr "Failed to start async worker" error)
    let _ ← Prog.effect "recordAsyncRun" [event, obj [("status", .str "failed"), ("error", message)]]
    let _ ← Prog.effect "failOwnedIngress" [event, message]
    return Twin.undefinedJson
  | _ => return Twin.undefinedJson

private def asyncToolRowSecretValues (call : Json) : Prog Json := do
  let row := Twin.callArg call 0
  let scope ← Prog.effect "parseAccountAgentFromScopedKey" [field row "parentEventId"]
  let agent ← if truthy scope then do
      let _ ← Prog.effect "getStorage"
      Prog.effect "getStorage().agents.getById" [field scope "accountId", field scope "agentId"]
    else pure .null
  if !truthy scope || !truthy agent then return toJson ([] : List Json)
  let config ← Prog.effect "toRuntimeAgentConfig" [field agent "config"]
  match ← Prog.attempt "resolveAgentRuntime" [config, obj [("accountId", field scope "accountId"),
      ("agentId", field scope "agentId")]] with
  | .ok runtime =>
    Prog.effect "collectSecretValues" [toJson [config, field runtime "sandboxes", field runtime "workspaces"]]
  | .threw error _ =>
    let _ ← Prog.effect "toErrorMessage" [error]
    Prog.effect "collectSecretValues" [config]
  | .pending => Prog.unsupported "runtime is unfinished"

private def continueAfterAsyncToolSettlement (call : Json) : Prog Json := do
  let settled := Twin.callArg call 0
  let scope ← Prog.effect "parseAccountAgentFromScopedKey" [field settled "parentEventId"]
  if !truthy scope || field settled "status" == .str "processing" || field settled "handback" == .str "stored" then
    return obj [("kind", .str "skip")]
  let publicEventId := Json.str ("async-tools-" ++ text (field settled "resultId"))
  let question := field settled "toolName" == .str "ask_questions"
  let delivery := field settled "delivery"
  let kind := field delivery "kind"
  let asking ← if kind == .str "channel" then pure .null else do
    let eventId ← Prog.effect "askingEventId" [settled]
    Prog.effect "getIngressStatusByEventId" [spread scope [("eventId", eventId)]]
  let eventId ← Prog.effect "asyncToolContinuationEventId" [settled]
  let message ← Prog.effect "completionToParentMessage" [obj (
    (["resultId", "toolName", "input", "status"].map fun k => (k, field settled k)) ++
    (if undef (field settled "response") then [] else [("response", field settled "response")]) ++
    (if truthy (field settled "error") then [("error", field settled "error")] else []))]
  Prog.effect "resumeConversation" [spread scope (
    (if truthy (field asking "publicDeploymentIngress") then
      [("publicDeploymentIngress", field asking "publicDeploymentIngress")] else []) ++
    [("eventId", eventId), ("publicEventId", publicEventId), ("toolResultId", field settled "resultId"),
     ("conversationKey", field settled "conversationKey"),
     ("delivery", if question && kind == .str "nats" then spread delivery [("publicEventId", publicEventId)]
       else delivery)] ++
    (if kind == .str "async" then [("asyncResultEventId", field settled "parentEventId")] else []) ++
    [("message", message), ("requestedMode", .str (if question then "steer" else "followup"))])]

private def resumeAfterSubagentResult (call : Json) : Prog Json := do
  let parent := Twin.callArg call 0
  let resultEventId := Twin.callArg call 3
  let nonce ← Prog.effect "subagentTaskNonce" [Twin.callArg call 1]
  if !truthy (field parent "accountId") || !truthy (field parent "agentId") || !truthy nonce then
    return .str "skip"
  let root ← Prog.effect "rootEventId" [field parent "eventId"]
  let outcome ← Prog.effect "resumeConversation" [obj [
    ("accountId", field parent "accountId"), ("agentId", field parent "agentId"),
    ("eventId", .str (text root ++ ":async-subagent:" ++ text nonce)),
    ("publicEventId", .str ("async-subagent-" ++ text nonce)),
    ("conversationKey", field parent "conversationKey"), ("delivery", field parent "delivery"),
    ("message", Twin.callArg call 2),
    ("requestedMode", .str (if undef resultEventId then "steer" else "followup")),
    ("resultEventId", resultEventId), ("target", Twin.callArg call 4)]]
  return if field outcome "kind" == .str "skip" then .str "skip" else field outcome "admission"

private def channelSessionKeyFormat : String :=
  "channel prefix plus platform ids, e.g. tg:<chatId> (negative for groups), slack:<teamId>:<channelId>[:<threadTs>]"

private def prepareSessionMessage (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let account := field o "accountId"
  let agent := field o "agentId"
  let source := field o "sourceConversationKey"
  let input := field o "input"
  let requested := Access.Js.trim (text (field input "conversationKey"))
  if requested == "" || Access.Js.trim (text (field input "message")) == "" then
    return ← Prog.throwError "Error" "Target conversation and message must not be empty"
  let scope ← Prog.effect "parseAccountAgentScopedKey" [.str requested]
  if Access.Js.startsWith requested "acct:" && !truthy scope then
    return ← Prog.throwError "Error" "Target conversation key is invalid"
  if truthy scope && (field scope "accountId" != account || field scope "agentId" != agent) then
    return ← Prog.throwError "Error" "Target conversation must belong to the current agent"
  let key ← if truthy scope then pure (Json.str requested) else
    Prog.effect "accountAgentScopedKey" [account, agent, .str requested]
  if key == source then
    return ← Prog.throwError "Error" "send-message cannot target the current conversation"
  let target ← Prog.effect "getConversationDispatchTarget"
    [obj [("accountId", account), ("agentId", agent), ("conversationKey", key)]]
  let sourceKey ← Prog.effect "publicConversationKeyFromScoped" [source, account, agent]
  if !truthy target then
    return ← Prog.throwError "Error" ("Target conversation is not an existing channel session of this agent: it must be a chat that has messaged this agent before, keyed " ++ channelSessionKeyFormat ++ ". This conversation's key is " ++ text sourceKey ++ ".")
  let uuid ← Prog.effect "crypto.randomUUID"
  let publicEventId := Json.str ("session-message-" ++ text uuid)
  let eventId ← Prog.effect "accountAgentScopedKey" [account, agent, publicEventId]
  let publicKey ← Prog.effect "publicConversationKeyFromScoped" [key, account, agent]
  let loaded ← Prog.effect "loadChannelSessionConfig"
    [obj [("accountId", account), ("agentId", agent), ("target", target)]]
  let runId ← Prog.effect "createRunId"
  return obj [("candidate", obj [("accountId", account), ("agentId", agent),
      ("configRef", field loaded "configRef"), ("eventId", eventId), ("runId", runId),
      ("conversationKey", key),
      ("events", toJson [obj [("role", .str "user"), ("content", .str
        ("[Inter-session message from " ++ text sourceKey ++ "]\n" ++ text (field input "message")))]]),
      ("requestedMode", .str "followup"), ("idempotencyKey", eventId),
      ("delivery", obj [("kind", .str "channel"), ("channel", field target "channelName"),
        ("source", field target "source")])]),
    ("agentConfig", field loaded "agentConfig"), ("publicEventId", publicEventId),
    ("publicConversationKey", publicKey)]

private def dispatchAppliedIngress (call : Json) : Prog Json := do
  let base := Twin.callArg call 0
  let next := Twin.callArg call 1
  let delivery := field next "delivery"
  if undef delivery then
    return ← Prog.throwError "TypeError" "undefined is not an object (evaluating 'delivery.kind')"
  let kind := field delivery "kind"
  let channel := kind == .str "channel"
  let publicEventId := if channel then field next "eventId" else field delivery "publicEventId"
  let publicKey := if channel then field base "publicConversationKey" else field delivery "publicConversationKey"
  let runId ← Prog.effect "createRunId"
  let event := obj (
    [("accountId", field base "accountId"), ("agentId", field base "agentId"), ("runId", runId),
     ("agentConfig", obj []), ("configRef", field next "configRef"),
     ("conversationKey", field base "conversationKey"), ("endpointId", field base "endpointId"),
     ("projectSlug", field base "projectSlug"), ("stageSlug", field base "stageSlug"),
     ("eventId", field next "eventId"), ("publicEventId", publicEventId),
     ("publicConversationKey", publicKey), ("events", field next "events"),
     ("requestedMode", field next "requestedMode"), ("idempotencyKey", field next "eventId"),
     ("ownerGeneration", field next "ownerGeneration")] ++
    (if truthy (field next "ephemeralSystem") then [("ephemeralSystem", field next "ephemeralSystem")] else []) ++
    (if kind == .str "websocket" then [("connectionId", field delivery "connectionId")] else []) ++
    (if channel then [("replyTarget", obj (
      [("channelName", field delivery "channel"),
       ("source", if undef (field delivery "source") || field delivery "source" == .null then obj []
         else field delivery "source")] ++
      if truthy (field delivery "identity") then [("identity", field delivery "identity")] else []))] else []))
  let fail := fun (current : Json) (error : Json) => do
    let _ ← Prog.effect "failOwnedIngress"
      [current, .str (errorMessageOr "Failed to schedule queued ingress" error)]
    (throw error : Prog Json)
  match ← Prog.attempt "loadAppliedIngressConfig" [obj [("accountId", field base "accountId"),
      ("agentId", field base "agentId"), ("configRef", field next "configRef")]] with
  | .pending => Prog.unsupported "config load is unfinished"
  | .threw error _ => fail event error
  | .ok config =>
    let loaded := spread event [("agentConfig", config)]
    if kind == .str "websocket" then
      match ← Prog.attempt "invokeNatsWorker" [loaded] with
      | .threw error _ => fail loaded error
      | _ => return Twin.undefinedJson
    else
      match ← Prog.attempt "createPendingAsyncAgentResult" [obj [("eventId", field next "eventId"),
          ("conversationKey", field base "conversationKey")]] with
      | .threw error _ => fail loaded error
      | _ =>
        match ← Prog.attempt "invokeAsyncWorker" [loaded] with
        | .threw error _ => fail loaded error
        | _ => return Twin.undefinedJson

private def resumeConversation (call : Json) : Prog Json := do
  let o := Twin.callArg call 0
  let account := field o "accountId"
  let agent := field o "agentId"
  let key := field o "conversationKey"
  let delivery := field o "delivery"
  let given := field o "target"
  let target ← if undef given || given == .null then
      Prog.effect "loadReentryTarget" [account, agent, key]
    else pure given
  if !truthy target then return obj [("kind", .str "skip")]
  let publicKey ← Prog.effect "eventPublicConversationKey" [key, account, agent]
  let runId ← Prog.effect "createRunId"
  let event := obj (
    [("accountId", account), ("agentId", agent), ("runId", runId),
     ("agentConfig", field target "agentConfig"), ("configRef", field target "configRef"),
     ("endpointId", field target "endpointId"), ("projectSlug", field target "projectSlug"),
     ("stageSlug", field target "stageSlug"), ("eventId", field o "eventId")] ++
    (if truthy (field o "asyncResultEventId") then [("asyncResultEventId", field o "asyncResultEventId")] else []) ++
    (if truthy (field o "publicDeploymentIngress") then
      [("publicDeploymentIngress", field o "publicDeploymentIngress")] else []) ++
    (if field delivery "kind" == .str "channel" then [("replyTarget", obj (
      [("channelName", field delivery "channelName"), ("source", field delivery "source")] ++
      if truthy (field delivery "identity") then [("identity", field delivery "identity")] else []))] else []) ++
    [("publicEventId", field o "publicEventId"), ("conversationKey", key),
     ("publicConversationKey", publicKey), ("events", toJson [field o "message"]),
     ("requestedMode", field o "requestedMode"), ("idempotencyKey", field o "eventId")])
  let socket ← Prog.effect "onSocket" [event, delivery]
  let routed ← Prog.effect "continuationDelivery" [socket]
  let fence := obj (
    (if truthy (field o "resultEventId") then [("resultEventId", field o "resultEventId")] else []) ++
    (if truthy (field o "toolResultId") then [("toolResultId", field o "toolResultId")] else []))
  let admitted ← Prog.effect "admitInternalContinuation" [event, routed, fence]
  let outcome := field (field admitted "admission") "outcome"
  let ready := fun (invoked : Bool) => obj [("kind", .str "ready"), ("admission", outcome),
    ("invoked", .bool invoked), ("publicEventId", field o "publicEventId")]
  let owned := field admitted "owned"
  if !truthy owned then return ready false
  let _ ← Prog.effect "createPendingAsyncAgentResult" [obj [("eventId", field owned "eventId"),
    ("conversationKey", field owned "conversationKey")]]
  let _ ← Prog.effect "invokeContinuationWorker" [owned, delivery]
  return ready true

private def handleSandboxJobCompletionRequest (call : Json) : Prog Json := do
  let event := Twin.callArg call 0
  let notFound := Prog.effect "errorResponse" [toJson (404 : Nat), .str "Background job result not found",
    obj [("code", .str "job_result_not_found")]]
  let alreadySettled := Prog.effect "errorResponse" [toJson (409 : Nat),
    .str "Background job result is already settled", obj [("code", .str "job_result_settled")]]
  let existing ← Prog.effect "getAsyncToolResult" [field event "resultId"]
  if !truthy existing then return ← notFound
  if field existing "status" != .str "processing" then return ← alreadySettled
  let verified ← Prog.effect "verifyAsyncToolCompletionToken" [field event "resultId", field event "token"]
  if !truthy verified then return ← notFound
  let secrets ← Prog.effect "asyncToolRowSecretValues" [existing]
  let settled ← Prog.effect "settleAsyncToolResultFromCallback" [obj (
    [("resultId", field event "resultId"), ("status", field event "status"), ("secretValues", secrets)] ++
    (if undef (field event "response") then [] else [("response", field event "response")]) ++
    (if truthy (field event "error") then [("error", field event "error")] else []))]
  if !truthy settled then return ← alreadySettled
  let outcome ← Prog.effect "continueAfterAsyncToolSettlement" [settled]
  Prog.effect "continuationResponse" [settled, outcome]

private def handleCronHttpRequest (call : Json) : Prog Json := do
  let request := Twin.callArg call 0
  if field request "method" != .str "POST" then
    return ← Prog.effect "methodNotAllowed" [toJson ["POST"]]
  let headers := field request "headers"
  let token ← Prog.effect "extractBearerToken" [field headers "authorization"]
  let authorized ← if truthy token then Prog.effect "isServiceToken" [headers, token] else pure (.bool false)
  if !truthy authorized then
    return ← Prog.effect "errorResponse" [toJson (401 : Nat), .str "Unauthorized"]
  match ← Prog.attempt "parseJsonBody" [request] with
  | .pending => Prog.unsupported "body parse is unfinished"
  | .threw error _ =>
    Prog.effect "errorResponse" [toJson (400 : Nat), .str (errorMessageOr "Invalid request JSON" error)]
  | .ok payload =>
    let valid ← Prog.effect "isCronInvocation" [payload]
    if !truthy valid then
      return ← Prog.effect "errorResponse" [toJson (400 : Nat), .str "Invalid cron invocation"]
    let refusal ← Prog.effect "handleScheduledCron" [payload]
    if truthy refusal then return ← Prog.effect "planRefusalResponse" [refusal]
    return obj [("$response", obj [("status", toJson (204 : Nat)), ("headers", toJson ([] : List Json))])]

private def startScheduledAgentRun (call : Json) : Prog Json := do
  let job := Twin.callArg call 0
  let firedAt := Twin.callArg call 1
  let opened ← match ← Prog.attempt "openCronRun" [job, firedAt] with
    | .ok value => pure value
    | .pending => Prog.unsupported "openCronRun is unfinished"
    | .threw error _ => do
      let _ ← Prog.effect "getStorage"
      let some message := (field (field error "$error") "message").getStr?.toOption
        | Prog.unsupported "a thrown non-Error"
      let _ ← Prog.effect "getStorage().crons.markFailed"
        [field job "accountId", field job "cronId", .str message, firedAt]
      throw error
  let event := field opened "event"
  let run := field opened "run"
  let oneShot ← Prog.effect "isOneTimeSchedule" [field job "scheduleExpression"]
  let event := spread event [("cronRun", obj ([("cronId", field job "cronId"), ("runId", field run "runId")] ++
    if truthy oneShot then [("oneShot", .bool true)] else []))]
  let failRun := fun (error : Json) => do
    let _ ← Prog.effect "getStorage"
    let _ ← Prog.effect "getStorage().crons.failRun" [field job "accountId", field job "cronId",
      field run "runId", .str (errorMessageOr "Failed to start cron async worker" error)]
    (throw error : Prog Json)
  let delivery ← Prog.effect "continuationDelivery" [event]
  match ← Prog.attempt "admitInternalContinuation" [event, delivery] with
  | .pending => Prog.unsupported "admission is unfinished"
  | .threw error _ => failRun error
  | .ok admitted =>
    let owned := field admitted "owned"
    if !truthy owned then
      return ← failRun (Prog.errorJson "Error" "Cron conversation is already processing another turn")
    match ← Prog.attempt "createPendingAsyncAgentResult" [obj [("eventId", field owned "eventId"),
        ("conversationKey", field owned "conversationKey")]] with
    | .threw error _ => failRun error
    | _ =>
      match ← Prog.attempt "invokeAsyncWorker" [owned] with
      | .threw error _ => failRun error
      | _ => return obj [("eventId", field event "publicEventId"),
          ("conversationKey", field event "publicConversationKey")]

private def traced (file name : String) (run : Json → Prog Json) : Twin :=
  Twin.traced ("apps/core/src/" ++ file ++ ".ts#" ++ name) run
private def plain (file name : String) (run : Json → Json) : Twin :=
  { source := "apps/core/src/" ++ file ++ ".ts#" ++ name, run := run }

def twins : List Twin := [
  traced "harness/handler" "dispatchAppliedIngress" dispatchAppliedIngress,
  traced "harness/handler" "resumeConversation" resumeConversation,
  traced "harness/handler" "handleSandboxJobCompletionRequest" handleSandboxJobCompletionRequest,
  traced "harness/handler" "handleCronHttpRequest" handleCronHttpRequest,
  traced "harness/handler" "startScheduledAgentRun" startScheduledAgentRun,
  traced "harness/handler" "failOwnedIngress" failOwnedIngress,
  traced "harness/handler" "admitInternalContinuation" admitInternalContinuation,
  traced "harness/handler" "dispatchNextIngress" dispatchNextIngress,
  traced "harness/handler" "dispatchRecoveredIngress" dispatchRecoveredIngress,
  traced "harness/handler" "invokeHarnessWorker" invokeHarnessWorker,
  traced "harness/handler" "startOwnedAsyncRun" startOwnedAsyncRun,
  traced "harness/handler" "asyncToolRowSecretValues" asyncToolRowSecretValues,
  traced "harness/handler" "continueAfterAsyncToolSettlement" continueAfterAsyncToolSettlement,
  traced "harness/handler" "resumeAfterSubagentResult" resumeAfterSubagentResult,
  traced "harness/handler" "invokeAsyncWorker" (fun c => do
    let _ ← Prog.effect "invokeHarnessWorker"
      [obj [("kind", .str "direct-api-async-worker"), ("event", Twin.callArg c 0)]]
    return Twin.undefinedJson),
  traced "harness/connections" "refreshAndSave" refreshAndSave,
  traced "harness/ingress" "prepareSessionMessage" prepareSessionMessage,
  traced "harness/handler" "removeOneShotCron" removeOneShotCron,
  traced "harness/handler" "settleCronRun" settleCronRun,
  traced "harness/handler" "pushReplyToChannel" pushReplyToChannel,
  traced "harness/handler" "handleStatusRequest" handleStatusRequest,
  traced "harness/handler" "resolveReentryTarget" resolveReentryTarget,
  traced "harness/handler" "loadReentryTarget" loadReentryTarget,
  traced "harness/handler" "directSession" directSession,
  traced "harness/handler" "settleFailedIngressAndDrain" settleFailedIngressAndDrain,
  traced "harness/handler" "settleChannelQuestion" settleChannelQuestion,
  traced "harness/handler" "createCronDirectEvent" createCronDirectEvent,
  traced "harness/handler" "openCronRun" openCronRun,
  traced "harness/handler" "settleAsyncRun" settleAsyncRun,
  traced "harness/handler" "queueFullResponse" queueFullResponse,
  traced "shared/nats" "streamResponseSubject" streamResponseSubject,
  traced "shared/nats" "logsSubjectWildcard" (wildcardSubject "logs"),
  traced "shared/nats" "tracesSubjectWildcard" (wildcardSubject "traces"),
  traced "shared/nats" "readConversationStream" readConversationStream,
  traced "shared/nats" "readObservabilityStream" readObservabilityStream,
  traced "shared/nats" "conversationReplaySnapshot" conversationReplaySnapshot,
  traced "shared/convex/client" "adminQuery" (fun c => adminCall "query" c []),
  traced "shared/convex/client" "adminMutation" (fun c => adminCall "mutation" c [Twin.callArg c 2]),
  traced "harness/worker-queue" "renewQueuedLease" renewQueuedLease,
  traced "harness/worker-queue" "withQueuePlace" withQueuePlace,
  traced "harness/responses" "errorSseResponse" errorSseResponse,
  traced "harness/responses" "continuationResponse" continuationResponse,
  traced "harness/responses" "acceptedAsyncResponse" acceptedAsyncResponse,
  traced "harness/questions" "openQuestion" openQuestion,
  traced "harness/questions" "listOpenQuestions" listOpenQuestions,
  traced "harness/ingress" "takeNextIngress" takeNextIngress,
  traced "harness/ingress" "releaseIngressOwner" releaseIngressOwner,
  traced "harness/ingress" "loadChannelSessionConfig" loadChannelSessionConfig,
  traced "harness/ingress" "loadAppliedIngressConfig" loadAppliedIngressConfig,
  traced "harness/async-tools" "resumeLostAsyncToolResults" resumeLostAsyncToolResults,
  traced "shared/convex/account-keys" "cipherFromKeys" cipherFromKeys,
  traced "shared/convex/account-keys" "decryptAccountBlob" decryptAccountBlob,
  traced "harness/handler" "formatChannelFinalText" formatChannelFinalText,
  plain "harness/async-tools" "formatUnknown" (fun a =>
    let v := Twin.arg a 0
    match v with | .str s => .str s | _ => .str v.compress),
  plain "harness/handler" "channelReplyText" channelReplyText,
  traced "harness/handler" "scheduledFireTime" scheduledFireTime,

  plain "harness/apply-runs" "applyScripts" applyScripts,
  traced "harness/ingress" "sha256Hex" sha256Hex,
  traced "harness/apply-runs" "fileWrites" fileWrites,
  traced "harness/apply-runs" "runScripts" runScripts,
  traced "harness/continuation" "turnSettlement" turnSettlement,
  traced "harness/handler" "continuationDelivery" continuationDelivery,
  traced "harness/handler" "recordAsyncRun" recordAsyncRun,
  traced "harness/async-tools" "completionToParentMessage" completionToParentMessage,
  traced "harness/continuation" "runParentPasses" Agent.Continuation.runParentPasses,
  traced "harness/continuation" "runParentContinuationLoop" runParentContinuationLoop,
  traced "harness/async-agent-result" "recordAsyncAgentResult" recordAsyncAgentResult,
  traced "harness/async-agent-result" "createPendingAsyncAgentResult" (fun c =>
    Prog.effect "runtime.mutate" [.str "createAsyncAgentResult", Twin.callArg c 0]),
  traced "harness/async-agent-result" "getAsyncAgentResult" (fun c =>
    Prog.effect "runtime.query" [.str "getAsyncAgentResult", obj [("eventId", Twin.callArg c 0)]]),
  traced "harness/async-agent-result" "listOwedAsyncAgentResults" (queryOptions "listOwedAsyncAgentResults"),
  traced "harness/handler" "claimSession" (fun _ => do
    let claimed ← Prog.effect "session.claim"
    return toJson (truthy claimed)),
  traced "harness/async-tool-result" "asyncToolContinuationEventId" (fun c => do
    let row := Twin.callArg c 0
    let root ← Prog.effect "rootEventId" [field row "parentEventId"]
    return .str (text root ++ ":async-tools:" ++ text (field row "resultId"))),
  traced "harness/handler" "eventPublicConversationKey" (fun c =>
    Prog.effect "publicConversationKeyFromScoped" [Twin.callArg c 0, Twin.callArg c 1, Twin.callArg c 2]),

  traced "harness/async-tools" "resumeLostAsyncToolResult" resumeLostAsyncToolResult,
  traced "harness/questions" "openWorkAfterRun" openWorkAfterRun,
  plain "harness/questions" "answersFromText" answersFromText,
  plain "harness/questions" "formatQuestionsText" formatQuestionsText,
  plain "harness/ingress" "outcomeSettlement" outcomeSettlement,
  plain "shared/nats" "consumerStartPolicy" consumerStartPolicy,
  plain "harness/questions" "answersFromChoice" answersFromChoice,
  plain "harness/run-finalizer" "rootSpanStatus" rootSpanStatus,
  traced "harness/responses" "directStatusUrl" directStatusUrl,
  traced "harness/ingress" "recoverQueuedIngress" recoverQueuedIngress,
  traced "shared/convex/client" "createConvexClient" createConvexClient,
  traced "harness/async-agent-result" "markAsyncAgentHandback" markAsyncAgentHandback,
  plain "harness/handler" "commandText" commandText,
  plain "harness/handler" "onSocket" onSocket,
  plain "harness/handler" "parseAccountAgentFromScopedKey" parseAccountAgent,
  traced "harness/continuation" "resumeAfterYield" resumeAfterYield,
  traced "harness/async-tool-result" "createDetachedAsyncToolResult" createDetachedAsyncToolResult,
  plain "harness/async-tool-result" "askingEventId" askingEventId,
  plain "harness/async-tool-result" "rootEventId" rootEventId,
  traced "harness/async-tool-result" "settleAsyncToolResultFromCallback" settleAsyncToolResultFromCallback,
  plain "harness/handler" "isAsyncWorkerInvocation" (invocation "direct-api-async-worker"),
  plain "harness/handler" "isNatsWorkerInvocation" (invocation "nats-worker"),
  plain "harness/handler" "isCronInvocation" (invocation "cron"),
  plain "harness/handler" "hasRunnableDirectEvents" (fun a => toJson ((items (field (Twin.arg a 0) "events")).any runnable)),
  plain "harness/handler" "asyncResultEventIds" asyncResultEventIds,
  traced "harness/ingress" "getConversationDispatchTarget" (queryOptions "getConversationTarget"),
  traced "harness/ingress" "getIngressStatus" (queryOptions "getIngressStatus"),
  traced "harness/ingress" "getIngressStatusByEventId" (queryOptions "getIngressStatusByEventId"),
  traced "harness/ingress" "renewIngressOwner" renewIngressOwner,
  traced "harness/ingress" "settleIngress" (fun c => Prog.effect "runtime.mutate" [.str "settleIngress", Twin.callArg c 0]),
  plain "shared/nats" "subjectToken" (fun a => .str (Access.Crypto.base64UrlEncode (text (Twin.arg a 0)).toUTF8.toList)),
  plain "harness/continuation" "isRunnableModelInput" (fun a => toJson (runnable (Twin.arg a 0))),
  traced "harness/connections" "expiresSoon" expiresSoon,
  traced "harness/async-tool-result" "getAsyncToolResult" (queryId "getAsyncToolResult"),
  traced "harness/async-tool-result" "markAsyncToolResultFailed" markAsyncToolResultFailed,
  traced "harness/async-tool-result" "listOwedAsyncToolResults" (queryOptions "listOwedAsyncToolResults"),
  traced "harness/async-tool-result" "verifyAsyncToolCompletionToken" (fun c =>
    Prog.effect "runtime.query" [.str "getAsyncToolToken", obj
      [("resultId", Twin.callArg c 0), ("completionToken", Twin.callArg c 1)]])
]
end Spec.Runs.Waveruns1
