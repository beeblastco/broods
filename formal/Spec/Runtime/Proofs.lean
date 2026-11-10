import Spec.Kit
import Spec.Runtime.Model

/-!
One inductive invariant of one account's state, proved for each input kind, in the manner of FlashProve's
round-by-round state functions: if the invariant holds before a step it holds after, whatever the input.
-/

namespace Spec.Runtime

/-- `i` is what authorises work on `account` under `root`: a credential that may start that agent's run
over the direct API or `/mcp` (`startAuth` and `mayStart`), or a delivery whose signature checked out,
that started that root run. -/
def Authorizes (cfg : Config) (i : Input) (account : AccountId) (root : RunId) : Prop :=
  match i with
  | .request credential gatewayRequest route agent _ id _ =>
    credential.account = account ∧ id = root ∧
      ∃ auth entry, startAuth credential gatewayRequest route = some auth ∧
        Access.authAccount auth = some account ∧ cfg.lookup account agent = some entry ∧
        mayStart credential auth route entry = true
  | .delivery a verified _ _ id _ _ _ => a = account ∧ verified = true ∧ id = root
  | _ => False

/-- `p` spawned `c`: `p` is a root run allowed to delegate, `c` may not delegate further, `c` runs no
tool `p` denies, and `c` is an agent `p` allows or a virtual child on `p`'s own config. -/
def Delegated (p c : Run) : Prop :=
  p.parent = none ∧ c.subagents = none ∧ (∀ t ∈ c.tools, t ∉ p.deny) ∧
    ∃ allowed, p.subagents = some allowed ∧
      (c.configAgent ∈ allowed ∨ c.configAgent = p.configAgent)

/-- The facts about one run that no status change can touch. -/
structure Stable (cfg : Config) (account : AccountId) (log : List Input) (r : Run) : Prop where
  conversationAccount : r.conversation.account = account
  principalAccount : r.context.principal.account = account
  sameAgent : r.conversation.agent = r.context.principal.agent
  attached : ∃ entry, cfg.lookup account r.configAgent = some entry ∧
    (∀ t ∈ r.tools, t ∈ entry.tools ∧ t ∉ entry.deny) ∧ (∀ x ∈ r.sandboxes, x ∈ entry.sandboxes)
  denied : ∀ t ∈ r.tools, t ∉ r.deny
  delegatorIsRoot : r.subagents.isSome = true → r.parent = none
  origin : ∃ w ∈ log, Authorizes cfg w account r.root

/-- The invariant of one account's runs. -/
structure Inv (cfg : Config) (account : AccountId) (log : List Input) (runs : List Run) : Prop where
  stable : ∀ r ∈ runs, Stable cfg account log r
  unique : ∀ a ∈ runs, ∀ b ∈ runs, a.id = b.id → a = b
  exclusive : ∀ a ∈ runs, ∀ b ∈ runs, a.status = .running → b.status = .running →
    a.conversation = b.conversation → a = b
  children : ∀ c ∈ runs, ∀ pid, c.parent = some pid → ∃ p ∈ runs, p.id = pid ∧ Delegated p c

theorem Stable.status {cfg : Config} {account : AccountId} {log : List Input} {r : Run}
    (h : Stable cfg account log r) (st : Status) : Stable cfg account log { r with status := st } :=
  { conversationAccount := h.conversationAccount
    principalAccount := h.principalAccount
    sameAgent := h.sameAgent
    attached := h.attached
    denied := h.denied
    delegatorIsRoot := h.delegatorIsRoot
    origin := h.origin }

theorem Stable.mono {cfg : Config} {account : AccountId} {log : List Input} {r : Run} (i : Input)
    (h : Stable cfg account log r) : Stable cfg account (i :: log) r :=
  { conversationAccount := h.conversationAccount
    principalAccount := h.principalAccount
    sameAgent := h.sameAgent
    attached := h.attached
    denied := h.denied
    delegatorIsRoot := h.delegatorIsRoot
    origin := by
      obtain ⟨w, hw, ha⟩ := h.origin
      exact ⟨w, List.mem_cons_of_mem _ hw, ha⟩ }

theorem Inv.mono {cfg : Config} {account : AccountId} {log : List Input} {runs : List Run} (i : Input)
    (h : Inv cfg account log runs) : Inv cfg account (i :: log) runs :=
  { stable := fun r hr => (h.stable r hr).mono i
    unique := h.unique
    exclusive := h.exclusive
    children := h.children }

theorem liveRun_some {runs : List Run} {id : RunId} {r : Run} (h : liveRun runs id = some r) :
    r ∈ runs ∧ r.id = id ∧ (r.status = .running ∨ r.status = .detached) := by
  have mem := List.mem_of_find?_eq_some h
  have sat := List.find?_some h
  simp only [Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq] at sat
  exact ⟨mem, sat.1, sat.2⟩

theorem ownerRun_some {runs : List Run} {id : RunId} {r : Run} (h : ownerRun runs id = some r) :
    r ∈ runs ∧ r.id = id ∧ r.status = .running := by
  have mem := List.mem_of_find?_eq_some h
  have sat := List.find?_some h
  simp only [Bool.and_eq_true, beq_iff_eq] at sat
  exact ⟨mem, sat.1, sat.2⟩

theorem queuedRun_some {runs : List Run} {id : RunId} {r : Run} (h : queuedRun runs id = some r) :
    r ∈ runs ∧ r.id = id ∧ r.status = .queued := by
  have mem := List.mem_of_find?_eq_some h
  have sat := List.find?_some h
  simp only [Bool.and_eq_true, beq_iff_eq] at sat
  exact ⟨mem, sat.1, sat.2⟩

theorem nextQueued_some {runs : List Run} {c : Conversation} {n : Run}
    (h : nextQueued runs c = some n) : n ∈ runs ∧ n.status = .queued ∧ n.conversation = c := by
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

theorem busy_of_mem {runs : List Run} {c : Conversation} {o : Run} (ho : o ∈ runs)
    (hs : o.status = .running) (hc : o.conversation = c) : busy runs c = true := by
  simp only [busy, List.any_eq_true, Bool.and_eq_true, beq_iff_eq]
  exact ⟨o, ho, hs, hc⟩

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

/-- A status change to anything but `running` makes no new owner. -/
theorem setStatus_running {runs : List Run} {id : RunId} {st : Status} (hst : st ≠ .running)
    {x : Run} (hx : x ∈ setStatus runs id st) (hr : x.status = .running) : x ∈ runs := by
  obtain ⟨r, hrm, ⟨_, rfl⟩ | ⟨_, rfl⟩⟩ := mem_setStatus hx
  · exact absurd hr hst
  · exact hrm

/-- Every run keeps an image of the same id and the same delegation facts. -/
theorem setStatus_image {runs : List Run} {id : RunId} {st : Status} {p : Run} (hp : p ∈ runs) :
    ∃ q ∈ setStatus runs id st, q.id = p.id ∧ q.root = p.root ∧ ∀ c, Delegated p c → Delegated q c := by
  by_cases hid : p.id = id
  · exact ⟨_, mem_setStatus_self hp hid, rfl, rfl, fun _ h => h⟩
  · exact ⟨p, mem_setStatus_other hp hid, rfl, rfl, fun _ h => h⟩

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

/-- Changing one run's status keeps the invariant, unless it makes a second owner. -/
theorem Inv.setStatus {cfg : Config} {account : AccountId} {log : List Input} {runs : List Run}
    {x : Run} {st : Status} (h : Inv cfg account log runs) (hx : x ∈ runs)
    (hsafe : st = .running → ∀ r ∈ runs, r.id ≠ x.id → r.status = .running →
      r.conversation ≠ x.conversation) :
    Inv cfg account log (Spec.Runtime.setStatus runs x.id st) := by
  refine ⟨stable_setStatus h.stable, unique_setStatus h.unique, ?_, ?_⟩
  · intro a ha b hb sa sb hc
    obtain ⟨ra, hra, ⟨hida, ea⟩ | ⟨hida, ea⟩⟩ := mem_setStatus ha <;>
      obtain ⟨rb, hrb, ⟨hidb, eb⟩ | ⟨hidb, eb⟩⟩ := mem_setStatus hb <;> subst a <;> subst b
    · rw [h.unique ra hra rb hrb (hida.trans hidb.symm)]
    · have rax : ra = x := h.unique ra hra x hx hida
      subst rax
      have hc' : ra.conversation = rb.conversation := hc
      exact absurd hc'.symm (hsafe sa rb hrb hidb sb)
    · have rbx : rb = x := h.unique rb hrb x hx hidb
      subst rbx
      have hc' : ra.conversation = rb.conversation := hc
      exact absurd hc' (hsafe sb ra hra hida sa)
    · exact h.exclusive ra hra rb hrb sa sb hc
  · intro c hc pid hpar
    obtain ⟨rc, hrc, ⟨_, ec⟩ | ⟨_, ec⟩⟩ := mem_setStatus hc <;> subst c
    · obtain ⟨p, hp, hpid, hd⟩ := h.children rc hrc pid hpar
      obtain ⟨q, hq, hqid, _, hqd⟩ := setStatus_image (id := x.id) (st := st) hp
      exact ⟨q, hq, hqid.trans hpid, hqd _ hd⟩
    · obtain ⟨p, hp, hpid, hd⟩ := h.children rc hrc pid hpar
      obtain ⟨q, hq, hqid, _, hqd⟩ := setStatus_image (id := x.id) (st := st) hp
      exact ⟨q, hq, hqid.trans hpid, hqd _ hd⟩

/-- Appending a fresh run keeps the invariant, provided it makes no second owner and its parent, if
any, is there and delegated to it. -/
theorem Inv.append {cfg : Config} {account : AccountId} {log : List Input} {runs : List Run} {n : Run}
    (h : Inv cfg account log runs) (hs : Stable cfg account log n)
    (hf : ∀ r ∈ runs, r.id ≠ n.id)
    (hrun : n.status = .running → ∀ r ∈ runs, r.status = .running → r.conversation ≠ n.conversation)
    (hpar : ∀ pid, n.parent = some pid → ∃ p ∈ runs, p.id = pid ∧ Delegated p n) :
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
  · intro c hc pid hpar'
    rcases List.mem_append.1 hc with hc | hc
    · obtain ⟨p, hp, hpid, hd⟩ := h.children c hc pid hpar'
      exact ⟨p, List.mem_append_left _ hp, hpid, hd⟩
    · rw [List.mem_singleton.1 hc] at hpar' ⊢
      obtain ⟨p, hp, hpid, hd⟩ := hpar pid hpar'
      exact ⟨p, List.mem_append_left _ hp, hpid, hd⟩

/-- What `promote` leaves in the run list. -/
theorem promote_runs (s : AccountState) (account : AccountId) (c : Conversation) :
    (promote s account c).1.runs = s.runs ∨
      ∃ n, nextQueued s.runs c = some n ∧ busy s.runs c = false ∧
        (promote s account c).1.runs = setStatus s.runs n.id .running := by
  unfold promote
  cases hb : busy s.runs c with
  | true => exact Or.inl rfl
  | false =>
    cases hn : nextQueued s.runs c with
    | none => exact Or.inl rfl
    | some n => exact Or.inr ⟨n, rfl, rfl, rfl⟩

/-- Every run keeps an image through `promote`, with the same id, root and delegation facts. -/
theorem promote_image {s : AccountState} {account : AccountId} {c : Conversation} {p : Run}
    (hp : p ∈ s.runs) :
    ∃ q ∈ (promote s account c).1.runs, q.id = p.id ∧ q.root = p.root ∧
      ∀ d, Delegated p d → Delegated q d := by
  rcases promote_runs s account c with heq | ⟨n, _, _, heq⟩
  · rw [heq]; exact ⟨p, hp, rfl, rfl, fun _ h => h⟩
  · rw [heq]; exact setStatus_image hp

/-- A run after `promote` came from one before it, with the same id and root. -/
theorem promote_mem {s : AccountState} {account : AccountId} {c : Conversation} {r : Run}
    (hr : r ∈ (promote s account c).1.runs) : ∃ o ∈ s.runs, o.id = r.id ∧ o.root = r.root := by
  rcases promote_runs s account c with heq | ⟨n, _, _, heq⟩
  · rw [heq] at hr; exact ⟨r, hr, rfl, rfl⟩
  · rw [heq] at hr
    obtain ⟨o, ho, ⟨_, eo⟩ | ⟨_, eo⟩⟩ := mem_setStatus hr <;> subst r
    · exact ⟨o, ho, rfl, rfl⟩
    · exact ⟨o, ho, rfl, rfl⟩

theorem Inv.promote {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState}
    {a : AccountId} {c : Conversation} (h : Inv cfg account log s.runs) :
    Inv cfg account log (Spec.Runtime.promote s a c).1.runs := by
  rcases promote_runs s a c with heq | ⟨n, hn, hb, heq⟩
  · rw [heq]; exact h
  · rw [heq]
    obtain ⟨nMem, _, nConv⟩ := nextQueued_some hn
    exact h.setStatus nMem (fun _ r hr _ hs hc => busy_false hb r hr hs (hc.trans nConv))

/-- `admit` keeps the invariant for a fresh, stable run whose parent, if any, delegated to it. -/
theorem Inv.admit {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState} {n : Run}
    {a : AccountId} {arrival : Arrival}
    (h : Inv cfg account log s.runs) (hs : Stable cfg account log n)
    (hf : ∀ r ∈ s.runs, r.id ≠ n.id)
    (hpar : ∀ pid, n.parent = some pid → ∃ p ∈ s.runs, p.id = pid ∧ Delegated p n) :
    Inv cfg account log (Spec.Runtime.admit s n a arrival).1.runs := by
  have h1 : Inv cfg account log (Spec.Runtime.promote s a n.conversation).1.runs := h.promote
  have hf1 : ∀ r ∈ (Spec.Runtime.promote s a n.conversation).1.runs, r.id ≠ n.id := by
    intro r hr
    obtain ⟨o, ho, hid, _⟩ := promote_mem hr
    rw [← hid]
    exact hf o ho
  have hpar1 : ∀ (st : Status) pid, n.parent = some pid →
      ∃ p ∈ (Spec.Runtime.promote s a n.conversation).1.runs, p.id = pid ∧ Delegated p { n with status := st } := by
    intro st pid hp
    obtain ⟨p, hpm, hpid, hd⟩ := hpar pid hp
    obtain ⟨q, hq, hqid, _, hqd⟩ := promote_image (account := a) (c := n.conversation) hpm
    exact ⟨q, hq, hqid.trans hpid, hqd _ hd⟩
  unfold Spec.Runtime.admit
  dsimp only
  split
  · split
    · exact h1
    · exact h1.append (hs.status _) hf1 (fun hst => by cases hst) (hpar1 .queued)
  · rename_i hb
    have hb' : busy (Spec.Runtime.promote s a n.conversation).1.runs n.conversation = false := by simpa using hb
    exact h1.append (hs.status _) hf1 (fun _ => busy_false hb') (hpar1 .running)

theorem Inv.arrive {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState} {n : Run}
    {a : AccountId} {arrival : Arrival}
    (h : Inv cfg account log s.runs) (hs : Stable cfg account log n)
    (hpar : ∀ pid, n.parent = some pid → ∃ p ∈ s.runs, p.id = pid ∧ Delegated p n) :
    Inv cfg account log (Spec.Runtime.arrive s n a arrival).1.runs := by
  unfold Spec.Runtime.arrive
  split
  · exact h
  · split
    · exact h
    · split
      · exact h
      · rename_i hf _
        have hf' : fresh s.runs n.id = true := by simpa using hf
        exact h.admit hs (fresh_true hf') hpar

theorem Inv.detach {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState} {n : Run}
    {a : AccountId} (h : Inv cfg account log s.runs) (hs : Stable cfg account log n)
    (hpar : ∀ pid, n.parent = some pid → ∃ p ∈ s.runs, p.id = pid ∧ Delegated p n) :
    Inv cfg account log (Spec.Runtime.detach s n a).1.runs := by
  unfold Spec.Runtime.detach
  split
  · exact h
  · rename_i hf
    have hf' : fresh s.runs n.id = true := by cases hfr : fresh s.runs n.id <;> simp_all
    exact h.append (hs.status _) (fresh_true hf') (fun hst => by cases hst)
      (fun pid hp => hpar pid hp)

/-- Ending a run keeps the invariant: its status is no longer `running`, and any hand-off goes
through `promote`. -/
theorem Inv.endRun {cfg : Config} {account : AccountId} {log : List Input} {s : AccountState} {run : Run}
    {a : AccountId} {st : Status} {handOn : Bool} (h : Inv cfg account log s.runs) (hrun : run ∈ s.runs)
    (hst : st ≠ .running) :
    Inv cfg account log (Spec.Runtime.endRun s a run st handOn).1.runs := by
  have h1 : Inv cfg account log (Spec.Runtime.setStatus s.runs run.id st) :=
    h.setStatus hrun (fun hs => absurd hs hst)
  unfold Spec.Runtime.endRun
  dsimp only
  split
  · exact Inv.promote (s := { s with runs := Spec.Runtime.setStatus s.runs run.id st }) h1
  · exact h1

/-- After `promote`, a conversation with a queued run has an owner. -/
theorem promote_busy {s : AccountState} {a : AccountId} {c : Conversation} {r : Run}
    (hr : r ∈ (promote s a c).1.runs) (hq : r.status = .queued) (hc : r.conversation = c) :
    busy (promote s a c).1.runs c = true := by
  unfold promote at hr ⊢
  cases hb : busy s.runs c with
  | true => simp [hb]
  | false =>
    cases hn : nextQueued s.runs c with
    | none =>
      simp only [hb, hn, Bool.false_eq_true, ite_false] at hr
      have none := List.find?_eq_none.1 hn r hr
      simp [hq, hc] at none
    | some n =>
      obtain ⟨nMem, _, nConv⟩ := nextQueued_some hn
      simp only [Bool.false_eq_true, ite_false]
      exact busy_of_mem (mem_setStatus_self nMem rfl) rfl nConv

/-- What `promote` emits: a start of one of the account's own runs. -/
theorem promote_effects {s : AccountState} {a : AccountId} {c : Conversation} {e : Effect}
    (he : e ∈ (promote s a c).2) : e.account = a ∧ ∃ r ∈ s.runs, e.root = r.root := by
  unfold promote at he
  split at he
  · simp at he
  · split at he
    · simp at he
    · rename_i n hn
      simp only [List.mem_singleton] at he
      subst he
      exact ⟨rfl, n, (nextQueued_some hn).1, rfl⟩

theorem admit_effects {s : AccountState} {n : Run} {a : AccountId} {arrival : Arrival} {e : Effect}
    (he : e ∈ (admit s n a arrival).2) :
    e.account = a ∧ (e.root = n.root ∨ ∃ r ∈ s.runs, e.root = r.root) := by
  have fromPromote : e ∈ (promote s a n.conversation).2 →
      e.account = a ∧ (e.root = n.root ∨ ∃ r ∈ s.runs, e.root = r.root) := fun hm =>
    let ⟨acc, rest⟩ := promote_effects hm
    ⟨acc, Or.inr rest⟩
  unfold admit at he
  dsimp only at he
  split at he
  · split at he <;>
      · rcases List.mem_append.1 he with he | he
        · exact fromPromote he
        · simp only [List.mem_singleton] at he
          subst he
          exact ⟨rfl, Or.inl rfl⟩
  · rcases List.mem_append.1 he with he | he
    · exact fromPromote he
    · simp only [List.mem_singleton] at he
      subst he
      exact ⟨rfl, Or.inl rfl⟩

theorem arrive_effects {s : AccountState} {n : Run} {a : AccountId} {arrival : Arrival} {e : Effect}
    (he : e ∈ (arrive s n a arrival).2) :
    e.account = a ∧ (e.root = n.root ∨ ∃ r ∈ s.runs, e.root = r.root) := by
  unfold arrive at he
  split at he
  · simp at he
  · split at he
    · simp at he
    · split at he
      · simp only [List.mem_singleton] at he
        subst he
        exact ⟨rfl, Or.inl rfl⟩
      · exact admit_effects he

theorem detach_effects {s : AccountState} {n : Run} {a : AccountId} {e : Effect}
    (he : e ∈ (detach s n a).2) : e.account = a ∧ e.root = n.root := by
  unfold detach at he
  split at he
  · simp at he
  · simp only [List.mem_singleton] at he
    subst he
    exact ⟨rfl, rfl⟩

theorem endRun_effects {s : AccountState} {a : AccountId} {run : Run} {st : Status} {handOn : Bool}
    {e : Effect} (hrun : run ∈ s.runs) (he : e ∈ (endRun s a run st handOn).2) :
    e.account = a ∧ ∃ r ∈ s.runs, e.root = r.root := by
  unfold endRun at he
  dsimp only at he
  rcases List.mem_cons.1 he with he | he
  · subst he
    exact ⟨rfl, run, hrun, rfl⟩
  · split at he
    · obtain ⟨hacc, r, hr, hroot⟩ := promote_effects he
      obtain ⟨o, ho, ⟨_, eo⟩ | ⟨_, eo⟩⟩ := mem_setStatus hr <;> subst r
      · exact ⟨hacc, o, ho, hroot⟩
      · exact ⟨hacc, o, ho, hroot⟩
    · simp at he

/-- A run a direct request asks for passed every check, and the request authorises it. -/
theorem requestRun_some {cfg : Config} {c : Access.Credential} {r : Access.Request} {route : DirectRoute}
    {ag : AgentId} {conv : Conversation} {id : RunId} {n : Run} (arrival : Arrival)
    (h : requestRun cfg c r route ag conv id = some n) :
    ∃ entry, cfg.lookup c.account ag = some entry ∧ conv.account = c.account ∧ conv.agent = ag ∧
      Authorizes cfg (.request c r route ag conv id arrival) c.account id ∧
      n = rootRun c.account ag conv id entry entry.deny entry.sandboxes := by
  unfold requestRun at h
  cases hs : startAuth c r route with
  | none => simp [hs] at h
  | some auth =>
    cases hl : cfg.lookup c.account ag with
    | none => simp [hs, hl] at h
    | some entry =>
      simp only [hs, hl] at h
      split at h
      · rename_i hcond
        simp only [Bool.and_eq_true, beq_iff_eq] at hcond
        obtain ⟨⟨⟨ha, hm⟩, hca⟩, hag⟩ := hcond
        cases h
        exact ⟨entry, rfl, hca, hag, ⟨rfl, rfl, auth, entry, hs, ha, hl, hm⟩, rfl⟩
      · cases h

theorem deliveryRun_some {cfg : Config} {a : AccountId} {v : Bool} {ag : AgentId} {conv : Conversation}
    {id : RunId} {den : List ToolId} {rec : List SandboxId} {n : Run}
    (h : deliveryRun cfg a v ag conv id den rec = some n) :
    ∃ entry, cfg.lookup a ag = some entry ∧ v = true ∧ conv.account = a ∧ conv.agent = ag ∧
      n = rootRun a ag conv id entry (entry.deny ++ den) (Channels.selectRefs entry.sandboxes rec) := by
  unfold deliveryRun at h
  cases hl : cfg.lookup a ag with
  | none => simp [hl] at h
  | some entry =>
    simp only [hl] at h
    split at h
    · rename_i hcond
      simp only [Bool.and_eq_true, beq_iff_eq] at hcond
      obtain ⟨⟨hv, hca⟩, hag⟩ := hcond
      cases h
      exact ⟨entry, rfl, hv, hca, hag, rfl⟩
    · cases h

/-- A root run accepted from an authorising input satisfies `Stable` once that input is logged. -/
theorem rootRun_stable {cfg : Config} {account : AccountId} {log : List Input} {agent : AgentId}
    {conversation : Conversation} {id : RunId} {deny : List ToolId} {sandboxes : List SandboxId}
    {entry : AgentConfig} {w : Input}
    (hAccount : conversation.account = account) (hAgent : conversation.agent = agent)
    (hLookup : cfg.lookup account agent = some entry)
    (hDeny : ∀ t ∈ entry.deny, t ∈ deny) (hSandboxes : ∀ x ∈ sandboxes, x ∈ entry.sandboxes)
    (hw : w ∈ log) (hAuth : Authorizes cfg w account id) :
    Stable cfg account log (rootRun account agent conversation id entry deny sandboxes) := by
  have kept : ∀ t ∈ Channels.allowedTools entry.tools deny, t ∈ entry.tools ∧ t ∉ deny := by
    intro t ht
    have := List.mem_filter.1 ht
    simp only [decide_eq_true_eq] at this
    exact this
  exact
    { conversationAccount := hAccount
      principalAccount := rfl
      sameAgent := hAgent
      attached := ⟨entry, hLookup, fun t ht => ⟨(kept t ht).1, fun hd => (kept t ht).2 (hDeny t hd)⟩,
        hSandboxes⟩
      denied := fun t ht => (kept t ht).2
      delegatorIsRoot := fun _ => rfl
      origin := ⟨w, hw, hAuth⟩ }

/-- The child a live, stable parent spawns is stable, delegated by that parent, and under its root. -/
theorem childRun_some {cfg : Config} {account : AccountId} {log : List Input} {p : Run}
    {target : SpawnTarget} {id : RunId} {c : Run} (hp : Stable cfg account log p)
    (h : childRun cfg account p target id = some c) :
    Stable cfg account log c ∧ Delegated p c ∧ c.root = p.root ∧ c.parent = some p.id := by
  unfold childRun at h
  cases hsub : p.subagents with
  | none => simp [hsub] at h
  | some allowed =>
    have pRoot : p.parent = none := hp.delegatorIsRoot (by simp [hsub])
    cases target with
    | named agent =>
      simp only [hsub] at h
      split at h
      · rename_i hallowed
        cases hl : cfg.lookup account agent with
        | none => simp [hl] at h
        | some entry =>
          simp only [hl, Option.map_some, Option.some.injEq] at h
          subst h
          have kept : ∀ t ∈ Channels.allowedTools entry.tools (p.deny ++ entry.deny),
              t ∈ entry.tools ∧ t ∉ p.deny ∧ t ∉ entry.deny := by
            intro t ht
            have := List.mem_filter.1 ht
            simp only [decide_eq_true_eq, List.mem_append, not_or] at this
            exact this
          refine ⟨
            { conversationAccount := rfl
              principalAccount := hp.principalAccount
              sameAgent := rfl
              attached := ⟨entry, hl, fun t ht => ⟨(kept t ht).1, (kept t ht).2.2⟩, fun _ hx => hx⟩
              denied := fun t ht hd => by
                rcases List.mem_append.1 hd with hd | hd
                · exact (kept t ht).2.1 hd
                · exact (kept t ht).2.2 hd
              delegatorIsRoot := fun hs => by simp at hs
              origin := hp.origin },
            ⟨pRoot, rfl, fun t ht => (kept t ht).2.1, allowed, hsub, Or.inl (by simpa using hallowed)⟩,
            rfl, rfl⟩
      · cases h
    | virtual agent =>
      simp only [hsub, Option.some.injEq] at h
      subst h
      exact ⟨
        { conversationAccount := rfl
          principalAccount := hp.principalAccount
          sameAgent := rfl
          attached := hp.attached
          denied := hp.denied
          delegatorIsRoot := fun hs => by simp at hs
          origin := hp.origin },
        ⟨pRoot, rfl, hp.denied, allowed, hsub, Or.inr rfl⟩, rfl, rfl⟩

theorem childRun_root {cfg : Config} {account : AccountId} {p : Run} {target : SpawnTarget}
    {id : RunId} {c : Run} (h : childRun cfg account p target id = some c) : c.root = p.root := by
  unfold childRun at h
  cases hsub : p.subagents with
  | none => simp [hsub] at h
  | some allowed =>
    cases target with
    | named agent =>
      simp only [hsub] at h
      split at h
      · simp at h
        obtain ⟨_, _, rfl⟩ := h
        rfl
      · cases h
    | virtual agent =>
      simp only [hsub, Option.some.injEq] at h
      subst h
      rfl

/-- Every effect names the input's account, and belongs to one of the account's runs or to the run
the input itself authorises. No invariant is needed. -/
theorem step_effect (cfg : Config) (s : AccountState) (i : Input) (e : Effect)
    (he : e ∈ (accountStep cfg s i).2) :
    e.account = i.account ∧ ((∃ r ∈ s.runs, e.root = r.root) ∨ Authorizes cfg i e.account e.root) := by
  cases i with
  | request c r route ag conv id arr =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i n hn
      obtain ⟨_, _, _, _, hauth, rfl⟩ := requestRun_some arr hn
      obtain ⟨hacc, hroot | hold⟩ := arrive_effects he
      · refine ⟨hacc, Or.inr ?_⟩
        rw [hacc, hroot]
        exact hauth
      · exact ⟨hacc, Or.inl hold⟩
  | delivery a v ag conv id den rec arr =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i n hn
      obtain ⟨_, _, hv, _, _, rfl⟩ := deliveryRun_some hn
      obtain ⟨hacc, hroot | hold⟩ := arrive_effects he
      · refine ⟨hacc, Or.inr ?_⟩
        rw [hacc, hroot]
        exact ⟨rfl, hv, rfl⟩
      · exact ⟨hacc, Or.inl hold⟩
  | spawn a pid target ch persistent arr =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i p hp
      obtain ⟨pMem, _, _⟩ := liveRun_some hp
      split at he
      · simp at he
      · rename_i c hc
        have croot : c.root = p.root := childRun_root hc
        split at he
        · obtain ⟨hacc, hroot | hold⟩ := arrive_effects he
          · exact ⟨hacc, Or.inl ⟨p, pMem, hroot.trans croot⟩⟩
          · exact ⟨hacc, Or.inl hold⟩
        · obtain ⟨hacc, hroot⟩ := detach_effects he
          exact ⟨hacc, Or.inl ⟨p, pMem, hroot.trans croot⟩⟩
  | toolCall a id t sb g wt gr =>
    simp only [accountStep] at he
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
          exact ⟨rfl, Or.inl ⟨run, mem, rfl⟩⟩
  | reply a id =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      simp only [List.mem_singleton] at he
      subst he
      exact ⟨rfl, Or.inl ⟨run, mem, rfl⟩⟩
  | settle a id failed handoff =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      obtain ⟨hacc, rest⟩ := endRun_effects mem he
      exact ⟨hacc, Or.inl rest⟩
  | boundary a id handoff =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := ownerRun_some hr
      split at he
      · simp at he
      · obtain ⟨hacc, rest⟩ := endRun_effects mem he
        exact ⟨hacc, Or.inl rest⟩
  | release a id =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := ownerRun_some hr
      simp only [List.mem_singleton] at he
      subst he
      exact ⟨rfl, Or.inl ⟨run, mem, rfl⟩⟩
  | requeue a id =>
    simp only [accountStep] at he
    split at he <;> simp at he
  | expire a id =>
    simp only [accountStep] at he
    split at he
    · simp at he
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := queuedRun_some hr
      simp only [List.mem_singleton] at he
      subst he
      exact ⟨rfl, Or.inl ⟨run, mem, rfl⟩⟩
  | recover a c =>
    simp only [accountStep] at he
    split at he
    · obtain ⟨hacc, rest⟩ := promote_effects he
      exact ⟨hacc, Or.inl rest⟩
    · simp at he
  | status a b =>
    simp [accountStep] at he

/-- Every input keeps the account's invariant, with that input added to the log. -/
theorem inv_accountStep (cfg : Config) (s : AccountState) (i : Input)
    (h : Inv cfg i.account s.log s.runs) :
    Inv cfg i.account (i :: s.log) (accountStep cfg s i).1.runs := by
  have logged := h.mono i
  have noParent : ∀ (n : Run), n.parent = none →
      ∀ pid, n.parent = some pid → ∃ p ∈ s.runs, p.id = pid ∧ Delegated p n := by
    intro n hn pid hp
    rw [hn] at hp
    cases hp
  cases i with
  | request c r route ag conv id arr =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i n hn
      obtain ⟨entry, hl, hca, hag, hauth, rfl⟩ := requestRun_some arr hn
      exact logged.arrive
        (rootRun_stable hca hag hl (fun _ ht => ht) (fun _ hx => hx) List.mem_cons_self hauth)
        (noParent _ rfl)
  | delivery a v ag conv id den rec arr =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i n hn
      obtain ⟨entry, hl, hv, hca, hag, rfl⟩ := deliveryRun_some hn
      refine logged.arrive ?_ (noParent _ rfl)
      refine rootRun_stable hca hag hl (fun _ ht => List.mem_append_left _ ht) ?_ List.mem_cons_self
        ⟨rfl, hv, rfl⟩
      intro x hx
      unfold Channels.selectRefs at hx
      split at hx
      · exact hx
      · exact (List.mem_filter.1 hx).1
  | spawn a pid target ch persistent arr =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i p hp
      obtain ⟨pMem, _, _⟩ := liveRun_some hp
      split
      · exact logged
      · rename_i c hc
        obtain ⟨cs, cd, _, cpar⟩ := childRun_some (logged.stable p pMem) hc
        have hpar : ∀ q, c.parent = some q → ∃ p' ∈ s.runs, p'.id = q ∧ Delegated p' c := by
          intro q hq
          rw [cpar] at hq
          cases hq
          exact ⟨p, pMem, rfl, cd⟩
        split
        · exact logged.arrive cs hpar
        · exact logged.detach cs hpar
  | toolCall a id t sb g wt gr =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    repeat' first | split | exact logged
  | reply a id =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split <;> exact logged
  | settle a id failed handoff =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := liveRun_some hr
      exact logged.endRun mem (by unfold settledStatus; split <;> (try split) <;> decide)
  | boundary a id handoff =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, _, _⟩ := ownerRun_some hr
      split
      · exact logged
      · exact logged.endRun mem (by decide)
  | release a id =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, hid, _⟩ := ownerRun_some hr
      have kept := logged.setStatus (st := .failed) mem (fun hs => by cases hs)
      rw [hid] at kept
      exact kept
  | requeue a id =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, hid, _⟩ := ownerRun_some hr
      have kept := logged.setStatus (st := .queued) mem (fun hs => by cases hs)
      rw [hid] at kept
      exact kept
  | expire a id =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged
    · rename_i run hr
      obtain ⟨mem, hid, _⟩ := queuedRun_some hr
      have kept := logged.setStatus (st := .failed) mem (fun hs => by cases hs)
      rw [hid] at kept
      exact kept
  | recover a c =>
    simp only [Input.account] at logged ⊢
    simp only [accountStep]
    split
    · exact logged.promote
    · exact logged
  | status a b =>
    simp only [Input.account] at logged ⊢
    exact logged

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

theorem viewOf_append (a : AccountId) (x y : List Effect) :
    viewOf a (x ++ y) = viewOf a x ++ viewOf a y :=
  List.filter_append ..

theorem appendCongr {x x' y y' : List Effect} (hx : x = x') (hy : y = y') : x ++ y = x' ++ y' := by
  rw [hx, hy]

/-- The state after a schedule ending in one input is that input's step after the rest. -/
theorem runFrom_snoc (sys : Spec.System) (s : sys.State) (pre : List sys.Input) (x : sys.Input) :
    (sys.runFrom s (pre ++ [x])).1 = (sys.step (sys.runFrom s pre).1 x).1 := by
  induction pre generalizing s with
  | nil => rfl
  | cons i rest ih => exact ih _

/-- What `startAuth` gives a run token, a role session, a scoped key or the admin key, on either path:
never an account or a stage credential. -/
theorem restricted_auth (c : Access.Credential) (r : Access.Request) (route : DirectRoute)
    (auth : Access.Auth) (hkind : c.kind = .run ∨ c.kind = .role ∨ c.kind = .scoped ∨ c.kind = .admin)
    (hs : startAuth c r route = some auth) : ∀ entry, mayStart c auth route entry = false := by
  intro entry
  unfold startAuth Access.mcpResolve Access.resolve at hs
  rcases hkind with h | h | h | h <;> cases hm : route.mcp <;> cases hv : c.valid <;>
    cases ha : c.active <;> simp [h, hm, hv, ha] at hs <;> subst hs <;> simp [mayStart]

/-- Makes the model's equation lemmas here, so `Theorems` does not list them as claims. -/
theorem model_equations : True := by
  have := @Config.lookup.eq_1
  have := @admit.eq_1
  have := @arrive.eq_1
  have := @emptyWorld.eq_1
  have := @endRun.eq_1
  have := @liveRun.eq_1
  have := @mayStart.eq_1
  have := @mayStart.eq_2
  have := @mayStart.eq_3
  have := @nextQueued.eq_1
  have := @ownInputs.eq_1
  have := @ownerRun.eq_1
  have := @promote.eq_1
  have := @requestRun.eq_1
  have := @rootRun.eq_1
  have := @setStatus.eq_1
  have := @startAuth.eq_1
  have := @system.eq_1
  have := @step.eq_1
  have := @viewOf.eq_1
  have := @deliveryRun.eq_1
  have := @childRun.eq_1
  have := @detach.eq_1
  have := @queuedRun.eq_1
  have := @busy.eq_1
  have := @fresh.eq_1
  trivial

end Spec.Runtime
