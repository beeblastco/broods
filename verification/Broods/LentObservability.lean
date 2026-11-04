/-!
# The dock agent reading logs

Logs carry end users' chats, so text in them may try to steer an agent that reads them. The dock
agent holds a login lent by the signed-in owner or admin (`agentDock.session`,
`packages/convex/agentDock.ts`). `mintObservabilityByLogin` (`packages/convex/cli/stages.ts`) trades
it for a `bdob_` ticket and, in the same mutation, marks its conversation as having read logs.
`observedLoginRefusal` (`packages/convex/config/routes/shared.ts`) then refuses every write by a login
of that conversation, using `conversationObserved` (`packages/convex/cli/auth.ts`), so a login
re-minted mid-conversation inherits it. The mark has its own table, so pruning logins keeps it. `observabilityTicketExpiry`
(`packages/convex/model/observabilityTicket.ts`) bounds the ticket, and `observabilityTicketScope`
(`apps/core/src/harness/integrations.ts`) is the one place that accepts it, for the log socket alone.

Each mutation is serializable, so each is one step. The model omits the signature (`openSignedTicket`
under its own key context, tested in `observabilityTicket.test.ts`) and what the agent does with what
it read: these theorems bound what its credentials can do, not what the model says. An answer's text
and links stay outside them, and the agent's web tools are removed in its own repo.
-/

namespace Broods.LentObservability

def TTL : Nat := 300000

/-- A login lent to the agent, for one dock conversation. -/
structure Login where
  id : Nat
  conv : Nat
  expiresAt : Nat
  deriving DecidableEq

/-- A `bdob_` ticket, with the conversation and login expiry it was minted from. -/
structure Ticket where
  stage : Nat
  conv : Nat
  mintedAt : Nat
  loginExpiresAt : Nat
  expiresAt : Nat
  deriving DecidableEq

structure State where
  now : Nat
  /-- The signed-in user is still an owner or admin (`resolveActiveCliToken`). -/
  member : Bool
  logins : List Login
  /-- `conversationObserved`: any login of this conversation has opened logs. -/
  observed : Nat → Bool
  tickets : List Ticket
  /-- Account writes made by each conversation's logins. -/
  writes : Nat → Nat

/-- `observabilityTicketExpiry`. -/
def ticketExpiry (now loginExpiresAt : Nat) : Nat :=
  min (now + TTL) loginExpiresAt

/-- `resolveActiveCliToken`: lent to this state, unexpired, and its user still a member. -/
def Live (s : State) (l : Login) : Prop :=
  l ∈ s.logins ∧ s.now < l.expiresAt ∧ s.member = true

inductive Step : State → State → Prop where
  | tick (s : State) : Step s { s with now := s.now + 1 }
  | demote (s : State) : Step s { s with member := false }
  /-- `agentDock.session`: owners and admins only. -/
  | lend (s : State) (l : Login) (h : s.member = true) :
      Step s { s with logins := l :: s.logins }
  /-- `mintObservabilityByLogin`: the mark and the ticket land in one mutation. -/
  | openLogs (s : State) (l : Login) (stage : Nat) (h : Live s l) :
      Step s
        { s with
          observed := fun c => c == l.conv || s.observed c
          tickets :=
            ⟨stage, l.conv, s.now, l.expiresAt, ticketExpiry s.now l.expiresAt⟩ :: s.tickets }
  /-- `pruneExpiredTokens` deletes logins. The mark lives in its own table, so it stays. -/
  | prune (s : State) (keep : Login → Bool) :
      Step s { s with logins := s.logins.filter keep }
  /-- A write through the config plane, past `observedLoginRefusal`. -/
  | write (s : State) (l : Login) (h : Live s l) (clean : s.observed l.conv = false) :
      Step s
        { s with writes := fun c => if c = l.conv then s.writes c + 1 else s.writes c }

/-- Any number of steps. -/
inductive Steps : State → State → Prop where
  | refl (s : State) : Steps s s
  | step {a b c : State} : Step a b → Steps b c → Steps a c

def init : State :=
  ⟨0, true, [], fun _ => false, [], fun _ => 0⟩

def Reachable (s : State) : Prop := Steps init s

/-- What a route takes. Every route but the stage's log socket refuses a ticket. -/
inductive Route where
  | logs (stage : Nat)
  | accountWrite
  | accountRead
  | run
  | sandbox
  | terminal
  deriving DecidableEq

/-- `observabilityTicketScope`, with core's auth answering null to `bdob_` everywhere else. -/
def ticketOpens (now : Nat) (t : Ticket) : Route → Bool
  | .logs stage => stage == t.stage && decide (now < t.expiresAt)
  | _ => false

/-- A ticket opens its own stage's logs while unexpired, and nothing else. -/
theorem ticket_opens_only_its_logs {now : Nat} {t : Ticket} {r : Route}
    (h : ticketOpens now t r = true) : r = .logs t.stage ∧ now < t.expiresAt := by
  cases r <;> simp [ticketOpens] at h
  exact ⟨by simp [h.1], h.2⟩

/-- A ticket cannot write, start a run, or reach a sandbox or terminal. -/
theorem ticket_cannot_act (now : Nat) (t : Ticket) :
    ticketOpens now t .accountWrite = false ∧ ticketOpens now t .accountRead = false ∧
      ticketOpens now t .run = false ∧ ticketOpens now t .sandbox = false ∧
      ticketOpens now t .terminal = false := by
  simp [ticketOpens]

/-- Having read logs is never forgotten by any step. -/
theorem observed_persists {s s' : State} {c : Nat} (hs : Step s s') (ho : s.observed c = true) :
    s'.observed c = true := by
  cases hs <;> simp_all

/-- Once a conversation has read logs, no step adds a write by any of its logins. -/
theorem no_write_after_logs {s s' : State} {c : Nat} (hs : Step s s')
    (ho : s.observed c = true) : s'.writes c = s.writes c := by
  cases hs with
  | write l h clean =>
    by_cases hc : c = l.conv
    · subst hc; simp_all
    · simp [hc]
  | _ => simp_all

/-- Over any run, however many logins are re-minted, that conversation's writes stay frozen. -/
theorem writes_frozen_after_logs {s s' : State} {c : Nat} (hs : Steps s s')
    (ho : s.observed c = true) : s'.writes c = s.writes c := by
  induction hs with
  | refl => rfl
  | step hab _ ih =>
    rw [ih (observed_persists hab ho), no_write_after_logs hab ho]

/-- A login re-minted for that conversation later still cannot write. -/
theorem remint_stays_read_only {s s' : State} {l : Login} (hs : Steps s s')
    (ho : s.observed l.conv = true) : s'.observed l.conv = true := by
  induction hs with
  | refl => exact ho
  | step hab _ ih => exact ih (observed_persists hab ho)

/-- A ticket's expiry is within the login's and within the TTL. -/
theorem ticketExpiry_bounded (now loginExpiresAt : Nat) :
    ticketExpiry now loginExpiresAt ≤ loginExpiresAt ∧
      ticketExpiry now loginExpiresAt ≤ now + TTL := by
  simp [ticketExpiry, Nat.min_le_left, Nat.min_le_right]

def TicketsSound (s : State) : Prop :=
  ∀ t ∈ s.tickets,
    t.expiresAt ≤ t.loginExpiresAt ∧ t.expiresAt ≤ t.mintedAt + TTL ∧ s.observed t.conv = true

theorem ticketsSound_step {s s' : State} (hs : Step s s') (h : TicketsSound s) :
    TicketsSound s' := by
  intro t ht
  cases hs with
  | openLogs l stage hl =>
    simp only [List.mem_cons] at ht
    rcases ht with rfl | ht
    · exact ⟨(ticketExpiry_bounded _ _).1, (ticketExpiry_bounded _ _).2, by simp⟩
    · have := h t ht
      exact ⟨this.1, this.2.1, by simp [this.2.2]⟩
  | lend l hm => exact h t ht
  | prune keep => exact h t ht
  | tick => exact h t ht
  | demote => exact h t ht
  | write l hl clean => exact h t ht

theorem ticketsSound_steps {s s' : State} (hs : Steps s s') (h : TicketsSound s) :
    TicketsSound s' := by
  induction hs with
  | refl => exact h
  | step hab _ ih => exact ih (ticketsSound_step hab h)

/-- In every reachable state, each ticket outlives neither its login nor the TTL, and its
conversation is already read-only: no ticket ever exists beside a login that can write. -/
theorem tickets_sound {s : State} (hs : Reachable s) : TicketsSound s :=
  ticketsSound_steps hs (by intro t ht; simp [init] at ht)

/-- Membership never comes back on its own, so a demoted user's lent logins stay dead. -/
theorem demoted_stays_out {s s' : State} (hs : Steps s s') (hm : s.member = false) :
    s'.member = false := by
  induction hs with
  | refl => exact hm
  | step hab _ ih =>
    apply ih
    cases hab <;> simp_all

theorem demoted_step {a b : State} (hs : Step a b) (hm : a.member = false) :
    b.member = false ∧ b.tickets = a.tickets ∧ b.writes = a.writes := by
  cases hs with
  | openLogs l stage hl => simp [Live, hm] at hl
  | write l hl clean => simp [Live, hm] at hl
  | lend l h => simp [hm] at h
  | prune keep => exact ⟨hm, rfl, rfl⟩
  | tick => exact ⟨hm, rfl, rfl⟩
  | demote => exact ⟨rfl, rfl, rfl⟩

/-- Once the user is demoted, no ticket is minted and no write lands. -/
theorem demoted_cannot_act {s s' : State} (hs : Steps s s') (hm : s.member = false) :
    s'.tickets = s.tickets ∧ s'.writes = s.writes := by
  induction hs with
  | refl => exact ⟨rfl, rfl⟩
  | step hab _ ih =>
    have h := demoted_step hab hm
    have hi := ih h.1
    exact ⟨hi.1.trans h.2.1, hi.2.trans h.2.2⟩

/-! A clean conversation can still act, so the hypotheses above can hold and do not hold always. -/

def alice : Login := ⟨1, 7, 100⟩
def lent : State := { init with logins := [alice] }

example : Reachable lent := .step (.lend init alice rfl) (.refl _)

example : Step lent { lent with writes := fun c => if c = alice.conv then 1 else 0 } :=
  .write lent alice ⟨by simp [lent, alice], by simp [lent, alice, init], rfl⟩ rfl

/-! Broken variants these properties catch. -/

/-- Keying the mark by login instead of conversation: a re-minted login could write again. -/
def observedByLogin (observedIds : List Nat) (l : Login) : Bool := observedIds.contains l.id

example : observedByLogin [alice.id] { alice with id := 2 } = false := by decide

/-- Keeping the mark on the login row: pruning that row would forget the conversation read logs. -/
def observedOnLoginRows (observedLogins : List Login) (conv : Nat) : Bool :=
  observedLogins.any (·.conv == conv)

example : observedOnLoginRows [alice] alice.conv = true := by decide
example : observedOnLoginRows ([alice].filter fun _ => false) alice.conv = false := by decide

/-- A ticket stamped `now + TTL` alone outlives a login with less time left. -/
example : ¬ 10 + TTL ≤ 100 := by decide
example : ticketExpiry 10 100 ≤ 100 := by decide

end Broods.LentObservability
