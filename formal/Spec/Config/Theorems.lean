import Spec.Config.Proofs
/-! Safety and noninterference for pure rules; scheduling progress does not apply.
The fragment round-trip and base canonicalisation are deliberately narrow (L700-L703).
Envelope secrecy is a cryptographic assumption, not a JSON-validation property (G701). -/
namespace Spec.Config

/-- A provider base URL that ECMAScript `trim` leaves unchanged (no leading or trailing
whitespace, U+00A0 and U+FEFF included) is a fixed point of the baseURL canonicalisation. -/
theorem normalisation_fixed (s : String) (trimmed : Spec.Js.trim s = s) :
    canonicalBase none (some s) = (none, some s) := Proofs.canonical_fixed s trimmed

/-- ASCII trimming is not enough: U+00A0 is not Lean's ASCII whitespace, yet the code strips it,
so a base starting with it satisfies a `trimAscii` hypothesis and is still rewritten. -/
example : Char.isWhitespace '\u00A0' = false ∧
    canonicalBase none (some (String.ofList ['\u00A0', 'a'])) = (none, some (String.ofList ['a'])) := by
  refine ⟨by decide, ?_⟩
  simp [canonicalBase, Spec.Js.trim, Spec.Js.trimStartChars, Spec.Js.isSpace]

/-- Credential validation never reads a secret map or substitutes a placeholder. -/
theorem placeholders_intact (v : String) (a b : List (String × String)) :
    normaliseCredential v a = normaliseCredential v b := Proofs.credential_independent v a b

/-- Decode after encode preserves the codec's maxTurn/system fragment. -/
theorem codec_fragment_roundtrip (v : AgentFragment) :
    decodeFragment (encodeFragment v) = v := Proofs.fragment_roundtrip v

/-- The explicit URL check accepts only HTTPS and a hostname outside its lexical deny list, whose
name rules (`localhost`, `.localhost`, `.local`, `.internal`) are read after lowercasing, dropping
one `[`, one `]` and one trailing dot. `hostKey` drops a single dot only, so `localhost..` passes,
and the hostname is the parser's result (L701), never resolved through DNS. -/
theorem accepted_url_public_https {p h : String}
    (ok : publicHttpsProblem (some (p,h)) = none) :
    p = "https:" ∧ privateHostname h = false ∧ deniedName (hostKey h) = false :=
  Proofs.public_https ok

/-- One trailing DNS dot names the same host: for a hostname whose last character is neither
`.` nor `]`, the deny list gives the same verdict with a dot appended. -/
theorem trailing_dot_same_host (h : String) (dot : h.toList.getLast? ≠ some '.')
    (close : h.toList.getLast? ≠ some ']') : privateHostname (h ++ ".") = privateHostname h :=
  Proofs.trailing_dot_private h dot close

/-- A provider's settings, once accepted, hold no URL-named setting (`/url$/i`, ASCII case; so
`base_url` and `baseURL` alike) whose trimmed string value is nonblank and fails `urlProblem`.
A blank value is exempt, and `urlProblem` stands for the WHATWG parse plus `publicHttpsProblem`. -/
theorem accepted_provider_endpoints {u : String → Option String} {v r : Value}
    (ok : normaliseProviderSettings u v = .ok r) {key s : String}
    (mem : (key, Value.str s) ∈ settingsOrder v) (named : endpointSetting key = true)
    (nonblank : Spec.Js.trim s ≠ "") : u (Spec.Js.trim s) = none :=
  Proofs.accepted_endpoint ok mem named nonblank

/-- Both base URL spellings are checked, each on its own: when settings are accepted, a nonblank
`base_url` or `baseURL` string passes `urlProblem`, whatever the other spelling holds. -/
theorem accepted_base_urls {u : String → Option String} {v r : Value}
    (ok : normaliseProviderSettings u v = .ok r) {key s : String}
    (base : key = "base_url" ∨ key = "baseURL") (got : v.get key = some (.str s))
    (nonblank : Spec.Js.trim s ≠ "") : u (Spec.Js.trim s) = none :=
  Proofs.accepted_endpoint ok (Proofs.base_in_order base got)
    (by rcases base with rfl | rfl <;> cbv) nonblank

/-- API error construction preserves its client-visible message verbatim. -/
theorem rejection_message_stable (status : Int) (message : String) (code param : Option String) :
    (apiError status message code param).get "error" = some (.obj
      ([("message", .str message), ("type", .str (apiStatus status).2),
        ("code", .str (code.getD (apiStatus status).1))] ++
       param.toList.map (fun p => ("param", .str p)))) :=
  Proofs.stable_message status message code param
end Spec.Config
