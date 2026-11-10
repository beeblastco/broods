import Spec.Sandbox.Proofs

/-! Safety, conditional cleanup progress, and cleanup outcome leakage. See LIMITS L400-L403. -/
namespace Spec.Sandbox

/-- A successful bash or computer selection comes from the run's supplied attachment list. -/
theorem tool_attachment (xs : List Nat) (mounted : Bool) (r : Option Nat) (x : Nat) :
    (selectBash xs mounted r = some x → x ∈ xs) ∧ (selectComputer xs r = some x → x ∈ xs) :=
  ⟨Proofs.bash_mem xs mounted r x, Proofs.computer_mem xs r x⟩

/-- An unnamed computer action with two or more attached machines selects none. -/
theorem computer_unnamed_needs_one (xs : List Nat) (h : 2 ≤ xs.length) :
    selectComputer xs none = none := Proofs.computer_unnamed xs h

/-- A bash call naming the first sandbox while a workspace mounts it selects none, when no later
sandbox has the same name. -/
theorem bash_named_skips_mounted (x : Nat) (rest : List Nat) (h : x ∉ rest) :
    selectBash (x :: rest) true (some x) = none := Proofs.bash_mounted x rest h

/-- A file tool's accepted path has no `..` segment after lexical normalization. Lexical only
(L400): no realpath, symlink or mount confinement. By construction (L22). -/
theorem lexical_no_parent_segment (p result : String) (h : lexicalPath p = some result) :
    ".." ∉ pathParts p := Proofs.lexical p result h

/-- A launch moves one outstanding admission to running, conserving their sum. It bounds nothing:
admissions are unbounded (G400, `background_no_uniform_cap`). By construction (L22). -/
theorem launch_conserves_admissions (cap : Nat) (s : Jobs) :
    (jobStep cap s .launch).running + (jobStep cap s .launch).admitted =
      s.running + s.admitted := Proofs.jobs_launch cap s

/-- A check admits only when it reads `running` below the cap, else leaves the state unchanged.
It bounds nothing (G400). By construction (L22). -/
theorem check_guard_reads_running (cap : Nat) (s : Jobs) :
    (jobStep cap s .check).running < cap ∨ jobStep cap s .check = s :=
  Proofs.jobs_check cap s

/-- An occupied registry slot requires force or the same nonempty daemon instance. -/
theorem daemon_exclusion (p i : Option String) (force : Bool)
    (h : acceptsHello true p i force = true) :
    force = true ∨ (i.isSome = true ∧ i ≠ some "" ∧ i = p) := Proofs.hello p i force h

/-- From a state where a row names the machine, a sweep completing lease, CAS and teardown removes
the machine and its mirror. The teardown's success is an input (L402). -/
theorem cleanup_progress : Spec.Progress cleanupSystem (fun _ => True)
    (fun _ schedule => ∃ r k, schedule = [.sweep true true true true r k])
    (fun s => s.row = true) (fun s => s.physical = false ∧ s.mirror = false) := Proofs.progress

/-- When every failed teardown is handed back or kept for the sweep (`keepForSweep`'s claim
landed), a machine still running always has a row a later sweep lists. -/
theorem failed_teardown_stays_reachable (trace : List CleanupInput)
    (hk : ∀ i ∈ trace, keepsFailed i = true) :
    (cleanupSystem.final trace).physical = true → (cleanupSystem.final trace).row = true :=
  Proofs.kept_reachable trace hk

/-- A failed teardown that is handed back or kept, followed by a sweep whose teardown succeeds,
removes the machine and its mirror. The retry's success is an input (L402, G403). -/
theorem failed_teardown_retried : Spec.Progress cleanupSystem (fun _ => True)
    (fun _ schedule => ∃ r k r' k', (r || k) = true ∧
      schedule = [.sweep true true true false r k, .sweep true true true true r' k'])
    (fun s => s.row = true) (fun s => s.physical = false ∧ s.mirror = false) := Proofs.retry

/-- The cleanup view equals the declared leak of attempted teardown outcomes. Tautological (L22). -/
theorem cleanup_view_is_declared_leak : Spec.Private cleanupSystem Unit (List Bool) Bool (fun _ => True)
    (fun _ _ => []) cleanupLeak (fun _ effects => effects) := Proofs.privacy

/-- With a cap of one, any finite number of launches can be admitted by racing checks (G400). -/
theorem background_no_uniform_cap (n : Nat) :
    (launchBurst 1 n (checkBurst 1 n {})).running = n := Proofs.unbounded n

/-- Without a `.read`, a stale id is returned only if the starting state already returned it or
held it cached. A drop clears no cache, so a read in flight before it still returns the id (G401).
By construction (L22): only `.read` fills `cached` and `returned` copies it; the content is G401. -/
theorem return_requires_cached_read (s : Instance) (trace : List InstanceInput)
    (h : ∀ i ∈ trace, i ≠ .read) (hr : (trace.foldl instanceStep s).returned = true) :
    s.returned = true ∨ s.cached = true := Proofs.return_cached s trace h hr

end Spec.Sandbox
