import Spec.Runtime.Proofs

/-!
The whole runtime's own claims, over every input list: every interleaving, crash, duplicate and attacker
choice the model has. `Spec.Top` names the ones a reader should start with.
-/

namespace Spec.Runtime

/-- The invariant of the whole world. -/
def WorldInv (cfg : Config) (w : World) : Prop :=
  ∀ a, Inv cfg a (w a).log (w a).runs

/-- The invariant holds initially and every input keeps it. A lemma the `Always` theorems below use. -/
theorem inductive_world (cfg : Config) : Spec.Inductive (system cfg) (WorldInv cfg) := by
  constructor
  · intro a
    exact ⟨by simp [system, emptyWorld], by simp [system, emptyWorld], by simp [system, emptyWorld],
      by simp [system, emptyWorld]⟩
  · intro w i h a
    change Inv cfg a ((Spec.Runtime.step cfg w i).1 a).log ((Spec.Runtime.step cfg w i).1 a).runs
    simp only [Spec.Runtime.step]
    by_cases ha : a = i.account
    · subst ha
      simp only [ite_true]
      exact inv_accountStep cfg (w i.account) i (h i.account)
    · simp only [ha, ite_false]
      exact h a

/-- The facts one step's effect can rely on: which run it acted for, in the state before the step. -/
theorem effect_of_step (cfg : Config) (s : AccountState) (i : Input) (e : Effect)
    (h : Inv cfg i.account s.log s.runs)
    (he : e ∈ (accountStep cfg s i).2) :
    e.account = i.account ∧ ∃ w ∈ i :: s.log, Authorizes cfg w e.account e.root := by
  obtain ⟨hacc, ⟨r, hr, hroot⟩ | hauth⟩ := step_effect cfg s i e he
  · obtain ⟨w, hw, ha⟩ := (h.stable r hr).origin
    refine ⟨hacc, w, List.mem_cons_of_mem _ hw, ?_⟩
    rw [hacc, hroot]
    exact ha
  · exact ⟨hacc, i, List.mem_cons_self, hauth⟩

/-- An effect's authorising input, read from the inputs so far and never from later ones. -/
noncomputable def authorisingInput (cfg : Config) (trace : List Input) (e : Effect) : Option Input :=
  open Classical in trace.find? fun w => decide (Authorizes cfg w e.account e.root)

/-- **Soundness.** Every effect on an account traces to an input, no later than the effect, that
started that effect's root run and authorises that account: a verified delivery, or a request whose
credential may start that agent's run (`mayStart`: an account key, the service token or, on `/mcp`, an
AuthKit sign-in; or a stage credential of the agent's stage, public agents only for the embeddable
key; with the direct API on). Late-result resumes and `message_agents` turns are not inputs (L9).
Credential resolution and signature checks are inputs here (A1, A3), so this shows the runtime acts
only through those checks; `LIMITS.md` L22. -/
theorem sound_effects (cfg : Config) (trace : List Input) (i : Input) (e : Effect)
    (he : e ∈ ((system cfg).step ((system cfg).final trace) i).2) :
    ∃ w ∈ trace ++ [i], Authorizes cfg w e.account e.root := by
  have hinv := (inductive_world cfg).always _ ⟨trace, rfl⟩ i.account
  have he' : e ∈ (accountStep cfg (((system cfg).final trace) i.account) i).2 := he
  obtain ⟨hAcc, w, hw, ha⟩ := effect_of_step cfg _ i e hinv he'
  refine ⟨w, ?_, ha⟩
  rcases List.mem_cons.1 hw with heq | hold
  · exact List.mem_append_right _ (by simp [heq])
  · rcases log_of_trace cfg i.account trace emptyWorld w hold with hstart | htrace
    · simp [emptyWorld] at hstart
    · exact List.mem_append_left _ htrace

/-- `sound_effects` in the general shape of `Spec.Sound`. -/
theorem sound (cfg : Config) :
    Spec.Sound (system cfg) (fun _ => True) Input (fun w e => Authorizes cfg w e.account e.root) := by
  refine ⟨authorisingInput cfg, ?_⟩
  intro trace i _ e he
  obtain ⟨w, hw, ha⟩ := sound_effects cfg trace i e he
  have found : (authorisingInput cfg (trace ++ [i]) e).isSome = true := by
    unfold authorisingInput
    apply List.find?_isSome.2
    exact ⟨w, hw, by simpa using ha⟩
  obtain ⟨x, hx⟩ := Option.isSome_iff_exists.1 found
  refine ⟨x, hx, ?_⟩
  have sat := List.find?_some hx
  simpa using sat

/-- **Tenant isolation.** In every reachable state, each of an account's runs has that account's
conversation and principal, and uses only tools and sandboxes of one agent configured in that account
(its own agent, or its parent's for a virtual subagent), never a tool that agent denies. -/
theorem tenant_isolation (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ r ∈ (w a).runs,
      r.conversation.account = a ∧ r.context.principal.account = a ∧
        ∃ entry, cfg.lookup a r.configAgent = some entry ∧
          (∀ t ∈ r.tools, t ∈ entry.tools ∧ t ∉ entry.deny) ∧
          (∀ x ∈ r.sandboxes, x ∈ entry.sandboxes) := by
  intro w reach a r hr
  have stable := ((inductive_world cfg).always w reach a).stable r hr
  exact ⟨stable.conversationAccount, stable.principalAccount, stable.attached⟩

/-- **Bounded delegation.** In every reachable state, a spawned run's parent is a root run that had
`subagent.enabled`; the child cannot delegate again, runs no tool its parent denies, and is either an
agent in the parent's `subagent.allowed` list or a virtual child on the parent's config. -/
theorem delegation_bounded (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ c ∈ (w a).runs, ∀ pid, c.parent = some pid →
      ∃ p ∈ (w a).runs, p.id = pid ∧ p.parent = none ∧ c.subagents = none ∧
        (∀ t ∈ c.tools, t ∉ p.deny) ∧ ∃ allowed, p.subagents = some allowed ∧
          (c.configAgent ∈ allowed ∨ c.configAgent = p.configAgent) := by
  intro w reach a c hc pid hpid
  exact ((inductive_world cfg).always w reach a).children c hc pid hpid

/-- **One owner per conversation.** At most one run holds a conversation's owner lease, in every
reachable state, across crashes, duplicates and any order of input. -/
theorem conversation_exclusive (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ x ∈ (w a).runs, ∀ y ∈ (w a).runs,
      x.status = .running → y.status = .running → x.conversation = y.conversation → x = y := by
  intro w reach a
  exact ((inductive_world cfg).always w reach a).exclusive

/-- **Queues can strand.** A queued run does not always have an owner: when the owner's lease is
released (a failed hand-off, shutdown, a shed dispatch's `requeue`) nothing promotes the queue. Request 7 owns, request 8 queues,
7 is released, and 8 waits with no owner until a recovery sweep or a new arrival. -/
theorem queue_can_strand :
    ¬ Spec.Always (system [{ account := 1, agent := 2, tools := [3], sandboxes := [4] }])
      fun w => ∀ a, ∀ r ∈ (w a).runs, r.status = .queued →
        ∃ o ∈ (w a).runs, o.status = .running ∧ o.conversation = r.conversation := by
  intro holds
  let key : Access.Credential := { kind := .account, account := 1 }
  let conversation : Conversation := { account := 1, agent := 2, name := 0 }
  let trace : List Input :=
    [.request key {} {} 2 conversation 7 {}, .request key {} {} 2 conversation 8 {}, .release 1 7]
  have state := holds _ ⟨trace, rfl⟩ 1
  let entry : AgentConfig := { account := 1, agent := 2, tools := [3], sandboxes := [4] }
  obtain ⟨o, ho, hs, _⟩ := state { rootRun 1 2 conversation 8 entry [] [4] with status := .queued }
    (by
      simp [trace, System.final, System.runFrom, system, step, accountStep, requestRun, startAuth,
        Access.resolve, Access.authAccount, mayStart, Config.lookup, arrive, fresh, admit, promote,
        busy, nextQueued, ownerRun, setStatus, emptyWorld, Input.account, key, conversation, rootRun,
        entry])
    rfl
  simp [trace, System.final, System.runFrom, system, step, accountStep, requestRun, startAuth,
    Access.resolve, Access.authAccount, mayStart, Config.lookup, arrive, fresh, admit, promote, busy,
    nextQueued, ownerRun, setStatus, emptyWorld, Input.account, key, conversation, rootRun] at ho
  rcases ho with rfl | rfl <;> simp at hs

/-- **Recovery hands the lease on.** After any input list that ends with a recovery sweep reaching
conversation `c` (`recoverQueued`, every 30 seconds per pod) while its account is active, a run of `c`
holds the owner lease whenever one is queued there. An inactive account's sweep is skipped
(`Controls.inactive_queue_stays_unowned`). Holding the lease is not running: the pod dispatches the
promoted work with no queue place, a shed dispatch puts it back in the queue (`requeue`) for the next
sweep or arrival, and queued work may expire before a sweep (`expire`). -/
theorem recover_drains (cfg : Config) (a : AccountId) (c : Conversation) :
    Spec.Progress (system cfg) (fun _ => True)
      (fun s schedule => ∃ pre, schedule = pre ++ [.recover a c] ∧
        (((system cfg).runFrom s pre).1 a).active = true)
      (fun _ => True)
      (fun w => ∀ r ∈ (w a).runs, r.status = .queued → r.conversation = c →
        busy (w a).runs c = true) := by
  intro trace _ _ schedule ⟨pre, hs, hactive⟩ r hr hq hc
  subst hs
  have last := runFrom_snoc (system cfg) ((system cfg).final trace) pre (Input.recover a c)
  rw [last] at hr ⊢
  change r ∈ ((Spec.Runtime.step cfg _ (.recover a c)).1 a).runs at hr
  change busy ((Spec.Runtime.step cfg _ (.recover a c)).1 a).runs c = true
  have hactive' : (((system cfg).runFrom ((system cfg).final trace) pre).1 a).active = true := hactive
  simp only [Spec.Runtime.step, Input.account, ite_true, accountStep, hactive'] at hr ⊢
  exact promote_busy hr hq hc

/-- An inactive account admits nothing through ingress: a request, a delivery, a persistent child and
a recovery sweep all leave its state alone (`requireActiveAccount` in `accept`, the status check in
`recoverQueued`). Its running runs lose their history rows, and no hand-off starts its queue
(`inactive_starts_nothing`). -/
theorem inactive_admits_nothing (cfg : Config) (s : AccountState) (i : Input)
    (hs : s.active = false) (hi : i.viaIngress = true) : accountStep cfg s i = (s, []) := by
  cases i with
  | request c r route ag conv id arr =>
    simp only [accountStep]
    split
    · rfl
    · simp [arrive, hs]
  | delivery a v ag conv id den rec arr =>
    simp only [accountStep]
    split
    · rfl
    · simp [arrive, hs]
  | spawn a pid target ch persistent arr =>
    simp only [Input.viaIngress] at hi
    simp only [accountStep, hi, ite_true]
    split
    · rfl
    · split
      · rfl
      · simp [arrive, hs]
  | recover a c => simp [accountStep, hs]
  | _ => simp [Input.viaIngress] at hi

/-- A tool runs only if its run is executing, the tool is one of the run's, the gate passed it, and
the sandbox is the run's. A lemma about one step, from the definition of the `toolCall` branch. -/
theorem tool_call_gated (cfg : Config) (s : AccountState) (a : AccountId) (id : RunId) (t : ToolId)
    (sb : Option SandboxId) (g : Agent.GateInput) (waiting granted : Bool) (e : Effect)
    (he : e ∈ (accountStep cfg s (.toolCall a id t sb g waiting granted)).2) :
    ∃ run ∈ s.runs, run.id = id ∧ (run.status = .running ∨ run.status = .detached) ∧ t ∈ run.tools ∧
      Agent.executes true (Agent.gate waiting g).1 granted = true ∧
      ∃ chosen ∈ run.sandboxes,
        e = .toolExecuted a run.context.principal.agent id run.root t chosen := by
  simp only [accountStep] at he
  split at he
  · simp at he
  · rename_i run hr
    obtain ⟨mem, hid, live⟩ := liveRun_some hr
    split at he
    · simp at he
    · rename_i hexec
      have hexec' : Agent.executes (run.tools.contains t) (Agent.gate waiting g).1 granted = true := by
        simpa using hexec
      have present : run.tools.contains t = true := by
        simp only [Agent.executes, Bool.and_eq_true] at hexec'
        exact hexec'.1
      rw [present] at hexec'
      split at he
      · simp at he
      · rename_i chosen hselect
        simp only [List.mem_singleton] at he
        refine ⟨run, mem, hid, live, by simpa using present, hexec', chosen, ?_, ?_⟩
        · unfold Sandbox.select at hselect
          split at hselect
          · exact List.mem_of_head? hselect
          · split at hselect
            · cases hselect
              assumption
            · simp at hselect
        · exact he

/-- An inactive account starts nothing on any path: no input emits a start, and every run that holds
an owner lease after the step held it before. Ingress and recovery refuse the account, a
non-persistent child's result row is refused before it starts (`detach`), and every hand-off's
`takeNext` promotes nothing there, whatever the hand-off. -/
theorem inactive_starts_nothing (cfg : Config) (s : AccountState) (i : Input)
    (hs : s.active = false) :
    (∀ e ∈ (accountStep cfg s i).2, ∀ a r root, e ≠ .started a r root) ∧
      ∀ r ∈ (accountStep cfg s i).1.runs, r.status = .running → r ∈ s.runs := by
  by_cases via : i.viaIngress = true
  · rw [inactive_admits_nothing cfg s i hs via]
    exact ⟨by simp, fun r hr _ => hr⟩
  have ended : ∀ a run st, st ≠ .running →
      (∀ e ∈ (endRun s a run st false).2, ∀ a r root, e ≠ .started a r root) ∧
        ∀ r ∈ (endRun s a run st false).1.runs, r.status = .running → r ∈ s.runs := by
    intro a run st hst
    refine ⟨fun e he a' r root h => ?_, fun r hr hrun => ?_⟩
    · simp only [endRun, Bool.false_and, Bool.false_eq_true, ite_false, List.mem_cons,
        List.not_mem_nil, or_false] at he
      subst he
      cases h
    · simp only [endRun, Bool.false_and, Bool.false_eq_true, ite_false] at hr
      exact setStatus_running hst hr hrun
  have unchanged : (∀ e ∈ ([] : List Effect), ∀ a r root, e ≠ .started a r root) ∧
      ∀ r ∈ s.runs, r.status = .running → r ∈ s.runs := ⟨by simp, fun r hr _ => hr⟩
  have failedNot : (Status.failed) ≠ .running := by decide
  cases i with
  | request c r route ag conv id arr => simp [Input.viaIngress] at via
  | delivery a v ag conv id den rec arr => simp [Input.viaIngress] at via
  | recover a c => simp [Input.viaIngress] at via
  | spawn a pid target ch persistent arr =>
    cases persistent
    · simp only [accountStep, ite_false, Bool.false_eq_true]
      split
      · exact unchanged
      · split
        · exact unchanged
        · simp only [detach, hs, Bool.not_false, Bool.true_or, ite_true]
          exact unchanged
    · simp [Input.viaIngress] at via
  | toolCall a id t sb g wt gr =>
    simp only [accountStep]
    refine ⟨?_, ?_⟩
    · intro e he a' r root h
      subst h
      repeat' (first | split at he | simp at he)
    · intro r hr _
      repeat' (first | split at hr | exact hr)
  | reply a id =>
    simp only [accountStep]
    split
    · exact unchanged
    · exact ⟨by simp, fun r hr _ => hr⟩
  | settle a id failed handoff =>
    simp only [accountStep, hs]
    split
    · exact unchanged
    · exact ended _ _ _ (by unfold settledStatus; split <;> (try split) <;> decide)
  | boundary a id handoff =>
    simp only [accountStep, hs]
    split
    · exact unchanged
    · exact ended _ _ _ failedNot
  | release a id =>
    simp only [accountStep]
    split
    · exact unchanged
    · exact ⟨by simp, fun r hr hrun => setStatus_running failedNot hr hrun⟩
  | requeue a id =>
    simp only [accountStep]
    split
    · exact unchanged
    · exact ⟨by simp, fun r hr hrun => setStatus_running (by decide) hr hrun⟩
  | expire a id =>
    simp only [accountStep]
    split
    · exact unchanged
    · exact ⟨by simp, fun r hr hrun => setStatus_running failedNot hr hrun⟩
  | status a b => exact ⟨by simp [accountStep], fun r hr _ => hr⟩

/-- A shed dispatch loses no run: `requeue` of the run holding its conversation's lease keeps every
run id in the same order, queues that run again in its place, and leaves the conversation without an
owner, so the next recovery sweep or arrival promotes it (`recover_drains`). -/
theorem requeue_returns_to_queue (cfg : Config) (s : AccountState) (a : AccountId) (id : RunId)
    (run : Run) (hrun : ownerRun s.runs id = some run) :
    let t := (accountStep cfg s (.requeue a id)).1
    t.runs.map (·.id) = s.runs.map (·.id) ∧ { run with status := .queued } ∈ t.runs ∧
      (∀ x ∈ s.runs, x.id ≠ id → x ∈ t.runs) ∧ (accountStep cfg s (.requeue a id)).2 = [] := by
  obtain ⟨mem, hid, _⟩ := ownerRun_some hrun
  simp only [accountStep, hrun]
  refine ⟨?_, mem_setStatus_self mem hid, fun x hx hne => mem_setStatus_other hx hne, trivial⟩
  simp only [setStatus, List.map_map]
  congr 1
  funext r
  simp only [Function.comp_def]
  split <;> rfl

/-- Settling the conversation's owner, then `takeNext`, hands the conversation to its oldest queued
run, when the account is active and no other run owns it. In an inactive account no hand-off starts
anything (`inactive_starts_nothing`): the run loses its history rows (a background run its outcome
too, `settledStatus`) and the queue waits for reactivation or expiry. One step of `endRun`. The code
promotes the first unexpired row, or a contiguous group of collect or steer rows as one run
(`promoteQueuedGroup`); the model promotes the oldest queued run alone (L9). `release` does not hand
on (`queue_can_strand`). -/
theorem settle_hands_on (cfg : Config) (s : AccountState) (a : AccountId) (id : RunId)
    (failed : Bool) (handoff : Handoff) (hand : s.active = true)
    (run n : Run) (hrun : liveRun s.runs id = some run) (howner : run.status = .running)
    (hfree : busy (setStatus s.runs run.id (settledStatus s.active handoff failed)) run.conversation =
      false)
    (hn : nextQueued (setStatus s.runs run.id (settledStatus s.active handoff failed)) run.conversation =
      some n) :
    { n with status := .running } ∈ (accountStep cfg s (.settle a id failed handoff)).1.runs := by
  rw [hand] at hfree hn
  simp only [accountStep, hrun, endRun, hand, howner, promote, hfree, hn]
  simp only [beq_self_eq_true, ite_true, Bool.false_eq_true, ite_false, Bool.true_and]
  exact mem_setStatus_self (nextQueued_some hn).1 rfl

/-- **Completeness on served requests.** A credential that may start the agent's run, a configured
agent, a matching conversation, an active account, a fresh run id, a free conversation with nothing
queued, and an admitted slot (`{}`) start the run. Soundness alone would be true of a runtime that
refuses everything. -/
theorem served_request_starts (cfg : Config) (s : AccountState) (c : Access.Credential)
    (r : Access.Request) (route : DirectRoute) (ag : AgentId) (conv : Conversation) (id : RunId)
    (auth : Access.Auth) (entry : AgentConfig)
    (hres : startAuth c r route = some auth) (hauth : Access.authAccount auth = some c.account)
    (hmay : mayStart c auth route entry = true)
    (hscope : conv.account = c.account) (hagent : conv.agent = ag)
    (hlookup : cfg.lookup c.account ag = some entry) (hactive : s.active = true)
    (hfresh : fresh s.runs id = true)
    (hfree : busy s.runs conv = false) (hempty : nextQueued s.runs conv = none) :
    Effect.started c.account id id ∈ (accountStep cfg s (.request c r route ag conv id {})).2 := by
  simp [accountStep, requestRun, hres, hlookup, hauth, hmay, hscope, hagent, arrive, hactive, hfresh,
    admit, promote, rootRun, hfree, hempty]

/-- **Who may start a run.** A run token, a role session, a scoped account key and the admin key
never start a run, over the direct API or through `/mcp`, whatever they ask for. -/
theorem restricted_never_start (cfg : Config) (s : AccountState) (c : Access.Credential)
    (r : Access.Request) (route : DirectRoute) (ag : AgentId) (conv : Conversation) (id : RunId)
    (arrival : Arrival)
    (hkind : c.kind = .run ∨ c.kind = .role ∨ c.kind = .scoped ∨ c.kind = .admin) :
    accountStep cfg s (.request c r route ag conv id arrival) = (s, []) := by
  have refused : requestRun cfg c r route ag conv id = none := by
    unfold requestRun
    cases hs : startAuth c r route with
    | none => rfl
    | some auth =>
      cases hl : cfg.lookup c.account ag with
      | none => simp [hl]
      | some entry => simp [hl, restricted_auth c r route auth hkind hs entry]
  simp [accountStep, refused]

/-- An AuthKit (WorkOS) sign-in starts runs only through `/mcp`, where `mcpAuth` resolves it as an
account key; the direct API's `resolve` refuses it. -/
theorem authkit_only_through_mcp (cfg : Config) (s : AccountState) (c : Access.Credential)
    (r : Access.Request) (route : DirectRoute) (ag : AgentId) (conv : Conversation) (id : RunId)
    (arrival : Arrival) (hkind : c.kind = .authkit) (hdirect : route.mcp = false) :
    accountStep cfg s (.request c r route ag conv id arrival) = (s, []) := by
  have none : startAuth c r route = none := by
    unfold startAuth Access.resolve
    cases hv : c.valid <;> simp [hdirect, hkind, hv]
  simp [accountStep, requestRun, none]

/-- **Stage credentials stay in their stage.** A run started by a stage credential (`bsk_` key or
`bdts_` ticket), over the direct API or `/mcp`, is of an agent deployed to that credential's own stage,
the stage its row names (A3), and one started by the embeddable `bsk_` key is of a public agent. -/
theorem stage_credential_scope (cfg : Config) (s : AccountState) (c : Access.Credential)
    (r : Access.Request) (route : DirectRoute) (ag : AgentId) (conv : Conversation) (id : RunId)
    (arrival : Arrival) (e : Effect) (hkind : c.kind = .runtime ∨ c.kind = .stage)
    (he : e ∈ (accountStep cfg s (.request c r route ag conv id arrival)).2) :
    ∃ entry, cfg.lookup c.account ag = some entry ∧ entry.stage = c.stage ∧
      (c.kind = .runtime → entry.publicAccess = true) := by
  simp only [accountStep] at he
  split at he
  · simp at he
  · rename_i n hn
    obtain ⟨entry, hl, _, _, ⟨_, _, auth, entry', hs, _, hl', hm⟩, _⟩ := requestRun_some arrival hn
    rw [hl] at hl'
    cases hl'
    have deployment : auth = .deployment c.account := by
      unfold startAuth Access.mcpResolve Access.resolve at hs
      rcases hkind with h | h <;> cases hmcp : route.mcp <;> cases hv : c.valid <;>
        cases ha : c.active <;> cases hu : c.userPresent <;> cases hw : c.userValid <;>
        simp [h, hmcp, hv, ha, hu, hw] at hs <;> exact hs.symm
    subst deployment
    rcases hkind with h | h <;> simp [mayStart, h] at hm <;> exact ⟨entry, hl, by simp_all⟩

/-- **Non-vacuity.** A real trace reaches a tool execution, so the theorems above do not hold merely
because nothing ever happens. -/
theorem non_vacuous :
    Spec.NonVacuous
      (system [{ account := 1, agent := 2, tools := [3], sandboxes := [4] }])
      (fun _ => True)
      (fun e => ∃ a g r root t x, e = .toolExecuted a g r root t x) := by
  refine ⟨[.request { kind := .account, account := 1 } {} {} 2 { account := 1, agent := 2, name := 0 } 7 {},
      .toolCall 1 7 3 none { policy := .allow } false false], trivial,
      .toolExecuted 1 2 7 7 3 4, ?_, 1, 2, 7, 7, 3, 4, rfl⟩
  simp [System.effects, System.runFrom, system, step, accountStep, requestRun, startAuth, mayStart,
    emptyWorld, Access.resolve, Access.authAccount, Config.lookup, arrive, fresh, admit, promote, busy,
    nextQueued, rootRun, liveRun, Channels.allowedTools, Agent.gate, Agent.executes, Sandbox.select,
    Input.account]
  exact List.mem_append_right _ (List.mem_append_left _ (List.mem_singleton.2 rfl))

/-- An effect always names the account its input was addressed to. True by construction: every
branch of `accountStep` emits effects on its input's account. -/
theorem effect_account (cfg : Config) (s : AccountState) (i : Input) (e : Effect)
    (he : e ∈ (accountStep cfg s i).2) : e.account = i.account :=
  (step_effect cfg s i e he).1

/-- An account's state and view depend only on its own inputs, whatever others do around them. True
by construction: `step` changes only the addressed account. -/
theorem run_is_local (cfg : Config) (a : AccountId) :
    ∀ (trace : List Input) (w : World),
      ((system cfg).runFrom w trace).1 a = (localRun cfg (w a) (ownInputs a trace)).1 ∧
        viewOf a ((system cfg).runFrom w trace).2 = (localRun cfg (w a) (ownInputs a trace)).2 := by
  intro trace
  induction trace with
  | nil =>
    intro w
    exact ⟨rfl, rfl⟩
  | cons i rest ih =>
    intro w
    have next := ih ((system cfg).step w i).1
    by_cases ha : i.account = a
    · subst ha
      have stateAt : ((system cfg).step w i).1 i.account =
          { (accountStep cfg (w i.account) i).1 with log := i :: (w i.account).log } := by
        change (Spec.Runtime.step cfg w i).1 i.account = _
        simp [Spec.Runtime.step]
      have allOwn : viewOf i.account ((system cfg).step w i).2 = ((system cfg).step w i).2 := by
        unfold viewOf
        apply List.filter_eq_self.2
        intro e he
        have := effect_account cfg (w i.account) i e he
        simp [this]
      have ownCons : ownInputs i.account (i :: rest) = i :: ownInputs i.account rest := by
        simp [ownInputs]
      rw [stateAt] at next
      constructor
      · rw [ownCons]
        exact next.1
      · rw [ownCons]
        exact (viewOf_append _ _ _).trans (appendCongr allOwn next.2)
    · have stateAt : ((system cfg).step w i).1 a = w a := by
        change (Spec.Runtime.step cfg w i).1 a = _
        have hne : a ≠ i.account := fun h => ha h.symm
        simp [Spec.Runtime.step, hne]
      have noneOwn : viewOf a ((system cfg).step w i).2 = [] := by
        unfold viewOf
        apply List.filter_eq_nil_iff.2
        intro e he
        have := effect_account cfg (w i.account) i e he
        simp [this, ha]
      have ownSkip : ownInputs a (i :: rest) = ownInputs a rest := by
        simp [ownInputs, ha]
      rw [stateAt] at next
      constructor
      · rw [ownSkip]
        exact next.1
      · rw [ownSkip]
        exact (viewOf_append _ _ _).trans
          ((appendCongr noneOwn next.2).trans (List.nil_append _))

/-- **Privacy between tenants.** What an account observes is fixed by its own inputs. Nothing another
tenant sends, and nothing stored for another tenant, changes what it sees. True by construction of the
per-account `World`: it shows the model keeps rows apart, not that the code does. By design this model
leaves out what leaks through shared capacity: the queue's answer is part of an account's own input
(`arrival`), and timing is not modelled. `LIMITS.md` lists these. -/
theorem tenant_private (cfg : Config) :
    Spec.Private (system cfg) AccountId Unit Effect (fun _ => True) ownInputs (fun _ => ()) viewOf := by
  intro a x y _ _ hown _
  have hx := (run_is_local cfg a x emptyWorld).2
  have hy := (run_is_local cfg a y emptyWorld).2
  change viewOf a ((system cfg).runFrom emptyWorld x).2 = viewOf a ((system cfg).runFrom emptyWorld y).2
  rw [hx, hy, hown]

end Spec.Runtime
