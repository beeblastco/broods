import Spec.Config.Model
namespace Spec.Config.Proofs

theorem credential_independent (v : String) (a b : List (String × String)) :
    normaliseCredential v a = normaliseCredential v b := rfl

theorem fragment_roundtrip (v : AgentFragment) : decodeFragment (encodeFragment v) = v := by
  rcases v with ⟨turns, system⟩
  by_cases empty : system == ""
  · have eq : system = "" := by simpa using empty
    subst system
    rfl
  · simp [encodeFragment, decodeFragment, Value.get, empty]

theorem public_https {p h : String} (ok : publicHttpsProblem (some (p,h)) = none) :
    p = "https:" ∧ privateHostname h = false := by
  simp only [publicHttpsProblem] at ok
  split at ok
  · contradiction
  · rename_i hp
    split at ok
    · contradiction
    · rename_i hh
      simp_all

theorem stable_message (status : Int) (message : String) (code param : Option String) :
    (apiError status message code param).get "error" = some (.obj
      ([("message", .str message), ("type", .str (apiStatus status).2),
        ("code", .str (code.getD (apiStatus status).1))] ++
       param.toList.map (fun p => ("param", .str p)))) := rfl

theorem canonical_fixed (s : String) (trimmed : Spec.Js.trim s = s) :
    canonicalBase none (some s) = (none, some s) := by
  change (if Spec.Js.trim s == "" then (none, some s)
    else (none, some (Spec.Js.trim s))) = (none, some s)
  rw [trimmed]
  split <;> rfl

end Spec.Config.Proofs
