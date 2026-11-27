import Spec.Access.Model

namespace Spec.Access.Proofs

theorem tenant (c : Credential) (r : Request) (a : Auth) (h : resolve c r = some a) :
    authAccount a = none ∨ authAccount a = some c.account := by
  cases c with | mk k account valid active present userValid =>
    cases k <;> cases valid <;> cases active <;> cases present <;> cases userValid <;>
      cases r with | mk via disabled =>
        cases via <;> cases disabled <;> simp_all [resolve] <;> subst a <;> simp [authAccount]

theorem service (c : Credential) (r : Request) (hk : c.kind = .service) (hv : r.viaGateway = true) :
    resolve c r = none := by simp [resolve, hk, hv]

theorem purpose (p : Purpose) (now : Nat) (t : Ticket) (h : t.purpose ≠ p) :
    openTicket p now t = none := by simp [openTicket, h]

theorem route_unique (m p : String) : ∃ r, resolveRoute m p = r ∧ ∀ s, resolveRoute m p = s → s = r := by
  exact ⟨resolveRoute m p, rfl, fun _ h => h.symm⟩

theorem secret_exact (r : Route) :
    secretPath r = true ↔ r = .downloads ∨ r = .secretWebhooks ∨ r = .media := by
  cases r <;> decide

theorem observations (xs : List Probe) : publicSystem.effects xs = publicLeaks xs := by
  induction xs with
  | nil => rfl
  | cons x xs ih =>
    change x.leak :: publicSystem.effects xs = x.leak :: publicLeaks xs
    rw [ih]

theorem privacy : Spec.Private publicSystem Unit (List PublicLeak) PublicLeak
    (fun _ => True) (fun _ _ => []) publicLeaks (fun _ xs => xs) := by
  intro _ a b _ _ _ h
  change publicSystem.effects a = publicSystem.effects b
  exact (observations a).trans (h.trans (observations b).symm)

theorem deny_overrides (p s : Option String) (rs : List ApiRule) (a : String) (r : ApiResource)
    (h : rs.any (fun rule => rule.deny && ruleMatches a r rule) = true) :
    authorize p s rs a r = false := by simp [authorize, h]

end Spec.Access.Proofs

namespace Spec.Access

/-- A result is the first matching rule, or none exactly when every rule misses. -/
def FirstResult (test : Route → Bool) : List Route → Option Route → Prop
  | [], r => r = none
  | x :: xs, r => if test x then r = some x else FirstResult test xs r

namespace Proofs

theorem find_first (test : Route → Bool) (xs : List Route) : FirstResult test xs (xs.find? test) := by
  induction xs with
  | nil => rfl
  | cons x xs ih =>
    cases h : test x <;> simp [FirstResult, List.find?, h, ih]

theorem first_unique (test : Route → Bool) (xs : List Route) (r s : Option Route)
    (hr : FirstResult test xs r) (hs : FirstResult test xs s) : r = s := by
  induction xs with
  | nil => exact hr.trans hs.symm
  | cons x xs ih =>
    cases h : test x <;> simp only [FirstResult, h, Bool.false_eq_true, ↓reduceIte] at hr hs
    · exact ih hr hs
    · exact hr.trans hs.symm

end Proofs
end Spec.Access

namespace Spec.Access.Proofs

theorem mcp_tenant (c : Credential) (r : Request) (a : Auth) (h : mcpResolve c r = some a) :
    authAccount a = some c.account := by
  unfold mcpResolve at h
  split at h
  · contradiction
  · rename_i b hb hres
    cases tenant c _ b hres with
    | inl hn =>
      cases b <;> simp_all [authAccount]
    | inr hs => simp_all
  · split at h <;> simp_all [authAccount] <;> subst a <;> rfl

theorem context_injective (p q : Purpose) (h : ticketContext p = ticketContext q) : p = q := by
  cases p <;> cases q <;> first | rfl | (simp [ticketContext] at h)

theorem kind_not_service (token : String) (adminMatch serviceMatch : Bool) :
    credentialKind token adminMatch serviceMatch true ≠ .service := by
  have hc : classify token ≠ .service := by
    unfold classify
    repeat (split; all_goals (try simp))
  intro h
  unfold credentialKind at h
  simp only [Bool.not_true, Bool.and_false, Bool.false_eq_true, ↓reduceIte] at h
  split at h
  · exact hc h
  · split at h
    · cases h
    · exact hc h

end Spec.Access.Proofs
