/-!
# `broods run`'s stage ticket

`credential()` in `run()`, `packages/broods/src/cli/index.ts`. Each request re-mints the
ticket when less than the margin (60 s) is left by the local clock, then reads whatever ticket
is stored and arrives at the server within `maxDelay` ticks. Requests interleave freely, so
re-mints overlap and finish in any order. Any set of requests, unbounded time.
-/

namespace Broods.StageTicket

/-- The ticket TTL, the re-mint margin, the latency bound of a request (a mint is a round trip
too, so it counts against it) and how far the local clock may lag the server's. -/
structure Params where
  ttl : Nat
  margin : Nat
  maxDelay : Nat
  skew : Nat

/-- What `run()` needs: latency plus clock lag under the margin, and latency under the TTL. -/
def Params.Valid (p : Params) : Prop :=
  p.skew + p.maxDelay < p.margin ∧ p.maxDelay < p.ttl

/-- Where one request is: `credential()`'s check, its `mintStageSession`, the read of
`session?.token`, on the wire, or refused by the server. -/
inductive Pc where
  | idle | minting | read | sent | rejected
  deriving DecidableEq, Repr

/-- A request between its expiry check and the server's answer. -/
def Pc.inFlight : Pc → Bool
  | .idle | .rejected => false
  | _ => true

/-- Server time, the stored `session.expiresAt`, and per request its phase, the ticket it sent
(by its expiry) and the ticks since its check. -/
structure State (R : Type) where
  now : Nat
  session : Nat
  pc : R → Pc
  token : R → Nat
  age : R → Nat

variable {R : Type} [DecidableEq R]

/-- `f` with `r` set to `v`. -/
def update {α : Type} (f : R → α) (r : R) (v : α) : R → α :=
  fun r' => if r' = r then v else f r'

/-- The ticket minted at startup by `mintStageSession`. -/
def init (p : Params) (now : Nat) : State R :=
  ⟨now, now + p.ttl, fun _ => .idle, fun _ => 0, fun _ => 0⟩

/-- One step. `check` is `session.expiresAt - Date.now() < 60_000` with the local clock at
`clock`, at most `skew` behind the server and anywhere ahead. `read` takes the stored ticket,
maybe another request's mint. `tick` advances time within each request's latency bound. -/
inductive Step (p : Params) : State R → State R → Prop
  | check (s : State R) (r : R) (clock : Nat) :
    s.pc r = .idle → s.now ≤ clock + p.skew →
    Step p s { s with
      pc := update s.pc r (if s.session < clock + p.margin then .minting else .read)
      age := update s.age r 0 }
  | mintDone (s : State R) (r : R) :
    s.pc r = .minting →
    Step p s { s with session := s.now + p.ttl, pc := update s.pc r .read }
  | read (s : State R) (r : R) :
    s.pc r = .read →
    Step p s { s with token := update s.token r s.session, pc := update s.pc r .sent }
  | arrive (s : State R) (r : R) :
    s.pc r = .sent →
    Step p s { s with pc := update s.pc r (if s.now < s.token r then .idle else .rejected) }
  | tick (s : State R) :
    (∀ r, (s.pc r).inFlight → s.age r < p.maxDelay) →
    Step p s { s with
      now := s.now + 1
      age := fun r => if (s.pc r).inFlight then s.age r + 1 else 0 }

/-- Every state some interleaving reaches from startup. -/
inductive Reachable (p : Params) : State R → Prop
  | init (now : Nat) : Reachable p (init p now)
  | step {s s' : State R} : Reachable p s → Step p s s' → Reachable p s'

/-- `NoExpiredTicket`: the server never refuses a request's ticket. -/
def NoExpiredTicket (s : State R) : Prop := ∀ r, s.pc r ≠ .rejected

/-- The inductive strengthening: every ticket a request will send outlives its arrival. -/
def Inv (p : Params) (s : State R) : Prop := ∀ r,
  s.pc r ≠ .rejected ∧
  ((s.pc r).inFlight → s.age r ≤ p.maxDelay) ∧
  (s.pc r = .read → s.now + p.maxDelay < s.session + s.age r) ∧
  (s.pc r = .sent → s.now + p.maxDelay < s.token r + s.age r)

/-! ## Properties -/

omit [DecidableEq R] in
theorem inv_init (p : Params) (now : Nat) : Inv p (init p now : State R) := by
  intro r
  simp [init, Pc.inFlight]

theorem inv_step {p : Params} (hp : p.Valid) {s s' : State R} (h : Inv p s)
    (hs : Step p s s') : Inv p s' := by
  obtain ⟨hskew, httl⟩ := hp
  cases hs with
  | check r clock hpc hclock =>
    intro r'
    by_cases hr : r' = r
    · subst hr
      by_cases hm : s.session < clock + p.margin
      · simp [update, hm, Pc.inFlight]
      · simp [update, hm, Pc.inFlight]
        omega
    · simpa [update, hr] using h r'
  | mintDone r hpc =>
    intro r'
    have := h r'
    by_cases hr : r' = r
    · subst hr
      simp_all [update, Pc.inFlight]
      omega
    · simp only [update, hr, ite_false]
      refine ⟨this.1, this.2.1, fun _ => by omega, this.2.2.2⟩
  | read r hpc =>
    intro r'
    have := h r'
    by_cases hr : r' = r
    · subst hr
      simp_all [update, Pc.inFlight]
    · simpa [update, hr] using this
  | arrive r hpc =>
    intro r'
    obtain ⟨h1, h2, h3, h4⟩ := h r'
    by_cases hr : r' = r
    · subst hr
      have hlt : s.now < s.token r' := by
        have := h2 (by simp [hpc, Pc.inFlight])
        have := h4 hpc
        omega
      simp [update, hlt, Pc.inFlight]
    · simpa [update, hr] using And.intro h1 (And.intro h2 (And.intro h3 h4))
  | tick hage =>
    intro r
    obtain ⟨h1, h2, h3, h4⟩ := h r
    have ha := hage r
    cases hpc : s.pc r <;> simp [hpc, Pc.inFlight] at h1 h2 h3 h4 ha ⊢ <;> omega

/-- Under `Valid`, no interleaving of checks, mints, reads, arrivals and ticks ever
sends an expired ticket. -/
theorem no_expired_ticket {p : Params} (hp : p.Valid) {s : State R} (h : Reachable p s) :
    NoExpiredTicket s := by
  have hi : Inv p s := by
    induction h with
    | init now => exact inv_init p now
    | step _ hs ih => exact inv_step hp ih hs
  exact fun r => (hi r).1

/-! ## Witnesses -/

/-- Latency equal to the margin: a request checks with exactly the margin left, skips the
re-mint, and its ticket expires on the wire. `Valid` is needed. -/
example : ∃ s : State Unit, Reachable ⟨5, 3, 3, 0⟩ s ∧ s.pc () = .rejected := by
  have tick : ∀ (s : State Unit), s.pc () = .idle →
      Step ⟨5, 3, 3, 0⟩ s { s with
        now := s.now + 1
        age := fun r => if (s.pc r).inFlight then s.age r + 1 else 0 } := fun s h =>
    .tick s (fun r h' => by cases r; simp [h, Pc.inFlight] at h')
  refine ⟨_, .step (.step (.step (.step (.step (.step (.step (.step
    (.init 0) (tick _ rfl)) (tick _ rfl)) (.check _ () 2 rfl (by decide))) (.read _ () ?_))
    (.tick _ ?_)) (.tick _ ?_)) (.tick _ ?_)) (.arrive _ () ?_), ?_⟩ <;>
    first
    | rfl
    | (intro r; cases r; simp [update, Pc.inFlight])
    | simp [update, init]

end Broods.StageTicket
