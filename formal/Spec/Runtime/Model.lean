import Spec.Statements
import Spec.Access.Model
import Spec.Agent.Model
import Spec.Channels.Model
import Spec.Sandbox.Model

/-!
The whole runtime as one transition system, composed from the subsystems' own decision functions:
`Access.resolve` admits a credential, `Channels.allowedTools` and `selectRefs` narrow a run's tools,
`Agent.gate` and `executes` decide a tool call, `Agent.child` builds a child's principal, and
`Sandbox.select` picks a sandbox. Every input is the attacker's or the scheduler's choice, so a theorem
over all input lists covers every interleaving, crash and duplicate.

Each account's state is separate because stored rows are keyed by an account-prefixed conversation key,
and `assertConversationScope` (`packages/convex/runtimeIngress.ts:1077`) enforces that. The check is
modelled, so `Controls.lean` shows what breaks without it. Queue admission depends on global load, so
its outcome is an input here: `Spec.Workers` bounds the queue, and `LIMITS.md` lists the leak.
-/

namespace Spec.Runtime

abbrev AccountId := Nat
abbrev AgentId := Nat
abbrev RunId := Nat
abbrev ToolId := Nat
abbrev SandboxId := Nat

/-- A conversation key. The code's string embeds the account and agent. -/
structure Conversation where
  account : AccountId
  agent : AgentId
  name : Nat
  deriving DecidableEq, Repr

/-- What Convex holds for one agent: the ceiling of what its runs may use. Trusted, assumption A3. -/
structure AgentConfig where
  account : AccountId
  agent : AgentId
  tools : List ToolId
  sandboxes : List SandboxId
  deriving Repr

/-- All agents' configuration, fixed for a theorem. -/
abbrev Config := List AgentConfig

/-- An agent's configuration, looked up by account and agent together, as `getById` does. -/
def Config.lookup (cfg : Config) (account : AccountId) (agent : AgentId) : Option AgentConfig :=
  cfg.find? fun entry => entry.account == account && entry.agent == agent

/-- Where a run is. -/
inductive Status where
  | queued
  | running
  | finished
  | failed
  deriving DecidableEq, Repr

/-- One run. `root` is the run whose request or delivery started this delegation tree. -/
structure Run where
  id : RunId
  root : RunId
  context : Agent.RunContext
  conversation : Conversation
  tools : List ToolId
  sandboxes : List SandboxId
  status : Status
  deriving DecidableEq, Repr

/-- Everything that can happen. `admitted` is the worker queue's answer, and `verified` is the
signature check's: by assumption A1 it holds only for a sender with that account's secret. -/
inductive Input where
  | request (credential : Access.Credential) (gatewayRequest : Access.Request) (agent : AgentId)
      (conversation : Conversation) (run : RunId) (admitted : Bool)
  | delivery (account : AccountId) (verified : Bool) (agent : AgentId) (conversation : Conversation)
      (run : RunId) (deniedTools : List ToolId) (recordSandboxes : List SandboxId) (admitted : Bool)
  | spawn (account : AccountId) (parent : RunId) (agent : AgentId) (child : RunId)
  | toolCall (account : AccountId) (run : RunId) (tool : ToolId) (sandbox : Option SandboxId)
      (gate : Agent.GateInput) (waiting granted : Bool)
  | reply (account : AccountId) (run : RunId)
  | settle (account : AccountId) (run : RunId)
  | leaseExpired (account : AccountId) (run : RunId)
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

/-- One account's state. `log` is ghost: the inputs addressed to this account, newest first. -/
structure AccountState where
  runs : List Run
  log : List Input

/-- The account an input is addressed to. A credential names its own account, so a request can
never be addressed to an account it holds no credential for. -/
def Input.account : Input → AccountId
  | .request credential _ _ _ _ _ => credential.account
  | .delivery account _ _ _ _ _ _ _ => account
  | .spawn account _ _ _ => account
  | .toolCall account _ _ _ _ _ _ => account
  | .reply account _ => account
  | .settle account _ => account
  | .leaseExpired account _ => account

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

/-- A run is live in this conversation: the coordinator's owner. -/
def busy (runs : List Run) (conversation : Conversation) : Bool :=
  runs.any fun r => r.status == .running && r.conversation == conversation

/-- True if no run has this id yet. -/
def fresh (runs : List Run) (id : RunId) : Bool :=
  !runs.any fun r => r.id == id

/-- Accept a new run: it owns the conversation if it is free, and queues behind the owner if not. -/
def admit (s : AccountState) (run : Run) (account : AccountId) : AccountState × List Effect :=
  if busy s.runs run.conversation then
    ({ s with runs := s.runs ++ [{ run with status := .queued }] },
      [.queued account run.id run.root])
  else
    ({ s with runs := s.runs ++ [{ run with status := .running }] },
      [.started account run.id run.root])

/-- A run with no parent, acting as this agent, with no delegation chain yet. -/
def rootRun (account : AccountId) (agent : AgentId) (conversation : Conversation) (id : RunId)
    (tools : List ToolId) (sandboxes : List SandboxId) : Run where
  id := id
  root := id
  context :=
    { principal := { account := account, agent := agent, chain := some [] }
      cron := false
      delivery := 0
      credential := 0
      userConversation := 0 }
  conversation := conversation
  tools := tools
  sandboxes := sandboxes
  status := .queued

/-- The run with this id, if it is running. -/
def liveRun (runs : List Run) (id : RunId) : Option Run :=
  runs.find? fun r => r.id == id && r.status == .running

/-- The runs with one run's status replaced. -/
def setStatus (runs : List Run) (id : RunId) (status : Status) : List Run :=
  runs.map fun r => if r.id == id then { r with status := status } else r

/-- The oldest queued run in this conversation. -/
def nextQueued (runs : List Run) (conversation : Conversation) : Option Run :=
  runs.find? fun r => r.status == .queued && r.conversation == conversation

/-- End the run, then hand its conversation to the oldest queued run there. -/
def endRun (s : AccountState) (account : AccountId) (run : Run) (status : Status) :
    AccountState × List Effect :=
  let ended := setStatus s.runs run.id status
  match nextQueued ended run.conversation with
  | none => ({ s with runs := ended }, [.ended account run.id run.root status])
  | some n =>
    ({ s with runs := setStatus ended n.id .running },
      [.ended account run.id run.root status, .started account n.id n.root])

/-- One account's step, without the ghost log. Every refusal leaves the state alone. -/
def accountStep (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request credential gatewayRequest agent conversation id admitted =>
    let account := credential.account
    match Access.resolve credential gatewayRequest with
    | none => (s, [])
    | some auth =>
      if Access.authAccount auth != some account then (s, [])
      else if conversation.account != account || conversation.agent != agent then (s, [])
      else
        match cfg.lookup account agent with
        | none => (s, [])
        | some entry =>
          if !fresh s.runs id then (s, [])
          else if !admitted then (s, [.refused account id id])
          else admit s (rootRun account agent conversation id entry.tools entry.sandboxes) account
  | .delivery account verified agent conversation id denied recordSandboxes admitted =>
    if !verified then (s, [])
    else if conversation.account != account || conversation.agent != agent then (s, [])
    else
      match cfg.lookup account agent with
      | none => (s, [])
      | some entry =>
        if !fresh s.runs id then (s, [])
        else if !admitted then (s, [.refused account id id])
        else
          admit s
            (rootRun account agent conversation id (Channels.allowedTools entry.tools denied)
              (Channels.selectRefs entry.sandboxes recordSandboxes))
            account
  | .spawn account parent agent child =>
    match liveRun s.runs parent, cfg.lookup account agent with
    | some p, some entry =>
      if !fresh s.runs child then (s, [])
      else
        admit s
          { id := child
            root := p.root
            context := Agent.child p.context agent
            conversation := { account := account, agent := agent, name := child }
            tools := entry.tools
            sandboxes := entry.sandboxes
            status := .queued }
          account
    | _, _ => (s, [])
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
  | .settle account id =>
    match liveRun s.runs id with
    | none => (s, [])
    | some run => endRun s account run .finished
  | .leaseExpired account id =>
    match liveRun s.runs id with
    | none => (s, [])
    | some run => endRun s account run .failed

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

end Spec.Runtime
