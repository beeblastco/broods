/-!
# `broods dev` watch loop

`dev()` in `packages/broods/src/cli/index.ts`. A save arms the debounce timer; `runSync` runs
one `syncChanged` at a time with one queued rerun, and a child may fail midway. The source is
the `.ts` and `.md` files under `broods/` that `sourceSignature` hashes, of any content type
`C`. Saves are unbounded. The watcher starts before the first sync.
-/

namespace Broods.DevWatch

/-- Where the running `syncChanged` is; `idle` when none runs. -/
inductive Pc where
  | idle | sig | read | write | done
  deriving DecidableEq, Repr

/-- The source, the stage, `lastSourceSignature`, `lastSyncFailed`, `syncing`, `pending`, the
armed `timer`, the signature taken, what the child read, `savedSinceSignature`, and whether
`printSyncError` printed for the last signature read. -/
structure State (C : Type) where
  src : C
  stage : Option C
  last : Option C
  failed : Bool
  syncing : Bool
  pending : Bool
  timer : Bool
  pc : Pc
  sig : Option C
  read : Option C
  dirty : Bool
  printed : Bool
  deriving DecidableEq, Repr

/-- One event: a save, the debounce timer, a step of `syncChanged`, or its `.finally`.
`signatureFails` is `sourceSignature()` rejecting because a save replaced a file it read;
`signatureErrors` is a rejection with no save behind it (a permission error). A failed child
may have written part of the stage (`wrote`). -/
inductive Action (C : Type) where
  | edit (c : C)
  | timerFires
  | signature
  | signatureFails (c : C)
  | signatureErrors
  | childRead
  | childSucceeds
  | childFails (wrote : Bool)
  | done
  deriving DecidableEq, Repr

variable {C : Type} [DecidableEq C]

/-- `watch()`, then `runSync()` for the first sync. -/
def init (src : C) (stage : Option C) : State C :=
  { src := src, stage := stage, last := none, failed := false, syncing := true,
    pending := false, timer := false, pc := .sig, sig := none, read := none, dirty := false,
    printed := false }

/-- One event, or `none` when it cannot happen now. A save, possibly of identical bytes, arms
the timer and sets `savedSinceSignature`. -/
def step (s : State C) : Action C → Option (State C)
  | .edit c => some { s with src := c, timer := true, dirty := true }
  | .timerFires =>
    if s.timer then
      if s.syncing then some { s with timer := false, pending := true }
      else some { s with timer := false, syncing := true, pc := .sig }
    else none
  | .signature =>
    if s.pc = .sig then
      let s := { s with sig := some s.src, printed := false, dirty := false }
      if s.last = some s.src ∧ s.failed = false then some { s with pc := .done }
      else some { s with pc := .read, failed := true }
    else none
  | .signatureFails c =>
    if s.pc = .sig then
      some { s with src := c, timer := true, dirty := true, printed := true, pc := .done }
    else none
  | .signatureErrors => if s.pc = .sig then some { s with printed := true, pc := .done } else none
  | .childRead => if s.pc = .read then some { s with read := some s.src, pc := .write } else none
  | .childSucceeds =>
    if s.pc = .write then
      some { s with stage := s.read, failed := false, pc := .done,
                    last := if s.dirty then none else s.sig }
    else none
  | .childFails wrote =>
    if s.pc = .write then
      some { s with stage := if wrote then s.read else s.stage, pc := .done }
    else none
  | .done =>
    if s.pc = .done then
      if s.pending then some { s with pending := false, pc := .sig }
      else some { s with syncing := false, pc := .idle }
    else none

/-- Every state some run of events reaches. -/
inductive Reachable : State C → Prop
  | init (src : C) (stage : Option C) : Reachable (init src stage)
  | step {s s' : State C} (a : Action C) : Reachable s → step s a = some s' → Reachable s'

/-- `TypeOK`: a sync runs exactly when `syncChanged` is past its start. -/
def TypeOK (s : State C) : Prop := s.syncing = true ↔ s.pc ≠ .idle

/-- No timer armed and no sync running. -/
def Quiescent (s : State C) : Prop := s.timer = false ∧ s.pc = .idle

/-- `StageMatchesSource`: once quiescent, the stage holds the source, unless the last sync
failed or the last signature read errored; both print and the next save retries. -/
def StageMatchesSource (s : State C) : Prop :=
  Quiescent s → s.stage = some s.src ∨ s.failed = true ∨ s.printed = true

/-- The inductive strengthening. -/
def Inv (s : State C) : Prop :=
  TypeOK s ∧
  (s.pending = true → s.pc ≠ .idle) ∧
  (s.failed = false → s.last = none ∨ s.stage = s.last) ∧
  (s.pc = .read → s.failed = true ∧ (s.dirty = false → s.sig = some s.src) ∧
    (s.dirty = true → s.timer = true ∨ s.pending = true)) ∧
  (s.pc = .write → s.failed = true ∧
    (s.dirty = false → s.sig = some s.src ∧ s.read = some s.src) ∧
    (s.dirty = true → s.timer = true ∨ s.pending = true)) ∧
  ((s.pc = .done ∨ s.pc = .idle) → s.timer = true ∨ s.pending = true ∨
    s.stage = some s.src ∨ s.failed = true ∨ s.printed = true)

/-! ## Properties -/

omit [DecidableEq C] in
theorem inv_init (src : C) (stage : Option C) : Inv (init src stage) := by
  simp [Inv, TypeOK, init]

theorem inv_step {s s' : State C} {a : Action C} (h : Inv s) (hs : step s a = some s') :
    Inv s' := by
  obtain ⟨src, stage, last, failed, syncing, pending, timer, pc, sig, read, dirty, printed⟩ := s
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := h
  simp only [TypeOK] at h1 h2 h3 h4 h5 h6
  cases a <;> simp only [step] at hs <;> (repeat' split at hs) <;> cases hs <;>
    cases pc <;> simp_all [Inv, TypeOK]
  rcases h5 with ⟨-, h | h⟩ <;> simp [h]

/-- Every reachable state is well typed and, once quiescent, the stage holds the source. -/
theorem stage_matches_source {s : State C} (h : Reachable s) :
    TypeOK s ∧ StageMatchesSource s := by
  have hi : Inv s := by
    induction h with
    | init src stage => exact inv_init src stage
    | step _ _ hs ih => exact inv_step ih hs
  obtain ⟨h1, h2, -, -, -, h6⟩ := hi
  refine ⟨h1, fun ⟨ht, hpc⟩ => ?_⟩
  have hp : s.pending = false := by cases hq : s.pending <;> simp_all
  simpa [ht, hp] using h6 (Or.inr hpc)

/-- Events in order; `none` once one cannot happen. -/
def run (s : State C) (as : List (Action C)) : Option (State C) :=
  as.foldlM step s

/-! ## Findings -/

/-- A save made during the first sync. The watcher once started after it, so the save armed
nothing and the stage kept the old source. Now it syncs again. -/
example :
    (run (init 0 none) [.signature, .childRead, .edit 1, .childSucceeds, .done, .timerFires,
      .signature, .childRead, .childSucceeds, .done]).map (fun s => (s.stage, s.src)) =
      some (some 1, 1) := by decide

/-- A save undone while a sync ran: the child read the save, but the sync recorded the
signature taken before it, so the undo matched it and skipped. Now the sync records none. -/
example :
    (run (init 0 none) [.signature, .edit 1, .childRead, .childSucceeds, .done, .edit 0,
      .timerFires, .signature, .childRead, .childSucceeds, .done]).map
      (fun s => (s.stage, s.src)) = some (some 0, 0) := by decide

end Broods.DevWatch
