/-!
# `broods dev` watch loop

`watchSource` in `packages/broods/src/cli/dev-watch.ts`, which `dev()` runs. A watcher event
arms a debounce timer; one sync runs at a time with one queued rerun, and a child may fail
midway. The source (`α`) is the `.ts` and `.md` files under `broods/`, the ones
`sourceSignature` hashes. `watch()` is armed before the first `runSync()`, so every change
reaches the timer. Any number of changes.
-/

namespace Broods.DevWatch

/-- Where the running `runSync` is: idle (`syncing` false), `sourceSignature`, child read,
child write, or its `.finally`. -/
inductive Pc where
  | idle | sig | read | write | done
  deriving DecidableEq, Repr

/-- `stage` is what the stage holds, `last` the signature of the last clean sync, `sig` and
`read` what this sync hashed and what its child read; `dirty` is a save since `sig`, `printed`
an error printed by this sync. -/
structure State (α : Type) where
  src : α
  stage : Option α
  last : Option α
  failed : Bool
  pending : Bool
  timer : Bool
  pc : Pc
  sig : Option α
  read : Option α
  dirty : Bool
  printed : Bool

variable {α : Type} [DecidableEq α]

/-- `watch()`, then `runSync()` for the first sync, against any stage. -/
def Init (s : State α) : Prop :=
  s.last = none ∧ s.failed = false ∧ s.pending = false ∧ s.timer = false ∧ s.sig = none ∧
    s.read = none ∧ s.dirty = false ∧ s.printed = false ∧ s.pc = .sig

inductive Step : State α → State α → Prop where
  /-- Any watcher event outside the generated folders: a save (possibly of identical bytes),
  a folder rename, a non-source file. Each sets `savedSinceSignature`, whatever its filename. -/
  | edit (s : State α) (x : α) : Step s { s with src := x, timer := true, dirty := true }
  /-- `runSync` from the debounce timer: queue a rerun, or start. -/
  | timerFires (s : State α) (h : s.timer = true) :
    Step s (if s.pc = .idle then { s with timer := false, pc := .sig }
      else { s with timer := false, pending := true })
  /-- `const signature = await sourceSignature()`: skip, or mark failed and sync. -/
  | signature (s : State α) (h : s.pc = .sig) :
    Step s (let t := { s with sig := some s.src, printed := false, dirty := false }
      if some s.src = s.last ∧ s.failed = false then { t with pc := .done }
      else { t with pc := .read, failed := true })
  /-- `sourceSignature()` rejects: a save was replacing a file it read. `printSyncError`
  logs it; that save's own watcher event re-arms the timer. -/
  | signatureFails (s : State α) (x : α) (h : s.pc = .sig) :
    Step s { s with src := x, timer := true, dirty := true, printed := true, pc := .done }
  /-- `sourceSignature()` rejects with no save behind it (a permission error): logged, and
  nothing retries until the next save. -/
  | signatureErrors (s : State α) (h : s.pc = .sig) :
    Step s { s with printed := true, pc := .done }
  /-- The child reads the project from disk, after the signature was taken. -/
  | childRead (s : State α) (h : s.pc = .read) :
    Step s { s with read := some s.src, pc := .write }
  | childSucceeds (s : State α) (h : s.pc = .write) :
    Step s { s with
      stage := s.read, failed := false, last := (if s.dirty then none else s.sig), pc := .done }
  /-- A failed child may have written part of the stage. -/
  | childFails (s : State α) (stage : Option α) (h : s.pc = .write)
      (hs : stage = s.stage ∨ stage = s.read) :
    Step s { s with stage := stage, pc := .done }
  /-- The `.finally` of `runSync`: run the queued rerun, or go idle. -/
  | done (s : State α) (h : s.pc = .done) :
    Step s (if s.pending then { s with pending := false, pc := .sig }
      else { s with pc := .idle })

inductive Reachable : State α → Prop where
  | init (s : State α) : Init s → Reachable s
  | step (s t : State α) : Reachable s → Step s t → Reachable t

/-- Nothing left to do: no timer armed and no sync running. -/
def Quiescent (s : State α) : Prop := s.timer = false ∧ s.pc = .idle

/-- The inductive invariant behind `stage_matches_source`. -/
structure Inv (s : State α) : Prop where
  idle_pending : s.pc = .idle → s.pending = false
  dirty_armed : s.dirty = true → s.timer = true ∨ s.pending = true ∨ s.pc = .sig ∨
    s.printed = true
  child_failed : (s.pc = .read ∨ s.pc = .write) → s.failed = true ∧ s.printed = false
  last_stage : s.failed = false → s.last = none ∨ s.last = s.stage
  clean_sig : (s.pc = .read ∨ s.pc = .write) → s.dirty = false → s.sig = some s.src
  clean_read : s.pc = .write → s.dirty = false → s.read = some s.src
  settled : (s.pc = .done ∨ s.pc = .idle) → s.timer = false → s.pending = false →
    s.stage = some s.src ∨ s.failed = true ∨ s.printed = true

theorem inv (s : State α) (hs : Reachable s) : Inv s := by
  induction hs with
  | init s h =>
    obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9⟩ := h
    constructor <;> simp_all
  | step s t _ hst ih =>
    obtain ⟨i2, i3, i4, i5, i6, i7, i8⟩ := ih
    cases hst with
    | edit x => constructor <;> simp_all
    | timerFires h =>
      split
      · constructor <;> simp_all
      · constructor <;> simp_all
    | signature h =>
      split
      · rename_i hc
        obtain ⟨hl, hf⟩ := hc
        constructor <;> simp_all
        cases i5 <;> simp_all
      · constructor <;> simp_all
    | signatureFails x h => constructor <;> simp_all
    | signatureErrors h => constructor <;> simp_all
    | childRead h => constructor <;> simp_all
    | childSucceeds h =>
      constructor <;> simp_all <;> cases hd : s.dirty <;> simp_all <;> intro _ _ <;> simp_all
    | childFails stage h hs => constructor <;> simp_all
    | done h =>
      split
      · constructor <;> simp_all
      · constructor <;> simp_all

/-- Whenever nothing is left to do, the stage holds the source, unless the last sync failed
or the last signature read errored: either way an error is printed and the next save
retries. -/
theorem stage_matches_source (s : State α) (hs : Reachable s) (hq : Quiescent s) :
    s.stage = some s.src ∨ s.failed = true ∨ s.printed = true :=
  (inv s hs).settled (.inr hq.2) hq.1 ((inv s hs).idle_pending hq.2)

/-- The code before the fix: only a `.ts`/`.md` filename set `savedSinceSignature`, so a folder
rename armed the timer and left `dirty` alone. -/
inductive StepBefore : State α → State α → Prop where
  | step (s t : State α) (h : Step s t) : StepBefore s t
  | rename (s : State α) (x : α) : StepBefore s { s with src := x, timer := true }

inductive ReachableBefore : State α → Prop where
  | init (s : State α) : Init s → ReachableBefore s
  | step (s t : State α) : ReachableBefore s → StepBefore s t → ReachableBefore t

/-- Finding, fixed: a folder renamed after the signature and back before the child's sync
landed left the stage on the renamed folder, quiescent, with no error. -/
example : ∃ s : State Nat, ReachableBefore s ∧ Quiescent s ∧ s.stage ≠ some s.src ∧
    s.failed = false ∧ s.printed = false := by
  let s0 : State Nat :=
    { src := 0, stage := none, last := none, failed := false, pending := false, timer := false,
      pc := .sig, sig := none, read := none, dirty := false, printed := false }
  have r0 : ReachableBefore s0 := .init _ ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
  have r1 := ReachableBefore.step _ _ r0 (.step _ _ (Step.signature _ rfl))
  have r2 := ReachableBefore.step _ _ r1 (.rename _ 1)
  have r3 := ReachableBefore.step _ _ r2 (.step _ _ (Step.childRead _ rfl))
  have r4 := ReachableBefore.step _ _ r3 (.rename _ 0)
  have r5 := ReachableBefore.step _ _ r4 (.step _ _ (Step.childSucceeds _ rfl))
  have r6 := ReachableBefore.step _ _ r5 (.step _ _ (Step.done _ rfl))
  have r7 := ReachableBefore.step _ _ r6 (.step _ _ (Step.timerFires _ rfl))
  have r8 := ReachableBefore.step _ _ r7 (.step _ _ (Step.signature _ rfl))
  have r9 := ReachableBefore.step _ _ r8 (.step _ _ (Step.done _ rfl))
  exact ⟨_, r9, ⟨rfl, rfl⟩, by decide, rfl, rfl⟩

end Broods.DevWatch
