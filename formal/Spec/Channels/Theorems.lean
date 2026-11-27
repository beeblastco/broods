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
/-- For a Slack source as the parser builds it, whatever a channel record's replyIn says, or with
none set, a reply keeps the incoming app and channel and goes to the thread the message arrived
in or a new thread on the message; it reaches the channel root only from a root message. -/
theorem replies_stay_in_conversation (s : Source) (replyIn : Option Bool) (opens : Bool)
    (parsed : s.thread = parsedThread s.incomingThread s.message opens) :
    SameConversation s (reply s replyIn) := reply_same s replyIn opens parsed

/-- The parser hypothesis is needed: a source whose thread was set elsewhere is kept as is. -/
example : ¬ SameConversation ⟨1, 2, 3, some 7, some 9⟩ (reply ⟨1, 2, 3, some 7, some 9⟩ none) := by
  simp [SameConversation, reply]
/-- Decision D7, not today's code: a model that keys starts by cron and fire time never accepts
one key twice. The code keys a run by a random id, and the fire time falls back to the clock when
the scheduler sends none (G2), so a duplicate POST can start a second run. -/
theorem intended_at_most_one_cron_run : Spec.Always system (fun s => s.fires.Nodup) := cron_always
/-- Decision D7, not today's code (G2): under a durable cron/fire-time key, an already accepted
firing emits no second start. -/
theorem intended_duplicate_cron_never_runs (s : State) (id time : Nat) (h : (id,time) ∈ s.fires)
    (ex ac ad st : Bool) : (step s (.cron id time ex ac ad st)).2 = [] :=
  duplicate_fire s id time h ex ac ad st
/-- After terminal recording succeeds, a one-shot always attempts deletion, even if it fails. -/
theorem one_shot_removal_attempted (s : State) (id : Nat) (ok : Bool) :
    Effect.removeAttempt id ∈ (step s (.finish id true true true ok)).2 := cleanup_attempt s id ok
/-- A successful cleanup input removes the job; no unconditional storage liveness is claimed. -/
theorem one_shot_removed (s : State) (id : Nat) :
    Effect.removed id ∈ (step s (.finish id true true true true)).2 := cleanup_success s id
/-- The intended at(...) parser (G500, not today's code) returns a valid calendar unchanged.
By construction (L22). -/
theorem schedule_calendar_roundtrip (d : Calendar) (h : validDate d = true) :
    parseDate (dateWire d) = some d := date_roundtrip d h
/-- Intent, not today's code (G500): the intended parser rejects invalid calendar fields. The
code normalises them instead (`schedule_at_normalises`). -/
theorem intended_schedule_rejects_invalid_dates (d : Calendar) (h : validDate d = false) :
    parseDate (dateWire d) = none := invalid_date d h
/-- With no timezone, today's code never rejects a day: day n+1 is day n plus 24 hours, whatever
the month, so February 30 is March 2 and day 00 is the last day of the month before. -/
theorem schedule_at_day_carries (d : Calendar) :
    atUtc { d with day := d.day + 1 } = atUtc d + 86400000 := at_day_carries d
/-- With no timezone, today's code accepts February 30 as March 2 and reads year 0050 as 1950
(G500). -/
theorem schedule_at_normalises :
    atUtc ⟨2026, 2, 30, 0, 0, 0⟩ = atUtc ⟨2026, 3, 2, 0, 0, 0⟩ ∧
    atUtc ⟨50, 1, 1, 0, 0, 0⟩ = atUtc ⟨1950, 1, 1, 0, 0, 0⟩ := at_normalises
/-- What a webhook request no agent verifies gets back depends only on its method and query,
whether the account is active, the listing succeeded, the stage exists, an agent configures the
channel and an adapter handles the request; never on any agent's secret. Includes the bare-GET 200
and the 404s. A correct secret does change the status. By construction (L22): `probeStatus` reads
only the coarse facts; the content is the `webhook` replay vectors. -/
theorem unsigned_webhook_privacy : Spec.Private probeSystem Unit (List Coarse) Nat (fun _ => True)
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
