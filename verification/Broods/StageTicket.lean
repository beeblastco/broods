/-!
# Stage ticket

Model of `broods run`'s stage ticket: `credential()` in `run()` in
`packages/broods/src/cli/index.ts`, which every request's `fetch` awaits for its
`Authorization` header. A request re-mints with `mintStageSession` when the stored
ticket has under `MARGIN` left by the local clock, which runs `SKEW` behind the
server's. Requests interleave freely, so re-mints overlap and land in any order, and a
request sends whatever ticket is stored once its own wait ends. The server stamps
`expiresAt = Date.now() + TTL` in `mintStageSessionTicket`
(`packages/convex/agent/deployments.ts`) and rejects a ticket with `expiresAt <= now`
in `openStageSessionTicket` (`packages/convex/model/stageSessionTicket.ts`). Each
request arrives within `MAXDELAY` of its check, its own mint included.

Ported from `tla/StageTicket.tla` for any number of requests (indexed by `Nat`) and
unbounded time. One change: the server stamps a mint at any time since the request's
check, not only when the response lands, so overlapping mints need
`2 * MAXDELAY < TTL`, where the TLA spec assumed `MAXDELAY < TTL`.
-/

namespace Broods.StageTicket

/-- Where a request is in `credential()` and the server's check. -/
inductive Pc where
  | idle | minting | read | sent | rejected
  deriving DecidableEq, Repr

/-- One request: where it is, the ticket it sent, and ticks since its expiry check. -/
structure Req where
  pc : Pc
  token : Nat
  age : Nat
  deriving DecidableEq, Repr

/-- Server time, the stored `session.expiresAt`, and every request. A ticket is its
expiry, the only field the server's check reads. -/
structure State where
  now : Nat
  session : Nat
  reqs : Nat → Req

variable (TTL MARGIN MAXDELAY SKEW : Nat)

/-- The deployment assumption: latency plus clock skew stays under the 60 s margin, and
two latencies under the 15 minute `STAGE_SESSION_TICKET_TTL_MS`. -/
def Assume : Prop := SKEW + MAXDELAY < MARGIN ∧ 2 * MAXDELAY < TTL

/-- A request between its expiry check and the server's verdict. -/
def Pc.inFlight : Pc → Bool
  | .minting | .read | .sent => true
  | _ => false

/-- Request `r` replaced by `q`. -/
def State.put (s : State) (r : Nat) (q : Req) : State :=
  { s with reqs := fun i => if i = r then q else s.reqs i }

/-- Startup: `run()` mints the first ticket before any request, with the local clock at 0. -/
def init : State := ⟨SKEW, SKEW + TTL, fun _ => ⟨.idle, 0, 0⟩⟩

/-- `credential()`'s check `session.expiresAt - Date.now() < 60_000`, `Date.now()` being
`now - SKEW`. -/
def check (s : State) (r : Nat) : State :=
  s.put r { s.reqs r with
    pc := if s.session - (s.now - SKEW) < MARGIN then .minting else .read, age := 0 }

/-- `session = await mintStageSession(...)`: a fresh ticket the server stamped at `stamp`. -/
def mintDone (s : State) (r stamp : Nat) : State :=
  { s.put r { s.reqs r with pc := .read } with session := stamp + TTL }

/-- `return session?.token`: whatever ticket is stored now, maybe another request's mint. -/
def read (s : State) (r : Nat) : State :=
  s.put r { s.reqs r with pc := .sent, token := s.session }

/-- `openStageSessionTicket` on arrival: `expiresAt <= now` is rejected. -/
def arrive (s : State) (r : Nat) : State :=
  s.put r { s.reqs r with pc := if s.now < (s.reqs r).token then .idle else .rejected }

/-- One tick of server time; every in-flight request ages by it. -/
def tick (s : State) : State :=
  { s with
    now := s.now + 1
    reqs := fun i =>
      { s.reqs i with age := if (s.reqs i).pc.inFlight then (s.reqs i).age + 1 else 0 } }

/-- One TLA action. A mint is stamped between its request's check and its response. Time
passes only while every in-flight request is within its latency budget. -/
inductive Step : State → State → Prop where
  | check (s : State) (r : Nat) :
    (s.reqs r).pc = .idle → Step s (check MARGIN SKEW s r)
  | mintDone (s : State) (r stamp : Nat) :
    (s.reqs r).pc = .minting → s.now ≤ stamp + (s.reqs r).age → stamp ≤ s.now →
    Step s (mintDone TTL s r stamp)
  | read (s : State) (r : Nat) : (s.reqs r).pc = .read → Step s (read s r)
  | arrive (s : State) (r : Nat) : (s.reqs r).pc = .sent → Step s (arrive s r)
  | tick (s : State) :
    (∀ i, (s.reqs i).pc.inFlight → (s.reqs i).age < MAXDELAY) → Step s (tick s)

/-- States reachable from `init` by `Step`s. -/
inductive Reachable : State → Prop where
  | init : Reachable (init TTL SKEW)
  | step {s t : State} : Reachable s → Step TTL MARGIN MAXDELAY SKEW s t → Reachable t

/-- `NoExpiredTicket`: no request is rejected. -/
def NoExpiredTicket (s : State) : Prop := ∀ i, (s.reqs i).pc ≠ .rejected

/-- One request's share of `Inv`. -/
def Req.ok (now session : Nat) (q : Req) : Prop :=
  q.pc ≠ .rejected ∧ (q.pc.inFlight → q.age ≤ MAXDELAY) ∧
    (q.pc = .read → now + MAXDELAY < session + q.age) ∧
    (q.pc = .sent → now + MAXDELAY < q.token + q.age)

/-- The inductive invariant: no request is rejected, each in-flight request is at most
`MAXDELAY` past its check, and the ticket a request will read (`read`) or has sent
(`sent`) outlives its deadline: expiry `> now - age + MAXDELAY`, its check time plus
`MAXDELAY`. -/
def Inv (s : State) : Prop := ∀ i, (s.reqs i).ok MAXDELAY s.now s.session

/-! ## Properties -/

/-- `put` leaves the clock alone. -/
theorem put_now (s : State) (r : Nat) (q : Req) : (s.put r q).now = s.now := rfl

/-- `put` replaces request `r` only. -/
theorem put_reqs (s : State) (r i : Nat) (q : Req) :
    (s.put r q).reqs i = if i = r then q else s.reqs i := rfl

/-- `put` leaves the stored ticket alone. -/
theorem put_session (s : State) (r : Nat) (q : Req) : (s.put r q).session = s.session := rfl

/-- `Inv` holds at startup. -/
theorem inv_init : Inv MAXDELAY (init TTL SKEW) := by
  intro i
  simp [Req.ok, init, Pc.inFlight]

/-- Under `Assume`, every `Step` preserves `Inv`. -/
theorem inv_step {s t : State} (h : Assume TTL MARGIN MAXDELAY SKEW)
    (hs : Inv MAXDELAY s) (st : Step TTL MARGIN MAXDELAY SKEW s t) : Inv MAXDELAY t := by
  obtain ⟨hm, ht⟩ := h
  intro i
  have hi := hs i
  cases st with
  | check r hpc =>
    simp only [check, put_now, put_reqs, put_session]
    by_cases e : i = r
    · subst e
      by_cases hc : s.session - (s.now - SKEW) < MARGIN <;>
        simp [Req.ok, hc, Pc.inFlight] <;> omega
    · simpa [e] using hi
  | mintDone r stamp hpc hlo _ =>
    have hr := (hs r).2.1 (by simp [hpc, Pc.inFlight])
    simp only [mintDone, put_now, put_reqs]
    by_cases e : i = r
    · subst e
      simp [Req.ok, Pc.inFlight]
      omega
    · simp only [e, ite_false]
      obtain ⟨h1, h2, _, h4⟩ := hi
      refine ⟨h1, h2, fun hp => ?_, h4⟩
      have := h2 (by simp [hp, Pc.inFlight])
      omega
  | read r hpc =>
    simp only [read, put_now, put_reqs, put_session]
    by_cases e : i = r
    · subst e
      obtain ⟨_, h2, h3, _⟩ := hi
      simp only [Req.ok, ite_true]
      have := h2 (by simp [hpc, Pc.inFlight])
      have := h3 hpc
      simp [Pc.inFlight]
      omega
    · simpa [e] using hi
  | arrive r hpc =>
    simp only [arrive, put_now, put_reqs, put_session]
    by_cases e : i = r
    · subst e
      obtain ⟨_, h2, _, h4⟩ := hi
      have := h2 (by simp [hpc, Pc.inFlight])
      have := h4 hpc
      have hlt : s.now < (s.reqs i).token := by omega
      simp [Req.ok, hlt, Pc.inFlight]
    · simpa [e] using hi
  | tick hg =>
    obtain ⟨h1, h2, h3, h4⟩ := hi
    have hgi := hg i
    show Req.ok MAXDELAY (s.now + 1) s.session
      { s.reqs i with age := if (s.reqs i).pc.inFlight then (s.reqs i).age + 1 else 0 }
    unfold Req.ok
    cases hp : (s.reqs i).pc <;> simp [hp, Pc.inFlight] at h1 h2 h3 h4 hgi ⊢ <;> omega

/-- Under `Assume`, `Inv` holds in every reachable state. -/
theorem inv_reachable {s : State} (h : Assume TTL MARGIN MAXDELAY SKEW)
    (hr : Reachable TTL MARGIN MAXDELAY SKEW s) : Inv MAXDELAY s := by
  induction hr with
  | init => exact inv_init TTL MAXDELAY SKEW
  | step _ st ih => exact inv_step TTL MARGIN MAXDELAY SKEW h ih st

/-- Under `Assume`, no request ever sends an expired ticket, for any number of requests
and any interleaving of their re-mints. -/
theorem noExpiredTicket {s : State} (h : Assume TTL MARGIN MAXDELAY SKEW)
    (hr : Reachable TTL MARGIN MAXDELAY SKEW s) : NoExpiredTicket s :=
  fun i => (inv_reachable TTL MARGIN MAXDELAY SKEW h hr i).1

/-! ## Assumption is needed, and the property is not vacuous -/

/-- With latency plus skew equal to the margin (`SKEW = MAXDELAY = 1`, `MARGIN = 2`), a
request sends a ticket that expires as it arrives. -/
theorem margin_needed :
    (¬ 1 + 1 < 2 ∧ 2 * 1 < 3) ∧ ∃ s, Reachable 3 2 1 1 s ∧ ¬ NoExpiredTicket s := by
  refine ⟨by decide, _, .step (.step (.step (.step (.step (.step .init
    (.tick _ ?_)) (.tick _ ?_)) (.check _ 0 rfl)) (.read _ 0 rfl)) (.tick _ ?_))
    (.arrive _ 0 rfl), fun h => h 0 (by decide)⟩ <;>
  · intro i
    rcases i with _ | _ | i <;> first | decide | nofun

/-- With `TTL = 2 * MAXDELAY` (so `MAXDELAY < TTL` still holds), an older re-mint landing
after a newer one stores a ticket that expires before the request reading it arrives. -/
theorem ttl_needed :
    (0 + 1 < 2 ∧ 1 < 2 ∧ ¬ 2 * 1 < 2) ∧ ∃ s, Reachable 2 2 1 0 s ∧ ¬ NoExpiredTicket s := by
  refine ⟨by decide, _,
    .step (.step (.step (.step (.step (.step (.step (.step (.step (.step (.step .init
      (.tick _ ?_)) (.check _ 0 rfl)) (.tick _ ?_)) (.check _ 1 rfl))
      (.mintDone _ 1 2 rfl (by decide) (by decide)))
      (.mintDone _ 0 1 rfl (by decide) (by decide)))
      (.read _ 1 rfl)) (.read _ 0 rfl)) (.arrive _ 0 rfl)) (.tick _ ?_)) (.arrive _ 1 rfl),
    fun h => h 1 (by decide)⟩ <;>
  · intro i
    rcases i with _ | _ | i <;> first | decide | nofun

/-- Under `Assume`, a request re-mints its ticket and the server accepts it. -/
theorem request_completes :
    Assume 3 3 1 1 ∧ ∃ s, Reachable 3 3 1 1 s ∧ s.session ≠ (init 3 1).session ∧
      Step 3 3 1 1 s (arrive s 0) ∧ ((arrive s 0).reqs 0).pc = .idle := by
  refine ⟨by unfold Assume; decide, _, .step (.step (.step (.step (.step .init
    (.tick _ ?_)) (.tick _ ?_)) (.check _ 0 rfl))
    (.mintDone _ 0 3 rfl (by decide) (by decide))) (.read _ 0 rfl), by decide,
    .arrive _ 0 rfl, by decide⟩ <;>
  · intro i
    rcases i with _ | _ | i <;> first | decide | nofun

end Broods.StageTicket
