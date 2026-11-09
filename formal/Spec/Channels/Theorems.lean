import Spec.Channels.Proofs
import Spec.Channels.CronLifecycleProofs
/-! Safety, progress and declared leakage; assumptions A1/A2/A3 apply at adapter boundaries. -/
namespace Spec.Channels
/-- A delivery which fails authentication never emits a run. -/
theorem unverified_never_runs (s : State) (d : Delivery) (h : d.verified = false) :
    (step s (.webhook d)).2 = [] := unverified_step s d h
/-- A record selects only original workspace references of the selected execution agent. -/
theorem record_never_grants_workspaces (a r : List Nat) (x : Nat)
    (h : x ∈ selectRefs a r) : x ∈ a := refs_subset a r x h
/-- Additional denials cannot create a tool capability for the selected execution agent. -/
theorem record_never_grants_tools (a r : List Nat) (x : Nat)
    (h : x ∈ allowedTools a r) : x ∈ a := tools_subset a r x h
/-- The app, channel and replyIn-selected thread define the incoming reply conversation. -/
theorem replies_stay_in_conversation (s : Source) (t : Bool) :
    SameConversation s (reply s t) t := reply_same s t
/-- D7: every reachable state's accepted cron/fire-time keys are unique; G2 disagrees. -/
theorem at_most_one_cron_run : Spec.Always system (fun s => s.fires.Nodup) := cron_always
/-- An already accepted cron/fire-time cannot emit another start. -/
theorem duplicate_cron_never_runs (s : State) (id time : Nat) (h : (id,time) ∈ s.fires)
    (ex ac ad st : Bool) : (step s (.cron id time ex ac ad st)).2 = [] :=
  duplicate_fire s id time h ex ac ad st
/-- After terminal recording succeeds, a one-shot always attempts deletion, even if it fails. -/
theorem one_shot_removal_attempted (s : State) (id : Nat) (ok : Bool) :
    Effect.removeAttempt id ∈ (step s (.finish id true true true ok)).2 := cleanup_attempt s id ok
/-- A successful cleanup input removes the job; no unconditional storage liveness is claimed. -/
theorem one_shot_removed (s : State) (id : Nat) :
    Effect.removed id ∈ (step s (.finish id true true true true)).2 := cleanup_success s id
/-- Valid calendar field encoding round-trips before timezone conversion. -/
theorem schedule_calendar_roundtrip (d : Calendar) (h : validDate d = true) :
    parseDate (dateWire d) = some d := date_roundtrip d h
/-- Invalid calendar fields are rejected rather than normalised; G500 disagrees. -/
theorem schedule_rejects_invalid_dates (d : Calendar) (h : validDate d = false) :
    parseDate (dateWire d) = none := invalid_date d h
/-- Unsigned probes reveal the declared routing response classes, independently of secrets. -/
theorem unsigned_webhook_privacy : Spec.Private probeSystem Unit (List Nat) Nat (fun _ => True)
    (fun _ _ => []) probeLeak (fun _ es => es) := probe_private
end Spec.Channels

namespace Spec.Channels
/-- Without a valid ticket, media reveals neither object metadata nor bytes. -/
theorem media_without_ticket_private (present head : Bool) (size : Nat) (metadata body : String) :
    mediaView false present head size metadata body = (404,"","") := media_no_ticket present head size metadata body
/-- Accepted delivery keys are unique within the retained deduplication history. -/
theorem delivery_deduplicated (s : State) (trace : List Input) (h : s.deliveries.Nodup) :
    (system.runFrom s trace).1.deliveries.Nodup := delivery_nodup_run s trace h
end Spec.Channels

namespace Spec.Channels
/-- A scheduled active admitted start advances from no firings to a recorded firing. -/
theorem cron_progress : Spec.Progress system (fun _ => True)
    (fun _ schedule => schedule = [.cron 1 5 true true true true])
    (fun s => s.fires = []) (fun s => s.fires ≠ []) := cron_progress_proof
end Spec.Channels

namespace Spec.Channels
/-- Cleanup completes when terminal recording and the external removal operation succeed. -/
theorem one_shot_cleanup_progress : Spec.Progress system (fun _ => True)
    (fun _ schedule => schedule = [.finish 1 true true true true])
    (fun _ => True) (fun s => 1 ∈ s.removed) := cleanup_progress_proof
/-- A cron run whose envelope really completed is shown failed only once it has waited its limit on
a person. -/
theorem cron_completed_fails_only_after_limit (l : CronLifecycle.Limits) (run : CronLifecycle.Run)
    (e : CronLifecycle.Envelope) (now : Nat) (tracked : run.tracked = true)
    (ended : e.status = .completed)
    (shown : (CronLifecycle.deadRunOutcome l run (some e) now).isFailure = true) :
    e.polling = .waitsOnPerson ∧ run.startedAt + l.pausedRunMaxAge < now :=
  CronLifecycle.completed_envelope_fails_only_after_limit l run e now tracked ended shown

/-- A paused cron run is not failed inside its limit. -/
theorem cron_paused_not_failed_inside_limit (l : CronLifecycle.Limits) (run : CronLifecycle.Run)
    (e : CronLifecycle.Envelope) (now : Nat) (tracked : run.tracked = true)
    (ended : e.status = .completed) (waits : e.polling = .waitsOnPerson)
    (inside : now ≤ run.startedAt + l.pausedRunMaxAge) :
    CronLifecycle.deadRunOutcome l run (some e) now = .wait :=
  CronLifecycle.paused_not_failed_inside_limit l run e now tracked ended waits inside

/-- The sweep never ends a cron run whose envelope is still in flight. -/
theorem cron_active_envelope_waits (l : CronLifecycle.Limits) (run : CronLifecycle.Run)
    (e : CronLifecycle.Envelope) (now : Nat) (tracked : run.tracked = true)
    (active : e.status = .active) : CronLifecycle.deadRunOutcome l run (some e) now = .wait :=
  CronLifecycle.active_envelope_waits l run e now tracked active

/-- A paused turn leaves its cron run started. -/
theorem cron_pause_keeps_run_started (run : CronLifecycle.Run) (s : CronLifecycle.State) :
    CronLifecycle.settleCronRun .awaitingApproval run s = s ∧
      CronLifecycle.settleCronRun .awaitingInput run s = s :=
  CronLifecycle.pause_keeps_run_started run s

/-- The first outcome of a cron run stands. -/
theorem cron_settle_first_wins (status : CronLifecycle.RunStatus) (id : Nat)
    (runs : List CronLifecycle.Run) (finished : ∀ run ∈ runs, run.id = id → run.status ≠ .started) :
    CronLifecycle.settleRun status id runs = runs :=
  CronLifecycle.settle_first_wins status id runs finished

/-- An answer only ever ends a started run of its own conversation. -/
theorem cron_answer_settles_own_conversation (conversation : Nat) (run : CronLifecycle.Run)
    (runs : List CronLifecycle.Run) (found : CronLifecycle.newestStarted conversation runs = some run) :
    run.conversation = conversation ∧ run.status = .started :=
  CronLifecycle.answer_settles_own_conversation conversation run runs found

end Spec.Channels
