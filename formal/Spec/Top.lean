import Spec.Runtime.All
import Spec.Workers.Theorems

/-!
The main theorems of the Broods runtime. Read these first, with `Statements.lean`, `Assumptions.lean` and
`Runtime/Model.lean`, whose definitions they name. Nothing is proved here: each only quotes a theorem
below it, as FlashProve's top file does, so a reader sees the claims without the proofs.

Each theorem is about the Lean model, over every input list. `LIMITS.md` says what that does not give.
-/

namespace Spec.Top

open Spec.Runtime

/-- **Soundness.** Every effect on an account traces to an earlier input authorising that account: a
verified delivery, or a request whose credential may start that agent's run (`mayStart`: an account key,
the service token or, through `/mcp`, an AuthKit sign-in; or a stage credential of the agent's stage,
public agents only for the embeddable key). Credential checks are inputs, so this is true by
construction (`LIMITS.md` L22). Late-result resumes and `message_agents` turns are not modelled (L9).
Assumes A1, A3. -/
theorem sound (cfg : Config) (trace : List Input) (i : Input) (e : Effect)
    (he : e ∈ ((system cfg).step ((system cfg).final trace) i).2) :
    ∃ w ∈ trace ++ [i], Authorizes cfg w e.account e.root :=
  sound_effects cfg trace i e he

/-- **Who never starts runs.** A run token, a role session, a scoped key and the admin key never start
a run, over the direct API or through `/mcp`. An AuthKit sign-in starts runs only through `/mcp`
(`authkit_only_through_mcp`). -/
theorem restrictedNeverStart (cfg : Config) (s : AccountState) (c : Access.Credential)
    (r : Access.Request) (route : DirectRoute) (ag : AgentId) (conv : Conversation) (id : RunId)
    (arrival : Arrival)
    (hkind : c.kind = .run ∨ c.kind = .role ∨ c.kind = .scoped ∨ c.kind = .admin) :
    accountStep cfg s (.request c r route ag conv id arrival) = (s, []) :=
  restricted_never_start cfg s c r route ag conv id arrival hkind

/-- **Tenant isolation.** Every run of an account holds only that account's conversation and
principal, and the tools and sandboxes of one agent configured in that account (its own, or its
parent's for a virtual subagent), never a tool that agent denies. Assumes A2 and A3. -/
theorem tenantIsolation (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ r ∈ (w a).runs,
      r.conversation.account = a ∧ r.context.principal.account = a ∧
        ∃ entry, cfg.lookup a r.configAgent = some entry ∧
          (∀ t ∈ r.tools, t ∈ entry.tools ∧ t ∉ entry.deny) ∧
          (∀ x ∈ r.sandboxes, x ∈ entry.sandboxes) :=
  tenant_isolation cfg

/-- **Bounded delegation.** A spawned run's parent is a root run with subagents enabled; the child
cannot delegate again, runs no tool its parent denies, and is an allowed agent or a virtual child. -/
theorem delegationBounded (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ c ∈ (w a).runs, ∀ pid, c.parent = some pid →
      ∃ p ∈ (w a).runs, p.id = pid ∧ p.parent = none ∧ c.subagents = none ∧
        (∀ t ∈ c.tools, t ∉ p.deny) ∧ ∃ allowed, p.subagents = some allowed ∧
          (c.configAgent ∈ allowed ∨ c.configAgent = p.configAgent) :=
  delegation_bounded cfg

/-- **Privacy.** What an account observes is fixed by its own inputs. Shared capacity and timing leak by
design: `LIMITS.md`, L8. -/
theorem tenantPrivate (cfg : Config) :
    Spec.Private (system cfg) AccountId Unit Effect (fun _ => True) ownInputs (fun _ => ()) viewOf :=
  tenant_private cfg

/-- **One owner.** At most one run holds a conversation's owner lease, in any interleaving. Assumes
A2. -/
theorem oneOwner (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ x ∈ (w a).runs, ∀ y ∈ (w a).runs,
      x.status = .running → y.status = .running → x.conversation = y.conversation → x = y :=
  conversation_exclusive cfg

/-- **Tools.** A tool runs only if its run is executing, the tool is the run's own, the gate passed it,
and the sandbox is the run's. One step, read off the `toolCall` branch (`LIMITS.md` L22); the content is
in `tenantIsolation` and `delegationBounded`, which bound a run's tools. By decision D5 this covers the
model's original call, not arguments a hook later rewrites. The code fences a lost lease at step
boundaries, later than this model ends the run (`LIMITS.md` L21). -/
theorem toolGated (cfg : Config) (s : AccountState) (a : AccountId) (id : RunId) (t : ToolId)
    (sb : Option SandboxId) (g : Agent.GateInput) (waiting granted : Bool) (e : Effect)
    (he : e ∈ (accountStep cfg s (.toolCall a id t sb g waiting granted)).2) :
    ∃ run ∈ s.runs, run.id = id ∧ (run.status = .running ∨ run.status = .detached) ∧ t ∈ run.tools ∧
      Agent.executes true (Agent.gate waiting g).1 granted = true ∧
      ∃ chosen ∈ run.sandboxes,
        e = .toolExecuted a run.context.principal.agent id run.root t chosen :=
  tool_call_gated cfg s a id t sb g waiting granted e he

/-- **Queues recover the lease.** Queued work can be left without an owner (a released lease hands
nothing on: `queue_can_strand`), but after any input list ending in a recovery sweep that reaches the
conversation while its account is active, a run there holds the lease whenever one is queued. One
`promote` step (`LIMITS.md` L22). Holding the lease is not running: a shed recovery dispatch fails the
work (G201), and an inactive account's queue stays unowned until it expires. A port must keep the
sweep. -/
theorem queueRecovers (cfg : Config) (a : AccountId) (c : Conversation) :
    Spec.Progress (system cfg) (fun _ => True)
      (fun s schedule => ∃ pre, schedule = pre ++ [.recover a c] ∧
        (((system cfg).runFrom s pre).1 a).active = true)
      (fun _ => True)
      (fun w => ∀ r ∈ (w a).runs, r.status = .queued → r.conversation = c →
        busy (w a).runs c = true) :=
  recover_drains cfg a c

/-- **Completeness.** A request whose credential may start the agent's run, of an active account, with
a fresh run id, to a free conversation with nothing queued, and admitted by the worker queue (`{}`),
starts its run, so soundness is not true merely because the runtime refuses everything. -/
theorem servedStarts (cfg : Config) (s : AccountState) (c : Access.Credential) (r : Access.Request)
    (route : DirectRoute) (ag : AgentId) (conv : Conversation) (id : RunId) (auth : Access.Auth)
    (entry : AgentConfig)
    (hres : startAuth c r route = some auth) (hauth : Access.authAccount auth = some c.account)
    (hmay : mayStart c auth route entry = true)
    (hscope : conv.account = c.account) (hagent : conv.agent = ag)
    (hlookup : cfg.lookup c.account ag = some entry) (hactive : s.active = true)
    (hfresh : fresh s.runs id = true)
    (hfree : busy s.runs conv = false) (hempty : nextQueued s.runs conv = none) :
    Effect.started c.account id id ∈ (accountStep cfg s (.request c r route ag conv id {})).2 :=
  served_request_starts cfg s c r route ag conv id auth entry hres hauth hmay hscope hagent hlookup
    hactive hfresh hfree hempty

/-- **Slots.** The pod never holds more than `MAX_INPROCESS_WORKERS` slots, in any interleaving. This
bounds the slot counter, not the work executing: after an overrun the slot is freed while a run that
ignores the abort keeps executing (`worker-queue.ts`). -/
theorem slotsBounded {L : Workers.Limits} (hSlots : 0 < L.maxSlots) :
    Spec.Always (Workers.system L) (fun s => s.active ≤ L.maxWorkers) :=
  Workers.slots_bounded hSlots

/-- **No starvation.** A waiting run takes a slot once as many inputs free one as stand ahead of
it, whatever else arrives, yields or holds places. The endings are assumed (the slot timer). -/
theorem noStarvation {L : Workers.Limits} (hSlots : 0 < L.maxSlots) (r : Workers.RunId) (u k : Nat) :
    Spec.Progress (Workers.system L) (fun _ => True)
      (fun s schedule => k + 1 ≤ Workers.slotsFreed L s schedule)
      (fun s => r ∈ s.pending ∧ s.pending.idxOf r = k ∧ s.phase r = .waiting u)
      (fun s => Workers.started u (s.phase r) = true) :=
  Workers.progress hSlots r u k

end Spec.Top
