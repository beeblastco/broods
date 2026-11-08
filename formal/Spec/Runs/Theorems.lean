import Spec.Runs.Proofs

/-! Local atomic safety claims under A2. Whole-trace progress and privacy remain open (L200). -/
namespace Spec.Runs
/-- Two owners passing the conversation fence at the same instant are identical. -/
theorem owner_exclusive (s : State) (a b : Owner) (now : Nat)
    (ha : fence s a now = true) (hb : fence s b now = true) : a = b :=
  Proofs.fence_unique s a b now ha hb
/-- A stale owner cannot append history at a step boundary. -/
theorem stale_owner_cannot_write (s : State) (o : Owner) (now ttl sender : Nat) (claim : Bool)
    (h : fence s o now = false) :
    (step s (.stepBoundary o now ttl claim sender)).1 = s :=
  Proofs.stale_boundary s o now ttl sender claim h
/-- A retained idempotency key cannot allocate another envelope, even if the digest changes. -/
theorem duplicate_no_second_run (s : State) (r old : Row) (now ttl : Nat)
    (h : s.rows.find? (fun x => x.key == r.key) = some old) :
    (step s (.accept r now ttl)).1 = s := Proofs.duplicate s r old now ttl h
/-- Maintenance retains a record of every envelope key, including expired ones. -/
theorem maintenance_records_not_lost (s : State) (now : Nat) :
    (maintain s now).rows.map (·.key) = s.rows.map (·.key) :=
  Proofs.maintain_records s now
/-- D8: rewriting a terminal row requires the continuation of that very run (G3). -/
theorem finished_async_requires_tied_continuation (run : Nat) (continuation : Option Nat) :
    asyncWrite true run continuation = true ↔ continuation = some run :=
  Proofs.tied_async run continuation
/-- D6: a queued envelope is unchanged by maintenance while its conversation has a live lease. -/
theorem queued_cannot_expire_behind_owner (s : State) (now : Nat) (r : Row)
    (live : active s now = true) (hq : r.phase = .queued) : maintainRow s now r = r :=
  Proofs.d6_live s now r live hq
/-- D6: after lease loss, maintenance cannot expire queued work before recovery is offered. -/
theorem recovery_before_queue_expiry (s : State) (now : Nat) (r : Row)
    (notOffered : s.recoveryOffered = false) (hq : r.phase = .queued) : maintainRow s now r = r :=
  Proofs.d6_recovery_chance s now r notOffered hq
/-- Promotion always begins with the first queued envelope, including collect and dead-owner steer. -/
theorem queue_fifo_head (s : State) (now ttl : Nat) (r : Row) (rest : List Row)
    (h : queued s = r :: rest) :
    ∃ tail, (promote s now ttl).2 = [.applied (r.event :: tail)] :=
  Proofs.fifo_head s now ttl r rest h
/-- Conversations observe only their routed effects; timing is supplied in their own inputs (L201). -/
theorem conversations_private : Spec.Private worldSystem Nat Unit Effect (fun _ => True)
    (fun p t => t.filter (fun i => i.conversation == p)) (fun _ => ()) observations :=
  Proofs.conversation_private
end Spec.Runs
