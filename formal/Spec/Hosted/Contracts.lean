import Spec.Assumptions

/-! External service contracts rely on trusted operators/providers (A3) and isolation (A5).
These describe adapter expectations, not proofs about OAuth servers, sandbox images or OTLP. -/
namespace Spec.Hosted.Contracts

/-- OAuth endpoint must return a nonempty token; absent/nonpositive expiry means one hour. -/
structure OAuth where
  token : String
  nonempty : token.isEmpty = false
  expiresAt : Nat

/-- oauth.ts refreshTokenGrant and mintAccessToken subtract a one-minute refresh margin. -/
def oauthFresh (now expiresAt : Nat) : Bool := now + 60000 < expiresAt

/-- A reserved Lambda sandbox serves JSON-RPC on /mcp and persists the stdio server. -/
structure SandboxMcp where
  persistent : Bool
  reservation : String
  command : List String
  result : String
  error : Option String

/-- postReserved must exist; malformed and JSON-RPC error replies fail the adapter. -/
def sandboxReplyAccepted (available resultResponse errorResponse : Bool) : Bool :=
  available && !errorResponse && resultResponse

/-- CloudWatch may retry an OTLP push when the endpoint returns a non-success response. -/
structure LogExport where
  dataMessage : Bool
  events : Nat
  status : Nat

/-- sandbox-log-forwarder.mjs only pushes nonempty DATA_MESSAGE payloads. -/
def exportsLogs (r : LogExport) : Bool := r.dataMessage && r.events > 0

/-- No endpoint delivery, redaction completeness or retention guarantee follows from this adapter. -/
def exportAccepted (r : LogExport) : Bool := 200 ≤ r.status && r.status < 300

end Spec.Hosted.Contracts
