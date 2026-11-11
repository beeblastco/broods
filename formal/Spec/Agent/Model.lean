import Spec.Statements
import Std

/-! Agent loop decisions from apps/core/src/harness/{policy,harness,session,subagents,usage-metering}.ts. -/
namespace Spec.Agent

inductive Verdict where
  | allow | ask | deny
  deriving DecidableEq, Repr

structure GateInput where
  policy : Verdict
  compatibility : Option Verdict := none
  configuredStandIn : Bool := false
  computer : Bool := false
  deriving Repr

/-- policy.ts:308: translated call is evaluated by policy before compatibility and original-name approval. -/
def gate (waiting : Bool) (i : GateInput) : Verdict × Bool :=
  let status := if i.policy == .deny then .deny else
    i.compatibility.getD (if i.configuredStandIn then .ask else i.policy)
  if !i.computer then (status, waiting)
  else if status == .ask then (.ask, true)
  else if waiting && status != .deny then (.ask, waiting)
  else (status, waiting)

/-- SDK execution contract: absent callback means allow; explicit denial cannot be approved away. -/
def executes (present : Bool) (v : Verdict) (granted : Bool) : Bool :=
  present && (v == .allow || (v == .ask && granted))

/-- broods_authz.rego: blocking enforce deny, then enforce allow-list; audit never opens enforce. -/
def opaAllowed (enforcing blocking enforcingAllow : Bool) : Bool :=
  !blocking && (!enforcing || enforcingAllow)

/-- policy.ts: missing documents enforce deny-all; audit outages pass, unknown mode refuses. -/
def channelInvoke (enabled account audit : Bool) (decision : Option Bool) : Bool :=
  if !enabled || !account then true else decision.getD audit

inductive ToolKind where
  | bash | computer | browse | edit | other
  deriving DecidableEq, Repr

/-- compatibilityApprovalStatus, with workspace/machine permission resolution supplied as input. -/
def compatibility (kind : ToolKind) (invalidSandbox bypass readAction evalMode editAsks configured : Bool) : Option Verdict :=
  let asks := match kind with
    | .bash => invalidSandbox || !bypass
    | .computer => !readAction && !bypass
    | .browse => evalMode && !bypass
    | .edit => editAsks
    | .other => configured
  if asks then some .ask else none

structure Principal where
  account : Nat
  agent : Nat
  chain : Option (List Nat)
  deriving DecidableEq, Repr

structure RunContext where
  principal : Principal
  cron : Bool
  delivery : Nat
  credential : Nat
  userConversation : Nat
  deriving DecidableEq, Repr

/-- subagents.ts:1214: principal account, trigger and delivery flags come only from parent. -/
def child (p : RunContext) (agent : Nat) : RunContext :=
  { p with principal := {
      account := p.principal.account
      agent := agent
      chain := p.principal.chain.map (fun chain => chain ++ [p.principal.agent]) } }

/-- Schedule tool availability is determined before policy: cron cannot install these tools. -/
def scheduleTools (scheduler cron : Bool) : Bool := scheduler && !cron

inductive Part where
  | text (value : Nat)
  | reasoning (value : Nat)
  | call (id : Nat) (providerExecuted : Bool)
  | request (id approval : Nat)
  | result (id : Nat)
  deriving DecidableEq, Repr

structure Item where
  part : Part
  storedId : Option Nat := none
  deriving DecidableEq, Repr

/-- session.ts:2158: pending approval and provider-executed calls are intentional exceptions. -/
def resolved (results pending : List Nat) : Part → Bool
  | .call id provider => provider || results.contains id
  | .request id approval => results.contains id || pending.contains approval
  | _ => true

/-- session.ts:2141: cross-model projection drops reasoning and OpenAI stored item ids. -/
def strip (items : List Item) : List Item :=
  items.filterMap fun item => match item.part with
    | .reasoning _ => none
    | _ => some { item with storedId := none }

/-- Projection repairs unresolved assistant content and clears stored items on changed messages. -/
def project (sameModel : Bool) (results pending : List Nat) (items : List Item) : List Item :=
  let kept := items.filter (fun item => resolved results pending item.part)
  if sameModel && kept.length == items.length then kept else strip kept

/-- compaction.ts:62: disabling compaction takes priority even over overflow. -/
def autoCompact (enabled overflow : Bool) (last : Option Nat) (threshold : Nat := 500000) : Bool :=
  enabled && (overflow || (last.map (fun n => decide (threshold ≤ n))).getD false)

inductive Split where
  | fail | truncate (chars : Nat) | halves (older newer : Nat)
  deriving DecidableEq, Repr

/-- summarizeBlocks: only length refusals split; a merge refusal propagates, never retries the merge. -/
def splitSummary (lengthError : Bool) (blocks chars : Nat) : Split :=
  if !lengthError then .fail
  else if blocks == 1 then
    if chars < 1000 then .fail else .truncate (chars / 2)
  else .halves ((blocks + 1) / 2) (blocks / 2)

structure Deadline where
  winding : Bool := false
  yielded : Bool := false
  deriving DecidableEq, Repr

/-- deadline-policy.ts: absent/early/pending-question returns without changing either flag. -/
def deadline (s : Deadline) (due canYield : Bool) (questions steps maxTurn : Nat) : Bool × Deadline :=
  if !due || questions > 0 then (false, s)
  else
    let yields := canYield && (maxTurn == 0 || steps < maxTurn)
    (yields, { winding := !yields, yielded := yields })

inductive Stop where
  | none | maxTurn | question | yielded | stopped | stale | abort | providerError | finished
  deriving DecidableEq, Repr

/-- harness.ts:843 and prepareStep: first matching stop, with stream terminal events as inputs. -/
def stopReason (maxTurn steps : Nat) (question yielded stopped stale aborted failed finished : Bool) : Stop :=
  if maxTurn != 0 && steps ≥ maxTurn then .maxTurn
  else if question then .question
  else if yielded then .yielded
  else if stopped then .stopped
  else if stale then .stale
  else if aborted then .abort
  else if failed then .providerError
  else if finished then .finished else .none

/-- Finite completed-step fuel; zero maxTurn represents the explicitly unlimited setting. -/
def remaining (maxTurn slots steps : Nat) : Nat := maxTurn * slots - steps

structure Usage where
  input : Nat := 0
  output : Nat := 0
  reasoning : Nat := 0
  cached : Nat := 0
  writes : Nat := 0
  total : Nat := 0
  deriving DecidableEq, Repr

def addUsage (a b : Usage) : Usage :=
  ⟨a.input+b.input, a.output+b.output, a.reasoning+b.reasoning,
   a.cached+b.cached, a.writes+b.writes, a.total+b.total⟩

structure Totals where
  usage : Usage := {}
  steps : Nat := 0
  writes : Nat := 0
  deriving DecidableEq, Repr

inductive MeterEvent where
  | step (number : Nat) (tokens : Usage) (fallback : Nat)
  | compact (tokens : Usage)
  | finish (tokens : Usage) (steps : Nat)
  deriving DecidableEq, Repr

/-- usage-metering.ts:createTaskTotals: finish replaces nonzero totals; cache-write fallback is separate. -/
def meter (s : Totals) : MeterEvent → Totals
  | .step n u fallback =>
    { usage := addUsage s.usage u
      steps := n+1
      writes := s.writes + (if u.writes == 0 then fallback else u.writes) }
  | .compact u => { s with usage := addUsage s.usage u, writes := s.writes + u.writes }
  | .finish u n =>
    { s with
      steps := n
      usage := if u.input+u.output+u.reasoning+u.cached+u.writes+u.total > 0 then u else s.usage }

abbrev RunEvent := Nat × MeterEvent

def ownEvents (run : Nat) (events : List RunEvent) : List MeterEvent :=
  (events.filter (fun e => e.1 == run)).map Prod.snd

def runUsage (run : Nat) (events : List RunEvent) : Totals :=
  (ownEvents run events).foldl meter {}

/-- A metering system emits one run-local snapshot after each own event, for Spec.Private. -/
def usageSystem : Spec.System where
  State := List RunEvent
  Input := RunEvent
  Effect := Nat × Totals
  init := []
  step := fun s e => let next := s ++ [e]; (next, [(e.1, runUsage e.1 next)])

/-- plan-limits.ts: budget precedes rate and unavailable/unenforced budgets fail open. -/
def admit (enforced : Bool) (percent runs cap : Nat) : Nat :=
  if !enforced then 0 else if percent ≥ 100 then 402 else if runs ≥ cap then 429 else 0

/-- provider.ts retryingMiddleware catches creation errors once; stream error frames do not retry. -/
def recoveryAttempts (creationError recoverable : Bool) : Nat :=
  if creationError && recoverable then 2 else 1

/-- hook-runner.ts: mutable field whitelist, prior to shallow last-writer merge in dispatcher. -/
def hookFields (event : String) : List String :=
  if event == "agent.started" then ["system", "messages"]
  else if event == "agent.finished" then ["output"]
  else if event == "agent.approval.required" then ["approve"]
  else if event == "tool.call.started" then ["decision", "args", "denyReason"]
  else if event == "tool.result" then ["output"]
  else if event == "subagent.task.finished" then ["visibleResult"]
  else if event == "channel.message.received" then ["drop", "text", "metadata"]
  else if event == "channel.message.sending" then ["drop", "text"] else []

def hookResult (event : String) (fields : List (String × Nat)) : List (String × Nat) :=
  fields.filter (fun field => (hookFields event).contains field.1)

/-- harnessSessionEntries.ts: pre-insertion split; an oversized single entry remains a singleton. -/
def entryBatches (sizes : List Nat) (rows : Nat := 100) (bytes : Nat := 4194304) : List (List Nat) :=
  let state := sizes.foldl (fun (s : List (List Nat) × List Nat × Nat) size =>
    if s.2.1.length ≥ rows || (s.2.2 > 0 && s.2.2 + size > bytes) then
      (s.1 ++ [s.2.1], [size], size)
    else (s.1, s.2.1 ++ [size], s.2.2 + size)) ([], [], 0)
  state.1 ++ [state.2.1]

/-- modelPricing.ts: rates in millionths, using natural quantities to avoid floating approximation. -/
def tokenCostNumerator (input output cached writes ri ro rc rw : Nat) : Nat :=
  (input - cached - writes)*ri + output*ro + cached*rc + writes*rw

/-- Completed work transitions; blocked external operations are absent ticks, not hidden termination. -/
abbrev fuelSystem (budget : Nat) : Spec.System where
  State := Nat
  Input := Unit
  Effect := Unit
  init := budget
  step := fun n _ => (n-1, if n == 0 then [] else [()])

/-- A recording boundary emits run-tagged events; aggregation is strictly local. -/
abbrev recordingSystem : Spec.System where
  State := Unit
  Input := RunEvent
  Effect := RunEvent
  init := ()
  step := fun _ e => ((), [e])

/-- subagentResults.ts uses the final separator, so ids may themselves contain colons. -/
def handbackKey (asyncTool : Bool) (id status : String) : String :=
  (if asyncTool then "async-tool:" else "subagent:") ++ id ++ ":" ++ status

def terminalStatus (status : String) : Bool :=
  status == "completed" || status == "failed" || status == "awaiting_input"

def parseHandback (key : String) : Option (Bool × String × String) :=
  let parts := key.splitOn ":"
  match parts with
  | tag :: rest =>
    let status := rest.getLastD ""
    let id := String.intercalate ":" (rest.take (rest.length-1))
    if (tag == "subagent" || tag == "async-tool") && !id.isEmpty && terminalStatus status
    then some (tag == "async-tool", id, status) else none
  | [] => none

/-- modelPricing.ts ordered provider aliases: Bedrock takes priority over Anthropic. -/
def canonicalProvider (provider : String) : String :=
  let p := provider.toLower
  if (p.splitOn "bedrock").length > 1 then "bedrock"
  else if (p.splitOn "anthropic").length > 1 then "anthropic"
  else if ["google", "vertex", "gemini"].any (fun key => (p.splitOn key).length > 1) then "google"
  else if ["openai", "azure"].any (fun key => (p.splitOn key).length > 1) then "openai"
  else p

/-- planLimits.ts budgetLevel and capsReached use inclusive thresholds. -/
def budgetLevel (percent : Nat) : Nat := if percent ≥ 100 then 2 else if percent ≥ 80 then 1 else 0

def capsReached (sandbox mcp storage egress percent : Nat) : Bool × Bool :=
  (storage ≥ percent, sandbox ≥ percent || mcp ≥ percent || egress ≥ percent)

/-- takeHarnessEntryBatch checks limits after inserting, including on the last available row. -/
def takeEntryBatch (sizes : List Nat) (rows bytes : Nat) : List Nat × Bool :=
  let rec go (rest kept : List Nat) (used : Nat) : List Nat × Bool :=
    match rest with
    | [] => (kept, false)
    | size :: tail =>
      let next := kept ++ [size]
      if next.length ≥ rows || used + size ≥ bytes then (next, true)
      else go tail next (used+size)
  go sizes [] 0

/-- withdrawYield clears only the yielded flag; windingDown is left untouched. -/
def withdrawYield (s : Deadline) : Deadline := { s with yielded := false }

/-- Subagents are one level deep: child config disables delegation; calls admit 1..10 tasks. -/
def childDelegationEnabled : Bool := false

def validTaskCount (n : Nat) : Bool := 1 ≤ n && n ≤ 10

def messageTurnAllowed (used : Nat) : Bool := used < 40

/-- Raw persistence appends calls before an approval result exists; projection supplies SDK repair. -/
def persistRaw (stored incoming : List Item) : List Item := stored ++ incoming

/-- Pending requests resolve their call id, and provider-executed calls are independent of results. -/
def resolutionIds (parts : List Part) (pending : List Nat) : List Nat :=
  parts.filterMap fun part => match part with
    | .result id => some id
    | .request id approval => if pending.contains approval then some id else none
    | _ => none

/-- Full assistant projection receives resolution ids extracted from the whole conversation. -/
def projectConversation (sameModel : Bool) (parts : List Part) (pending : List Nat) (assistant : List Item) : List Item :=
  project sameModel (resolutionIds parts pending) pending assistant

structure ExecutionInput where
  waiting : Bool
  call : GateInput
  present : Bool
  granted : Bool

/-- One original-call execution boundary; successful effects have the gate decision as their witness. -/
abbrev executionSystem : Spec.System where
  State := Unit
  Input := ExecutionInput
  Effect := Unit
  init := ()
  step := fun _ i => ((), if executes i.present (gate i.waiting i.call).1 i.granted then [()] else [])

def executionJustified (i : ExecutionInput) (_ : Unit) : Prop :=
  executes i.present (gate i.waiting i.call).1 i.granted = true

end Spec.Agent
