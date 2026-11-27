import Spec.Channels.Twins.Wavechannels1.Base

namespace Spec.Channels.Wavechannels1.GitHub

open Lean Spec Spec.Channels.Wavechannels1.Base

private def source (name : String) : String :=
  "apps/core/src/shared/github-channel.ts#" ++ name

private def apiVersion : String := "2022-11-28"
private def maxContextComments : Nat := 50
/-- `FETCH_TIMEOUT_MS`, `apps/core/src/harness/isolate/runner/pinned-fetch.mjs:9`. -/
private def fetchTimeoutMs : Nat := 30000

private def present (fields : List (String × Json)) : List (String × Json) :=
  fields.filter (!missing ·.2)

private def ignored : Json := Json.mkObj [("kind", .str "ignore")]

private def ack : Json := Json.mkObj [("statusCode", num 200)]

/-- A number as template-literal text. -/
private def show' (value : Json) : String :=
  match value with
  | .str s => s
  | other => other.compress

private def textContent (value : Json) : Json :=
  jarr [Json.mkObj [("type", .str "text"), ("text", value)]]

private def statusOf (response : Json) : Int :=
  (asNum (get (get response "$response") "status")).mantissa

private def isOk (response : Json) : Bool :=
  let status := statusOf response
  200 ≤ status && status ≤ 299

private def createAppJwt (call : Json) : Prog Json := do
  let now ← Prog.effect "Date.now"
  let seconds := (asNum now).mantissa / 1000
  let header ← Prog.effect "base64UrlEncode" [.str "{\"alg\":\"RS256\",\"typ\":\"JWT\"}"]
  let claims := "{\"iat\":" ++ toString (seconds - 60) ++ ",\"exp\":" ++ toString (seconds + 540) ++
    ",\"iss\":" ++ (Twin.callArg call 0).compress ++ "}"
  let payload ← Prog.effect "base64UrlEncode" [.str claims]
  let unsigned := text header ++ "." ++ text payload
  let _ ← Prog.effect "createSign" [.str "RSA-SHA256"]
  let _ ← Prog.effect "createSign(\"RSA-SHA256\") .update" [.str unsigned]
  let _ ← Prog.effect "createSign(\"RSA-SHA256\") .update(unsigned) .end"
  let key ← Prog.effect "normalizePrivateKey" [Twin.callArg call 1]
  let signature ← Prog.effect "createSign(\"RSA-SHA256\") .update(unsigned) .end() .sign" [key]
  let encoded ← Prog.effect "base64UrlEncode" [signature]
  return .str (unsigned ++ "." ++ text encoded)

private def childLogger : Prog Json := do
  let _ ← Prog.effect "new ConsoleLogger" [.str "error"]
  Prog.effect "new ConsoleLogger(\"error\").child" [.str "github"]

private def createActions (call : Json) : Prog Json := do
  let source := Twin.callArg call 2
  let key ← Prog.effect "normalizePrivateKey" [Twin.callArg call 1]
  let logger ← childLogger
  let _ ← Prog.effect "new GitHubAdapter" [Json.mkObj (present
    [("apiUrl", Twin.callArg call 3), ("appId", Twin.callArg call 0),
     ("installationId", get source "installationId"), ("privateKey", key), ("logger", logger),
     ("webhookSecret", .str "not-used-for-outbound-actions")])]
  return Json.mkObj [("sendText", fnJson "sendText"), ("sendTyping", fnJson "sendTyping"),
    ("supportsReactions", .bool (jsTruthy (get source "messageId"))),
    ("reactToMessage", fnJson "reactToMessage"), ("stream", fnJson "stream")]

private def createChannel (call : Json) : Prog Json := do
  let key ← Prog.effect "normalizePrivateKey" [Twin.callArg call 2]
  let logger ← childLogger
  let _ ← Prog.effect "new BroodsGitHubAdapter" [Json.mkObj (present
    [("apiUrl", Twin.callArg call 5), ("appId", Twin.callArg call 1), ("privateKey", key),
     ("webhookSecret", Twin.callArg call 0), ("userName", Twin.callArg call 6),
     ("botUserId", Twin.callArg call 7), ("logger", logger)])]
  return Json.mkObj [("name", .str "github"), ("canHandle", fnJson "canHandle"),
    ("authenticate", fnJson "authenticate"), ("parse", fnJson "parse"),
    ("actions", fnJson "actions")]

private def trimTrailingSlashes (value : String) : String :=
  String.ofList ((value.toList.reverse.dropWhile (· == '/')).reverse)

private def createRestClient (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let apiUrl := get options "apiUrl"
  let base := trimTrailingSlashes (if nullish apiUrl then "https://api.github.com" else text apiUrl)
  let _ ← Prog.effect "channelApiFetch" [apiUrl]
  let jwt ← Prog.effect "createGitHubAppJwt" [get options "appId", get options "privateKey"]
  let signal ← Prog.effect "AbortSignal.timeout" [num fetchTimeoutMs]
  let response ← Prog.effect "request"
    [.str s!"{base}/app/installations/{show' (get options "installationId")}/access_tokens",
     Json.mkObj [("method", .str "POST"), ("headers", Json.mkObj
       [("Accept", .str "application/vnd.github+json"),
        ("Authorization", .str s!"Bearer {text jwt}"),
        ("X-GitHub-Api-Version", .str apiVersion)]), ("signal", signal)]]
  if !isOk response then
    return ← Prog.throwError "Error" s!"installation token request failed ({statusOf response})"
  let body ← Prog.effect "tokenResponse.json"
  if text (get body "token") == "" then
    return ← Prog.throwError "Error" "installation token response did not include a token"
  return Json.mkObj [("get", fnJson "get")]

/-- `await` of a request that already settled. -/
private def awaited : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => throw error
  | .pending => throw (Json.mkObj [("pending", true)])

private def hydrate (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let repoPath := "/repos/" ++ encodeComponent (text (get options "owner")) ++ "/" ++
    encodeComponent (text (get options "repo"))
  let number := show' (get options "number")
  let isIssue := get options "resource" == .str "issue"
  Prog.catchFail
    (do
      let _ ← Prog.effect "createGitHubRestClient" [options]
      let threadGet := ("client.get",
        [.str (repoPath ++ (if isIssue then "/issues/" else "/pulls/") ++ number)])
      let issueGet := ("client.get",
        [.str (repoPath ++ "/issues/" ++ number ++ "/comments?per_page=100")])
      let reviewGet := ("client.get",
        [.str (repoPath ++ "/pulls/" ++ number ++ "/comments?per_page=100")])
      let withReview := jsTruthy (get options "includeReviewComments")
      -- All requests settle together; awaiting in order lets the thread's error win.
      let outcomes ← Prog.all ([threadGet, issueGet] ++ (if withReview then [reviewGet] else []))
      let thread ← awaited (outcomes.getD 0 .pending)
      let issueComments ← awaited (outcomes.getD 1 .pending)
      let reviewComments ←
        if withReview then awaited (outcomes.getD 2 .pending) else pure (Json.arr #[])
      let content ← Prog.effect "formatGitHubThreadContext" [Json.mkObj (present
        [("owner", get options "owner"), ("repo", get options "repo"),
         ("resource", get options "resource"), ("number", get options "number"),
         ("thread", thread), ("issueComments", issueComments),
         ("reviewComments", reviewComments),
         ("currentCommentId", get options "currentCommentId"),
         ("currentCommentCreatedAt", get options "currentCommentCreatedAt")])]
      return if jsTruthy content then
          Json.mkObj [("role", .str "system"), ("content", content), ("persist", .bool false)]
        else .null)
    (fun _ => pure .null)

private def commentView (comment label : Json) : Json :=
  Json.mkObj (present
    [("id", get comment "id"), ("body", get comment "body"),
     ("createdAt", get comment "created_at"), ("author", get (get comment "user") "login"),
     ("label", label)])

private def sortKey (comment : Json) : String :=
  let created := get comment "createdAt"
  if nullish created then "" else text created

/-- Stable insertion, as `Array.prototype.sort` is. -/
private def insertSorted (item : Json) : List Json → List Json
  | [] => [item]
  | head :: rest =>
    if sortKey item < sortKey head then item :: head :: rest
    else head :: insertSorted item rest

private def filterPrior (id at_ : Json) : List Json → Prog (List Json)
  | [] => pure []
  | head :: rest => do
    let keep ← Prog.effect "isPriorGitHubComment" [head, id, at_]
    let tail ← filterPrior id at_ rest
    return if jsTruthy keep then head :: tail else tail

private def labelReviews : List Json → Prog (List Json)
  | [] => pure []
  | head :: rest => do
    let label ← Prog.effect "formatReviewCommentLabel" [head]
    let tail ← labelReviews rest
    return commentView head label :: tail

private def safeOr (value : Json) (fallback : String) : Prog String := do
  let cleaned ← Prog.effect "safeText" [value]
  return if jsTruthy cleaned then text cleaned else fallback

private def commentLines : List Json → Prog (List String)
  | [] => pure []
  | head :: rest => do
    let author ← safeOr (get head "author") "unknown"
    let created ← safeOr (get head "createdAt") "unknown time"
    let body ← Prog.effect "safeText" [get head "body"]
    let short ← Prog.effect "truncateText" [body, num 2000]
    let tail ← commentLines rest
    return ["", s!"- {text (get head "label")} by {author} at {created}:",
      if jsTruthy short then text short else "(empty)"] ++ tail

private def formatContext (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let thread := get options "thread"
  let title ← safeOr (get thread "title") "(untitled)"
  let safeBody ← Prog.effect "safeText" [get thread "body"]
  let body ← Prog.effect "truncateText" [safeBody, num 8000]
  let reviews ← labelReviews (items (get options "reviewComments"))
  let issues := (items (get options "issueComments")).map fun c => commentView c (.str "comment")
  let prior ← filterPrior (get options "currentCommentId") (get options "currentCommentCreatedAt")
    (issues ++ reviews)
  let sorted := prior.foldl (fun acc item => insertSorted item acc) []
  let comments := sorted.drop (sorted.length - maxContextComments)
  let state ← safeOr (get thread "state") "unknown"
  let author ← safeOr (get (get thread "user") "login") "unknown"
  let kind := if get options "resource" == .str "issue" then "Issue" else "Pull request"
  let head := ["<github_thread_context>",
    s!"Repository: {text (get options "owner")}/{text (get options "repo")}",
    s!"Thread: {kind} #{show' (get options "number")}", s!"Title: {title}", s!"State: {state}",
    s!"Author: {author}", "", "Body:", if jsTruthy body then text body else "(empty)"]
  let tail ←
    if comments.isEmpty then pure ["", "Prior comments: (none)"]
    else do
      let note := if comments.length == maxContextComments then " most recent" else ""
      let lines ← commentLines comments
      pure (["", s!"Prior comments ({comments.length}{note}):"] ++ lines)
  return .str ("\n".intercalate (head ++ tail ++ ["</github_thread_context>"]))

private def messageResult (eventId key body identity events : Json) (source : Json) : Json :=
  Json.mkObj [("kind", .str "message"), ("ack", ack), ("message", Json.mkObj (
    [("eventId", eventId), ("conversationKey", key), ("channelName", .str "github"),
     ("content", textContent body)] ++
    (if missing events then [] else [("events", events)]) ++
    [("identity", identity), ("source", source)]))]

private def hydrateArgs (options : Json) (resource number : Json) (extra : List (String × Json)) :
    Json :=
  let inner := get options "options"
  Json.mkObj (present
    ([("apiUrl", get inner "apiUrl"), ("appId", get inner "appId"),
      ("privateKey", get inner "privateKey"), ("owner", get options "owner"),
      ("repo", get options "repo"), ("installationId", get options "installationId"),
      ("resource", resource), ("number", number),
      ("currentCommentId", get options "commentId"),
      ("currentCommentCreatedAt", get (get (get options "payload") "comment") "created_at")] ++ extra))

private def eventsWith (context body : Json) : Json :=
  jarr ((if jsTruthy context then [context] else []) ++
    [Json.mkObj [("role", .str "user"), ("content", textContent body)]])

private def buildComment (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let number := get options "issueNumber"
  let body := get options "body"
  let context ← Prog.effect "hydrateGitHubThreadContext"
    [hydrateArgs options (get options "resource") number []]
  let identity ← Prog.effect "githubIdentity"
    [get options "repoFullName", number, get (get options "payload") "sender"]
  let source := Json.mkObj
    [("owner", get options "owner"), ("repo", get options "repo"),
     ("installationId", get options "installationId"), ("threadId", get options "threadId"),
     ("messageId", .str (show' (get options "commentId"))), ("issueNumber", number),
     ("commentId", get options "commentId"), ("target", get options "target")]
  let key := s!"gh:{text (get options "repoFullName")}:{text (get options "resource")}:{show' number}"
  return messageResult (get options "eventId") (.str key) body identity (eventsWith context body) source

private def buildReview (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let number := get options "pullNumber"
  let body := get options "body"
  let context ← Prog.effect "hydrateGitHubThreadContext"
    [hydrateArgs options (.str "pr") number [("includeReviewComments", .bool true)]]
  let identity ← Prog.effect "githubIdentity"
    [get options "repoFullName", number, get (get options "payload") "sender"]
  let source := Json.mkObj
    [("owner", get options "owner"), ("repo", get options "repo"),
     ("installationId", get options "installationId"), ("threadId", get options "threadId"),
     ("messageId", .str (show' (get options "commentId"))), ("issueNumber", number),
     ("pullNumber", number), ("commentId", get options "commentId"),
     ("target", .str "pull_request_review_comment")]
  let key := s!"gh:{text (get options "repoFullName")}:pr:{show' number}"
  return messageResult (get options "eventId") (.str key) body identity (eventsWith context body) source

/-- The screening both comment events share. `none` means the event is ignored. -/
private def commentBody (payload options number : Json) : Prog (Option String) := do
  let relevant ← Prog.effect "isRelevantAction" [get payload "action"]
  if !jsTruthy relevant then return none
  let comment := get payload "comment"
  let authorBot ← Prog.effect "isBotActor" [get (get comment "user") "type"]
  if jsTruthy authorBot then return none
  let senderBot ← Prog.effect "isBotActor" [get (get payload "sender") "type"]
  if jsTruthy senderBot then return none
  let body := jsTrim (text (get comment "body"))
  if !jsTruthy number || !jsTruthy (get (get payload "installation") "id") || body == "" ||
      !jsTruthy (get comment "id") then return none
  let botName := get options "botUserName"
  if jsTruthy botName &&
      (indexOf? body.toLower ("@" ++ (text botName).toLower)).isNone then return none
  return some body

private def parseIssueComment (call : Json) : Prog Json := do
  let payload := Twin.callArg call 1
  let options := Twin.callArg call 6
  let number := get (get payload "issue") "number"
  match ← commentBody payload options number with
  | none => return ignored
  | some body =>
    let resource := if jsTruthy (get (get payload "issue") "pull_request") then "pr" else "issue"
    let threadId ← Prog.effect "github.encodeThreadId" [Json.mkObj
      [("owner", Twin.callArg call 3), ("repo", Twin.callArg call 4), ("prNumber", number),
       ("type", .str resource)]]
    Prog.effect "buildCommentMessage" [Json.mkObj
      [("payload", payload), ("options", options), ("resource", .str resource),
       ("owner", Twin.callArg call 3), ("repo", Twin.callArg call 4),
       ("repoFullName", Twin.callArg call 5),
       ("installationId", get (get payload "installation") "id"), ("issueNumber", number),
       ("commentId", get (get payload "comment") "id"), ("threadId", threadId),
       ("eventId", .str ("gh:" ++ text (Twin.callArg call 2))), ("body", .str body),
       ("target", .str "issue_comment")]]

private def parseReviewComment (call : Json) : Prog Json := do
  let payload := Twin.callArg call 1
  let options := Twin.callArg call 6
  let number := get (get payload "pull_request") "number"
  match ← commentBody payload options number with
  | none => return ignored
  | some body =>
    let comment := get payload "comment"
    let reply := get comment "in_reply_to_id"
    let threadId ← Prog.effect "github.encodeThreadId" [Json.mkObj
      [("owner", Twin.callArg call 3), ("repo", Twin.callArg call 4), ("prNumber", number),
       ("reviewCommentId", if nullish reply then get comment "id" else reply)]]
    Prog.effect "buildReviewCommentMessage" [Json.mkObj
      [("payload", payload), ("options", options), ("owner", Twin.callArg call 3),
       ("repo", Twin.callArg call 4), ("repoFullName", Twin.callArg call 5),
       ("installationId", get (get payload "installation") "id"), ("pullNumber", number),
       ("commentId", get comment "id"), ("threadId", threadId),
       ("eventId", .str ("gh:" ++ text (Twin.callArg call 2))), ("body", .str body)]]

/-- What differs between the issue and pull-request events. -/
private structure Kind where
  field : String
  segment : String
  label : String
  optionKey : String
  threadExtra : List (String × Json)
  sourceExtra : Json → List (String × Json)
  target : String

private def issueKind : Kind :=
  { field := "issue", segment := "issue", label := "Issue", optionKey := "triggerOnIssueOpen",
    threadExtra := [("type", .str "issue")], sourceExtra := fun _ => [], target := "issue" }

private def pullKind : Kind :=
  { field := "pull_request", segment := "pr", label := "Pull request", optionKey := "triggerOnPROpen",
    threadExtra := [], sourceExtra := fun number => [("pullNumber", number)],
    target := "pull_request" }

private def openedMessage (kind : Kind) (call payload number : Json) : Prog Json := do
  let owner := Twin.callArg call 3
  let repo := Twin.callArg call 4
  let full := Twin.callArg call 5
  let subject := get payload kind.field
  let threadId ← Prog.effect "github.encodeThreadId" [Json.mkObj
    ([("owner", owner), ("repo", repo), ("prNumber", number)] ++ kind.threadExtra)]
  let body ← Prog.effect "formatTitleAndBody"
    [.str kind.label, get subject "title", get subject "body"]
  let identity ← Prog.effect "githubIdentity" [full, number, get payload "sender"]
  let source := Json.mkObj
    ([("owner", owner), ("repo", repo), ("installationId", get (get payload "installation") "id"),
      ("threadId", threadId), ("issueNumber", number), ("target", .str kind.target)] ++
     kind.sourceExtra number)
  return messageResult (.str ("gh:" ++ text (Twin.callArg call 2)))
    (.str s!"gh:{text full}:{kind.segment}:{show' number}") body identity undef source

private def parseThreadEvent (kind : Kind) (call : Json) : Prog Json := do
  let payload := Twin.callArg call 1
  let number := get (get payload kind.field) "number"
  if !jsTruthy number || !jsTruthy (get (get payload "installation") "id") then return ignored
  let action := get payload "action"
  if action == .str "closed" then
    return Json.mkObj [("kind", .str "cleanup"), ("ack", ack),
      ("eventId", .str ("gh:" ++ text (Twin.callArg call 2))), ("channelName", .str "github"),
      ("conversationKey",
        .str s!"gh:{text (Twin.callArg call 5)}:{kind.segment}:{show' number}")]
  if action == .str "assigned" then
    let assigned ← Prog.effect "isBotAssignee" [payload, Twin.callArg call 7]
    if !jsTruthy assigned then return ignored
    return ← openedMessage kind call payload number
  let relevant ← Prog.effect "isRelevantAction" [action]
  if !jsTruthy relevant then return ignored
  let senderBot ← Prog.effect "isBotActor" [get (get payload "sender") "type"]
  if jsTruthy senderBot then return ignored
  if get (Twin.callArg call 6) kind.optionKey == .bool false then return ignored
  openedMessage kind call payload number

/-- This file's twins. -/
def twins : List Twin :=
  [Twin.traced (source "createGitHubAppJwt") createAppJwt,
   Twin.traced (source "createGitHubActions") createActions,
   Twin.traced (source "createGitHubChannel") createChannel,
   Twin.traced (source "createGitHubRestClient") createRestClient,
   Twin.traced (source "hydrateGitHubThreadContext") hydrate,
   Twin.traced (source "formatGitHubThreadContext") formatContext,
   Twin.traced (source "buildCommentMessage") buildComment,
   Twin.traced (source "buildReviewCommentMessage") buildReview,
   Twin.traced (source "parseIssueCommentEvent") parseIssueComment,
   Twin.traced (source "parseReviewCommentEvent") parseReviewComment,
   Twin.traced (source "parseIssuesEvent") (parseThreadEvent issueKind),
   Twin.traced (source "parsePullRequestEvent") (parseThreadEvent pullKind)]

end Spec.Channels.Wavechannels1.GitHub
