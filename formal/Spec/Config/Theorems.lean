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

/-- The explicit URL check accepts only HTTPS and a hostname outside its lexical deny list. -/
theorem accepted_url_public_https {p h : String}
    (ok : publicHttpsProblem (some (p,h)) = none) :
    p = "https:" ∧ privateHostname h = false := Proofs.public_https ok

/-- API error construction preserves its client-visible message verbatim. -/
theorem rejection_message_stable (status : Int) (message : String) (code param : Option String) :
    (apiError status message code param).get "error" = some (.obj
      ([("message", .str message), ("type", .str (apiStatus status).2),
        ("code", .str (code.getD (apiStatus status).1))] ++
       param.toList.map (fun p => ("param", .str p)))) :=
  Proofs.stable_message status message code param
end Spec.Config
