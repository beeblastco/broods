import Spec.Statements
import Spec.Assumptions
import Std

/-! `integrations.ts`, `channel-record.ts`, `commands.ts`, `media.ts`, cronRules and forwarder.
Cryptographic verification is an input under A1. Storage outcomes are inputs under A2/A3.
-/
namespace Spec.Channels

structure Candidate where
  agent : Nat
  verifies : Bool
  eachEntry : Bool
  deriving Repr, DecidableEq

/-- scanChannelCredentialHolder: input is stage-filtered, sorted by agentId and capped at 25. -/
def receivers : List Candidate → List Nat
  | [] => []
  | c :: cs => if c.verifies then c.agent :: (if c.eachEntry then receivers cs else [])
    else receivers cs

/-- applyChannelRecord preserves the agent's original workspace names and writable flags. -/
def selectRefs (agent : List Nat) (record : List Nat) : List Nat :=
  if record.isEmpty then agent else agent.filter (· ∈ record)

/-- applyChannelRecord only unions denials; tools here are the agent's initially allowed tools. -/
def allowedTools (agent denied : List Nat) : List Nat := agent.filter (· ∉ denied)

/-- resolveChannelAgentId: the first default wins, otherwise the first binding. -/
def binding (bindings : List (Nat × Bool)) : Option Nat :=
  ((bindings.find? (fun b => b.2)).orElse (fun _ => bindings.head?)).map Prod.fst

structure Source where
  app : Nat
  channel : Nat
  message : Nat
  incomingThread : Option Nat
  thread : Option Nat
  deriving Repr, DecidableEq

/-- integrations.ts channelReplySource: with no record replyIn the parsed source is kept; Slack's
applyReplyIn keeps an incoming thread, and `thread` opens one on the message. -/
def reply (s : Source) : Option Bool → Source
  | none => s
  | some inThread => { s with thread := if inThread then s.incomingThread.orElse (fun _ => some s.message)
                                        else s.incomingThread }

/-- slack-channel.ts getSlackReplyThreadTs: a mention or a non-DM message opens a thread on the
message unless it arrived in one; any other event keeps the thread it arrived in, if any. -/
def parsedThread (incoming : Option Nat) (message : Nat) (opensThread : Bool) : Option Nat :=
  if opensThread then some (incoming.getD message) else incoming

def opensThread (eventType channelType : String) : Bool :=
  eventType == "app_mention" ||
    (eventType == "message" && channelType != "im" && channelType != "app_home")

/-- Same app and channel, and the thread the message arrived in or a new thread on the message:
the channel root only when the message itself was at the root. -/
def SameConversation (s destination : Source) : Prop :=
  destination.app = s.app ∧ destination.channel = s.channel ∧
  destination.thread ∈ [s.incomingThread, some s.message]

inductive ParseKind where
  | response | ignore | cleanup | context | message
  deriving Repr, DecidableEq

structure Delivery where
  verified : Bool
  kind : ParseKind
  account : Nat
  targetAgent : Nat
  event : Nat
  policyAllows : Bool
  hookDrops : Bool
  capacity : Bool
  deriving Repr

abbrev DeliveryKey := Nat × Nat × Nat
abbrev FireKey := Nat × Nat

structure State where
  deliveries : List DeliveryKey := []
  fires : List FireKey := []
  removed : List Nat := []
  deriving Repr

inductive Input where
  | webhook (d : Delivery)
  | cron (id time : Nat) (present active admitted started : Bool)
  | finish (id : Nat) (oneShot terminal recorded removalSucceeds : Bool)
  deriving Repr

inductive Effect where
  | run (key : DeliveryKey)
  | cronRun (key : FireKey)
  | removeAttempt (id : Nat)
  | removed (id : Nat)
  deriving Repr, DecidableEq

/-- handler.ts scheduled entry and channel admission. The cron branch is decision D7 (a durable
cron/fire-time key), not the code's random event id (G2). -/
def step (s : State) : Input → State × List Effect
  | .webhook d =>
    let key := (d.account, d.targetAgent, d.event)
    if d.verified && d.kind == .message && d.policyAllows && !d.hookDrops && d.capacity
        && !(key ∈ s.deliveries) then
      ({ s with deliveries := key :: s.deliveries }, [.run key])
    else (s, [])
  | .cron id time present active admitted started =>
    if present && active && admitted && started && !((id,time) ∈ s.fires) then
      ({ s with fires := (id,time) :: s.fires }, [.cronRun (id,time)])
    else if present && active && !(admitted && started) then
      (s, [])
    else (s, [])
  | .finish id oneShot terminal recorded removalSucceeds =>
    if oneShot && terminal && recorded then
      ({ s with removed := if removalSucceeds then id :: s.removed else s.removed },
       [.removeAttempt id] ++ if removalSucceeds then [.removed id] else [])
    else (s, [])

def system : Spec.System := ⟨State, Input, Effect, {}, step⟩

/-- media.ts: a valid bearer ticket reveals existence, size/type/cache expiry and GET bytes. -/
def mediaStatus (valid present : Bool) (bytes : Nat) : Nat :=
  if !valid || !present then 404 else if bytes > 25 * 1024 * 1024 then 413 else 200

/-- integrations.ts webhook route for a request no agent verifies. A bare GET answers 200 before
any lookup; a missing or inactive account is 404; a failed listing 503; an endpoint whose stage
lists no agent 404; no adapter that handles the request 200 for a GET, else 503; otherwise 401.
`candidates` (an adapter handles it) implies `configured` in the code. -/
def webhookStatus (get query active available stageKnown candidates : Bool) : Nat :=
  if get && !query then 200 else if !active then 404 else if !available then 503
  else if !stageKnown then 404 else if !candidates then (if get then 200 else 503) else 401

/-- What an unsigned prober controls or can learn anyway. `configured` picks the 503 message
("Webhook <channel> ..."), so it is part of the declared leak. -/
structure Coarse where
  get : Bool
  query : Bool
  active : Bool
  available : Bool
  stageKnown : Bool
  configured : Bool
  candidates : Bool
  deriving Repr, DecidableEq

/-- An unsigned probe: the coarse routing facts, plus every agent's webhook secret. -/
structure Probe where
  coarse : Coarse
  secret : Nat
  deriving Repr

def probeStatus (p : Probe) : Nat :=
  webhookStatus p.coarse.get p.coarse.query p.coarse.active p.coarse.available
    p.coarse.stageKnown p.coarse.candidates

abbrev probeSystem : Spec.System where
  State := Unit
  Input := Probe
  Effect := Nat
  init := ()
  step := fun s p => (s, [probeStatus p])

def probeLeak (ps : List Probe) : List Coarse := ps.map Probe.coarse

/-- The intended at(...) calendar check (G500): the code does not run it, see `atUtc`. -/
def leap (y : Nat) : Bool := y % 400 == 0 || (y % 4 == 0 && y % 100 != 0)

def days (y m : Nat) : Nat :=
  if m = 2 then if leap y then 29 else 28
  else if m ∈ [4,6,9,11] then 30 else 31

structure Calendar where
  year : Nat
  month : Nat
  day : Nat
  hour : Nat
  minute : Nat
  second : Nat
  deriving Repr, DecidableEq

def validDate (d : Calendar) : Bool :=
  d.month ≥ 1 && d.month ≤ 12 && d.day ≥ 1 && d.day ≤ days d.year d.month &&
  d.hour < 24 && d.minute < 60 && d.second < 60

/-- Days from 1970-01-01 to day 1 of month `m` (1-12) of year `y`, proleptic Gregorian. -/
def monthStartDay (y : Int) (m : Nat) : Int :=
  let y := if m ≤ 2 then y - 1 else y
  let era := y / 400
  let yoe := y - era * 400
  let doy : Int := (153 * (if m > 2 then m - 3 else m + 9) + 2) / 5
  era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468

/-- cronRules.ts at(...) with no timezone, as the code runs it (G500): every digit field goes to
Date.UTC, so a year 0-99 means 1900-1999 and out-of-range fields carry into the next unit. Never
rejects. A timezone adds a two-pass offset this model leaves out. -/
def atUtc (d : Calendar) : Int :=
  let year : Int := if d.year ≤ 99 then 1900 + d.year else d.year
  let month : Int := (d.month : Int) - 1
  let start := monthStartDay (year + month / 12) ((month % 12).toNat + 1)
  (start + d.day - 1) * 86400000 + d.hour * 3600000 + d.minute * 60000 + d.second * 1000

/-- Numeric wire fields of at(yyyy-mm-ddThh:mm:ss), after the exact-width syntax check. -/
def dateWire (d : Calendar) : List Nat :=
  [d.year,d.month,d.day,d.hour,d.minute,d.second]

def parseDate : List Nat → Option Calendar
  | [y,m,d,h,n,s] => let c := Calendar.mk y m d h n s
                    if validDate c then some c else none
  | _ => none

/-- rate(...) has positive integral counts and units minute(s), hour(s), day(s). -/
def rate (count unit : Nat) : Option Nat :=
  if count = 0 then none else
    match unit with
    | 0 => some (count * 60000)
    | 1 => some (count * 3600000)
    | 2 => some (count * 86400000)
    | _ => none

inductive Command where
  | newContext | compact | steer | stop | queue | help | unknown
  deriving Repr, DecidableEq

/-- commands.ts: commandToken has already been lowercased and whitespace split. -/
def command (token : String) : Command :=
  if token = "/new" || token = "/clear" then .newContext
  else if token = "/compact" then .compact else if token = "/steer" then .steer
  else if token = "/stop" || token = "/cancel" then .stop
  else if token = "/queue" then .queue else if token = "/help" then .help else .unknown

/-- resolveChannelCommand: compact retains its token even with empty arguments. -/
def commandMode (c : Command) (hasText : Bool) : Nat :=
  match c with
  | .unknown => 0
  | .compact => 2
  | .queue => if hasText then 2 else 3
  | .steer => if hasText then 1 else 3
  | _ => 3

/-- channel-media.ts native-media floor; image is universal, audio/video Google/Vertex only. -/
def nativeMedia (provider : Nat) (media : Nat) : Bool :=
  media == 0 || (media == 1 && provider < 6) || ((media == 2 || media == 3) && provider ≥ 4 && provider < 6)

/-- supervisor.ts reconciles a map keyed by token across all config planes. -/
def socketOwners (tokens : List Nat) : List Nat := tokens.eraseDups

inductive SocketPhase where
  | stopped | connecting | ready | backoff | fatal | exhausted
  deriving Repr, DecidableEq

/-- socket.ts stale socket handles cannot change the owner; fatal codes never schedule reconnect. -/
def socketClose (phase : SocketPhase) (current fatal : Bool) : SocketPhase :=
  if !current || phase == .stopped then phase else if fatal then .fatal else .backoff

/-- channelRules.ts partition aliases are single segments; validation precedes trimming. -/
def aliasValid (s : String) : Bool :=
  !s.isEmpty && s != "." && s != ".." && !(s.contains '/') && !(s.contains '\\')

/-- Normalisation keeps supplied events, otherwise synthesises exactly one user turn. -/
def normaliseEvents (content : String) (events : Option (List String)) : List String :=
  events.getD [content]

/-- channel.message.received changes the latest user text, never the routing source. -/
def rewriteLatest : List (Bool × String) → String → List (Bool × String)
  | [], _ => []
  | (user,text) :: rest, replacement =>
    if rest.any Prod.fst then (user,text) :: rewriteLatest rest replacement
    else if user then (true,replacement) :: rest else (user,text) :: rest

/-- Authenticated adapter boundary: provider decides parse outcome, never bypasses authentication. -/
structure ChannelAdapterContract where
  authenticated : Bool
  parsed : ParseKind
  source : Source
  entryOwner : Nat
  credentialOwner : Nat

/-- Partition/policy/instruction additions do not alter the selected execution agent's ceiling. -/
structure RecordOverlay where
  selectedAgent : Nat
  credentialAgent : Nat
  workspaces : List Nat
  denyTools : List Nat
  addedPolicies : List Nat
  instructions : String
  partition : Option String

/-- Media tickets are symbolic authenticated bearer capabilities under A1, checked on every read. -/
def ticketValid (authentic : Bool) (expiry now : Nat) : Bool := authentic && now < expiry

/-- Bearer observers see status, and with a valid existing small object its metadata and GET body. -/
def mediaView (valid present head : Bool) (size : Nat) (metadata body : String) : Nat × String × String :=
  let status := mediaStatus valid present size
  (status, if status = 200 then metadata else "", if status = 200 && !head then body else "")

/-- cronRules six-field envelope; inner cron syntax belongs to the external scheduler. -/
def cronEnvelope (fields : List String) : Bool :=
  fields.length == 6 && fields.getLast? == some "*" &&
    !(fields.take 5).any (fun f => f.toUpper.contains 'L' || f.toUpper.contains 'W' || f.contains '#')

/-- connections.ts consists of one configured OAuth type and its metadata. -/
def connectionType (s : String) : Bool := s == "chatgpt"

/-- identify-budget.ts uses a strict sliding-window cutoff, separately for each token. -/
def identifyAllowed (stamps : List Nat) (now window limit : Nat) : Bool :=
  (stamps.filter (fun stamp => stamp + window > now)).length < limit

/-- config.ts plane names are case-preserving ASCII alphanumeric/hyphen, unique as strings. -/
def planeNameValid (s : String) : Bool :=
  !s.isEmpty && s.toList.all (fun c => c.isAlphanum && c.toNat < 128 || c == '-')

def planeNamesValid (names : List String) : Bool :=
  !names.isEmpty && names.all planeNameValid && names.eraseDups.length == names.length

/-- socket resume host permits one ASCII label on the literal discord.gg suffix. -/
def resumeLabelValid (s : String) : Bool :=
  !s.isEmpty && s.length ≤ 63 &&
  s.toList.all (fun c => (c.isAlphanum && c.toNat < 128) || c == '-') &&
  (s.toList.head?.getD '-').isAlphanum

end Spec.Channels
