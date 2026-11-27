import Lean.Data.Json
import Spec.Twin

/-!
JavaScript semantics the twins share: JSON access, `String.trim`, `JSON.stringify`, a small backtracking
regex matcher, base64url, SHA-256 and the WHATWG URL parser's host rules. Recursion over JSON carries an
explicit budget, since `partial` is forbidden in `Spec/`.
-/

namespace Spec.Js

open Lean

/-- Recursion budget for JSON values, far deeper than any config. -/
def depth : Nat := 256

/-- `Object.entries`, in key order: the recording's insertion order is not visible to a twin. -/
def entries : Json → List (String × Json)
  | .obj kvs => kvs.toList
  | _ => []

/-- The own property `key`, or none for `undefined`. -/
def field? (value : Json) (key : String) : Option Json :=
  match value with
  | .obj kvs => kvs.get? key
  | _ => none

/-- `value[key] !== undefined`. -/
def has (value : Json) (key : String) : Bool :=
  (field? value key).isSome

/-- `value[key]`, with `undefined` as JSON null. -/
def get (value : Json) (key : String) : Json :=
  (field? value key).getD .null

def set (value : Json) (key : String) (item : Json) : Json :=
  match value with
  | .obj kvs => .obj (kvs.insert key item)
  | _ => Json.mkObj [(key, item)]

def del (value : Json) (key : String) : Json :=
  match value with
  | .obj kvs => .obj (kvs.erase key)
  | other => other

/-- Sets `key` when `item` is defined. -/
def setOpt (value : Json) (key : String) (item : Option Json) : Json :=
  match item with
  | some present => set value key present
  | none => value

def empty : Json := Json.mkObj []

/-- `{...left, ...right}`. -/
def spread (left right : Json) : Json :=
  (entries right).foldl (fun acc (key, item) => set acc key item) (match left with | .obj _ => left | _ => empty)

def isObj : Json → Bool
  | .obj _ => true
  | _ => false

def isArr : Json → Bool
  | .arr _ => true
  | _ => false

def isStr : Json → Bool
  | .str _ => true
  | _ => false

def isNum : Json → Bool
  | .num _ => true
  | _ => false

def isBool : Json → Bool
  | .bool _ => true
  | _ => false

/-- `typeof value === "object" && value !== null`, arrays included. -/
def isObjectLike : Json → Bool
  | .obj _ | .arr _ => true
  | _ => false

def str? : Json → Option String
  | .str s => some s
  | _ => none

def arr? : Json → Option (List Json)
  | .arr items => some items.toList
  | _ => none

/-- JavaScript truthiness of a JSON value. -/
def truthy : Json → Bool
  | .null => false
  | .bool b => b
  | .num n => n.mantissa != 0
  | .str s => !s.isEmpty
  | _ => true

/-- JavaScript truthiness of a possibly undefined value. -/
def truthyOpt : Option Json → Bool
  | some value => truthy value
  | none => false

/-- `a ?? b` on JSON values, where a recorded undefined is null. -/
def orElse (value fallback : Json) : Json :=
  if value == .null then fallback else value

/-- The value as an integer, when it is one. -/
def int? : Json → Option Int
  | .num n =>
    if n.exponent == 0 then some n.mantissa
    else if n.mantissa % (10 ^ n.exponent : Int) == 0 then some (n.mantissa / (10 ^ n.exponent : Int))
    else none
  | _ => none

/-- `Number.isSafeInteger`. -/
def safeInt? (value : Json) : Option Int :=
  (int? value).bind fun n =>
    if -9007199254740991 ≤ n && n ≤ 9007199254740991 then some n else none

/-- The value as a natural number, when it is one. -/
def nat? (value : Json) : Option Nat :=
  (int? value).bind fun n => if 0 ≤ n then some n.toNat else none

/-- `Math.ceil` of a JSON number. -/
def ceil (n : JsonNumber) : Int :=
  let scale : Int := 10 ^ n.exponent
  let floor := n.mantissa / scale
  if n.mantissa % scale == 0 then floor else floor + 1

/-- A number compared to an integer: `n >= bound`. -/
def numGe (n : JsonNumber) (bound : Int) : Bool :=
  n.mantissa ≥ bound * (10 ^ n.exponent : Int)

/-- `value === null` for a value that may be undefined. -/
def isNull : Option Json → Bool
  | some .null => true
  | _ => false

/-- `value == null`. -/
def nullish : Option Json → Bool
  | none | some .null => true
  | _ => false

/-- Unicode whitespace as `String.prototype.trim` defines it. -/
def isSpace (c : Char) : Bool :=
  let v := c.toNat
  v == 9 || v == 10 || v == 11 || v == 12 || v == 13 || v == 32 || v == 0xA0 || v == 0x1680 ||
    (0x2000 ≤ v && v ≤ 0x200A) || v == 0x2028 || v == 0x2029 || v == 0x202F || v == 0x205F ||
    v == 0x3000 || v == 0xFEFF

def trimStartChars : List Char → List Char
  | c :: rest => if isSpace c then trimStartChars rest else c :: rest
  | [] => []

/-- `String.prototype.trimEnd`. -/
def trimEnd (s : String) : String :=
  String.ofList (trimStartChars s.toList.reverse).reverse

/-- `String.prototype.trim`. -/
def trim (s : String) : String :=
  String.ofList (trimStartChars (trimStartChars s.toList).reverse).reverse

/-- `String.prototype.startsWith` from character `start`. -/
def startsWithAt (s : List Char) (prefixChars : List Char) : Bool :=
  prefixChars.isPrefixOf s

/-- `[...new Set(items)]`. -/
def dedupe (items : List Json) : List Json :=
  (items.foldl (fun acc item => if acc.contains item then acc else item :: acc) []).reverse

/-- Number formatted as `String(number)` for the ordinary range. -/
def numString (n : JsonNumber) : String :=
  n.toString

/-- `String(value)` where the answer does not depend on object identity. -/
def string? : Option Json → Option String
  | none => some "undefined"
  | some .null => some "null"
  | some (.bool b) => some (if b then "true" else "false")
  | some (.num n) => some (numString n)
  | some (.str s) => some s
  | some _ => none

private def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

/-- Lowercase hex of the bytes, as `hexFromBytes`. -/
def hex (bytes : List Nat) : String :=
  String.ofList (bytes.flatMap fun b => [hexDigit (b / 16 % 16), hexDigit (b % 16)])

private def quoteChar (c : Char) : String :=
  match c with
  | '"' => "\\\""
  | '\\' => "\\\\"
  | '\n' => "\\n"
  | '\r' => "\\r"
  | '\t' => "\\t"
  | _ =>
    let v := c.toNat
    if v == 8 then "\\b"
    else if v == 12 then "\\f"
    else if v < 32 then "\\u00" ++ String.ofList [hexDigit (v / 16), hexDigit (v % 16)]
    else c.toString

/-- `JSON.stringify` of a string. -/
def quote (s : String) : String :=
  "\"" ++ String.join (s.toList.map quoteChar) ++ "\""

/-- `JSON.stringify` with keys in code-point order. -/
def stringifyWith : Nat → Json → String
  | 0, _ => "null"
  | fuel + 1, value =>
    match value with
    | .null => "null"
    | .bool b => if b then "true" else "false"
    | .num n => numString n
    | .str s => quote s
    | .arr items => "[" ++ ",".intercalate (items.toList.map (stringifyWith fuel)) ++ "]"
    | .obj kvs =>
      "{" ++ ",".intercalate (kvs.toList.map fun (key, item) =>
        quote key ++ ":" ++ stringifyWith fuel item) ++ "}"

def stringify (value : Json) : String :=
  stringifyWith depth value

/-- A backtracking regular expression over characters. `.back` tests the previous character. -/
inductive Re where
  | any (p : Char → Bool)
  | seq (a b : Re)
  | alt (a b : Re)
  | star (a : Re) (greedy : Bool)
  | eps
  | bol
  | eol
  | notBack (p : Char → Bool)
  | wordB
  | notAhead (a : Re)

namespace Re

def lit (s : String) : Re :=
  s.toList.foldr (fun c acc => .seq (.any (· == c)) acc) .eps

def seqs (parts : List Re) : Re :=
  parts.foldr .seq .eps

def plus (a : Re) : Re :=
  .seq a (.star a true)

def opt (a : Re) : Re :=
  .alt a .eps

private def isWord (c : Char) : Bool :=
  (c.isAlphanum && c.toNat < 128) || c == '_'

private def at? (s : Array Char) (i : Nat) : Option Char :=
  s[i]?

/-- Runs `re` at `i`, handing each match's end to `k`. Budget exhaustion fails the branch. -/
def go (s : Array Char) : Nat → Re → Nat → (Nat → Bool) → Bool
  | 0, _, _, _ => false
  | fuel + 1, re, i, k =>
    match re with
    | .any p => match at? s i with
      | some c => p c && k (i + 1)
      | none => false
    | .seq a b => go s fuel a i fun j => go s fuel b j k
    | .alt a b => go s fuel a i k || go s fuel b i k
    | .star a greedy =>
      let more := go s fuel a i fun j => j != i && go s fuel (.star a greedy) j k
      if greedy then more || k i else k i || more
    | .eps => k i
    | .bol => i == 0 && k i
    | .eol => i == s.size && k i
    | .notBack p =>
      (if i == 0 then true else match at? s (i - 1) with
        | some c => !p c
        | none => true) && k i
    | .wordB =>
      let before := if i == 0 then false else match at? s (i - 1) with
        | some c => isWord c
        | none => false
      let after := match at? s i with
        | some c => isWord c
        | none => false
      before != after && k i
    | .notAhead a => !(go s fuel a i fun _ => true) && k i

/-- `pattern.test(text)`. -/
def test (re : Re) (text : String) : Bool :=
  let s := text.toList.toArray
  let fuel := 4 * s.size + 400
  (List.range (s.size + 1)).any fun i => go s fuel re i fun _ => true

/-- A whole-string match, as `/^...$/.test(text)`. -/
def full (re : Re) (text : String) : Bool :=
  let s := text.toList.toArray
  go s (4 * s.size + 400) re 0 fun j => j == s.size

end Re

def isAsciiDigit (c : Char) : Bool :=
  '0' ≤ c && c ≤ '9'

def isAsciiAlpha (c : Char) : Bool :=
  ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z')

def isAsciiAlnum (c : Char) : Bool :=
  isAsciiDigit c || isAsciiAlpha c

def isHexDigit (c : Char) : Bool :=
  isAsciiDigit c || ('a' ≤ c && c ≤ 'f') || ('A' ≤ c && c ≤ 'F')

/-- A JavaScript regex `\s`. -/
def reSpace : Re :=
  .any isSpace

/-- Non-empty and every character satisfies `p`. -/
def allChars (p : Char → Bool) (s : String) : Bool :=
  !s.isEmpty && s.toList.all p

/-- ASCII lowercase. Non-ASCII letters are left alone, which no recorded value reaches. -/
def lower (s : String) : String :=
  s.toLower

private def base64Url : List Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toList

private def b64 (n : Nat) : Char :=
  base64Url.getD (n % 64) 'A'

/-- Base64url with no padding. -/
def base64UrlEncode : List Nat → List Char
  | a :: b :: c :: rest =>
    [b64 (a / 4), b64 ((a % 4) * 16 + b / 16), b64 ((b % 16) * 4 + c / 64), b64 c] ++
      base64UrlEncode rest
  | [a, b] => [b64 (a / 4), b64 ((a % 4) * 16 + b / 16), b64 ((b % 16) * 4)]
  | [a] => [b64 (a / 4), b64 ((a % 4) * 16)]
  | [] => []

/-- UTF-8 of a string. -/
def utf8 (s : String) : List Nat :=
  s.toUTF8.toList.map UInt8.toNat

private def sha256K : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

private def rotr (x : UInt32) (n : UInt32) : UInt32 :=
  (x >>> n) ||| (x <<< (32 - n))

private def word (a b c d : Nat) : UInt32 :=
  UInt32.ofNat ((a <<< 24) + (b <<< 16) + (c <<< 8) + d)

private def schedule (block : List Nat) : Array UInt32 :=
  let rec first : List Nat → List UInt32
    | a :: b :: c :: d :: rest => word a b c d :: first rest
    | _ => []
  let initial := (first block).toArray
  (List.range 48).foldl (fun w t =>
    let i := t + 16
    let w15 := w[i - 15]!
    let w2 := w[i - 2]!
    let s0 := rotr w15 7 ^^^ rotr w15 18 ^^^ (w15 >>> 3)
    let s1 := rotr w2 17 ^^^ rotr w2 19 ^^^ (w2 >>> 10)
    w.push (w[i - 16]! + s0 + w[i - 7]! + s1)) initial

private def compress (state : Array UInt32) (block : List Nat) : Array UInt32 :=
  let w := schedule block
  let finalState := (List.range 64).foldl (fun (s : Array UInt32) t =>
    let a := s[0]!
    let b := s[1]!
    let c := s[2]!
    let e := s[4]!
    let f := s[5]!
    let g := s[6]!
    let s1 := rotr e 6 ^^^ rotr e 11 ^^^ rotr e 25
    let ch := (e &&& f) ^^^ ((~~~e) &&& g)
    let t1 := s[7]! + s1 + ch + sha256K[t]! + w[t]!
    let s0 := rotr a 2 ^^^ rotr a 13 ^^^ rotr a 22
    let maj := (a &&& b) ^^^ (a &&& c) ^^^ (b &&& c)
    #[t1 + s0 + maj, a, b, c, s[3]! + t1, e, f, g]) state
  (List.range 8).toArray.map fun i => state[i]! + finalState[i]!

private def blocks : Nat → List Nat → List (List Nat)
  | 0, _ => []
  | fuel + 1, bytes =>
    if bytes.isEmpty then [] else bytes.take 64 :: blocks fuel (bytes.drop 64)

/-- SHA-256 of the bytes. -/
def sha256 (bytes : List Nat) : List Nat :=
  let size := bytes.length
  let padding := (64 + 55 - size % 64) % 64
  let bitLength := size * 8
  let lengthBytes := (List.range 8).reverse.map fun i => (bitLength >>> (8 * i)) % 256
  let padded := bytes ++ [0x80] ++ List.replicate padding 0 ++ lengthBytes
  let initial : Array UInt32 := #[0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  let state := (blocks padded.length padded).foldl compress initial
  state.toList.flatMap fun w =>
    let v := w.toNat
    [v / 16777216 % 256, v / 65536 % 256, v / 256 % 256, v % 256]

/-- The hex SHA-256 of a string's UTF-8. -/
def sha256Hex (s : String) : String :=
  hex (sha256 (utf8 s))

/-- `conform.ts` crashes on a bare `null` output, so null results are reported as uncompared. Every
twin here goes through this, so returning null again is a one-line change once that is fixed. -/
def guardNull (twin : Spec.Twin) : Spec.Twin :=
  { twin with
    run := fun args =>
      match twin.run args with
      | .null => Spec.Twin.unsupported "null result"
      | other => other }

end Spec.Js

namespace Spec.Url

open Spec.Js

/-- What `new URL(value)` exposes, without a base. -/
structure Url where
  protocol : String
  hostname : String
  port : String
  pathname : String
  search : String
  hash : String
  username : String
  password : String
  deriving Inhabited

/-- `new URL` throws, succeeds, or does something this parser does not model. -/
inductive Parsed where
  | invalid
  | ok (url : Url)
  | unknown (reason : String)

private def isC0OrSpace (c : Char) : Bool :=
  c.toNat ≤ 32

private def dropC0 : List Char → List Char
  | c :: rest => if isC0OrSpace c then dropC0 rest else c :: rest
  | [] => []

private def splitFirst (p : Char → Bool) (s : List Char) : List Char × List Char :=
  (s.takeWhile (fun c => !p c), s.dropWhile (fun c => !p c))

private def isSpecial (scheme : String) : Bool :=
  ["http", "https", "ws", "wss", "ftp"].contains scheme

private def defaultPort (scheme : String) : String :=
  match scheme with
  | "http" | "ws" => "80"
  | "https" | "wss" => "443"
  | "ftp" => "21"
  | _ => ""

private def hexValue (c : Char) : Nat :=
  if isAsciiDigit c then c.toNat - 48
  else if 'a' ≤ c && c ≤ 'f' then c.toNat - 87
  else c.toNat - 55

private def percentDecode : Nat → List Char → Option (List Char)
  | 0, _ => some []
  | _ + 1, [] => some []
  | fuel + 1, '%' :: a :: b :: rest =>
    if isHexDigit a && isHexDigit b then
      let byte := hexValue a * 16 + hexValue b
      if byte < 128 then (percentDecode fuel rest).map (Char.ofNat byte :: ·) else none
    else ('%' :: ·) <$> percentDecode fuel (a :: b :: rest)
  | fuel + 1, c :: rest => (c :: ·) <$> percentDecode fuel rest

private def isForbiddenHost (c : Char) : Bool :=
  let v := c.toNat
  v ≤ 32 || v == 127 || "#/:<>?@[\\]^|%".toList.contains c

/-- One part of a dotted IPv4 host: decimal, `0x` hex or leading-zero octal. -/
private def ipv4Part (part : String) : Option Nat :=
  let chars := part.toList
  match chars with
  | [] => none
  | '0' :: x :: rest =>
    if x == 'x' || x == 'X' then
      if rest.all isHexDigit then some (rest.foldl (fun acc c => acc * 16 + hexValue c) 0) else none
    else if (x :: rest).all (fun c => '0' ≤ c && c ≤ '7') then
      some ((x :: rest).foldl (fun acc c => acc * 8 + (c.toNat - 48)) 0)
    else none
  | _ => if chars.all isAsciiDigit then part.toNat? else none

private def endsInNumber (host : String) : Bool :=
  let parts := host.splitOn "."
  let parts := if parts.getLast? == some "" then parts.dropLast else parts
  match parts.getLast? with
  | none => false
  | some last =>
    (allChars isAsciiDigit last) ||
      (match last.toList with
       | '0' :: x :: rest => (x == 'x' || x == 'X') && rest.all isHexDigit
       | _ => false)

private def parseIpv4 (host : String) : Option String :=
  let parts := host.splitOn "."
  let parts := if parts.getLast? == some "" then parts.dropLast else parts
  if parts.length > 4 || parts.isEmpty then none else
  match parts.mapM ipv4Part with
  | none => none
  | some numbers =>
    let front := numbers.dropLast
    let last := numbers.getLastD 0
    if front.any (· > 255) then none
    else if last >= 256 ^ (5 - numbers.length) then none
    else
      let value := (front.zipIdx).foldl (fun acc (n, i) => acc + n * 256 ^ (3 - i)) last
      some (".".intercalate
        ([value / 16777216 % 256, value / 65536 % 256, value / 256 % 256, value % 256].map toString))

/-- One IPv6 hex group. -/
private def ipv6Group (group : String) : Option Nat :=
  if group.isEmpty || group.length > 4 || !group.toList.all isHexDigit then none
  else some (group.toList.foldl (fun acc c => acc * 16 + hexValue c) 0)

/-- A trailing dotted quad as two groups. -/
private def embeddedIpv4 (group : String) : Option (List Nat) :=
  let parts := group.splitOn "."
  if parts.length != 4 then none else
  match parts.mapM (fun p =>
      if allChars isAsciiDigit p && p.length ≤ 3 && (p.length == 1 || !p.startsWith "0")
      then p.toNat? else none) with
  | some [a, b, c, d] =>
    if a > 255 || b > 255 || c > 255 || d > 255 then none
    else some [a * 256 + b, c * 256 + d]
  | _ => none

private def ipv6Groups (text : String) : Option (List Nat) :=
  if text.isEmpty then some [] else
  let parts := text.splitOn ":"
  let front := parts.dropLast
  let last := parts.getLastD ""
  match front.mapM ipv6Group with
  | none => none
  | some head =>
    if last.contains '.' then (embeddedIpv4 last).map (head ++ ·)
    else (ipv6Group last).map fun tail => head ++ [tail]

private def hexGroup (n : Nat) : String :=
  String.ofList (Nat.toDigits 16 n)

/-- The longest run of at least two zero groups, first on a tie: `(start, length)`. -/
private def longestZeroRun (groups : List Nat) : Option (Nat × Nat) :=
  let step := fun (acc : Option (Nat × Nat) × Nat × Nat) (item : Nat × Nat) =>
    let (best, start, length) := acc
    let (value, index) := item
    if value == 0 then
      let length := length + 1
      let start := if length == 1 then index else start
      let better : Bool := match best with
        | some (_, bestLength) => decide (length > bestLength)
        | none => decide (length ≥ 2)
      (if better then some (start, length) else best, start, length)
    else (best, start, 0)
  (groups.zipIdx.foldl step (none, 0, 0)).1

private def serializeIpv6 (groups : List Nat) : String :=
  let text := fun (items : List Nat) => ":".intercalate (items.map hexGroup)
  match longestZeroRun groups with
  | some (start, length) =>
    text (groups.take start) ++ "::" ++ text (groups.drop (start + length))
  | none => text groups

/-- The canonical `[...]` form of an IPv6 literal, or none when it is invalid. -/
private def parseIpv6 (text : String) : Option String :=
  let halves := text.splitOn "::"
  match halves with
  | [whole] =>
    (ipv6Groups whole).bind fun groups =>
      if groups.length == 8 then some ("[" ++ serializeIpv6 groups ++ "]") else none
  | [left, right] =>
    (ipv6Groups left).bind fun head => (ipv6Groups right).bind fun tail =>
      if head.length + tail.length ≥ 8 then none
      else some ("[" ++ serializeIpv6 (head ++ List.replicate (8 - head.length - tail.length) 0 ++ tail) ++ "]")
  | _ => none

private def parseHost (host : List Char) : Option (Option String) :=
  match host with
  | '[' :: rest =>
    match rest.getLast? with
    | some ']' => some ((parseIpv6 (String.ofList rest.dropLast)))
    | _ => some none
  | _ =>
    match percentDecode (host.length + 1) host with
    | none => none
    | some decoded =>
      if decoded.any (fun c => c.toNat ≥ 128) then none else
      let text := lower (String.ofList decoded)
      if text.isEmpty || text.toList.any isForbiddenHost then some none
      else if endsInNumber text then some (parseIpv4 text)
      else some (some text)

private def isPlainPathChar (c : Char) : Bool :=
  isAsciiAlnum c || "-._~!$&'()*+,;=:@/%".toList.contains c

/-- `new URL(value)` for a special scheme's authority form; others keep only their protocol. -/
def parse (input : String) : Parsed :=
  let trimmed := (dropC0 (dropC0 input.toList).reverse).reverse
  let cleaned := trimmed.filter fun c => c != '\t' && c != '\n' && c != '\r'
  let (schemeChars, afterScheme) := splitFirst (· == ':') cleaned
  let validScheme := match schemeChars with
    | first :: rest => isAsciiAlpha first && rest.all fun c =>
        isAsciiAlnum c || c == '+' || c == '-' || c == '.'
    | [] => false
  if !validScheme || afterScheme.isEmpty then .invalid else
  let scheme := lower (String.ofList schemeChars)
  let protocol := scheme ++ ":"
  let plain : Url := { protocol := protocol, hostname := "", port := "", pathname := "",
                       search := "", hash := "", username := "", password := "" }
  if scheme == "file" then .unknown "file URL"
  else if !isSpecial scheme then .ok plain
  else
    let rest := (afterScheme.drop 1).dropWhile fun c => c == '/' || c == '\\'
    let (authority, tail) := splitFirst (fun c => c == '/' || c == '\\' || c == '?' || c == '#') rest
    let (userInfo, hostPort) :=
      if authority.contains '@' then
        let reversed := authority.reverse
        let (hostRev, infoRev) := splitFirst (· == '@') reversed
        (infoRev.drop 1 |>.reverse, hostRev.reverse)
      else ([], authority)
    if authority.contains '@' && hostPort.isEmpty then .invalid else
    let (hostChars, portChars) :=
      match hostPort with
      | '[' :: _ =>
        let (inside, after) := splitFirst (· == ']') hostPort
        (inside ++ after.take 1, after.drop 1)
      | _ => splitFirst (· == ':') hostPort
    let portDigits := portChars.drop 1
    if !portChars.isEmpty && portChars.head? != some ':' then .invalid
    else if !portDigits.all isAsciiDigit then .invalid
    else
      let portNumber := (String.ofList portDigits).toNat?.getD 0
      if portNumber > 65535 then .invalid
      else if hostChars.isEmpty then .invalid
      else
        match parseHost hostChars with
        | none => .unknown "host needs IDNA or a non-ASCII escape"
        | some none => .invalid
        | some (some hostname) =>
          let port := if portDigits.isEmpty then "" else toString portNumber
          let port := if port == defaultPort scheme then "" else port
          let (beforeHash, hashPart) := splitFirst (· == '#') tail
          let (pathPart, searchPart) := splitFirst (· == '?') beforeHash
          let (user, pass) := splitFirst (· == ':') userInfo
          let path := String.ofList pathPart
          .ok { plain with
                hostname := hostname
                port := port
                pathname := if path.isEmpty then "/" else path
                search := if searchPart.length ≤ 1 then "" else String.ofList searchPart
                hash := if hashPart.length ≤ 1 then "" else String.ofList hashPart
                username := String.ofList user
                password := String.ofList (pass.drop 1) }

/-- True when the URL's path and search stay as typed, so `href` is exact. -/
def plainHref (url : Url) : Bool :=
  url.pathname.toList.all isPlainPathChar && !(url.pathname.splitOn "/").any (fun part =>
    part == "." || part == ".." || lower part == "%2e" || lower part == ".%2e" ||
      lower part == "%2e." || lower part == "%2e%2e") &&
  (url.search ++ url.hash).toList.all fun c => c.toNat > 32 && c.toNat < 127 && c != '"' && c != '<' && c != '>' && c != '\''

/-- `url.host`. -/
def host (url : Url) : String :=
  if url.port.isEmpty then url.hostname else url.hostname ++ ":" ++ url.port

/-- `url.origin` of a special URL. -/
def origin (url : Url) : String :=
  url.protocol ++ "//" ++ host url

/-- `url.href`, when the path needs no re-encoding. -/
def href (url : Url) : String :=
  let credentials :=
    if url.username.isEmpty && url.password.isEmpty then ""
    else url.username ++ (if url.password.isEmpty then "" else ":" ++ url.password) ++ "@"
  url.protocol ++ "//" ++ credentials ++ host url ++ url.pathname ++ url.search ++ url.hash

end Spec.Url
