import Spec.Twin
import Spec.Sandbox.Model

/-!
What the tool twins share: JavaScript's view of JSON values, a small backtracking regular expression
matcher, and the base64 and SHA-256 the tools call.
-/

namespace Spec.Sandbox.Tools

open Lean

/-- Why a modelled call has no return value: the function threw, or the model does not reach. -/
inductive Stop where
  | threw (message : String)
  | unsupported (reason : String)

abbrev R := Except Stop

def jsThrow {α : Type} (message : String) : R α := .error (.threw message)

def noModel {α : Type} (reason : String) : R α := .error (.unsupported reason)

/-- The marker for an `undefined` or null result. `scripts/conform.ts` crashes reading a bare null
output, so these calls count as unsupported until that is fixed: then return `Json.null` here. -/
def nullResult : Json := Json.null

def finish : R Json → Json
  | .ok .null => nullResult
  | .ok value => value
  | .error (.threw message) => Spec.Twin.threw message
  | .error (.unsupported reason) => Spec.Twin.unsupported reason

/-- A twin of `name` in `apps/core/src/harness/tools/<file>`. -/
def tool (file name : String) (run : Json → R Json) (gaps : List String := []) : Spec.Twin where
  source := "apps/core/src/harness/tools/" ++ file ++ "#" ++ name
  run := fun args => finish (run args)
  gaps := gaps

def arg (args : Json) (index : Nat) : Json := Spec.Twin.arg args index

/-! ## JSON as JavaScript sees it. A missing key and `undefined` both read as `null`. -/

def field (value : Json) (key : String) : Json := value.getObjValD key

def fieldAt (value : Json) (keys : List String) : Json := keys.foldl field value

def hasKey (value : Json) (key : String) : Bool :=
  match value.getObjVal? key with
  | .ok _ => true
  | .error _ => false

def items : Json → List Json
  | .arr values => values.toList
  | _ => []

def first (value : Json) : Json := (items value).headD Json.null

def entries : Json → List (String × Json)
  | .obj pairs => pairs.toList
  | _ => []

def truthy : Json → Bool
  | .null => false
  | .bool value => value
  | .str value => value != ""
  | .num value => value.mantissa != 0
  | _ => true

def isStr : Json → Bool
  | .str _ => true
  | _ => false

def isObj : Json → Bool
  | .obj _ => true
  | _ => false

def isArr : Json → Bool
  | .arr _ => true
  | _ => false

def strOf? : Json → Option String
  | .str value => some value
  | _ => none

/-- `value ?? fallback`. -/
def orElse (value fallback : Json) : Json :=
  if value == Json.null then fallback else value

/-- `${value}` in a template literal, for the string fields these functions interpolate. -/
def text : Json → String
  | .str value => value
  | .null => "undefined"
  | .bool value => if value then "true" else "false"
  | .num value => toString value
  | other => other.compress

def strs (values : List String) : Json := Json.arr (values.map Json.str).toArray

def nat (value : Nat) : Json := toJson value

/-- An object literal. A null value stands for `undefined`, which `JSON.stringify` drops. -/
def object (pairs : List (String × Json)) : Json :=
  Json.mkObj (pairs.filter fun pair => pair.2 != Json.null)

/-- `{ ...a, ...b }`. -/
def spread (a b : Json) : Json := Json.mkObj (entries a ++ entries b)

def withoutKeys (value : Json) (keys : List String) : Json :=
  Json.mkObj ((entries value).filter fun pair => !keys.contains pair.1)

def intOf? : Json → Option Int
  | .num value =>
    let scale : Int := (10 : Int) ^ value.exponent
    if value.mantissa % scale == 0 then some (value.mantissa / scale) else none
  | _ => none

/-- `[...new Set(values)]`: first occurrence wins. -/
def dedupe {α : Type} [BEq α] (values : List α) : List α :=
  (values.foldl (fun kept value => if kept.contains value then kept else value :: kept) []).reverse

/-! ## Strings -/

def asciiLower (c : Char) : Char :=
  if 'A' ≤ c ∧ c ≤ 'Z' then Char.ofNat (c.toNat + 32) else c

/-- `String.prototype.length`, in UTF-16 code units. -/
def jsLength (value : String) : Nat :=
  value.toList.foldl (fun total c => total + if c.toNat > 0xFFFF then 2 else 1) 0

def isPrefix (value pre : String) : Bool := pre.toList.isPrefixOf value.toList

def isSuffix (value post : String) : Bool :=
  post.toList.reverse.isPrefixOf value.toList.reverse

def hasSublist : List Char → List Char → Bool
  | needle, [] => needle.isEmpty
  | needle, hay@(_ :: rest) => needle.isPrefixOf hay || hasSublist needle rest

def contains (value needle : String) : Bool := hasSublist needle.toList value.toList

def split (value separator : String) : List String := value.splitOn separator

def lastPart (value separator : String) : String := (split value separator).getLastD ""

/-- `shellQuote`, sandbox/utils.ts:277. -/
def shellQuote (value : String) : String :=
  "'" ++ value.replace "'" "'\\''" ++ "'"

/-! ## `JSON.stringify` -/

private def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

private def jsonEscapeChar (c : Char) : List Char :=
  match c with
  | '"' => ['\\', '"']
  | '\\' => ['\\', '\\']
  | '\n' => ['\\', 'n']
  | '\r' => ['\\', 'r']
  | '\t' => ['\\', 't']
  | _ =>
    if c.toNat == 8 then ['\\', 'b']
    else if c.toNat == 12 then ['\\', 'f']
    else if c.toNat < 32 then
      ['\\', 'u', '0', '0', hexDigit (c.toNat / 16), hexDigit (c.toNat % 16)]
    else [c]

def jsonQuote (value : String) : String :=
  String.ofList ('"' :: (value.toList.flatMap jsonEscapeChar) ++ ['"'])

private def jsonDepth : Nat := 128

private def stringifyAux : Nat → Json → R String
  | 0, _ => noModel "JSON nested too deep"
  | _ + 1, .null => pure "null"
  | _ + 1, .bool value => pure (if value then "true" else "false")
  | _ + 1, .num value => pure (toString value)
  | _ + 1, .str value => pure (jsonQuote value)
  | fuel + 1, .arr values => do
    let parts ← values.toList.mapM (stringifyAux fuel)
    pure ("[" ++ String.intercalate "," parts ++ "]")
  | fuel + 1, .obj pairs => do
    if pairs.toList.length > 1 then
      noModel "JSON.stringify follows insertion order, which the recorded argument does not hold"
    else
      let parts ← pairs.toList.mapM fun pair => do
        let value ← stringifyAux fuel pair.2
        pure (jsonQuote pair.1 ++ ":" ++ value)
      pure ("{" ++ String.intercalate "," parts ++ "}")

/-- `JSON.stringify` of a value whose objects have at most one key, the only case where the parsed
argument still says what the key order was. -/
def stringify (value : Json) : R String := stringifyAux jsonDepth value

/-- `JSON.stringify` of an object whose type declares its key order. -/
def stringifyDeclared (order : List String) (value : Json) : R String := do
  let pairs := entries value
  let known := order.filterMap fun key => (pairs.find? (·.1 == key))
  let rest := pairs.filter fun pair => !order.contains pair.1
  let parts ← (known ++ rest).mapM fun pair => do
    let inner ← stringify pair.2
    pure (jsonQuote pair.1 ++ ":" ++ inner)
  pure ("{" ++ String.intercalate "," parts ++ "}")

/-! ## Regular expressions: the backtracking subset these tools write, on code points. -/

inductive Re where
  | empty
  | chr (test : Char → Bool)
  | seq (a b : Re)
  | alt (a b : Re)
  /-- Zero or more; greedy or lazy. An iteration that consumes nothing stops, as in ECMAScript. -/
  | rep (body : Re) (greedy : Bool)
  | bol
  | eol
  | wordBoundary
  | ahead (body : Re)
  | group (index : Nat) (body : Re)

namespace Re

def lit (value : String) : Re :=
  value.toList.foldr (fun c rest => .seq (.chr (· == c)) rest) .empty

def oneOf (value : String) : Re := .chr fun c => value.toList.contains c

def noneOf (value : String) : Re := .chr fun c => !value.toList.contains c

def space : Re := .chr jsWhitespace

def nonSpace : Re := .chr fun c => !jsWhitespace c

def digit : Re := .chr fun c => '0' ≤ c ∧ c ≤ '9'

def opt (body : Re) : Re := .alt body .empty

def star (body : Re) : Re := .rep body true

def lazy (body : Re) : Re := .rep body false

def plus (body : Re) : Re := .seq body (star body)

def seqs (parts : List Re) : Re := parts.foldr .seq .empty

def alts : List Re → Re
  | [] => .empty
  | [one] => one
  | one :: rest => .alt one (alts rest)

def anyLit (values : List String) : Re := alts (values.map lit)

/-- Group spans found so far, newest first. -/
abbrev Spans := List (Nat × Nat × Nat)

private def isWord (c : Char) : Bool :=
  ('a' ≤ c ∧ c ≤ 'z') || ('A' ≤ c ∧ c ≤ 'Z') || ('0' ≤ c ∧ c ≤ '9') || c == '_'

private def wordAt (s : Array Char) (i : Nat) : Bool :=
  match s[i]? with
  | some c => isWord c
  | none => false

private def orTry {α : Type} : Option α → (Unit → Option α) → Option α
  | some value, _ => some value
  | none, next => next ()

/-- Tries `re` at `i`, then the continuation. Fuel only falls along one path of the match, so
the length of the input plus the depth of the pattern is always enough. -/
def run (s : Array Char) : Nat → Re → Nat → Spans → (Nat → Spans → Option (Nat × Spans)) →
    Option (Nat × Spans)
  | 0, _, _, _, _ => none
  | _ + 1, .empty, i, spans, next => next i spans
  | _ + 1, .chr test, i, spans, next =>
    match s[i]? with
    | some c => if test c then next (i + 1) spans else none
    | none => none
  | fuel + 1, .seq a b, i, spans, next =>
    run s fuel a i spans fun j found => run s fuel b j found next
  | fuel + 1, .alt a b, i, spans, next =>
    orTry (run s fuel a i spans next) fun _ => run s fuel b i spans next
  | fuel + 1, .rep body greedy, i, spans, next =>
    let more : Unit → Option (Nat × Spans) := fun _ =>
      run s fuel body i spans fun j found =>
        if j == i then none else run s fuel (.rep body greedy) j found next
    if greedy then orTry (more ()) fun _ => next i spans
    else orTry (next i spans) more
  | _ + 1, .bol, i, spans, next => if i == 0 then next i spans else none
  | _ + 1, .eol, i, spans, next => if i == s.size then next i spans else none
  | _ + 1, .wordBoundary, i, spans, next =>
    let before := i > 0 && wordAt s (i - 1)
    if before != wordAt s i then next i spans else none
  | fuel + 1, .ahead body, i, spans, next =>
    match run s fuel body i spans fun j found => some (j, found) with
    | some _ => next i spans
    | none => none
  | fuel + 1, .group index body, i, spans, next =>
    run s fuel body i spans fun j found => next j ((index, i, j) :: found)

/-- One match: where it starts, where it ends, and its group spans. -/
structure Match where
  start : Nat
  stop : Nat
  spans : Spans

private def fuelFor (s : Array Char) : Nat := s.size + 256

private def searchFrom (re : Re) (s : Array Char) : Nat → Nat → Option Match
  | 0, _ => none
  | remaining + 1, i =>
    match run s (fuelFor s) re i [] fun j found => some (j, found) with
    | some (stop, spans) => some { start := i, stop := stop, spans := spans }
    | none => searchFrom re s remaining (i + 1)

/-- `re.exec(value)`, from position `from`. -/
def execFrom (re : Re) (s : Array Char) (start : Nat) : Option Match :=
  searchFrom re s (s.size + 1 - start) start

def test (re : Re) (value : String) : Bool :=
  (execFrom re value.toList.toArray 0).isSome

private def slice (s : Array Char) (start stop : Nat) : String :=
  String.ofList ((s.toList.drop start).take (stop - start))

def groupText (s : Array Char) (found : Match) (index : Nat) : Option String :=
  (found.spans.find? (·.1 == index)).map fun span => slice s span.2.1 span.2.2

/-- `value.match(re)?.[1]`. -/
def firstGroup (re : Re) (value : String) : Option String :=
  let s := value.toList.toArray
  (execFrom re s 0).bind fun found => groupText s found 1

private def collectFrom (re : Re) (s : Array Char) : Nat → Nat → List Match
  | 0, _ => []
  | remaining + 1, start =>
    match execFrom re s start with
    | none => []
    | some found =>
      found :: collectFrom re s remaining (if found.stop == found.start then found.stop + 1 else found.stop)

/-- `value.matchAll(re)`, group 1 of each match. -/
def allGroups (re : Re) (value : String) : List String :=
  let s := value.toList.toArray
  (collectFrom re s (s.size + 1) 0).filterMap fun found => groupText s found 1

end Re

/-! ## Base64 -/

private def base64Alphabet : Array Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toList.toArray

private def base64Char (n : Nat) : Char := base64Alphabet.getD (n % 64) 'A'

private def encodeBytes : List Nat → List Char
  | a :: b :: c :: rest =>
    base64Char (a / 4) :: base64Char ((a % 4) * 16 + b / 16) ::
      base64Char ((b % 16) * 4 + c / 64) :: base64Char (c % 64) :: encodeBytes rest
  | [a, b] =>
    [base64Char (a / 4), base64Char ((a % 4) * 16 + b / 16), base64Char ((b % 16) * 4), '=']
  | [a] => [base64Char (a / 4), base64Char ((a % 4) * 16), '=', '=']
  | [] => []

/-- `toBase64`, filesystem-utils.ts:689. -/
def toBase64 (value : String) : String :=
  String.ofList (encodeBytes (value.toUTF8.toList.map (·.toNat)))

private def base64Value (c : Char) : Option Nat :=
  base64Alphabet.findIdx? (· == c)

/-- `Buffer.from(value, "base64")` for text already known to be base64. -/
def fromBase64 (value : String) : Array Nat :=
  let sextets := value.toList.filterMap base64Value
  let step : (Nat × Nat × Array Nat) → Nat → (Nat × Nat × Array Nat) := fun state sextet =>
    let (bits, count, out) := state
    let joined := bits * 64 + sextet
    let total := count + 6
    if total ≥ 8 then
      let extra := total - 8
      (joined % 2 ^ extra, extra, out.push (joined / 2 ^ extra))
    else (joined, total, out)
  (sextets.foldl step (0, 0, #[])).2.2

/-! ## SHA-256 -/

private def shaK : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

private def rotr (x : UInt32) (n : UInt32) : UInt32 := (x >>> n) ||| (x <<< (32 - n))

private def wordsOf (block : List Nat) : List UInt32 :=
  match block with
  | a :: b :: c :: d :: rest =>
    UInt32.ofNat (a * 16777216 + b * 65536 + c * 256 + d) :: wordsOf rest
  | _ => []

private def schedule (words : Array UInt32) : Array UInt32 :=
  (List.range 48).foldl (fun w t =>
    let i := t + 16
    let w15 := w.getD (i - 15) 0
    let w2 := w.getD (i - 2) 0
    let s0 := rotr w15 7 ^^^ rotr w15 18 ^^^ (w15 >>> 3)
    let s1 := rotr w2 17 ^^^ rotr w2 19 ^^^ (w2 >>> 10)
    w.push (w.getD (i - 16) 0 + s0 + w.getD (i - 7) 0 + s1)) words

private def compress (state : Array UInt32) (block : List Nat) : Array UInt32 :=
  let w := schedule (wordsOf block).toArray
  let at_ (i : Nat) : UInt32 := state.getD i 0
  let final := (List.range 64).foldl (fun (s : Array UInt32) t =>
    let a := s.getD 0 0
    let b := s.getD 1 0
    let c := s.getD 2 0
    let d := s.getD 3 0
    let e := s.getD 4 0
    let f := s.getD 5 0
    let g := s.getD 6 0
    let h := s.getD 7 0
    let s1 := rotr e 6 ^^^ rotr e 11 ^^^ rotr e 25
    let ch := (e &&& f) ^^^ ((~~~e) &&& g)
    let temp1 := h + s1 + ch + shaK.getD t 0 + w.getD t 0
    let s0 := rotr a 2 ^^^ rotr a 13 ^^^ rotr a 22
    let maj := (a &&& b) ^^^ (a &&& c) ^^^ (b &&& c)
    #[temp1 + s0 + maj, a, b, c, d + temp1, e, f, g]) state
  (List.range 8).toArray.map fun i => at_ i + final.getD i 0

private def blocksOf : Nat → List Nat → List (List Nat)
  | 0, _ => []
  | _ + 1, [] => []
  | fuel + 1, bytes => bytes.take 64 :: blocksOf fuel (bytes.drop 64)

private def paddedBytes (bytes : List Nat) : List Nat :=
  let size := bytes.length
  let zeros := (120 - (size + 1) % 64) % 64
  let lengthBytes := (List.range 8).map fun i => (size * 8) / 256 ^ (7 - i) % 256
  bytes ++ [128] ++ List.replicate zeros 0 ++ lengthBytes

private def hexByte (n : Nat) : List Char := [hexDigit (n / 16), hexDigit (n % 16)]

/-- `createHash("sha256").update(value, "utf8").digest("hex")`. -/
def sha256Hex (value : String) : String :=
  let padded := paddedBytes (value.toUTF8.toList.map (·.toNat))
  let start : Array UInt32 := #[
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  let digest := (blocksOf padded.length padded).foldl compress start
  String.ofList (digest.toList.flatMap fun word =>
    let n := word.toNat
    hexByte (n / 16777216) ++ hexByte (n / 65536 % 256) ++ hexByte (n / 256 % 256) ++ hexByte (n % 256))

end Spec.Sandbox.Tools
