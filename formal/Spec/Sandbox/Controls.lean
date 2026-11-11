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
theorem inactive_cleanup_stalls (s : Cleanup) (cr r k : Bool) :
    cleanupStep s (.sweep false true true true cr r k) = (s, []) := by rfl

/-- G403: a failed teardown that neither the hand-back nor `keepForSweep` keeps, after which another
run takes the machine's own key, leaves a running machine no later sweep reaches. -/
theorem unkept_taken_key_strands (cr : Bool) (rest : List CleanupInput) :
    let s := (cleanupSystem.runFrom {} (.sweep true true true false cr false false :: .takeKey :: rest)).1
    s.physical = true ∧ s.row = false ∧ s.mirror = false := by
  have h := Proofs.stranded ⟨false, true, false, false⟩ rfl rfl rest
  change (cleanupSystem.runFrom ⟨false, true, false, false⟩ rest).1.physical = true ∧
    (cleanupSystem.runFrom ⟨false, true, false, false⟩ rest).1.row = false ∧
    (cleanupSystem.runFrom ⟨false, true, false, false⟩ rest).1.mirror = false
  rw [h]; exact ⟨rfl, rfl, rfl⟩

/-- With the key untaken, the orphaned mirror row lets the next sweep tear an unkept machine down. -/
theorem unkept_orphan_retried (r k : Bool) :
    (cleanupSystem.final [.sweep true true true false true false false,
      .sweep true true true true true r k]).physical = false := by
  cases r <;> cases k <;> rfl

/-- G405: a retry through the kept `teardown:<externalId>` reservation removes the machine and
leaves its mirror row under the own key. -/
theorem kept_retry_leaves_mirror (r k : Bool) :
    let s := cleanupSystem.final [.sweep true true true false true false true,
      .sweep true true true true true r k]
    s.physical = false ∧ s.mirror = true := by
  cases r <;> cases k <;> exact ⟨rfl, rfl⟩

/-- G403: once the account no longer holds the credentials the machine was started with, no sweep
tears it down, though its rows stay intact when every hand-back lands. -/
theorem lost_credentials_keep_machine (trace : List CleanupInput)
    (h : ∀ i ∈ trace, lacksCredentials i = true) :
    (cleanupSystem.final trace).physical = true :=
  Proofs.no_credentials cleanupSystem.init trace h rfl

/-- Selection, confinement, daemon reclaim, launch and sweep each have a successful case. -/
theorem successful_cases :
    select [7] (some 7) = some 7 ∧ lexicalPath "/a/./b" = some "a/b" ∧
    acceptsHello true (some "same") (some "same") false = true ∧
    (jobStep 1 (jobStep 1 {} .check) .launch).running = 1 := by cbv <;> decide

/-- Successful cleanup emits an observable teardown outcome. -/
theorem cleanup_nonvacuous : Spec.NonVacuous cleanupSystem (fun _ => True) (fun e => e = true) := by
  exact ⟨[.sweep true true true true true false false], trivial, true,
    by change true ∈ ([true] : List Bool); simp, rfl⟩

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
  have bad := h () [] [.sweep true true true true true false false] trivial trivial rfl rfl
  change ([] : List Bool) = [true] at bad
  contradiction

/-- Cleanup that never calls the provider cannot satisfy the stated progress schedule. -/
theorem disabled_sweep_breaks_progress :
    ¬ Spec.Progress { cleanupSystem with step := fun s _ => (s, []) }
      (fun _ => True) (fun _ schedule => ∃ r k, schedule = [.sweep true true true true true r k])
      (fun s => (s.row || s.mirror) = true) (fun s => s.physical = false) := by
  intro h
  have bad := h [] trivial rfl [.sweep true true true true true false false] ⟨false, false, rfl⟩
  exact Bool.noConfusion bad

/-- A broken sweep that drops the reservation and the mirror row on every failed teardown. -/
def droppedRowStep (s : Cleanup) : CleanupInput → Cleanup × List Bool
  | .sweep a l c p cr _ _ =>
    let next := cleanupStep s (.sweep a l c p cr false false)
    ({ next.1 with mirror := next.1.mirror && next.1.row }, next.2)
  | .takeKey => cleanupStep s .takeKey

/-- `droppedRowStep` makes `failed_teardown_stays_reachable` false. -/
theorem dropped_row_breaks_reachability :
    ¬ ∀ trace : List CleanupInput, (∀ i ∈ trace, i ≠ .takeKey) →
      (trace.foldl (fun s i => (droppedRowStep s i).1) ({} : Cleanup)).physical = true →
      ((trace.foldl (fun s i => (droppedRowStep s i).1) ({} : Cleanup)).row ||
        (trace.foldl (fun s i => (droppedRowStep s i).1) ({} : Cleanup)).mirror) = true := by
  intro h
  have bad := h [.sweep true true true false true true true] (by simp) rfl
  exact Bool.noConfusion bad

/-- No in-flight read admits an ordinary successful fresh lookup followed by teardown. -/
theorem no_inflight_nonvacuous :
    (instanceStep {} .drop).physical = false ∧
    (instanceStep (instanceStep {} .delete) .read).cached = false := by decide

end Spec.Sandbox.Controls

namespace Spec.Sandbox.Controls

/-- The old single `select` ran an unnamed computer action on the first of two machines. -/
theorem head_selection_breaks_computer :
    select [1, 2] none = some 1 ∧ selectComputer [1, 2] none = none := by decide

end Spec.Sandbox.Controls
