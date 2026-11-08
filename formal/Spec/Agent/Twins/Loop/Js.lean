import Spec.Twin

/-!
JavaScript semantics the agent twins share: object access, truthiness, UTF-16 string indexing,
`String(number)`, `JSON.stringify` and SHA-256. Recorded objects arrive with sorted keys, because
`Json.parse` keeps no insertion order, so a twin whose text depends on key order must say so.
-/

namespace Spec.Agent.Js

open Lean

/-- `value[key]`, with a missing key read as null. -/
def get (value : Json) (key : String) : Json :=
  match value.getObjVal? key with
  | .ok found => found
  | .error _ => .null

/-- Whether the key was present in the recorded object, which means it was not `undefined`. -/
def has (value : Json) (key : String) : Bool :=
  match value.getObjVal? key with
  | .ok _ => true
  | .error _ => false

/-- The value when it is a string. -/
def str? : Json → Option String
  | .str text => some text
  | _ => none

/-- The value when it is a number. -/
def num? : Json → Option JsonNumber
  | .num number => some number
  | _ => none

/-- The value when it is an array. -/
def arr? : Json → Option (List Json)
  | .arr items => some items.toList
  | _ => none

/-- The array's items, or nothing when it is not an array. -/
def items : Json → List Json
  | .arr items => items.toList
  | _ => []

/-- `typeof value === "object"` for a non-null, non-array value. -/
def isObj : Json → Bool
  | .obj _ => true
  | _ => false

/-- `Array.isArray(value)`. -/
def isArr : Json → Bool
  | .arr _ => true
  | _ => false

/-- `value && typeof value === "object"`, which arrays also satisfy. -/
def isObjectLike : Json → Bool
  | .obj _ => true
  | .arr _ => true
  | _ => false

/-- The object's entries in key order. -/
def entries : Json → List (String × Json)
  | .obj fields => fields.toList
  | _ => []

/-- `Object.keys(value)` in key order. -/
def keys (value : Json) : List String :=
  (entries value).map Prod.fst

/-- JavaScript truthiness. -/
def truthy : Json → Bool
  | .null => false
  | .bool flag => flag
  | .num number => number.mantissa != 0
  | .str text => !text.isEmpty
  | _ => true

/-- `{ key: value }` when the value is present, else nothing, for building an object. -/
def field (key : String) : Option Json → List (String × Json)
  | some value => [(key, value)]
  | none => []

/-- `...(value[key] !== undefined ? { [key]: value[key] } : {})`. -/
def copied (value : Json) (key : String) : List (String × Json) :=
  match value.getObjVal? key with
  | .ok found => [(key, found)]
  | .error _ => []

/-- `...(value[key] ? { [key]: value[key] } : {})`. -/
def copiedIfTruthy (value : Json) (key : String) : List (String × Json) :=
  let found := get value key
  if truthy found then [(key, found)] else []

/-- `{ ...base, ...fields }`, where a later field replaces an earlier one. -/
def spread (base : Json) (fields : List (String × Json)) : Json :=
  Json.mkObj (entries base ++ fields)

/-- `{ ...value }` without the named keys. -/
def without (value : Json) (names : List String) : Json :=
  Json.mkObj ((entries value).filter fun entry => !names.contains entry.fst)

/-- A whole number, as a `Json` value. -/
def nat (value : Nat) : Json :=
  .num (JsonNumber.mk (Int.ofNat value) 0)

/-- The number when it is a non-negative integer. -/
def natOf? : Json → Option Nat
  | .num ⟨mantissa, 0⟩ => if mantissa ≥ 0 then some mantissa.toNat else none
  | _ => none

/-- The whole number's value as an integer, when it is one. -/
def intOf? : Json → Option Int
  | .num ⟨mantissa, 0⟩ => some mantissa
  | _ => none

/-- `a >= b` on decimals, exactly. -/
def numGe (a b : JsonNumber) : Bool :=
  a.mantissa * (10 : Int) ^ b.exponent ≥ b.mantissa * (10 : Int) ^ a.exponent

/-- `a > 0`. -/
def numPositive (a : JsonNumber) : Bool :=
  a.mantissa > 0

/-- Code units a character takes in a JavaScript string. -/
def units (c : Char) : Nat :=
  if c.toNat > 0xFFFF then 2 else 1

/-- `text.length`. -/
def length (text : String) : Nat :=
  text.toList.foldl (fun total c => total + units c) 0

/-- The characters of the first `count` code units; a pair cut in half is dropped. -/
def takeUnits : List Char → Nat → List Char
  | [], _ => []
  | c :: rest, count =>
    if units c ≤ count then c :: takeUnits rest (count - units c) else []

/-- The characters after the first `count` code units. -/
def dropUnits : List Char → Nat → List Char
  | [], _ => []
  | c :: rest, count =>
    if count = 0 then c :: rest else dropUnits rest (count - min count (units c))

/-- `text.slice(0, count)`. -/
def take (text : String) (count : Nat) : String :=
  String.ofList (takeUnits text.toList count)

/-- `text.slice(count)`. -/
def drop (text : String) (count : Nat) : String :=
  String.ofList (dropUnits text.toList count)

/-- `text.slice(start, stop)` for non-negative bounds. -/
def slice (text : String) (start stop : Nat) : String :=
  take (drop text start) (stop - start)

/-- `text.slice(-count)`. -/
def takeLast (text : String) (count : Nat) : String :=
  drop text (length text - count)

/-- ECMAScript TrimString WhiteSpace and LineTerminator code points. -/
def isSpace (c : Char) : Bool :=
  [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
    8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279].contains c.toNat

/-- `text.trimStart()`. -/
def trimStart (text : String) : String :=
  String.ofList (text.toList.dropWhile isSpace)

/-- `text.trimEnd()`. -/
def trimEnd (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile isSpace).reverse

/-- `text.trim()`. -/
def trim (text : String) : String :=
  trimEnd (trimStart text)

/-- `text.startsWith(prefix)`. -/
def startsWith (text pre : String) : Bool :=
  pre.isPrefixOf text

/-- `text.endsWith(suffix)`. -/
def endsWith (text suffix : String) : Bool :=
  suffix.toList.reverse.isPrefixOf text.toList.reverse

/-- `text.includes(part)`. -/
def includes (text part : String) : Bool :=
  (text.splitOn part).length > 1 || part.isEmpty

/-- `text.indexOf(part)` counted in characters. -/
def indexOf? (text part : String) : Option Nat :=
  let rec go : List Char → Nat → Option Nat
    | [], at_ => if part.isEmpty then some at_ else none
    | c :: rest, at_ =>
      if part.toList.isPrefixOf (c :: rest) then some at_ else go rest (at_ + 1)
  go text.toList 0

/-- `text.replaceAll(part, replacement)`. -/
def replaceAll (text part replacement : String) : String :=
  String.intercalate replacement (text.splitOn part)

private def hexDigit (value : Nat) : Char :=
  if value < 10 then Char.ofNat (48 + value) else Char.ofNat (87 + value)

/-- `value` as lowercase hex, padded to `width` digits. -/
def hexPad (width value : Nat) : String :=
  let digits := (Nat.toDigits 16 value)
  String.ofList (List.replicate (width - digits.length) '0' ++ digits)

private def escapeChar (c : Char) : String :=
  match c with
  | '"' => "\\\""
  | '\\' => "\\\\"
  | '\n' => "\\n"
  | '\r' => "\\r"
  | '\t' => "\\t"
  | '\x08' => "\\b"
  | '\x0c' => "\\f"
  | _ => if c.toNat < 0x20 then "\\u" ++ hexPad 4 c.toNat else c.toString

/-- `JSON.stringify(text)`. -/
def quote (text : String) : String :=
  "\"" ++ String.join (text.toList.map escapeChar) ++ "\""

/-- `String(number)` for a number the recorder printed as JSON. -/
def numText (number : JsonNumber) : String :=
  let negative := number.mantissa < 0
  let raw := (Nat.toDigits 10 number.mantissa.natAbs)
  let digits := (raw.reverse.dropWhile (· == '0')).reverse
  -- value = 0.digits × 10^point
  let point : Int := (raw.length : Int) - (number.exponent : Int)
  let count := digits.length
  let body :=
    if number.mantissa == 0 then "0"
    else if point > 21 then
      let exponentText := (point - 1).toNat.repr
      let rest := digits.drop 1
      String.ofList (digits.take 1) ++
        (if rest.isEmpty then "" else "." ++ String.ofList rest) ++ "e+" ++ exponentText
    else if point > 0 && point.toNat ≥ count then
      String.ofList (digits ++ List.replicate (point.toNat - count) '0')
    else if point > 0 then
      String.ofList (digits.take point.toNat) ++ "." ++ String.ofList (digits.drop point.toNat)
    else if point > -6 then
      "0." ++ String.ofList (List.replicate (-point).toNat '0' ++ digits)
    else
      let rest := digits.drop 1
      String.ofList (digits.take 1) ++
        (if rest.isEmpty then "" else "." ++ String.ofList rest) ++ "e-" ++ (1 - point).toNat.repr
  if negative then "-" ++ body else body

/-- `String(value)` for a primitive, where a recorded null reads as `null`. -/
def primitiveText : Json → String
  | .null => "null"
  | .bool flag => if flag then "true" else "false"
  | .num number => numText number
  | .str text => text
  | .arr _ => "[object Array]"
  | .obj _ => "[object Object]"

/-- `${value}` where a missing value reads `undefined`. -/
def template (value : Json) : String :=
  match value with
  | .null => "undefined"
  | other => primitiveText other

/-- `JSON.stringify(value)` up to `fuel` levels, with object keys in sorted order. -/
def stringify : Nat → Json → String
  | 0, _ => "null"
  | _ + 1, .null => "null"
  | _ + 1, .bool flag => if flag then "true" else "false"
  | _ + 1, .num number => numText number
  | _ + 1, .str text => quote text
  | fuel + 1, .arr values =>
    "[" ++ String.intercalate "," (values.toList.map (stringify fuel)) ++ "]"
  | fuel + 1, .obj fields =>
    "{" ++ String.intercalate ","
      (fields.toList.map fun entry => quote entry.fst ++ ":" ++ stringify fuel entry.snd) ++ "}"

/-- Whether an object anywhere in the value has at least two keys, so that their order is lost. -/
def orderLost : Nat → Json → Bool
  | 0, _ => true
  | fuel + 1, .arr values => values.toList.any (orderLost fuel)
  | fuel + 1, .obj fields =>
    fields.toList.length > 1 || fields.toList.any fun entry => orderLost fuel entry.snd
  | _ + 1, _ => false

/-! SHA-256, for the functions whose results are content hashes. -/

private def shaK : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

private def rotr (x n : UInt32) : UInt32 :=
  (x >>> n) ||| (x <<< (32 - n))

private def schedule (block : List UInt8) : Array UInt32 := Id.run do
  let bytes := block.toArray
  let mut w : Array UInt32 := #[]
  for i in [0:16] do
    let b (k : Nat) : UInt32 := (bytes.getD (i * 4 + k) 0).toUInt32
    w := w.push ((b 0 <<< 24) ||| (b 1 <<< 16) ||| (b 2 <<< 8) ||| b 3)
  for i in [16:64] do
    let x := w.getD (i - 15) 0
    let y := w.getD (i - 2) 0
    let s0 := rotr x 7 ^^^ rotr x 18 ^^^ (x >>> 3)
    let s1 := rotr y 17 ^^^ rotr y 19 ^^^ (y >>> 10)
    w := w.push (w.getD (i - 16) 0 + s0 + w.getD (i - 7) 0 + s1)
  return w

private def compress (state : Array UInt32) (block : List UInt8) : Array UInt32 := Id.run do
  let w := schedule block
  let mut v := state
  for i in [0:64] do
    let g (k : Nat) : UInt32 := v.getD k 0
    let s1 := rotr (g 4) 6 ^^^ rotr (g 4) 11 ^^^ rotr (g 4) 25
    let ch := (g 4 &&& g 5) ^^^ ((~~~ (g 4)) &&& g 6)
    let t1 := g 7 + s1 + ch + shaK.getD i 0 + w.getD i 0
    let s0 := rotr (g 0) 2 ^^^ rotr (g 0) 13 ^^^ rotr (g 0) 22
    let maj := (g 0 &&& g 1) ^^^ (g 0 &&& g 2) ^^^ (g 1 &&& g 2)
    let t2 := s0 + maj
    v := #[t1 + t2, g 0, g 1, g 2, g 3 + t1, g 4, g 5, g 6]
  return (state.zip v).map fun pair => pair.fst + pair.snd

private def blocks : Nat → List UInt8 → List (List UInt8)
  | 0, _ => []
  | fuel + 1, bytes =>
    if bytes.isEmpty then [] else bytes.take 64 :: blocks fuel (bytes.drop 64)

/-- `createHash("sha256").update(text).digest("hex")`. -/
def sha256Hex (text : String) : String :=
  let bytes := text.toUTF8.toList
  let bits := bytes.length * 8
  let pad := (119 - bytes.length % 64) % 64
  let lengthBytes := (List.range 8).reverse.map fun i => (bits >>> (i * 8)).toUInt8
  let message := bytes ++ [0x80] ++ List.replicate pad 0 ++ lengthBytes
  let start : Array UInt32 := #[0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
    0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  let final := (blocks message.length message).foldl compress start
  String.join (final.toList.map fun word => hexPad 8 word.toNat)

/-- `conform.ts` crashes on a twin whose output is JSON null, so a null result stays uncompared. -/
def nullComparable : Bool := true

/-- The twin with a null result reported as uncompared, unless `nullComparable` is set. -/
def comparable (twin : Spec.Twin) : Spec.Twin :=
  { twin with
    run := fun args =>
      match twin.run args with
      | .null => if nullComparable then .null else Twin.unsupported "conform.ts cannot compare null"
      | output => output }

end Spec.Agent.Js
