import Spec.Agent.Model
namespace Spec.Agent.Proofs

theorem denial (waiting : Bool) (i : GateInput) (h : i.policy = .deny) :
    (gate waiting i).1 = .deny := by
  simp [gate, h]

theorem execution (present granted : Bool) (v : Verdict) :
    executes present v granted = true → present = true ∧ (v = .allow ∨ v = .ask ∧ granted = true) := by
  cases v <;> simp [executes]

theorem absent (v : Verdict) (granted : Bool) : executes false v granted = false := by
  simp [executes]

theorem ancestry (p : RunContext) (a : Nat) (chain : List Nat)
    (h : p.principal.chain = some chain) :
    (child p a).principal.account = p.principal.account ∧
    (child p a).principal.chain = some (chain ++ [p.principal.agent]) := by
  simp [child, h]

theorem cron (p : RunContext) (a : Nat) (enabled : Bool) (h : p.cron = true) :
    scheduleTools enabled (child p a).cron = false := by simp [scheduleTools, child, h]

theorem stripped (xs : List Item) (x : Item) (h : x ∈ strip xs) :
    x.storedId = none ∧ ∀ n, x.part ≠ .reasoning n := by
  simp only [strip, List.mem_filterMap] at h
  obtain ⟨a, _, ha⟩ := h
  cases hp : a.part <;> simp [hp] at ha <;> subst x <;> simp

theorem projection (same : Bool) (results pending : List Nat) (xs : List Item) (x : Item)
    (h : x ∈ project same results pending xs) : resolved results pending x.part = true := by
  simp only [project] at h
  split at h
  · exact (List.mem_filter.mp h).2
  · simp only [strip, List.mem_filterMap] at h
    obtain ⟨a, ha, he⟩ := h
    have hr := (List.mem_filter.mp ha).2
    cases hp : a.part <;> simp [hp] at he <;> subst x <;> simpa [hp] using hr

theorem crossModel (results pending : List Nat) (xs : List Item) (x : Item)
    (h : x ∈ project false results pending xs) :
    x.storedId = none ∧ ∀ n, x.part ≠ .reasoning n := by
  exact stripped _ _ (by simpa [project] using h)

theorem bound (maxTurn slots steps : Nat) (h : steps < maxTurn * slots) :
    remaining maxTurn slots (steps+1) < remaining maxTurn slots steps := by
  unfold remaining
  omega

theorem usageLocal (run : Nat) (a b : List RunEvent) (h : ownEvents run a = ownEvents run b) :
    runUsage run a = runUsage run b := by simp [runUsage, h]

theorem fuel_run (budget n : Nat) (trace : List Unit) :
    ((fuelSystem budget).runFrom n trace).1 = n - trace.length := by
  induction trace generalizing n with
  | nil => rfl
  | cons i rest ih =>
    change ((fuelSystem budget).runFrom (n-1) rest).1 = n - (i :: rest).length
    rw [ih]
    simp only [List.length_cons]
    omega

theorem fuel_progress (budget : Nat) :
    Spec.Progress (fuelSystem budget) (fun _ => True)
      (fun n schedule => n ≤ schedule.length) (fun n => 0 < n) (fun n => n = 0) := by
  intro trace _ _ schedule enough
  change ((fuelSystem budget).runFrom ((fuelSystem budget).final trace) schedule).1 = 0
  rw [fuel_run]
  change (fuelSystem budget).final trace ≤ schedule.length at enough
  exact Nat.sub_eq_zero_of_le enough

theorem recorded (s : Unit) (trace : List RunEvent) :
    (recordingSystem.runFrom s trace).2 = trace := by
  induction trace generalizing s with
  | nil => rfl
  | cons e rest ih =>
    change [e] ++ (recordingSystem.runFrom () rest).2 = e :: rest
    rw [ih]
    rfl

theorem meter_private :
    Spec.Private recordingSystem Nat Unit Totals (fun _ => True)
      (fun run trace => trace.filter (fun e => e.1 == run)) (fun _ => ())
      (fun run effects => [runUsage run effects]) := by
  intro run a b _ _ same _
  change [runUsage run (recordingSystem.runFrom () a).2] = [runUsage run (recordingSystem.runFrom () b).2]
  rw [recorded, recorded]
  apply congrArg (fun t => [t])
  apply usageLocal
  exact congrArg (List.map Prod.snd) same

theorem execution_sound : Spec.Sound executionSystem (fun _ => True) ExecutionInput executionJustified := by
  refine ⟨fun trace _ => trace.reverse.head?, ?_⟩
  intro trace i _ e he
  change e ∈ (if executes i.present (gate i.waiting i.call).1 i.granted then [()] else []) at he
  split at he
  · rename_i allowed
    exact ⟨i, by simp, allowed⟩
  · simp at he

end Spec.Agent.Proofs
