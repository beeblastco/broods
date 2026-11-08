import Spec.Runs.Model
namespace Spec.Runs.Proofs

theorem fence_unique (s : State) (a b : Owner) (now : Nat)
    (ha : fence s a now = true) (hb : fence s b now = true) : a = b := by
  simp [fence] at ha hb
  exact Option.some.inj (ha.1.symm.trans hb.1)

theorem stale_boundary (s : State) (o : Owner) (now ttl sender : Nat) (claim : Bool)
    (h : fence s o now = false) :
    (step s (.stepBoundary o now ttl claim sender)).1 = s := by
  simp [step, h]

theorem duplicate (s : State) (r old : Row) (now ttl : Nat)
    (h : s.rows.find? (fun x => x.key == r.key) = some old) :
    (step s (.accept r now ttl)).1 = s := by
  simp [step, h]

theorem live_queue (s : State) (now : Nat) (r : Row)
    (live : active s now = true) (queuedRow : r.phase = .queued) :
    (if r.phase == .queued && !active s now && s.recoveryOffered && r.expires ≤ now then
        { r with phase := .expired }
      else if r.phase == .processing && !active s now && r.expires ≤ now then
        { r with phase := .expired } else r) = r := by
  simp [live, queuedRow]

theorem no_recovery_no_expiry (s : State) (now : Nat) (r : Row)
    (notOffered : s.recoveryOffered = false) (queuedRow : r.phase = .queued) :
    (if r.phase == .queued && !active s now && s.recoveryOffered && r.expires ≤ now then
        { r with phase := .expired }
      else if r.phase == .processing && !active s now && r.expires ≤ now then
        { r with phase := .expired } else r) = r := by
  simp [notOffered, queuedRow]

theorem tied_async (run : Nat) (continuation : Option Nat) :
    asyncWrite true run continuation = true ↔ continuation = some run := by
  simp [asyncWrite]

theorem maintain_records (s : State) (now : Nat) :
    (maintain s now).rows.map (·.key) = s.rows.map (·.key) := by
  simp only [maintain, List.map_map]
  congr 1
  funext r
  simp only [Function.comp_apply, maintainRow]
  split <;> first | rfl | (split <;> rfl)


theorem d6_live (s : State) (now : Nat) (r : Row)
    (live : active s now = true) (hq : r.phase = .queued) :
    maintainRow s now r = r := by simp [maintainRow, live, hq]

theorem d6_recovery_chance (s : State) (now : Nat) (r : Row)
    (notOffered : s.recoveryOffered = false) (hq : r.phase = .queued) :
    maintainRow s now r = r := by simp [maintainRow, notOffered, hq]

theorem fifo_head (s : State) (now ttl : Nat) (r : Row) (rest : List Row)
    (h : queued s = r :: rest) :
    ∃ tail, (promote s now ttl).2 = [.applied (r.event :: tail)] := by
  simp only [promote, h]
  split <;> simp

 theorem other_unchanged (s : World) (i : RoutedInput) (p : Nat)
    (h : p ≠ i.conversation) : (worldStep s i).1 p = s p := by
  simp [worldStep, h]

 theorem projected_run (s : World) (trace : List RoutedInput) (p : Nat) :
    observations p (worldSystem.runFrom s trace).2 =
      (system.runFrom (s p) (ownInputs p trace)).2 := by
  induction trace generalizing s with
  | nil => rfl
  | cons i rest ih =>
    simp only [Spec.System.runFrom]
    change observations p ((worldStep s i).2 ++
      (worldSystem.runFrom (worldStep s i).1 rest).2) = _
    have app (a b : List RoutedEffect) : observations p (a ++ b) = observations p a ++ observations p b := by
      simp [observations, List.filter_append, List.map_append]
    rw [app]
    rw [ih]
    by_cases h : p = i.conversation
    · subst p
      simp [ownInputs, worldStep, observations, Spec.System.runFrom, system, List.filter_map, List.map_map, Function.comp_def]
    · have hn : i.conversation ≠ p := Ne.symm h
      simp [ownInputs, worldStep, observations, h, hn]

 theorem conversation_private : Spec.Private worldSystem Nat Unit Effect (fun _ => True)
    (fun p t => t.filter (fun i => i.conversation == p)) (fun _ => ()) observations := by
  intro p a b _ _ own _
  rw [Spec.System.effects, Spec.System.effects, projected_run, projected_run]
  have equal : ownInputs p a = ownInputs p b := by
    simpa [ownInputs] using congrArg (List.map RoutedInput.input) own
  rw [equal]
end Spec.Runs.Proofs
