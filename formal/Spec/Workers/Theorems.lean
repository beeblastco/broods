import Spec.Workers.Proofs

/-!
The worker queue's guarantees, as statements about every reachable state and every trace. `Spec.Top`
quotes these, and `Controls.lean` shows a broken queue fails them.
-/

namespace Spec.Workers

variable {L : Limits}

/-- The pod never has more slot holders than `MAX_INPROCESS_WORKERS`, for any interleaving. An
overrun run is abandoned, not stopped: its slot is freed while it may still execute (L-row). -/
theorem slots_bounded (hSlots : 0 < L.maxSlots) :
    Spec.Always (system L) (fun s => s.active ≤ L.maxWorkers) :=
  fun s reach => ((inductive_inv hSlots).always s reach).activeLe

/-- The code's counter always equals the number of runs holding a slot, so a double release or a
missed release cannot happen. It counts slot holders, not executing runs (an overrun run is out). -/
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

/-- `started` keeps the slot number its `start` call computed. By definition of `start` (L22); a
lemma `slot_numbers_bounded` uses. -/
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

/-- Any `started` effect `enqueue` emits is one past the slots the run has used. Close to the
definition of `enqueue` (L22); a lemma `slot_numbers_bounded` uses. -/
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

/-- Only a sheddable `enqueue` refuses, and only the run it enqueues. -/
theorem enqueue_refuses {L : Limits} {t : State} {q x : RunId} {used : Nat} {shed : Bool}
    (h : Effect.refused x ∈ (enqueue L t q used shed).2) : x = q ∧ shed = true := by
  unfold enqueue at h
  split at h
  · simp [start] at h
  · split at h
    · rename_i hs
      simp at h
      exact ⟨h, by simp at hs; exact hs.1⟩
    · simp at h

/-- `release` never refuses. -/
theorem release_never_refuses (t : State) (r x : RunId) : Effect.refused x ∉ (release t r).2 := by
  unfold release
  cases t.pending with
  | nil => simp
  | cons next rest =>
    simp only
    cases t.phase next <;> simp [start]

/-- Every `refused` effect, from any input, is the first dispatch of that run, holding no place. A
yield, a placed dispatch, a place, a settle or an overrun never sheds a run. A first dispatch can
still carry durable queued work, such as a recovery dispatch (`Workers` has no leases). -/
theorem shed_only_unplaced_first_dispatch (s : State) (i : Input) (x : RunId)
    (h : Effect.refused x ∈ (step L s i).2) :
    s.phase x = .absent ∧ ∃ place, i = .dispatch x place ∧ ∀ p, place = some p → p ∉ s.places := by
  cases i with
  | openPlace p =>
    simp only [step] at h
    split at h
    · simp at h
    · split at h <;> simp at h
  | closePlace p =>
    simp only [step] at h
    split at h <;> simp at h
  | dispatch r place =>
    simp only [step] at h
    split at h
    · rename_i absent
      cases place with
      | some p =>
        simp only at h
        split at h
        · exact absurd (enqueue_refuses h).2 (by simp)
        · rename_i out
          obtain ⟨rfl, _⟩ := enqueue_refuses h
          exact ⟨absent, some p, rfl, fun q hq => by cases hq; exact out⟩
      | none =>
        obtain ⟨rfl, _⟩ := enqueue_refuses h
        exact ⟨absent, none, rfl, fun _ hq => by cases hq⟩
    · simp at h
  | settle r =>
    simp only [step] at h
    split at h
    · exact absurd h (release_never_refuses _ _ _)
    · simp at h
  | overrun r =>
    simp only [step] at h
    split at h
    · simp only [List.mem_cons, reduceCtorEq, false_or] at h
      exact absurd h (release_never_refuses _ _ _)
    · simp at h
  | yieldSlot r =>
    simp only [step] at h
    split at h
    · split at h
      · simp only [List.mem_append] at h
        rcases h with h | h
        · exact absurd h (release_never_refuses _ _ _)
        · exact absurd (enqueue_refuses h).2 (by simp)
      · simp at h
    · simp at h

/-- Whether an input frees a slot in state `s`: it ends or yields a run that holds one. -/
def Frees (L : Limits) (s : State) : Input → Bool
  | .settle x | .overrun x => match s.phase x with | .running _ => true | _ => false
  | .yieldSlot x => match s.phase x with | .running used => decide (used < L.maxSlots) | _ => false
  | _ => false

/-- How many inputs of a schedule free a slot, each judged in the state it meets. -/
def slotsFreed (L : Limits) : State → List Input → Nat
  | _, [] => 0
  | s, i :: rest => (if Frees L s i then 1 else 0) + slotsFreed L (step L s i).1 rest

/-- A run that was waiting with `u` slots used has taken a slot since: it holds or has held more
than `u`, or it is finished. -/
def started (u : Nat) : Phase → Bool
  | .waiting n | .running n => decide (u < n)
  | .finished | .refused => true
  | .absent => false

/-- Ending a run moves every waiting run one place forward, and starts the one at the head. -/
theorem release_moves_forward {L : Limits} {s : State} {x r : RunId} {n u : Nat} {k : Nat}
    (h : Inv L s) (hx : s.phase x = .running n) (hr : s.phase r = .waiting u)
    (member : r ∈ s.pending) (position : s.pending.idxOf r = k) :
    let after := (release s x).1
    if k = 0 then after.phase r = .running (u + 1)
    else r ∈ after.pending ∧ after.pending.idxOf r = k - 1 ∧ after.phase r = .waiting u := by
  have rNeX : r ≠ x := by
    rintro rfl
    rw [hx] at hr
    cases hr
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
      rw [hr] at hUsed
      cases hUsed
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
      refine ⟨inRest, ?_, ?_⟩
      · simp only [start, State.setPhase, State.withPending, State.free]
        omega
      · simp [start, State.setPhase, State.withPending, State.free, rNeX, Ne.symm hHead, hr]

/-- `enqueue` of another run keeps a waiting run's place and phase. -/
theorem enqueue_keeps_waiting {L : Limits} {t : State} {q r : RunId} {used u k : Nat} {shed : Bool}
    (hq : q ≠ r) (member : r ∈ t.pending) (position : t.pending.idxOf r = k)
    (hr : t.phase r = .waiting u) :
    let after := (enqueue L t q used shed).1
    r ∈ after.pending ∧ after.pending.idxOf r = k ∧ after.phase r = .waiting u := by
  have hrq : r ≠ q := Ne.symm hq
  unfold enqueue
  split
  · simp [start, State.setPhase, hrq, member, position, hr]
  · split
    · simp [State.setPhase, hrq, member, position, hr]
    · simp [State.setPhase, hrq, member, position, hr, List.idxOf_append]

/-- A run that has taken a slot never goes back to waiting with its old count, whatever the input. -/
theorem started_step {L : Limits} (s : State) (i : Input) (r : RunId) (u : Nat)
    (h : started u (s.phase r) = true) : started u ((step L s i).1.phase r) = true := by
  have viaRelease : ∀ (t : State) (x : RunId), started u (t.phase r) = true →
      started u ((release t x).1.phase r) = true := by
    intro t x ht
    unfold release
    cases t.pending with
    | nil =>
      by_cases hx : r = x
      · simp [State.free, hx, started]
      · simpa [State.free, hx] using ht
    | cons next rest =>
      simp only
      cases hn : t.phase next with
      | waiting used =>
        by_cases hx : r = x
        · subst hx
          by_cases hrn : r = next
          · subst hrn
            rw [hn] at ht
            simp [started] at ht
            simp [start, State.setPhase, State.withPending, State.free, started]
            omega
          · simp [start, State.setPhase, State.withPending, State.free, hrn, started]
        · by_cases hrn : r = next
          · subst hrn
            rw [hn] at ht
            simp [started] at ht
            simp [start, State.setPhase, State.withPending, State.free, started]
            omega
          · simp [start, State.setPhase, State.withPending, State.free, hrn, hx, ht]
      | _ =>
        by_cases hx : r = x
        · simp [State.withPending, State.free, hx, started]
        · simpa [State.withPending, State.free, hx] using ht
  have viaEnqueue : ∀ (t : State) (q : RunId) (used : Nat) (shed : Bool),
      (q = r → u < used) → (q ≠ r → started u (t.phase r) = true) →
      started u ((enqueue L t q used shed).1.phase r) = true := by
    intro t q used shed hu ht
    by_cases hq : q = r
    · subst hq
      have := hu rfl
      unfold enqueue
      split
      · simp [start, State.setPhase, started]; omega
      · split
        · simp [State.setPhase, started]
        · simp [State.setPhase, started]; exact this
    · have hrq : r ≠ q := Ne.symm hq
      have ht' := ht hq
      unfold enqueue
      split
      · simp [start, State.setPhase, hrq, ht']
      · split <;> simp [State.setPhase, hrq, ht']
  cases i with
  | openPlace p =>
    simp only [step]
    split
    · exact h
    · split <;> exact h
  | closePlace p =>
    simp only [step]
    split <;> exact h
  | dispatch x place =>
    simp only [step]
    split
    · rename_i absent
      have hxr : x ≠ r := by rintro rfl; rw [absent] at h; simp [started] at h
      cases place with
      | some p =>
        simp only
        split
        · exact viaEnqueue _ _ _ _ (fun e => absurd e hxr) (fun _ => h)
        · exact viaEnqueue _ _ _ _ (fun e => absurd e hxr) (fun _ => h)
      | none => exact viaEnqueue _ _ _ _ (fun e => absurd e hxr) (fun _ => h)
    · exact h
  | settle x =>
    simp only [step]
    split
    · exact viaRelease _ _ h
    · exact h
  | overrun x =>
    simp only [step]
    split
    · exact viaRelease _ _ h
    · exact h
  | yieldSlot x =>
    simp only [step]
    split
    · rename_i used hx
      split
      · refine viaEnqueue _ _ _ _ ?_ (fun _ => viaRelease _ _ h)
        rintro rfl
        rw [hx] at h
        simpa [started] using h
      · exact h
    · exact h

/-- Once a run has taken a slot, no schedule makes it wait again with its old count. -/
theorem started_stays {L : Limits} (r : RunId) (u : Nat) :
    ∀ (schedule : List Input) (s : State), started u (s.phase r) = true →
      started u (((system L).runFrom s schedule).1.phase r) = true := by
  intro schedule
  induction schedule with
  | nil => intro s h; exact h
  | cons i rest ih => intro s h; exact ih (step L s i).1 (started_step s i r u h)

/-- One input, any kind: a slot-freeing input moves a waiting run forward or starts it; any other
input keeps its place, whatever arrives, yields or holds a place behind it. -/
theorem waiting_step {L : Limits} {s : State} {r : RunId} {u k : Nat} (h : Inv L s) (i : Input)
    (member : r ∈ s.pending) (position : s.pending.idxOf r = k) (hr : s.phase r = .waiting u) :
    let after := (step L s i).1
    if Frees L s i then
      (if k = 0 then started u (after.phase r) = true
       else r ∈ after.pending ∧ after.pending.idxOf r = k - 1 ∧ after.phase r = .waiting u)
    else r ∈ after.pending ∧ after.pending.idxOf r = k ∧ after.phase r = .waiting u := by
  have fromRelease : ∀ x n, s.phase x = .running n →
      (if k = 0 then started u ((release s x).1.phase r) = true
       else r ∈ (release s x).1.pending ∧ (release s x).1.pending.idxOf r = k - 1 ∧
        (release s x).1.phase r = .waiting u) := by
    intro x n hx
    have moved := release_moves_forward h hx hr member position
    simp only at moved
    split
    · rename_i k0; simp only [k0, ite_true] at moved; simp [moved, started]
    · rename_i k0; simp only [k0, ite_false] at moved; exact moved
  cases i with
  | openPlace p =>
    simp only [step, Frees, Bool.false_eq_true, ite_false]
    split
    · exact ⟨member, position, hr⟩
    · split <;> exact ⟨member, position, hr⟩
  | closePlace p =>
    simp only [step, Frees, Bool.false_eq_true, ite_false]
    split <;> exact ⟨member, position, hr⟩
  | dispatch x place =>
    simp only [step, Frees, Bool.false_eq_true, ite_false]
    split
    · rename_i absent
      have hxr : x ≠ r := by rintro rfl; rw [absent] at hr; cases hr
      cases place with
      | some p =>
        simp only
        split
        · exact enqueue_keeps_waiting hxr member position hr
        · exact enqueue_keeps_waiting hxr member position hr
      | none => exact enqueue_keeps_waiting hxr member position hr
    · exact ⟨member, position, hr⟩
  | settle x =>
    cases hx : s.phase x with
    | running n => simpa [step, Frees, hx] using fromRelease x n hx
    | _ => simp [step, Frees, hx, member, position, hr]
  | overrun x =>
    cases hx : s.phase x with
    | running n => simpa [step, Frees, hx] using fromRelease x n hx
    | _ => simp [step, Frees, hx, member, position, hr]
  | yieldSlot x =>
    cases hx : s.phase x with
    | running used =>
      have hxr : x ≠ r := by rintro rfl; rw [hx] at hr; cases hr
      have hrx : r ≠ x := Ne.symm hxr
      by_cases usedLt : used < L.maxSlots
      · simp only [step, Frees, hx, usedLt, decide_true, ite_true]
        have moved := fromRelease x used hx
        split
        · rename_i k0
          simp only [k0, ite_true] at moved
          unfold enqueue
          split
          · simpa [start, State.setPhase, hrx] using moved
          · split <;> simpa [State.setPhase, hrx] using moved
        · rename_i k0
          simp only [k0, ite_false] at moved
          exact enqueue_keeps_waiting hxr moved.1 moved.2.1 moved.2.2
      · simp [step, Frees, hx, usedLt, member, position, hr]
    | _ => simp [step, Frees, hx, member, position, hr]

/-- A run at position `k` of the queue, waiting with `u` slots used, has taken a slot once `k + 1`
inputs have freed one, in any schedule: arrivals join behind it, a yielding run re-enters at the
back, and places, refused dispatches and no-op inputs do not move it. The schedule must contain
those `k + 1` endings or yields; in the code the slot timer (budget plus 5 s grace) forces them,
and the model takes them as given. -/
theorem no_starvation (hSlots : 0 < L.maxSlots) (r : RunId) (u : Nat) :
    ∀ (k : Nat) (schedule : List Input) (s : State), Inv L s → r ∈ s.pending →
      s.pending.idxOf r = k → s.phase r = .waiting u → k + 1 ≤ slotsFreed L s schedule →
      started u (((system L).runFrom s schedule).1.phase r) = true := by
  intro k schedule
  induction schedule generalizing k with
  | nil => intro s _ _ _ _ enough; simp [slotsFreed] at enough
  | cons i rest ih =>
    intro s h member position hr enough
    have moved := waiting_step (L := L) h i member position hr
    simp only at moved
    have next := inv_step hSlots s i h
    simp only [slotsFreed] at enough
    change started u (((system L).runFrom (step L s i).1 rest).1.phase r) = true
    split at moved
    · rename_i frees
      simp only [frees, ite_true] at enough
      split at moved
      · exact started_stays r u rest _ moved
      · rename_i k0
        exact ih (k - 1) _ next moved.1 moved.2.1 moved.2.2 (by omega)
    · rename_i frees
      simp only [frees, Bool.false_eq_true, ite_false] at enough
      exact ih k _ next moved.1 moved.2.1 moved.2.2 (by omega)

/-- `no_starvation` in the general shape of `Spec.Progress`. -/
theorem progress (hSlots : 0 < L.maxSlots) (r : RunId) (u k : Nat) :
    Spec.Progress (system L) (fun _ => True)
      (fun s schedule => k + 1 ≤ slotsFreed L s schedule)
      (fun s => r ∈ s.pending ∧ s.pending.idxOf r = k ∧ s.phase r = .waiting u)
      (fun s => started u (s.phase r) = true) := by
  intro trace _ pending schedule fair
  have h := (inductive_inv hSlots).always _ ⟨trace, rfl⟩
  exact no_starvation hSlots r u k schedule _ h pending.1 pending.2.1 pending.2.2 fair

/-- Limits where a run can yield once. -/
def yieldOnce : Limits := { maxWorkers := 1, maxPending := 2, maxSlots := 2 }

/-- "Out of the queue" is not the property: with yields allowed, run 1 starts after one ending and
then waits again after its own yield. `no_starvation` therefore says the run has taken a slot. -/
theorem started_run_can_wait_again :
    ((system yieldOnce).runFrom ((system yieldOnce).final [.dispatch 0 none, .dispatch 1 none,
      .dispatch 2 none]) [.settle 0, .yieldSlot 1]).1.phase 1 = .waiting 1 := by decide

/-- The queue does start runs: soundness and bounds above are not true only because nothing runs. -/
theorem non_vacuous (hWorkers : 0 < L.maxWorkers) :
    Spec.NonVacuous (system L) (fun _ => True) (fun e => ∃ r slot, e = .started r slot) := by
  refine ⟨[.dispatch 0 none], trivial, .started 0 1, ?_, 0, 1, rfl⟩
  simp [System.effects, System.runFrom, system, step, State.empty, enqueue, start, hWorkers]
  exact List.mem_append_left _ (List.mem_singleton.2 rfl)

end Spec.Workers
