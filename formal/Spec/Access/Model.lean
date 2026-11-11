import Spec.Statements
import Spec.Assumptions

/-! Routing and credential decisions in edge/routes.ts, gateway/main.ts and core/shared/auth.ts. -/
namespace Spec.Access

inductive Route where
  | health | sockets | downloads | config | secretWebhooks | webhooks | media | core
  deriving DecidableEq, Repr

def routeName : Route → String
  | .health => "health" | .sockets => "sockets" | .downloads => "downloads"
  | .config => "config" | .secretWebhooks => "secret-webhooks"
  | .webhooks => "webhooks" | .media => "media" | .core => "core"

def secretPath (r : Route) : Bool :=
  r == .downloads || r == .secretWebhooks || r == .media

def normalized (p : String) : String :=
  let s := String.ofList (p.toList.reverse.dropWhile (· == '/')).reverse
  if s == "" then "/" else s

def segment (s : String) : Bool := s != ""

def socketPath (p : List String) : Bool :=
  match p with
  | ["", "v1", "sandboxes", "terminal", "ws"] => true
  | ["", "v1", "machines", "ws"] => true
  | ["", "v1", "projects", a, "stages", b, "observability", "ws"] => segment a && segment b
  | ["", "v1", "projects", a, "stages", b, "agents", c, "ws"] => segment a && segment b && segment c
  | ["", "v1", "agents", a, "ws"] => segment a
  | _ => false

def configPath (m : String) (p : List String) : Bool :=
  match p with
  | ["", "v1", "account"] => ["GET", "PATCH"].contains m
  | "" :: "v1" :: "account" :: xs => xs != []
  | ["", "v1", "accounts"] => m == "GET"
  | ["", "v1", "accounts", a] => segment a && ["GET", "PATCH"].contains m
  | ["", "v1", "accounts", a, "rotate-secret"] => segment a && m == "POST"
  | ["", "v1", "agents"] => ["GET", "POST"].contains m
  | ["", "v1", "agents", a] => segment a && ["GET", "PATCH", "DELETE"].contains m
  | ["", "v1", "agents", a, "channels", b, "directory"] => segment a && segment b && m == "GET"
  | ["", "v1", "env"] => m == "GET"
  | ["", "v1", "env", a] => segment a && ["PUT", "DELETE"].contains m
  | ["", "v1", "workspaces", a, "download-links"] => segment a && m == "POST"
  | ["", "v1", "audit"] | ["", "v1", "audit", "verify"] => m == "GET"
  | ["", "v1", "usage"] => m == "GET"
  | ["", "v1", "audit", "sink"] => ["GET", "PUT", "DELETE"].contains m
  | ["", "v1", "workspaces", a, "files"] | ["", "v1", "crons", a, "runs"] => segment a
  | ["", "v1", r] => ["skills", "mcp", "hooks", "workspaces", "sandboxes", "policies", "roles", "channels", "crons"].contains r
  | ["", "v1", r, a] => segment a && ["skills", "mcp", "hooks", "workspaces", "sandboxes", "policies", "roles", "channels", "crons"].contains r
  | _ => false

def routeMatches (m path : String) (r : Route) : Bool :=
  let p := (normalized path).splitOn "/"
  match r with
  | .health => m == "GET" && (["/", "/healthz"].contains (normalized path))
  | .sockets => socketPath p
  | .downloads => match p with
    | ["", "v1", "downloads", a] => segment a && ["GET", "HEAD"].contains m
    | _ => false
  | .config => configPath m p
  | .secretWebhooks =>
    -- One match per TypeScript rule, OR-ed like `rules.some`: a failed arm must not hide a later rule.
    (match p with
      | ["", "v1", "webhooks", a, "pancake"] => segment a
      | ["", "v1", "webhooks", a, "dev", b, "pancake"] => segment a && segment b
      | _ => false) ||
    (m == "GET" && match p with | "" :: "v1" :: "webhooks" :: xs => xs != [] | _ => false)
  | .webhooks => match p with | "" :: "v1" :: "webhooks" :: xs => xs != [] | _ => false
  | .media => match p with
    | "" :: "v1" :: "media" :: xs => xs != [] && ["GET", "HEAD"].contains m
    | ["", "v1", "mcp-connections", "callback"] => m == "GET"
    | _ => false
  | .core => (normalized path) == "/mcp" || (normalized path) == "/.well-known/oauth-protected-resource" ||
      (normalized path) == "/.well-known/oauth-protected-resource/mcp" || (match p with | "" :: "v1" :: _ => true | _ => false)

def routeOrder : List Route := [.health, .sockets, .downloads, .config, .secretWebhooks, .webhooks, .media, .core]

def resolveRoute (method path : String) : Option Route :=
  routeOrder.find? (routeMatches method.toUpper path)

inductive Kind where
  | role | stage | run | admin | service | account | runtime | user | terminal | media | unknown | scoped
  | observability | authkit
  deriving DecidableEq, Repr

/-- Token prefixes in shared/auth.ts; `bdob_` is the observability ticket's early return. -/
def classify (s : String) : Kind :=
  if s.startsWith "bsts_" then .role else if s.startsWith "bdts_" then .stage
  else if s.startsWith "bdob_" then .observability
  else if s.startsWith "brt_" then .run else if s.startsWith "bask_" then .account
  else if s.startsWith "bsk_" then .runtime else .unknown

/-- `account` and `stage` are the row's or the signed subject's, never a request field (A3). `stage` is
the deployment scope (endpoint, project and stage) a stage credential belongs to.
`userConversations`: the user token lists its conversations. -/
structure Credential where
  kind : Kind
  account : Nat
  valid : Bool := true
  active : Bool := true
  userPresent : Bool := false
  userValid : Bool := true
  stage : Nat := 0
  userConversations : Bool := false
  deriving Repr

structure Request where
  viaGateway : Bool := false
  allowDisabled : Bool := false
  deriving Repr

inductive Auth where
  | admin | account (id : Nat) (service : Bool) | role (id : Nat) | deployment (id : Nat) | agent (id : Nat)
  deriving DecidableEq, Repr

def authAccount : Auth → Option Nat
  | .admin => none | .account a _ | .role a | .deployment a | .agent a => some a

/-- Storage lookups are trusted A3; `account` is the row or authenticated signed subject, never a request field. -/
def resolve (c : Credential) (r : Request) : Option Auth :=
  if !c.valid then none else
  match c.kind with
  | .admin => some .admin
  | .service => if r.viaGateway || !c.active then none else some (.account c.account true)
  | .account => if c.active || r.allowDisabled then some (.account c.account false) else none
  | .scoped => some (.role c.account)
  | .role => if c.active then some (.role c.account) else none
  | .stage => if c.active then some (.deployment c.account) else none
  | .run => if c.active then some (.agent c.account) else none
  | .runtime => if c.active && (!c.userPresent || c.userValid) then some (.deployment c.account) else none
  | .observability => none
  | _ => none

/-- `mcpAuth` in harness/mcp-tasks.ts: core's own credentials except admin, else an AuthKit token.
For `.authkit`, `valid` is a verified WorkOS subject, `active` that `accounts.getForUser(subject, org)`
did not refuse, and `account` the row it chose from the subject's memberships (A3). -/
def mcpResolve (c : Credential) (r : Request) : Option Auth :=
  match resolve c { r with allowDisabled := false } with
  | some .admin => none
  | some a => some a
  | none => if c.kind == .authkit && c.valid && c.active then some (.account c.account false) else none

inductive Purpose where
  | run | stage | terminal | media | user | observability
  deriving DecidableEq, Repr

/-- A1 abstracts verification and distinct key contexts; terminal canonical encoding is checked separately. -/
structure Ticket where
  purpose : Purpose
  account : Nat
  expires : Nat
  authentic : Bool := true
  wellFormed : Bool := true
  canonical : Bool := true
  deriving Repr

def openTicket (p : Purpose) (now : Nat) (t : Ticket) : Option Nat :=
  if t.purpose == p && t.authentic && t.wellFormed && now < t.expires &&
      (p != .terminal || t.canonical) then some t.account else none

structure ApiRule where
  id : String
  deny : Bool
  actions : List String
  ids : Option (List String) := none
  deriving Repr

structure ApiResource where
  id : Option String := none
  project : Option String := none
  stage : Option String := none
  deriving Repr

def withinPin (project stage : Option String) (r : ApiResource) : Bool :=
  (project.isNone || project == r.project) && (stage.isNone || stage == r.stage)

def ruleMatches (action : String) (r : ApiResource) (rule : ApiRule) : Bool :=
  rule.actions.contains action && (match rule.ids with
    | none => true
    | some ids => ids.contains "*" || (match r.id with | none => false | some id => ids.contains id))

def authorize (project stage : Option String) (rules : List ApiRule) (action : String) (r : ApiResource) : Bool :=
  withinPin project stage r && !(rules.any fun rule => rule.deny && ruleMatches action r rule) &&
    rules.any (fun rule => !rule.deny && ruleMatches action r rule)

def roleTtl (seconds : Option Nat) : Option Nat :=
  match seconds with
  | none => some 3600
  | some n => if 1 ≤ n && n ≤ 43200 then some n else none

def deploymentScopeMatches (auth row : List String) : Bool := auth == row

def userOwns (user : String) (allowed : Option (List String)) (key : String) : Bool :=
  let userPrefix := "bsu:" ++ user ++ ":"
  key.startsWith userPrefix && (key.drop userPrefix.length).toString != "" &&
    (match allowed with | none => true | some xs => xs.contains (key.drop userPrefix.length).toString)

def embeddableReaches (user : Option String) (allowed : Option (List String)) (key : String) : Bool :=
  match user with | none => !key.startsWith "bsu:" | some u => userOwns u allowed key

/-- Public-agent status check order in harness/status-access.ts, including the existence leak. -/
def statusDecision (present isPublic stageTicket scope ingressScope required hasUser owns : Bool) : Nat :=
  if !present || (!isPublic && !stageTicket) then 1
  else if !scope || !ingressScope then 2
  else if stageTicket then 0
  else if required && !hasUser then 3
  else if owns then 0 else 2

/-- Upgrade guard order in gateway/main.ts; terminal invalidity upgrades and closes later. -/
def upgrade (origin blocked capacity terminal machine known token available valid scope expiry : Bool) : Nat :=
  if !origin then 403 else if blocked then 429 else if capacity then 503
  else if terminal then 101 else if !known && !machine then 404
  else if !token then 401 else if machine then 101 else if !available then 502
  else if !valid then 401 else if !expiry then 502 else if !scope then 403 else 101

/-- Public observations before authentication: route, fixed guard error, request id. -/
structure PublicLeak where
  route : Option Route
  guardStatus : Nat
  requestId : String
  deriving DecidableEq, Repr

structure Probe where
  leak : PublicLeak
  tenantSecret : String
  deriving Repr

def publicSystem : Spec.System where
  State := Unit
  Input := Probe
  Effect := PublicLeak
  init := ()
  step := fun s i => (s, [i.leak])

def publicLeaks (xs : List Probe) : List PublicLeak := xs.map (·.leak)

end Spec.Access

namespace Spec.Access

inductive Link where
  | user (id : String) | api (kind : String) | agent (id : String)
  deriving DecidableEq, Repr

def delegatedChain (agent : String) (chain : Option (List Link)) : Option (List Link) :=
  chain.map (· ++ [.agent agent])

def directChain (supplied : Option (List Link)) (cron : Bool) (user : Option String) : Option (List Link) :=
  match supplied with
  | some xs => some xs
  | none => if cron then some [.api "cron"] else user.map (fun u => [.user u])

def principalLabel : Link → String
  | .user id => "user:" ++ id | .api kind => "api:" ++ kind | .agent id => "agent:" ++ id

def coreAccountRoute (method path : String) : Bool :=
  let m := method.toUpper
  match path.splitOn "/" with
  | ["", "v1", "accounts"] => m == "POST"
  | ["", "v1", "accounts", a] => segment a && m == "DELETE"
  | ["", "v1", "account"] => m == "DELETE"
  | ["", "v1", "mcp-service", "rpc"] => m == "POST"
  | ["", "v1", "sandboxes", a, action] => segment a && m == "POST" &&
      ["suspend", "resume", "terminate", "snapshot", "refresh", "exec", "terminal"].contains action
  | _ => false

structure Window where
  start : Nat
  count : Nat
  deriving Repr

def blocked (now width limit : Nat) (window : Option Window) : Bool :=
  match window with | none => false | some w => now < w.start + width && w.count ≥ limit

def hitWindow (now width limit : Nat) (window : Option Window) : Window × Bool :=
  match window with
  | none => (⟨now, 1⟩, true)
  | some w => if now ≥ w.start + width then (⟨now, 1⟩, true)
    else (⟨w.start, w.count + 1⟩, w.count + 1 ≤ limit)

/-- Rendered Traefik priority decreases in table order; only secret paths suppress access logs. -/
def traefikPriority (index : Nat) : Nat := 1000 + routeOrder.length - index

/-- Refusals happen before resource existence is revealed. Provider calls are external inputs. -/
def accountEndpoint (auth : Auth) (allowService : Bool) : Bool :=
  match auth with | .account _ service => !service || allowService | _ => false

/-- Bounded runtime cascade in accounts/cleanup.ts: zero ends deletion, 100 nonzero batches fail. -/
def cleanupBatches : Nat → List Nat → Option Nat
  | 0, _ => none
  | _, [] => none
  | fuel + 1, n :: rest => if n == 0 then some 0 else (cleanupBatches fuel rest).map (n + ·)

end Spec.Access

namespace Spec.Access

/-- Scoped key and user namespace decisions in core/shared/runtime-keys.ts and model/userToken.ts. -/
def accountScopedKey (account key : String) : String := "acct:" ++ account ++ ":" ++ key

def accountAgentScopedKey (account agent key : String) : String :=
  accountScopedKey account ("agent:" ++ agent ++ ":" ++ key)

def parseScopedKey (value : String) : Option (String × String × String) :=
  match value.splitOn ":" with
  | "acct" :: account :: "agent" :: agent :: rest =>
    let key := String.intercalate ":" rest
    if account != "" && agent != "" && key != "" then some (account, agent, key) else none
  | _ => none

def publicConversation (value account : String) (agent : Option String) : String :=
  let p := match agent with
    | none => "acct:" ++ account ++ ":"
    | some a => "acct:" ++ account ++ ":agent:" ++ a ++ ":"
  let unscoped := if value.startsWith p then (value.drop p.length).toString else value
  if unscoped.startsWith "api:" then (unscoped.drop 4).toString else unscoped

def reservedEvents : List String :=
  ["bsu:", "conversation-lease:", "acct:", "api:", "gchat:", "gh:", "linear:", "slack:",
   "slack-command:", "teams:", "tg:", "twilio:", "discord:", "pancake:", "subagent~", "zalo:",
   "instagram:", "messenger:", "whatsapp:"]

def reservedConversations : List String := reservedEvents.filter (fun p => p != "slack-command:" && p != "subagent~")

def validPublicIdentifier (event : Bool) (value : String) : Bool :=
  let v := value.trimAscii.toString
  v != "" && !(if event then reservedEvents else reservedConversations).any (fun p => v.startsWith p)

/-- The subagent row and parent status must both establish exactly the deployment's scope. -/
def subagentStatus (childExists childAccount childEvent childScope childApi parentScope
    parentExists parentPublic stageTicket deployment parentStatus parentEvent ingress required hasUser owns : Bool) : Nat :=
  if !(childExists && childAccount && childEvent && childScope && childApi && parentScope &&
      parentExists && (parentPublic || stageTicket) && deployment && parentStatus && parentEvent && ingress) then 2
  else if stageTicket then 0 else if required && !hasUser then 3 else if owns then 0 else 2

/-- Distinct key contexts in the token modules; signatures/encryption are symbolic under A1. -/
def ticketContext : Purpose → String
  | .run => "broods-run-token"
  | .stage => "stage-session-ticket:"
  | .terminal => "sandbox-terminal-ticket:"
  | .media => "workspace-media-link:"
  | .user => "broods-user-token:"
  | .observability => "observability-read-ticket:"

end Spec.Access

namespace Spec.Access

def retryAfterSeconds (now width : Nat) (window : Option Window) : Nat :=
  match window with | none => 0 | some w => (w.start + width - now + 999) / 1000

def runTtl (workerBudget : Nat) : Nat := min (workerBudget + 300000) 7200000

end Spec.Access

namespace Spec.Access

structure Principal where
  account : String
  agent : String
  chain : Option (List Link)
  deriving Repr

def runPrincipal (account agent : Option String) (chain : Option (List Link)) : Option Principal :=
  match account, agent with
  | some a, some g => if a != "" && g != "" then some ⟨a, g, chain⟩ else none
  | _, _ => none

def channelChain (user : Option String) : Option (List Link) :=
  user.bind fun u => if u == "" then none else some [.user u]

def chainLabel (p : Principal) : Option String :=
  (delegatedChain p.agent p.chain).map (fun xs => String.intercalate ">" (xs.map principalLabel))

def lowerAscii (c : Char) : Bool := 'a' ≤ c && c ≤ 'z'
def upperAscii (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'
def digitAscii (c : Char) : Bool := '0' ≤ c && c ≤ '9'

def camelWords : List Char → Char → List Char
  | [], _ => []
  | c :: cs, prev =>
    let boundary := ((lowerAscii prev || digitAscii prev) && upperAscii c) ||
      (upperAscii prev && upperAscii c && cs.head?.any lowerAscii)
    (if boundary then [' ', c] else [c]) ++ camelWords cs c

def nameWords (name : String) : List String :=
  let expanded := String.ofList (camelWords name.toList ' ')
  let lowered := expanded.toLower.toList.map (fun c => if lowerAscii c || digitAscii c then c else ' ')
  (String.ofList lowered).splitOn " " |>.filter (· != "")

def judgeSecretWords (words : List String) : Bool :=
  let counts := ["cachecreationinputtokens", "cachedinputtokens", "cachereadtokens", "cachewritetokens",
    "inputtokens", "maxoutputtokens", "maxtokens", "nocachetokens", "outputtokens", "reasoningtokens", "texttokens", "totaltokens"]
  let always := ["secret", "password", "passwd", "passphrase", "kubeconfig"]
  let endings := ["apikey", "accesskey", "credential", "credentials", "privatekey", "token"]
  let lastWords := ["secret", "secrets", "password", "passwords", "credential", "credentials", "cookie", "cookies",
    "certificate", "pem", "authorization", "authentication", "auth", "bearer", "token", "tokens", "key", "keys", "apikey", "accesskey", "privatekey"]
  let identifiers := ["cache", "conversation", "destination", "embeddable", "event", "idempotency", "object", "partition",
    "preview", "public", "reservation", "resource", "scope", "sort", "source", "storage", "unscoped"]
  match words.reverse with
  | [] => false
  | last :: rest =>
    if counts.contains (String.join words) then false
    else if words.any (fun word => always.any (fun part => (word.splitOn part).length > 1)) then true
    else if !lastWords.contains last then endings.any (fun ending => last.endsWith ending)
    else if last != "key" && last != "keys" then true
    else rest.head?.any (fun qualifier => !identifiers.contains qualifier)

def isSecretName (name : String) : Bool := judgeSecretWords (nameWords name)

end Spec.Access

namespace Spec.Access

def extractBearer (value : String) : Option String :=
  let words := value.trimAscii.toString.splitOn " " |>.flatMap (fun s => s.splitOn "\t")
    |>.flatMap (fun s => s.splitOn "\n") |>.flatMap (fun s => s.splitOn "\r") |>.filter (· != "")
  match words with
  | [scheme, token] => if scheme.toLower == "bearer" then some token else none
  | _ => none

def claimLastUsed (writes : List (String × Nat)) (key : String) (now interval : Nat) :
    List (String × Nat) × Bool :=
  if writes.any (fun (k, atTime) => k == key && now < atTime + interval) then (writes, false)
  else (((key, now) :: writes.filter (fun (k, atTime) => k != key && now < atTime + interval)), true)

def credentialKind (token : String) (adminMatch serviceMatch via : Bool) : Kind :=
  let kind := classify token
  if kind == .role || kind == .stage || kind == .observability || kind == .run then kind
  else if adminMatch then .admin else if serviceMatch && !via then .service else kind

end Spec.Access
