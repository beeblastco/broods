import Spec.Twin

/-!
JavaScript semantics the channel twins share: truthiness, field access, `String.prototype.trim`,
`decodeURIComponent`, `encodeURIComponent` and the WHATWG URL parser's outcome for the URLs channels see.
-/

namespace Spec.Channels

open Lean

/-- The field's value, or `none` when the object has no such key (`undefined`). -/
def field? (value : Json) (key : String) : Option Json :=
  (value.getObjVal? key).toOption

/-- The field's value, with `undefined` read as null. -/
def field (value : Json) (key : String) : Json :=
  (field? value key).getD .null

/-- JavaScript truthiness of a JSON value. -/
def truthy : Json → Bool
  | .null => false
  | .bool b => b
  | .num n => n.mantissa != 0
  | .str s => s != ""
  | _ => true

/-- `Boolean(value?.key)`. -/
def fieldTruthy (value : Json) (key : String) : Bool :=
  truthy (field value key)

/-- The string in a JSON value. -/
def str? : Json → Option String
  | .str s => some s
  | _ => none

/-- The items of a JSON array. -/
def arr? : Json → Option (List Json)
  | .arr items => some items.toList
  | _ => none

/-- The keys of an object, in sorted order: Lean's JSON keeps no insertion order. -/
def keys : Json → List String
  | .obj kvs => kvs.toList.map (·.1)
  | _ => []

/-- The entries of an object, in sorted order. -/
def entries : Json → List (String × Json)
  | .obj kvs => kvs.toList
  | _ => []

/-- `{ ...value, [key]: item }`. -/
def setField (value : Json) (key : String) (item : Json) : Json :=
  Json.mkObj ((entries value).filter (·.1 != key) ++ [(key, item)])

/-- `{ ...base, ...over }`. -/
def spread (base over : Json) : Json :=
  (entries over).foldl (fun acc entry => setField acc entry.1 entry.2) base

/-- The object without `key`. -/
def dropField (value : Json) (key : String) : Json :=
  Json.mkObj ((entries value).filter (·.1 != key))

/-- An object entry that exists only when the value does. -/
def optEntry (key : String) : Option Json → List (String × Json)
  | some item => [(key, item)]
  | none => []

/-- A JSON array from a list. -/
def jarr (items : List Json) : Json :=
  .arr items.toArray

/-- A JSON string array. -/
def jstrs (items : List String) : Json :=
  jarr (items.map Json.str)

/-- The zod name of a JSON value's type, as in `expected object, received string`. -/
def zodType : Json → String
  | .null => "null"
  | .bool _ => "boolean"
  | .num _ => "number"
  | .str _ => "string"
  | .arr _ => "array"
  | .obj _ => "object"

/-- `[...new Set(items)]`, keeping first occurrences. -/
def uniq {α : Type} [BEq α] (items : List α) : List α :=
  (items.foldl (fun acc item => if acc.contains item then acc else item :: acc) []).reverse

/-- ECMAScript WhiteSpace and LineTerminator, which is what `trim` and `\s` use. -/
def jsSpace (c : Char) : Bool :=
  let n := c.toNat
  n == 9 || n == 10 || n == 11 || n == 12 || n == 13 || n == 32 || n == 0xA0 || n == 0x1680 ||
    (n >= 0x2000 && n <= 0x200A) || n == 0x2028 || n == 0x2029 || n == 0x202F || n == 0x205F ||
    n == 0x3000 || n == 0xFEFF

/-- `String.prototype.trimStart`. -/
def jsTrimStart (s : String) : String :=
  String.ofList (s.toList.dropWhile jsSpace)

/-- `String.prototype.trim`. -/
def jsTrim (s : String) : String :=
  let start := s.toList.dropWhile jsSpace
  String.ofList (start.reverse.dropWhile jsSpace).reverse

/-- `s.slice(n)` for a prefix length counted in characters. -/
def dropChars (s : String) (n : Nat) : String :=
  String.ofList (s.toList.drop n)

/-- `s.slice(pre.length)` when `s` starts with `pre`. -/
def stripPrefix? (s pre : String) : Option String :=
  if s.startsWith pre then some (dropChars s pre.length) else none

/-- The first index of `needle` in `s`, as `String.prototype.indexOf`. -/
def indexOf? (s needle : String) : Option Nat :=
  go s.toList 0 (s.length + 1)
where
  go (rest : List Char) (at' fuel : Nat) : Option Nat :=
    match fuel with
    | 0 => none
    | fuel + 1 =>
      if needle.toList.isPrefixOf rest then some at'
      else
        match rest with
        | [] => none
        | _ :: tail => go tail (at' + 1) fuel

/-- The value of a hex digit. -/
def hexValue (c : Char) : Option Nat :=
  if '0' ≤ c && c ≤ '9' then some (c.toNat - '0'.toNat)
  else if 'a' ≤ c && c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
  else if 'A' ≤ c && c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
  else none

private def utf8Length (lead : Nat) : Option Nat :=
  if lead < 0x80 then some 1
  else if lead >= 0xC2 && lead <= 0xDF then some 2
  else if lead >= 0xE0 && lead <= 0xEF then some 3
  else if lead >= 0xF0 && lead <= 0xF4 then some 4
  else none

private def takeEncoded (count : Nat) (rest : List Char) : Option (List UInt8 × List Char) :=
  match count with
  | 0 => some ([], rest)
  | count + 1 =>
    match rest with
    | '%' :: hi :: lo :: tail =>
      match hexValue hi, hexValue lo with
      | some h, some l =>
        match takeEncoded count tail with
        | some (bytes, remaining) => some ((h * 16 + l).toUInt8 :: bytes, remaining)
        | none => none
      | _, _ => none
    | _ => none

private def decodeLoop (fuel : Nat) (rest : List Char) (out : List Char) : Option (List Char) :=
  match fuel with
  | 0 => none
  | fuel + 1 =>
    match rest with
    | [] => some out.reverse
    | '%' :: hi :: lo :: _ =>
      match hexValue hi, hexValue lo with
      | some h, some l =>
        match utf8Length (h * 16 + l) with
        | none => none
        | some length =>
          match takeEncoded length rest with
          | none => none
          | some (bytes, remaining) =>
            match String.fromUTF8? (ByteArray.mk bytes.toArray) with
            | none => none
            | some text => decodeLoop fuel remaining (text.toList.reverse ++ out)
      | _, _ => none
    | '%' :: _ => none
    | c :: tail => decodeLoop fuel tail (c :: out)

/-- `decodeURIComponent`, or `none` where it throws. Invalid UTF-8 is a failure, as in the spec. -/
def decodeComponent? (s : String) : Option String :=
  (decodeLoop (s.length + 1) s.toList []).map String.ofList

private def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat ('0'.toNat + n) else Char.ofNat ('A'.toNat + n - 10)

private def unreservedComponent (c : Char) : Bool :=
  ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z') || ('0' ≤ c && c ≤ '9') ||
    "-_.!~*'()".toList.contains c

/-- `encodeURIComponent`. -/
def encodeComponent (s : String) : String :=
  String.ofList <| s.toList.flatMap fun c =>
    if unreservedComponent c then [c]
    else
      (String.singleton c).toUTF8.toList.flatMap fun byte =>
        ['%', hexDigit (byte.toNat / 16), hexDigit (byte.toNat % 16)]

/-- The parts of a parsed URL the channel code reads. -/
structure ParsedUrl where
  protocol : String
  hostname : String
  port : String
  pathname : String
  deriving Repr

/-- What `new URL(value)` does. `unknown` covers syntax this model leaves out: IP hosts,
non-ASCII hosts, percent-encoded hosts and non-special authorities. -/
inductive UrlOutcome where
  | invalid
  | ok (url : ParsedUrl)
  | unknown
  deriving Repr

private def specialSchemes : List (String × String) :=
  [("http", "80"), ("https", "443"), ("ws", "80"), ("wss", "443"), ("ftp", "21")]

private def isAlpha (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z')
private def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

private def forbiddenDomain (c : Char) : Bool :=
  c.toNat <= 0x20 || c.toNat == 0x7F || "#/:<>?@[\\]^|%".toList.contains c

private def stripUrlEdges (s : String) : List Char :=
  let edge := fun (c : Char) => c.toNat <= 0x20
  let start := s.toList.dropWhile edge
  let trimmed := (start.reverse.dropWhile edge).reverse
  trimmed.filter fun c => c != '\t' && c != '\n' && c != '\r'

private def lastLabelIsNumber (host : String) : Bool :=
  let labels := host.splitOn "."
  let labels := if labels.getLast? == some "" then labels.dropLast else labels
  match labels.getLast? with
  | some label =>
    (!label.isEmpty && label.toList.all isDigit) ||
      label.startsWith "0x" || label.startsWith "0X"
  | none => false

private def parseHostPort (authority : List Char) (defaultPort : String) :
    UrlOutcome ⊕ (String × String) :=
  let afterCredentials :=
    match (authority.reverse.span (· != '@')) with
    | (_, []) => authority
    | (tail, _) => tail.reverse
  if afterCredentials.head? == some '[' then .inl .unknown
  else
    let (hostChars, portChars) := afterCredentials.span (· != ':')
    let portDigits := portChars.drop 1
    if !portDigits.all isDigit then .inl .invalid
    else
      let portNumber := portDigits.foldl (fun acc c => acc * 10 + (c.toNat - '0'.toNat)) 0
      if portNumber > 65535 then .inl .invalid
      else if hostChars.isEmpty then .inl .invalid
      else if hostChars.any (fun c => c.toNat >= 0x80) || hostChars.contains '%' then .inl .unknown
      else if hostChars.any forbiddenDomain then .inl .invalid
      else
        let host := (String.ofList hostChars).toLower
        if lastLabelIsNumber host then .inl .unknown
        else
          let port := if portDigits.isEmpty then "" else toString portNumber
          .inr (host, if port == defaultPort then "" else port)

/-- The URL parser's outcome. Only the pathname `/` is computed exactly when dot segments appear. -/
def parseUrl (value : String) : UrlOutcome :=
  let input := stripUrlEdges value
  match input with
  | first :: _ =>
    if !isAlpha first then .invalid
    else
      let (schemeChars, rest) := input.span fun c =>
        isAlpha c || isDigit c || c == '+' || c == '-' || c == '.'
      match rest with
      | ':' :: afterColon =>
        let scheme := (String.ofList schemeChars).toLower
        match specialSchemes.lookup scheme with
        | some defaultPort =>
          let afterSlashes := afterColon.dropWhile fun c => c == '/' || c == '\\'
          let (authority, tail) := afterSlashes.span fun c =>
            c != '/' && c != '\\' && c != '?' && c != '#'
          match parseHostPort authority defaultPort with
          | .inl outcome => outcome
          | .inr (host, port) =>
            let pathChars := (tail.takeWhile fun c => c != '?' && c != '#').map fun c =>
              if c == '\\' then '/' else c
            let path := if pathChars.isEmpty then "/" else String.ofList pathChars
            let segments := path.splitOn "/"
            let dotted := segments.any fun seg =>
              let lower := seg.toLower
              lower == "." || lower == ".." || lower == "%2e" || lower == ".%2e" ||
                lower == "%2e." || lower == "%2e%2e"
            if dotted then .unknown
            else .ok { protocol := scheme ++ ":", hostname := host, port := port, pathname := path }
        | none =>
          if scheme == "file" || afterColon.take 2 == ['/', '/'] then .unknown
          else
            let (pathChars, _) := afterColon.span fun c => c != '?' && c != '#'
            .ok { protocol := scheme ++ ":", hostname := "", port := "",
                  pathname := String.ofList pathChars }
      | _ => .invalid
  | [] => .invalid

/-- `url.href` for a parsed `http`-like URL whose text needs no percent-encoding or credential handling. -/
def urlHref (raw : String) (url : ParsedUrl) : Option String :=
  let plain := fun (ch : Char) => ch.toNat > 32 && ch.toNat < 127 && ch != '@' && ch != '\\' &&
    ch != '"' && ch != '<' && ch != '>' && ch != '`' && ch != '{' && ch != '}' && ch != '|' && ch != '^'
  let tail := (raw.toList.dropWhile (fun ch => ch != '?' && ch != '#'))
  if !raw.toList.all plain || raw.toList.contains '[' then none
  else
    let port := if url.port == "" then "" else ":" ++ url.port
    some (url.protocol ++ "//" ++ url.hostname ++ port ++ url.pathname ++ String.ofList tail)

/-- `Number.isFinite` on a JSON number is always true; compares the value with a natural. -/
def numLe (n : JsonNumber) (k : Nat) : Bool :=
  let scale := (10 : Int) ^ n.exponent
  n.mantissa ≤ (k : Int) * scale

/-- Whether a JSON number is at least the natural `k`. -/
def numGe (n : JsonNumber) (k : Nat) : Bool :=
  let scale := (10 : Int) ^ n.exponent
  (k : Int) * scale ≤ n.mantissa

/-- The whole value of a JSON number, when it has no fractional part. -/
def numInt? (n : JsonNumber) : Option Int :=
  let scale := (10 : Int) ^ n.exponent
  if n.mantissa % scale == 0 then some (n.mantissa / scale) else none

end Spec.Channels
