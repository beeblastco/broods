import Spec.Runtime.Proofs

/-!
The whole runtime's own claims, over every input list: every interleaving, crash, duplicate and attacker
choice the model has. `Spec.Top` names the ones a reader should start with.
-/

namespace Spec.Runtime

/-- The invariant of the whole world. -/
def WorldInv (cfg : Config) (w : World) : Prop :=
  ∀ a, Inv cfg a (w a).log (w a).runs

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

/-- Inputs in an account's log were all inputs of the trace, addressed to that account. -/
theorem log_of_trace (cfg : Config) (a : AccountId) :
    ∀ (trace : List Input) (w : World) (x : Input),
      x ∈ (((system cfg).runFrom w trace).1 a).log → x ∈ (w a).log ∨ x ∈ trace := by
  intro trace
  induction trace with
  | nil =>
    intro w x hx
    exact Or.inl hx
  | cons i rest ih =>
    intro w x hx
    rcases ih ((system cfg).step w i).1 x hx with hprev | hrest
    · change x ∈ ((Spec.Runtime.step cfg w i).1 a).log at hprev
      simp only [Spec.Runtime.step] at hprev
      by_cases ha : a = i.account
      · subst ha
        simp only [ite_true, List.mem_cons] at hprev
        rcases hprev with heq | hold
        · exact Or.inr (by simp [heq])
        · exact Or.inl hold
      · simp only [ha, ite_false] at hprev
        exact Or.inl hprev
    · exact Or.inr (List.mem_cons_of_mem _ hrest)

/-- The facts one step's effect can rely on: which run it acted for, in the state before the step. -/
theorem effect_of_step (cfg : Config) (s : AccountState) (i : Input) (e : Effect)
    (h : Inv cfg i.account s.log s.runs)
    (he : e ∈ (accountStep cfg s i).2) :
    e.account = i.account ∧ ∃ w ∈ i :: s.log, Authorizes w e.account e.root := by
  have fromRun : ∀ r ∈ s.runs, ∃ w ∈ i :: s.log, Authorizes w i.account r.root := by
    intro r hr
    obtain ⟨w, hw, ha⟩ := (h.stable r hr).origin
    exact ⟨w, List.mem_cons_of_mem _ hw, ha⟩
  have admitEffect : ∀ (n : Run) (a : AccountId),
      e ∈ (admit s n a).2 → (e = .started a n.id n.root ∨ e = .queued a n.id n.root) := by
    intro n a hm
    unfold admit at hm
    split at hm
    · simp only [List.mem_singleton] at hm
      exact Or.inr hm
    · simp only [List.mem_singleton] at hm
      exact Or.inl hm
  have endEffect : ∀ (run : Run) (st : Status), run ∈ s.runs →
      e ∈ (endRun s i.account run st).2 → e.account = i.account ∧
        ∃ r ∈ setStatus s.runs run.id st, e.root = r.root := by
    intro run st hrun hm
    unfold endRun at hm
    dsimp only at hm
    have runInEnded : { run with status := st } ∈ setStatus s.runs run.id st :=
      mem_setStatus_self hrun rfl
    cases hn : nextQueued (setStatus s.runs run.id st) run.conversation with
    | none =>
      simp only [hn, List.mem_singleton] at hm
      subst hm
      exact ⟨rfl, _, runInEnded, rfl⟩
    | some n =>
      simp only [hn, List.mem_cons, List.not_mem_nil, or_false] at hm
      rcases hm with hm | hm
      · subst hm
        exact ⟨rfl, _, runInEnded, rfl⟩
      · subst hm
        exact ⟨rfl, n, List.mem_of_find?_eq_some hn, rfl⟩
  have rootInEnded : ∀ (id : RunId) (st : Status) (r : Run), r ∈ setStatus s.runs id st →
      ∃ o ∈ s.runs, r.root = o.root := by
    intro id st r hr
    obtain ⟨o, ho, hcase | hcase⟩ := mem_setStatus hr
    · exact ⟨o, ho, by rw [hcase.2]⟩
    · exact ⟨o, ho, by rw [hcase.2]⟩
  cases i with
  | request c r ag conv id ad =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun ⊢
    cases hres : Access.resolve c r with
    | none => simp [hres] at he
    | some auth =>
      simp only [hres] at he
      by_cases hauth : Access.authAccount auth = some c.account
      · have self : Authorizes (.request c r ag conv id ad) c.account id :=
          ⟨rfl, rfl, auth, hres, hauth⟩
        simp only [hauth, bne_self_eq_false, ite_false, Bool.false_eq_true] at he
        split at he
        · simp at he
        · split at he
          · simp at he
          · rename_i entry _
            split at he
            · simp at he
            · split at he
              · simp only [List.mem_singleton] at he
                subst he
                exact ⟨rfl, _, List.mem_cons_self, self⟩
              · rcases admitEffect _ _ he with he | he <;> subst he <;>
                  exact ⟨rfl, _, List.mem_cons_self, self⟩
      · have hne : (Access.authAccount auth != some c.account) = true := by simpa using hauth
        simp [hne] at he
  | delivery a v ag conv id den rec ad =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun ⊢
    cases v with
    | false => simp at he
    | true =>
      have self : Authorizes (.delivery a true ag conv id den rec ad) a id := ⟨rfl, rfl, rfl⟩
      simp only [Bool.not_true, Bool.false_eq_true, ite_false] at he
      split at he
      · simp at he
      · split at he
        · simp at he
        · split at he
          · simp at he
          · split at he
            · simp only [List.mem_singleton] at he
              subst he
              exact ⟨rfl, _, List.mem_cons_self, self⟩
            · rcases admitEffect _ _ he with he | he <;> subst he <;>
                exact ⟨rfl, _, List.mem_cons_self, self⟩
  | spawn a p ag ch =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun ⊢
    split at he
    · rename_i pr entry hp _
      obtain ⟨pMem, _, _⟩ := liveRun_some hp
      split at he
      · simp at he
      · rcases admitEffect _ _ he with he | he <;> subst he <;>
          exact ⟨rfl, fromRun pr pMem⟩
    · simp at he
  | toolCall a id t sb g wt gr =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun ⊢
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      split at he
      · simp at he
      · split at he
        · simp at he
        · simp only [List.mem_singleton] at he
          subst he
          exact ⟨rfl, fromRun run mem⟩
  | reply a id =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun ⊢
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      simp only [List.mem_singleton] at he
      subst he
      exact ⟨rfl, fromRun run mem⟩
  | settle a id =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun endEffect ⊢
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      obtain ⟨hAcc, r, hrm, hroot⟩ := endEffect run .finished mem he
      obtain ⟨o, ho, hoRoot⟩ := rootInEnded _ _ r hrm
      refine ⟨hAcc, ?_⟩
      rw [hAcc, hroot, hoRoot]
      exact fromRun o ho
  | leaseExpired a id =>
    simp only [accountStep] at he
    simp only [Input.account] at h fromRun endEffect ⊢
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      obtain ⟨hAcc, r, hrm, hroot⟩ := endEffect run .failed mem he
      obtain ⟨o, ho, hoRoot⟩ := rootInEnded _ _ r hrm
      refine ⟨hAcc, ?_⟩
      rw [hAcc, hroot, hoRoot]
      exact fromRun o ho

/-- An effect's authorising input, read from the inputs so far and never from later ones. -/
noncomputable def authorisingInput (trace : List Input) (e : Effect) : Option Input :=
  open Classical in trace.find? fun w => decide (Authorizes w e.account e.root)

/-- **Soundness.** Every effect on an account traces to an input that authorises that account: a
credential that resolved to it or a delivery whose signature verified, which started that effect's root
run, and which came no later than the effect. By assumption A1 only a holder of that account's secret
can produce such an input, so no other tenant can cause an effect on it. -/
theorem sound_effects (cfg : Config) (trace : List Input) (i : Input) (e : Effect)
    (he : e ∈ ((system cfg).step ((system cfg).final trace) i).2) :
    ∃ w ∈ trace ++ [i], Authorizes w e.account e.root := by
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
    Spec.Sound (system cfg) (fun _ => True) Input (fun w e => Authorizes w e.account e.root) := by
  refine ⟨authorisingInput, ?_⟩
  intro trace i _ e he
  obtain ⟨w, hw, ha⟩ := sound_effects cfg trace i e he
  have found : (authorisingInput (trace ++ [i]) e).isSome = true := by
    unfold authorisingInput
    apply List.find?_isSome.2
    exact ⟨w, hw, by simpa using ha⟩
  obtain ⟨x, hx⟩ := Option.isSome_iff_exists.1 found
  refine ⟨x, hx, ?_⟩
  have sat := List.find?_some hx
  simpa using sat

/-- **Tenant isolation.** In every reachable state, each of an account's runs has that account's
conversation and principal, acts as an agent configured in that account, and uses only tools and
sandboxes configured for that agent, so no run can hold another account's resources. -/
theorem tenant_isolation (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ r ∈ (w a).runs,
      r.conversation.account = a ∧ r.context.principal.account = a ∧
        ∃ entry, cfg.lookup a r.context.principal.agent = some entry ∧
          (∀ t ∈ r.tools, t ∈ entry.tools) ∧ (∀ x ∈ r.sandboxes, x ∈ entry.sandboxes) := by
  intro w reach a r hr
  have stable := ((inductive_world cfg).always w reach a).stable r hr
  exact ⟨stable.conversationAccount, stable.principalAccount, stable.attached⟩

/-- **One owner per conversation.** At most one run is running per conversation, in every reachable
state, across crashes, duplicates and any order of input. -/
theorem conversation_exclusive (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ x ∈ (w a).runs, ∀ y ∈ (w a).runs,
      x.status = .running → y.status = .running → x.conversation = y.conversation → x = y := by
  intro w reach a
  exact ((inductive_world cfg).always w reach a).exclusive

/-- **No stranded queue.** A queued run always has a running owner in its conversation, so the queue
always has someone to hand it on. A crash ends in `leaseExpired`, which hands it on too. -/
theorem queue_never_stranded (cfg : Config) :
    Spec.Always (system cfg) fun w => ∀ a, ∀ r ∈ (w a).runs, r.status = .queued →
      ∃ o ∈ (w a).runs, o.status = .running ∧ o.conversation = r.conversation := by
  intro w reach a
  exact ((inductive_world cfg).always w reach a).owned

/-- A tool runs only if it is one of the run's tools, the gate passed it, and the sandbox is the run's. -/
theorem tool_call_gated (cfg : Config) (s : AccountState) (a : AccountId) (id : RunId) (t : ToolId)
    (sb : Option SandboxId) (g : Agent.GateInput) (waiting granted : Bool) (e : Effect)
    (he : e ∈ (accountStep cfg s (.toolCall a id t sb g waiting granted)).2) :
    ∃ run ∈ s.runs, run.id = id ∧ run.status = .running ∧ t ∈ run.tools ∧
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

/-- The first queued run of a conversation owns it once its owner ends. -/
theorem owner_end_hands_on (cfg : Config) (s : AccountState) (run n : Run) (a : AccountId) (st : Status)
    (hn : nextQueued (setStatus s.runs run.id st) run.conversation = some n) :
    { n with status := .running } ∈ (endRun s a run st).1.runs := by
  rw [endRun_runs, hn]
  exact mem_setStatus_self (List.mem_of_find?_eq_some hn) rfl

/-- **Completeness on served requests.** A valid credential, a configured agent, a matching conversation,
a fresh run id, a free conversation and an admitted slot start the run. Soundness alone would be true of
a runtime that refuses everything, and this rules that out. -/
theorem served_request_starts (cfg : Config) (s : AccountState) (c : Access.Credential) (r : Access.Request)
    (ag : AgentId) (conv : Conversation) (id : RunId) (auth : Access.Auth) (entry : AgentConfig)
    (hres : Access.resolve c r = some auth) (hauth : Access.authAccount auth = some c.account)
    (hscope : conv.account = c.account) (hagent : conv.agent = ag)
    (hlookup : cfg.lookup c.account ag = some entry) (hfresh : fresh s.runs id = true)
    (hfree : busy s.runs conv = false) :
    Effect.started c.account id id ∈ (accountStep cfg s (.request c r ag conv id true)).2 := by
  simp [accountStep, hres, hauth, hscope, hagent, hlookup, hfresh, admit, rootRun, hfree]

/-- **Non-vacuity.** A real trace reaches a tool execution, so the theorems above do not hold merely
because nothing ever happens. -/
theorem non_vacuous :
    Spec.NonVacuous
      (system [{ account := 1, agent := 2, tools := [3], sandboxes := [4] }])
      (fun _ => True)
      (fun e => ∃ a g r root t x, e = .toolExecuted a g r root t x) := by
  refine ⟨[.request { kind := .account, account := 1 } {} 2 { account := 1, agent := 2, name := 0 } 7 true,
      .toolCall 1 7 3 none { policy := .allow } false false], trivial,
      .toolExecuted 1 2 7 7 3 4, ?_, 1, 2, 7, 7, 3, 4, rfl⟩
  simp [System.effects, System.runFrom, system, step, accountStep, emptyWorld, Access.resolve, Access.authAccount, Config.lookup, fresh, admit, busy, rootRun, liveRun, Agent.gate, Agent.executes, Sandbox.select, Input.account]
  exact List.mem_append_right _ (List.mem_append_left _ (List.mem_singleton.2 rfl))

/-- An effect always names the account its input was addressed to. -/
theorem effect_account (cfg : Config) (s : AccountState) (i : Input) (e : Effect)
    (he : e ∈ (accountStep cfg s i).2) : e.account = i.account := by
  have admitted : ∀ (n : Run) (a : AccountId), e ∈ (admit s n a).2 → e.account = a := by
    intro n a hm
    unfold admit at hm
    split at hm <;>
      · simp only [List.mem_singleton] at hm
        rw [hm]
        rfl
  have ended : ∀ (a : AccountId) (run : Run) (st : Status), e ∈ (endRun s a run st).2 →
      e.account = a := by
    intro a run st hm
    unfold endRun at hm
    dsimp only at hm
    cases hn : nextQueued (setStatus s.runs run.id st) run.conversation with
    | none =>
      simp only [hn, List.mem_singleton] at hm
      rw [hm]
      rfl
    | some n =>
      simp only [hn, List.mem_cons, List.not_mem_nil, or_false] at hm
      rcases hm with hm | hm <;>
        · rw [hm]
          rfl
  cases i with
  | request c r ag conv id ad =>
    simp only [accountStep] at he
    simp only [Input.account]
    repeat' split at he
    all_goals first
      | simp at he; done
      | (simp only [List.mem_singleton] at he; rw [he]; rfl)
      | exact admitted _ _ he
  | delivery a v ag conv id den rec ad =>
    simp only [accountStep] at he
    simp only [Input.account]
    repeat' split at he
    all_goals first
      | simp at he; done
      | (simp only [List.mem_singleton] at he; rw [he]; rfl)
      | exact admitted _ _ he
  | spawn a p ag ch =>
    simp only [accountStep] at he
    simp only [Input.account]
    repeat' split at he
    all_goals first
      | simp at he; done
      | exact admitted _ _ he
  | toolCall a id t sb g wt gr =>
    simp only [accountStep] at he
    simp only [Input.account]
    repeat' split at he
    all_goals first
      | simp at he; done
      | (simp only [List.mem_singleton] at he; rw [he]; rfl)
  | reply a id =>
    simp only [accountStep] at he
    simp only [Input.account]
    split at he
    · simp at he
    · simp only [List.mem_singleton] at he
      rw [he]
      rfl
  | settle a id =>
    simp only [accountStep] at he
    simp only [Input.account]
    split at he
    · simp at he
    · exact ended _ _ _ he
  | leaseExpired a id =>
    simp only [accountStep] at he
    simp only [Input.account]
    split at he
    · simp at he
    · exact ended _ _ _ he

/-- An account's inputs. -/
def ownInputs (a : AccountId) (trace : List Input) : List Input :=
  trace.filter fun i => i.account == a

/-- What an account sees: the effects that happen on it. -/
def viewOf (a : AccountId) (effects : List Effect) : List Effect :=
  effects.filter fun e => e.account == a

theorem viewOf_append (a : AccountId) (x y : List Effect) :
    viewOf a (x ++ y) = viewOf a x ++ viewOf a y :=
  List.filter_append ..

theorem appendCongr {x x' y y' : List Effect} (hx : x = x') (hy : y = y') : x ++ y = x' ++ y' := by
  rw [hx, hy]

/-- One account run alone on its own inputs. -/
def localRun (cfg : Config) (s : AccountState) : List Input → AccountState × List Effect
  | [] => (s, [])
  | i :: rest =>
    let next := accountStep cfg s i
    let later := localRun cfg { next.1 with log := i :: s.log } rest
    (later.1, next.2 ++ later.2)

/-- An account's state and view depend only on its own inputs, whatever others do around them. -/
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
tenant sends, and nothing stored for another tenant, changes what it sees. By design this model leaves
out what leaks through shared capacity: the queue's answer is part of an account's own input (`admitted`),
and timing is not modelled. `LIMITS.md` lists these. -/
theorem tenant_private (cfg : Config) :
    Spec.Private (system cfg) AccountId Unit Effect (fun _ => True) ownInputs (fun _ => ()) viewOf := by
  intro a x y _ _ hown _
  have hx := (run_is_local cfg a x emptyWorld).2
  have hy := (run_is_local cfg a y emptyWorld).2
  change viewOf a ((system cfg).runFrom emptyWorld x).2 = viewOf a ((system cfg).runFrom emptyWorld y).2
  rw [hx, hy, hown]

end Spec.Runtime
