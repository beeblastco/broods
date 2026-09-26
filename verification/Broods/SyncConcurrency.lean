import Broods.Sync

/-!
# Two sessions syncing one stage

`handleManifestSync` (`packages/convex/cli/httpRoutes.ts`) is an action, not a
transaction: it writes the stage's rows in separate mutations, first
`recordExternalResourcesBySecretHash` (skills, hooks and MCP snapshots), then
`syncManifestBySecretHash` (everything else), and with prune a second record that
drops what the manifest no longer declares. Each mutation is serializable on its
own, so two sessions interleave mutation by mutation.

The PUT's first mutation, `ensureScopeBySecretHash`, claims the stage's next
manifest revision (`claimManifestRevision`). `broods dev` sends the revision it
read, and a claim another sync has moved past is refused before the PUT writes
anything. `broods deploy` and older CLIs send none and always claim, so they keep
the last-writer-wins behaviour the first two witnesses show.
-/

namespace Broods.SyncConcurrency

open Broods.Sync

/-- The two row groups a PUT writes, one per mutation, and the manifest revision. -/
structure Server where
  ext : State
  main : State
  rev : Nat
  deriving DecidableEq, Repr

/-- One mutation of `handleManifestSync`. -/
inductive Step where
  | claim (expected : Option Nat)
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
  | _ => false

/-- `claimManifestRevision`: a claim with no revision, or with the current one, takes
the next revision. -/
def claims (s : Server) (expected : Option Nat) : Bool :=
  expected.all (· == s.rev)

/-- One committed mutation: `recordExternalResourcesBySecretHash` reconciles the
external rows, `syncManifestBySecretHash` the rest, each in its own transaction. -/
def apply (store : Resource → Resource) : Step → Server → Server
  | .claim e, s => if claims s e then { s with rev := s.rev + 1 } else s
  | .record m p, s => { s with ext := sync store (extPart m) p s.ext }
  | .main m p, s => { s with main := sync store (mainPart m) p s.main }

/-- One PUT, in `handleManifestSync` order: the record prunes only after the main
sync succeeded. -/
def put (m : Manifest) (prune : Bool) : List Step :=
  [.record m false, .main m prune] ++ if prune then [.record m true] else []

/-- Runs mutations in the order the server committed them. -/
def run (store : Resource → Resource) (steps : List Step) (s : Server) : Server :=
  steps.foldl (fun s st => apply store st s) s

/-- One whole PUT sent with `expected`: its claim, then its writes, or nothing at all
when the claim is refused (the action throws a 409). -/
def putAt (store : Resource → Resource) (m : Manifest) (prune : Bool)
    (expected : Option Nat) (s : Server) : Server :=
  if claims s expected then run store (put m prune) { s with rev := s.rev + 1 } else s

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
    | claim => simp [Step.isRecord] at h
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
    | claim => simp only [apply]; split <;> rfl
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
  · have := last_record_wins hkey hsnap hu (put mA pA ++ [.record mB false, .main mB true]) []
      s (by simp)
    simpa [put] using this
  · have := last_main_wins hkey hsnap hu (put mA pA ++ [.record mB false]) [.record mB true] s
      (by simp [Step.isRecord])
    simpa [put] using this

/-- A PUT sent with a revision another sync has moved past writes nothing. -/
theorem stale_put_noop (m : Manifest) (prune : Bool) (s : Server) (k : Nat)
    (hk : k ≠ s.rev) : putAt store m prune (some k) s = s := by
  simp [putAt, claims, hk]

/-- A PUT sent with the current revision, or with none, applies in full. -/
theorem fresh_put_applies (m : Manifest) (prune : Bool) (s : Server) (e : Option Nat)
    (he : claims s e = true) :
    putAt store m prune e s = run store (put m prune) { s with rev := s.rev + 1 } := by
  simp [putAt, he]

end

/-! ## Without a revision: `broods deploy` and older CLIs -/

/-- Interleaved pruning PUTs leave a stage neither session declared: B's hooks next
to A's agents. -/
example :
    let mA : Manifest := [⟨.hook, 1, ⟨0, none, none⟩⟩, ⟨.agent, 1, ⟨0, none, none⟩⟩]
    let mB : Manifest := [⟨.hook, 2, ⟨0, none, none⟩⟩, ⟨.agent, 2, ⟨0, none, none⟩⟩]
    let s := run id [.record mA false, .record mB false, .main mB true, .main mA true,
      .record mA true, .record mB true] ⟨[], [], 0⟩
    readAll s = [⟨.hook, 2, ⟨0, none, none⟩⟩, ⟨.agent, 1, ⟨0, none, none⟩⟩] ∧
      diff mA (readAll s) ≠ [] ∧ diff mB (readAll s) ≠ [] := by
  decide

/-- Without prune a stale session still removes another's resource: B, which never
saw A's agent 1, declares agent 2 with the same content, and the server renames
agent 1 away. -/
example :
    let s := run id (put [⟨.agent, 1, ⟨7, none, none⟩⟩] false ++
      put [⟨.agent, 2, ⟨7, none, none⟩⟩] false) ⟨[], [], 0⟩
    readAll s = [⟨.agent, 2, ⟨7, none, none⟩⟩] := by
  decide

/-! ## With the revision `broods dev` read -/

/-- The stale session is refused: B read revision 0, A synced first, and agent 1
stays. -/
example :
    let a := putAt id [⟨.agent, 1, ⟨7, none, none⟩⟩] false (some 0) ⟨[], [], 0⟩
    let b := putAt id [⟨.agent, 2, ⟨7, none, none⟩⟩] false (some 0) a
    readAll b = [⟨.agent, 1, ⟨7, none, none⟩⟩] := by
  decide

/-- Two sessions that read the same revision: the second claim is refused, its PUT
writes nothing, and the stage is exactly A's. -/
example :
    let mA : Manifest := [⟨.hook, 1, ⟨0, none, none⟩⟩, ⟨.agent, 1, ⟨0, none, none⟩⟩]
    let s := run id ([.claim (some 0), .claim (some 0)] ++ put mA true) ⟨[], [], 0⟩
    s = run id (.claim (some 0) :: put mA true) ⟨[], [], 0⟩ ∧ diff mA (readAll s) = [] := by
  decide

end Broods.SyncConcurrency
