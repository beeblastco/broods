import Spec.Channels.Model
namespace Spec.Channels

theorem unverified_step (s : State) (d : Delivery) (h : d.verified = false) :
    (step s (.webhook d)).2 = [] := by simp [step, h]

theorem refs_subset (a r : List Nat) (x : Nat) (h : x ∈ selectRefs a r) : x ∈ a := by
  unfold selectRefs at h
  split at h
  · exact h
  · exact (List.mem_filter.mp h).1

theorem tools_subset (a r : List Nat) (x : Nat) (h : x ∈ allowedTools a r) : x ∈ a :=
  (List.mem_filter.mp h).1

theorem reply_same (s : Source) (t : Bool) : SameConversation s (reply s t) t := by
  simp [SameConversation, reply]

theorem fire_nodup_step (s : State) (i : Input) (h : s.fires.Nodup) :
    (step s i).1.fires.Nodup := by
  cases i with
  | webhook d => simp only [step]; split <;> exact h
  | cron id time ex ac ad st =>
    simp only [step]
    split
    · rename_i guard
      have hn : (id,time) ∉ s.fires := by
        intro hm
        simp [hm] at guard
      exact List.nodup_cons.mpr ⟨hn, h⟩
    · split <;> exact h
  | finish id os term rec ok => simp only [step]; split <;> exact h

theorem fires_nodup_run (s : State) (trace : List Input) (h : s.fires.Nodup) :
    (system.runFrom s trace).1.fires.Nodup := by
  induction trace generalizing s with
  | nil => exact h
  | cons i rest ih => exact ih (step s i).1 (fire_nodup_step s i h)

theorem cron_always : Spec.Always system (fun s => s.fires.Nodup) := by
  rintro s ⟨trace, rfl⟩
  exact fires_nodup_run {} trace (by simp)

theorem duplicate_fire (s : State) (id time : Nat) (h : (id,time) ∈ s.fires)
    (ex ac ad st : Bool) : (step s (.cron id time ex ac ad st)).2 = [] := by
  simp [step, h]

theorem cleanup_attempt (s : State) (id : Nat) (ok : Bool) :
    Effect.removeAttempt id ∈ (step s (.finish id true true true ok)).2 := by
  simp [step]

theorem cleanup_success (s : State) (id : Nat) :
    Effect.removed id ∈ (step s (.finish id true true true true)).2 := by simp [step]

theorem date_roundtrip (d : Calendar) (h : validDate d = true) :
    parseDate (dateWire d) = some d := by cases d; simp_all [parseDate, dateWire]

theorem invalid_date (d : Calendar) (h : validDate d = false) :
    parseDate (dateWire d) = none := by cases d; simp_all [parseDate, dateWire]

theorem probe_effects (s : Unit) (ps : List Probe) :
    (probeSystem.runFrom s ps).2 = probeLeak ps := by
  induction ps generalizing s with
  | nil => rfl
  | cons p ps ih =>
    change [webhookStatus p.get p.stageKnown p.configured p.candidates p.available] ++
      (probeSystem.runFrom s ps).2 = _
    rw [ih]
    rfl

theorem probe_private : Spec.Private probeSystem Unit (List Nat) Nat (fun _ => True)
    (fun _ _ => []) probeLeak (fun _ es => es) := by
  intro p a b _ _ _ h
  change (probeSystem.runFrom probeSystem.init a).2 = (probeSystem.runFrom probeSystem.init b).2
  rw [probe_effects, probe_effects]
  exact h

end Spec.Channels

namespace Spec.Channels

theorem media_no_ticket (present head : Bool) (size : Nat) (metadata body : String) :
    mediaView false present head size metadata body = (404,"","") := by
  simp [mediaView, mediaStatus]

theorem unsigned_no_secrets (get stage configured candidates available : Bool) (s t : Nat) :
    probeLeak [⟨get,stage,configured,candidates,available,s⟩] =
    probeLeak [⟨get,stage,configured,candidates,available,t⟩] := rfl

theorem delivery_nodup_step (s : State) (i : Input) (h : s.deliveries.Nodup) :
    (step s i).1.deliveries.Nodup := by
  cases i with
  | webhook d =>
    simp only [step]
    split
    · rename_i guard
      have hn : (d.account,d.targetAgent,d.event) ∉ s.deliveries := by
        intro hm
        simp [hm] at guard
      exact List.nodup_cons.mpr ⟨hn,h⟩
    · exact h
  | cron id time ex ac ad st => simp only [step]; split; exact h; split <;> exact h
  | finish id os term rec ok => simp only [step]; split <;> exact h

theorem delivery_nodup_run (s : State) (trace : List Input) (h : s.deliveries.Nodup) :
    (system.runFrom s trace).1.deliveries.Nodup := by
  induction trace generalizing s with
  | nil => exact h
  | cons i rest ih => exact ih (step s i).1 (delivery_nodup_step s i h)

end Spec.Channels

namespace Spec.Channels
theorem cron_progress_proof : Spec.Progress system (fun _ => True)
    (fun _ schedule => schedule = [.cron 1 5 true true true true])
    (fun s => s.fires = []) (fun s => s.fires ≠ []) := by
  intro trace _ pending schedule fair
  subst schedule
  simp only [system] at pending
  simp [Spec.System.runFrom, system, step, pending]
end Spec.Channels

namespace Spec.Channels
theorem cleanup_progress_proof : Spec.Progress system (fun _ => True)
    (fun _ schedule => schedule = [.finish 1 true true true true])
    (fun _ => True) (fun s => 1 ∈ s.removed) := by
  intro trace _ _ schedule fair
  subst schedule
  simp [Spec.System.runFrom, system, step]
end Spec.Channels
