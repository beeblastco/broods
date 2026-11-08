import Spec.Sandbox.Proofs

/-! Safety, conditional cleanup progress, and cleanup outcome leakage. See LIMITS L400-L403. -/
namespace Spec.Sandbox

/-- A successful named/default selection comes from the run's supplied attachment list. -/
theorem tool_attachment (xs : List Nat) (r : Option Nat) (x : Nat)
    (h : select xs r = some x) : x ∈ xs := Proofs.selected_mem xs r x h

/-- A file tool's accepted path has no parent traversal segment after lexical normalization. -/
theorem lexical_confinement (p result : String) (h : lexicalPath p = some result) :
    ".." ∉ pathParts p := Proofs.lexical p result h

/-- A launch consumes one outstanding admission, bounding running plus admissions by its old sum. -/
theorem background_launch_bound (cap : Nat) (s : Jobs) :
    (jobStep cap s .launch).running + (jobStep cap s .launch).admitted =
      s.running + s.admitted := Proofs.jobs_launch cap s

/-- Only a check below the cap can grow the number of admitted launches. -/
theorem background_check_bound (cap : Nat) (s : Jobs) :
    (jobStep cap s .check).running < cap ∨ jobStep cap s .check = s :=
  Proofs.jobs_check cap s

/-- An occupied registry slot requires force or the same nonempty daemon instance. -/
theorem daemon_exclusion (p i : Option String) (force : Bool)
    (h : acceptsHello true p i force = true) :
    force = true ∨ (i.isSome = true ∧ i ≠ some "" ∧ i = p) := Proofs.hello p i force h

/-- A sweep completing lease, CAS and teardown removes the expired instance and its mirror. -/
theorem cleanup_progress : Spec.Progress cleanupSystem (fun _ => True)
    (fun _ schedule => schedule = [.sweep true true true true])
    (fun s => s.row = true) (fun s => s.physical = false ∧ s.mirror = false) := Proofs.progress

/-- Cleanup exposes only attempted teardown outcomes in this abstraction. -/
theorem cleanup_private : Spec.Private cleanupSystem Unit (List Bool) Bool (fun _ => True)
    (fun _ _ => []) cleanupLeak (fun _ effects => effects) := Proofs.privacy

/-- With a cap of one, any finite number of launches can be admitted by racing checks (G400). -/
theorem background_no_uniform_cap (n : Nat) :
    (launchBurst 1 n (checkBurst 1 n {})).running = n := Proofs.unbounded n

/-- A dropped physical id is not returned when there is no cached read in flight and no new create. -/
theorem no_resurrection_without_inflight (s : Instance) (h : s.cached = false) :
    (instanceStep (instanceStep (instanceStep s .drop) .delete) .refreshReturn).returned = false :=
  Proofs.no_inflight s h

end Spec.Sandbox
