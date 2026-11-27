import Spec.Access.Proofs

/-! Safety and declared leakage for the synchronous access decision boundary.
Progress is witnessed by successful resolutions: no scheduler or retry loop is modelled (L100). -/
namespace Spec.Access

/-- Bearer credentials resolve to no tenant (admin) or to `c.account`. By construction (L22): the
account is the trusted row or signed subject the credential carries (A3), so this pins the shape. -/
theorem resolved_credential_tenant (c : Credential) (r : Request) (a : Auth)
    (h : resolve c r = some a) : authAccount a = none ∨ authAccount a = some c.account :=
  Proofs.tenant c r a h

/-- `/mcp` never resolves to admin: every accepted credential, including an AuthKit sign-in, names
exactly `c.account`, which for AuthKit is the `getForUser` row for the verified subject (A3). The
account part is by construction (L22): the account is the credential's input; the content is that
no `/mcp` branch yields admin. -/
theorem mcp_credential_tenant (c : Credential) (r : Request) (a : Auth)
    (h : mcpResolve c r = some a) : authAccount a = some c.account :=
  Proofs.mcp_tenant c r a h

/-- Distinct ticket purposes have distinct key contexts, so under A1 a ticket sealed for one purpose
never verifies for another, even though run, stage and observability share STAGE_TICKET_SECRET. -/
theorem token_purpose_separation (p q : Purpose) (h : ticketContext p = ticketContext q) : p = q :=
  Proofs.context_injective p q h

/-- `openTicket` checks the purpose it is asked for. By construction (L22): this is the model's
abstraction of the key context, justified by `token_purpose_separation`. -/
theorem open_requires_purpose (p : Purpose) (now : Nat) (t : Ticket) (h : t.purpose ≠ p) :
    openTicket p now t = none := Proofs.purpose p now t h

/-- A proxied request never resolves through the service-token branch. -/
theorem gateway_refuses_service (c : Credential) (r : Request)
    (hk : c.kind = .service) (hv : r.viaGateway = true) : resolve c r = none :=
  Proofs.service c r hk hv

/-- Through the gateway, no bearer token classifies as the service credential. -/
theorem gateway_token_never_service (token : String) (adminMatch serviceMatch : Bool) :
    credentialKind token adminMatch serviceMatch true ≠ .service :=
  Proofs.kind_not_service token adminMatch serviceMatch

/-- Every path and method has exactly one first-match result, including no route (L101). -/
theorem first_match_unique (m p : String) : ∃ r, resolveRoute m p = r ∧ ∀ s, resolveRoute m p = s → s = r := Proofs.route_unique m p

/-- Only downloads, secret webhooks and media routes suppress access logging. -/
theorem secret_routes_exact (r : Route) :
    secretPath r = true ↔ r = .downloads ∨ r = .secretWebhooks ∨ r = .media := Proofs.secret_exact r

/-- The public view of boundary probes equals the declared leak. Tautological (L22): the leak is
the whole view, so it states the declaration, not a derived bound (L102). -/
theorem public_view_is_declared_leak : Spec.Private publicSystem Unit (List PublicLeak) PublicLeak
    (fun _ => True) (fun _ _ => []) publicLeaks (fun _ xs => xs) := Proofs.privacy

/-- An explicit matching deny overrides every allowing API rule. -/
theorem api_deny_overrides (p s : Option String) (rs : List ApiRule) (a : String) (r : ApiResource)
    (h : rs.any (fun rule => rule.deny && ruleMatches a r rule) = true) :
    authorize p s rs a r = false := Proofs.deny_overrides p s rs a r h

end Spec.Access

namespace Spec.Access

/-- Selection honors every preceding route and returns none only when all routes miss. Each route's
predicate ORs its rules as `resolveRouter`'s `rules.some` does. By construction (L22): this restates
`find?`; the content is `routeMatches` and the route replay. -/
theorem first_match_order (m p : String) :
    FirstResult (routeMatches m.toUpper p) routeOrder (resolveRoute m p) :=
  Proofs.find_first _ _

/-- Any other result satisfying ordered matching is the selected result. By construction (L22). -/
theorem first_match_deterministic (m p : String) (other : Option Route)
    (h : FirstResult (routeMatches m.toUpper p) routeOrder other) : other = resolveRoute m p :=
  Proofs.first_unique _ _ _ _ h (Proofs.find_first _ _)

/-- A GET to a webhook path with an empty provider segment still takes the unlogged secret router. -/
theorem empty_segment_webhook_get_secret :
    resolveRoute "GET" "/v1/webhooks//pancake" = some .secretWebhooks ∧
    resolveRoute "GET" "/v1/webhooks/a/dev//pancake" = some .secretWebhooks := by
  constructor <;> cbv <;> decide

end Spec.Access
