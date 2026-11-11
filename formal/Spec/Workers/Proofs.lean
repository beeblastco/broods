import Spec.Kit
import Spec.Workers.Model

/-!
What the worker queue guarantees, proved one input kind at a time from one inductive invariant.
-/

namespace Spec.Workers

/-- The invariant of the queue. Each field is a claim about every reachable state. -/
structure Inv (L : Limits) (s : State) : Prop where
  activeEq : s.active = s.running.length
  activeLe : s.active ≤ L.maxWorkers
  conserving : s.pending ≠ [] → s.active = L.maxWorkers
  pendingIff : ∀ r, r ∈ s.pending ↔ ∃ n, s.phase r = .waiting n
  runningIff : ∀ r, r ∈ s.running ↔ ∃ n, s.phase r = .running n
  pendingNodup : s.pending.Nodup
  runningNodup : s.running.Nodup
  heldEq : s.held = s.places.length
  placesNodup : s.places.Nodup
  heldLe : s.held ≤ cap L
  totalLe : s.active + s.pending.length + s.held ≤ cap L + L.maxWorkers
  runningSlots : ∀ r n, s.phase r = .running n → 1 ≤ n ∧ n ≤ L.maxSlots
  waitingSlots : ∀ r n, s.phase r = .waiting n → n < L.maxSlots

theorem inv_empty (L : Limits) : Inv L State.empty := by
  constructor <;> simp [State.empty]

theorem setPhase_phase (s : State) (r x : RunId) (p : Phase) :
    (s.setPhase r p).phase x = if x = r then p else s.phase x := rfl

/-- `start` keeps the invariant for a run that holds no slot and is not queued. -/
theorem inv_start {L : Limits} {s : State} {r : RunId} {used : Nat}
    (activeEq : s.active = s.running.length)
    (roomy : s.active < L.maxWorkers)
    (conserving : (s.pending ≠ [] → s.active + 1 = L.maxWorkers))
    (pendingIff : ∀ x, x ∈ s.pending ↔ x ≠ r ∧ ∃ n, s.phase x = .waiting n)
    (runningIff : ∀ x, x ∈ s.running ↔ x ≠ r ∧ ∃ n, s.phase x = .running n)
    (pendingNodup : s.pending.Nodup)
    (runningNodup : s.running.Nodup)
    (heldEq : s.held = s.places.length)
    (placesNodup : s.places.Nodup)
    (heldLe : s.held ≤ cap L)
    (totalLe : s.active + 1 + s.pending.length + s.held ≤ cap L + L.maxWorkers)
    (runningSlots : ∀ x n, x ≠ r → s.phase x = .running n → 1 ≤ n ∧ n ≤ L.maxSlots)
    (waitingSlots : ∀ x n, x ≠ r → s.phase x = .waiting n → n < L.maxSlots)
    (usedLt : used < L.maxSlots) :
    Inv L (start s r used).1 := by
  have rNotRunning : r ∉ s.running := fun h => ((runningIff r).1 h).1 rfl
  constructor
  · simp [start, State.setPhase, activeEq]
  · simp [start, State.setPhase]; omega
  · intro h; simp [start, State.setPhase] at h ⊢; exact conserving h
  · intro x
    simp only [start, State.setPhase]
    by_cases hx : x = r
    · subst hx
      constructor
      · intro h; exact absurd rfl ((pendingIff x).1 h).1
      · rintro ⟨n, hn⟩; simp at hn
    · simp [hx, pendingIff x]
  · intro x
    simp only [start, State.setPhase]
    by_cases hx : x = r
    · subst hx; simp
    · simp [hx, runningIff x]
  · simpa [start, State.setPhase] using pendingNodup
  · simpa [start, State.setPhase, List.nodup_cons] using ⟨rNotRunning, runningNodup⟩
  · simpa [start, State.setPhase] using heldEq
  · simpa [start, State.setPhase] using placesNodup
  · simpa [start, State.setPhase] using heldLe
  · simp only [start, State.setPhase]; omega
  · intro x n h
    simp only [start, State.setPhase] at h
    by_cases hx : x = r
    · subst hx; simp at h; omega
    · simp [hx] at h; exact runningSlots x n hx h
  · intro x n h
    simp only [start, State.setPhase] at h
    by_cases hx : x = r
    · subst hx; simp at h
    · simp [hx] at h; exact waitingSlots x n hx h

/-- `enqueue` keeps the invariant. `room` says an unshed run does not break the total bound. -/
theorem inv_enqueue {L : Limits} {s : State} {r : RunId} {used : Nat} {shed : Bool}
    (activeEq : s.active = s.running.length)
    (activeLe : s.active ≤ L.maxWorkers)
    (conserving : s.pending ≠ [] → s.active = L.maxWorkers)
    (pendingIff : ∀ x, x ∈ s.pending ↔ x ≠ r ∧ ∃ n, s.phase x = .waiting n)
    (runningIff : ∀ x, x ∈ s.running ↔ x ≠ r ∧ ∃ n, s.phase x = .running n)
    (pendingNodup : s.pending.Nodup)
    (runningNodup : s.running.Nodup)
    (heldEq : s.held = s.places.length)
    (placesNodup : s.places.Nodup)
    (heldLe : s.held ≤ cap L)
    (totalLe : s.active + s.pending.length + s.held ≤ cap L + L.maxWorkers)
    (room : shed = false → s.active + s.pending.length + s.held + 1 ≤ cap L + L.maxWorkers)
    (runningSlots : ∀ x n, x ≠ r → s.phase x = .running n → 1 ≤ n ∧ n ≤ L.maxSlots)
    (waitingSlots : ∀ x n, x ≠ r → s.phase x = .waiting n → n < L.maxSlots)
    (usedLt : used < L.maxSlots) :
    Inv L (enqueue L s r used shed).1 := by
  have rNotPending : r ∉ s.pending := fun h => ((pendingIff r).1 h).1 rfl
  unfold enqueue
  split
  · rename_i free
    have noPending : s.pending = [] := by
      cases hp : s.pending with
      | nil => rfl
      | cons h t =>
        have := conserving (by simp [hp])
        omega
    refine inv_start activeEq free ?_ pendingIff runningIff pendingNodup runningNodup heldEq
      placesNodup heldLe ?_ runningSlots waitingSlots usedLt
    · intro h; exact absurd noPending h
    · simp [noPending]; unfold cap at *; omega
  · rename_i busy
    have atMax : s.active = L.maxWorkers := by omega
    split
    · rename_i refuse
      constructor
      · simpa [State.setPhase] using activeEq
      · simpa [State.setPhase] using activeLe
      · simpa [State.setPhase] using conserving
      · intro x
        simp only [State.setPhase]
        by_cases hx : x = r
        · subst hx; simp [rNotPending]
        · simp [hx, pendingIff x]
      · intro x
        simp only [State.setPhase]
        by_cases hx : x = r
        · subst hx
          simp
          intro h
          exact ((runningIff x).1 h).1 rfl
        · simp [hx, runningIff x]
      · simpa [State.setPhase] using pendingNodup
      · simpa [State.setPhase] using runningNodup
      · simpa [State.setPhase] using heldEq
      · simpa [State.setPhase] using placesNodup
      · simpa [State.setPhase] using heldLe
      · simpa [State.setPhase] using totalLe
      · intro x n h
        simp only [State.setPhase] at h
        by_cases hx : x = r
        · subst hx; simp at h
        · simp [hx] at h; exact runningSlots x n hx h
      · intro x n h
        simp only [State.setPhase] at h
        by_cases hx : x = r
        · subst hx; simp at h
        · simp [hx] at h; exact waitingSlots x n hx h
    · rename_i keep
      have bound : s.active + s.pending.length + s.held + 1 ≤ cap L + L.maxWorkers := by
        cases shed with
        | false => exact room rfl
        | true =>
          simp [full] at keep
          omega
      constructor
      · simpa [State.setPhase] using activeEq
      · simpa [State.setPhase] using activeLe
      · intro _; simpa [State.setPhase] using atMax
      · intro x
        simp only [State.setPhase]
        by_cases hx : x = r
        · subst hx; simp
        · simp [hx, pendingIff x]
      · intro x
        simp only [State.setPhase]
        by_cases hx : x = r
        · subst hx
          simp
          intro h
          exact ((runningIff x).1 h).1 rfl
        · simp [hx, runningIff x]
      · simp only [List.nodup_append]
        refine ⟨pendingNodup, by simp, ?_⟩
        intro a ha b hb
        simp at hb
        subst hb
        intro heq
        subst heq
        exact rNotPending ha
      · simpa [State.setPhase] using runningNodup
      · simpa [State.setPhase] using heldEq
      · simpa [State.setPhase] using placesNodup
      · simpa [State.setPhase] using heldLe
      · simp only [State.setPhase, List.length_append, List.length_singleton]; omega
      · intro x n h
        simp only [State.setPhase] at h
        by_cases hx : x = r
        · subst hx; simp at h
        · simp [hx] at h; exact runningSlots x n hx h
      · intro x n h
        simp only [State.setPhase] at h
        by_cases hx : x = r
        · subst hx; simp at h; omega
        · simp [hx] at h; exact waitingSlots x n hx h

/-- `enqueue` from a state with the invariant, for a run that holds no slot and is not queued. -/
theorem inv_enqueue_of_inv {L : Limits} {s : State} {r : RunId} {used : Nat} {shed : Bool}
    (h : Inv L s) (notRunning : ∀ n, s.phase r ≠ .running n)
    (notWaiting : ∀ n, s.phase r ≠ .waiting n)
    (room : shed = false → s.active + s.pending.length + s.held + 1 ≤ cap L + L.maxWorkers)
    (usedLt : used < L.maxSlots) :
    Inv L (enqueue L s r used shed).1 := by
  refine inv_enqueue h.activeEq h.activeLe h.conserving ?_ ?_ h.pendingNodup h.runningNodup
    h.heldEq h.placesNodup h.heldLe h.totalLe room ?_ ?_ usedLt
  · intro x
    rw [h.pendingIff x]
    constructor
    · rintro ⟨n, hn⟩
      refine ⟨?_, n, hn⟩
      rintro rfl
      exact notWaiting n hn
    · rintro ⟨_, hn⟩
      exact hn
  · intro x
    rw [h.runningIff x]
    constructor
    · rintro ⟨n, hn⟩
      refine ⟨?_, n, hn⟩
      rintro rfl
      exact notRunning n hn
    · rintro ⟨_, hn⟩
      exact hn
  · intro x n _ hn
    exact h.runningSlots x n hn
  · intro x n _ hn
    exact h.waitingSlots x n hn

/-- `release` keeps the invariant, finishes the released run, and frees one unit of the total. -/
theorem inv_release {L : Limits} {s : State} {r : RunId} {n : Nat}
    (h : Inv L s) (hr : s.phase r = .running n) :
    Inv L (release s r).1 ∧ (release s r).1.phase r = .finished ∧
      (release s r).1.active + (release s r).1.pending.length + (release s r).1.held + 1 =
        s.active + s.pending.length + s.held := by
  have rRunning : r ∈ s.running := (h.runningIff r).2 ⟨n, hr⟩
  have runningPos : 0 < s.running.length := List.length_pos_of_mem rRunning
  have activeEq := h.activeEq
  have eraseLen : (s.running.erase r).length = s.active - 1 := by
    rw [List.length_erase_of_mem rRunning]; omega
  have eraseMem : ∀ x, x ∈ s.running.erase r ↔ x ≠ r ∧ x ∈ s.running := by
    intro x
    constructor
    · intro hx
      have hne : x ≠ r := by
        rintro rfl
        exact (List.Nodup.not_mem_erase h.runningNodup) hx
      exact ⟨hne, List.mem_of_mem_erase hx⟩
    · rintro ⟨hne, hx⟩
      exact (List.mem_erase_of_ne hne).2 hx
  have eraseNodup : (s.running.erase r).Nodup := h.runningNodup.erase r
  have rNotPending : r ∉ s.pending := by
    intro hm
    obtain ⟨k, hk⟩ := (h.pendingIff r).1 hm
    rw [hr] at hk
    cases hk
  have runIff : ∀ x, x ∈ s.running.erase r ↔
      ∃ m, (if x = r then Phase.finished else s.phase x) = .running m := by
    intro x
    rw [eraseMem x, h.runningIff x]
    by_cases hx : x = r
    · subst hx; simp
    · simp [hx]
  unfold release
  cases hp : s.pending with
  | nil =>
    simp only
    refine ⟨?_, by simp [State.free], ?_⟩
    · have heldEq := h.heldEq
      have totalLe := h.totalLe
      have activeLe := h.activeLe
      rw [hp] at totalLe
      refine
        { activeEq := ?_, activeLe := ?_, conserving := ?_, pendingIff := ?_, runningIff := ?_,
          pendingNodup := ?_, runningNodup := ?_, heldEq := heldEq, placesNodup := h.placesNodup,
          heldLe := h.heldLe, totalLe := ?_, runningSlots := ?_, waitingSlots := ?_ }
      · simpa [State.free] using eraseLen.symm
      · simp only [State.free]; omega
      · simp [State.free, hp]
      · intro x
        have := h.pendingIff x
        rw [hp] at this
        simp only [State.free, hp]
        by_cases hx : x = r
        · subst hx; simp
        · simpa [hx] using this
      · exact runIff
      · simp [State.free, hp]
      · exact eraseNodup
      · simp only [State.free, hp, List.length_nil]; simp only [List.length_nil] at totalLe; omega
      · intro x k hk
        simp only [State.free] at hk
        by_cases hx : x = r
        · subst hx; simp at hk
        · simp [hx] at hk; exact h.runningSlots x k hk
      · intro x k hk
        simp only [State.free] at hk
        by_cases hx : x = r
        · subst hx; simp at hk
        · simp [hx] at hk; exact h.waitingSlots x k hk
    · simp only [State.free, hp, List.length_nil]; omega
  | cons next rest =>
    have nextIn : next ∈ s.pending := by simp [hp]
    obtain ⟨used, hUsed⟩ := (h.pendingIff next).1 nextIn
    have nextNeR : next ≠ r := by
      rintro rfl
      exact rNotPending nextIn
    have atMax : s.active = L.maxWorkers := h.conserving (by simp [hp])
    have nodupP : (next :: rest).Nodup := by rw [← hp]; exact h.pendingNodup
    have nextNotRest : next ∉ rest := (List.nodup_cons.1 nodupP).1
    have restNodup : rest.Nodup := (List.nodup_cons.1 nodupP).2
    simp only [hUsed]
    have pendingFacts : ∀ x, x ∈ rest ↔
        x ≠ next ∧ ∃ m, (if x = r then Phase.finished else s.phase x) = .waiting m := by
      intro x
      have base := h.pendingIff x
      rw [hp] at base
      simp only [List.mem_cons] at base
      by_cases hx : x = next
      · subst hx; simp [nextNotRest]
      · by_cases hxr : x = r
        · subst hxr
          have : x ∉ rest := fun hm => rNotPending (by simp [hp, hm])
          simp [this]
        · simp only [hxr, ite_false]
          constructor
          · intro hm; exact ⟨hx, base.1 (Or.inr hm)⟩
          · rintro ⟨_, hm⟩
            rcases base.2 hm with heq | hm'
            · exact absurd heq hx
            · exact hm'
    have runningFacts : ∀ x, x ∈ s.running.erase r ↔
        x ≠ next ∧ ∃ m, (if x = r then Phase.finished else s.phase x) = .running m := by
      intro x
      rw [runIff x]
      by_cases hx : x = next
      · subst hx
        simp [nextNeR, hUsed]
      · simp [hx]
    have totalLe := h.totalLe
    rw [hp] at totalLe
    simp only [List.length_cons] at totalLe
    refine ⟨?_, ?_, ?_⟩
    · refine inv_start (s := (s.free r).withPending rest) eraseLen.symm ?_ ?_ pendingFacts
        runningFacts restNodup eraseNodup h.heldEq h.placesNodup h.heldLe ?_ ?_ ?_
        (h.waitingSlots next used hUsed)
      · show s.active - 1 < L.maxWorkers
        omega
      · intro _
        show s.active - 1 + 1 = L.maxWorkers
        omega
      · show s.active - 1 + 1 + rest.length + s.held ≤ cap L + L.maxWorkers
        omega
      · intro x k _ hk
        change (if x = r then Phase.finished else s.phase x) = .running k at hk
        by_cases hxr : x = r
        · subst hxr; simp at hk
        · simp [hxr] at hk; exact h.runningSlots x k hk
      · intro x k _ hk
        change (if x = r then Phase.finished else s.phase x) = .waiting k at hk
        by_cases hxr : x = r
        · subst hxr; simp at hk
        · simp [hxr] at hk; exact h.waitingSlots x k hk
    · simp [start, State.setPhase, State.withPending, State.free, nextNeR.symm]
    · simp only [start, State.setPhase, State.withPending, State.free, List.length_cons]
      omega

/-- Closing a held place keeps the invariant and frees one unit of the total. -/
theorem inv_closePlace {L : Limits} {s : State} {p : PlaceId} (h : Inv L s) (hp : p ∈ s.places) :
    let next : State := { s with held := s.held - 1, places := s.places.erase p }
    Inv L next ∧ next.active + next.pending.length + next.held + 1 =
      s.active + s.pending.length + s.held := by
  intro next
  have pos : 0 < s.places.length := List.length_pos_of_mem hp
  have heldEq := h.heldEq
  refine ⟨?_, ?_⟩
  · constructor
    · exact h.activeEq
    · exact h.activeLe
    · exact h.conserving
    · exact h.pendingIff
    · exact h.runningIff
    · exact h.pendingNodup
    · exact h.runningNodup
    · simp only [next, List.length_erase_of_mem hp]; omega
    · exact h.placesNodup.erase p
    · have := h.heldLe; simp only [next]; omega
    · have := h.totalLe; simp only [next]; omega
    · exact h.runningSlots
    · exact h.waitingSlots
  · simp only [next]; omega

/-- Every input keeps the invariant. -/
theorem inv_step {L : Limits} (hSlots : 0 < L.maxSlots) (s : State) (i : Input) (h : Inv L s) :
    Inv L (step L s i).1 := by
  cases i with
  | openPlace p =>
    simp only [step]
    split
    · exact h
    · rename_i notIn
      split
      · exact h
      · rename_i notFull
        simp [full] at notFull
        constructor
        · exact h.activeEq
        · exact h.activeLe
        · exact h.conserving
        · exact h.pendingIff
        · exact h.runningIff
        · exact h.pendingNodup
        · exact h.runningNodup
        · simp [h.heldEq]
        · simpa [List.nodup_cons] using ⟨notIn, h.placesNodup⟩
        · simp only; omega
        · simp only; unfold cap at *; omega
        · exact h.runningSlots
        · exact h.waitingSlots
  | closePlace p =>
    simp only [step]
    split
    · rename_i hp; exact (inv_closePlace h hp).1
    · exact h
  | dispatch r place =>
    simp only [step]
    split
    · rename_i absent
      have notRunning : ∀ n, s.phase r ≠ .running n := by simp [absent]
      have notWaiting : ∀ n, s.phase r ≠ .waiting n := by simp [absent]
      split
      · rename_i p
        split
        · rename_i hp
          obtain ⟨closed, total⟩ := inv_closePlace h hp
          refine inv_enqueue_of_inv closed notRunning notWaiting ?_ hSlots
          intro _
          have := h.totalLe
          omega
        · exact inv_enqueue_of_inv h notRunning notWaiting (by simp) hSlots
      · exact inv_enqueue_of_inv h notRunning notWaiting (by simp) hSlots
    · exact h
  | settle r =>
    simp only [step]
    split
    · rename_i n hr; exact (inv_release h hr).1
    · exact h
  | overrun r =>
    simp only [step]
    split
    · rename_i n hr; exact (inv_release h hr).1
    · exact h
  | yieldSlot r =>
    simp only [step]
    split
    · rename_i used hr
      split
      · rename_i usedLt
        obtain ⟨freed, finished, total⟩ := inv_release (L := L) h hr
        refine inv_enqueue_of_inv freed ?_ ?_ ?_ usedLt
        · intro n; rw [finished]; simp
        · intro n; rw [finished]; simp
        · intro _
          have := h.totalLe
          omega
      · exact h
    · exact h

/-- The invariant is inductive. -/
theorem inductive_inv {L : Limits} (hSlots : 0 < L.maxSlots) :
    Spec.Inductive (system L) (Inv L) :=
  ⟨inv_empty L, fun s i h => inv_step hSlots s i h⟩

end Spec.Workers
