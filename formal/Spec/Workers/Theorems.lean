import Spec.Workers.Proofs

/-!
The worker queue's guarantees, as statements about every reachable state and every trace. `Spec.Top`
quotes these, and `Controls.lean` shows a broken queue fails them.
-/

namespace Spec.Workers

variable {L : Limits}

/-- The pod never runs more slots than `MAX_INPROCESS_WORKERS`, for any interleaving. -/
theorem slots_bounded (hSlots : 0 < L.maxSlots) :
    Spec.Always (system L) (fun s => s.active ≤ L.maxWorkers) :=
  fun s reach => ((inductive_inv hSlots).always s reach).activeLe

/-- The code's counter always equals the number of runs holding a slot, so a double release or a
missed release cannot happen. -/
theorem counter_exact (hSlots : 0 < L.maxSlots) :
    Spec.Always (system L) (fun s => s.active = s.running.length ∧ s.running.Nodup) :=
  fun s reach =>
    let h := (inductive_inv hSlots).always s reach
    ⟨h.activeEq, h.runningNodup⟩

/-- No slot sits idle while a run waits. -/
theorem work_conserving (hSlots : 0 < L.maxSlots) :
    Spec.Always (system L) (fun s => s.pending ≠ [] → s.active = L.maxWorkers) :=
  fun s reach => ((inductive_inv hSlots).always s reach).conserving

/-- Active runs, waiting runs and held places together stay below the queue's capacity plus one
pod of slots. The slack exists because a free slot starts a run without a fullness check. -/
theorem capacity_bounded (hSlots : 0 < L.maxSlots) :
    Spec.Always (system L)
      (fun s => s.active + s.pending.length + s.held ≤ cap L + L.maxWorkers) :=
  fun s reach => ((inductive_inv hSlots).always s reach).totalLe

/-- `started` keeps the slot number its `start` call computed. -/
theorem start_effects {s : State} {r : RunId} {used : Nat} {e : Effect}
    (he : e ∈ (start s r used).2) : e = .started r (used + 1) := by
  simpa [start] using he

/-- Any effect `release` emits starts a waiting run, one past the slots it has used. -/
theorem release_effects {L : Limits} {s : State} {r x : RunId} {slot : Nat}
    (h : Inv L s) (he : Effect.started x slot ∈ (release s r).2) : 1 ≤ slot ∧ slot ≤ L.maxSlots := by
  unfold release at he
  cases hp : s.pending with
  | nil => simp [hp] at he
  | cons next rest =>
    simp only [hp] at he
    cases hu : s.phase next with
    | waiting used =>
      simp only [hu] at he
      have heq := start_effects he
      injection heq with _ hslot
      have := h.waitingSlots next used hu
      omega
    | absent => simp [hu] at he
    | running _ => simp [hu] at he
    | finished => simp [hu] at he
    | refused => simp [hu] at he

/-- Any `started` effect `enqueue` emits is one past the slots the run has used. -/
theorem enqueue_effects {L : Limits} {s : State} {r x : RunId} {used slot : Nat} {shed : Bool}
    (usedLt : used < L.maxSlots)
    (he : Effect.started x slot ∈ (enqueue L s r used shed).2) : 1 ≤ slot ∧ slot ≤ L.maxSlots := by
  unfold enqueue at he
  split at he
  · have heq := start_effects he
    injection heq with _ hslot
    omega
  · split at he <;> simp at he

/-- Every slot a run takes is numbered at most `MAX_RUN_SLOTS`, however often it yields. -/
theorem slot_numbers_bounded (hSlots : 0 < L.maxSlots) :
    ∀ trace, ∀ e ∈ (system L).effects trace,
      ∀ x slot, e = .started x slot → 1 ≤ slot ∧ slot ≤ L.maxSlots := by
  refine (inductive_inv hSlots).effects ?_
  intro s i h e he x slot heq
  subst heq
  change Effect.started x slot ∈ (step L s i).2 at he
  cases i with
  | openPlace p =>
    simp only [step] at he
    split at he
    · simp at he
    · split at he <;> simp at he
  | closePlace p =>
    simp only [step] at he
    split at he <;> simp at he
  | dispatch r place =>
    simp only [step] at he
    split at he
    · split at he
      · split at he
        · exact enqueue_effects hSlots he
        · exact enqueue_effects hSlots he
      · exact enqueue_effects hSlots he
    · simp at he
  | settle r =>
    simp only [step] at he
    split at he
    · exact release_effects h he
    · simp at he
  | overrun r =>
    simp only [step] at he
    split at he
    · simp only [List.mem_cons, reduceCtorEq, false_or] at he
      exact release_effects h he
    · simp at he
  | yieldSlot r =>
    simp only [step] at he
    split at he
    · rename_i used hr
      split at he
      · rename_i usedLt
        simp only [List.mem_append] at he
        rcases he with he | he
        · exact release_effects h he
        · exact enqueue_effects usedLt he
      · simp at he
    · simp at he

/-- A `refused` effect names only a fresh run that held no place. A run that yielded its slot is
never shed, and neither is the first dispatch that holds a place. -/
theorem shed_only_fresh_unplaced (s : State) (r x : RunId) (p : PlaceId) :
    (p ∈ s.places → Effect.refused x ∉ (step L s (.dispatch r (some p))).2) ∧
      Effect.refused x ∉ (step L s (.yieldSlot r)).2 := by
  have enqueueNoShed : ∀ (t : State) (q : RunId) (used : Nat),
      Effect.refused x ∉ (enqueue L t q used false).2 := by
    intro t q used
    simp [enqueue]
    split <;> simp [start]
  have releaseNoRefuse : ∀ t : State, Effect.refused x ∉ (release t r).2 := by
    intro t
    unfold release
    cases t.pending with
    | nil => simp
    | cons next rest =>
      simp only
      cases t.phase next <;> simp [start]
  constructor
  · intro hp
    simp only [step]
    split
    · simp only [hp, ite_true]
      exact enqueueNoShed _ _ _
    · simp
  · simp only [step]
    split
    · split
      · simp only [List.mem_append, not_or]
        exact ⟨releaseNoRefuse _, enqueueNoShed _ _ _⟩
      · simp
    · simp

/-- A schedule in which each input ends a run that holds a slot at that moment. -/
def Releasing (L : Limits) : State → List Input → Prop
  | _, [] => True
  | s, i :: rest =>
    (∃ x n, s.phase x = .running n ∧ (i = .settle x ∨ i = .overrun x)) ∧
      Releasing L (step L s i).1 rest

/-- Ending a run moves every waiting run one place forward, and starts the one at the head. -/
theorem release_moves_forward {L : Limits} {s : State} {x r : RunId} {n : Nat} {k : Nat}
    (h : Inv L s) (hx : s.phase x = .running n)
    (member : r ∈ s.pending) (position : s.pending.idxOf r = k) :
    let after := (release s x).1
    if k = 0 then (∀ m, after.phase r ≠ .waiting m) ∧ after.phase r ≠ .absent
    else r ∈ after.pending ∧ after.pending.idxOf r = k - 1 := by
  have rNeX : r ≠ x := by
    rintro rfl
    obtain ⟨m, hm⟩ := (h.pendingIff r).1 member
    rw [hx] at hm
    cases hm
  unfold release
  cases hp : s.pending with
  | nil => simp [hp] at member
  | cons next rest =>
    have nextIn : next ∈ s.pending := by simp [hp]
    obtain ⟨used, hUsed⟩ := (h.pendingIff next).1 nextIn
    simp only [hUsed]
    rw [hp] at member position
    by_cases hHead : next = r
    · subst hHead
      simp only [List.idxOf_cons_self] at position
      subst position
      simp [start, State.setPhase, State.withPending, State.free]
    · have nodup : (next :: rest).Nodup := by rw [← hp]; exact h.pendingNodup
      have inRest : r ∈ rest := by
        simp only [List.mem_cons] at member
        rcases member with heq | hm
        · exact absurd heq.symm hHead
        · exact hm
      have positionRest : rest.idxOf r + 1 = k := by
        simpa [List.idxOf_cons, hHead] using position
      have kPos : k ≠ 0 := by omega
      simp only [kPos, ite_false]
      refine ⟨inRest, ?_⟩
      simp only [start, State.setPhase, State.withPending, State.free]
      omega

/-- A run that has left the queue stays out of it while runs only end. -/
theorem release_stays_out {L : Limits} {s : State} {x r : RunId} {n : Nat}
    (h : Inv L s) (hx : s.phase x = .running n)
    (notWaiting : ∀ m, s.phase r ≠ .waiting m) (present : s.phase r ≠ .absent) :
    let after := (release s x).1
    (∀ m, after.phase r ≠ .waiting m) ∧ after.phase r ≠ .absent := by
  have notPending : r ∉ s.pending := by
    intro hm
    obtain ⟨m, hm'⟩ := (h.pendingIff r).1 hm
    exact notWaiting m hm'
  unfold release
  cases hp : s.pending with
  | nil =>
    simp only [State.free]
    by_cases hr : r = x
    · subst hr; simp
    · simp [hr, notWaiting, present]
  | cons next rest =>
    have nextIn : next ∈ s.pending := by simp [hp]
    obtain ⟨used, hUsed⟩ := (h.pendingIff next).1 nextIn
    have rNeNext : r ≠ next := by
      rintro rfl
      exact notPending nextIn
    simp only [hUsed, start, State.setPhase, State.withPending, State.free, rNeNext, ite_false]
    by_cases hr : r = x
    · subst hr; simp
    · simp [hr, notWaiting, present]

/-- Both ways of ending a run change the state the same way. -/
theorem end_run_state {L : Limits} {s : State} {x : RunId} {n : Nat} {i : Input}
    (hx : s.phase x = .running n) (hi : i = .settle x ∨ i = .overrun x) :
    (step L s i).1 = (release s x).1 := by
  rcases hi with rfl | rfl <;> simp [step, hx]

/-- Once a run is out of the queue, a releasing schedule keeps it out. -/
theorem releasing_stays_out {L : Limits} (hSlots : 0 < L.maxSlots) (r : RunId) :
    ∀ (schedule : List Input) (s : State), Inv L s → Releasing L s schedule →
      (∀ m, s.phase r ≠ .waiting m) → s.phase r ≠ .absent →
      (∀ m, ((system L).runFrom s schedule).1.phase r ≠ .waiting m) ∧
        ((system L).runFrom s schedule).1.phase r ≠ .absent := by
  intro schedule
  induction schedule with
  | nil => intro s _ _ out present; exact ⟨out, present⟩
  | cons i rest ih =>
    intro s h fair out present
    obtain ⟨⟨x, n, hx, hi⟩, fairRest⟩ := fair
    have heq := end_run_state (L := L) hx hi
    have stays := release_stays_out h hx out present
    simp only at stays
    refine ih (step L s i).1 (inv_step hSlots s i h) fairRest ?_ ?_
    · rw [heq]; exact stays.1
    · rw [heq]; exact stays.2

/-- A run at position `k` is out of the queue after `k + 1` runs end. Waiting is strictly first in,
first out, and no later arrival can overtake it. -/
theorem no_starvation (hSlots : 0 < L.maxSlots) (r : RunId) :
    ∀ (k : Nat) (schedule : List Input) (s : State), Inv L s → r ∈ s.pending →
      s.pending.idxOf r = k → Releasing L s schedule → k + 1 ≤ schedule.length →
      ∀ m, ((system L).runFrom s schedule).1.phase r ≠ .waiting m := by
  intro k
  induction k with
  | zero =>
    intro schedule s h member position fair enough m
    cases schedule with
    | nil => simp at enough
    | cons i rest =>
      obtain ⟨⟨x, n, hx, hi⟩, fairRest⟩ := fair
      have moved := release_moves_forward h hx member position
      simp only [ite_true] at moved
      have heq := end_run_state (L := L) hx hi
      have out := releasing_stays_out hSlots r rest (step L s i).1 (inv_step hSlots s i h) fairRest
        (by rw [heq]; exact moved.1) (by rw [heq]; exact moved.2)
      exact out.1 m
  | succ k ih =>
    intro schedule s h member position fair enough m
    cases schedule with
    | nil => simp at enough
    | cons i rest =>
      obtain ⟨⟨x, n, hx, hi⟩, fairRest⟩ := fair
      have moved := release_moves_forward h hx member position
      simp only [Nat.succ_ne_zero, ite_false] at moved
      have heq := end_run_state (L := L) hx hi
      simp only [List.length_cons] at enough
      exact ih rest (step L s i).1 (inv_step hSlots s i h) (by rw [heq]; exact moved.1)
        (by rw [heq]; exact moved.2) fairRest (by omega) m

/-- `no_starvation` in the general shape of `Spec.Progress`. -/
theorem progress (hSlots : 0 < L.maxSlots) (r : RunId) (k : Nat) :
    Spec.Progress (system L) (fun _ => True)
      (fun s schedule => Releasing L s schedule ∧ k + 1 ≤ schedule.length)
      (fun s => r ∈ s.pending ∧ s.pending.idxOf r = k)
      (fun s => ∀ m, s.phase r ≠ .waiting m) := by
  intro trace _ pending schedule fair m
  have h := (inductive_inv hSlots).always _ ⟨trace, rfl⟩
  exact no_starvation hSlots r k schedule _ h pending.1 pending.2 fair.1 fair.2 m

/-- The queue does start runs: soundness and bounds above are not true only because nothing runs. -/
theorem non_vacuous (hWorkers : 0 < L.maxWorkers) :
    Spec.NonVacuous (system L) (fun _ => True) (fun e => ∃ r slot, e = .started r slot) := by
  refine ⟨[.dispatch 0 none], trivial, .started 0 1, ?_, 0, 1, rfl⟩
  simp [System.effects, System.runFrom, system, step, State.empty, enqueue, start, hWorkers]
  exact List.mem_append_left _ (List.mem_singleton.2 rfl)

end Spec.Workers
