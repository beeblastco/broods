import Spec.Channels.Model
import Spec.Channels.CronLifecycle
namespace Spec.Channels
/-- Removing authentication admits this unsigned delivery. -/
def brokenAuthenticate (_ : Bool) : Bool := true
theorem authentication_control : brokenAuthenticate false = true := by decide
/-- Replacing rather than selecting workspace references grants id 2. -/
theorem workspace_control : 2 ∈ ([2] : List Nat) ∧ 2 ∉ ([1] : List Nat) := by decide
/-- Replacing agent tools by a record's tools grants id 2. -/
theorem tool_control : 2 ∈ ([1,2] : List Nat) ∧ 2 ∉ ([1] : List Nat) := by decide
/-- Routing on a user-supplied channel breaks conversation confinement. -/
theorem reply_control : ¬ SameConversation ⟨1,2,3,none,none⟩ ⟨1,9,3,none,none⟩ false := by
  simp [SameConversation]
/-- G2's random ids permit two entries for the same firing. -/
theorem cron_control : ¬ ([(1,5),(1,5)] : List FireKey).Nodup := by decide
/-- Skipping cleanup cannot produce removal. -/
theorem cleanup_control : Effect.removed 1 ∉ ([] : List Effect) := by decide
/-- Date.UTC's overflow behaviour admits February 30; the intended calendar rejects it. -/
theorem calendar_control : validDate ⟨2026,2,30,0,0,0⟩ = false := by decide
/-- Appending the secret to the response distinguishes two otherwise equal probes. -/
theorem privacy_control : ([401,7] : List Nat) ≠ [401,8] := by decide

def good : Delivery := ⟨true,.message,1,2,3,true,false,true⟩
/-- A verified, admitted message really starts. -/
theorem authentication_nonvacuous : (step {} (.webhook good)).2 = [.run (1,2,3)] := by decide
/-- Narrowing preserves a real attached workspace and an allowed tool. -/
theorem record_nonvacuous : selectRefs [1,2] [2,3] = [2] ∧ allowedTools [1,2] [1] = [2] := by decide
/-- Thread replies open on the original top-level message. -/
theorem reply_nonvacuous : (reply ⟨1,2,3,none,none⟩ true).thread = some 3 := by decide
/-- An active cron really emits a run. -/
theorem cron_nonvacuous : (step {} (.cron 1 5 true true true true)).2 = [.cronRun (1,5)] := by decide
/-- Failed best-effort removal still attempts cleanup. -/
theorem cleanup_nonvacuous : (step {} (.finish 1 true true true false)).2 = [.removeAttempt 1] := by decide
/-- Leap day is an accepted calendar. -/
theorem calendar_nonvacuous : parseDate [2024,2,29,23,59,59] = some ⟨2024,2,29,23,59,59⟩ := by decide
/-- Authentication distinguishes a configured unsigned endpoint. -/
theorem privacy_nonvacuous : webhookStatus false true true true true = 401 := by decide
/-- A bearer ticket with a real object serves bytes; an invalid ticket cannot. -/
theorem media_nonvacuous : mediaStatus true true 100 = 200 ∧ mediaStatus false true 100 = 404 := by decide
end Spec.Channels

namespace Spec.Channels

def brokenRecord (_ : List Nat) (r : List Nat) : List Nat := r

theorem broken_record_fails_subset :
    ¬ (∀ x, x ∈ brokenRecord [1] [2] → x ∈ ([1] : List Nat)) := by
  intro h
  have := h 2 (by decide)
  contradiction

def brokenReply (s : Source) : Source := { s with channel := 9 }

theorem broken_reply_fails_theorem :
    ¬ SameConversation ⟨1,2,3,none,none⟩ (brokenReply ⟨1,2,3,none,none⟩) false := by
  simp [SameConversation, brokenReply]

def brokenMedia (_ : Bool) (body : String) : String := body

theorem broken_media_leaks : brokenMedia false "secret" ≠ brokenMedia false "other" := by decide

def brokenCron (s : State) (key : FireKey) : State := { s with fires := key :: s.fires }

theorem broken_cron_fails_uniqueness :
    ¬ (brokenCron (brokenCron {} (1,5)) (1,5)).fires.Nodup := by decide

/-- Explicit storage failure counterexample behind G501's conditional cleanup theorem. -/
theorem terminal_recording_failure_skips_cleanup :
    (step {} (.finish 1 true true false true)).2 = [] := by decide

/-- A sweep that fails every run breaks the guarantee for a run that really finished. -/
theorem cron_sweep_control :
    ¬ ∀ (run : CronLifecycle.Run) (e : CronLifecycle.Envelope), run.tracked = true → e.status = .completed →
      CronLifecycle.Verdict.failedDead.isFailure = true → e.polling = .waitsOnPerson := by
  intro claim
  have wrong := claim
    { id := 1, job := 1, conversation := 1, startedAt := 0, tracked := true, oneShot := false,
      status := .started }
    { status := .completed, updatedAt := 0, polling := .settled } rfl rfl rfl
  cases wrong

end Spec.Channels
