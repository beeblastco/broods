import Spec.Kit
import Spec.Runtime.Model

/-!
One inductive invariant of one account's state, proved for each input kind, in the manner of FlashProve's
round-by-round state functions: if the invariant holds before a step it holds after, whatever the input.
-/

namespace Spec.Runtime

/-- `i` is what authorises work on `account` under `root`: a credential that resolves to that account,
or a delivery whose signature checked out, that started that root run. -/
def Authorizes (i : Input) (account : AccountId) (root : RunId) : Prop :=
  match i with
  | .request credential gatewayRequest _ _ id _ =>
    credential.account = account ∧ id = root ∧
      ∃ auth, Access.resolve credential gatewayRequest = some auth ∧
        Access.authAccount auth = some account
  | .delivery a verified _ _ id _ _ _ => a = account ∧ verified = true ∧ id = root
  | _ => False

/-- The facts about one run that no status change can touch. -/
structure Stable (cfg : Config) (account : AccountId) (log : List Input) (r : Run) : Prop where
  conversationAccount : r.conversation.account = account
  principalAccount : r.context.principal.account = account
  sameAgent : r.conversation.agent = r.context.principal.agent
  attached : ∃ entry, cfg.lookup account r.context.principal.agent = some entry ∧
    (∀ t ∈ r.tools, t ∈ entry.tools) ∧ (∀ x ∈ r.sandboxes, x ∈ entry.sandboxes)
  origin : ∃ w ∈ log, Authorizes w account r.root

/-- The invariant of one account's runs. -/
structure Inv (cfg : Config) (account : AccountId) (log : List Input) (runs : List Run) : Prop where
  stable : ∀ r ∈ runs, Stable cfg account log r
  unique : ∀ a ∈ runs, ∀ b ∈ runs, a.id = b.id → a = b
  exclusive : ∀ a ∈ runs, ∀ b ∈ runs, a.status = .running → b.status = .running →
    a.conversation = b.conversation → a = b
  owned : ∀ r ∈ runs, r.status = .queued →
    ∃ o ∈ runs, o.status = .running ∧ o.conversation = r.conversation

theorem Stable.status {cfg : Config} {account : AccountId} {log : List Input} {r : Run}
    (h : Stable cfg account log r) (st : Status) : Stable cfg account log { r with status := st } :=
  { conversationAccount := h.conversationAccount
    principalAccount := h.principalAccount
    sameAgent := h.sameAgent
    attached := h.attached
    origin := h.origin }

theorem Stable.mono {cfg : Config} {account : AccountId} {log : List Input} {r : Run} (i : Input)
    (h : Stable cfg account log r) : Stable cfg account (i :: log) r :=
  { conversationAccount := h.conversationAccount
    principalAccount := h.principalAccount
    sameAgent := h.sameAgent
    attached := h.attached
    origin := by
      obtain ⟨w, hw, ha⟩ := h.origin
      exact ⟨w, List.mem_cons_of_mem _ hw, ha⟩ }

theorem Inv.mono {cfg : Config} {account : AccountId} {log : List Input} {runs : List Run} (i : Input)
    (h : Inv cfg account log runs) : Inv cfg account (i :: log) runs :=
  { stable := fun r hr => (h.stable r hr).mono i
    unique := h.unique
    exclusive := h.exclusive
    owned := h.owned }

theorem liveRun_some {runs : List Run} {id : RunId} {r : Run} (h : liveRun runs id = some r) :
    r ∈ runs ∧ r.id = id ∧ r.status = .running := by
  have mem := List.mem_of_find?_eq_some h
  have sat := List.find?_some h
  simp only [Bool.and_eq_true, beq_iff_eq] at sat
  exact ⟨mem, sat.1, sat.2⟩

theorem fresh_true {runs : List Run} {id : RunId} (h : fresh runs id = true) :
    ∀ r ∈ runs, r.id ≠ id := by
  intro r hr heq
  simp only [fresh, Bool.not_eq_true', List.any_eq_false, beq_iff_eq] at h
  exact h r hr heq

theorem busy_false {runs : List Run} {c : Conversation} (h : busy runs c = false) :
    ∀ r ∈ runs, r.status = .running → r.conversation ≠ c := by
  intro r hr hs hc
  simp only [busy, List.any_eq_false, Bool.and_eq_true, beq_iff_eq, not_and] at h
  exact h r hr hs hc

theorem busy_true {runs : List Run} {c : Conversation} (h : busy runs c = true) :
    ∃ o ∈ runs, o.status = .running ∧ o.conversation = c := by
  simp only [busy, List.any_eq_true, Bool.and_eq_true, beq_iff_eq] at h
  exact h

/-- Appending a fresh run keeps the invariant, provided it queues behind a busy owner or owns a free
conversation. -/
theorem Inv.append {cfg : Config} {account : AccountId} {log : List Input} {runs : List Run} {n : Run}
    (h : Inv cfg account log runs) (hs : Stable cfg account log n)
    (hf : ∀ r ∈ runs, r.id ≠ n.id)
    (hrun : n.status = .running → ∀ r ∈ runs, r.status = .running → r.conversation ≠ n.conversation)
    (hqueue : n.status = .queued → ∃ o ∈ runs, o.status = .running ∧ o.conversation = n.conversation) :
    Inv cfg account log (runs ++ [n]) := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro r hr
    rcases List.mem_append.1 hr with hr | hr
    · exact h.stable r hr
    · rw [List.mem_singleton.1 hr]; exact hs
  · intro a ha b hb hab
    rcases List.mem_append.1 ha with ha | ha <;> rcases List.mem_append.1 hb with hb | hb
    · exact h.unique a ha b hb hab
    · rw [List.mem_singleton.1 hb] at hab; exact absurd hab (hf a ha)
    · rw [List.mem_singleton.1 ha] at hab; exact absurd hab.symm (hf b hb)
    · rw [List.mem_singleton.1 ha, List.mem_singleton.1 hb]
  · intro a ha b hb sa sb hc
    rcases List.mem_append.1 ha with ha1 | ha1 <;> rcases List.mem_append.1 hb with hb1 | hb1
    · exact h.exclusive a ha1 b hb1 sa sb hc
    · have hb' := List.mem_singleton.1 hb1
      subst hb'
      exact absurd hc (hrun sb a ha1 sa)
    · have ha' := List.mem_singleton.1 ha1
      subst ha'
      exact absurd hc.symm (hrun sa b hb1 sb)
    · rw [List.mem_singleton.1 ha1, List.mem_singleton.1 hb1]
  · intro r hr sr
    rcases List.mem_append.1 hr with hr | hr
    · obtain ⟨o, ho, so, co⟩ := h.owned r hr sr
      exact ⟨o, List.mem_append_left _ ho, so, co⟩
    · have hr' := List.mem_singleton.1 hr
      subst hr'
      obtain ⟨o, ho, so, co⟩ := hqueue sr
      exact ⟨o, List.mem_append_left _ ho, so, co⟩

/-- `admit` keeps the invariant for a fresh, stable run. -/
theorem Inv.admit {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState} {n : Run}
    (h : Inv cfg account log s.runs) (hs : Stable cfg account log n)
    (hf : ∀ r ∈ s.runs, r.id ≠ n.id) :
    Inv cfg account log (admit s n account).1.runs := by
  unfold Spec.Runtime.admit
  cases hb : busy s.runs n.conversation with
  | true =>
    simp only [ite_true]
    refine h.append (hs.status _) hf (fun hst => by simp at hst) (fun _ => busy_true hb)
  | false =>
    simp only [Bool.false_eq_true, ite_false]
    refine h.append (hs.status _) hf (fun _ => busy_false hb) (fun hst => by simp at hst)

/-- Status changes keep identity: an element of the updated list came from one original. -/
theorem mem_setStatus {runs : List Run} {id : RunId} {st : Status} {x : Run}
    (h : x ∈ setStatus runs id st) :
    ∃ r ∈ runs, (r.id = id ∧ x = { r with status := st }) ∨ (r.id ≠ id ∧ x = r) := by
  obtain ⟨r, hr, hx⟩ := List.mem_map.1 h
  refine ⟨r, hr, ?_⟩
  by_cases hid : r.id = id
  · left
    have hb : (r.id == id) = true := by simp [hid]
    rw [if_pos hb] at hx
    exact ⟨hid, hx.symm⟩
  · right
    have hb : ¬ (r.id == id) = true := by simp [hid]
    rw [if_neg hb] at hx
    exact ⟨hid, hx.symm⟩

/-- A run other than the one named keeps its place and fields. -/
theorem mem_setStatus_other {runs : List Run} {id : RunId} {st : Status} {r : Run}
    (hr : r ∈ runs) (hid : r.id ≠ id) : r ∈ setStatus runs id st := by
  refine List.mem_map.2 ⟨r, hr, ?_⟩
  have hb : ¬ (r.id == id) = true := by simp [hid]
  rw [if_neg hb]

/-- The named run appears with its new status. -/
theorem mem_setStatus_self {runs : List Run} {id : RunId} {st : Status} {r : Run}
    (hr : r ∈ runs) (hid : r.id = id) : { r with status := st } ∈ setStatus runs id st := by
  refine List.mem_map.2 ⟨r, hr, ?_⟩
  have hb : (r.id == id) = true := by simp [hid]
  rw [if_pos hb]

/-- `setStatus` keeps the facts no status can touch, and uniqueness of ids. -/
theorem stable_setStatus {cfg : Config} {account : AccountId} {log : List Input} {runs : List Run}
    {id : RunId} {st : Status} (h : ∀ r ∈ runs, Stable cfg account log r) :
    ∀ r ∈ setStatus runs id st, Stable cfg account log r := by
  intro x hx
  obtain ⟨r, hr, hcase | hcase⟩ := mem_setStatus hx
  · rw [hcase.2]; exact (h r hr).status st
  · rw [hcase.2]; exact h r hr

theorem unique_setStatus {runs : List Run} {id : RunId} {st : Status}
    (h : ∀ a ∈ runs, ∀ b ∈ runs, a.id = b.id → a = b) :
    ∀ a ∈ setStatus runs id st, ∀ b ∈ setStatus runs id st, a.id = b.id → a = b := by
  intro a ha b hb hab
  obtain ⟨ra, hra, hca | hca⟩ := mem_setStatus ha <;> obtain ⟨rb, hrb, hcb | hcb⟩ := mem_setStatus hb
  · rw [hca.2, hcb.2, h ra hra rb hrb (hca.1.trans hcb.1.symm)]
  · rw [hca.2, hcb.2] at hab; exact absurd (hab.symm.trans hca.1) hcb.1
  · rw [hca.2, hcb.2] at hab; exact absurd (hab.trans hcb.1) hca.1
  · rw [hca.2, hcb.2] at hab ⊢; exact h ra hra rb hrb hab

/-- What `endRun` leaves in the run list. -/
theorem endRun_runs (s : AccountState) (account : AccountId) (run : Run) (st : Status) :
    (endRun s account run st).1.runs =
      match nextQueued (setStatus s.runs run.id st) run.conversation with
      | none => setStatus s.runs run.id st
      | some n => setStatus (setStatus s.runs run.id st) n.id .running := by
  unfold endRun
  dsimp only
  cases nextQueued (setStatus s.runs run.id st) run.conversation <;> rfl

/-- Ending a live run keeps the invariant, and hands its conversation to the oldest queued run. -/
theorem Inv.endRun {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState} {run : Run}
    {st : Status} (h : Inv cfg account log s.runs) (hrun : run ∈ s.runs)
    (hlive : run.status = .running) (hst : st ≠ .running) (hsq : st ≠ .queued) :
    Inv cfg account log (Spec.Runtime.endRun s account run st).1.runs := by
  rw [endRun_runs]
  have runningOriginal : ∀ x ∈ setStatus s.runs run.id st,
      x.status = .running → x ∈ s.runs ∧ x.id ≠ run.id := by
    intro x hx hs
    obtain ⟨r, hr, hcase | hcase⟩ := mem_setStatus hx
    · rw [hcase.2] at hs; exact absurd hs hst
    · rw [hcase.2]; exact ⟨hr, hcase.1⟩
  have queuedOriginal : ∀ x ∈ setStatus s.runs run.id st,
      x.status = .queued → x ∈ s.runs ∧ x.id ≠ run.id := by
    intro x hx hs
    obtain ⟨r, hr, hcase | hcase⟩ := mem_setStatus hx
    · rw [hcase.2] at hs; exact absurd hs hsq
    · rw [hcase.2]; exact ⟨hr, hcase.1⟩
  have endedStable := stable_setStatus (id := run.id) (st := st) h.stable
  have endedUnique := unique_setStatus (id := run.id) (st := st) h.unique
  cases hnext : nextQueued (setStatus s.runs run.id st) run.conversation with
  | none =>
    refine ⟨endedStable, endedUnique, ?_, ?_⟩
    · intro a ha b hb sa sb hc
      exact h.exclusive a (runningOriginal a ha sa).1 b (runningOriginal b hb sb).1 sa sb hc
    · intro r hr sr
      have orig := queuedOriginal r hr sr
      obtain ⟨o, ho, so, co⟩ := h.owned r orig.1 sr
      by_cases hid : o.id = run.id
      · have ho' : o = run := h.unique o ho run hrun hid
        subst ho'
        have none := List.find?_eq_none.1 hnext r hr
        simp [sr, co] at none
      · exact ⟨o, mem_setStatus_other ho hid, so, co⟩
  | some n =>
    have nMem : n ∈ setStatus s.runs run.id st := List.mem_of_find?_eq_some hnext
    have nSat := List.find?_some hnext
    simp only [Bool.and_eq_true, beq_iff_eq] at nSat
    refine ⟨stable_setStatus endedStable, unique_setStatus endedUnique, ?_, ?_⟩
    · have conflict : ∀ x ∈ setStatus s.runs run.id st, x.status = .running →
          x.conversation ≠ n.conversation := by
        intro x hx sx cx
        have ox := runningOriginal x hx sx
        have same := h.exclusive x ox.1 run hrun sx hlive (cx.trans nSat.2)
        exact ox.2 (congrArg Run.id same)
      intro a ha b hb sa sb hc
      obtain ⟨ra, hra, hca | hca⟩ := mem_setStatus ha <;>
        obtain ⟨rb, hrb, hcb | hcb⟩ := mem_setStatus hb
      · rw [hca.2, hcb.2, endedUnique ra hra rb hrb (hca.1.trans hcb.1.symm)]
      · have rIsN : ra = n := endedUnique ra hra n nMem hca.1
        subst rIsN
        rw [hcb.2] at sb
        rw [hca.2, hcb.2] at hc
        exact absurd hc.symm (conflict rb hrb sb)
      · have rIsN : rb = n := endedUnique rb hrb n nMem hcb.1
        subst rIsN
        rw [hca.2] at sa
        rw [hca.2, hcb.2] at hc
        exact absurd hc (conflict ra hra sa)
      · rw [hca.2] at sa
        rw [hcb.2] at sb
        rw [hca.2, hcb.2] at hc ⊢
        have oa := runningOriginal ra hra sa
        have ob := runningOriginal rb hrb sb
        exact h.exclusive ra oa.1 rb ob.1 sa sb hc
    · intro x hx sx
      obtain ⟨r, hr, hcase | hcase⟩ := mem_setStatus hx
      · rw [hcase.2] at sx
        simp at sx
      · rw [hcase.2] at sx ⊢
        have orig := queuedOriginal r hr sx
        obtain ⟨o, ho, so, co⟩ := h.owned r orig.1 sx
        by_cases hid : o.id = run.id
        · have ho' : o = run := h.unique o ho run hrun hid
          subst ho'
          exact ⟨{ n with status := .running }, mem_setStatus_self nMem rfl, rfl, nSat.2.trans co⟩
        · have oStays := mem_setStatus_other (st := st) ho hid
          have oNotN : o.id ≠ n.id := by
            intro heq
            have same := endedUnique o oStays n nMem heq
            rw [same, nSat.1] at so
            cases so
          exact ⟨o, mem_setStatus_other oStays oNotN, so, co⟩

/-- A root run accepted from a verified or credentialed input satisfies `Stable` once that input is logged. -/
theorem rootRun_stable {cfg : Config} {account : AccountId} {log : List Input} {agent : AgentId}
    {conversation : Conversation} {id : RunId} {tools : List ToolId} {sandboxes : List SandboxId}
    {entry : AgentConfig} {w : Input}
    (hAccount : conversation.account = account) (hAgent : conversation.agent = agent)
    (hLookup : cfg.lookup account agent = some entry)
    (hTools : ∀ t ∈ tools, t ∈ entry.tools) (hSandboxes : ∀ x ∈ sandboxes, x ∈ entry.sandboxes)
    (hw : w ∈ log) (hAuth : Authorizes w account id) :
    Stable cfg account log (rootRun account agent conversation id tools sandboxes) :=
  { conversationAccount := hAccount
    principalAccount := rfl
    sameAgent := hAgent
    attached := ⟨entry, hLookup, hTools, hSandboxes⟩
    origin := ⟨w, hw, hAuth⟩ }

/-- `accountStep` never edits the ghost log. -/
theorem accountStep_log (cfg : Config) (s : AccountState) (i : Input) :
    (accountStep cfg s i).1.log = s.log := by
  have adm : ∀ (run : Run) (a : AccountId), (admit s run a).1.log = s.log := by
    intro run a
    unfold admit
    split <;> rfl
  have ends : ∀ (a : AccountId) (run : Run) (st : Status), (endRun s a run st).1.log = s.log := by
    intro a run st
    unfold Spec.Runtime.endRun
    dsimp only
    split <;> rfl
  cases i with
  | request c r ag conv id ad =>
    simp only [accountStep]
    repeat' first | split | rfl | exact adm _ _
  | delivery a v ag conv id den rec ad =>
    simp only [accountStep]
    repeat' first | split | rfl | exact adm _ _
  | spawn a p ag ch =>
    simp only [accountStep]
    repeat' first | split | rfl | exact adm _ _
  | toolCall a id t sb g wt gr =>
    simp only [accountStep]
    repeat' first | split | rfl
  | reply a id =>
    simp only [accountStep]
    split <;> rfl
  | settle a id =>
    simp only [accountStep]
    split
    · rfl
    · exact ends _ _ _
  | leaseExpired a id =>
    simp only [accountStep]
    split
    · rfl
    · exact ends _ _ _

/-- Every input keeps the account's invariant, with that input added to the log. -/
theorem inv_accountStep (cfg : Config) (s : AccountState) (i : Input)
    (h : Inv cfg i.account s.log s.runs) :
    Inv cfg i.account (i :: s.log) (accountStep cfg s i).1.runs := by
  have logged := h.mono i
  cases i with
  | request c r ag conv id ad =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    cases hres : Access.resolve c r with
    | none => exact logged
    | some auth =>
      simp only
      by_cases hauth : Access.authAccount auth = some c.account
      · simp only [hauth, bne_self_eq_false, ite_false, Bool.false_eq_true]
        by_cases hscope : conv.account = c.account ∧ conv.agent = ag
        · simp only [hscope.1, hscope.2, bne_self_eq_false, Bool.or_self, ite_false, Bool.false_eq_true]
          cases hl : cfg.lookup c.account ag with
          | none => exact logged
          | some entry =>
            simp only
            cases hf : fresh s.runs id with
            | false => simpa using logged
            | true =>
              simp only [Bool.not_true, Bool.false_eq_true, ite_false]
              cases ad with
              | false => simpa using logged
              | true =>
                simp only [Bool.not_true, Bool.false_eq_true, ite_false]
                refine Inv.admit logged ?_ (fresh_true hf)
                exact rootRun_stable hscope.1 hscope.2 hl (fun _ ht => ht) (fun _ hx => hx)
                  (List.mem_cons_self) ⟨rfl, rfl, auth, hres, hauth⟩
        · have hne : (conv.account != c.account || conv.agent != ag) = true := by
            simp only [Bool.or_eq_true, bne_iff_ne]
            by_cases ha : conv.account = c.account
            · right
              intro hb
              exact hscope ⟨ha, hb⟩
            · left; exact ha
          simp only [hne, ite_true]
          exact logged
      · have hne : (Access.authAccount auth != some c.account) = true := by
          simpa using hauth
        simp only [hne, ite_true]
        exact logged
  | delivery a v ag conv id den rec ad =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    cases v with
    | false => simpa using logged
    | true =>
      simp only [Bool.not_true, Bool.false_eq_true, ite_false]
      by_cases hscope : conv.account = a ∧ conv.agent = ag
      · simp only [hscope.1, hscope.2, bne_self_eq_false, Bool.or_self, ite_false, Bool.false_eq_true]
        cases hl : cfg.lookup a ag with
        | none => exact logged
        | some entry =>
          simp only
          cases hf : fresh s.runs id with
          | false => simpa using logged
          | true =>
            simp only [Bool.not_true, Bool.false_eq_true, ite_false]
            cases ad with
            | false => simpa using logged
            | true =>
              simp only [Bool.not_true, Bool.false_eq_true, ite_false]
              refine Inv.admit logged ?_ (fresh_true hf)
              refine rootRun_stable hscope.1 hscope.2 hl ?_ ?_ (List.mem_cons_self)
                ⟨rfl, rfl, rfl⟩
              · intro t ht
                exact (List.mem_filter.1 ht).1
              · intro x hx
                unfold Channels.selectRefs at hx
                split at hx
                · exact hx
                · exact (List.mem_filter.1 hx).1
      · have hne : (conv.account != a || conv.agent != ag) = true := by
          simp only [Bool.or_eq_true, bne_iff_ne]
          by_cases ha : conv.account = a
          · right
            intro hb
            exact hscope ⟨ha, hb⟩
          · left; exact ha
        simp only [hne, ite_true]
        exact logged
  | spawn a p ag ch =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    split
    · rename_i pr entry hp hl
      obtain ⟨pMem, _, pLive⟩ := liveRun_some hp
      cases hf : fresh s.runs ch with
      | false => simpa using logged
      | true =>
        simp only [Bool.not_true, Bool.false_eq_true, ite_false]
        have parent := logged.stable pr pMem
        refine Inv.admit logged ?_ (fresh_true hf)
        exact
          { conversationAccount := rfl
            principalAccount := parent.principalAccount
            sameAgent := rfl
            attached := ⟨entry, hl, fun _ ht => ht, fun _ hx => hx⟩
            origin := parent.origin }
    · exact logged
  | toolCall a id t sb g wt gr =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    repeat' first | split | exact logged
  | reply a id =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    split <;> exact logged
  | settle a id =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, _, live⟩ := liveRun_some hr
      exact logged.endRun mem live (by decide) (by decide)
  | leaseExpired a id =>
    simp only [Input.account] at h logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, _, live⟩ := liveRun_some hr
      exact logged.endRun mem live (by decide) (by decide)

end Spec.Runtime
