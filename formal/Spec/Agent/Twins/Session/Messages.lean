import Spec.Agent.Twins.Loop.Provider
import Spec.Agent.Twins.Session.Prompts

/-!
Twins of how `session.ts`, `pruning.ts` and `compaction.ts` store, project and prune conversation
messages.
-/

namespace Spec.Agent

open Lean Js

private def isRole (message : Json) (role : String) : Bool :=
  get message "role" == .str role

private def isType (part : Json) (kind : String) : Bool :=
  get part "type" == .str kind

/-- `truncateText`: by UTF-8 bytes, with a cut character decoded as U+FFFD. -/
def truncateByBytes (value : String) (limit : Nat) : Option String :=
  if value.toUTF8.size ≤ limit then none
  else
    let step (state : List Char × Nat × Bool) (c : Char) : List Char × Nat × Bool :=
      if state.snd.snd then state
      else
        let size := (c.toString.toUTF8.size)
        if size ≤ state.snd.fst then (c :: state.fst, state.snd.fst - size, false)
        else ((if state.snd.fst > 0 then Char.ofNat 0xFFFD :: state.fst else state.fst), 0, true)
    let kept := (value.toList.foldl step ([], limit, false)).fst.reverse
    some (String.ofList kept ++ "\n[output truncated]")

/-- `isStorableMediaReference`, where a recorded `URL` arrives as its string. -/
def isStorableMediaReference (value : Json) : Bool :=
  let isRemote (text : String) : Bool :=
    let lower := text.toLower
    startsWith lower "http://" || startsWith lower "https://" || startsWith text "broods-media:"
  match value with
  | .str text => isRemote text
  | .obj _ =>
    isType value "url" &&
      match get value "url" with
      | .str text => isRemote text
      | _ => false
  | _ => false

private def attachmentNotRetained : Json :=
  Json.mkObj [("type", "text"), ("text", "[attachment not retained]")]

/-- `storableToolResultOutput`, or none when a cut JSON text depends on lost key order. -/
def storableToolResultOutput (output : Json) (limit : Nat) : Option Json :=
  if isType output "execution-denied" then some output
  else
    let stored :=
      if !isType output "content" then output
      else
        let kept := (items (get output "value")).filter fun part =>
          if isType part "file-data" || isType part "image-data" then false
          else if isType part "file" then
            if isType (get part "data") "url" then isStorableMediaReference (get part "data")
            else !isType (get part "data") "data"
          else if isType part "file-url" || isType part "image-url" then
            isStorableMediaReference (get part "url")
          else true
        spread output [("value", .arr (if kept.isEmpty then #[attachmentNotRetained] else kept.toArray))]
    let value := get stored "value"
    let text :=
      match value with
      | .str plain => plain
      | other => if has stored "value" then stringify 64 other else ""
    match truncateByBytes text limit with
    | none => some stored
    | some cut =>
      if !(str? value).isSome && orderLost 64 value then none
      else
        some (Json.mkObj [
          ("type", if isType output "error-text" || isType output "error-json"
            then "error-text" else "text"),
          ("value", toJson cut)])

/-- `sanitizeToolMessage`, or none when an output's text depends on lost key order. -/
def sanitizeToolMessage (message : Json) : Option Json := do
  let parts := (items (get message "content")).filter fun part =>
    isType part "tool-approval-response" || isType part "tool-result"
  let results := (parts.filter fun part => isType part "tool-result").length
  let limit := (768 * 1024) / max results 1
  let content ← parts.mapM fun part =>
    if isType part "tool-result" then
      (storableToolResultOutput (get part "output") limit).map fun output =>
        spread part [("output", output)]
    else some part
  return (if content.isEmpty then .null else spread message [("content", .arr content.toArray)])

/-- `sanitizeUserMessage`. -/
def sanitizeUserMessage (message : Json) : Json :=
  match get message "content" with
  | .str _ => message
  | other =>
    let parts := items other
    let kept := parts.filter fun part =>
      isType part "text" ||
        (isType part "image" && isStorableMediaReference (get part "image")) ||
        (isType part "file" && isStorableMediaReference (get part "data"))
    if !kept.isEmpty then spread message [("content", .arr kept.toArray)]
    else if !parts.isEmpty then spread message [("content", .arr #[attachmentNotRetained])]
    else .null

private def persistedAssistantPart (part : Json) : Bool :=
  ["reasoning", "text", "tool-call", "tool-approval-request", "tool-result"].any (isType part)

/-- `sanitizeAssistantMessage`. -/
def sanitizeAssistantMessage (message : Json) (retainsReasoning : Bool) : Json :=
  match get message "content" with
  | .str _ => message
  | other =>
    let kept := (items other).filter fun part =>
      persistedAssistantPart part && (retainsReasoning || !isType part "reasoning")
    if kept.isEmpty then .null else spread message [("content", .arr kept.toArray)]

/-- `toStoredConversationEvent`. -/
def toStoredConversationEvent (message sourceEventId metadata model : Json) : Json :=
  if !truthy message then .null
  else
    Json.mkObj ([("version", nat 1), ("sourceEventId", sourceEventId)] ++
      (if metadata != .null then [("metadata", metadata)] else []) ++
      (if model != .null then [("model", model)] else []) ++
      [("message", message)])

/-- `systemModelMessageSchema.parse`, which drops keys it does not name; none when it throws. -/
def parseSystemMessage (message : Json) : Option Json :=
  match get message "role", get message "content" with
  | .str "system", .str content =>
    some (Json.mkObj ([("role", .str "system"), ("content", .str content)] ++
      copied message "providerOptions"))
  | _, _ => none

/-- `createStoredEventFromModelMessage`, or none past what the arguments decide. -/
def createStoredEvent (message sourceEventId producer : Json) : Option Json :=
  if !truthy message then some .null
  else if isRole message "user" then
    some (toStoredConversationEvent
      (sanitizeUserMessage (without message ["metadata", "dedupeKey"])) sourceEventId
      (get message "metadata") .null)
  else if isRole message "assistant" then
    some (toStoredConversationEvent
      (sanitizeAssistantMessage message (get producer "retainsReasoning" == .bool true))
      sourceEventId .null (get producer "model"))
  else if isRole message "tool" then
    (sanitizeToolMessage message).map fun sanitized =>
      toStoredConversationEvent sanitized sourceEventId .null .null
  else if isRole message "system" then
    (parseSystemMessage message).map fun parsed =>
      toStoredConversationEvent parsed sourceEventId .null .null
  else some .null

/-- `withoutStoredItems`. -/
def withoutStoredItems (message : Json) : Json :=
  match get message "content" with
  | .str _ => message
  | other =>
    spread message [("content", .arr
      (((items other).filter fun part => !isType part "reasoning").map withoutStoredItemId).toArray)]

/-- `isToolApprovalResponseMessage`, also `hasPendingToolApprovalResponse`'s last-message test. -/
def isToolApprovalResponse (message : Json) : Bool :=
  isRole message "tool" && !(items (get message "content")).isEmpty &&
    (items (get message "content")).all fun part => isType part "tool-approval-response"

/-- `withoutUnresolvedToolCalls`: an unanswered tool call leaves the prompt with its stored items. -/
def withoutUnresolvedToolCalls (messages : List Json) : List Json :=
  let pendingApprovals :=
    match messages.getLast? with
    | some last =>
      if isToolApprovalResponse last then
        ((items (get last "content")).filter fun part => isType part "tool-approval-response").map
          fun part => get part "approvalId"
      else []
    | none => []
  let resolved := messages.flatMap fun message =>
    ((items (get message "content")).filter fun part =>
      isType part "tool-result" ||
        (isType part "tool-approval-request" && pendingApprovals.contains (get part "approvalId"))).map
      fun part => get part "toolCallId"
  messages.flatMap fun message =>
    if !isRole message "assistant" || !isArr (get message "content") then [message]
    else
      let parts := items (get message "content")
      let kept := parts.filter fun part =>
        (!isType part "tool-call" && !isType part "tool-approval-request") ||
          (isType part "tool-call" && get part "providerExecuted" == .bool true) ||
          resolved.contains (get part "toolCallId")
      if kept.length == parts.length then [message]
      else
        let repaired := withoutStoredItems (spread message [("content", .arr kept.toArray)])
        if (items (get repaired "content")).isEmpty then [] else [repaired]

/-- `projectEntriesToMessages`, with the throw on an unknown role as the error. -/
def projectEntriesToMessages (entries : List Json) (model : Json) : Except String (List Json) := do
  let projected ← entries.mapM fun entry =>
    let event := get entry "event"
    let message := get event "message"
    if isRole message "system" then .ok []
    else if isRole message "user" then
      .ok [spread message (copied event "metadata" ++ copied entry "createdAt")]
    else if isRole message "assistant" then
      .ok [if get event "model" == model then message else withoutStoredItems message]
    else if isRole message "tool" then .ok [message]
    else .error s!"Unsupported conversation message role: {template (get message "role")}"
  return withoutUnresolvedToolCalls projected.flatten

/-- `stripEnvelopeFieldsFromMessages`. -/
def stripEnvelopeFields (messages : List Json) : List Json :=
  messages.map fun message => without message ["metadata", "createdAt", "dedupeKey"]

/-- `storedEventBatches`: at most 8 MiB and 8000 events each, an oversized event alone. Byte counts
do not depend on key order. -/
def storedEventBatches (events : List Json) : List (List Json) :=
  let limit := 8 * 1024 * 1024
  let step (state : List (List Json) × List Json × Nat) (entry : Json) :
      List (List Json) × List Json × Nat :=
    let size := (stringify 64 entry).toUTF8.size
    let batch := state.snd.fst
    let bytes := state.snd.snd
    if !batch.isEmpty && (bytes + size > limit || batch.length ≥ 8000) then
      (batch.reverse :: state.fst, [entry], size)
    else (state.fst, entry :: batch, bytes + size)
  let final := events.foldl step ([], [], 0)
  (if final.snd.fst.isEmpty then final.fst else final.snd.fst.reverse :: final.fst).reverse

/-- `isCompactionSummaryMessage`. -/
def isCompactionSummary (message : Json) : Bool :=
  match get message "content" with
  | .str content => startsWith content "<session-compaction-summary>"
  | _ => false

/-- `findLatestCompactionSummaryIndex`. -/
def latestCompactionIndex (entries : List Json) : Option Nat :=
  lastIndexWhere (fun entry =>
    let message := get (get entry "event") "message"
    isRole message "system" && isCompactionSummary message) entries

/-- `appendToLatestUserEvent`. -/
def appendToLatestUserEvent (events parts : List Json) : List Json :=
  match lastIndexWhere (fun event => isRole event "user") events with
  | none => events ++ [Json.mkObj [("role", "user"), ("content", .arr parts.toArray)]]
  | some index =>
    let event := events.getD index .null
    let existing :=
      match get event "content" with
      | .str text => [Json.mkObj [("type", "text"), ("text", .str text)]]
      | other => items other
    let kept := existing.filter fun part =>
      !isType part "text" || !(((str? (get part "text")).getD "").isEmpty)
    events.set index (spread event [("content", .arr (kept ++ parts).toArray)])

/-- `projectSystemContextMessages`. -/
def projectSystemContextMessages (entries : List Json) : List Json :=
  let latest := latestCompactionIndex entries
  entries.zipIdx.flatMap fun pair =>
    let message := get (get pair.fst "event") "message"
    if !isRole message "system" then []
    else if isCompactionSummary message then
      if latest == some pair.snd then [message] else []
    else
      match latest with
      | none => [message]
      | some at_ => if pair.snd > at_ then [message] else []

/-- `withUnwrittenRows`: rows read back win, and the rest merge in by cursor. -/
def withUnwrittenRows (entries unwritten : List Json) : List Json :=
  let read := entries.map fun entry => get entry "createdAt"
  let missing := unwritten.filter fun row => !read.contains (get row "cursor")
  if missing.isEmpty then entries
  else
    let added := missing.map fun row =>
      Json.mkObj ([("createdAt", get row "cursor")] ++ copied row "event")
    let text (entry : Json) : String := (str? (get entry "createdAt")).getD ""
    (entries ++ added).mergeSort fun left right => compare (text left) (text right) != .gt

/-- `retainsReasoningParts`. -/
def retainsReasoningParts (agentConfig : Json) : Bool :=
  match get (get agentConfig "model") "provider" with
  | .str "openai" => true
  | .str "azure" => true
  | _ => false

private def isReasoning (part : Json) : Bool :=
  isType part "reasoning" || isType part "reasoning-file"

/-- The AI SDK's `pruneMessages` with `reasoning: "all"`: an assistant's reasoning goes. -/
def stripReasoningParts (messages : List Json) : List Json :=
  messages.map fun message =>
    if !isRole message "assistant" || !isArr (get message "content") then message
    else spread message [("content", .arr
      ((items (get message "content")).filter fun part => !isReasoning part).toArray)]

/-- The AI SDK's rule that reasoning goes when no part after it, up to the next reasoning, stays. -/
private def dropOrphanReasoning : Nat → List (Json × Bool) → List (Json × Bool)
  | 0, rest => rest
  | fuel + 1, rest =>
    match rest with
    | [] => []
    | head :: tail =>
      if !isReasoning head.fst then head :: dropOrphanReasoning fuel tail
      else
        let reasoning := rest.takeWhile fun pair => isReasoning pair.fst
        let after := rest.dropWhile fun pair => isReasoning pair.fst
        let following := after.takeWhile fun pair => !isReasoning pair.fst
        let later := after.dropWhile fun pair => !isReasoning pair.fst
        let orphaned := !following.isEmpty && !following.any Prod.snd
        (reasoning.map fun pair => (pair.fst, pair.snd && !orphaned)) ++ following ++
          dropOrphanReasoning fuel later

private def isCallOrResult (part : Json) : Bool :=
  isType part "tool-call" || isType part "tool-result"

private def isApproval (part : Json) : Bool :=
  isType part "tool-approval-request" || isType part "tool-approval-response"

/-- The AI SDK's `pruneMessages` with `toolCalls: "before-last-N-messages"`, for N above zero. -/
def pruneToolCalls (keep : Nat) (messages : List Json) : List Json :=
  let isToolMessage (message : Json) : Bool :=
    (isRole message "assistant" || isRole message "tool") && isArr (get message "content")
  let recent := (messages.drop (messages.length - keep)).filter isToolMessage
  let recentParts := recent.flatMap fun message => items (get message "content")
  let keptApprovals := (recentParts.filter isApproval).map fun part => get part "approvalId"
  let requests := (messages.filter isToolMessage).flatMap fun message =>
    (items (get message "content")).filter fun part => isType part "tool-approval-request"
  let approvedCalls := keptApprovals.filterMap fun approval =>
    (requests.reverse.find? fun part => get part "approvalId" == approval).map
      fun part => get part "toolCallId"
  let keptCalls := ((recentParts.filter isCallOrResult).map fun part => get part "toolCallId") ++
    approvedCalls
  messages.zipIdx.map fun pair =>
    let message := pair.fst
    if !isToolMessage message || pair.snd + keep ≥ messages.length then message
    else
      let parts := items (get message "content")
      let flagged := parts.map fun part =>
        let keptPart :=
          if !isCallOrResult part && !isApproval part then true
          else if isCallOrResult part then keptCalls.contains (get part "toolCallId")
          else keptApprovals.contains (get part "approvalId")
        (part, keptPart)
      let final :=
        if isRole message "assistant" then dropOrphanReasoning (parts.length + 1) flagged
        else flagged
      spread message [("content", .arr ((final.filter Prod.snd).map Prod.fst).toArray)]

/-- The AI SDK's `emptyMessages: "remove"`. -/
def removeEmptyMessages (messages : List Json) : List Json :=
  messages.filter fun message =>
    match get message "content" with
    | .str text => length text > 0
    | other => !(items other).isEmpty

/-- `toolImage`: an image the prompt can carry instead of a pruned tool result. -/
def toolImage (item : Json) : List Json :=
  let image (data : Json) : List Json :=
    [Json.mkObj ([("type", .str "image"), ("image", data)] ++ copied item "mediaType")]
  let imageType := startsWith ((str? (get item "mediaType")).getD "") "image"
  if isType item "image-data" then image (get item "data")
  else if isType item "file-data" then if imageType then image (get item "data") else []
  else if isType item "file" && imageType && isType (get item "data") "data" then
    image (get (get item "data") "data")
  else []

private def toolContentItems (message : Json) : List Json :=
  (items (get message "content")).flatMap fun part =>
    if isType part "tool-result" && isType (get part "output") "content" then
      items (get (get part "output") "value")
    else []

/-- `withToolImagesKept`: images in results about to be pruned follow as a user message. -/
def withToolImagesKept (messages : List Json) (prunedBefore : Int) : List Json :=
  let before (index : Nat) : Bool := (index : Int) < prunedBefore
  let carries := messages.zipIdx.any fun pair =>
    before pair.snd && isRole pair.fst "tool" &&
      (toolContentItems pair.fst).any fun item => !(toolImage item).isEmpty
  if !carries then messages
  else
    messages.zipIdx.flatMap fun pair =>
      if !isRole pair.fst "tool" || !before pair.snd then [pair.fst]
      else
        let images := (toolContentItems pair.fst).flatMap toolImage
        if images.isEmpty then [pair.fst]
        else [pair.fst, Json.mkObj [("role", "user"), ("content", .arr
          ((Json.mkObj [("type", "text"), ("text", "Images a tool returned earlier:")]) ::
            images).toArray)]]

/-- `pruneSessionMessages`. -/
def pruneSessionMessages (messages : List Json) (agentConfig : Json) : List Json :=
  let approvalResume :=
    match messages.getLast? with
    | some last => isToolApprovalResponse last
    | none => false
  let retains := retainsReasoningParts agentConfig
  let model :=
    if approvalResume || retains then messages
    else removeEmptyMessages (stripReasoningParts messages)
  let kept := if approvalResume then 2 else 1
  if get (get (get agentConfig "session") "pruning") "enabled" == .bool false then model
  else if retains then removeEmptyMessages model
  else
    removeEmptyMessages
      (pruneToolCalls kept (withToolImagesKept model ((model.length : Int) - (kept : Int))))

/-- `missingHarnessRole`, composing the entry projection and pruning. -/
def missingHarnessRole (entries : List Json) (agentConfig : Json) : Except String Json := do
  let active :=
    match latestCompactionIndex entries with
    | some index => entries.drop (index + 1)
    | none => entries
  let model := get agentConfig "model"
  let identity :=
    if has model "provider" && has model "modelId" then
      toJson (template (get model "provider") ++ "/" ++ template (get model "modelId"))
    else .null
  let projected ← projectEntriesToMessages active identity
  let messages := pruneSessionMessages projected agentConfig
  if !messages.dropLast.any fun message => isRole message "assistant" then return .str "assistant"
  return if messages.any fun message => isRole message "user" then .null else .str "user"

end Spec.Agent
