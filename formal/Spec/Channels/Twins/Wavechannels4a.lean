import Spec.Channels.Twins.Support
import Spec.Sandbox.Twins.Tools.Js

/-!
Twins for the functions listed in `.lake/worklist/assign4/channels4a.tsv`.
-/

namespace Spec.Channels.Wavechannels4a

open Lean Spec Spec.Channels Spec.Sandbox.Tools.Re
open Spec.Sandbox.Tools (Re asciiLower contains)

private def get (v : Json) (k : String) : Json := (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def text (v : Json) : String := v.getStr?.toOption.getD ""
private def items (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def undef : Json := Twin.undefinedJson
private def isUndef (v : Json) : Bool := v == Twin.undefinedJson
private def live (v : Json) : Bool := !isUndef v && v != .null && truthy v
private def a (c : Json) (n : Nat) : Json := Twin.callArg c n
private def obj (pairs : List (String × Json)) : Json := Json.mkObj pairs
private def num (n : Nat) : Json := toJson n
private def source (file name : String) : String := s!"apps/core/src/{file}.ts#{name}"

/-! ## `simplifyErrorText` -/

private def dot : Re := .chr fun c =>
  c != '\n' && c != '\r' && c != ' ' && c != ' '
private def word : Re := .chr fun c => c.isAlphanum || c == '_'

/-- ECMAScript `/i` on ASCII text: match the lowered text, read groups from the original. -/
private def lower (s : String) : String := String.ofList (s.toList.map asciiLower)

private def replaceRe (re : Re) (global : Bool) (s : String) : String :=
  let chars := s.toList.toArray
  let rec loop : Nat → Nat → String
    | 0, pos => String.ofList (chars.toList.drop pos)
    | fuel + 1, pos =>
      match execFrom re chars pos with
      | none => String.ofList (chars.toList.drop pos)
      | some found =>
        let before := String.ofList ((chars.toList.drop pos).take (found.start - pos))
        if global then before ++ loop fuel (max found.stop (found.start + 1))
        else before ++ String.ofList (chars.toList.drop found.stop)
  loop (s.length + 1) 0

private def lastError : Re :=
  seqs [lit "last error:", star space, .group 1 (plus (.chr fun _ => true)), .eol]

private def errorHints : List (Re × Option String) :=
  [(seqs [.wordBoundary, anyLit ["try", "retry"], lit " ", opt (lit "again "),
      alts [seqs [lit "in ", digit], lit "later"]], none),
   (alts [lit "usage limit", lit "quota",
      seqs [lit "insufficient ", alts [lit "balance", seqs [star dot, lit "credit"]]],
      lit "credit balance", lit "purchase credits",
      seqs [lit "upgrade your ", opt (lit "token "), lit "plan"]],
    some "Add credits or upgrade the plan with the model provider."),
   (alts [seqs [lit "rate", opt dot, lit "limit"],
      seqs [.wordBoundary, lit "429", .wordBoundary],
      lit "too many requests", lit "overloaded", lit "queue is full"],
    some "Try again in a moment."),
   (alts [seqs [.wordBoundary, lit "time", opt (lit "d"), opt (lit " "), lit "out", .wordBoundary],
      seqs [.wordBoundary, lit "etimedout", .wordBoundary],
      seqs [.wordBoundary, lit "econnreset", .wordBoundary]],
    some "Try again."),
   (lit "ran out of time", some "Send a message to continue where I left off.")]

/-- `simplifyErrorText`. `secretValues` comes from the ambient observability context, which a
recording does not show, so a message that names a secret is left out of the comparison. -/
private def simplifyErrorText (c : Json) : Prog Json := do
  let raw := text (a c 0)
  if contains raw "secret" then
    return ← Prog.unsupported "secretValues come from an ambient context the recording omits"
  let redacted := text (← Prog.effect "redactSensitiveText" [a c 0, undef])
  let chars := redacted.toList.toArray
  let body :=
    ((execFrom lastError (lower redacted).toList.toArray 0).bind
      (groupText chars · 1)).getD redacted
  let body := replaceRe (seqs [.bol, lit "AI_", plus word, lit ":", star space]) false body
  let body := replaceRe (seqs [lit " in organization org-",
    plus (alts [word, lit "-"])]) false body
  let body := replaceRe (seqs [opt (lit " "), lit "Visit http", opt (lit "s"), lit "://",
    plus nonSpace, lit " to learn more."]) true body
  let message := jsTrim body
  if message.isEmpty then
    return .str "Something went wrong while generating a reply. Try again."
  let overflow ← Prog.effect "isContextLengthError" [.str message]
  let hint : Option String :=
    if overflow == .bool true then
      some (if a c 1 == .bool true
        then "Send /compact to summarize the conversation, or /new to start over if that fails."
        else "Start a new conversation to continue.")
    else
      let low := lower message
      (errorHints.find? (fun entry => test entry.1 low)).bind (·.2)
  match hint with
  | none => return .str message
  | some value =>
    return .str (replaceRe (seqs [oneOf ".!?", .eol]) false message ++ ". " ++ value)

/-! ## Responses and small adapters -/

private def badRequestResponse (c : Json) : Prog Json := do
  let error := get (a c 0) "$error"
  let cls := text (get error "$class")
  let message := get error "message"
  if cls == "DirectForbiddenError" then
    Prog.effect "errorResponse" [num 403, message, get (get error "fields") "init"]
  else if cls == "DirectNotFoundError" then
    Prog.effect "errorResponse" [num 404, message]
  else if cls == "StatusUrlConfigError" then
    Prog.effect "errorResponse" [num 500, message]
  else
    Prog.effect "errorResponse"
      [num 400, if isUndef error then .str "Invalid request" else message]

private def whatsAppInbound (c : Json) : Prog Json := do
  let message := a c 0
  let sender := a c 1
  let parsed := a c 2
  let raw := Twin.field parsed "raw"
  let threadId := Twin.field parsed "threadId"
  let userName := get (get (get raw "contact") "profile") "name"
  let named := if live userName then [("userName", userName)] else []
  let attachments := Twin.field parsed "attachments"
  return obj ([("eventId", .str ("whatsapp:" ++ text (get message "id"))),
      ("conversationKey", threadId), ("channelName", .str "whatsapp"), ("content", a c 3),
      ("identity", obj ([("channelId", sender), ("userId", sender)] ++ named)),
      ("source", obj ([("messageId", get message "id"),
        ("phoneNumberId", get raw "phoneNumberId"), ("threadId", threadId),
        ("userWaId", sender)] ++ named))] ++
    (if (items attachments).isEmpty then [] else [("attachments", attachments)]))

private def tenantGraphApi (c : Json) : Prog Json := do
  let self := Twin.self c
  let init := a c 1
  let signal ← Prog.effect "AbortSignal.timeout" [num 30000]
  let extra := match get init "headers" with
    | .obj kvs => kvs.toArray.toList.filter (fun entry => entry.1 != "$keys" && entry.1 != "$undefined")
    | _ => []
  let headers := obj (("Authorization", .str ("Bearer " ++ text (Twin.field self "accessToken"))) :: extra)
  let response ← Prog.effect "publicHostFetch"
    [.str (text (Twin.field self "graphApiUrl") ++ text (a c 0)),
     obj [("method", .str "POST"), ("body", get init "body"), ("headers", headers),
      ("signal", signal)]]
  let status := (get (get response "$response") "status").getNat?.toOption.getD 0
  if 200 ≤ status && status < 300 then
    Prog.effect "response.json"
  else
    let body ← Prog.effect "response.text"
    Prog.throwError "Error" s!"WhatsApp API error: {status} {text body}"

private def fetchSlackFile (c : Json) : Prog Json := do
  let _ ← Prog.effect "assertSlackFileUrl" [a c 0]
  Prog.unsupported "no recording reaches the download"

/-- The key order `JSON.stringify` uses for a recorded object. -/
private def keyOrder (value : Json) : List String :=
  match get value "$keys", value with
  | .arr keys, _ => keys.toList.filterMap (fun key => (Json.getStr? key).toOption)
  | _, .obj kvs => kvs.toArray.toList.map (·.1)
  | _, _ => []

private def forwardMessageCreate (c : Json) : Prog Json := do
  let data := a c 0
  let thread := a c 1
  let merged : Json :=
    if live thread then
      let order := (keyOrder data).filter (· != "thread") ++ ["thread"]
      obj (order.map (fun key => (key, if key == "thread" then thread else get data key)) ++
        [("$keys", .arr ((order.map Json.str).toArray))])
    else data
  let body := Twin.jsonStringify 64 (obj
    [("type", .str "GATEWAY_MESSAGE_CREATE"), ("data", merged),
     ("$keys", .arr #[.str "type", .str "data"])])
  let token ← Prog.effect "discordForwarderToken" [a c 2]
  let _ ← Prog.all ((items (a c 3)).map fun target => ("post", [target, .str body, token]))
  return undef

/-! ## `handleHttpRequest` -/

private def isPrefix (value pre : String) : Bool := pre.toList.isPrefixOf value.toList
private def isSuffix (value post : String) : Bool := post.toList.isSuffixOf value.toList
private def entries (value : Json) : List (String × Json) :=
  match value with
  | .obj kvs => kvs.toArray.toList.filter (fun entry => entry.1 != "$keys" && entry.1 != "$fields")
  | _ => []

private def isUnsupported (error : Json) : Bool := !isUndef (get error "$unsupported")

/-- The `catch (err)` that turns a failure into `badRequestResponse(err)`. -/
private def orBadRequest (body : Prog Json) : Prog Json :=
  Prog.catchFail body fun error =>
    if isUnsupported error then Prog.fail error
    else Prog.effect "badRequestResponse" [error]

/-- `return handler(x)` inside a `try`: a synchronous throw is caught, a rejection is not. -/
private def returned (label : String) (args : List Json) : Prog Json := do
  match ← Prog.attempt label args with
  | .ok value => pure value
  | .threw error true => Prog.effect "badRequestResponse" [error]
  | .threw error false => Prog.fail error
  | .pending => Prog.fail (obj [("pending", .bool true)])

private def statusRoute (request handlers context : Json) : Prog Json := do
  let auth ← Prog.effect "context.authResolver" [get request "headers"]
  let kind := text (get auth "kind")
  if kind != "account" && kind != "deployment" && kind != "agent" || !live (get auth "account") then
    return ← Prog.effect "unauthorizedResponse"
  orBadRequest do
    if isUndef (get handlers "handleStatusRequest") then
      return ← Prog.effect "notFoundResponse"
    let target ← Prog.effect "parseStatusPath" [get request "path", get auth "account"]
    let ingress ← Prog.effect "context.ingressStatusLoader" [target]
    if !live ingress then
      return ← Prog.effect "errorResponse"
        [num 404, .str s!"No run {text (get target "runId")}", obj [("code", .str "run_not_found")]]
    let publicEventId ← Prog.effect "publicEventIdForScope"
      [get ingress "eventId", get target "accountId", get ingress "agentId", get ingress "eventId"]
    let parsed := obj (entries target ++
      [("agentId", get ingress "agentId"), ("eventId", get ingress "eventId"),
       ("publicEventId", publicEventId), ("ingress", ingress)])
    if kind == "deployment" then
      let denial ← Prog.effect "statusAccessDenial" [auth, parsed, context]
      if live denial then
        return ← Prog.effect "errorResponse"
          [num 403, get denial "message", obj [("code", get denial "code")]]
    if kind == "agent" && get ingress "agentId" != get auth "agentId" then
      return ← Prog.effect "runTokenScopeResponse" [get auth "agentId"]
    returned "handlers.handleStatusRequest" [parsed]

private def sandboxJobPath : Re :=
  seqs [.bol, lit "/v1/sandbox-jobs/", .group 1 (plus (noneOf "/")), lit "/complete", .eol]

private def unknownWebhook : String :=
  "Unknown webhook URL. Provider webhooks are /v1/webhooks/{accountId}/{channel} for a production " ++
  "stage, or /v1/webhooks/{accountId}/dev/{endpointId}/{channel} for any other stage. The agent " ++
  "is chosen by credentials and channel records, never named in the URL."

private def liveness : Json := obj [("status", .str "ok"), ("method", .str "POST")]

private def webhookRoute (route channelRequest method handlers context : Json) : Prog Json := do
  let channelName := get route "channelName"
  let endpointId := get route "endpointId"
  let account ← Prog.effect "context.accountLoader" [get route "accountId"]
  if !live account || get account "status" != .str "active" then
    return ← Prog.effect "notFoundResponse"
  let holder ← Prog.effect "findChannelCredentialHolder"
    [context, get account "accountId", channelName, channelRequest, endpointId]
  let kind := text (get holder "kind")
  if kind == "unconfigured" && method == .str "GET" then
    return ← Prog.effect "jsonResponse" [num 200, liveness]
  if kind == "unconfigured" then
    return ← Prog.effect "integrationNotConfigured"
      [if live (get holder "configured") then .str s!"Webhook {text channelName}" else channelName]
  if kind == "unknown-stage" then
    return ← Prog.effect "errorResponse"
      [num 404,
       .str s!"No stage of this account is deployed at {text endpointId}. Re-copy the webhook URL that broods printed for the stage.",
       obj [("code", .str "unknown_webhook_stage")]]
  if kind == "unverified" then return ← Prog.effect "unauthorizedResponse"
  if kind == "unavailable" then
    return ← Prog.effect "errorResponse" [num 503, .str "Channel lookup failed, retry the delivery"]
  Prog.effect "handleChannelWebhook"
    [get holder "receivers", channelRequest, handlers, account, context]

private def socketScopeBody (auth : Json) : Prog Json := do
  let user := get auth "user"
  let ticket := get auth "stageTicket"
  let userFields ←
    if live user then do
      let prefix' ← Prog.effect "userConversationPrefix" [get user "userId"]
      pure [("conversationPrefix", prefix'), ("userTokenExpiresAt", get user "expiresAt")]
    else pure []
  return obj ([("accountId", get (get auth "account") "accountId"),
      ("projectSlug", get auth "projectSlug"), ("stageSlug", get auth "stageSlug"),
      ("endpointIds", .arr #[get auth "endpointId"])] ++
    (if live ticket then [("expiresAt", get ticket "expiresAt")] else []) ++ userFields)

/-- The direct API: `parseDirectPayload`, then the sync or async handler. -/
private def directRoute (request handlers context auth : Json) : Prog Json := do
  let kind := text (get auth "kind")
  let deployment := if kind == "deployment" then auth else undef
  let user := get deployment "user"
  orBadRequest do
    let payload ← Prog.effect "parseDirectPayload"
      [get request "body", get request "headers", get auth "account", context, deployment]
    let chain : List Json :=
      (if live user then [obj [("kind", .str "user"), ("id", get user "userId")]] else []) ++
      [obj [("kind", .str "api"), ("keyKind", .str kind)]]
    let credential := get user "credential"
    let scope ←
      if isUndef deployment then pure []
      else do
        let ingress ← Prog.effect "publicDeploymentIngress" [deployment]
        pure [("endpointId", get deployment "endpointId"),
          ("projectSlug", get deployment "projectSlug"),
          ("stageSlug", get deployment "stageSlug"), ("publicDeploymentIngress", ingress)]
    let parsed := entries payload ++ [("principalChain", .arr chain.toArray)] ++
      (if isUndef credential then [] else [("userCredential", credential)]) ++ scope
    if !live (get payload "background") then
      return ← returned "handlers.handleDirectRequest" [obj parsed]
    if isUndef (get handlers "handleAsyncRequest") then
      return ← Prog.effect "notFoundResponse"
    let statusUrl ← Prog.effect "buildStatusUrl" [get payload "runId"]
    returned "handlers.handleAsyncRequest" [obj (parsed ++ [("statusUrl", statusUrl)])]

/-- `observabilityTicketScope`: a read-only ticket answers the log socket's scope check. -/
private def observabilityTicketScope (c : Json) : Prog Json := do
  let token ← Prog.effect "extractBearerToken" [get (a c 0) "authorization"]
  if !live token || !isPrefix (text token) "bdob_" then
    return Json.null
  let secret ← Prog.effect "requireEnv" [.str "STAGE_TICKET_SECRET"]
  let ticket ← Prog.effect "openObservabilityTicket" [token, secret]
  if !live ticket then
    return Json.null
  let _ ← Prog.effect "getStorage"
  let account ← Prog.effect "getStorage().accounts.getById" [get ticket "accountId"]
  if !live account || get account "status" != .str "active" then
    return Json.null
  return obj
    [("accountId", get ticket "accountId"),
     ("projectSlug", get ticket "projectSlug"),
     ("stageSlug", get ticket "stageSlug"),
     ("endpointIds", .arr #[get ticket "endpointId"]),
     ("expiresAt", get ticket "expiresAt")]

private def handleHttpRequest (c : Json) : Prog Json := do
  let request := a c 0
  let handlers := a c 1
  let context := a c 2
  let method := get request "method"
  let path := text (get request "path")
  let search := get request "search"
  if isSuffix path "/files" then
    let trimmed := String.ofList (path.toList.take (path.length - 6))
    let endpoint ← Prog.effect "parsePublicEndpointPath" [.str trimmed]
    if live endpoint then
      return ← Prog.effect "handleConversationFilesRequest" [request, endpoint, context]
  if method == .str "GET" && isPrefix path "/v1/runs/" then
    return ← statusRoute request handlers context
  if method == .str "GET" then
    let withQuery ←
      if live search then Prog.effect "matchWebhookPath" [.str path] else pure undef
    if !live withQuery then
      let route ← Prog.effect "matchWebhookPath" [.str path]
      if live route then return ← Prog.effect "jsonResponse" [num 200, liveness]
      return ← Prog.effect "notFoundResponse"
  if method != .str "GET" && method != .str "POST" then
    return ← Prog.effect "methodNotAllowed" [.arr #[.str "GET", .str "POST"]]
  let channelRequest := obj [("method", method), ("rawPath", .str path), ("rawQueryString", search),
    ("headers", get request "headers"), ("body", get request "body")]
  let chars := path.toList.toArray
  match (execFrom sandboxJobPath chars 0).bind (groupText chars · 1) with
  | some jobId =>
    if isUndef (get handlers "handleSandboxJobCompletionRequest") then
      return ← Prog.effect "notFoundResponse"
    orBadRequest do
      let payload ← Prog.effect "parseSandboxJobCompletionPayload"
        [.str jobId, get request "headers", get request "body"]
      returned "handlers.handleSandboxJobCompletionRequest" [payload]
  | none =>
    let route ← Prog.effect "matchWebhookPath" [.str path]
    if !live route && isPrefix path "/v1/webhooks/" then
      return ← Prog.effect "errorResponse"
        [num 404, .str unknownWebhook, obj [("code", .str "unknown_webhook_url")]]
    if live route then
      return ← webhookRoute route channelRequest method handlers context
    let publicEndpoint ← Prog.effect "parsePublicEndpointPath" [.str path]
    let scope ← Prog.effect "socketScopePath" [.str path]
    if scope == .str "observability" then
      let readOnly ← Prog.effect "observabilityTicketScope" [get request "headers"]
      if live readOnly then
        return ← Prog.effect "jsonResponse" [num 200, readOnly]
    let auth ← Prog.effect "context.authResolver" [get request "headers"]
    let kind := text (get auth "kind")
    if live scope then
      if kind != "deployment" || (scope == .str "observability" && !live (get auth "stageTicket")) then
        return ← Prog.effect "unauthorizedResponse"
      let body ← socketScopeBody auth
      return ← Prog.effect "jsonResponse" [num 200, body]
    if kind == "agent" then
      return ← Prog.effect "runTokenScopeResponse" [get auth "agentId"]
    if !live (get context "directApiEnabled") then
      return ← Prog.effect "directApiDisabledResponse"
    if live publicEndpoint then
      let matched ←
        if kind == "deployment" then Prog.effect "deploymentMatchesPath" [auth, publicEndpoint]
        else pure (.bool false)
      if !live matched then return ← Prog.effect "unauthorizedResponse"
    if kind != "deployment" && kind != "account" then
      return ← Prog.effect "unauthorizedResponse"
    directRoute request handlers context auth

/-! ## The channel webhook path -/

private def workerQueueFull : String := "In-process worker queue is full"
private def promise : Json := obj [("$opaque", .str "Promise")]
private def anonymous : Json := obj [("$fn", .str "")]
private def statusOk : Json := obj [("statusCode", num 200)]
private def orElse (value fallback : Json) : Json :=
  if isUndef value || value == .null then fallback else value

private def errorText (error : Json) : String :=
  match get error "$error" with
  | details@(.obj _) => text (get details "message")
  | _ => error.compress

/-- `finally`: runs `after` on both paths. -/
private def finallyDo {α : Type} (body : Prog α) (after : Prog Unit) : Prog α :=
  Prog.bind
    (Prog.catchFail body fun error =>
      if isUnsupported error then Prog.fail error
      else Prog.bind after fun _ => Prog.fail error)
    fun value => Prog.bind after fun _ => pure value

/-- Puts back the context `getObservabilityContext()` returned on entry. -/
private def restoreContext (c : Json) : Prog Unit := do
  let _ ← Prog.effect "setObservabilityContext" [Twin.observabilityContext c]

private def setContext (fields : List (String × Json)) (conversationKey config : Json) :
    Prog Unit := do
  let traceId ← Prog.effect "mintTraceId"
  let active ← Prog.effect "otelContextApi.active"
  let secrets ← Prog.effect "collectSecretValues" [config]
  let _ ← Prog.effect "setObservabilityContext"
    [obj (fields ++ [("conversationKey", conversationKey), ("traceId", traceId),
      ("otelContext", active), ("secretValues", secrets)])]

private def receiveChannelWebhook (c : Json) : Prog Json := do
  let receiver := a c 0
  let adapter := get receiver "adapter"
  let agent := get receiver "agent"
  let account := a c 3
  let context := a c 4
  let accountId := get account "accountId"
  let agentId := get agent "agentId"
  let deployment ← Prog.effect "context.deploymentLoader" [accountId, agentId]
  let hasScope := live deployment
  if hasScope then
    setContext
      [("accountId", accountId), ("project", get deployment "projectSlug"),
       ("stage", get deployment "stageSlug"), ("endpointId", get deployment "endpointId"),
       ("agentId", agentId)]
      (.str s!"webhook:{text (get adapter "name")}:{text agentId}") (get agent "config")
  finallyDo
    (do
      let parsed ← Prog.effect "adapter.parse" [a c 1]
      let kind := text (get parsed "kind")
      if kind == "response" then
        return obj [("kind", .str "response"), ("response", get parsed "response")]
      if kind == "ignore" then
        return obj [("kind", .str "ignore"), ("response", orElse (get parsed "response") statusOk)]
      let ack := orElse (get parsed "ack") statusOk
      if kind == "cleanup" then
        let _ ← Prog.effect "context.waitUntil" [promise]
        let _ ← Prog.attempt "cleanupChannelPartitions"
          [obj [("accountId", get account "accountId"), ("agentConfig", get agent "config"),
                ("channelName", get parsed "channelName"),
                ("conversationKey", get parsed "conversationKey")]]
        return obj [("kind", .str "accepted"), ("ack", ack)]
      if kind == "batch" then
        return ← Prog.unsupported "a batch admits after the receipt returns"
      let admit ← Prog.effect "acceptChannelTurn"
        [adapter, parsed, a c 2, account, agent, deployment, context]
      return obj ([("kind", .str "accepted"), ("ack", ack)] ++
        (if isUndef admit then [] else [("admitted", promise)])))
    (if hasScope then restoreContext c else pure ())

private structure WebhookState where
  ack : Json := undef
  ignored : Json := undef
  admissions : Nat := 0

private inductive Receipts where
  | early (response : Json)
  | done (state : WebhookState)

private def collectReceipts (c : Json) : List Json → WebhookState → Prog Receipts
  | [], state => pure (.done state)
  | receiver :: rest, state => do
    let receipt ← Prog.effect "receiveChannelWebhook"
      [receiver, a c 1, a c 2, a c 3, a c 4, anonymous]
    let kind := text (get receipt "kind")
    if kind == "response" then
      return .early (← Prog.effect "toResponse" [get receipt "response"])
    if kind == "ignore" then
      return ← collectReceipts c rest { state with ignored := orElse state.ignored (get receipt "response") }
    collectReceipts c rest
      { state with
        ack := orElse state.ack (get receipt "ack")
        admissions := state.admissions + (if isUndef (get receipt "admitted") then 0 else 1) }

/-- What `Promise.race` saw: whether the ack timer fired, and whether admission was refused. -/
private structure RaceState where
  timer : Json := undef
  fired : Bool := false
  refused : Bool := false

/-- `$enter:arg5` is the `acked` closure, asked only after a full-queue failure on a redelivering
message. Asked before the timer fires it answers false, so the admission rejects. -/
private def raceCallbacks : Nat → RaceState → Prog RaceState
  | 0, state => pure state
  | limit + 1, state =>
    .input fun
      | none => pure state
      | some ("arg0", args) =>
        if (items args).isEmpty then
          Prog.bind (Prog.effect "resolve") fun _ =>
            raceCallbacks limit { state with fired := true }
        else
          Prog.bind (Prog.effect "setTimeout" [anonymous, num 2000]) fun timer =>
            raceCallbacks limit { state with timer := timer }
      | some ("arg5", _) =>
        raceCallbacks limit { state with refused := state.refused || !state.fired }
      | some (other, _) => Prog.unsupported s!"callback {other}"

private def handleChannelWebhook (c : Json) : Prog Json :=
  Prog.catchFail
    (do
      match ← collectReceipts c (items (a c 0)) {} with
      | .early response => return response
      | .done state =>
        if state.admissions > 0 then
          let _ ← Prog.effect "context.waitUntil" [promise]
          let race ← raceCallbacks 8 {}
          let _ ← Prog.effect "clearTimeout" [race.timer]
          if race.refused then
            return ← Prog.fail (Prog.errorJson "Error" workerQueueFull)
        Prog.effect "toResponse" [orElse state.ack (orElse state.ignored statusOk)])
    fun error =>
      if isUnsupported error then Prog.fail error
      else if errorText error == workerQueueFull then
        Prog.effect "errorResponse"
          [num 503, .str workerQueueFull, obj [], obj [("Retry-After", .str "5")]]
      else Prog.effect "errorResponse" [num 500, .str "Internal server error"]

private def acceptChannelTurn (c : Json) : Prog Json := do
  let adapter := a c 0
  let result := a c 1
  let account := a c 3
  let agent := a c 4
  let context := a c 6
  if get result "kind" == .str "context" then
    return ← Prog.unsupported "no recording reaches the context path"
  let message := get result "message"
  let channelName := get message "channelName"
  let target ← Prog.effect "resolveChannelTarget"
    [context, account, agent, channelName, get message "identity"]
  if get target "kind" == .str "unavailable" then
    let _ ← Prog.effect "adapter .actions" [message]
    let reply ← Prog.effect "formatChannelErrorText"
      [.str "I can't reach my channel configuration right now. Try again in a moment."]
    Prog.spawn "adapter .actions(message) .sendText" [reply]
    let _ ← Prog.effect "context.waitUntil" [promise]
    return undef
  let record := get target "record"
  let targetAgentId := get (get target "agent") "agentId"
  let replySource ← Prog.effect "channelReplySource" [adapter, message, record]
  let _ ← Prog.effect "adapter.actions" [obj (entries message ++ [("source", replySource)])]
  if targetAgentId != get agent "agentId" then
    let _ ← Prog.effect "context.deploymentLoader" [get account "accountId", targetAgentId]
  let identity ← Prog.effect "identityWithChannelRoles" [get message "identity", record]
  let config ← Prog.effect "channelRuntimeAgentConfig" [target, channelName, get agent "config"]
  let refusal ← Prog.effect "refuseChannelInvoke"
    [config, account, targetAgentId, channelName, identity]
  if live refusal then
    let reply ← Prog.effect "formatChannelErrorText" [refusal]
    Prog.spawn "channel .sendText" [reply]
    let _ ← Prog.effect "context.waitUntil" [promise]
    return undef
  return anonymous

/-- `ackInbound` starts `send` on a task of its own, so the callback's outcome is ignored here. -/
private def ack (event : Json) (action label : String) : Prog Unit := do
  let _ ← Prog.effect "ackInbound" [event, .str action, anonymous]
  .input fun
    | none => pure ()
    | some _ => Prog.spawn label

private def runMutationFields (event : Json) : Prog (Option (Json × Json) × Bool) := do
  let _ ← Prog.effect "createAgentHookDispatcher" [get event "accountId", get event "agentConfig"]
  let extracted ← Prog.effect "extractText" [get event "content"]
  let source ← Prog.effect "toLifecycleValue" [get event "source"]
  let mutation ← Prog.effect "hooks.runMutation"
    [.str "channel.message.received",
     obj [("channel", get event "channelName"), ("text", extracted), ("source", source)]]
  if get mutation "drop" == .bool true then return (none, true)
  let mut content := get event "content"
  let mut events := get event "events"
  if let .str rewritten := get mutation "text" then
    content ← Prog.effect "rewriteUserContentText" [content, .str rewritten]
    events ← Prog.effect "rewriteLatestUserIngressText" [events, .str rewritten]
  if !isUndef mutation && !isUndef (get mutation "metadata") then
    events ← Prog.effect "attachMetadataToLatestUserIngress" [events, get mutation "metadata"]
  return (some (content, events), false)

private def processBody (event : Json) : Prog Json := do
  let answer := live (get event "answer")
  let mut content := get event "content"
  let mut events := get event "events"
  if live (get event "agentConfig") && !answer then
    let (rewritten, dropped) ← runMutationFields event
    if dropped then return undef
    if let some (newContent, newEvents) := rewritten then
      content := newContent
      events := newEvents
  if !answer then
    ack event "sendTyping" "event.channel.sendTyping"
    ack event "reactToMessage" "event.channel.reactToMessage"
  let token ←
    if answer then pure undef
    else do
      let resolved ← Prog.effect "resolveCommandToken"
        [content, get event "source", get event "channelName"]
      pure (orElse resolved undef)
  let _ ← Prog.effect "handlers.handleChannelRequest"
    [obj (entries event ++ [("content", content), ("events", events)] ++
      (if isUndef token then [] else [("commandToken", token)]))]
  return undef

private def processChannelMessage (c : Json) : Prog Json := do
  let event := a c 0
  let hasScope := live (get event "accountId") && live (get event "agentId") &&
    live (get event "endpointId") && live (get event "projectSlug") && live (get event "stageSlug")
  if hasScope then
    setContext
      [("accountId", get event "accountId"), ("project", get event "projectSlug"),
       ("stage", get event "stageSlug"), ("endpointId", get event "endpointId"),
       ("agentId", get event "agentId")]
      (get event "conversationKey") (get event "agentConfig")
  finallyDo
    (Prog.catchFail (processBody event) fun error => do
      if isUnsupported error then return ← Prog.fail error
      let message := errorText error
      if message == workerQueueFull then
        let again ← Prog.effect "redeliver"
        if live again then return ← Prog.fail error
      let reply ← Prog.effect "formatChannelErrorText" [.str message, get event "channelName"]
      let _ ← Prog.attempt "event.channel .sendText" [reply]
      return undef)
    (if hasScope then restoreContext c else pure ())

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (source "shared/channels" "simplifyErrorText") simplifyErrorText,
   Twin.traced (source "harness/integrations" "badRequestResponse") badRequestResponse,
   Twin.traced (source "shared/whatsapp-channel" "toInboundMessage") whatsAppInbound,
   Twin.traced (source "shared/whatsapp-channel" "BroodsWhatsAppAdapter.tenantGraphApi") tenantGraphApi,
   Twin.traced (source "shared/slack-channel" "fetchSlackFile") fetchSlackFile,
   Twin.traced "apps/discord-forwarder/src/forward.ts#forwardMessageCreate" forwardMessageCreate,
   Twin.traced (source "harness/integrations" "handleHttpRequest") handleHttpRequest,
   Twin.traced (source "harness/integrations" "observabilityTicketScope") observabilityTicketScope,
   Twin.traced (source "harness/integrations" "receiveChannelWebhook") receiveChannelWebhook,
   Twin.traced (source "harness/integrations" "handleChannelWebhook") handleChannelWebhook,
   Twin.traced (source "harness/integrations" "acceptChannelTurn") acceptChannelTurn,
   Twin.traced (source "harness/integrations" "processChannelMessage") processChannelMessage]

end Spec.Channels.Wavechannels4a
