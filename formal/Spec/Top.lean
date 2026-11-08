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
credential that resolved to it, or a delivery whose signature verified. Assumes A1 and A3. -/
theorem sound (cfg : Config) (trace : List Input) (i : Input) (e : Effect)
    (he : e ∈ ((system cfg).step ((system cfg).final trace) i).2) :
    ∃ w ∈ trace ++ [i], Authorizes w e.account e.root :=
  sound_effects cfg trace i e he

/-- **Tenant isolation.** Every run of an account holds only that account's conversation, principal,
agent, tools and sandboxes. Assumes A2 and A3. -/
theorem tenantIsolation (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ r ∈ (w a).runs,
      r.conversation.account = a ∧ r.context.principal.account = a ∧
        ∃ entry, cfg.lookup a r.context.principal.agent = some entry ∧
          (∀ t ∈ r.tools, t ∈ entry.tools) ∧ (∀ x ∈ r.sandboxes, x ∈ entry.sandboxes) :=
  tenant_isolation cfg

/-- **Privacy.** What an account observes is fixed by its own inputs. Shared capacity and timing leak by
design: `LIMITS.md`, L8. -/
theorem tenantPrivate (cfg : Config) :
    Spec.Private (system cfg) AccountId Unit Effect (fun _ => True) ownInputs (fun _ => ()) viewOf :=
  tenant_private cfg

/-- **One owner.** At most one run is running per conversation, in any interleaving. Assumes A2. -/
theorem oneOwner (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ x ∈ (w a).runs, ∀ y ∈ (w a).runs,
      x.status = .running → y.status = .running → x.conversation = y.conversation → x = y :=
  conversation_exclusive cfg

/-- **Tools.** A tool runs only if it is the run's own, the gate passed it, and the sandbox is the run's.
By decision D5 this covers the model's original call, not arguments a hook later rewrites. -/
theorem toolGated (cfg : Config) (s : AccountState) (a : AccountId) (id : RunId) (t : ToolId)
    (sb : Option SandboxId) (g : Agent.GateInput) (waiting granted : Bool) (e : Effect)
    (he : e ∈ (accountStep cfg s (.toolCall a id t sb g waiting granted)).2) :
    ∃ run ∈ s.runs, run.id = id ∧ run.status = .running ∧ t ∈ run.tools ∧
      Agent.executes true (Agent.gate waiting g).1 granted = true ∧
      ∃ chosen ∈ run.sandboxes,
        e = .toolExecuted a run.context.principal.agent id run.root t chosen :=
  tool_call_gated cfg s a id t sb g waiting granted e he

/-- **No stranded queue.** A queued run always has a running owner to hand it on. -/
theorem queueHasOwner (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ r ∈ (w a).runs, r.status = .queued →
      ∃ o ∈ (w a).runs, o.status = .running ∧ o.conversation = r.conversation :=
  queue_never_stranded cfg

/-- **Completeness.** A served request starts its run, so soundness is not true merely because the
runtime refuses everything. -/
theorem servedStarts (cfg : Config) (s : AccountState) (c : Access.Credential) (r : Access.Request)
    (ag : AgentId) (conv : Conversation) (id : RunId) (auth : Access.Auth) (entry : AgentConfig)
    (hres : Access.resolve c r = some auth) (hauth : Access.authAccount auth = some c.account)
    (hscope : conv.account = c.account) (hagent : conv.agent = ag)
    (hlookup : cfg.lookup c.account ag = some entry) (hfresh : fresh s.runs id = true)
    (hfree : busy s.runs conv = false) :
    Effect.started c.account id id ∈ (accountStep cfg s (.request c r ag conv id true)).2 :=
  served_request_starts cfg s c r ag conv id auth entry hres hauth hscope hagent hlookup hfresh hfree

/-- **Slots.** The pod never holds more than `MAX_INPROCESS_WORKERS` slots, in any interleaving. -/
theorem slotsBounded {L : Workers.Limits} (hSlots : 0 < L.maxSlots) :
    Spec.Always (Workers.system L) (fun s => s.active ≤ L.maxWorkers) :=
  Workers.slots_bounded hSlots

/-- **No starvation.** A waiting run leaves the queue after as many runs end as stand ahead of it. -/
theorem noStarvation {L : Workers.Limits} (hSlots : 0 < L.maxSlots) (r : Workers.RunId) (k : Nat) :
    Spec.Progress (Workers.system L) (fun _ => True)
      (fun s schedule => Workers.Releasing L s schedule ∧ k + 1 ≤ schedule.length)
      (fun s => r ∈ s.pending ∧ s.pending.idxOf r = k)
      (fun s => ∀ m, s.phase r ≠ .waiting m) :=
  Workers.progress hSlots r k

end Spec.Top
