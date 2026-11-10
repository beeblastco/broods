import Spec.Sandbox.Model

namespace Spec.Sandbox.Proofs

theorem selected_mem (xs : List Nat) (r : Option Nat) (x : Nat)
    (h : select xs r = some x) : x ∈ xs := by
  cases r with
  | some id => simp only [select] at h; split at h <;> simp_all
  | none =>
    cases xs with
    | nil => simp [select] at h
    | cons a rest => simp [select] at h; simp [← h]

theorem lexical (p : String) (result : String) (h : lexicalPath p = some result) :
    ".." ∉ pathParts p := by
  simp only [lexicalPath] at h
  split at h
  · contradiction
  · simpa using ‹¬ (pathParts p).contains ".." = true›

theorem jobs_launch (cap : Nat) (s : Jobs) :
    (jobStep cap s .launch).running + (jobStep cap s .launch).admitted =
      s.running + s.admitted := by
  simp only [jobStep]
  split <;> simp_all <;> omega

theorem jobs_check (cap : Nat) (s : Jobs) :
    (jobStep cap s .check).running < cap ∨ jobStep cap s .check = s := by
  simp only [jobStep]
  split <;> simp_all

theorem hello (p i : Option String) (force : Bool)
    (h : acceptsHello true p i force = true) :
    force = true ∨ (i.isSome = true ∧ i ≠ some "" ∧ i = p) := by
  simpa [acceptsHello, Bool.and_eq_true, Bool.or_eq_true, and_assoc] using h

theorem cleanup_effects (s : Cleanup) (trace : List CleanupInput) :
    (cleanupSystem.runFrom s trace).2 = cleanupLeakFrom s.row s.mirror trace := by
  induction trace generalizing s with
  | nil => rfl
  | cons i rest ih =>
    show List.append (cleanupStep s i).2 (cleanupSystem.runFrom (cleanupStep s i).1 rest).2 = _
    rw [ih]
    cases i with
    | sweep a l c p cr r k =>
      obtain ⟨row, physical, mirror⟩ := s
      cases a <;> cases l <;> cases c <;> cases row <;> cases mirror <;> cases p <;> cases cr <;>
        simp [cleanupStep, cleanupLeakFrom]
    | takeKey => simp [cleanupStep, cleanupLeakFrom]

theorem progress : Spec.Progress cleanupSystem (fun _ => True)
    (fun _ schedule => ∃ r k, schedule = [.sweep true true true true true r k])
    (fun s => (s.row || s.mirror) = true) (fun s => s.physical = false ∧ s.mirror = false) := by
  intro trace _ pending schedule fair
  obtain ⟨r, k, rfl⟩ := fair
  generalize cleanupSystem.final trace = s at pending ⊢
  simp [Spec.System.runFrom, cleanupSystem, cleanupStep, pending]

theorem privacy : Spec.Private cleanupSystem Unit (List Bool) Bool (fun _ => True)
    (fun _ _ => []) cleanupLeak (fun _ effects => effects) := by
  intro _ a b _ _ _ h
  exact (cleanup_effects cleanupSystem.init a).trans
    (h.trans (cleanup_effects cleanupSystem.init b).symm)

/-- Folds a per-step invariant over a trace whose every input satisfies `ok`. -/
theorem run_inv (inv : Cleanup → Prop) (ok : CleanupInput → Prop)
    (hstep : ∀ s i, ok i → inv s → inv (cleanupStep s i).1) (s : Cleanup)
    (trace : List CleanupInput) (hk : ∀ i ∈ trace, ok i) (h : inv s) :
    inv (cleanupSystem.runFrom s trace).1 := by
  induction trace generalizing s with
  | nil => exact h
  | cons i rest ih =>
    exact ih (cleanupStep s i).1 (fun j hj => hk j (List.mem_cons_of_mem _ hj))
      (hstep s i (hk i List.mem_cons_self) h)

theorem kept_step (s : Cleanup) (i : CleanupInput) (hk : keepsFailed i = true)
    (h : s.physical = true → s.row = true) :
    (cleanupStep s i).1.physical = true → (cleanupStep s i).1.row = true := by
  cases i with
  | sweep a l c p cr r k =>
    simp only [cleanupStep]
    split
    · split
      · simp
      · rename_i hpc
        intro _
        simp only [keepsFailed] at hk
        simp_all
    · exact h
  | takeKey => exact h

theorem mirror_step (s : Cleanup) (i : CleanupInput) (hk : i ≠ .takeKey)
    (h : s.physical = true → s.mirror = true) :
    (cleanupStep s i).1.physical = true → (cleanupStep s i).1.mirror = true := by
  cases i with
  | sweep a l c p cr r k =>
    simp only [cleanupStep]
    split
    · split
      · simp
      · exact h
    · exact h
  | takeKey => exact absurd rfl hk

theorem kept_reachable (trace : List CleanupInput)
    (h : (∀ i ∈ trace, keepsFailed i = true) ∨ (∀ i ∈ trace, i ≠ .takeKey)) :
    (cleanupSystem.final trace).physical = true →
      ((cleanupSystem.final trace).row || (cleanupSystem.final trace).mirror) = true := by
  intro hp
  rcases h with hk | hk
  · have := run_inv (fun s => s.physical = true → s.row = true) (fun i => keepsFailed i = true)
      (fun s i hi hs => kept_step s i hi hs) cleanupSystem.init trace hk (fun _ => rfl) hp
    simp [Spec.System.final, this]
  · have := run_inv (fun s => s.physical = true → s.mirror = true) (fun i => i ≠ .takeKey)
      (fun s i hi hs => mirror_step s i hi hs) cleanupSystem.init trace hk (fun _ => rfl) hp
    simp [Spec.System.final, this]

theorem retry : Spec.Progress cleanupSystem (fun _ => True)
    (fun s schedule => ∃ p cr r k r' k', (r || k || s.mirror) = true ∧
      schedule = [.sweep true true true p cr r k, .sweep true true true true true r' k'])
    (fun s => (s.row || s.mirror) = true) (fun s => s.physical = false ∧ s.mirror = false) := by
  intro trace _ pending schedule fair
  obtain ⟨p, cr, r, k, r', k', hk, rfl⟩ := fair
  generalize cleanupSystem.final trace = s at pending hk ⊢
  obtain ⟨row, physical, mirror⟩ := s
  cases p <;> cases cr <;> cases r <;> cases k <;> cases row <;> cases mirror <;>
    simp_all [Spec.System.runFrom, cleanupSystem, cleanupStep]

theorem stranded (s : Cleanup) (h : s.row = false) (hm : s.mirror = false)
    (trace : List CleanupInput) : (cleanupSystem.runFrom s trace).1 = s := by
  induction trace with
  | nil => rfl
  | cons i rest ih =>
    have hs : (cleanupStep s i).1 = s := by
      cases i with
      | sweep a l c p cr r k => simp [cleanupStep, h, hm]
      | takeKey => obtain ⟨row, physical, mirror⟩ := s; simp_all [cleanupStep]
    change (cleanupSystem.runFrom (cleanupStep s i).1 rest).1 = s
    rw [hs]; exact ih

theorem no_credentials (s : Cleanup) (trace : List CleanupInput)
    (hk : ∀ i ∈ trace, lacksCredentials i = true) (h : s.physical = true) :
    (cleanupSystem.runFrom s trace).1.physical = true :=
  run_inv (fun s => s.physical = true) (fun i => lacksCredentials i = true)
    (fun s i hi hs => by
      cases i with
      | sweep a l c p cr r k =>
        simp only [lacksCredentials] at hi
        simp only [cleanupStep]
        split
        · split
          · simp_all
          · exact hs
        · exact hs
      | takeKey => exact hs) s trace hk h

theorem check_burst (n a : Nat) : checkBurst 1 n ⟨0, a⟩ = ⟨0, a + n⟩ := by
  induction n generalizing a with
  | zero => simp [checkBurst]
  | succ n ih => simpa [checkBurst, jobStep, Nat.add_assoc, Nat.add_comm, Nat.add_left_comm] using ih (a + 1)

theorem launch_burst (n r : Nat) : launchBurst 1 n ⟨r, n⟩ = ⟨r + n, 0⟩ := by
  induction n generalizing r with
  | zero => simp [launchBurst]
  | succ n ih => simpa [launchBurst, jobStep, Nat.add_assoc, Nat.add_comm, Nat.add_left_comm] using ih (r + 1)

theorem unbounded (n : Nat) :
    (launchBurst 1 n (checkBurst 1 n {})).running = n := by
  rw [check_burst, Nat.zero_add, launch_burst, Nat.zero_add]

theorem return_cached (s : Instance) (trace : List InstanceInput)
    (h : ∀ i ∈ trace, i ≠ .read) (hr : (trace.foldl instanceStep s).returned = true) :
    s.returned = true ∨ s.cached = true := by
  induction trace generalizing s with
  | nil => exact Or.inl hr
  | cons i rest ih =>
    have hrest := ih (instanceStep s i) (fun j hj => h j (List.mem_cons_of_mem _ hj)) hr
    cases i with
    | read => exact absurd rfl (h .read List.mem_cons_self)
    | drop => exact hrest
    | delete => exact hrest
    | refreshReturn => simp only [instanceStep] at hrest; exact Or.inr (hrest.elim id id)

theorem bash_mem (xs : List Nat) (mounted : Bool) (r : Option Nat) (x : Nat)
    (h : selectBash xs mounted r = some x) : x ∈ xs := by
  cases r with
  | none => exact List.mem_of_head? h
  | some id =>
    cases mounted
    · by_cases hm : id ∈ xs <;> simp_all [selectBash]
    · by_cases hm : id ∈ xs.tail <;> simp_all [selectBash]
      exact List.mem_of_mem_tail hm

theorem computer_mem (xs : List Nat) (r : Option Nat) (x : Nat)
    (h : selectComputer xs r = some x) : x ∈ xs := by
  cases r with
  | none =>
    simp only [selectComputer] at h
    split at h
    · exact List.mem_of_head? h
    · cases h
  | some id =>
    simp only [selectComputer] at h
    split at h
    · cases h; assumption
    · cases h

theorem computer_unnamed (xs : List Nat) (h : 2 ≤ xs.length) : selectComputer xs none = none := by
  simp only [selectComputer]
  split
  · omega
  · rfl

theorem bash_mounted (x : Nat) (rest : List Nat) (h : x ∉ rest) :
    selectBash (x :: rest) true (some x) = none := by
  simp [selectBash, h]

theorem select_eq_bash (xs : List Nat) (r : Option Nat) : select xs r = selectBash xs false r := by
  cases r <;> rfl

end Spec.Sandbox.Proofs
