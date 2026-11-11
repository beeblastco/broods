import Spec.Agent.Theorems
namespace Spec.Agent.Controls

def parent : RunContext := ⟨⟨1, 2, some [9]⟩, true, 3, 4, 5⟩
def original : Item := ⟨.call 7 false, some 8⟩

/-- Ignoring denial allows an explicitly denied call. -/
theorem broken_deny : executes true .allow true = true ∧ executes true .deny true = false := by decide
/-- Installing absent tools breaks policy-only-refuses. -/
theorem broken_install : executes true .allow false ≠ executes false .allow false := by decide
/-- Replacing the account or dropping ancestry fails both child requirements. -/
theorem broken_child : (child parent 8).principal ≠ (⟨99, 8, some []⟩ : Principal) := by decide
/-- Identity projection retains an unresolved call, reasoning and stored ids. -/
theorem broken_projection : resolved [] [] original.part = false ∧ original.storedId ≠ none := by decide
/-- Identity cross-model projection leaks reasoning. -/
theorem broken_reasoning : (⟨.reasoning 9, some 1⟩ : Item) ∉ project false [] [] [⟨.reasoning 9, some 1⟩] := by decide
/-- Forgetting the inherited trigger exposes schedules. -/
theorem broken_cron : scheduleTools true false = true ∧ scheduleTools true (child parent 8).cron = false := by decide
/-- An unlimited run does not consume a positive finite step budget. -/
theorem broken_unlimited : ¬ remaining 0 6 1 < remaining 0 6 0 := by decide
/-- Summing another run's tokens changes the victim's view. -/
theorem broken_meter : runUsage 1 [(2, .compact { input := 4 })] ≠
    ({ usage := { input := 4 } } : Totals) := by decide

/-- Main-claim witnesses include actual execution, delegation, projection, progress and nonzero usage. -/
theorem nonvacuity :
    executes true (gate false { policy := .allow }).1 false = true ∧
    executes true (gate false { policy := .ask }).1 true = true ∧
    (child parent 8).principal.chain = some [9,2] ∧
    project false [7] [] [original] = [⟨.call 7 false, none⟩] ∧
    scheduleTools true false = true ∧
    remaining 30 6 1 < remaining 30 6 0 ∧
    (runUsage 1 [(1, .compact { input := 4 })]).usage.input = 4 := by decide

/-- G300: provider-executed calls need no stored result, disproving the literal pairing claim. -/
theorem provider_exception : project false [] [] [⟨.call 7 true, none⟩] = [⟨.call 7 true, none⟩] := by decide
/-- G301: absent ancestry remains absent on delegation. -/
theorem absent_chain : (child { parent with principal := ⟨1,2,none⟩ } 8).principal.chain = none := by decide
/-- Broken execution ignores the gate entirely. -/
def ungated (_ : Verdict) : Bool := true

theorem ungated_fails : ¬ ∀ v, ungated v = true → v ≠ .deny := by
  intro h
  exact h .deny rfl rfl

/-- Broken delegation chooses a model-supplied account. -/
def unscopedChild (p : RunContext) (account agent : Nat) : RunContext :=
  { child p agent with principal := ⟨account,agent,none⟩ }

theorem unscoped_child_fails : ¬ ∀ p a, (unscopedChild p 99 a).principal.account = p.principal.account := by
  intro h
  have bad := h parent 8
  contradiction

/-- A broken fuel transition never consumes the completed step. -/
abbrev stuckFuel : Spec.System := { fuelSystem 1 with step := fun s _ => (s, []) }

theorem stuck_fuel_fails :
    ¬ Spec.Progress stuckFuel (fun _ => True) (fun _ schedule => schedule.length ≥ 1)
      (fun _ => True) (fun n => n = 0) := by
  intro h
  have bad := h [] trivial trivial [()] (by decide)
  exact absurd bad (by decide)

/-- The progress and leakage systems can actually emit a nonzero work event. -/
theorem progress_nonvacuous : Spec.NonVacuous (fuelSystem 30) (fun _ => True) (fun _ => True) := by
  exact ⟨[()], trivial, (), by decide, trivial⟩

theorem usage_nonvacuous : Spec.NonVacuous recordingSystem (fun _ => True)
    (fun e => e = (1, MeterEvent.compact { input := 4 })) := by
  exact ⟨[(1,.compact { input := 4 })], trivial, (1,.compact { input := 4 }), by decide, rfl⟩

def weakGate (i : GateInput) : Verdict := i.compatibility.getD i.policy

theorem weak_gate_fails : ¬ ∀ i, i.policy = .deny → weakGate i = .deny := by
  intro h
  have bad := h { policy := .deny, compatibility := some .ask } rfl
  exact absurd bad (by decide)

theorem execution_nonvacuous : Spec.NonVacuous executionSystem (fun _ => True) (fun _ => True) := by
  exact ⟨[⟨false, { policy := .allow }, true, false⟩], trivial, (), by decide, trivial⟩

end Spec.Agent.Controls
