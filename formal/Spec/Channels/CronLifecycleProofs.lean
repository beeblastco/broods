import Spec.Channels.CronLifecycle

/-! Proofs about the cron run lifecycle, and the two findings it holds as examples. -/

namespace Spec.Channels.CronLifecycle

/-- A run whose envelope really completed is shown failed only once it has waited its limit on a
person. The sweep treats a missing envelope as dead, which assumes a tracked run has its row. -/
theorem completed_envelope_fails_only_after_limit (l : Limits) (run : Run) (e : Envelope)
    (now : Time) (tracked : run.tracked = true) (ended : e.status = .completed)
    (shown : (deadRunOutcome l run (some e) now).isFailure = true) :
    e.polling = .waitsOnPerson ∧ run.startedAt + l.pausedRunMaxAge < now := by
  cases hp : e.polling
  · by_cases h : run.startedAt + l.pausedRunMaxAge < now
    · exact ⟨rfl, h⟩
    · simp [deadRunOutcome, tracked, ended, hp, h, Verdict.isFailure] at shown
  · by_cases h : e.updatedAt + l.deadRunGrace < now <;>
      simp [deadRunOutcome, tracked, ended, hp, h, Verdict.isFailure] at shown

/-- A run that waits on a person is not failed inside its limit. -/
theorem paused_not_failed_inside_limit (l : Limits) (run : Run) (e : Envelope) (now : Time)
    (tracked : run.tracked = true) (ended : e.status = .completed)
    (waits : e.polling = .waitsOnPerson) (inside : now ≤ run.startedAt + l.pausedRunMaxAge) :
    deadRunOutcome l run (some e) now = .wait := by
  have : ¬ run.startedAt + l.pausedRunMaxAge < now := Nat.not_lt.mpr inside
  simp [deadRunOutcome, tracked, ended, waits, this]

/-- A run still in flight is never ended by the sweep. -/
theorem active_envelope_waits (l : Limits) (run : Run) (e : Envelope) (now : Time)
    (tracked : run.tracked = true) (active : e.status = .active) :
    deadRunOutcome l run (some e) now = .wait := by
  simp [deadRunOutcome, tracked, active]

/-- A paused turn changes nothing, so the run stays `started`. -/
theorem pause_keeps_run_started (run : Run) (s : State) :
    settleCronRun .awaitingApproval run s = s ∧ settleCronRun .awaitingInput run s = s :=
  ⟨rfl, rfl⟩

/-- The first outcome stands: settling a run already finished changes nothing. -/
theorem settle_first_wins (status : RunStatus) (id : Nat) (runs : List Run)
    (finished : ∀ run ∈ runs, run.id = id → run.status ≠ .started) :
    settleRun status id runs = runs := by
  induction runs with
  | nil => rfl
  | cons head tail ih =>
    have hhead := finished head (by simp)
    have htail := ih fun run mem => finished run (by simp [mem])
    simp only [settleRun, List.map_cons] at htail ⊢
    rw [htail]
    by_cases hid : head.id = id
    · simp [hid, hhead hid]
    · simp [hid]

/-- An answer only ever ends a run of its own conversation. -/
theorem answer_settles_own_conversation (conversation : Nat) (run : Run) (runs : List Run)
    (found : newestStarted conversation runs = some run) :
    run.conversation = conversation ∧ run.status = .started := by
  have mem : run ∈ runs.filter fun r => r.conversation == conversation && r.status == .started :=
    List.mem_of_getLast? found
  simpa using (List.mem_filter.mp mem).2

/-- Finding: when a conversation has two started runs, an answer to the older one ends the newer
one, and the run that asked stays open. See `GAPS.md` G505. -/
example :
    let older : Run :=
      { id := 1, job := 1, conversation := 7, startedAt := 0, tracked := true, oneShot := false,
        status := .started }
    let newer : Run := { older with id := 2, job := 2, startedAt := 1 }
    (settleAnsweredRun 7 .completed { runs := [older, newer], jobs := [] }).runs =
      [older, { newer with status := .completed }] := by
  decide

/-- Finding: a job rescheduled to recur while its one-shot run is open is deleted when that run
finishes, because the run keeps the flag it fired with. See `GAPS.md` G506. -/
example :
    let run : Run :=
      { id := 1, job := 1, conversation := 7, startedAt := 0, tracked := true, oneShot := true,
        status := .started }
    let rescheduled := reschedule 1 false { runs := [run], jobs := [{ id := 1, oneShot := true }] }
    rescheduled.jobs = [{ id := 1, oneShot := false }] ∧
      (finishRun .completed run rescheduled).jobs = [] := by
  decide

end Spec.Channels.CronLifecycle
