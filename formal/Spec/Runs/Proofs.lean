import Spec.Kit
import Spec.Runs.Model
namespace Spec.Runs.Proofs

theorem fence_unique (s : State) (a b : Owner) (now : Nat)
    (ha : fence s a now = true) (hb : fence s b now = true) : a = b := by
  simp [fence] at ha hb
  exact Option.some.inj (ha.1.symm.trans hb.1)

theorem stale_boundary (s : State) (o : Owner) (now ttl sender : Nat) (claim : Bool)
    (results : List Nat) (h : fence s o now = false) :
    (step s (.stepBoundary o now ttl claim sender results)).1 = s := by
  simp [step, h]

theorem tied_async (run : Nat) (continuation : Option Nat) :
    asyncWrite true run continuation = true ↔ continuation = some run := by
  simp [asyncWrite]

/-- Rows of `b` come from rows of `a` with the same key; an expired or queued row is unchanged,
except a queued row expired under `G`. -/
def Tracks (G : Row → Prop) (a b : List Row) : Prop :=
  ∀ x ∈ b, ∃ y ∈ a, y.key = x.key ∧ (x.phase = .expired → x = y ∨ (y.phase = .queued ∧ G y)) ∧
    (x.phase = .queued → x = y)

/-- An expired row of `b` was expired in `a`, or was queued there and expired under `G`. -/
def ExpiredFrom (G : Row → Prop) (a b : List Row) : Prop :=
  ∀ x ∈ b, x.phase = .expired → ∃ y ∈ a, y.key = x.key ∧ (x = y ∨ (y.phase = .queued ∧ G y))

theorem tracks_refl {G : Row → Prop} (a : List Row) : Tracks G a a :=
  fun x hx => ⟨x, hx, rfl, fun _ => Or.inl rfl, fun _ => rfl⟩

theorem tracks_filter {G : Row → Prop} (a : List Row) (p : Row → Bool) : Tracks G a (a.filter p) :=
  fun x hx => ⟨x, (List.mem_filter.1 hx).1, rfl, fun _ => Or.inl rfl, fun _ => rfl⟩

theorem tracks_map {G : Row → Prop} (a : List Row) (f : Row → Row)
    (hf : ∀ y, (f y).key = y.key ∧ ((f y).phase = .expired → f y = y ∨ (y.phase = .queued ∧ G y)) ∧
      ((f y).phase = .queued → f y = y)) : Tracks G a (a.map f) := by
  intro x hx
  obtain ⟨y, hy, rfl⟩ := List.mem_map.1 hx
  exact ⟨y, hy, (hf y).1.symm, (hf y).2⟩

theorem tracks_mono {G H : Row → Prop} {a b : List Row} (h : Tracks G a b) (gh : ∀ y, G y → H y) :
    Tracks H a b := by
  intro x hx
  obtain ⟨y, hy, k, e, q⟩ := h x hx
  exact ⟨y, hy, k, fun he => (e he).imp id (fun ⟨hq, hg⟩ => ⟨hq, gh y hg⟩), q⟩

theorem tracks_trans {G : Row → Prop} {a b c : List Row} (hab : Tracks G a b) (hbc : Tracks G b c) :
    Tracks G a c := by
  intro x hx
  obtain ⟨y, hy, ky, ey, qy⟩ := hbc x hx
  obtain ⟨z, hz, kz, ez, qz⟩ := hab y hy
  refine ⟨z, hz, kz.trans ky, ?_, ?_⟩
  · intro hxe
    rcases ey hxe with rfl | ⟨hyq, hg⟩
    · exact ez hxe
    · have hyz := qz hyq
      subst hyz
      exact Or.inr ⟨hyq, hg⟩
  · intro hxq
    have hxy := qy hxq
    subst hxy
    exact qz hxq

theorem expired_of_tracks {G : Row → Prop} {a b : List Row} (h : Tracks G a b) : ExpiredFrom G a b := by
  intro x hx he
  obtain ⟨y, hy, k, e, _⟩ := h x hx
  exact ⟨y, hy, k, e he⟩

theorem expired_append {G : Row → Prop} {a b : List Row} (n : Row) (h : ExpiredFrom G a b)
    (fresh : n.phase ≠ .expired) : ExpiredFrom G a (b ++ [n]) := by
  intro x hx he
  rcases List.mem_append.1 hx with hb | hn
  · exact h x hb he
  · rw [List.mem_singleton.1 hn] at he
    exact absurd he fresh

theorem mark_tracks {G : Row → Prop} (s : State) (sel : List Row) (o : Owner) :
    Tracks G s.rows (mark s sel o).rows :=
  tracks_map _ _ (fun y => by by_cases h : y ∈ sel <;> simp [h])

theorem finish_tracks {G : Row → Prop} (s : State) (o : Owner) (failed : Bool) :
    Tracks G s.rows (finish s o failed).rows := by
  refine tracks_map _ _ (fun y => ?_)
  by_cases h : (y.phase == .processing && y.appliedTo == o.event) = true
  · cases failed <;> simp [h]
  · simp [h]

theorem expire_tracks (s : State) (now : Nat) :
    Tracks (fun y => mayExpire s now y = true) s.rows (expireQueued s now).rows := by
  refine tracks_map _ _ (fun y => ?_)
  by_cases h : mayExpire s now y = true
  · have hq : y.phase = .queued := by simp [mayExpire] at h; exact h.1.1.1
    simp [h, hq]
  · simp [h]

theorem storeResults_tracks {G : Row → Prop} (s : State) (results : List Nat) :
    Tracks G s.rows (storeResults s results).rows :=
  tracks_refl _

theorem store_tracks {G : Row → Prop} (s : State) (o : Owner) (results : List Nat) :
    Tracks G s.rows (store s o results).rows :=
  storeResults_tracks s results

theorem promote_tracks {G : Row → Prop} (s : State) (now ttl : Nat) :
    Tracks G s.rows (promote s now ttl).1.rows := by
  unfold promote
  split
  · exact tracks_refl _
  · exact mark_tracks _ _ _

theorem mayExpire_rows (s : State) (rows : List Row) (now : Nat) (y : Row) :
    mayExpire { s with rows := rows } now y = mayExpire s now y := rfl

theorem steer_tracks (s : State) (o : Owner) (now ttl sender : Nat) :
    Tracks (fun y => mayExpire s now y = true) s.rows (steer s o now ttl sender).1.rows := by
  unfold steer
  split
  · exact tracks_refl _
  · exact tracks_trans (expire_tracks s now) (mark_tracks _ _ _)

theorem admit_expired (s : State) (r : Row) (now ttl : Nat) :
    ExpiredFrom (fun y => mayExpire s now y = true) s.rows (admit s r now ttl).1.rows := by
  have ready : Tracks (fun y => mayExpire s now y = true) s.rows (prepare s now ttl).rows := by
    unfold prepare
    split
    · exact expire_tracks s now
    · exact tracks_trans (expire_tracks s now) (promote_tracks _ _ _)
  unfold admit
  split
  · exact expired_of_tracks (tracks_refl _)
  · simp only
    split
    · exact expired_of_tracks ready
    · split
      · exact expired_append _ (expired_of_tracks ready) (by simp)
      · exact expired_append _ (expired_of_tracks ready) (by simp)

/-- Every expired row after one input was expired before, was processing, or was queued and
expired under D6 at the input's own clock. -/
theorem step_expired (s : State) (i : Input) (x : Row) (hx : x ∈ (step s i).1.rows)
    (he : x.phase = .expired) :
    ∃ y ∈ s.rows, y.key = x.key ∧ (x = y ∨ y.phase = .processing ∨
      (y.phase = .queued ∧ ∃ now, i.time = some now ∧ mayExpire s now y = true)) := by
  have lift : ∀ {G : Row → Prop}, ExpiredFrom G s.rows (step s i).1.rows →
      (∀ y, G y → ∃ now, i.time = some now ∧ mayExpire s now y = true) →
      ∃ y ∈ s.rows, y.key = x.key ∧ (x = y ∨ y.phase = .processing ∨
        (y.phase = .queued ∧ ∃ now, i.time = some now ∧ mayExpire s now y = true)) := by
    intro G h g
    obtain ⟨y, hy, k, e⟩ := h x hx he
    exact ⟨y, hy, k, e.elim Or.inl (fun ⟨hq, hg⟩ => Or.inr (Or.inr ⟨hq, g y hg⟩))⟩
  have none : ∀ y, False → ∃ now, i.time = some now ∧ mayExpire s now y = true :=
    fun _ h => h.elim
  cases i with
  | accept r now ttl =>
    refine lift (G := fun y => mayExpire s now y = true) ?_ (fun y h => ⟨now, rfl, h⟩)
    simp only [step]
    split
    · exact expired_of_tracks (tracks_refl _)
    · split
      · split
        · intro z hz hze
          obtain ⟨y, hy, k, e⟩ := admit_expired _ r now ttl z hz hze
          exact ⟨y, (List.mem_filter.1 hy).1, k, e⟩
        · exact expired_of_tracks (tracks_refl _)
      · exact admit_expired s r now ttl
  | takeNext o now ttl settles rows =>
    refine lift (G := fun y => mayExpire s now y = true) ?_ (fun y h => ⟨now, rfl, h⟩)
    simp only [step]
    split
    · split
      · exact expired_of_tracks (tracks_refl _)
      · cases settles
        · exact expired_of_tracks (tracks_trans (expire_tracks s now) (promote_tracks _ _ _))
        · exact expired_of_tracks (tracks_trans (tracks_trans (finish_tracks s o false)
            (expire_tracks _ now)) (promote_tracks _ _ _))
    · exact expired_of_tracks (tracks_refl _)
  | applySteering o now ttl sender =>
    refine lift (G := fun y => mayExpire s now y = true) ?_ (fun y h => ⟨now, rfl, h⟩)
    simp only [step]
    split
    · exact expired_of_tracks (steer_tracks s o now ttl sender)
    · exact expired_of_tracks (tracks_refl _)
  | stepBoundary o now ttl claim sender results =>
    refine lift (G := fun y => mayExpire s now y = true) ?_ (fun y h => ⟨now, rfl, h⟩)
    simp only [step]
    split
    · exact expired_of_tracks (tracks_refl _)
    · split
      · exact expired_of_tracks (tracks_refl _)
      · split
        · exact expired_of_tracks (store_tracks s o results)
        · split
          · exact expired_of_tracks (tracks_trans (store_tracks s o results)
              (steer_tracks (store s o results) o now ttl sender))
          · unfold renew
            split <;> exact expired_of_tracks (store_tracks s o results)
  | settle o now failed results asyncResult =>
    refine lift (G := fun _ => False) ?_ none
    simp only [step]
    split
    · exact expired_of_tracks (tracks_refl _)
    · split
      · exact expired_of_tracks (tracks_refl _)
      · exact expired_of_tracks (tracks_trans (storeResults_tracks s results)
          (finish_tracks _ o failed))
  | renewOwner o now ttl =>
    refine lift (G := fun _ => False) ?_ none
    simp only [step]
    split
    · exact expired_of_tracks (tracks_refl _)
    · split
      · exact expired_of_tracks (tracks_refl _)
      · unfold renew
        split <;> exact expired_of_tracks (tracks_refl _)
  | releaseOwner o =>
    refine lift (G := fun _ => False) ?_ none
    simp only [step]
    split <;> exact expired_of_tracks (tracks_refl _)
  | stopOwner now =>
    refine lift (G := fun _ => False) ?_ none
    simp only [step]
    split <;> (try split) <;> exact expired_of_tracks (tracks_refl _)
  | status a =>
    refine lift (G := fun _ => False) ?_ none
    exact expired_of_tracks (tracks_refl _)
  | recoverQueued now ttl =>
    refine lift (G := fun y => mayExpire s now y = true) ?_ (fun y h => ⟨now, rfl, h⟩)
    simp only [step]
    split
    · exact expired_of_tracks (tracks_refl _)
    · exact expired_of_tracks (tracks_trans (expire_tracks s now) (promote_tracks _ _ _))
  | declineRecovery now =>
    refine lift (G := fun _ => False) ?_ none
    simp only [step]
    split <;> exact expired_of_tracks (tracks_refl _)
  | maintain now =>
    simp only [step, maintain] at hx
    obtain ⟨hm, _⟩ := List.mem_filter.1 hx
    obtain ⟨y, hy, rfl⟩ := List.mem_map.1 hm
    refine ⟨y, hy, ?_, ?_⟩
    · unfold maintainRow; split <;> (try split) <;> rfl
    · unfold maintainRow at he ⊢
      by_cases h1 : mayExpire s now y = true
      · have hq : y.phase = .queued := by simp [mayExpire] at h1; exact h1.1.1.1
        exact Or.inr (Or.inr ⟨hq, now, rfl, h1⟩)
      · by_cases h2 : (y.phase == .processing && !active s now && decide (y.expires ≤ now)) = true
        · simp at h2
          exact Or.inr (Or.inl h2.1.1)
        · left
          simp only [h1, h2, ite_false, Bool.false_eq_true]

theorem key_unique {l : List Row} (nodup : (l.map (·.key)).Nodup) {a b : Row}
    (ha : a ∈ l) (hb : b ∈ l) (k : a.key = b.key) : a = b := by
  induction l with
  | nil => simp at ha
  | cons c rest ih =>
    simp only [List.map_cons, List.nodup_cons, List.mem_map] at nodup
    simp only [List.mem_cons] at ha hb
    rcases ha with rfl | ha <;> rcases hb with rfl | hb
    · rfl
    · exact absurd ⟨b, hb, k.symm⟩ nodup.1
    · exact absurd ⟨a, ha, k⟩ nodup.1
    · exact ih nodup.2 ha hb

/-- D6 over every input: a queued row becomes expired only when D6's guard held at that input. -/
theorem queued_expiry_guarded (s : State) (i : Input) (r x : Row)
    (keys : (s.rows.map (·.key)).Nodup) (hr : r ∈ s.rows) (hq : r.phase = .queued)
    (hx : x ∈ (step s i).1.rows) (hk : x.key = r.key) (he : x.phase = .expired) :
    ∃ now, i.time = some now ∧ mayExpire s now r = true := by
  obtain ⟨y, hy, k, e⟩ := step_expired s i x hx he
  have hyr : y = r := key_unique keys hy hr (k.trans hk)
  subst hyr
  rcases e with rfl | hp | ⟨_, g⟩
  · rw [hq] at he; cases he
  · rw [hq] at hp; cases hp
  · exact g

theorem keys_map {l : List Row} (f : Row → Row) (hf : ∀ r, (f r).key = r.key) :
    (l.map f).map (·.key) = l.map (·.key) := by
  simp [List.map_map, Function.comp_def, hf]

theorem mark_keys (s : State) (sel : List Row) (o : Owner) :
    (mark s sel o).rows.map (·.key) = s.rows.map (·.key) :=
  keys_map _ (fun r => by by_cases h : r ∈ sel <;> simp [h])

theorem expire_keys (s : State) (now : Nat) :
    (expireQueued s now).rows.map (·.key) = s.rows.map (·.key) :=
  keys_map _ (fun r => by by_cases h : mayExpire s now r = true <;> simp [h])

theorem finish_keys (s : State) (o : Owner) (failed : Bool) :
    (finish s o failed).rows.map (·.key) = s.rows.map (·.key) :=
  keys_map _ (fun r => by split <;> rfl)

theorem promote_keys (s : State) (now ttl : Nat) :
    (promote s now ttl).1.rows.map (·.key) = s.rows.map (·.key) := by
  unfold promote
  split
  · rfl
  · exact mark_keys _ _ _

theorem steer_keys (s : State) (o : Owner) (now ttl sender : Nat) :
    (steer s o now ttl sender).1.rows.map (·.key) = s.rows.map (·.key) := by
  unfold steer
  split
  · rfl
  · exact (mark_keys _ _ _).trans (expire_keys s now)

theorem storeResults_keys (s : State) (results : List Nat) :
    (storeResults s results).rows.map (·.key) = s.rows.map (·.key) :=
  rfl

theorem store_keys (s : State) (o : Owner) (results : List Nat) :
    (store s o results).rows.map (·.key) = s.rows.map (·.key) :=
  storeResults_keys s results

theorem renew_keys (s : State) (now ttl : Nat) : (renew s now ttl).rows = s.rows := by
  unfold renew; split <;> rfl

theorem admit_keys (s : State) (r : Row) (now ttl : Nat) (keys : (s.rows.map (·.key)).Nodup)
    (fresh : ∀ x ∈ s.rows, x.key ≠ r.key) : ((admit s r now ttl).1.rows.map (·.key)).Nodup := by
  have ready : (prepare s now ttl).rows.map (·.key) = s.rows.map (·.key) := by
    unfold prepare
    split
    · exact expire_keys s now
    · exact (promote_keys _ _ _).trans (expire_keys s now)
  have grow : ∀ (n : Row), n.key = r.key → ∀ rows : List Row,
      rows.map (·.key) = s.rows.map (·.key) → ((rows ++ [n]).map (·.key)).Nodup := by
    intro n hn rows hrows
    rw [List.map_append, hrows, List.nodup_append]
    refine ⟨keys, by simp, ?_⟩
    intro a ha b hb
    simp only [List.map_cons, List.map_nil, List.mem_singleton] at hb
    obtain ⟨x, hx, rfl⟩ := List.mem_map.1 ha
    rw [hb, hn]
    exact fresh x hx
  unfold admit
  split
  · exact keys
  · simp only
    split
    · rw [ready]; exact keys
    · split
      · exact grow _ (by rfl) _ ready
      · exact grow _ (by rfl) _ ready

/-- Idempotency keys stay unique in every state: deduplication and resume re-admission keep one row
per key. -/
theorem keys_inductive : Spec.Inductive system (fun s => (s.rows.map (·.key)).Nodup) := by
  refine ⟨List.nodup_nil, fun s i keys => ?_⟩
  change ((step s i).1.rows.map (·.key)).Nodup
  cases i with
  | accept r now ttl =>
    simp only [step]
    split
    · exact keys
    · split
      · split
        · rename_i old _ _
          apply admit_keys
          · exact List.Nodup.sublist ((List.filter_sublist).map _) keys
          · intro x hx
            simpa using (List.mem_filter.1 hx).2
        · exact keys
      · rename_i hnone
        exact admit_keys s r now ttl keys (fun x hx hk => by
          have := List.find?_eq_none.1 hnone x hx
          simp [hk] at this)
  | takeNext o now ttl settles rows =>
    simp only [step]
    split
    · split
      · exact keys
      · cases settles
        · simp only [Bool.false_eq_true, ite_false]
          rw [promote_keys, expire_keys]; exact keys
        · simp only [ite_true]
          rw [promote_keys, expire_keys, finish_keys]; exact keys
    · exact keys
  | applySteering o now ttl sender =>
    simp only [step]
    split
    · rw [steer_keys]; exact keys
    · exact keys
  | stepBoundary o now ttl claim sender results =>
    simp only [step]
    split
    · exact keys
    · split
      · exact keys
      · split
        · rw [store_keys]; exact keys
        · split
          · rw [steer_keys, store_keys]; exact keys
          · rw [renew_keys, store_keys]; exact keys
  | settle o now failed results asyncResult =>
    simp only [step]
    split
    · exact keys
    · split
      · exact keys
      · rw [finish_keys, storeResults_keys]; exact keys
  | renewOwner o now ttl =>
    simp only [step]
    split
    · exact keys
    · split
      · exact keys
      · rw [renew_keys]; exact keys
  | releaseOwner o =>
    simp only [step]
    split <;> exact keys
  | stopOwner now =>
    simp only [step]
    split <;> (try split) <;> exact keys
  | status a => exact keys
  | recoverQueued now ttl =>
    simp only [step]
    split
    · exact keys
    · rw [promote_keys, expire_keys]; exact keys
  | declineRecovery now =>
    simp only [step]
    split <;> exact keys
  | maintain now =>
    simp only [step, maintain]
    refine List.Nodup.sublist ((List.filter_sublist).map _) ?_
    rw [keys_map _ (fun r => by unfold maintainRow; split <;> (try split) <;> rfl)]
    exact keys

/-- A row with retention left survives maintenance under its key. -/
theorem maintain_keeps (s : State) (now : Nat) (r : Row) (hr : r ∈ s.rows)
    (kept : now < r.retainUntil) : ∃ x ∈ (maintain s now).rows, x.key = r.key := by
  refine ⟨maintainRow s now r, ?_, ?_⟩
  · refine List.mem_filter.2 ⟨List.mem_map_of_mem hr, ?_⟩
    have hk : (maintainRow s now r).retainUntil = r.retainUntil := by
      unfold maintainRow; split <;> (try split) <;> rfl
    simp [hk]
    omega
  · unfold maintainRow; split <;> (try split) <;> rfl

theorem duplicate (s : State) (r old : Row) (now ttl : Nat)
    (h : s.rows.find? (fun x => x.key == r.key) = some old) (kept : undelivered s old = false) :
    (step s (.accept r now ttl)).1 = s := by
  simp only [step, h, kept]
  split <;> rfl

theorem fifo_head (s : State) (now ttl : Nat) (r : Row) (rest : List Row)
    (h : queued s = r :: rest) :
    ∃ tail, (promote s now ttl).2 = [.applied (r.event :: tail)] := by
  simp only [promote, h]
  split <;> simp

 theorem other_unchanged (s : World) (i : RoutedInput) (p : Nat)
    (h : p ≠ i.conversation) : (worldStep s i).1 p = s p := by
  simp [worldStep, h]

 theorem projected_run (s : World) (trace : List RoutedInput) (p : Nat) :
    observations p (worldSystem.runFrom s trace).2 =
      (system.runFrom (s p) (ownInputs p trace)).2 := by
  induction trace generalizing s with
  | nil => rfl
  | cons i rest ih =>
    simp only [Spec.System.runFrom]
    change observations p ((worldStep s i).2 ++
      (worldSystem.runFrom (worldStep s i).1 rest).2) = _
    have app (a b : List RoutedEffect) : observations p (a ++ b) = observations p a ++ observations p b := by
      simp [observations, List.filter_append, List.map_append]
    rw [app]
    rw [ih]
    by_cases h : p = i.conversation
    · subst p
      simp [ownInputs, worldStep, observations, Spec.System.runFrom, system, List.filter_map, List.map_map, Function.comp_def]
    · have hn : i.conversation ≠ p := Ne.symm h
      simp [ownInputs, worldStep, observations, h, hn]

 theorem conversation_private : Spec.Private worldSystem Nat Unit Effect (fun _ => True)
    (fun p t => t.filter (fun i => i.conversation == p)) (fun _ => ()) observations := by
  intro p a b _ _ own _
  rw [Spec.System.effects, Spec.System.effects, projected_run, projected_run]
  have equal : ownInputs p a = ownInputs p b := by
    simpa [ownInputs] using congrArg (List.map RoutedInput.input) own
  rw [equal]
end Spec.Runs.Proofs
