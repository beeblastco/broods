import Spec.Twin

/-!
The JavaScript semantics the access twins share: property reads, strings, numbers and URI coding.
-/

namespace Spec.Access.Js

open Lean

/-- A property read. `none` is `undefined`, which is also what a non-object answers. -/
def prop (value : Json) (key : String) : Option Json :=
  (value.getObjVal? key).toOption

/-- The string under `key`, when it holds one. -/
def strProp (value : Json) (key : String) : Option String :=
  match prop value key with
  | some (.str text) => some text
  | _ => none

/-- JavaScript truthiness of a JSON value. -/
def truthy : Json → Bool
  | .null => false
  | .bool flag => flag
  | .str text => text != ""
  | .num number => number.mantissa != 0
  | _ => true

/-- Truthiness of a property read. -/
def truthyProp (value : Json) (key : String) : Bool :=
  (prop value key).any truthy

/-- `typeof value === "object"` for a value that is not null: an object or an array. -/
def isObjectLike : Json → Bool
  | .obj _ => true
  | .arr _ => true
  | _ => false

/-- An object's entries. -/
def entries : Json → List (String × Json)
  | .obj fields => fields.toList
  | _ => []

/-- `Object.keys(value).length` for an object or an array. -/
def keyCount : Json → Nat
  | .obj fields => fields.toList.length
  | .arr items => items.size
  | _ => 0

/-- One optional field of an object being built. -/
def optField (key : String) (value : Option Json) : List (String × Json) :=
  match value with
  | some item => [(key, item)]
  | none => []

/-- A top-level `null` or `undefined` result. `scripts/conform.ts` crashes reading a real null, so
this stays uncompared until that is fixed; then it is `.null`. -/
def nullResult : Json :=
  Json.null

/-- An optional string as a result. -/
def optStr (value : Option String) : Json :=
  match value with
  | some text => .str text
  | none => nullResult

/-- `.length` of a string, which counts UTF-16 code units. -/
def utf16Length (text : String) : Nat :=
  text.toList.foldl (fun total char => total + if char.val > 0xFFFF then 2 else 1) 0

/-- The whitespace of `String.prototype.trim` and the regular expression class `\s`. -/
def isSpace (char : Char) : Bool :=
  let code := char.toNat
  code == 9 || code == 10 || code == 11 || code == 12 || code == 13 || code == 32 ||
    code == 0xA0 || code == 0x1680 || (0x2000 ≤ code && code ≤ 0x200A) || code == 0x2028 ||
    code == 0x2029 || code == 0x202F || code == 0x205F || code == 0x3000 || code == 0xFEFF

/-- What the regular expression `.` refuses. -/
def isLineTerminator (char : Char) : Bool :=
  let code := char.toNat
  code == 10 || code == 13 || code == 0x2028 || code == 0x2029

/-- `String.prototype.trim`. -/
def trim (text : String) : String :=
  let start := text.toList.dropWhile isSpace
  String.ofList (start.reverse.dropWhile isSpace).reverse

/-- Whether every character is ASCII, the range where `toLowerCase` and `toUpperCase` are modelled. -/
def isAscii (text : String) : Bool :=
  text.toList.all fun char => char.toNat < 128

/-- `text` without its first `count` characters. -/
def dropChars (text : String) (count : Nat) : String :=
  String.ofList (text.toList.drop count)

/-- The rest of `text` after `prefix`, when it starts with it. -/
def afterPrefix (text pre : String) : Option String :=
  if pre.toList.isPrefixOf text.toList then some (dropChars text pre.length) else none

/-- `text.startsWith(pre)`. -/
def startsWith (text pre : String) : Bool :=
  pre.toList.isPrefixOf text.toList

/-- `text.endsWith(suffix)`. -/
def endsWith (text suffix : String) : Bool :=
  suffix.toList.isSuffixOf text.toList

/-- The first position of `pattern` among `chars`, counted from `position`. -/
def indexFrom (pattern : List Char) : List Char → Nat → Option Nat
  | [], position => if pattern.isEmpty then some position else none
  | rest@(_ :: tail), position =>
    if pattern.isPrefixOf rest then some position else indexFrom pattern tail (position + 1)

/-- `text.indexOf(pattern)`, or `none` for -1. Positions count characters. -/
def indexOf (text pattern : String) : Option Nat :=
  indexFrom pattern.toList text.toList 0

/-- `text.includes(part)`. -/
def includes (text part : String) : Bool :=
  (indexOf text part).isSome

/-- Splits on runs of `\s`, as `text.split(/\s+/)` does on text with no outer whitespace. -/
def splitSpaces (text : String) : List String :=
  let (words, last) := text.toList.foldl
    (fun (state : List String × List Char) char =>
      let (done, current) := state
      if isSpace char then
        if current.isEmpty then state else (String.ofList current.reverse :: done, [])
      else (done, char :: current))
    (([], []) : List String × List Char)
  (String.ofList last.reverse :: words).reverse

/-- `text.replace(/\/+$/, "")`, and the scan in `stripTrailingSlashes`. -/
def stripTrailingSlashes (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile (· == '/')).reverse

/-- Uppercase hex of a byte, as URI escapes spell it. -/
def upperHexByte (byte : Nat) : String :=
  let digit (value : Nat) : Char :=
    if value < 10 then Char.ofNat (48 + value) else Char.ofNat (55 + value)
  String.ofList [digit (byte / 16), digit (byte % 16)]

/-- `encodeURIComponent`. -/
def encodeURIComponent (text : String) : String :=
  let unreserved (char : Char) : Bool :=
    char.isAlphanum && char.toNat < 128 || "-_.!~*'()".toList.contains char
  String.join <| text.toList.map fun char =>
    if unreserved char then char.toString
    else String.join <| (String.singleton char).toUTF8.toList.map fun byte =>
      "%" ++ upperHexByte byte.toNat

/-- The value of one hex digit. -/
def hexValue (char : Char) : Option Nat :=
  let code := char.toNat
  if 48 ≤ code && code ≤ 57 then some (code - 48)
  else if 97 ≤ code && code ≤ 102 then some (code - 87)
  else if 65 ≤ code && code ≤ 70 then some (code - 55)
  else none

/-- One `%XX` at the head of `chars`, with what follows it. -/
def percentByte : List Char → Option (Nat × List Char)
  | '%' :: high :: low :: rest =>
    match hexValue high, hexValue low with
    | some h, some l => some (h * 16 + l, rest)
    | _, _ => none
  | _ => none

/-- `count` continuation bytes, each spelled as a `%XX`. -/
def continuationBytes : Nat → List Char → Option (List UInt8 × List Char)
  | 0, chars => some ([], chars)
  | count + 1, chars =>
    match percentByte chars with
    | some (byte, rest) =>
      if byte &&& 0xC0 != 0x80 then none
      else
        match continuationBytes count rest with
        | some (bytes, tail) => some (byte.toUInt8 :: bytes, tail)
        | none => none
    | none => none

/-- `decodeURIComponent` over `fuel` steps, `none` where it throws. -/
def decodeSteps : Nat → List Char → List Char → Option String
  | _, [], done => some (String.ofList done.reverse)
  | 0, _, _ => none
  | fuel + 1, char :: rest, done =>
    if char != '%' then decodeSteps fuel rest (char :: done)
    else
      match percentByte (char :: rest) with
      | none => none
      | some (first, tail) =>
        if first < 0x80 then decodeSteps fuel tail (Char.ofNat first :: done)
        else
          let more := if first &&& 0xE0 == 0xC0 then some 1
            else if first &&& 0xF0 == 0xE0 then some 2
            else if first &&& 0xF8 == 0xF0 then some 3
            else none
          match more with
          | none => none
          | some count =>
            match continuationBytes count tail with
            | none => none
            | some (bytes, after) =>
              match String.fromUTF8? (ByteArray.mk (first.toUInt8 :: bytes).toArray) with
              | some decoded => decodeSteps fuel after (decoded.toList.reverse ++ done)
              | none => none

/-- `decodeURIComponent`, `none` where it throws `URIError`. -/
def decodeURIComponent (text : String) : Option String :=
  decodeSteps text.length text.toList []

/-- IEEE not-a-number. -/
def nan : Float := 0.0 / 0.0

/-- IEEE positive infinity. -/
def infinity : Float := 1.0 / 0.0

/-- A JSON number as a double. -/
def numFloat (number : JsonNumber) : Float :=
  let size := Float.ofScientific number.mantissa.natAbs true number.exponent
  if number.mantissa < 0 then -size else size

/-- The decimal with the fewest places that reads back as `value`, for `mantissa / scale`. -/
private def shortestPlaces (value : Float) (mantissa scale : Nat) : Nat → Nat → Option JsonNumber
  | 0, _ => none
  | fuel + 1, places =>
    let digits := (2 * (mantissa * 10 ^ places) + scale) / (2 * scale)
    if Float.ofScientific digits true places == value then
      some ⟨Int.ofNat digits, places⟩
    else
      shortestPlaces value mantissa scale fuel (places + 1)

/-- A fractional double's shortest round-trip decimal, which is what JavaScript prints. -/
private def shortestDecimal (value : Float) : Option JsonNumber :=
  let (fraction, binary) := value.abs.frExp
  let mantissa := (fraction.scaleB 53).toUInt64.toNat
  if binary < 53 then
    (shortestPlaces value.abs mantissa (2 ^ (53 - binary).toNat) 400 0).map fun number =>
      if value < 0.0 then ⟨-number.mantissa, number.exponent⟩ else number
  else
    none

/-- A double as JSON: `JSON.stringify` writes NaN and the infinities as null. -/
def floatJson (value : Float) : Json :=
  if value.isNaN || value.isInf then .null
  else if value == value.floor && value.abs < 9007199254740992.0 then
    let size : Int := Int.ofNat value.abs.toUInt64.toNat
    .num (JsonNumber.fromInt (if value < 0.0 then -size else size))
  else
    match shortestDecimal value with
    | some number => .num number
    | none =>
      match JsonNumber.fromFloat? value with
      | .inr number => .num number
      | .inl _ => .null

/-- Compares two JSON numbers exactly. -/
def numCompare (left right : JsonNumber) : Ordering :=
  compare (left.mantissa * (10 : Int) ^ right.exponent) (right.mantissa * (10 : Int) ^ left.exponent)

/-- `left <= right`. -/
def numLe (left right : JsonNumber) : Bool :=
  numCompare left right != .gt

/-- `left + right`, exact. -/
def numAdd (left right : JsonNumber) : JsonNumber :=
  let exponent := max left.exponent right.exponent
  ⟨left.mantissa * (10 : Int) ^ (exponent - left.exponent) +
    right.mantissa * (10 : Int) ^ (exponent - right.exponent), exponent⟩

/-- A natural number as a JSON number. -/
def natNum (value : Nat) : JsonNumber :=
  JsonNumber.fromInt (Int.ofNat value)

/-- The natural number a digit list spells in `base`. -/
def digitsValue (base : Nat) (digits : List Char) : Option Nat :=
  digits.foldl
    (fun (total : Option Nat) char =>
      match total, hexValue char with
      | some sum, some digit => if digit < base then some (sum * base + digit) else none
      | _, _ => none)
    (some 0)

/-- A nonzero `mantissa` scaled by a decimal exponent, saturating far out of a double's range. -/
def scaled (mantissa : Nat) (negative : Bool) (exponent : Nat) : Float :=
  if exponent > 800 then (if negative then 0.0 else infinity)
  else Float.ofScientific mantissa negative exponent

/-- `StrDecimalLiteral` without its sign, or `none` where `Number` gives NaN. -/
def decimalLiteral (chars : List Char) : Option Float :=
  if chars == "Infinity".toList then some infinity
  else
    let whole := chars.takeWhile Char.isDigit
    let afterWhole := chars.dropWhile Char.isDigit
    let (fraction, afterFraction) := match afterWhole with
      | '.' :: rest => (rest.takeWhile Char.isDigit, rest.dropWhile Char.isDigit)
      | rest => ([], rest)
    if whole.isEmpty && fraction.isEmpty then none
    else
      let exponent : Option Int := match afterFraction with
        | [] => some 0
        | 'e' :: rest | 'E' :: rest =>
          let (sign, digits) := match rest with
            | '+' :: more => (1, more)
            | '-' :: more => (-1, more)
            | more => ((1 : Int), more)
          if digits.isEmpty || !digits.all Char.isDigit then none
          else (digitsValue 10 digits).map fun value => sign * Int.ofNat value
        | _ => none
      match exponent, digitsValue 10 (whole ++ fraction) with
      | some power, some mantissa =>
        let total := power - Int.ofNat fraction.length
        some (scaled mantissa (total < 0) total.natAbs)
      | _, _ => none

/-- `Number(text)`. -/
def numberOfString (text : String) : Float :=
  let chars := (trim text).toList
  let radix (base : Nat) (digits : List Char) : Float :=
    if digits.isEmpty then nan
    else
      match digitsValue base digits with
      | some value => Float.ofNat value
      | none => nan
  match chars with
  | [] => 0.0
  | '0' :: 'x' :: digits | '0' :: 'X' :: digits => radix 16 digits
  | '0' :: 'o' :: digits | '0' :: 'O' :: digits => radix 8 digits
  | '0' :: 'b' :: digits | '0' :: 'B' :: digits => radix 2 digits
  | '-' :: rest => (decimalLiteral rest).map (fun value => -value) |>.getD nan
  | '+' :: rest => (decimalLiteral rest).getD nan
  | rest => (decimalLiteral rest).getD nan

/-- `Number(value)`, or `none` for an array, whose conversion goes through `toString`. -/
def numberOf : Json → Option Float
  | .null => some 0.0
  | .bool flag => some (if flag then 1.0 else 0.0)
  | .num number => some (numFloat number)
  | .str text => some (numberOfString text)
  | .obj _ => some nan
  | .arr _ => none

/-- `Number.isSafeInteger`. -/
def isSafeInteger (value : Float) : Bool :=
  !value.isNaN && !value.isInf && value == value.floor && value.abs ≤ 9007199254740991.0

/-- `String(number)` for a number JSON can hold. -/
def numberText (number : JsonNumber) : String :=
  (Json.num number).compress

/-- The JSON text of a string, as `JSON.stringify` spells it. -/
def quoteJson (text : String) : String :=
  let hex (value : Nat) : Char :=
    if value < 10 then Char.ofNat (48 + value) else Char.ofNat (87 + value)
  let body := text.toList.flatMap fun char =>
    match char with
    | '"' => ['\\', '"']
    | '\\' => ['\\', '\\']
    | '\n' => ['\\', 'n']
    | '\r' => ['\\', 'r']
    | '\t' => ['\\', 't']
    | '\x08' => ['\\', 'b']
    | '\x0c' => ['\\', 'f']
    | other =>
      if other.toNat < 32 then
        ['\\', 'u', '0', '0', hex (other.toNat / 16), hex (other.toNat % 16)]
      else [other]
  String.ofList ('"' :: body ++ ['"'])

/-- A twin of a function over one string. -/
def stringTwin (source : String) (body : String → Json) : Spec.Twin where
  source := source
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str first => body first
    | _ => Spec.Twin.unsupported "argument is not a string"

/-- A twin of a function over two strings. -/
def stringTwin2 (source : String) (body : String → String → Json) : Spec.Twin where
  source := source
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
    | .str first, .str second => body first second
    | _, _ => Spec.Twin.unsupported "arguments are not strings"

/-- A twin of a function over any JSON arguments. -/
def jsonTwin (source : String) (body : Json → Json) : Spec.Twin where
  source := source
  run := body

end Spec.Access.Js
