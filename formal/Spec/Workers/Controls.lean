import Spec.Workers.Theorems

/-!
Controls, checked by the kernel: each breaks the queue in one way and proves the matching theorem
false for the broken queue. So the theorems are not true of everything, and they detect that fault.
-/

namespace Spec.Workers.Controls

/-- Limits small enough to break by hand. -/
def tiny : Limits :=
  { maxWorkers := 1, maxPending := 1, maxSlots := 1 }

/-- A queue whose dispatch ignores the slot limit. -/
def noLimitStep (L : Limits) (s : State) : Input → State × List Effect
  | .dispatch r _ => start s r 0
  | i => step L s i

/-- `slots_bounded` fails without the limit check. -/
theorem no_limit_breaks_slots_bounded :
    ¬ Spec.Always { system tiny with step := noLimitStep tiny } (fun s => s.active ≤ tiny.maxWorkers) := by
  intro holds
  have broken := holds _ ⟨[.dispatch 0 none, .dispatch 1 none], rfl⟩
  exact absurd broken (by decide)

/-- A queue whose release forgets to hand the slot to the next run. -/
def noHandoffStep (L : Limits) (s : State) : Input → State × List Effect
  | .settle r =>
    match s.phase r with
    | .running _ => (s.free r, [])
    | _ => (s, [])
  | i => step L s i

/-- `work_conserving` fails without the hand-off: the run in the queue stalls with a free slot. -/
theorem no_handoff_breaks_work_conserving :
    ¬ Spec.Always { system tiny with step := noHandoffStep tiny }
      (fun s => s.pending ≠ [] → s.active = tiny.maxWorkers) := by
  intro holds
  have broken := holds _ ⟨[.dispatch 0 none, .dispatch 1 none, .settle 0], rfl⟩
  exact absurd (broken (by decide)) (by decide)

/-- A queue that treats a yielding run as sheddable. -/
def shedOnYieldStep (L : Limits) (s : State) : Input → State × List Effect
  | .yieldSlot r =>
    match s.phase r with
    | .running used =>
      let freed := release s r
      let queued := enqueue L freed.1 r used true
      (queued.1, freed.2 ++ queued.2)
    | _ => (s, [])
  | i => step L s i

/-- `shed_only_unplaced_first_dispatch` fails if a yield can be shed: a run that held its lease and already
did work would be dropped mid-turn. The trace reaches it through the capacity slack that
`capacity_bounded` documents. -/
theorem shed_on_yield_drops_a_live_run :
    ¬ ∀ trace, Effect.refused 0 ∉
      ({ system tiny with step := shedOnYieldStep tiny } : Spec.System).effects trace := by
  intro holds
  apply holds [.openPlace 1, .openPlace 2, .dispatch 0 none, .dispatch 1 (some 1), .yieldSlot 0]
  show Effect.refused 0 ∈ ([.started 0 1, .started 1 1, .refused 0] : List Effect)
  decide

end Spec.Workers.Controls
