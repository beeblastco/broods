--------------------------- MODULE StageTicket ---------------------------
(* run()'s stage ticket in packages/broods/src/cli/index.ts. Each request re-mints with under
   MARGIN left by a local clock SKEW behind the server's, then arrives within MAXDELAY ticks.
   Requests interleave freely, so re-mints can overlap and finish in any order. *)
EXTENDS Naturals

CONSTANTS Req, TTL, MARGIN, MAXDELAY, HORIZON, SKEW

ASSUME SKEW + MAXDELAY < MARGIN /\ MAXDELAY < TTL

VARIABLES now, session, pc, token, age

vars == <<now, session, pc, token, age>>

Local == now - SKEW          \* Date.now() on the developer's machine

Init ==
  /\ now = SKEW
  /\ session = now + TTL     \* minted at startup; holds the server expiry
  /\ pc = [r \in Req |-> "idle"]
  /\ token = [r \in Req |-> 0]
  /\ age = [r \in Req |-> 0]

\* credential(): the expiry check.
Check(r) ==
  /\ pc[r] = "idle"
  /\ pc' = [pc EXCEPT ![r] = IF session - Local < MARGIN THEN "minting" ELSE "read"]
  /\ age' = [age EXCEPT ![r] = 0]
  /\ UNCHANGED <<now, session, token>>

\* session = await mintStageSession(...): a fresh ticket from the server.
MintDone(r) ==
  /\ pc[r] = "minting"
  /\ session' = now + TTL
  /\ pc' = [pc EXCEPT ![r] = "read"]
  /\ UNCHANGED <<now, token, age>>

\* return session?.token: whatever ticket is stored now, maybe another
\* request's mint.
Read(r) ==
  /\ pc[r] = "read"
  /\ token' = [token EXCEPT ![r] = session]
  /\ pc' = [pc EXCEPT ![r] = "sent"]
  /\ UNCHANGED <<now, session, age>>

\* The server checks the ticket on arrival.
Arrive(r) ==
  /\ pc[r] = "sent"
  /\ pc' = [pc EXCEPT ![r] = IF token[r] > now THEN "idle" ELSE "rejected"]
  /\ UNCHANGED <<now, session, token, age>>

\* Time passes, within each in-flight request's latency budget. A mint is
\* a round trip too, so it also counts against the budget.
Tick ==
  /\ now < HORIZON
  /\ \A r \in Req : pc[r] \in {"idle", "rejected"} \/ age[r] < MAXDELAY
  /\ now' = now + 1
  /\ age' = [r \in Req |-> IF pc[r] \in {"idle", "rejected"} THEN 0 ELSE age[r] + 1]
  /\ UNCHANGED <<session, pc, token>>

Next == Tick \/ \E r \in Req : Check(r) \/ MintDone(r) \/ Read(r) \/ Arrive(r)

Spec == Init /\ [][Next]_vars

NoExpiredTicket == \A r \in Req : pc[r] # "rejected"
=============================================================================
