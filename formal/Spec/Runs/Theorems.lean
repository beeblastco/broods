import Spec.Runs.Proofs

/-! Local atomic safety claims under A2. Whole-trace progress and privacy remain open (L200). -/
namespace Spec.Runs
/-- Two owners passing the conversation fence at the same instant are identical. -/
theorem owner_exclusive (s : State) (a b : Owner) (now : Nat)
    (ha : fence s a now = true) (hb : fence s b now = true) : a = b :=
  Proofs.fence_unique s a b now ha hb
/-- A stale owner cannot append history at a step boundary. True by definition: the model's
`stepBoundary` checks the fence first (L22). -/
theorem stale_owner_cannot_write (s : State) (o : Owner) (now ttl sender : Nat) (claim : Bool)
    (results : List Nat) (h : fence s o now = false) :
    (step s (.stepBoundary o now ttl claim sender results)).1 = s :=
  Proofs.stale_boundary s o now ttl sender claim results h
/-- A retained idempotency key cannot allocate another envelope, even if the digest changes, unless
the retained row is a finished late-result resume whose result was never stored: that row is
deleted and admitted again (`checkDuplicateAdmission`). -/
theorem duplicate_no_second_run (s : State) (r old : Row) (now ttl : Nat)
    (h : s.rows.find? (fun x => x.key == r.key) = some old) (kept : undelivered s old = false) :
    (step s (.accept r now ttl)).1 = s := Proofs.duplicate s r old now ttl h kept
/-- One envelope for the counterexamples below. -/
def sampleRow (phase : Phase) (retainUntil : Nat) (resume : Bool) : Row :=
  { key := 1, event := 1, digest := 1, mode := .followup, sender := 0, expires := 10, retainUntil := retainUntil, phase := phase, resume := resume }
/-- Without the resume exception the claim is false: a finished resume whose result no fenced write
carried (so it was never stored) is admitted a second time under the same key. -/
theorem duplicate_resume_readmitted :
    (step { rows := [sampleRow .completed 100 true] } (.accept (sampleRow .queued 100 true) 1 100)).2 =
      [.admission "owner"] := by decide
/-- Once a fenced write carried the result's events, here the owner's step boundary, the same resume
is a duplicate: a delivered late result is told once (`undeliveredResume` reads the result row's
`handback`). A boundary that carries no result events stores nothing, and the resume is admitted again
(`boundary_without_result_stores_nothing`). -/
theorem stored_resume_not_readmitted :
    let owned := (step {} (.accept (sampleRow .queued 100 true) 0 100)).1
    let saved := (step owned (.stepBoundary ⟨1, 1⟩ 1 100 false 0 [1])).1
    let settled := (step saved (.settle ⟨1, 1⟩ 2 false [] false)).1
    (step settled (.accept (sampleRow .queued 100 true) 3 100)).2 = [.admission "duplicate"] := by
  decide
/-- A step boundary that carries no result events leaves the resume undelivered. -/
theorem boundary_without_result_stores_nothing :
    let owned := (step {} (.accept (sampleRow .queued 100 true) 0 100)).1
    let saved := (step owned (.stepBoundary ⟨1, 1⟩ 1 100 false 0 [])).1
    let settled := (step saved (.settle ⟨1, 1⟩ 2 false [] false)).1
    let released := (step settled (.releaseOwner ⟨1, 1⟩ false)).1
    (step released (.accept (sampleRow .queued 100 true) 3 100)).2 = [.admission "owner"] := by
  decide
/-- Idempotency keys are unique among the rows of every reachable state, so a key names one
envelope. Deletion at retention can still free a key for a second run (G200). -/
theorem keys_unique : Spec.Always system (fun s => (s.rows.map (·.key)).Nodup) :=
  Proofs.keys_inductive.always
/-- Maintenance keeps every row, under its key, until that row's `statusExpiresAt` has passed;
after that a terminal row is deleted (G200). -/
theorem maintain_keeps_until_retention (s : State) (now : Nat) (r : Row) (hr : r ∈ s.rows)
    (kept : now < r.retainUntil) : ∃ x ∈ (maintain s now).rows, x.key = r.key :=
  Proofs.maintain_keeps s now r hr kept
/-- Maintenance does delete: a terminal row past its retention is gone. -/
theorem maintain_deletes_after_retention :
    (maintain { rows := [sampleRow .completed 5 false] } 6).rows = [] := by decide
/-- D8: rewriting a terminal row requires the continuation of that very run (G3). True by
definition of `asyncWrite`; the code has no such guard yet (L22). -/
theorem finished_async_requires_tied_continuation (run : Nat) (continuation : Option Nat) :
    asyncWrite true run continuation = true ↔ continuation = some run :=
  Proofs.tied_async run continuation
/-- D6, over every input of every reachable state: a queued envelope becomes expired only by an
input whose clock finds no live owner. Intended rule; the code expires by TTL alone (G1). -/
theorem queued_cannot_expire_behind_owner (s : State) (reach : system.Reachable s) (i : Input)
    (r x : Row) (hr : r ∈ s.rows) (hq : r.phase = .queued)
    (hx : x ∈ (step s i).1.rows) (hk : x.key = r.key) (he : x.phase = .expired) :
    ∃ now, i.time = some now ∧ active s now = false ∧ r.expires ≤ now := by
  obtain ⟨now, ht, g⟩ := Proofs.queued_expiry_guarded s i r x (keys_unique s reach) hr hq hx hk he
  simp [mayExpire] at g
  exact ⟨now, ht, g.1.1.2, g.2⟩
/-- D6, over every input of every reachable state: a queued envelope becomes expired only after
recovery was offered: a promotion found the queue empty, or recovery declined the conversation
because its account is not active. A shed dispatch offers nothing: its `releaseOwner` with `requeue`
puts the rows back for the next recovery or arrival. Intended rule; the code expires by TTL alone (G1). -/
theorem recovery_before_queue_expiry (s : State) (reach : system.Reachable s) (i : Input)
    (r x : Row) (hr : r ∈ s.rows) (hq : r.phase = .queued)
    (hx : x ∈ (step s i).1.rows) (hk : x.key = r.key) (he : x.phase = .expired) :
    s.recoveryOffered = true := by
  obtain ⟨now, _, g⟩ := Proofs.queued_expiry_guarded s i r x (keys_unique s reach) hr hq hx hk he
  simp [mayExpire] at g
  exact g.1.2
/-- A conversation whose account is not active mints no owner on any path: from such a state, any
input list that never reactivates the account leaves the owner generation where it was. Admission
and `stopOwner` refuse, recovery skips the account, and `takeNext` clears the owner without
promoting, with or without a settle. -/
theorem inactive_promotes_nothing (s : State) (trace : List Input) (hs : s.accountActive = false)
    (stays : ∀ i ∈ trace, ∀ a, i = .status a → a = false) :
    (system.runFrom s trace).1.generation = s.generation :=
  Proofs.inactive_run s trace hs stays
/-- A shed dispatch loses nothing: in a reachable state, `releaseOwner` with `requeue` by the live
owner keeps every row under its key in the same order, with no key twice; it leaves no owner, no row
still processing under that owner and generation, and each such row queued again unowned
(`requeueRow`). Counters are checked by replay, not modelled. -/
theorem requeue_restores_queue (s : State) (reach : system.Reachable s) (o : Owner)
    (h : s.owner = some o) :
    let t := (step s (.releaseOwner o true)).1
    t.rows.map (·.key) = s.rows.map (·.key) ∧ (t.rows.map (·.key)).Nodup ∧ t.owner = none ∧
      (∀ x ∈ t.rows, ¬ (x.phase = .processing ∧ x.appliedTo = o.event ∧ x.generation = o.generation)) ∧
      ∀ y ∈ s.rows, requeueRow o y ∈ t.rows := by
  obtain ⟨keys, owner, held, back⟩ := Proofs.requeue_release s o h
  exact ⟨keys, keys ▸ keys_unique s reach, owner, held, back⟩
/-- Promotion always begins with the first queued envelope, including collect and dead-owner steer.
The code promotes the first unexpired envelope; the model promotes the head whatever its deadline,
the intended D6 order (G1, L203). -/
theorem queue_fifo_head (s : State) (now ttl : Nat) (r : Row) (rest : List Row)
    (h : queued s = r :: rest) :
    ∃ tail, (promote s now ttl).2 = [.applied (r.event :: tail)] :=
  Proofs.fifo_head s now ttl r rest h
/-- Conversations observe only their routed effects; timing is supplied in their own inputs (L201).
True by construction of `worldStep` (L22). Event ids are client-chosen and unique per deployment,
so in the code one conversation's input can make another's admission a conflict (L201). -/
theorem conversations_private : Spec.Private worldSystem Nat Unit Effect (fun _ => True)
    (fun p t => t.filter (fun i => i.conversation == p)) (fun _ => ()) observations :=
  Proofs.conversation_private
end Spec.Runs
