import Broods.Sync

/-!
# Two sessions syncing one stage

`handleManifestSync` (`packages/convex/cli/httpRoutes.ts`) is an action, not a
transaction: it writes the stage's rows in separate mutations, first
`recordExternalResourcesBySecretHash` (skills, hooks and MCP snapshots), then
`syncManifestBySecretHash` (everything else). The server has no version or
compare-and-set, so two `dev` sessions or deployers on one stage interleave
mutation by mutation. Each mutation is serializable on its own.
-/

namespace Broods.SyncConcurrency

open Broods.Sync

/-- The two row groups a PUT writes, one per mutation. -/
structure Server where
  ext : State
  main : State
  deriving DecidableEq, Repr

/-- One mutation of `handleManifestSync`. -/
inductive Step where
  | record (m : Manifest) (prune : Bool)
  | main (m : Manifest) (prune : Bool)
  deriving DecidableEq, Repr

/-- What `recordExternalResourcesBySecretHash` writes: the skills, hooks and MCP servers. -/
def extPart (m : Manifest) : Manifest := m.filter (·.kind.external)

/-- What `syncManifestBySecretHash` writes: every other kind. -/
def mainPart (m : Manifest) : Manifest := m.filter (!·.kind.external)

/-- Whether the step is `recordExternalResourcesBySecretHash`. -/
def Step.isRecord : Step → Bool
  | .record _ _ => true
  | .main _ _ => false

/-- One committed mutation: `recordExternalResourcesBySecretHash` reconciles the
external rows, `syncManifestBySecretHash` the rest, each in its own transaction. -/
def apply (store : Resource → Resource) : Step → Server → Server
  | .record m p, s => { s with ext := sync store (extPart m) p s.ext }
  | .main m p, s => { s with main := sync store (mainPart m) p s.main }

/-- One PUT, in `handleManifestSync` order. -/
def put (m : Manifest) (prune : Bool) : List Step := [.record m prune, .main m prune]

/-- Runs mutations in the order the server committed them. -/
def run (store : Resource → Resource) (steps : List Step) (s : Server) : Server :=
  steps.foldl (fun s st => apply store st s) s

/-- `GET /manifest`. -/
def readAll (s : Server) : Manifest := read s.ext ++ read s.main

/-! ## Properties -/

section
variable {store : Resource → Resource}

theorem unique_filter {m : Manifest} (p : Resource → Bool) (hu : m.unique) :
    Manifest.unique (m.filter p) :=
  fun x hx y hy hk => hu x (List.mem_filter.mp hx).1 y (List.mem_filter.mp hy).1 hk

private theorem run_main_untouched (post : List Step) (s : Server)
    (h : ∀ st ∈ post, st.isRecord = true) : (run store post s).main = s.main := by
  induction post generalizing s with
  | nil => rfl
  | cons st rest ih =>
    simp only [run, List.foldl_cons] at ih ⊢
    rw [ih _ (fun st' hs => h st' (List.mem_cons_of_mem _ hs))]
    cases st with
    | record => rfl
    | main => simp [Step.isRecord] at h

private theorem run_ext_untouched (post : List Step) (s : Server)
    (h : ∀ st ∈ post, st.isRecord = false) : (run store post s).ext = s.ext := by
  induction post generalizing s with
  | nil => rfl
  | cons st rest ih =>
    simp only [run, List.foldl_cons] at ih ⊢
    rw [ih _ (fun st' hs => h st' (List.mem_cons_of_mem _ hs))]
    cases st with
    | record => simp [Step.isRecord] at h
    | main => rfl

/-- Whatever the interleaving, the rows `syncManifestBySecretHash` owns converge to
the session whose main mutation committed last. -/
theorem last_main_wins (hkey : ∀ r, (store r).key = r.key)
    (hsnap : ∀ r, diff.snapshot (store r) = diff.snapshot r)
    {m : Manifest} (hu : m.unique) (pre post : List Step) (s : Server)
    (hpost : ∀ st ∈ post, st.isRecord = true) :
    diff (mainPart m) (read (run store (pre ++ .main m true :: post) s).main) = [] := by
  rw [run, List.foldl_append, List.foldl_cons]
  rw [show (post.foldl (fun s st => apply store st s) _) = run store post _ from rfl,
    run_main_untouched post _ hpost]
  exact (sync_converges hkey hsnap (unique_filter _ hu) true _).2 rfl

/-- And the recorded skills, hooks and MCP servers converge to the session whose
record mutation committed last. -/
theorem last_record_wins (hkey : ∀ r, (store r).key = r.key)
    (hsnap : ∀ r, diff.snapshot (store r) = diff.snapshot r)
    {m : Manifest} (hu : m.unique) (pre post : List Step) (s : Server)
    (hpost : ∀ st ∈ post, st.isRecord = false) :
    diff (extPart m) (read (run store (pre ++ .record m true :: post) s).ext) = [] := by
  rw [run, List.foldl_append, List.foldl_cons]
  rw [show (post.foldl (fun s st => apply store st s) _) = run store post _ from rfl,
    run_ext_untouched post _ hpost]
  exact (sync_converges hkey hsnap (unique_filter _ hu) true _).2 rfl

/-- Serialized PUTs are last-writer-wins: after A then B, both row groups match B. -/
theorem serial_last_writer (hkey : ∀ r, (store r).key = r.key)
    (hsnap : ∀ r, diff.snapshot (store r) = diff.snapshot r)
    {mA mB : Manifest} (pA : Bool) (hu : mB.unique) (s : Server) :
    diff (extPart mB) (read (run store (put mA pA ++ put mB true) s).ext) = [] ∧
      diff (mainPart mB) (read (run store (put mA pA ++ put mB true) s).main) = [] := by
  constructor
  · have := last_record_wins hkey hsnap hu (put mA pA) [.main mB true] s (by simp [Step.isRecord])
    simpa [put] using this
  · have := last_main_wins hkey hsnap hu (put mA pA ++ [.record mB true]) [] s (by simp)
    simpa [put] using this

end

/-! ## Findings, as executable witnesses -/

/-- Interleaved pruning PUTs leave a stage neither session declared: B's hooks next
to A's agents. -/
example :
    let mA : Manifest := [⟨.hook, 1, ⟨0, none, none⟩⟩, ⟨.agent, 1, ⟨0, none, none⟩⟩]
    let mB : Manifest := [⟨.hook, 2, ⟨0, none, none⟩⟩, ⟨.agent, 2, ⟨0, none, none⟩⟩]
    let s := run id [.record mA true, .record mB true, .main mB true, .main mA true] ⟨[], []⟩
    readAll s = [⟨.hook, 2, ⟨0, none, none⟩⟩, ⟨.agent, 1, ⟨0, none, none⟩⟩] ∧
      diff mA (readAll s) ≠ [] ∧ diff mB (readAll s) ≠ [] := by
  decide

/-- Without prune a stale session still removes another's resource: B, which never
saw A's agent 1, declares agent 2 with the same content, and the server renames
agent 1 away. -/
example :
    let s := run id (put [⟨.agent, 1, ⟨7, none, none⟩⟩] false ++
      put [⟨.agent, 2, ⟨7, none, none⟩⟩] false) ⟨[], []⟩
    readAll s = [⟨.agent, 2, ⟨7, none, none⟩⟩] := by
  decide

end Broods.SyncConcurrency
