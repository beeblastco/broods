import Broods.Sync

/-!
# Two sessions syncing one stage

`handleManifestSync` (`packages/convex/cli/httpRoutes.ts`) is an action, not a
transaction: it writes the stage's rows in separate mutations, first
`recordExternalResourcesBySecretHash` (skills, hooks and MCP snapshots), then
`syncManifestBySecretHash` (everything else), and with prune a second record that
drops what the manifest no longer declares. Each mutation is serializable on its
own, so without an exclusive claim two sessions can interleave mutation by mutation.

The PUT's first mutation claims the revision and keeps an exclusive stage claim
until `finishManifestSync` runs in `finally`. Every overlapping PUT is refused,
including a deploy without a revision and a client that read the in-flight revision.
`active` abstracts a nonexpired `stageSyncs.activeUntil` as its owning revision.
Abandoned-claim expiry is outside this model: the implementation waits longer than
the HTTP action and child Node action execution limits before admitting another PUT.
-/

namespace Broods.SyncConcurrency

open Broods.Sync

/-- The two row groups a PUT writes, one per mutation, and the manifest revision. -/
structure Server where
  ext : State
  main : State
  rev : Nat
  active : Option Nat
  deriving DecidableEq, Repr

/-- One mutation of `handleManifestSync`. -/
inductive Step where
  | claim (expected : Option Nat)
  | release (revision : Nat)
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

/-- `claimManifestRevision`: an idle stage accepts no revision or the current one
and takes the next revision. -/
def claims (s : Server) (expected : Option Nat) : Bool :=
  s.active.isNone && expected.all (· == s.rev)

/-- One committed mutation: `recordExternalResourcesBySecretHash` reconciles the
external rows, `syncManifestBySecretHash` the rest, each in its own transaction. -/
def apply (store : Resource → Resource) : Step → Server → Server
  | .claim e, s =>
    if claims s e then { s with rev := s.rev + 1, active := some (s.rev + 1) } else s
  | .release r, s => if s.active == some r then { s with active := none } else s
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
  if claims s expected then
    let claimed := { s with rev := s.rev + 1, active := some (s.rev + 1) }
    apply store (.release (s.rev + 1)) (run store (put m prune) claimed)
  else s

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
    | claim | release => simp [Step.isRecord] at h
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
    | claim | release => simp only [apply]; split <;> rfl
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

/-- An admitted PUT applies its modeled writes and releases its claim. -/
theorem fresh_put_applies (m : Manifest) (prune : Bool) (s : Server) (e : Option Nat)
    (he : claims s e = true) :
    putAt store m prune e s =
      apply store (.release (s.rev + 1))
        (run store (put m prune) { s with rev := s.rev + 1, active := some (s.rev + 1) }) := by
  simp [putAt, he]

/-- While the action owns the stage, every overlapping PUT writes nothing. -/
theorem busy_put_noop (m : Manifest) (prune : Bool) (s : Server) (e : Option Nat)
    (h : s.active.isNone = false) : putAt store m prune e s = s := by
  simp [putAt, claims, h]

/-- An older action's cleanup cannot release a newer claim. -/
theorem stale_release_noop (s : Server) (r : Nat) (h : s.active ≠ some r) :
    apply store (.release r) s = s := by
  simp [apply, h]

end

/-! ## Exclusive claims, with and without revisions -/

/-- A second deploy cannot claim while A is uploading. Only A's rows land. -/
example :
    let mA : Manifest := [⟨.hook, 1, ⟨0, none, none⟩⟩, ⟨.agent, 1, ⟨0, none, none⟩⟩]
    let mB : Manifest := [⟨.hook, 2, ⟨0, none, none⟩⟩, ⟨.agent, 2, ⟨0, none, none⟩⟩]
    let claimed := apply id (.claim none) ⟨[], [], 0, none⟩
    putAt id mB true none claimed = claimed ∧
      readAll (run id (put mA true ++ [.release 1]) claimed) = mA := by
  decide

/-- Reading the in-flight revision does not admit a second writer either. -/
example :
    let claimed := apply id (.claim (some 0)) ⟨[], [], 0, none⟩
    putAt id [⟨.agent, 2, ⟨7, none, none⟩⟩] false (some 1) claimed = claimed := by
  decide

/-- After A finishes, a stale dev revision is refused without renaming A's agent. -/
example :
    let a := putAt id [⟨.agent, 1, ⟨7, none, none⟩⟩] false (some 0) ⟨[], [], 0, none⟩
    let b := putAt id [⟨.agent, 2, ⟨7, none, none⟩⟩] false (some 0) a
    readAll b = [⟨.agent, 1, ⟨7, none, none⟩⟩] ∧ b.active = none := by
  decide

/-- A later deploy can replace A once its claim has been released. -/
example :
    let a := putAt id [⟨.agent, 1, ⟨7, none, none⟩⟩] true none ⟨[], [], 0, none⟩
    let b := putAt id [⟨.agent, 2, ⟨8, none, none⟩⟩] true none a
    readAll b = [⟨.agent, 2, ⟨8, none, none⟩⟩] ∧ b.active = none := by
  decide

end Broods.SyncConcurrency
