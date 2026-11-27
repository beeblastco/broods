import Spec.Statements

/-!
General facts about the properties in `Statements.lean`. Every subsystem reuses them, so a subsystem
only proves its one-step lemmas.
-/

namespace Spec

/-- Running `a ++ b` is running `a` and then continuing with `b`. -/
theorem System.runFrom_append (sys : System) (s : sys.State) (a b : List sys.Input) :
    sys.runFrom s (a ++ b) =
      ((sys.runFrom (sys.runFrom s a).1 b).1,
        (sys.runFrom s a).2 ++ (sys.runFrom (sys.runFrom s a).1 b).2) := by
  induction a generalizing s with
  | nil => simp [System.runFrom]
  | cons i rest ih => simp [System.runFrom, ih, List.append_assoc]

/-- The state after one more input. -/
theorem System.final_snoc (sys : System) (trace : List sys.Input) (i : sys.Input) :
    sys.final (trace ++ [i]) = (sys.step (sys.final trace) i).1 := by
  simp [System.final, System.runFrom_append, System.runFrom]

/-- The effects after one more input. -/
theorem System.effects_snoc (sys : System) (trace : List sys.Input) (i : sys.Input) :
    sys.effects (trace ++ [i]) = sys.effects trace ++ (sys.step (sys.final trace) i).2 := by
  simp [System.effects, System.final, System.runFrom_append, System.runFrom]

/-- A property kept by every step is kept by every run from a state that has it. -/
theorem Inductive.runFrom {sys : System} {inv : sys.State → Prop} (h : Inductive sys inv)
    (s : sys.State) (hs : inv s) (trace : List sys.Input) : inv (sys.runFrom s trace).1 := by
  induction trace generalizing s with
  | nil => exact hs
  | cons i rest ih => exact ih _ (h.2 s i hs)

/-- An inductive invariant holds in every reachable state. -/
theorem Inductive.always {sys : System} {inv : sys.State → Prop} (h : Inductive sys inv) :
    Always sys inv := by
  intro s ⟨trace, hs⟩
  subst hs
  exact h.runFrom _ h.1 trace

/-- A claim about one step's effects, given the invariant, holds of every effect of every run. -/
theorem Inductive.effects {sys : System} {inv : sys.State → Prop} (h : Inductive sys inv)
    {claim : sys.Effect → Prop}
    (one : ∀ s i, inv s → ∀ e ∈ (sys.step s i).2, claim e) :
    ∀ trace, ∀ e ∈ sys.effects trace, claim e := by
  have general : ∀ (trace : List sys.Input) (s : sys.State), inv s →
      ∀ e ∈ (sys.runFrom s trace).2, claim e := by
    intro trace
    induction trace with
    | nil => intro _ _ e he; simp [System.runFrom] at he
    | cons i rest ih =>
      intro s hs e he
      simp only [System.runFrom, List.mem_append] at he
      rcases he with he | he
      · exact one s i hs e he
      · exact ih _ (h.2 s i hs) e he
  intro trace e he
  exact general trace _ h.1 e he

end Spec
