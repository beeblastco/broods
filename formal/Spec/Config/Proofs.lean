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
    p = "https:" ∧ privateHostname h = false ∧ deniedName (hostKey h) = false := by
  simp only [publicHttpsProblem] at ok
  split at ok
  · contradiction
  · rename_i hp
    split at ok
    · contradiction
    · rename_i hh
      have priv : privateHostname h = false := by simpa using hh
      refine ⟨by simpa using hp, priv, ?_⟩
      cases named : deniedName (hostKey h)
      · rfl
      · simp [privateHostname, named] at priv

/-- ASCII lowercasing maps no character onto one outside `a`..`z`, except that character. -/
theorem lower_fixed (c d : Char) (hd : d.val.toNat < 97 ∨ 122 < d.val.toNat)
    (h : c.toLower = d) : c = d := by
  unfold Char.toLower at h
  split at h
  · rename_i hu
    subst h
    exfalso
    obtain ⟨h1, h2⟩ := hu
    simp only [UInt32.le_iff_toNat_le] at h1 h2
    simp only [UInt32.toNat_add] at hd
    have shift : ('a'.val - 'A'.val).toNat = 32 := by decide
    have ha : 'A'.val.toNat = 65 := by decide
    have hz : 'Z'.val.toNat = 90 := by decide
    rw [shift] at hd
    rw [ha] at h1
    rw [hz] at h2
    omega
  · exact h

theorem dropOpen_dot (l : List Char) : dropOpen (l ++ ['.']) = dropOpen l ++ ['.'] := by
  cases l with
  | nil => decide
  | cons x r =>
    by_cases hx : x = '['
    · simp [dropOpen, hx]
    · simp [dropOpen, hx]

theorem dropOpen_last (l : List Char) :
    (dropOpen l).getLast? = none ∨ (dropOpen l).getLast? = l.getLast? := by
  cases l with
  | nil => left; rfl
  | cons x r =>
    by_cases hx : x = '['
    · cases r with
      | nil => left; simp [dropOpen, hx]
      | cons y t =>
        right
        simp [dropOpen, hx, List.getLast?_cons_cons]
    · right
      simp [dropOpen, hx]

theorem dropLastIf_concat (c d : Char) (l : List Char) (ne : d ≠ c) :
    dropLastIf c (l ++ [d]) = l ++ [d] := by
  simp [dropLastIf, ne]

theorem dropLastIf_self (c : Char) (l : List Char) : dropLastIf c (l ++ [c]) = l := by
  simp [dropLastIf]

theorem dropLastIf_other (c : Char) (l : List Char) (last : l.getLast? ≠ some c) :
    dropLastIf c l = l := by
  simp [dropLastIf, last]

theorem trailing_dot_key (h : String) (dot : h.toList.getLast? ≠ some '.')
    (close : h.toList.getLast? ≠ some ']') : hostKey (h ++ ".") = hostKey h := by
  have last : ∀ c, (dropOpen (h.toList.map Char.toLower)).getLast? = some c →
      c ≠ '.' ∧ c ≠ ']' := by
    intro c hc
    rcases dropOpen_last (h.toList.map Char.toLower) with none | same
    · rw [none] at hc
      cases hc
    · rw [same, List.getLast?_map] at hc
      cases hl : h.toList.getLast? with
      | none => rw [hl] at hc; cases hc
      | some d =>
        rw [hl] at hc
        simp only [Option.map_some, Option.some.injEq] at hc
        constructor
        · intro hd
          subst hd
          exact dot (by rw [hl, lower_fixed d '.' (by decide) hc])
        · intro hd
          subst hd
          exact close (by rw [hl, lower_fixed d ']' (by decide) hc])
  have dotChars : ("." : String).toList = ['.'] := by decide
  have lowerDot : Char.toLower '.' = '.' := by decide
  simp only [hostKey, String.toList_append, dotChars, List.map_append, List.map_cons,
    List.map_nil, lowerDot, dropOpen_dot]
  rw [dropLastIf_concat ']' '.' _ (by decide), dropLastIf_self]
  have notClose : (dropOpen (h.toList.map Char.toLower)).getLast? ≠ some ']' := fun hc =>
    (last ']' hc).2 rfl
  rw [dropLastIf_other ']' _ notClose]
  have notDot : (dropOpen (h.toList.map Char.toLower)).getLast? ≠ some '.' := fun hc =>
    (last '.' hc).1 rfl
  rw [dropLastIf_other '.' _ notDot]

theorem trailing_dot_private (h : String) (dot : h.toList.getLast? ≠ some '.')
    (close : h.toList.getLast? ≠ some ']') : privateHostname (h ++ ".") = privateHostname h := by
  simp only [privateHostname, trailing_dot_key h dot close]

theorem accepted_endpoint {u : String → Option String} {v r : Value}
    (ok : normaliseProviderSettings u v = .ok r) {key s : String}
    (mem : (key, Value.str s) ∈ settingsOrder v) (named : endpointSetting key = true)
    (nonblank : Spec.Js.trim s ≠ "") : u (Spec.Js.trim s) = none := by
  cases v with
  | obj xs =>
    simp only [normaliseProviderSettings] at ok
    split at ok
    · simp at ok
    · split at ok
      · simp at ok
      · rename_i clear
        have one := List.findSome?_eq_none_iff.mp clear _ mem
        have blank : (Spec.Js.trim s == "") = false := by simpa using nonblank
        simp only [endpointProblem, named, Bool.not_true, blank] at one
        simpa using one
  | _ => simp [normaliseProviderSettings] at ok

theorem base_in_order {v x : Value} {key : String} (base : key = "base_url" ∨ key = "baseURL")
    (got : v.get key = some x) : (key, x) ∈ settingsOrder v := by
  apply List.mem_append_left
  rw [List.mem_filterMap]
  refine ⟨key, by rcases base with rfl | rfl <;> simp, by simp [got]⟩

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
