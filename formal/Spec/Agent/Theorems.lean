import Spec.Agent.Proofs

/-! Safety, bounded-step progress, and run-local leakage; external call termination is not proved. -/
namespace Spec.Agent

/-- A present tool runs only on allow or granted ask (D5). Restates `executes` (L22). -/
theorem tool_execution_gated (present granted : Bool) (v : Verdict) :
    executes present v granted = true → present = true ∧ (v = .allow ∨ v = .ask ∧ granted = true) :=
  Proofs.execution present granted v

/-- Policy denial wins over compatibility, configured approval and the computer waiting rule. -/
theorem deny_dominates (waiting : Bool) (i : GateInput) (h : i.policy = .deny) :
    (gate waiting i).1 = .deny := Proofs.denial waiting i h

/-- A policy never installs a tool that the run did not have. -/
theorem policy_only_refuses (v : Verdict) (granted : Bool) :
    executes false v granted = false := Proofs.absent v granted

/-- A child preserves account and extends an existing chain by exactly its delegating agent. -/
theorem child_principal_extends (p : RunContext) (a : Nat) (chain : List Nat)
    (h : p.principal.chain = some chain) :
    (child p a).principal.account = p.principal.account ∧
    (child p a).principal.chain = some (chain ++ [p.principal.agent]) := Proofs.ancestry p a chain h

/-- Projection keeps only resolved calls, provider-executed calls, or pending approval requests (L300). -/
theorem projection_calls_resolved (same : Bool) (results pending : List Nat) (xs : List Item) (x : Item)
    (h : x ∈ project same results pending xs) : resolved results pending x.part = true :=
  Proofs.projection same results pending xs x h

/-- A different model receives neither reasoning nor stored OpenAI item ids. -/
theorem cross_model_items_private (results pending : List Nat) (xs : List Item) (x : Item)
    (h : x ∈ project false results pending xs) :
    x.storedId = none ∧ ∀ n, x.part ≠ .reasoning n := Proofs.crossModel results pending xs x h

/-- Cron children cannot obtain schedule tools even if their scheduler is enabled. -/
theorem cron_children_no_schedules (p : RunContext) (a : Nat) (enabled : Bool) (h : p.cron = true) :
    scheduleTools enabled (child p a).cron = false := Proofs.cron p a enabled h

/-- Below `maxTurn * slots`, one more step lowers the remaining fuel. Arithmetic on `remaining`, not
tied to the harness's `stopReason` or `maxTurn` (L22, L302). -/
theorem fuel_decreases (maxTurn slots steps : Nat) (h : steps < maxTurn * slots) :
    remaining maxTurn slots (steps+1) < remaining maxTurn slots steps := Proofs.bound maxTurn slots steps h

/-- The metering view of one run depends only on that run's events, with no additional leakage. -/
theorem usage_run_local (run : Nat) (a b : List RunEvent) (h : ownEvents run a = ownEvents run b) :
    runUsage run a = runUsage run b := Proofs.usageLocal run a b h

/-- A counter that loses one per input reaches zero after `budget` inputs. Not tied to the harness's
`stopReason` or `maxTurn`, so it proves no run stops (L22, L302). -/
theorem fuel_exhausts (budget : Nat) :
    Spec.Progress (fuelSystem budget) (fun _ => True)
      (fun n schedule => n ≤ schedule.length) (fun n => 0 < n) (fun n => n = 0) :=
  Proofs.fuel_progress budget

/-- Recording and folding events from other runs adds no information to a run's usage. -/
theorem usage_recording_private :
    Spec.Private recordingSystem Nat Unit Totals (fun _ => True)
      (fun run trace => trace.filter (fun e => e.1 == run)) (fun _ => ())
      (fun run effects => [runUsage run effects]) := Proofs.meter_private

/-- Every emitted execution satisfies `executes` on the same input's gate verdict and `granted` field.
Restates the step (L22): it does not show the grant comes from the original call. -/
theorem tool_execution_sound : Spec.Sound executionSystem (fun _ => True) ExecutionInput executionJustified :=
  Proofs.execution_sound

end Spec.Agent
