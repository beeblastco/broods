/-!
# Esc during a streaming turn

`stopTurnOnEscape` in `packages/broods/src/cli/tui.ts`. A lone Esc read is held for
`ESC_SEQUENCE_WAIT_MS`: a read starting with `[` joins it into a key; anything else, or the
timer, settles it, a `stopTurn()` when it was pressed mid-turn, else an Esc for the TUI. Esc
plus more in one read (Alt+key) is a key and passes. Unbounded key presses.
-/

namespace Broods.EscFilter

/-- One read from stdin. `esc` and `escHalf` are the same byte: `escHalf` is the first half of
an arrow split across reads, `tail` its `[A`. `key` is any other read not starting with `[` or
`O`, like `x`, Ctrl+C or Alt+key. -/
inductive Chunk where
  | esc | escHalf | arrow | tail | key (k : Nat)
  deriving DecidableEq, Repr

/-- A key press. -/
inductive Key where
  | esc | arrow | splitArrow | key (k : Nat)
  deriving DecidableEq, Repr

/-- The reads a key press arrives in. -/
def Key.chunks : Key → List Chunk
  | .esc => [.esc]
  | .arrow => [.arrow]
  | .splitArrow => [.escHalf, .tail]
  | .key k => [.key k]

/-- What the TUI sees, or `stop` for a `transport.stopTurn()` call. -/
inductive Out where
  | stop | esc | arrow | tail | key (k : Nat)
  deriving DecidableEq, Repr

/-- A read as the TUI sees it unfiltered. -/
def Chunk.out : Chunk → Out
  | .esc | .escHalf => .esc
  | .arrow => .arrow
  | .tail => .tail
  | .key k => .key k

/-- The reads not yet emitted, whether an Esc is `held` and whether it was pressed mid-turn
(`held.streaming`), `transport.streaming`, what the TUI saw, and what the keys meant. -/
structure State where
  wire : List Chunk
  held : Bool
  heldMidTurn : Bool
  streaming : Bool
  out : List Out
  expected : List Out
  deriving DecidableEq, Repr

/-- A key press, `input.emit("data", chunk)` for the next read, the hold timer, or a turn
starting or ending. -/
inductive Action where
  | press (k : Key) | receive | timer | turnStarts | turnEnds
  deriving DecidableEq, Repr

/-- No read yet, with or without a turn streaming. -/
def init (streaming : Bool) : State := ⟨[], false, false, streaming, [], []⟩

/-- `settle()`: a held Esc pressed mid-turn stops the turn, else reaches the TUI. -/
def settleOut (s : State) : Out := if s.heldMidTurn then .stop else .esc

/-- What reading `c` means once the keys before it took effect: a held Esc that stops the
turn makes a second Esc an idle one. -/
def meaning (s : State) : Chunk → List Out
  | .esc => [if s.streaming && !(s.held && s.heldMidTurn) then .stop else .esc]
  | .escHalf | .arrow => [.arrow]
  | .tail => []
  | .key k => [.key k]

/-- What `input.emit` does with read `c`: a held Esc joins a `[` read; anything else settles
it first, then an Esc is held and the rest passes. -/
def emit (s : State) (c : Chunk) : State :=
  if s.held ∧ c = .tail then { s with out := s.out ++ [.arrow], held := false }
  else
    let settled := if s.held then [settleOut s] else []
    let streaming := s.streaming && !(s.held && s.heldMidTurn)
    match c with
    | .esc | .escHalf =>
      { s with out := s.out ++ settled, held := true, heldMidTurn := streaming,
               streaming := streaming }
    | c => { s with out := s.out ++ settled ++ [c.out], held := false, streaming := streaming }

/-- `input.emit("data", chunk)` for the read at the head of the wire. -/
def receive (s : State) : Option State :=
  match s.wire with
  | [] => none
  | c :: rest => some { emit s c with wire := rest, expected := s.expected ++ meaning s c }

/-- The hold timer firing `settle`. A split arrow's halves arrive within the wait, so it never
fires between them; past that, the arrow reaches the TUI as Esc. -/
def timer (s : State) : Option State :=
  if s.held ∧ s.wire.head? ≠ some .tail then
    some { s with out := s.out ++ [settleOut s], held := false,
                  streaming := s.streaming && !s.heldMidTurn }
  else none

/-- One event, or `none` when it cannot happen now. -/
def step (s : State) : Action → Option State
  | .press k => some { s with wire := s.wire ++ k.chunks }
  | .receive => receive s
  | .timer => timer s
  | .turnStarts => if s.streaming then none else some { s with streaming := true }
  | .turnEnds => if s.streaming then some { s with streaming := false } else none

/-- Every state some run of events reaches. -/
inductive Reachable : State → Prop
  | init (streaming : Bool) : Reachable (init streaming)
  | step {s s' : State} (a : Action) : Reachable s → step s a = some s' → Reachable s'

/-- `OutMatchesKeys`: the TUI only sees what the keys meant. An Esc pressed mid-turn stops the
turn and never quits, an arrow stays one key, order is kept. -/
def OutMatchesKeys (s : State) : Prop := s.out <+: s.expected

/-- Whole key presses, as they arrive on the wire. -/
inductive Keyed : List Chunk → Prop
  | nil : Keyed []
  | esc {w : List Chunk} : Keyed w → Keyed (.esc :: w)
  | arrow {w : List Chunk} : Keyed w → Keyed (.arrow :: w)
  | split {w : List Chunk} : Keyed w → Keyed (.escHalf :: .tail :: w)
  | key {w : List Chunk} (k : Nat) : Keyed w → Keyed (.key k :: w)

/-- What the held Esc will add to `out`: an arrow when its `[A` is next, else its settle. -/
def pend (s : State) : List Out :=
  if s.held then (if s.wire.head? = some .tail then [.arrow] else [settleOut s]) else []

/-- The inductive strengthening: the wire is whole keys, after the `[A` of a held split arrow,
and `out` is `expected` short of the held Esc. -/
def Inv (s : State) : Prop :=
  (Keyed s.wire ∨ (s.held = true ∧ ∃ w, s.wire = .tail :: w ∧ Keyed w)) ∧
  s.expected = s.out ++ pend s

/-! ## Safety -/

theorem keyed_head {w : List Chunk} (h : Keyed w) : w.head? ≠ some .tail := by
  cases h <;> simp

theorem keyed_append {w : List Chunk} (k : Key) (h : Keyed w) : Keyed (w ++ k.chunks) := by
  induction h with
  | nil => cases k <;> simp [Key.chunks] <;> repeat constructor
  | esc _ ih => exact .esc ih
  | arrow _ ih => exact .arrow ih
  | split _ ih => exact .split ih
  | key n _ ih => exact .key n ih

theorem head_append (w : List Chunk) (k : Key) :
    (w ++ k.chunks).head? = some .tail ↔ w.head? = some .tail := by
  cases w <;> cases k <;> simp [Key.chunks]

theorem inv_init (b : Bool) : Inv (init b) := ⟨Or.inl .nil, rfl⟩

theorem inv_step {s s' : State} {a : Action} (h : Inv s) (hs : step s a = some s') :
    Inv s' := by
  obtain ⟨wire, held, hmt, str, out, exp⟩ := s
  obtain ⟨hw, he⟩ := h
  simp only at hw he
  cases a with
  | press k =>
    simp only [step, Option.some.injEq] at hs
    subst hs
    refine ⟨?_, by simpa only [pend, head_append, settleOut] using he⟩
    rcases hw with hk | ⟨hh, w, rfl, hk⟩
    · exact Or.inl (keyed_append k hk)
    · exact Or.inr ⟨hh, w ++ k.chunks, rfl, keyed_append k hk⟩
  | receive =>
    rcases hw with hk | ⟨hh, w, rfl, hk⟩
    · cases hk with
      | nil => simp [step, receive] at hs
      | esc hk | arrow hk | key _ hk =>
        have := keyed_head hk
        cases held <;> cases hmt <;> cases str <;>
          simp_all [step, receive, emit, pend, meaning, settleOut, Chunk.out, Inv] <;> subst hs <;>
          simp_all
      | split hk =>
        cases held <;> cases hmt <;> cases str <;>
          simp_all [step, receive, emit, pend, meaning, settleOut, Inv] <;> subst hs <;> simp_all
    · subst hh
      have := keyed_head hk
      simp_all [step, receive, emit, pend, meaning, Inv]
      subst hs
      simp_all
  | timer =>
    simp only [step, timer] at hs
    split at hs
    · rename_i hc
      simp only [Option.some.injEq] at hs
      subst hs
      obtain ⟨hh, ht⟩ := hc
      refine ⟨Or.inl ?_, by simpa [pend, hh, ht] using he⟩
      rcases hw with hk | ⟨_, w, rfl, _⟩
      · exact hk
      · simp at ht
    · cases hs
  | turnStarts | turnEnds =>
    simp only [step] at hs
    split at hs <;> cases hs <;> exact ⟨hw, by simpa [pend, settleOut] using he⟩

theorem inv_reachable {s : State} (h : Reachable s) : Inv s := by
  induction h with
  | init b => exact inv_init b
  | step _ _ hs ih => exact inv_step ih hs

/-- Every reachable state shows the TUI only what the keys meant, in order. -/
theorem out_matches_keys {s : State} (h : Reachable s) : OutMatchesKeys s :=
  ⟨pend s, (inv_reachable h).2.symm⟩

/-! ## Liveness -/

/-- A behavior of the spec: states from `init`, each step an event or a stutter. -/
def Behavior (σ : Nat → State) : Prop :=
  (∃ b, σ 0 = init b) ∧ ∀ n, σ (n + 1) = σ n ∨ ∃ a, step (σ n) a = some (σ (n + 1))

/-- `WF_vars(a)`, `□(□ENABLED ⟨a⟩ ⇒ ◇⟨a⟩)`: an event enabled in every state from some point
on happens. `⟨a⟩_vars` is `a` for `receive` and `timer`, see `fair_steps_change`. -/
def WeakFair (σ : Nat → State) (a : Action) : Prop :=
  ∀ n, (∀ m, n ≤ m → (step (σ m) a).isSome) → ∃ m, n ≤ m ∧ step (σ m) a = some (σ (m + 1))

/-- The spec's fairness, `WF_vars(Receive) ∧ WF_vars(TimerFires)`. -/
def Fair (σ : Nat → State) : Prop := WeakFair σ .receive ∧ WeakFair σ .timer

/-- Every read handled and no Esc held, so the TUI saw all the keys meant. -/
def Drained (s : State) : Prop := s.wire = [] ∧ s.held = false ∧ s.out = s.expected

/-- Strictly down on `receive` and `timer`, unchanged on a turn starting or ending. -/
def rank (s : State) : Nat := 2 * s.wire.length + if s.held then 1 else 0

theorem receive_wire {s s' : State} (h : receive s = some s') : ∃ c, s.wire = c :: s'.wire := by
  unfold receive at h
  split at h
  · cases h
  · rename_i c rest hw
    cases h
    exact ⟨c, hw⟩

theorem receive_split {s s' : State} (hh : s.held = true) (ht : s.wire.head? = some .tail)
    (h : receive s = some s') : s'.held = false := by
  unfold receive at h
  split at h
  · cases h
  · rename_i c rest hw
    rw [hw] at ht
    simp only [List.head?_cons, Option.some.injEq] at ht
    subst ht
    cases h
    simp [emit, hh]

theorem receive_enabled {s : State} (h : s.wire ≠ []) : (receive s).isSome = true := by
  unfold receive
  split
  · exact absurd ‹_› h
  · rfl

theorem timer_spec {s s' : State} (h : timer s = some s') :
    s.held = true ∧ s.wire.head? ≠ some .tail ∧ s'.held = false ∧ s'.wire = s.wire := by
  unfold timer at h
  split at h
  · rename_i hc
    cases h
    exact ⟨hc.1, hc.2, rfl, rfl⟩
  · cases h

theorem timer_enabled {s : State} (hh : s.held = true) (ht : s.wire.head? ≠ some .tail) :
    (timer s).isSome = true := by
  simp [timer, hh, ht]

theorem quiet_step {s s' : State} {a : Action} (hs : step s a = some s')
    (hr : a ≠ .receive) (ht : a ≠ .timer) :
    s'.held = s.held ∧ (s'.wire = s.wire ∨ ∃ k, a = .press k ∧ s'.wire = s.wire ++ k.chunks) := by
  cases a with
  | press k =>
    simp only [step, Option.some.injEq] at hs
    subst hs
    exact ⟨rfl, .inr ⟨k, rfl, rfl⟩⟩
  | receive => exact absurd rfl hr
  | timer => exact absurd rfl ht
  | turnStarts | turnEnds =>
    simp only [step] at hs
    split at hs <;> cases hs <;> exact ⟨rfl, .inl rfl⟩

theorem fair_steps_change {s s' : State} :
    (step s .receive = some s' → s' ≠ s) ∧ (step s .timer = some s' → s' ≠ s) := by
  refine ⟨fun h he => ?_, fun h he => ?_⟩
  · obtain ⟨c, hw⟩ := receive_wire h
    have := congrArg List.length hw
    rw [he] at this
    simp at this
  · obtain ⟨h1, -, h2, -⟩ := timer_spec h
    rw [he, h1] at h2
    cases h2

theorem rank_step {s s' : State} {a : Action} (hs : step s a = some s')
    (ha : ∀ k, a ≠ .press k) :
    (a = .receive ∨ a = .timer → rank s' < rank s) ∧
    (a ≠ .receive → a ≠ .timer → s'.wire = s.wire ∧ s'.held = s.held) := by
  refine ⟨fun hf => ?_, fun hr ht => ?_⟩
  · rcases hf with rfl | rfl
    · obtain ⟨c, hw⟩ := receive_wire hs
      simp only [rank, hw, List.length_cons]
      split <;> split <;> omega
    · obtain ⟨hh, -, hh', hw⟩ := timer_spec hs
      simp [rank, hh, hh', hw]
  · obtain ⟨hh, hw | ⟨k, rfl, _⟩⟩ := quiet_step hs hr ht
    · exact ⟨hw, hh⟩
    · exact absurd rfl (ha k)

/-- `HeldSettles`, `□(held ⇒ ◇¬held)`, as the stronger `□◇¬held`: under the spec's fairness,
with key presses unbounded, from every point on some state holds no Esc. -/
theorem held_settles {σ : Nat → State} (hb : Behavior σ) (hf : Fair σ) (n : Nat) :
    ∃ m, n ≤ m ∧ (σ m).held = false := by
  apply Classical.byContradiction
  intro hne
  have hall : ∀ m, n ≤ m → (σ m).held = true := fun m hm => by
    cases hh : (σ m).held
    · exact absurd ⟨m, hm, hh⟩ hne
    · rfl
  by_cases hsplit : ∃ m, n ≤ m ∧ (σ m).wire.head? = some .tail
  · obtain ⟨m, hm, htail⟩ := hsplit
    have keep : ∀ d, (σ (m + d)).wire.head? = some .tail := by
      intro d
      induction d with
      | zero => exact htail
      | succ d ih =>
        rw [← Nat.add_assoc]
        rcases hb.2 (m + d) with he | ⟨a, ha⟩
        · rw [he]; exact ih
        · by_cases hr : a = .receive
          · subst hr
            have := receive_split (hall (m + d) (by omega)) ih ha
            rw [hall (m + d + 1) (by omega)] at this
            cases this
          by_cases ht : a = .timer
          · subst ht
            exact absurd ih (timer_spec ha).2.1
          obtain ⟨-, hw | ⟨k, -, hw⟩⟩ := quiet_step ha hr ht
          · rw [hw]; exact ih
          · rw [hw, head_append]; exact ih
    have at_ : ∀ j, m ≤ j → (σ j).wire.head? = some .tail := fun j hj => by
      have := keep (j - m)
      rwa [Nat.add_sub_cancel' hj] at this
    obtain ⟨j, hj, hs⟩ := hf.1 m (fun j hj => receive_enabled (fun hw => by
      have := at_ j hj
      rw [hw] at this
      cases this))
    have := receive_split (hall j (by omega)) (at_ j hj) hs
    rw [hall (j + 1) (by omega)] at this
    cases this
  · obtain ⟨j, hj, hs⟩ := hf.2 n (fun j hj =>
      timer_enabled (hall j hj) (fun ht => hsplit ⟨j, hj, ht⟩))
    have := (timer_spec hs).2.2.1
    rw [hall (j + 1) (by omega)] at this
    cases this

/-- `Drains`: once no more keys are pressed, under the spec's fairness every read is handled,
no Esc stays held, and the TUI saw all the keys meant. -/
theorem drains {σ : Nat → State} (hb : Behavior σ) (hf : Fair σ) (n : Nat)
    (hp : ∀ m, n ≤ m → ∀ k, step (σ m) (.press k) ≠ some (σ (m + 1))) :
    ∃ m, n ≤ m ∧ Drained (σ m) := by
  have reach : ∀ m, Reachable (σ m) := by
    intro m
    induction m with
    | zero => obtain ⟨b, hb0⟩ := hb.1; rw [hb0]; exact .init b
    | succ m ih =>
      rcases hb.2 m with he | ⟨a, ha⟩
      · rw [he]; exact ih
      · exact .step a ih ha
  have notPress : ∀ m, n ≤ m → ∀ a, step (σ m) a = some (σ (m + 1)) → ∀ k, a ≠ .press k :=
    fun m hm a ha k hk => hp m hm k (hk ▸ ha)
  have mono : ∀ m d, n ≤ m → rank (σ (m + d)) ≤ rank (σ m) := by
    intro m d hm
    induction d with
    | zero => exact Nat.le_refl _
    | succ d ih =>
      rw [← Nat.add_assoc]
      rcases hb.2 (m + d) with he | ⟨a, ha⟩
      · rw [he]; exact ih
      · have hr := rank_step ha (notPress _ (by omega) a ha)
        by_cases hft : a = .receive ∨ a = .timer
        · exact Nat.le_trans (Nat.le_of_lt (hr.1 hft)) ih
        · have hq := hr.2 (fun h => hft (.inl h)) (fun h => hft (.inr h))
          simp only [rank, hq.1, hq.2] at ih ⊢
          exact ih
  have descend : ∀ m, n ≤ m → Drained (σ m) ∨ ∃ j, m ≤ j ∧ rank (σ (j + 1)) < rank (σ m) := by
    intro m hm
    by_cases hd : Drained (σ m)
    · exact .inl hd
    apply Or.inr
    have hfair : ∃ j, m ≤ j ∧ (step (σ j) .receive = some (σ (j + 1)) ∨
        step (σ j) .timer = some (σ (j + 1))) := by
      apply Classical.byContradiction
      intro hno
      have same : ∀ d, (σ (m + d)).wire = (σ m).wire ∧ (σ (m + d)).held = (σ m).held := by
        intro d
        induction d with
        | zero => exact ⟨rfl, rfl⟩
        | succ d ih =>
          rw [← Nat.add_assoc]
          rcases hb.2 (m + d) with he | ⟨a, ha⟩
          · rw [he]; exact ih
          · have hr := rank_step ha (notPress _ (by omega) a ha)
            have hq := hr.2 (fun h => hno ⟨m + d, by omega, .inl (h ▸ ha)⟩)
              (fun h => hno ⟨m + d, by omega, .inr (h ▸ ha)⟩)
            exact ⟨hq.1.trans ih.1, hq.2.trans ih.2⟩
      have at_ : ∀ j, m ≤ j → (σ j).wire = (σ m).wire ∧ (σ j).held = (σ m).held := by
        intro j hj
        have := same (j - m)
        rwa [Nat.add_sub_cancel' hj] at this
      cases hw : (σ m).wire with
      | cons c rest =>
        obtain ⟨j, hj, hs⟩ := hf.1 m (fun j hj => receive_enabled (by simp [(at_ j hj).1, hw]))
        exact hno ⟨j, hj, .inl hs⟩
      | nil =>
        have hh : (σ m).held = true := by
          cases hh : (σ m).held
          · have he := (inv_reachable (reach m)).2
            simp [pend, hh] at he
            exact absurd ⟨hw, hh, he.symm⟩ hd
          · rfl
        obtain ⟨j, hj, hs⟩ := hf.2 m (fun j hj =>
          timer_enabled ((at_ j hj).2.trans hh) (by simp [(at_ j hj).1, hw]))
        exact hno ⟨j, hj, .inr hs⟩
    obtain ⟨j, hj, hs⟩ := hfair
    have hle := mono m (j - m) hm
    rw [Nat.add_sub_cancel' hj] at hle
    refine ⟨j, hj, Nat.lt_of_lt_of_le ?_ hle⟩
    rcases hs with hs | hs
    · exact (rank_step hs (notPress j (by omega) _ hs)).1 (.inl rfl)
    · exact (rank_step hs (notPress j (by omega) _ hs)).1 (.inr rfl)
  have go : ∀ v m, n ≤ m → rank (σ m) ≤ v → ∃ m', m ≤ m' ∧ Drained (σ m') := by
    intro v
    induction v with
    | zero =>
      intro m hm hv
      rcases descend m hm with hd | ⟨j, _, hj⟩
      · exact ⟨m, Nat.le_refl _, hd⟩
      · omega
    | succ v ih =>
      intro m hm hv
      rcases descend m hm with hd | ⟨j, hj, hlt⟩
      · exact ⟨m, Nat.le_refl _, hd⟩
      · obtain ⟨m', hm', hd⟩ := ih (j + 1) (by omega) (by omega)
        exact ⟨m', by omega, hd⟩
  exact go (rank (σ n)) n (Nat.le_refl _) (Nat.le_refl _)

/-! ## Witnesses -/

/-- Mid-turn, an arrow split across reads reaches the TUI as one arrow, and a lone Esc only
stops the turn. -/
example :
    (([.press .splitArrow, .receive, .receive, .press .esc, .receive, .timer] : List Action).foldlM
      step (init true)).map (·.out) = some [.arrow, .stop] := by decide

end Broods.EscFilter
