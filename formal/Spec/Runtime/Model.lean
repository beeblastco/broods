import Spec.Statements
import Spec.Access.Model
import Spec.Agent.Model
import Spec.Channels.Model
import Spec.Sandbox.Model

/-!
The whole runtime as one transition system, composed from the subsystems' own decision functions:
`Access.resolve` (or `Access.mcpResolve` on `/mcp`) admits a credential, `Channels.allowedTools` and `selectRefs` narrow a run's tools,
`Agent.gate` and `executes` decide a tool call, `Agent.child` builds a child's principal, and
`Sandbox.select` picks a sandbox. Every input is the attacker's or the scheduler's choice, so a theorem
over all input lists covers every interleaving, crash and duplicate.

Each account's state is separate because stored rows are keyed by an account-prefixed conversation key,
and `assertConversationScope` (`packages/convex/runtimeIngress.ts:1129`) enforces that. The check is
modelled, so `Controls.lean` shows what breaks without it. Queue admission depends on global load, so
its outcome is an input here: `Spec.Workers` bounds the queue, and `LIMITS.md` lists the leak.
-/

namespace Spec.Runtime

abbrev AccountId := Nat
abbrev AgentId := Nat
abbrev RunId := Nat
abbrev ToolId := Nat
abbrev SandboxId := Nat
abbrev StageId := Nat

/-- A conversation key. The code's string embeds the account and agent. -/
structure Conversation where
  account : AccountId
  agent : AgentId
  name : Nat
  deriving DecidableEq, Repr

/-- What Convex holds for one agent: the ceiling of what its runs may use. Trusted, assumption A3.
`deny` is `denyTools`; `stage` names the deployment scope (endpoint, project and stage) the agent is
deployed to; `subagents` is `none` without `subagent.enabled`, else the `subagent.allowed` list. -/
structure AgentConfig where
  account : AccountId
  agent : AgentId
  tools : List ToolId
  sandboxes : List SandboxId
  deny : List ToolId := []
  stage : StageId := 0
  publicAccess : Bool := false
  requireUserToken : Bool := false
  subagents : Option (List AgentId) := none
  deriving Repr

/-- All agents' configuration, fixed for a theorem. -/
abbrev Config := List AgentConfig

/-- An agent's configuration, looked up by account and agent together, as `getById` does. -/
def Config.lookup (cfg : Config) (account : AccountId) (agent : AgentId) : Option AgentConfig :=
  cfg.find? fun entry => entry.account == account && entry.agent == agent

/-- Where a run is. `running` holds the conversation's owner lease; `detached` runs without one, as a
non-persistent subagent does (`subagents.ts`, it skips ingress). -/
inductive Status where
  | queued
  | running
  | detached
  | finished
  | failed
  deriving DecidableEq, Repr

/-- One run. `root` is the run whose request or delivery started this delegation tree, `parent` the run
that spawned it. `configAgent` is the agent whose config row the run's tools come from: its own agent,
except for a virtual subagent, which runs on its parent's. `deny` is what it and its children may not
use, and `subagents` what it may spawn. -/
structure Run where
  id : RunId
  root : RunId
  parent : Option RunId
  context : Agent.RunContext
  conversation : Conversation
  configAgent : AgentId
  tools : List ToolId
  sandboxes : List SandboxId
  deny : List ToolId
  subagents : Option (List AgentId)
  status : Status
  deriving DecidableEq, Repr

/-- How a run request reaches `integrations.ts` `routeRequest`. `directApi` is the operator's switch.
`urlStage` is the stage a scoped URL names: `/v1/projects/{p}/stages/{s}/agents/{e}` and
`/v1/agents/{endpointId}` both set it, and both refuse an account key. `mcp` is a `/mcp` tool call,
which replays `POST /v1/runs` with the caller `mcpAuth` resolved (`handler.ts`, `mcp-tasks.ts`
`startRun`), so an AuthKit sign-in arrives as an account key there; its `urlStage` is none in the
code. The credential's own stage is `Access.Credential.stage`, never a route field. -/
structure DirectRoute where
  directApi : Bool := true
  urlStage : Option StageId := none
  mcp : Bool := false
  deriving Repr

/-- What admission decides beside the conversation's owner: `admitted` is the worker queue's answer,
`rejectIfBusy` the `reject` mode, and `queueFull` the queued count or bytes at their cap. -/
structure Arrival where
  admitted : Bool := true
  rejectIfBusy : Bool := false
  queueFull : Bool := false
  deriving Repr

/-- What a parent asks to spawn: an allowed agent on its own config, or a virtual child on the
parent's config, named by its fresh `virtual_subagent_…` agent id. -/
inductive SpawnTarget where
  | named (agent : AgentId)
  | virtual (agent : AgentId)
  deriving Repr

/-- How core settles a run and hands its conversation on, which decides what an inactive account
keeps (`insertOwnedEvents` and `writeAsyncAgentResult` run `requireActiveAccount`; the session retries
a refused settle without its history rows). `drain`: settle, then `takeNext` with no rows (direct,
async and WebSocket runs, `settleFailedIngressAndDrain`). `inline`: `takeNext` carries the settle and
the turn's rows (channel turns, queued command turns, `dispatchNextIngress` with a settle that
throws to a caller that releases the lease). `background`: a drain whose settle also carries the
background run's `asyncResult`. -/
inductive Handoff where
  | drain
  | inline
  | background
  deriving DecidableEq, Repr

/-- The status a settle leaves. An inactive account's history rows are dropped and the outcome
kept, except a background run's: its settle is refused whole, so its envelope stays `processing`
until `maintain` expires it, here `failed`. -/
def settledStatus (active : Bool) (handoff : Handoff) (failed : Bool) : Status :=
  if !active && handoff == .background then .failed else if failed then .failed else .finished

/-- Whether core hands the conversation on: always, except an inline hand-off in an inactive
account, whose `takeNext` throws to a caller that releases the lease (handler.ts channel loop,
`runCommandTurn`); the queue then waits, and `recover` skips the account. -/
def handsOn (active : Bool) (handoff : Handoff) : Bool :=
  active || handoff != .inline

/-- Everything that can happen. `verified` is the signature check's answer: by assumption A1 it holds
only for a sender with that account's secret. `settle` is a settle, finished or failed, then the
hand-off its `Handoff` names; `boundary` is a step-boundary write carrying history rows
(`stepBoundary`), which an inactive account refuses, so the run fails and core settles it through
the same hand-off; `release`
is `releaseOwner` or a lease that ran out; `expire` drops a queued message past its time to live
(TTL alone, as today's code does, G1; `Spec.Runs` states the intended D6 rule); `recover` is one
`recoverQueued` sweep reaching a conversation, which skips an inactive account and leaves its queue
unowned until `expire`; `status` is the operator activating or suspending the
account (its row is trusted, A3). -/
inductive Input where
  | request (credential : Access.Credential) (gatewayRequest : Access.Request) (route : DirectRoute)
      (agent : AgentId) (conversation : Conversation) (run : RunId) (arrival : Arrival)
  | delivery (account : AccountId) (verified : Bool) (agent : AgentId) (conversation : Conversation)
      (run : RunId) (deniedTools : List ToolId) (recordSandboxes : List SandboxId) (arrival : Arrival)
  | spawn (account : AccountId) (parent : RunId) (target : SpawnTarget) (child : RunId)
      (persistent : Bool) (arrival : Arrival)
  | toolCall (account : AccountId) (run : RunId) (tool : ToolId) (sandbox : Option SandboxId)
      (gate : Agent.GateInput) (waiting granted : Bool)
  | reply (account : AccountId) (run : RunId)
  | settle (account : AccountId) (run : RunId) (failed : Bool) (handoff : Handoff)
  | boundary (account : AccountId) (run : RunId) (handoff : Handoff)
  | release (account : AccountId) (run : RunId)
  | expire (account : AccountId) (run : RunId)
  | recover (account : AccountId) (conversation : Conversation)
  | status (account : AccountId) (active : Bool)
  deriving Repr

/-- What the outside world can see, always naming the account it happens on. -/
inductive Effect where
  | started (account : AccountId) (run root : RunId)
  | queued (account : AccountId) (run root : RunId)
  | refused (account : AccountId) (run root : RunId)
  | toolExecuted (account : AccountId) (agent : AgentId) (run root : RunId) (tool : ToolId)
      (sandbox : SandboxId)
  | replied (account : AccountId) (conversation : Conversation) (run root : RunId)
  | ended (account : AccountId) (run root : RunId) (status : Status)
  deriving DecidableEq, Repr

/-- One account's state. `active` is the account row's status; `log` is ghost: the inputs addressed to
this account, newest first. -/
structure AccountState where
  runs : List Run
  log : List Input
  active : Bool := true

/-- The account an input is addressed to. A credential names its own account, so a request can
never be addressed to an account it holds no credential for. -/
def Input.account : Input → AccountId
  | .request credential _ _ _ _ _ _ => credential.account
  | .delivery account _ _ _ _ _ _ _ => account
  | .spawn account _ _ _ _ _ => account
  | .toolCall account _ _ _ _ _ _ => account
  | .reply account _ => account
  | .settle account _ _ _ => account
  | .boundary account _ _ => account
  | .release account _ => account
  | .expire account _ => account
  | .recover account _ => account
  | .status account _ => account

/-- Whether an input goes through ingress `accept` or a `recoverQueued` sweep, both of which skip an
inactive account. A non-persistent child skips ingress (`detach`). -/
def Input.viaIngress : Input → Bool
  | .request .. | .delivery .. | .recover .. => true
  | .spawn _ _ _ _ persistent _ => persistent
  | _ => false

/-- The account an effect happens on. -/
def Effect.account : Effect → AccountId
  | .started account _ _ => account
  | .queued account _ _ => account
  | .refused account _ _ => account
  | .toolExecuted account _ _ _ _ _ => account
  | .replied account _ _ _ => account
  | .ended account _ _ _ => account

/-- The root run an effect belongs to. -/
def Effect.root : Effect → RunId
  | .started _ _ root => root
  | .queued _ _ root => root
  | .refused _ _ root => root
  | .toolExecuted _ _ _ root _ _ => root
  | .replied _ _ _ root => root
  | .ended _ _ root _ => root

/-- A run holds this conversation's owner lease (`hasActiveOwner`). -/
def busy (runs : List Run) (conversation : Conversation) : Bool :=
  runs.any fun r => r.status == .running && r.conversation == conversation

/-- True if no run has this id yet. -/
def fresh (runs : List Run) (id : RunId) : Bool :=
  !runs.any fun r => r.id == id

/-- The runs with one run's status replaced. -/
def setStatus (runs : List Run) (id : RunId) (status : Status) : List Run :=
  runs.map fun r => if r.id == id then { r with status := status } else r

/-- The oldest queued run in this conversation. -/
def nextQueued (runs : List Run) (conversation : Conversation) : Option Run :=
  runs.find? fun r => r.status == .queued && r.conversation == conversation

/-- The run with this id, if it is executing, with or without the owner lease. -/
def liveRun (runs : List Run) (id : RunId) : Option Run :=
  runs.find? fun r => r.id == id && (r.status == .running || r.status == .detached)

/-- The run with this id, if it holds its conversation's owner lease. -/
def ownerRun (runs : List Run) (id : RunId) : Option Run :=
  runs.find? fun r => r.id == id && r.status == .running

/-- The run with this id, if it is queued. -/
def queuedRun (runs : List Run) (id : RunId) : Option Run :=
  runs.find? fun r => r.id == id && r.status == .queued

/-- A credential as the run path resolves it: `mcpAuth` on `/mcp` (core's credentials except admin,
else an AuthKit sign-in as an account key), `resolve` everywhere else. `allowDisabledAccountSecret` is
passed only for account self-delete (`accounts/handler.ts:170`), never here. -/
def startAuth (credential : Access.Credential) (gatewayRequest : Access.Request) (route : DirectRoute) :
    Option Access.Auth :=
  if route.mcp then Access.mcpResolve credential gatewayRequest
  else Access.resolve credential { gatewayRequest with allowDisabled := false }

/-- Whether a resolved credential may start a run of `entry` over the direct API
(`integrations.ts` `routeRequest` and `admitStageCredential`). Only an account key (or the service
token) or a stage credential starts a run; a run token, a role session, a scoped key and the admin key
never do. A scoped URL takes only a stage credential of that stage. A stage credential reaches only
agents of its own stage, and the embeddable key (`bsk_`) only public ones, with a user token where the
agent requires one; a member's stage ticket (`bdts_`) also reaches private ones. On `/mcp` an
embeddable key whose user token lists its conversations runs no agent (`listRunnableAgents`: a task
always opens a fresh conversation). -/
def mayStart (credential : Access.Credential) (auth : Access.Auth) (route : DirectRoute)
    (entry : AgentConfig) : Bool :=
  route.directApi &&
    match auth with
    | .account _ _ => route.urlStage.isNone
    | .deployment _ =>
      route.urlStage.all (· == credential.stage) && entry.stage == credential.stage &&
        (!route.mcp || credential.kind == .stage || !credential.userConversations) &&
        (credential.kind == .stage ||
          (entry.publicAccess && (!entry.requireUserToken || credential.userPresent)))
    | _ => false

/-- A run with no parent, acting as this agent on its config row, its tools narrowed by `deny`. -/
def rootRun (account : AccountId) (agent : AgentId) (conversation : Conversation) (id : RunId)
    (entry : AgentConfig) (deny : List ToolId) (sandboxes : List SandboxId) : Run where
  id := id
  root := id
  parent := none
  context :=
    { principal := { account := account, agent := agent, chain := some [] }
      cron := false
      delivery := 0
      credential := 0
      userConversation := 0 }
  conversation := conversation
  configAgent := agent
  tools := Channels.allowedTools entry.tools deny
  sandboxes := sandboxes
  deny := deny
  subagents := entry.subagents
  status := .queued

/-- The run a direct request asks for, if the credential, route, agent and conversation pass. -/
def requestRun (cfg : Config) (credential : Access.Credential) (gatewayRequest : Access.Request)
    (route : DirectRoute) (agent : AgentId) (conversation : Conversation) (id : RunId) : Option Run :=
  let account := credential.account
  match startAuth credential gatewayRequest route, cfg.lookup account agent with
  | some auth, some entry =>
    if Access.authAccount auth == some account && mayStart credential auth route entry &&
        conversation.account == account && conversation.agent == agent then
      some (rootRun account agent conversation id entry entry.deny entry.sandboxes)
    else none
  | _, _ => none

/-- The run a verified channel delivery asks for. The channel record's denials join the agent's. -/
def deliveryRun (cfg : Config) (account : AccountId) (verified : Bool) (agent : AgentId)
    (conversation : Conversation) (id : RunId) (denied : List ToolId) (recordSandboxes : List SandboxId) :
    Option Run :=
  match cfg.lookup account agent with
  | some entry =>
    if verified && conversation.account == account && conversation.agent == agent then
      some (rootRun account agent conversation id entry (entry.deny ++ denied)
        (Channels.selectRefs entry.sandboxes recordSandboxes))
    else none
  | none => none

/-- The child a live run may spawn (`subagents.ts` `resolveChild`): none unless the parent has
`subagent.enabled` and a named target is in its `subagent.allowed`. The child gets the parent's
`denyTools` on top of its own, and delegation off (`tools/utils.ts` `subagentConfig`). -/
def childRun (cfg : Config) (account : AccountId) (p : Run) (target : SpawnTarget) (id : RunId) :
    Option Run :=
  match p.subagents, target with
  | none, _ => none
  | some allowed, .named agent =>
    if allowed.contains agent then
      (cfg.lookup account agent).map fun entry =>
        { id := id
          root := p.root
          parent := some p.id
          context := Agent.child p.context agent
          conversation := { account := account, agent := agent, name := id }
          configAgent := agent
          tools := Channels.allowedTools entry.tools (p.deny ++ entry.deny)
          sandboxes := entry.sandboxes
          deny := p.deny ++ entry.deny
          subagents := none
          status := .queued }
    else none
  | some _, .virtual agent =>
    some
      { id := id
        root := p.root
        parent := some p.id
        context := Agent.child p.context agent
        conversation := { account := account, agent := agent, name := id }
        configAgent := p.configAgent
        tools := p.tools
        sandboxes := p.sandboxes
        deny := p.deny
        subagents := none
        status := .queued }

/-- Hand a free conversation to its oldest queued run (`promoteQueuedGroup`). Nothing if it has an
owner or nothing queued. -/
def promote (s : AccountState) (account : AccountId) (conversation : Conversation) :
    AccountState × List Effect :=
  if busy s.runs conversation then (s, [])
  else
    match nextQueued s.runs conversation with
    | none => (s, [])
    | some n => ({ s with runs := setStatus s.runs n.id .running }, [.started account n.id n.root])

/-- Accept a new run (`accept`): first promote work queued with no owner, then own the conversation
if it is free, or queue behind the owner, or be refused in `reject` mode or at the queue's cap. -/
def admit (s : AccountState) (run : Run) (account : AccountId) (arrival : Arrival) :
    AccountState × List Effect :=
  let first := promote s account run.conversation
  if busy first.1.runs run.conversation then
    if arrival.rejectIfBusy || arrival.queueFull then
      (first.1, first.2 ++ [.refused account run.id run.root])
    else
      ({ first.1 with runs := first.1.runs ++ [{ run with status := .queued }] },
        first.2 ++ [.queued account run.id run.root])
  else
    ({ first.1 with runs := first.1.runs ++ [{ run with status := .running }] },
      first.2 ++ [.started account run.id run.root])

/-- A new run reaches ingress: an inactive account's is refused (`accept` throws in
`requireActiveAccount`), a reused id is ignored, and the worker queue may refuse it. -/
def arrive (s : AccountState) (run : Run) (account : AccountId) (arrival : Arrival) :
    AccountState × List Effect :=
  if !s.active then (s, [])
  else if !fresh s.runs run.id then (s, [])
  else if !arrival.admitted then (s, [.refused account run.id run.root])
  else admit s run account arrival

/-- A non-persistent child starts at once, outside ingress, holding no owner lease. -/
def detach (s : AccountState) (run : Run) (account : AccountId) : AccountState × List Effect :=
  if !fresh s.runs run.id then (s, [])
  else ({ s with runs := s.runs ++ [{ run with status := .detached }] }, [.started account run.id run.root])

/-- Settle a run and, if it held the owner lease and `handOn`, hand its conversation on (`takeNext`). -/
def endRun (s : AccountState) (account : AccountId) (run : Run) (status : Status) (handOn : Bool) :
    AccountState × List Effect :=
  let ended : AccountState := { s with runs := setStatus s.runs run.id status }
  let next := if handOn && run.status == .running then promote ended account run.conversation
    else (ended, [])
  (next.1, .ended account run.id run.root status :: next.2)

/-- One account's step, without the ghost log. Every refusal leaves the state alone. -/
def accountStep (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request credential gatewayRequest route agent conversation id arrival =>
    match requestRun cfg credential gatewayRequest route agent conversation id with
    | none => (s, [])
    | some run => arrive s run credential.account arrival
  | .delivery account verified agent conversation id denied recordSandboxes arrival =>
    match deliveryRun cfg account verified agent conversation id denied recordSandboxes with
    | none => (s, [])
    | some run => arrive s run account arrival
  | .spawn account parent target child persistent arrival =>
    match liveRun s.runs parent with
    | none => (s, [])
    | some p =>
      match childRun cfg account p target child with
      | none => (s, [])
      | some c => if persistent then arrive s c account arrival else detach s c account
  | .toolCall account id tool sandbox gateInput waiting granted =>
    match liveRun s.runs id with
    | none => (s, [])
    | some run =>
      let verdict := (Agent.gate waiting gateInput).1
      if !Agent.executes (run.tools.contains tool) verdict granted then (s, [])
      else
        match Sandbox.select run.sandboxes sandbox with
        | none => (s, [])
        | some chosen =>
          (s, [.toolExecuted account run.context.principal.agent id run.root tool chosen])
  | .reply account id =>
    match liveRun s.runs id with
    | none => (s, [])
    | some run => (s, [.replied account run.conversation id run.root])
  | .settle account id failed handoff =>
    match liveRun s.runs id with
    | none => (s, [])
    | some run =>
      endRun s account run (settledStatus s.active handoff failed) (handsOn s.active handoff)
  | .boundary account id handoff =>
    match ownerRun s.runs id with
    | none => (s, [])
    | some run =>
      if s.active then (s, []) else endRun s account run .failed (handsOn s.active handoff)
  | .release account id =>
    match ownerRun s.runs id with
    | none => (s, [])
    | some run =>
      ({ s with runs := setStatus s.runs id .failed }, [.ended account id run.root .failed])
  | .expire account id =>
    match queuedRun s.runs id with
    | none => (s, [])
    | some run =>
      ({ s with runs := setStatus s.runs id .failed }, [.ended account id run.root .failed])
  | .recover account conversation => if s.active then promote s account conversation else (s, [])
  | .status _ active => ({ s with active := active }, [])

/-- The whole runtime's state: accounts never share a row. -/
abbrev World := AccountId → AccountState

/-- One step: only the addressed account changes, and the input joins its ghost log. -/
def step (cfg : Config) (w : World) (i : Input) : World × List Effect :=
  let account := i.account
  let result := accountStep cfg (w account) i
  (fun a => if a = account then { result.1 with log := i :: (w account).log } else w a, result.2)

/-- The runtime before any input. -/
def emptyWorld : World :=
  fun _ => { runs := [], log := [] }

/-- The runtime as a transition system. -/
def system (cfg : Config) : Spec.System where
  State := World
  Input := Input
  Effect := Effect
  init := emptyWorld
  step := step cfg

/-- An account's inputs. -/
def ownInputs (a : AccountId) (trace : List Input) : List Input :=
  trace.filter fun i => i.account == a

/-- What an account sees: the effects that happen on it. -/
def viewOf (a : AccountId) (effects : List Effect) : List Effect :=
  effects.filter fun e => e.account == a

/-- One account run alone on its own inputs. -/
def localRun (cfg : Config) (s : AccountState) : List Input → AccountState × List Effect
  | [] => (s, [])
  | i :: rest =>
    let next := accountStep cfg s i
    let later := localRun cfg { next.1 with log := i :: s.log } rest
    (later.1, next.2 ++ later.2)

end Spec.Runtime
