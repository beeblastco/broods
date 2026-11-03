/-!
# Stage ticket

`broods run`'s stage ticket, `credential()` in `run()` (`packages/broods/src/cli/index.ts`).
Each request re-mints when the stored ticket has under `margin` left by a local clock `skew`
behind the server's, then arrives within `maxDelay` ticks. Requests interleave freely, so
re-mints overlap and finish in any order. Any number of requests, over unbounded time.
-/

namespace Broods.StageTicket

/-- Where one request is in `credential()` and its send. -/
inductive Pc where
  | idle | minting | read | sent | rejected
  deriving DecidableEq, Repr

/-- One request: its step, the ticket it sent, and ticks since its expiry check. -/
structure Req where
  pc : Pc
  token : Int
  age : Int

/-- Server time, the stored ticket's server expiry, and every request (`ι` names them). -/
structure State (ι : Type) where
  now : Int
  session : Int
  reqs : ι → Req

/-- The ticket TTL, the re-mint margin, the latency bound and the local clock's lag. -/
structure Params where
  ttl : Int
  margin : Int
  maxDelay : Int
  skew : Int

variable {ι : Type} [DecidableEq ι] (p : Params)

/-- Replaces request `r`. -/
def set (s : State ι) (r : ι) (q : Req) : State ι :=
  { s with reqs := fun r' => if r' = r then q else s.reqs r' }

/-- Startup: `mintStageSession` once, before any request. -/
def Init (s : State ι) : Prop :=
  s.now = p.skew ∧ s.session = s.now + p.ttl ∧ ∀ r, s.reqs r = ⟨.idle, 0, 0⟩

/-- Not waiting on a mint or the server: its latency budget does not run. -/
def settled (q : Req) : Bool := q.pc = .idle || q.pc = .rejected

/-- One step: `credential()`'s expiry check, a finished `mintStageSession`, `session?.token`
read (maybe another request's mint), the server's check on arrival, or a tick of time within
every in-flight request's latency budget (a mint is a round trip too). -/
inductive Step : State ι → State ι → Prop where
  | check (s : State ι) (r : ι) (h : (s.reqs r).pc = .idle) :
    Step s (set s r ⟨if s.session - (s.now - p.skew) < p.margin then .minting else .read,
      (s.reqs r).token, 0⟩)
  | mintDone (s : State ι) (r : ι) (h : (s.reqs r).pc = .minting) :
    Step s { set s r { s.reqs r with pc := .read } with session := s.now + p.ttl }
  | read (s : State ι) (r : ι) (h : (s.reqs r).pc = .read) :
    Step s (set s r { s.reqs r with pc := .sent, token := s.session })
  | arrive (s : State ι) (r : ι) (h : (s.reqs r).pc = .sent) :
    Step s (set s r { s.reqs r with pc := if (s.reqs r).token > s.now then .idle else .rejected })
  | tick (s : State ι) (h : ∀ r, settled (s.reqs r) = true ∨ (s.reqs r).age < p.maxDelay) :
    Step s { s with now := s.now + 1, reqs := fun r =>
      let q := s.reqs r
      { q with age := if settled q then 0 else q.age + 1 } }

inductive Reachable : State ι → Prop where
  | init (s : State ι) : Init p s → Reachable s
  | step (s t : State ι) : Reachable s → Step p s t → Reachable t

/-- What a request knows about the ticket it will send, given server time and stored expiry. -/
def Good (now session : Int) (q : Req) : Prop :=
  0 ≤ q.age ∧ q.age ≤ p.maxDelay ∧ q.pc ≠ .rejected ∧
    (q.pc = .read → session ≥ now - q.age + min (p.margin - p.skew) p.ttl) ∧
    (q.pc = .sent → q.token ≥ now - q.age + min (p.margin - p.skew) p.ttl)

theorem good_inv (hp : p.skew + p.maxDelay < p.margin ∧ p.maxDelay < p.ttl ∧ 0 ≤ p.maxDelay)
    (s : State ι) (hs : Reachable p s) : ∀ r, Good p s.now s.session (s.reqs r) := by
  induction hs with
  | init s h =>
    obtain ⟨_, _, h⟩ := h
    intro r; simp [Good, h r]; omega
  | step s t _ hst ih =>
    intro r
    have hr := ih r
    cases hst with
    | check r0 h0 =>
      by_cases e : r = r0
      · subst e; simp only [Good, set, ite_true] at hr ⊢; split <;> simp <;> omega
      · simp only [Good, set, e, ite_false] at hr ⊢
        revert hr; generalize s.reqs r = q; rcases q with ⟨pc, _, _⟩
        cases pc <;> simp <;> omega
    | mintDone r0 h0 =>
      by_cases e : r = r0
      · subst e; simp [Good, set, h0] at hr ⊢; omega
      · simp only [Good, set, e, ite_false] at hr ⊢
        revert hr; generalize s.reqs r = q; rcases q with ⟨pc, _, _⟩
        cases pc <;> simp <;> omega
    | read r0 h0 =>
      by_cases e : r = r0
      · subst e; simp [Good, set, h0] at hr ⊢; omega
      · simp only [Good, set, e, ite_false] at hr ⊢
        revert hr; generalize s.reqs r = q; rcases q with ⟨pc, _, _⟩
        cases pc <;> simp <;> omega
    | arrive r0 h0 =>
      by_cases e : r = r0
      · subst e; simp [Good, set, h0] at hr ⊢; split <;> simp <;> omega
      · simp only [Good, set, e, ite_false] at hr ⊢
        revert hr; generalize s.reqs r = q; rcases q with ⟨pc, _, _⟩
        cases pc <;> simp <;> omega
    | tick h0 =>
      have hb := h0 r
      simp only [Good, settled] at hr hb ⊢
      revert hr hb; generalize s.reqs r = q; rcases q with ⟨pc, _, _⟩
      cases pc <;> simp <;> omega

/-- No request ever sends an expired ticket, given latency under the margin (and the TTL)
and a local clock within margin minus latency of the server's. -/
theorem no_expired_ticket
    (hp : p.skew + p.maxDelay < p.margin ∧ p.maxDelay < p.ttl ∧ 0 ≤ p.maxDelay)
    (s : State ι) (hs : Reachable p s) (r : ι) : (s.reqs r).pc ≠ .rejected :=
  (good_inv p hp s hs r).2.2.1

end Broods.StageTicket
