import Spec.Config.Theorems
namespace Spec.Config.Controls

/-- A rewrite that appends a slash breaks canonical fixed points. -/
theorem bad_normalisation : (none, some ("https://example.com/" ++ "/")) ≠
    canonicalBase none (some "https://example.com/") := by
  cbv
  all_goals decide

/-- Resolving a credential placeholder breaks noninterference. -/
theorem bad_resolution : normaliseCredential "${KEY}" [("KEY", "secret")] ≠ "secret" := by
  cbv
  all_goals decide

/-- Dropping the system string breaks the round-trip. -/
theorem bad_codec : decodeFragment (encodeFragment ⟨1,""⟩) ≠ (⟨1, "${KEY}"⟩ : AgentFragment) := by
  cbv
  all_goals decide

/-- Skipping the scheme check would admit an HTTP endpoint. -/
theorem bad_scheme : publicHttpsProblem (some ("http:", "example.com")) ≠ none := by
  cbv
  all_goals decide

/-- Replacing the caller's message with a generic message changes the wire error. -/
theorem bad_message : apiError 400 "bad" none none ≠
    apiError 400 "generic" none none := by
  simp [apiError]

/-- Each main claim has an accepted, nonempty concrete witness. -/
theorem witnesses :
    canonicalBase none (some "https://example.com/") = (none, some "https://example.com/") ∧
    normaliseCredential "${KEY}" [] = "${KEY}" ∧
    decodeFragment (encodeFragment ⟨1,"${KEY}"⟩) = ⟨1,"${KEY}"⟩ ∧
    publicHttpsProblem (some ("https:","example.com")) = none ∧
    (apiError 400 "bad" none none).get "error" ≠ none := by
  cbv
  all_goals decide

/-- G701: encryption input has no predicate excluding already resolved secret material. -/
theorem envelope_accepts_resolved : envelopePlaintext (.obj [("apiKey",.str "secret")]) =
    .obj [("apiKey",.str "secret")] := rfl

/-- The literal hostname deny list does not reject a trailing dot (G700). -/
theorem trailing_dot_private_escape : privateHostname "localhost." = false := by
  cbv
  all_goals decide
end Spec.Config.Controls
