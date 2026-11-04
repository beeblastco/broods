/-!
# Esc mid-turn

`stopTurnOnEscape` in `packages/broods/src/cli/tui.ts`. A lone Esc is held 30 ms: a read starting
`[` or `O` joins it into a key, else it stops a streaming turn or reaches the TUI. Esc plus more in
one read (Alt+key) is a key and passes. `out` is what the TUI saw, `.stop` a `stopTurn()` call,
and `expected` what the keys read so far meant. Any number of keys.
-/

namespace Broods.EscFilter

/-- The byte after Esc in an arrow key: `[` (0x5b, CSI) or `O` (0x4f, SS3). -/
inductive Intro where
  | csi | ss3
  deriving DecidableEq, Repr

/-- One read from stdin. `escKey` and `escArrow` are the same lone Esc byte; `escArrow` is the
first half of an arrow key split across reads, `arrowTail i` its `[A` or `OA`. `arrow i` is a
whole arrow key in one read, `key` any other read (a letter, Ctrl+C, Alt+key) not starting `[` or
`O`. -/
inductive Chunk where
  | escKey | escArrow | arrow (i : Intro) | arrowTail (i : Intro) | key (k : Nat)
  deriving DecidableEq, Repr

/-- What reaches the TUI, or `stop` for `transport.stopTurn()`. `tail i` is a bare `[A` or `OA`. -/
inductive Out where
  | stop | esc | arrow (i : Intro) | tail (i : Intro) | key (k : Nat)
  deriving DecidableEq, Repr

/-- The bytes still in flight, the held Esc and whether it was read mid-turn, the turn. -/
structure State where
  wire : List Chunk
  held : Bool
  heldMidTurn : Bool
  streaming : Bool
  out : List Out
  expected : List Out
  deriving DecidableEq, Repr

def Chunk.isEsc : Chunk → Bool
  | .escKey | .escArrow => true
  | _ => false

/-- A read passed through as is. -/
def Chunk.plain : Chunk → Out
  | .escKey | .escArrow => .esc
  | .arrow i => .arrow i
  | .arrowTail i => .tail i
  | .key k => .key k

/-- What reading `c` means for its key, once the keys before it took effect (a held Esc that
stops the turn makes a second Esc an idle one). A split arrow means its key at its last read. -/
def meaning (s : State) : Chunk → List Out
  | .escKey => [if s.streaming && !(s.held && s.heldMidTurn) then .stop else .esc]
  | .escArrow => []
  | .arrow i | .arrowTail i => [.arrow i]
  | .key k => [.key k]

/-- `settle()`: what a held Esc turns into. -/
def settleOut (midTurn : Bool) : Out := if midTurn then .stop else .esc

/-- `input.emit("data", chunk)` for the chunk at the head of the wire. A held Esc joins an
`arrowTail`, the read that `chunk[0] === 0x5b || chunk[0] === 0x4f` matches. -/
def receive (s : State) : Option State :=
  match s.wire with
  | [] => none
  | c :: rest =>
    let t := { s with wire := rest, expected := s.expected ++ meaning s c }
    match s.held, c with
    | true, .arrowTail i => some { t with out := s.out ++ [.arrow i], held := false }
    | _, _ =>
      let settled := if s.held then [settleOut s.heldMidTurn] else []
      let still := s.streaming && !(s.held && s.heldMidTurn)
      if c.isEsc then
        some { t with
          out := s.out ++ settled, held := true, heldMidTurn := still, streaming := still }
      else some { t with out := s.out ++ settled ++ [c.plain], held := false, streaming := still }

/-- The next read is an arrow's tail, the read `chunk[0] === 0x5b || chunk[0] === 0x4f` joins. -/
def tailNext (s : State) : Bool :=
  match s.wire with
  | .arrowTail _ :: _ => true
  | _ => false

/-- The hold timer. A split arrow's halves arrive within the wait (30 ms), so it never fires
between them; past that, the arrow reaches the TUI as Esc. -/
def timerFires (s : State) : Option State :=
  if s.held && !tailNext s then
    some { s with
      out := s.out ++ [settleOut s.heldMidTurn], streaming := s.streaming && !s.heldMidTurn,
      held := false }
  else none

/-- The reads one key press puts on the wire. -/
inductive Press : List Chunk → Prop where
  | esc : Press [.escKey]
  | arrow (i : Intro) : Press [.arrow i]
  | splitArrow (i : Intro) : Press [.escArrow, .arrowTail i]
  | key (k : Nat) : Press [.key k]

inductive Step : State → State → Prop where
  | press (s : State) (cs : List Chunk) (h : Press cs) : Step s { s with wire := s.wire ++ cs }
  | receive (s t : State) (h : receive s = some t) : Step s t
  | timer (s t : State) (h : timerFires s = some t) : Step s t
  | turnStarts (s : State) (h : s.streaming = false) : Step s { s with streaming := true }
  | turnEnds (s : State) (h : s.streaming = true) : Step s { s with streaming := false }

def Init (s : State) : Prop :=
  s.wire = [] ∧ s.held = false ∧ s.heldMidTurn = false ∧ s.out = [] ∧ s.expected = []

inductive Reachable : State → Prop where
  | init (s : State) : Init s → Reachable s
  | step (s t : State) : Reachable s → Step s t → Reachable t

/-- Every arrow tail on the wire right behind the Esc it completes, as one press puts them. -/
def ok : List Chunk → Bool
  | [] => true
  | .arrowTail _ :: _ => false
  | .escArrow :: .arrowTail _ :: r => ok r
  | .escArrow :: _ => false
  | _ :: r => ok r

theorem ok_append : ∀ a b : List Chunk, ok a = true → ok b = true → ok (a ++ b) = true
  | [], _, _, hb => hb
  | .arrowTail _ :: _, _, ha, _ => by simp [ok] at ha
  | .escArrow :: .arrowTail _ :: r, b, ha, hb => by
    simp only [ok, List.cons_append] at ha ⊢; exact ok_append r b ha hb
  | [.escArrow], _, ha, _ => by simp [ok] at ha
  | .escArrow :: .escKey :: _, _, ha, _ => by simp [ok] at ha
  | .escArrow :: .escArrow :: _, _, ha, _ => by simp [ok] at ha
  | .escArrow :: .arrow _ :: _, _, ha, _ => by simp [ok] at ha
  | .escArrow :: .key _ :: _, _, ha, _ => by simp [ok] at ha
  | .escKey :: r, b, ha, hb => by simp only [ok, List.cons_append] at ha ⊢; exact ok_append r b ha hb
  | .arrow _ :: r, b, ha, hb => by
    simp only [ok, List.cons_append] at ha ⊢; exact ok_append r b ha hb
  | .key _ :: r, b, ha, hb => by simp only [ok, List.cons_append] at ha ⊢; exact ok_append r b ha hb

/-- Nothing held and the TUI saw every meaning; an Esc held that will settle to its meaning;
or the first half of a split arrow held, its tail next. -/
def Inv (s : State) : Prop :=
  (s.held = false ∧ s.expected = s.out ∧ ok s.wire = true) ∨
    (s.held = true ∧ s.expected = s.out ++ [settleOut s.heldMidTurn] ∧ ok s.wire = true) ∨
    (s.held = true ∧ s.expected = s.out ∧ ∃ i r, s.wire = .arrowTail i :: r ∧ ok r = true)

theorem press_ok {cs : List Chunk} (h : Press cs) : ok cs = true := by cases h <;> rfl

theorem inv_step (s t : State) (hs : Inv s) (hst : Step s t) : Inv t := by
  cases hst with
  | press cs hc =>
    have := press_ok hc
    rcases hs with ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩ | ⟨h1, h2, i, r, h3, h4⟩
    · exact .inl ⟨h1, h2, ok_append _ _ h3 this⟩
    · exact .inr (.inl ⟨h1, h2, ok_append _ _ h3 this⟩)
    · exact .inr (.inr ⟨h1, h2, i, r ++ cs, by simp [h3], ok_append _ _ h4 this⟩)
  | receive _ h =>
    obtain ⟨wire, held, mid, streaming, out, expected⟩ := s
    simp only [receive] at h
    rcases hs with ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩ | ⟨h1, h2, i, r, h3, h4⟩ <;> simp only at h1 h2 h3
    rotate_right
    · subst h1 h2 h3; simp at h; subst h; left; simp_all [meaning]
    all_goals
      subst h1 h2
      match wire, h3 with
      | .escKey :: rest, h3 =>
        simp [Chunk.isEsc] at h; subst h; refine .inr (.inl ?_)
        cases mid <;> cases streaming <;> simp_all [ok, meaning, settleOut]
      | .escArrow :: .arrowTail i :: rest, h3 =>
        simp [Chunk.isEsc] at h; subst h
        exact .inr (.inr ⟨rfl, by simp [meaning], i, rest, rfl, by simpa [ok] using h3⟩)
      | .arrow _ :: rest, h3 | .key _ :: rest, h3 =>
        simp [Chunk.isEsc] at h; subst h; left; simp_all [ok, meaning, Chunk.plain]
      | [], _ | .arrowTail _ :: _, h3 | [.escArrow], h3 | .escArrow :: .escKey :: _, h3
      | .escArrow :: .escArrow :: _, h3 | .escArrow :: .arrow _ :: _, h3
      | .escArrow :: .key _ :: _, h3 => simp [ok] at h3 h
  | timer _ h =>
    obtain ⟨wire, held, mid, streaming, out, expected⟩ := s
    simp only [timerFires] at h
    split at h
    · rename_i hg
      simp at h; subst h
      rcases hs with ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩ | ⟨h1, h2, i, r, h3, h4⟩ <;>
        simp_all [Inv, tailNext]
    · simp at h
  | turnStarts h => exact hs
  | turnEnds h => exact hs

theorem inv (s : State) (hs : Reachable s) : Inv s := by
  induction hs with
  | init s h => obtain ⟨h1, h2, _, h4, h5⟩ := h; exact .inl ⟨h2, by simp [h4, h5], by simp [h1, ok]⟩
  | step s t _ hst ih => exact inv_step s t ih hst

/-- The TUI only ever sees what the keys meant: an Esc pressed mid-turn stops the turn and
never quits, an arrow stays one key, order is kept. -/
theorem out_matches_keys (s : State) (hs : Reachable s) : s.out <+: s.expected := by
  rcases inv s hs with ⟨_, h, _⟩ | ⟨_, h, _⟩ | ⟨_, h, _⟩ <;> rw [h] <;> simp

/-! ## Liveness under weak fairness of `receive` and the hold timer -/

/-- A behavior: an initial state, then steps or stutters, with every read eventually handled
and the timer eventually firing whenever each stays enabled. -/
structure Behavior (σ : Nat → State) : Prop where
  init : Init (σ 0)
  next : ∀ n, Step (σ n) (σ (n + 1)) ∨ σ (n + 1) = σ n
  fairReceive : ∀ n, (∀ m ≥ n, (receive (σ m)).isSome) → ∃ m ≥ n, receive (σ m) = some (σ (m + 1))
  fairTimer : ∀ n, (∀ m ≥ n, (timerFires (σ m)).isSome) →
    ∃ m ≥ n, timerFires (σ m) = some (σ (m + 1))

variable {σ : Nat → State}

theorem Behavior.reachable (hb : Behavior σ) : ∀ n, Reachable (σ n)
  | 0 => .init _ hb.init
  | n + 1 => by
    rcases hb.next n with h | h
    · exact .step _ _ (hb.reachable n) h
    · rw [h]; exact hb.reachable n

theorem receive_isSome {s : State} (h : s.wire ≠ []) : (receive s).isSome := by
  cases hw : s.wire with
  | nil => exact absurd hw h
  | cons c r => simp only [receive, hw]; repeat' split
                all_goals rfl

theorem receive_clears_held {s t : State} (hs : Inv s) (hw : tailNext s = true)
    (h : receive s = some t) : t.held = false := by
  obtain ⟨wire, held, mid, streaming, out, expected⟩ := s
  rcases hs with ⟨_, _, h3⟩ | ⟨_, _, h3⟩ | ⟨h1, _, _, _, h3, _⟩
  · rcases wire with _ | ⟨_ | _ | _ | _ | _, _⟩ <;> simp_all [tailNext, ok]
  · rcases wire with _ | ⟨_ | _ | _ | _ | _, _⟩ <;> simp_all [tailNext, ok]
  · simp only at h1 h3; subst h1 h3; simp [receive] at h; subst h; rfl

/-- A held split-arrow Esc stays one, its tail next, until a read is handled. -/
theorem tail_held_step {s t : State} (hs : Inv s) (hh : s.held = true)
    (hw : tailNext s = true) (hst : Step s t) (ht : t.held = true) : tailNext t = true := by
  cases hst with
  | press cs _ =>
    revert hw; unfold tailNext; split <;> simp_all
  | receive _ h => simp [receive_clears_held hs hw h] at ht
  | timer _ h => simp [timerFires, hh, hw] at h
  | turnStarts | turnEnds => exact hw

/-- Every held Esc settles. -/
theorem held_settles (hb : Behavior σ) (n : Nat) : ∃ m ≥ n, (σ m).held = false := by
  refine Classical.byContradiction fun hne => ?_
  have hall : ∀ m ≥ n, (σ m).held = true := fun m hm => by
    cases h : (σ m).held
    · exact absurd ⟨m, hm, h⟩ hne
    · rfl
  by_cases htail : ∃ m ≥ n, tailNext (σ m) = true
  · obtain ⟨m, hm, hw⟩ := htail
    have hkeep : ∀ k ≥ m, tailNext (σ k) = true := by
      intro k hk
      induction hk with
      | refl => exact hw
      | @step k hk ih =>
        rcases hb.next k with h | h
        · exact tail_held_step (inv _ (hb.reachable k)) (hall k (Nat.le_trans hm hk)) ih h
            (hall (k + 1) (Nat.le_trans hm (Nat.le_succ_of_le hk)))
        · rw [h]; exact ih
    obtain ⟨k, hk, hr⟩ := hb.fairReceive m fun k hk =>
      receive_isSome fun h => by simpa [tailNext, h] using hkeep k hk
    have := receive_clears_held (inv _ (hb.reachable k)) (hkeep k hk) hr
    simp [hall (k + 1) (by omega)] at this
  · obtain ⟨k, hk, ht⟩ := hb.fairTimer n fun k hk => by
      have := hall k hk
      have hw : tailNext (σ k) ≠ true := fun h => htail ⟨k, hk, h⟩
      simp [timerFires, this, hw]
    simp only [timerFires] at ht
    split at ht
    · simp at ht; have := hall (k + 1) (by omega); rw [← ht] at this; simp at this
    · simp at ht

/-- Twice the reads in flight, plus one for a held Esc: `receive` and the timer lower it,
a turn starting or ending leaves it. -/
def measure (s : State) : Nat := 2 * s.wire.length + if s.held then 1 else 0

theorem receive_measure {s t : State} (h : receive s = some t) : measure t < measure s := by
  obtain ⟨wire, held, mid, streaming, out, expected⟩ := s
  match wire with
  | [] => simp [receive] at h
  | c :: rest =>
    simp only [receive] at h
    split at h
    · simp at h; subst h; simp [measure]; omega
    · split at h <;> (simp at h; subst h; simp [measure]; split <;> omega)

theorem timer_measure {s t : State} (h : timerFires s = some t) : measure t < measure s := by
  simp only [timerFires] at h
  split at h
  · rename_i hg; simp at h hg; subst h; simp [measure, hg.1]
  · simp at h

theorem quiet_step {s t : State} (h : Step s t)
    (hq : ∀ cs, Press cs → t ≠ { s with wire := s.wire ++ cs }) :
    measure t ≤ measure s ∧ (receive s = some t ∨ timerFires s = some t ∨
      (t.wire = s.wire ∧ t.held = s.held)) := by
  cases h with
  | press cs hc => exact absurd rfl (hq cs hc)
  | receive _ h => exact ⟨Nat.le_of_lt (receive_measure h), .inl h⟩
  | timer _ h => exact ⟨Nat.le_of_lt (timer_measure h), .inr (.inl h)⟩
  | turnStarts | turnEnds => exact ⟨by simp [measure], .inr (.inr ⟨rfl, rfl⟩)⟩

/-- With no more key presses, every read is handled, nothing stays held, and the TUI saw
exactly what the keys meant. -/
theorem drains (hb : Behavior σ) (n : Nat)
    (hquiet : ∀ k ≥ n, ∀ cs, Press cs → σ (k + 1) ≠ { σ k with wire := (σ k).wire ++ cs }) :
    ∃ m ≥ n, (σ m).wire = [] ∧ (σ m).held = false ∧ (σ m).out = (σ m).expected := by
  have hstep : ∀ k ≥ n, measure (σ (k + 1)) ≤ measure (σ k) ∧
      (receive (σ k) = some (σ (k + 1)) ∨ timerFires (σ k) = some (σ (k + 1)) ∨
        ((σ (k + 1)).wire = (σ k).wire ∧ (σ (k + 1)).held = (σ k).held)) := by
    intro k hk
    rcases hb.next k with h | h
    · exact quiet_step h (hquiet k hk)
    · rw [h]; exact ⟨Nat.le_refl _, .inr (.inr ⟨rfl, rfl⟩)⟩
  have hmono : ∀ k ≥ n, ∀ j ≥ k, measure (σ j) ≤ measure (σ k) := by
    intro k hk j hj
    induction hj with
    | refl => exact Nat.le_refl _
    | @step j hj ih => exact Nat.le_trans (hstep j (Nat.le_trans hk hj)).1 ih
  suffices ∀ v, ∀ k ≥ n, measure (σ k) ≤ v →
      ∃ m ≥ k, (σ m).wire = [] ∧ (σ m).held = false from by
    obtain ⟨m, hm, hw, hh⟩ := this _ n (Nat.le_refl _) (Nat.le_refl _)
    refine ⟨m, hm, hw, hh, ?_⟩
    rcases inv _ (hb.reachable m) with ⟨_, h, _⟩ | ⟨h1, _⟩ | ⟨h1, _⟩
    · exact h.symm
    all_goals simp [hh] at h1
  intro v
  induction v using Nat.strongRecOn with
  | ind v ih =>
  intro k hk hv
  by_cases hfire : ∃ j ≥ k, receive (σ j) = some (σ (j + 1)) ∨
      timerFires (σ j) = some (σ (j + 1))
  · obtain ⟨j, hj, hf⟩ := hfire
    have hlt : measure (σ (j + 1)) < measure (σ j) := by
      rcases hf with h | h
      · exact receive_measure h
      · exact timer_measure h
    have := hmono k hk j hj
    obtain ⟨m, hm, h⟩ := ih (measure (σ (j + 1))) (by omega) (j + 1) (by omega) (Nat.le_refl _)
    exact ⟨m, by omega, h⟩
  · have hconst : ∀ j ≥ k, (σ j).wire = (σ k).wire ∧ (σ j).held = (σ k).held := by
      intro j hj
      induction hj with
      | refl => exact ⟨rfl, rfl⟩
      | @step j hj ihj =>
        rcases (hstep j (Nat.le_trans hk hj)).2 with h | h | ⟨h1, h2⟩
        · exact absurd ⟨j, hj, .inl h⟩ hfire
        · exact absurd ⟨j, hj, .inr h⟩ hfire
        · exact ⟨h1.trans ihj.1, h2.trans ihj.2⟩
    by_cases hw : (σ k).wire = []
    · by_cases hh : (σ k).held = false
      · exact ⟨k, Nat.le_refl _, hw, hh⟩
      · obtain ⟨j, hj, ht⟩ := hb.fairTimer k fun j hj => by
          obtain ⟨h1, h2⟩ := hconst j hj
          simp_all [timerFires, tailNext]
        exact absurd ⟨j, hj, .inr ht⟩ hfire
    · obtain ⟨j, hj, hr⟩ := hb.fairReceive k fun j hj =>
        receive_isSome fun h => hw ((hconst j hj).1.symm.trans h)
      exact absurd ⟨j, hj, .inl hr⟩ hfire

end Broods.EscFilter
