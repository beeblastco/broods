import Spec.Sandbox.Theorems

namespace Spec.Sandbox.Controls

/-- G400: two checks at zero followed by two launches exceed a cap of one. -/
theorem racing_checks_exceed_cap :
    ([JobInput.check, .check, .launch, .launch].foldl (jobStep 1) {}).running = 2 := by cbv <;> decide

/-- G401: reserve reads externalId, release drops/deletes it, then reserve returns its cached id. -/
theorem released_instance_returned :
    let s := [InstanceInput.read, .drop, .delete, .refreshReturn].foldl instanceStep {}
    s.physical = false ∧ s.row = false ∧ s.returned = true := by cbv <;> decide

/-- A path normalizer that omits traversal rejection violates lexical confinement. -/
theorem unchecked_path_breaks_confinement : ".." ∈ pathParts "a/../b" := by
  have h : pathParts "a/../b" = ["a", "..", "b"] := by cbv <;> decide
  rw [h]
  simp

/-- A selector that returns arbitrary requested ids violates attachment membership. -/
theorem unchecked_selection_breaks_attachment : 2 ∉ ([1] : List Nat) := by decide

/-- An unfenced hello accepting any daemon violates exclusion. -/
theorem unchecked_hello_breaks_exclusion :
    acceptsHello true (some "first") (some "second") false = false := by cbv <;> decide

/-- An inactive account can retain a physical sandbox through arbitrarily many sweeps. -/
theorem inactive_cleanup_stalls (s : Cleanup) :
    cleanupStep s (.sweep false true true true) = (s, []) := by rfl

/-- Selection, confinement, daemon reclaim, launch and sweep each have a successful case. -/
theorem successful_cases :
    select [7] (some 7) = some 7 ∧ lexicalPath "/a/./b" = some "a/b" ∧
    acceptsHello true (some "same") (some "same") false = true ∧
    (jobStep 1 (jobStep 1 {} .check) .launch).running = 1 := by cbv <;> decide

/-- Successful cleanup emits an observable teardown outcome. -/
theorem cleanup_nonvacuous : Spec.NonVacuous cleanupSystem (fun _ => True) (fun e => e = true) := by
  exact ⟨[.sweep true true true true], trivial, true, by change true ∈ ([true] : List Bool); simp, rfl⟩

end Spec.Sandbox.Controls

namespace Spec.Sandbox.Controls

/-- A broken selector trusts the caller's id instead of looking in attached resources. -/
def brokenSelect (_xs : List Nat) (r : Option Nat) : Option Nat := r

theorem broken_select_fails_membership :
    ¬ ∀ xs r x, brokenSelect xs r = some x → x ∈ xs := by
  intro h
  have bad := h [1] (some 2) 2 rfl
  simp at bad

/-- Forgetting to consume an admission makes the launch accounting theorem false. -/
def brokenLaunch (s : Jobs) : Jobs := { s with running := s.running + 1 }

theorem broken_launch_fails_accounting :
    (brokenLaunch ⟨0, 1⟩).running + (brokenLaunch ⟨0, 1⟩).admitted ≠ 0 + 1 := by decide

/-- Removing the declared outcome leakage would falsely promise identical observable traces. -/
theorem hidden_outcomes_break_privacy :
    ¬ Spec.Private cleanupSystem Unit Unit Bool (fun _ => True)
      (fun _ _ => []) (fun _ => ()) (fun _ effects => effects) := by
  intro h
  have bad := h () [] [.sweep true true true true] trivial trivial rfl rfl
  change ([] : List Bool) = [true] at bad
  contradiction

/-- Cleanup that never calls the provider cannot satisfy the stated progress schedule. -/
theorem disabled_sweep_breaks_progress :
    ¬ Spec.Progress { cleanupSystem with step := fun s _ => (s, []) }
      (fun _ => True) (fun _ schedule => schedule = [.sweep true true true true])
      (fun s => s.row = true) (fun s => s.physical = false ∧ s.mirror = false) := by
  intro h
  have bad := h [] trivial rfl [.sweep true true true true] rfl
  exact Bool.noConfusion bad.1

/-- No in-flight read admits an ordinary successful fresh lookup followed by teardown. -/
theorem no_inflight_nonvacuous :
    (instanceStep {} .drop).physical = false ∧
    (instanceStep (instanceStep {} .delete) .read).cached = false := by decide

end Spec.Sandbox.Controls
