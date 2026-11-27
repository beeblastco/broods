import Spec.Twin
import Spec.Sandbox.Model

/-!
Shared helpers for the sandbox runtime twins: JSON access with JavaScript's meaning, string and number
rules, a WHATWG URL parser for the forms these functions see, and SHA-256.
-/

namespace Spec.Sandbox.Rt

open Lean

/-- A computation that may stop with a twin output: a throw or an unmodelled case. -/
abbrev R := Except Json

/-- Stops as if the function threw `message`. -/
def fail {α : Type} (message : String) : R α :=
  .error (Spec.Twin.threw message)

/-- Stops because the outcome depends on something the arguments do not hold. -/
def unsup {α : Type} (reason : String) : R α :=
  .error (Spec.Twin.unsupported reason)

/-- The output for a call that returned undefined or null. `conform.ts` cannot read a bare `null` line
yet, so these calls stay uncompared until it can. -/
def voidResult : Json :=
  Json.null

/-- A twin from a function of the call's arguments. -/
def twin (source : String) (run : Json → R Json) : Spec.Twin where
  source := source
  run := fun args =>
    match run args with
    | .ok .null => voidResult
    | .ok value => value
    | .error stop => stop

/-- The value at `key`, when the object holds it. Undefined never survives recording, so absent is undefined. -/
def opt (value : Json) (key : String) : Option Json :=
  (value.getObjVal? key).toOption

/-- `value[key]`, with absent and null both reading as null. -/
def get (value : Json) (key : String) : Json :=
  (opt value key).getD .null

/-- `key in value`. -/
def has (value : Json) (key : String) : Bool :=
  (opt value key).isSome

/-- The object's entries in key order. JavaScript's own order is lost when Lean parses the call. -/
def entries (value : Json) : List (String × Json) :=
  match value with
  | .obj fields => fields.foldl (fun acc key item => acc ++ [(key, item)]) []
  | _ => []

/-- An object that is not an array or null. -/
def isObj (value : Json) : Bool :=
  match value with
  | .obj _ => true
  | _ => false

/-- JavaScript truthiness of a JSON value. -/
def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str text => !text.isEmpty
  | .num number => number.mantissa != 0
  | _ => true

/-- A JSON string as an option. -/
def strOf (value : Json) : Option String :=
  match value with
  | .str text => some text
  | _ => none

/-- The string at `key`, when there is one. -/
def strAt (value : Json) (key : String) : Option String :=
  strOf (get value key)

/-- Builds an object, leaving out the fields marked absent. -/
def objOf (fields : List (String × Option Json)) : Json :=
  Json.mkObj (fields.filterMap fun (key, item) => item.map fun present => (key, present))

/-- Whether every character is ASCII. -/
def isAscii (text : String) : Bool :=
  text.toList.all fun c => c.toNat < 128

/-- String.prototype.toLowerCase for ASCII text. -/
def lowerAscii (text : String) : String :=
  String.ofList (text.toList.map Char.toLower)

/-- String length in UTF-16 code units, as JavaScript counts it. -/
def utf16Length (text : String) : Nat :=
  text.toList.foldl (fun total c => total + (if c.toNat ≥ 65536 then 2 else 1)) 0

/-- A string's UTF-16 code units, as `charCodeAt` reads them. -/
def utf16Units (text : String) : List Nat :=
  text.toList.flatMap fun c =>
    let code := c.toNat
    if code ≥ 65536 then
      let offset := code - 65536
      [55296 + offset / 1024, 56320 + offset % 1024]
    else [code]

/-- Whether `text` contains `part`. -/
def includes (text part : String) : Bool :=
  part.isEmpty || (text.splitOn part).length > 1

/-- The text after the first occurrence of `part`, when it occurs. -/
def afterFirst (text part : String) : Option String :=
  match text.splitOn part with
  | _ :: rest@(_ :: _) => some (part.intercalate rest)
  | _ => none

/-- Drops leading slashes: `replace(/^\/+/, "")`. -/
def dropLeadingSlashes (text : String) : String :=
  String.ofList (text.toList.dropWhile (· == '/'))

/-- Drops trailing slashes: `replace(/\/+$/, "")`. -/
def dropTrailingSlashes (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile (· == '/')).reverse

/-- `replace(/^\/+|\/+$/g, "")`. -/
def stripSlashes (text : String) : String :=
  dropTrailingSlashes (dropLeadingSlashes text)

/-- `value?.trim() || undefined` for a string field. -/
def trimmedOrNone (value : Json) : Option String :=
  match value with
  | .str text =>
    let trimmed := jsTrim text
    if trimmed.isEmpty then none else some trimmed
  | _ => none

/-- A character of `[A-Z0-9_]`. -/
def isEnvNameChar (c : Char) : Bool :=
  ('A' ≤ c && c ≤ 'Z') || ('0' ≤ c && c ≤ '9') || c == '_'

/-- Reads one `${NAME}` at the front of `chars`, returning what follows. -/
def takeEnvRef (chars : List Char) : Option (List Char) :=
  match chars with
  | '$' :: '{' :: first :: rest =>
    if 'A' ≤ first && first ≤ 'Z' then
      let (_, after) := rest.span isEnvNameChar
      match after with
      | '}' :: tail => some tail
      | _ => none
    else none
  | _ => none

/-- `^\$\{([A-Z][A-Z0-9_]*)\}$`. -/
def isEnvRef (text : String) : Bool :=
  takeEnvRef text.toList == some []

/-- `\$\{([A-Z][A-Z0-9_]*)\}` anywhere in the text. -/
def hasEnvPlaceholder (text : String) : Bool :=
  (List.range text.length).any fun index => (takeEnvRef (text.toList.drop index)).isSome

/-- One or more `${NAME}` and nothing else. -/
def isEnvRefsOnly (chars : List Char) : Bool :=
  let rec go (fuel : Nat) (rest : List Char) : Bool :=
    match fuel, takeEnvRef rest with
    | 0, _ => false
    | _, none => false
    | _ + 1, some [] => true
    | fuel + 1, some tail => go fuel tail
  go chars.length chars

/-- `^(?:[A-Za-z]+ )?(?:\$\{[A-Z][A-Z0-9_]*\})+$`. -/
def isCredentialHeaderValue (text : String) : Bool :=
  let chars := text.toList
  let isLetter := fun c : Char => ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z')
  if isEnvRefsOnly chars then true
  else
    let (word, rest) := chars.span isLetter
    match rest with
    | ' ' :: tail => !word.isEmpty && isEnvRefsOnly tail
    | _ => false

/-! ## Numbers -/

/-- A number's exact integer value, when it has one. -/
def intOf (number : JsonNumber) : Option Int :=
  let scale : Int := (10 ^ number.exponent : Nat)
  if number.mantissa % scale == 0 then some (number.mantissa / scale) else none

/-- `a ≤ b` on JSON numbers. -/
def numLe (a b : JsonNumber) : Bool :=
  a.mantissa * ((10 ^ b.exponent : Nat) : Int) ≤ b.mantissa * ((10 ^ a.exponent : Nat) : Int)

/-- A number with no trailing zeros in its fraction. -/
def numNormal (number : JsonNumber) : JsonNumber :=
  let rec go (fuel : Nat) (mantissa : Int) (exponent : Nat) : JsonNumber :=
    match fuel, exponent with
    | fuel + 1, exponent + 1 =>
      if mantissa % 10 == 0 then go fuel (mantissa / 10) exponent
      else ⟨mantissa, exponent + 1⟩
    | _, _ => ⟨mantissa, exponent⟩
  go number.exponent number.mantissa number.exponent

/-- A number from an integer. -/
def numOfInt (value : Int) : JsonNumber :=
  ⟨value, 0⟩

/-- `Number.isSafeInteger(value) && value >= 1`. -/
def isPositiveSafeInt (value : Json) : Bool :=
  match value with
  | .num number =>
    match intOf number with
    | some whole => 1 ≤ whole && whole ≤ 9007199254740991
    | none => false
  | _ => false

/-- A JSON number written the way a template literal writes it, for the magnitudes these functions see. -/
def numText (number : JsonNumber) : String :=
  (Json.num (numNormal number)).compress

/-- What `Number(text)` gives on text holding no whitespace. `unmodelled` covers hex, octal and binary
forms, and values with more digits than a double holds exactly. -/
inductive JsNumber where
  | exact (value : JsonNumber)
  | notFinite
  | unmodelled

/-- Digits to a natural number. -/
def digitsValue (digits : List Char) : Nat :=
  digits.foldl (fun total c => total * 10 + (c.toNat - 48)) 0

/-- `Number(text)` for text with no whitespace. -/
def jsNumber (text : String) : JsNumber :=
  let chars := text.toList
  let (negative, body) :=
    match chars with
    | '-' :: rest => (true, rest)
    | '+' :: rest => (false, rest)
    | _ => (false, chars)
  let (whole, afterWhole) := body.span Char.isDigit
  let (fraction, afterFraction) :=
    match afterWhole with
    | '.' :: rest => rest.span Char.isDigit
    | rest => ([], rest)
  let build := fun (exponent : Int) (rest : List Char) =>
    if !rest.isEmpty then JsNumber.notFinite
    else
      let digits := digitsValue (whole ++ fraction)
      let shift := exponent - (fraction.length : Int)
      if digits ≥ 1000000000000000 || shift > 20 || shift < -20 then JsNumber.unmodelled
      else
        let scaled : Nat := if shift ≥ 0 then digits * 10 ^ shift.toNat else digits
        let mantissa : Int := if negative then -(scaled : Int) else (scaled : Int)
        JsNumber.exact (numNormal ⟨mantissa, if shift ≥ 0 then 0 else (-shift).toNat⟩)
  if body == "Infinity".toList then .notFinite
  else if whole.isEmpty && fraction.isEmpty then
    .notFinite
  else
    match whole, afterFraction with
    | ['0'], c :: _ =>
      if "xXoObB".toList.contains c then .unmodelled
      else if c == 'e' || c == 'E' then
        match afterFraction.drop 1 with
        | '-' :: rest =>
          let (digits, tail) := rest.span Char.isDigit
          if digits.isEmpty then .notFinite else build (-(digitsValue digits : Int)) tail
        | '+' :: rest =>
          let (digits, tail) := rest.span Char.isDigit
          if digits.isEmpty then .notFinite else build (digitsValue digits : Int) tail
        | rest =>
          let (digits, tail) := rest.span Char.isDigit
          if digits.isEmpty then .notFinite else build (digitsValue digits : Int) tail
      else .notFinite
    | _, 'e' :: rest | _, 'E' :: rest =>
      match rest with
      | '-' :: more =>
        let (digits, tail) := more.span Char.isDigit
        if digits.isEmpty then .notFinite else build (-(digitsValue digits : Int)) tail
      | '+' :: more =>
        let (digits, tail) := more.span Char.isDigit
        if digits.isEmpty then .notFinite else build (digitsValue digits : Int) tail
      | more =>
        let (digits, tail) := more.span Char.isDigit
        if digits.isEmpty then .notFinite else build (digitsValue digits : Int) tail
    | _, rest => build 0 rest

/-! ## URLs -/

/-- The parts of a parsed URL these functions read. Outside `http`-like schemes only `protocol` is set. -/
structure Url where
  protocol : String
  username : String := ""
  password : String := ""
  hostname : String := ""
  port : String := ""
  pathname : String := ""
  search : String := ""
  hash : String := ""

/-- `new URL(text)`: parsed, thrown, or a form this parser leaves out. -/
inductive UrlParse where
  | ok (url : Url)
  | invalid
  | unmodelled

/-- A character allowed in a host this parser takes as written. -/
def isPlainHostChar (c : Char) : Bool :=
  ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z') || ('0' ≤ c && c ≤ '9') || c == '.' || c == '-' || c == '_'

/-- One decimal IPv4 part in canonical form. -/
def isIpv4Part (part : String) : Bool :=
  let chars := part.toList
  !chars.isEmpty && chars.all Char.isDigit && digitsValue chars ≤ 255 &&
    (chars.length == 1 || chars.head? != some '0')

/-- The host's last label reads as a number, which sends WHATWG to its IPv4 parser. -/
def endsInNumber (host : String) : Bool :=
  let labels := (host.splitOn ".").reverse
  let last := match labels with
    | "" :: previous :: _ => previous
    | label :: _ => label
    | [] => ""
  let chars := last.toList
  (!chars.isEmpty && chars.all Char.isDigit) ||
    (match chars with
     | '0' :: x :: _ => x == 'x' || x == 'X'
     | _ => false)

/-- A special-scheme host in canonical form, or none when this parser leaves it out. -/
def plainHost (host : String) : Option String :=
  let lower := lowerAscii host
  if !host.toList.all isPlainHostChar || includes lower "xn--" then none
  else if endsInNumber lower then
    let parts := lower.splitOn "."
    if parts.length == 4 && parts.all isIpv4Part then some lower else none
  else some lower

/-- An IPv6 literal the URL serializer would leave unchanged, lowercased, or none. -/
def canonicalIpv6 (literal : String) : Option String :=
  let lower := lowerAscii literal
  if lower == "::" || lower == "::1" then some lower
  else if includes lower "." then none
  else
    match lower.splitOn "::" with
    | [head, tail] =>
      let groups := (head.splitOn ":") ++ (tail.splitOn ":")
      let named := groups.filter (· != "")
      let goodGroup := fun group : String =>
        let chars := group.toList
        !chars.isEmpty && chars.length ≤ 4 && chars.head? != some '0' &&
          chars.all fun c => ('0' ≤ c && c ≤ '9') || ('a' ≤ c && c ≤ 'f')
      if named.all goodGroup && named.length ≤ 6 then some lower else none
    | _ => none

/-- The default port of a special scheme. -/
def defaultPort (scheme : String) : Nat :=
  match scheme with
  | "http" | "ws" => 80
  | "https" | "wss" => 443
  | _ => 21

/-- Splits `host` and `port` out of an authority's last part. -/
def parseHostPort (scheme : String) (hostPort : List Char) : Option (Option (String × String)) :=
  let portOf := fun (digits : List Char) =>
    if !digits.all Char.isDigit then none
    else if digits.isEmpty then some ""
    else
      let value := digitsValue digits
      if value > 65535 then none
      else if value == defaultPort scheme then some ""
      else some (toString value)
  match hostPort with
  | '[' :: rest =>
    let (literal, after) := rest.span (· != ']')
    match after with
    | [']'] =>
      some ((canonicalIpv6 (String.ofList literal)).map fun host => (s!"[{host}]", ""))
    | ']' :: ':' :: digits =>
      match portOf digits with
      | none => none
      | some port => some ((canonicalIpv6 (String.ofList literal)).map fun host => (s!"[{host}]", port))
    | _ => some none
  | _ =>
    let (hostChars, after) := hostPort.span (· != ':')
    let port := match after with
      | ':' :: digits => portOf digits
      | _ => some ""
    if hostChars.isEmpty then none
    else
      match port with
      | none => none
      | some port => some ((plainHost (String.ofList hostChars)).map fun host => (host, port))

/-- A URL with a special scheme, from what follows the colon. -/
def parseSpecial (scheme : String) (rest : List Char) : UrlParse :=
  let body := rest.dropWhile fun c => c == '/' || c == '\\'
  let (authority, afterAuthority) := body.span fun c => c != '/' && c != '\\' && c != '?' && c != '#'
  let reversed := authority.reverse
  let (hostPortReversed, credentials) := reversed.span (· != '@')
  let hostPort := hostPortReversed.reverse
  let userinfo := (credentials.drop 1).reverse
  let (username, passwordPart) := userinfo.span (· != ':')
  let password := passwordPart.drop 1
  match parseHostPort scheme hostPort with
  | none => .invalid
  | some none => .unmodelled
  | some (some (hostname, port)) =>
    let (pathChars, afterPath) := afterAuthority.span fun c => c != '?' && c != '#'
    let (queryChars, afterQuery) := afterPath.span (· != '#')
    let segments := (String.ofList pathChars).splitOn "/"
    let dotted := segments.any fun segment =>
      let lower := lowerAscii segment
      lower == "." || lower == ".." || includes lower "%2e"
    if pathChars.contains '\\' || dotted then .unmodelled
    else
      let pathname := if pathChars.isEmpty then "/" else String.ofList pathChars
      .ok {
        protocol := s!"{scheme}:"
        username := String.ofList username
        password := String.ofList password
        hostname := hostname
        port := port
        pathname := pathname
        search := if queryChars.length ≤ 1 then "" else String.ofList queryChars
        hash := if afterQuery.length ≤ 1 then "" else String.ofList afterQuery
      }

/-- `new URL(text)` with no base. -/
def parseUrl (text : String) : UrlParse :=
  let chars := text.toList
  let isControl := fun c : Char => c == '\t' || c == '\n' || c == '\r'
  match chars with
  | [] => .invalid
  | first :: _ =>
    if first.toNat ≤ 32 || chars.any isControl then .unmodelled
    else if !first.isAlpha then .invalid
    else
      let (schemeChars, after) := chars.span fun c =>
        (c.toNat < 128 && c.isAlphanum) || c == '+' || c == '-' || c == '.'
      match after with
      | ':' :: rest =>
        let scheme := lowerAscii (String.ofList schemeChars)
        if rest.any fun c => c.toNat ≤ 32 || c.toNat ≥ 127 then .unmodelled
        else if ["http", "https", "ws", "wss", "ftp"].contains scheme then parseSpecial scheme rest
        else if scheme == "file" then .unmodelled
        else
          match rest with
          | '/' :: '/' :: tail =>
            let (authority, _) := tail.span fun c => c != '/' && c != '?' && c != '#'
            let odd := authority.any fun c => "@[]%^|<>\\:".toList.contains c
            if odd then .unmodelled else .ok { protocol := s!"{scheme}:" }
          | _ => .ok { protocol := s!"{scheme}:" }
      | _ => .invalid

/-- agentRules.ts `isPrivateHostname`: one trailing dot is dropped after the brackets. -/
def isPrivateHostname (hostname : String) : Bool :=
  let lowered := (lowerAscii hostname).toList
  let noOpen := match lowered with
    | '[' :: rest => rest
    | all => all
  let bare := match noOpen.reverse with
    | ']' :: rest => rest.reverse
    | _ => noOpen
  let host := String.ofList (match bare.reverse with
    | '.' :: rest => rest.reverse
    | _ => bare)
  if host == "localhost" || host.endsWith ".localhost" || host.endsWith ".local" || host.endsWith ".internal" then
    true
  else
    let parts := host.splitOn "."
    let isQuad := parts.length == 4 && parts.all fun part =>
      let digits := part.toList
      1 ≤ digits.length && digits.length ≤ 3 && digits.all Char.isDigit
    if isQuad then
      let a := digitsValue (parts.getD 0 "").toList
      let b := digitsValue (parts.getD 1 "").toList
      a == 0 || a == 10 || a == 127 || (a == 100 && 64 ≤ b && b ≤ 127) || (a == 169 && b == 254) ||
        (a == 172 && 16 ≤ b && b ≤ 31) || (a == 192 && b == 168)
    else if includes host ":" then
      let chars := host.toList
      host == "::" || host == "::1" || host.startsWith "::ffff:" ||
        (match chars with
         | 'f' :: c :: _ => c == 'c' || c == 'd'
         | _ => false) ||
        (match chars with
         | 'f' :: 'e' :: c :: _ => ['8', '9', 'a', 'b'].contains c
         | _ => false)
    else false

/-- `publicHttpsUrlProblem`: the reason a value is no public https URL. -/
def publicHttpsUrlProblem (value : String) : R (Option String) :=
  match parseUrl value with
  | .invalid => pure (some "must be a valid URL")
  | .unmodelled => unsup "a URL form the parser leaves out"
  | .ok url =>
    if url.protocol != "https:" then pure (some "must use https")
    else if isPrivateHostname url.hostname then pure (some "must not point to a private or internal address")
    else pure none

/-- agentRules.ts `assertPublicHttpsUrl`, returning the parsed URL. -/
def assertPublicHttpsUrl (value label : String) : R Url := do
  match ← publicHttpsUrlProblem value with
  | some problem => fail s!"{label} {problem}"
  | none =>
    match parseUrl value with
    | .ok url => pure url
    | _ => unsup "a URL form the parser leaves out"

/-! ## SHA-256 and encodings -/

/-- The SHA-256 round constants. -/
def sha256K : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

/-- Rotates a word right. -/
def rotr (word : UInt32) (count : UInt32) : UInt32 :=
  (word >>> count) ||| (word <<< (32 - count))

/-- Adds one 64-byte block at `start` to the hash state. -/
def sha256Block (state : Array UInt32) (bytes : Array UInt8) (start : Nat) : Array UInt32 := Id.run do
  let mut schedule : Array UInt32 := Array.replicate 64 0
  for index in [0:16] do
    let at4 := fun (offset : Nat) => (bytes.getD (start + index * 4 + offset) 0).toUInt32
    schedule := schedule.set! index
      ((at4 0 <<< 24) ||| (at4 1 <<< 16) ||| (at4 2 <<< 8) ||| at4 3)
  for index in [16:64] do
    let w15 := schedule.getD (index - 15) 0
    let w2 := schedule.getD (index - 2) 0
    let s0 := rotr w15 7 ^^^ rotr w15 18 ^^^ (w15 >>> 3)
    let s1 := rotr w2 17 ^^^ rotr w2 19 ^^^ (w2 >>> 10)
    schedule := schedule.set! index (schedule.getD (index - 16) 0 + s0 + schedule.getD (index - 7) 0 + s1)
  let mut a := state.getD 0 0
  let mut b := state.getD 1 0
  let mut c := state.getD 2 0
  let mut d := state.getD 3 0
  let mut e := state.getD 4 0
  let mut f := state.getD 5 0
  let mut g := state.getD 6 0
  let mut h := state.getD 7 0
  for index in [0:64] do
    let s1 := rotr e 6 ^^^ rotr e 11 ^^^ rotr e 25
    let choice := (e &&& f) ^^^ (~~~e &&& g)
    let t1 := h + s1 + choice + sha256K.getD index 0 + schedule.getD index 0
    let s0 := rotr a 2 ^^^ rotr a 13 ^^^ rotr a 22
    let majority := (a &&& b) ^^^ (a &&& c) ^^^ (b &&& c)
    let t2 := s0 + majority
    h := g
    g := f
    f := e
    e := d + t1
    d := c
    c := b
    b := a
    a := t1 + t2
  return #[state.getD 0 0 + a, state.getD 1 0 + b, state.getD 2 0 + c, state.getD 3 0 + d,
    state.getD 4 0 + e, state.getD 5 0 + f, state.getD 6 0 + g, state.getD 7 0 + h]

/-- SHA-256 of a byte list. -/
def sha256 (message : List UInt8) : List UInt8 := Id.run do
  let bitLength := message.length * 8
  let zeros := (120 - (message.length + 1) % 64) % 64
  let lengthBytes := (List.range 8).reverse.map fun shift => (bitLength >>> (shift * 8)).toUInt8
  let padded := (message ++ [0x80] ++ List.replicate zeros 0 ++ lengthBytes).toArray
  let mut state : Array UInt32 := #[0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  for block in [0:padded.size / 64] do
    state := sha256Block state padded (block * 64)
  return state.toList.flatMap fun (word : UInt32) =>
    [(word >>> 24).toUInt8, (word >>> 16).toUInt8, (word >>> 8).toUInt8, word.toUInt8]

/-- Bytes as lowercase hex. -/
def hexOf (bytes : List UInt8) : String :=
  let digit := fun (value : Nat) => Nat.digitChar value
  String.ofList (bytes.flatMap fun byte => [digit (byte.toNat / 16), digit (byte.toNat % 16)])

/-- A string's UTF-8 bytes. -/
def utf8Bytes (text : String) : List UInt8 :=
  text.toUTF8.toList

/-- runtime-keys.ts `normalizeFilesystemNamespace`. -/
def filesystemNamespace (key : String) : String :=
  let digest := hexOf (sha256 (utf8Bytes s!"filesystem-namespace\x00{key}"))
  s!"fs-{String.ofList (digest.toList.take 40)}"

/-- runtime-keys.ts `agentNamespaceFolder`. -/
def agentNamespaceFolder (agentId : String) : String :=
  s!"agent/{filesystemNamespace agentId}"

/-- Base64 with padding. -/
def base64 (bytes : List UInt8) : String :=
  let table := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray
  let letter := fun (index : Nat) => table.getD index 'A'
  let rec go (fuel : Nat) (rest : List UInt8) : List Char :=
    match fuel, rest with
    | 0, _ => []
    | _, [] => []
    | _ + 1, [a] =>
      [letter (a.toNat / 4), letter ((a.toNat % 4) * 16), '=', '=']
    | _ + 1, [a, b] =>
      [letter (a.toNat / 4), letter ((a.toNat % 4) * 16 + b.toNat / 16), letter ((b.toNat % 16) * 4), '=']
    | fuel + 1, a :: b :: c :: tail =>
      [letter (a.toNat / 4), letter ((a.toNat % 4) * 16 + b.toNat / 16),
        letter ((b.toNat % 16) * 4 + c.toNat / 64), letter (c.toNat % 64)] ++ go fuel tail
  String.ofList (go bytes.length bytes)

end Spec.Sandbox.Rt
