import Spec.Access.Proofs

/-! Safety and declared leakage for the synchronous access decision boundary.
Progress is witnessed by successful resolutions: no scheduler or retry loop is modelled (L100). -/
namespace Spec.Access

/-- Tenant credentials resolve only to their authenticated account; admin carries no tenant. -/
theorem resolved_credential_tenant (c : Credential) (r : Request) (a : Auth)
    (h : resolve c r = some a) : authAccount a = none ∨ authAccount a = some c.account :=
  Proofs.tenant c r a h

/-- A ticket cannot open for any other purpose, under symbolic cryptography A1. -/
theorem token_purpose_separation (p : Purpose) (now : Nat) (t : Ticket) (h : t.purpose ≠ p) :
    openTicket p now t = none := Proofs.purpose p now t h

/-- A proxied request never resolves through the service-token branch. -/
theorem gateway_refuses_service (c : Credential) (r : Request)
    (hk : c.kind = .service) (hv : r.viaGateway = true) : resolve c r = none :=
  Proofs.service c r hk hv

/-- Every path and method has exactly one first-match result, including no route (L101). -/
theorem first_match_unique (m p : String) : ∃ r, resolveRoute m p = r ∧ ∀ s, resolveRoute m p = s → s = r := Proofs.route_unique m p

/-- Only downloads, secret webhooks and media routes suppress access logging. -/
theorem secret_routes_exact (r : Route) :
    secretPath r = true ↔ r = .downloads ∨ r = .secretWebhooks ∨ r = .media := Proofs.secret_exact r

/-- Unauthenticated boundary probes reveal only declared public metadata, never tenant secrets (L102). -/
theorem unauthenticated_private : Spec.Private publicSystem Unit (List PublicLeak) PublicLeak
    (fun _ => True) (fun _ _ => []) publicLeaks (fun _ xs => xs) := Proofs.privacy

/-- An explicit matching deny overrides every allowing API rule. -/
theorem api_deny_overrides (p s : Option String) (rs : List ApiRule) (a : String) (r : ApiResource)
    (h : rs.any (fun rule => rule.deny && ruleMatches a r rule) = true) :
    authorize p s rs a r = false := Proofs.deny_overrides p s rs a r h

end Spec.Access

namespace Spec.Access

/-- Selection honors every preceding route and returns none only when all routes miss. -/
theorem first_match_order (m p : String) :
    FirstResult (routeMatches m.toUpper p) routeOrder (resolveRoute m p) :=
  Proofs.find_first _ _

/-- Any other result satisfying ordered matching must be the selected result. -/
theorem first_match_deterministic (m p : String) (other : Option Route)
    (h : FirstResult (routeMatches m.toUpper p) routeOrder other) : other = resolveRoute m p :=
  Proofs.first_unique _ _ _ _ h (Proofs.find_first _ _)

end Spec.Access

namespace Spec.Access

/-- Runtime composition may extract a tenant only if it is exactly the credential's own tenant. -/
theorem resolved_tenant_account (c : Credential) (r : Request) (a : Auth) (id : Nat)
    (h : resolve c r = some a) (ha : authAccount a = some id) : id = c.account :=
  Proofs.tenant_account c r a id h ha

end Spec.Access
