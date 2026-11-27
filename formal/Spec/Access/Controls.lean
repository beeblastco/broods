import Spec.Access.Theorems

namespace Spec.Access.Controls

def tenantCredential : Credential :=
  { kind := .runtime, account := 7, valid := true, active := true, userPresent := false }

theorem tenant_nonvacuous : resolve tenantCredential {} = some (.deployment 7) := by decide

def wrongTenant (_ : Credential) : Auth := .deployment 8

theorem wrong_tenant_breaks : authAccount (wrongTenant tenantCredential) ≠ some tenantCredential.account := by decide

def ticket : Ticket := ⟨.run, 7, 100, true, true, true⟩

theorem purpose_nonvacuous : openTicket .run 0 ticket = some 7 := by decide

def ignorePurpose (t : Ticket) : Option Nat := some t.account

theorem ignore_purpose_breaks : ignorePurpose ticket ≠ openTicket .stage 0 ticket := by decide

theorem service_nonvacuous : resolve { tenantCredential with kind := .service } {} = some (.account 7 true) := by decide

def ignoreGateway (c : Credential) : Option Auth := resolve c {}

theorem ignore_gateway_breaks : ignoreGateway { tenantCredential with kind := .service } ≠
    resolve { tenantCredential with kind := .service } { viaGateway := true } := by decide

theorem route_nonvacuous : resolveRoute "GET" "/v1/downloads/key" = some .downloads := by cbv <;> decide

def lastMatch (m p : String) : Option Route := routeOrder.reverse.find? (routeMatches m p)

theorem reversed_order_breaks : lastMatch "GET" "/v1/downloads/key" ≠ resolveRoute "GET" "/v1/downloads/key" := by cbv <;> decide

theorem secret_nonvacuous : secretPath .downloads = true := by decide

theorem log_all_breaks : false ≠ secretPath .downloads := by decide

def leak : PublicLeak := ⟨some .health, 200, "request"⟩

theorem privacy_nonvacuous : Spec.NonVacuous publicSystem (fun _ => True) (fun e => e = leak) := by
  exact ⟨[⟨leak, "hidden"⟩], trivial, leak, by exact List.mem_append_left [] (List.mem_singleton.mpr rfl), rfl⟩

def brokenView (p : Probe) : String := p.tenantSecret

theorem leaking_secret_breaks : publicLeaks [⟨leak, "a"⟩] = publicLeaks [⟨leak, "b"⟩] ∧
    brokenView ⟨leak, "a"⟩ ≠ brokenView ⟨leak, "b"⟩ := by decide

def allowRule : ApiRule := ⟨"allow", false, ["agents:read"], none⟩
def denyRule : ApiRule := ⟨"deny", true, ["agents:read"], none⟩

theorem api_nonvacuous : authorize none none [allowRule] "agents:read" {} = true := by decide

theorem first_allow_breaks : authorize none none [allowRule, denyRule] "agents:read" {} = false ∧
    authorize none none [allowRule] "agents:read" {} = true := by decide

end Spec.Access.Controls

namespace Spec.Access.Controls

theorem reversed_order_violates_first_match :
    ¬ FirstResult (routeMatches "GET" "/v1/downloads/key") routeOrder
      (lastMatch "GET" "/v1/downloads/key") := by cbv <;> decide

end Spec.Access.Controls

namespace Spec.Access.Controls

/-- G100: a mismatched deployment distinguishes public agents from missing/private agents. -/
theorem status_publicness_leak :
    statusDecision true false false false true false false true = 1 ∧
    statusDecision true true false false true false false true = 2 := by decide

end Spec.Access.Controls

namespace Spec.Access.Controls

def leakingSystem : Spec.System where
  State := Unit
  Input := Probe
  Effect := String
  init := ()
  step := fun s i => (s, [i.tenantSecret])

theorem secret_effect_violates_privacy :
    ¬ Spec.Private leakingSystem Unit (List PublicLeak) String
      (fun _ => True) (fun _ _ => []) publicLeaks (fun _ xs => xs) := by
  intro h
  have bad := h () [⟨leak, "a"⟩] [⟨leak, "b"⟩] trivial trivial rfl rfl
  exact (by decide : (["a"] : List String) ≠ ["b"]) bad

end Spec.Access.Controls

namespace Spec.Access.Controls

/-- An AuthKit sign-in resolves on `/mcp` only; admin resolves on bearer routes but not on `/mcp`. -/
theorem mcp_nonvacuous :
    mcpResolve { kind := .authkit, account := 3 } {} = some (.account 3 false) ∧
    resolve { kind := .authkit, account := 3 } {} = none ∧
    resolve { kind := .admin, account := 3 } {} = some .admin ∧
    mcpResolve { kind := .admin, account := 3 } {} = none := by decide

/-- The pre-fix route model: stopping at the first fitting pattern sent these GETs to `webhooks`. -/
def stopAtFirstPattern (m : String) (p : List String) : Bool :=
  match p with
  | ["", "v1", "webhooks", a, "pancake"] => segment a
  | "" :: "v1" :: "webhooks" :: xs => xs != [] && m == "GET"
  | _ => false

theorem first_pattern_breaks_secret_webhooks :
    stopAtFirstPattern "GET" ["", "v1", "webhooks", "", "pancake"] = false ∧
    routeMatches "GET" "/v1/webhooks//pancake" .secretWebhooks = true := by
  constructor <;> cbv <;> decide

end Spec.Access.Controls
