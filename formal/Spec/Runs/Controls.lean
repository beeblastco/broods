import Spec.Runs.Theorems
namespace Spec.Runs.Controls

def row (key : Nat) : Row :=
  { key := key, event := key, digest := key, mode := .followup, sender := 0, expires := 10, retainUntil := 1000, phase := .queued }
def owner : Owner := ⟨1, 1⟩
def live : State := (step {} (.accept (row 1) 0 100)).1

/-- A real admission reaches a live fence and records the accepted run. -/
theorem admission_nonvacuous : fence live owner 1 = true ∧ live.rows.length = 1 := by decide
/-- The stale generation is rejected after an actual admission. -/
theorem stale_nonvacuous : fence live ⟨1, 0⟩ 1 = false := by decide
/-- A duplicate reaches the duplicate branch after an actual admission. -/
theorem duplicate_nonvacuous : (step live (.accept (row 1) 1 100)).2 = [.admission "duplicate"] := by decide
/-- D6 has a queued row whose nominal deadline passes while its owner lives. -/
theorem d6_nonvacuous :
    ((maintain (step live (.accept (row 2) 1 100)).1 11).rows[1]).phase = .queued := by decide
/-- The D6 expiry branch is reachable: after the owner leaves and recovery declines the
conversation, maintenance expires the queued envelope past its TTL. -/
theorem d6_expiry_reachable :
    let queuedBehind := (step live (.accept (row 2) 1 100)).1
    let released := (step (step queuedBehind (.settle owner 2 false [] false)).1 (.releaseOwner owner false)).1
    let declined := (step released (.declineRecovery 3)).1
    declined.recoveryOffered = true ∧ queued declined ≠ [] ∧
      ((maintain declined 11).rows.map (·.phase)) = [.completed, .expired] := by decide
/-- Without a decline, the same trace keeps the queued envelope for recovery. -/
theorem d6_needs_offer :
    let queuedBehind := (step live (.accept (row 2) 1 100)).1
    let released := (step (step queuedBehind (.settle owner 2 false [] false)).1 (.releaseOwner owner false)).1
    ((maintain released 11).rows.map (·.phase)) = [.completed, .queued] := by decide
/-- A finished async row permits its own continuation and rejects an unrelated one. -/
theorem d8_nonvacuous : asyncWrite true 1 (some 1) = true ∧ asyncWrite true 1 (some 2) = false := by decide
/-- Dropping the owner-id check lets two different owners pass the broken fence. -/
theorem broken_fence :
    (active live 1 && decide (owner.generation = live.generation)) = true ∧
    (active live 1 && decide (({ event := 2, generation := 1 : Owner }).generation = live.generation)) = true ∧
    owner ≠ ({ event := 2, generation := 1 : Owner }) := by decide
/-- Omitting deduplication appends a second run for one key. -/
theorem broken_duplicate : (live.rows ++ [row 1]).length = 2 := by decide
/-- Expiring by TTL alone loses a queued message behind a live owner (G1). -/
theorem broken_expiry : (row 2).expires ≤ 11 ∧ active live 11 = true := by decide
/-- An unconditional write admits an unrelated overwrite of a finished row (G3). -/
theorem broken_async : true ≠ asyncWrite true 1 (some 2) := by decide
/-- Deleting a row before its retention passes loses the key `maintain_keeps_until_retention` keeps. -/
theorem broken_conservation : ([] : List Row).map (·.key) ≠ [1] := by decide
/-- A real trace emits an accepted-owner response, so rejecting every input cannot satisfy this witness. -/
theorem accepted_nonvacuous : Spec.NonVacuous system (fun _ => True)
    (fun e => e = .admission "owner") := by
  exact ⟨[.accept (row 1) 0 100], trivial, .admission "owner", by decide, rfl⟩
/-- Recovery has a nonempty queue to promote after an actual owner release. -/
theorem recovery_nonvacuous :
    ((step (step (step live (.accept (row 2) 1 100)).1
      (.releaseOwner owner false)).1 (.recoverQueued 11 100)).1.owner) = some ⟨2, 2⟩ := by decide
/-- Request 1 owns, 2 queues, the account is suspended, and 1 hands on with a settle. -/
def suspended : State :=
  (step (step (step {} (.accept (row 1) 0 100)).1 (.accept (row 2) 1 100)).1 (.status false)).1
/-- `takeNext` without its active-account check (the code before it checked the account) promotes 2 in a
suspended account, so `inactive_promotes_nothing` fails for it; the real step holds 2 queued. -/
theorem inactive_takeNext_needs_check :
    (promote (expireQueued (finish suspended owner false) 2) 2 100).1.generation = 2 ∧
      (step suspended (.takeNext owner 2 100 true false)).1.generation = 1 ∧
      (step suspended (.takeNext owner 2 100 true false)).1.owner = none ∧
      queued (step suspended (.takeNext owner 2 100 true false)).1 ≠ [] := by decide
/-- After reactivation, recovery promotes the queue `takeNext` held. -/
theorem inactive_queue_resumes :
    let held := (step suspended (.takeNext owner 2 100 true false)).1
    (step (step held (.status true)).1 (.recoverQueued 3 100)).1.owner = some ⟨2, 2⟩ := by decide
/-- 1 owns, 2 is promoted under ⟨2, 2⟩ and its dispatch is shed. -/
def shed : State :=
  (step (step (step live (.accept (row 2) 1 100)).1 (.takeNext owner 2 100 true false)).1
    (.releaseOwner ⟨2, 2⟩ true)).1
/-- A requeue puts 2 back and recovery promotes it again; a release without `requeue` leaves 2
processing with no owner, where recovery cannot reach it, so `requeue_restores_queue` needs it. -/
theorem requeue_needed :
    queued shed ≠ [] ∧ (step shed (.recoverQueued 3 100)).1.owner = some ⟨2, 3⟩ ∧
      let dropped := (step (step (step live (.accept (row 2) 1 100)).1
        (.takeNext owner 2 100 true false)).1 (.releaseOwner ⟨2, 2⟩ false)).1
      queued dropped = [] ∧ dropped.owner = none ∧
        (dropped.rows.map (·.phase)) = [.completed, .processing] := by decide
/-- Reversing a two-message queue selects the second arrival first. -/
theorem broken_fifo : ([row 2, row 3].reverse.head?).map (·.event) = some 3 := by decide
/-- A live steering prefix cannot jump a queued followup. -/
theorem fifo_nonvacuous :
    (step (step (step live (.accept (row 2) 1 100)).1
      (.accept { row 3 with mode := .steer } 2 100)).1
      (.applySteering owner 3 100 0)).2 = [] := by decide
/-- Another conversation can run without producing any observation for this one. -/
theorem privacy_nonvacuous :
    observations 0 (worldSystem.effects [⟨1, .accept (row 1) 0 100⟩]) = [] ∧
    observations 1 (worldSystem.effects [⟨1, .accept (row 1) 0 100⟩]) = [.admission "owner"] := by decide
/-- Broadcasting all effects exposes an otherwise invisible other-conversation admission. -/
theorem broadcast_breaks_privacy : ¬ Spec.Private worldSystem Nat Unit Effect (fun _ => True)
    (fun p t => t.filter (fun i => i.conversation == p)) (fun _ => ())
    (fun _ effects => effects.map (·.2)) := by
  intro h
  have bad := h 0 [] [⟨1, .accept (row 1) 0 100⟩] trivial trivial rfl rfl
  exact absurd bad (by decide)
end Spec.Runs.Controls
