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

/-- The deny list refuses `localhost.` and `a.local.`, and reads `localhost..` as `localhost.`,
which no name rule matches. -/
theorem trailing_dot_verdicts : privateHostname "localhost." = true ∧
    privateHostname "a.local." = true ∧ privateHostname "localhost.." = false := by
  cbv
  all_goals decide

/-- `accepted_provider_endpoints` has an accepted case: a public `baseURL` passes unchanged. -/
theorem provider_endpoint_witness :
    normaliseProviderSettings (fun _ => none) (.obj [("baseURL", .str "https://example.com/")]) =
    .ok (.obj [("baseURL", .str "https://example.com/")]) := by
  cbv
  all_goals decide

/-- Skipping `baseURL` when `base_url` is blank would accept a private `baseURL`. -/
theorem blank_base_url_checks_alias : normaliseProviderSettings
    (fun s => if s == "https://127.0.0.1/" then some "must not point to a private or internal address"
      else none)
    (.obj [("base_url", .str ""), ("baseURL", .str "https://127.0.0.1/")]) =
    .error "config.provider.openai.baseURL must not point to a private or internal address" := by
  cbv
  all_goals decide

end Spec.Config.Controls
