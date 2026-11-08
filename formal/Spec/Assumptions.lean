/-!
What every theorem takes as given about the world outside the runtime. Read this with
`Statements.lean`: a theorem says nothing where one of these fails.

A1. Signatures are unforgeable. Nobody without a key can make a token, ticket or webhook signature
    that verifies. Forging is modelled as impossible, not as unlikely, so no theorem carries a
    probability bound. A real HMAC or AES-GCM failure is outside every theorem.
A2. Convex mutations are serialisable transactions: each runs alone and either commits whole or not
    at all, and a reader sees its own writes.
A3. Operators, Convex and cloud providers are honest. Anyone holding an admin key or pod access is
    outside the attacker model (`DECISIONS.md`, D4).
A4. Core runs as a single replica. The worker queue and machine registry live in its memory.
A5. Tenant code cannot escape its isolate, MicroVM or sandbox provider. Isolation inside those
    boundaries is assumed, not proved.
A6. Time only moves forward, and every timer the model treats as an input eventually can fire.
-/

namespace Spec

/-- The list of assumption labels theorems may cite. Being data, a removed label breaks its users. -/
inductive Assumption where
  | unforgeable
  | serialisableConvex
  | trustedOperators
  | singleReplica
  | sandboxIsolation
  | monotonicTime
  deriving DecidableEq, Repr

end Spec
