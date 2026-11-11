/-!
SHA-256, base64 and AES-256-GCM decryption, which the access twins need to run the key derivations
and ticket checks on recorded input. Standards: FIPS 180-4, FIPS 197, NIST SP 800-38D.
-/

namespace Spec.Access.Crypto

/-- The SHA-256 round constants. -/
def roundConstants : Array UInt32 := #[
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

/-- One compression of the 64-byte block at `offset`. -/
def compress (state : Array UInt32) (data : Array UInt8) (offset : Nat) : Array UInt32 := Id.run do
  let mut words : Array UInt32 := Array.mkEmpty 64
  for index in [0:16] do
    let start := offset + index * 4
    words := words.push
      ((data[start]!.toUInt32 <<< 24) ||| (data[start + 1]!.toUInt32 <<< 16) |||
        (data[start + 2]!.toUInt32 <<< 8) ||| data[start + 3]!.toUInt32)
  for index in [16:64] do
    let w15 := words[index - 15]!
    let w2 := words[index - 2]!
    let s0 := rotr w15 7 ^^^ rotr w15 18 ^^^ (w15 >>> 3)
    let s1 := rotr w2 17 ^^^ rotr w2 19 ^^^ (w2 >>> 10)
    words := words.push (words[index - 16]! + s0 + words[index - 7]! + s1)
  let mut a := state[0]!
  let mut b := state[1]!
  let mut c := state[2]!
  let mut d := state[3]!
  let mut e := state[4]!
  let mut f := state[5]!
  let mut g := state[6]!
  let mut h := state[7]!
  for index in [0:64] do
    let s1 := rotr e 6 ^^^ rotr e 11 ^^^ rotr e 25
    let choose := (e &&& f) ^^^ ((~~~e) &&& g)
    let first := h + s1 + choose + roundConstants[index]! + words[index]!
    let s0 := rotr a 2 ^^^ rotr a 13 ^^^ rotr a 22
    let majority := (a &&& b) ^^^ (a &&& c) ^^^ (b &&& c)
    let second := s0 + majority
    h := g
    g := f
    f := e
    e := d + first
    d := c
    c := b
    b := a
    a := first + second
  return #[state[0]! + a, state[1]! + b, state[2]! + c, state[3]! + d,
    state[4]! + e, state[5]! + f, state[6]! + g, state[7]! + h]

/-- The SHA-256 digest of a message. -/
def sha256 (message : List UInt8) : List UInt8 := Id.run do
  let size := message.length
  let padding := (64 + 55 - size % 64) % 64
  let lengthBytes := (List.range 8).reverse.map fun index => ((size * 8) >>> (index * 8)).toUInt8
  let data := (message ++ [0x80] ++ List.replicate padding 0 ++ lengthBytes).toArray
  let mut state : Array UInt32 :=
    #[0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  for block in [0:data.size / 64] do
    state := compress state data (block * 64)
  return state.toList.flatMap fun (word : UInt32) =>
    [(word >>> 24).toUInt8, (word >>> 16).toUInt8, (word >>> 8).toUInt8, word.toUInt8]

/-- The UTF-8 bytes of a string. -/
def utf8 (text : String) : List UInt8 :=
  text.toUTF8.toList

/-- Lowercase hex. -/
def hex (bytes : List UInt8) : String :=
  let digit (value : Nat) : Char :=
    if value < 10 then Char.ofNat (48 + value) else Char.ofNat (87 + value)
  String.ofList <| bytes.flatMap fun byte => [digit (byte.toNat / 16), digit (byte.toNat % 16)]

/-- The base64url alphabet, which `Buffer` writes without padding. -/
def urlAlphabet : Array Char :=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toList.toArray

/-- Encodes as many bytes as the 3-byte `groups` count allows, then the tail. -/
def encodeGroups : Nat → List UInt8 → List Char
  | 0, _ => []
  | fuel + 1, bytes =>
    let symbol (value : Nat) : Char := urlAlphabet[value % 64]!
    match bytes with
    | [] => []
    | [a] =>
      let x := a.toNat
      [symbol (x / 4), symbol ((x % 4) * 16)]
    | [a, b] =>
      let x := a.toNat
      let y := b.toNat
      [symbol (x / 4), symbol ((x % 4) * 16 + y / 16), symbol ((y % 16) * 4)]
    | a :: b :: c :: rest =>
      let x := a.toNat
      let y := b.toNat
      let z := c.toNat
      [symbol (x / 4), symbol ((x % 4) * 16 + y / 16), symbol ((y % 16) * 4 + z / 64),
        symbol (z % 64)] ++ encodeGroups fuel rest

/-- `Buffer.toString("base64url")`. -/
def base64UrlEncode (bytes : List UInt8) : String :=
  String.ofList (encodeGroups bytes.length bytes)

/-- A symbol's value in either base64 alphabet. -/
def base64Value (char : Char) : Option Nat :=
  let code := char.toNat
  if 65 ≤ code && code ≤ 90 then some (code - 65)
  else if 97 ≤ code && code ≤ 122 then some (code - 71)
  else if 48 ≤ code && code ≤ 57 then some (code + 4)
  else if char == '+' || char == '-' then some 62
  else if char == '/' || char == '_' then some 63
  else none

/-- Decodes symbol values four at a time; a lone trailing symbol carries no whole byte. -/
def decodeGroups : Nat → List Nat → List UInt8
  | 0, _ => []
  | fuel + 1, values =>
    match values with
    | a :: b :: c :: d :: rest =>
      [(a * 4 + b / 16).toUInt8, ((b % 16) * 16 + c / 4).toUInt8, ((c % 4) * 64 + d).toUInt8] ++
        decodeGroups fuel rest
    | [a, b, c] => [(a * 4 + b / 16).toUInt8, ((b % 16) * 16 + c / 4).toUInt8]
    | [a, b] => [(a * 4 + b / 16).toUInt8]
    | _ => []

/-- `Buffer.from(text, "base64url")`: either alphabet, skipping other characters, up to any `=`. -/
def base64Decode (text : String) : List UInt8 :=
  let values := (text.toList.takeWhile (· != '=')).filterMap base64Value
  decodeGroups values.length values

/-- The AES S-box. -/
def sbox : Array UInt8 := #[
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16]

/-- The S-box lookup. -/
def subByte (byte : UInt8) : UInt8 :=
  sbox[byte.toNat]!

/-- Multiplies by x in GF(2^8). -/
def xtime (byte : UInt8) : UInt8 :=
  (byte <<< 1) ^^^ (if byte &&& 0x80 != 0 then 0x1b else 0)

/-- The AES-256 key schedule: 60 words of 4 bytes, flattened. -/
def expandKey (key : Array UInt8) : Array UInt8 := Id.run do
  let mut schedule := key
  let mut rcon : UInt8 := 1
  for word in [8:60] do
    let last := (word - 1) * 4
    let mut t0 := schedule[last]!
    let mut t1 := schedule[last + 1]!
    let mut t2 := schedule[last + 2]!
    let mut t3 := schedule[last + 3]!
    if word % 8 == 0 then
      let first := t0
      t0 := subByte t1 ^^^ rcon
      t1 := subByte t2
      t2 := subByte t3
      t3 := subByte first
      rcon := xtime rcon
    else if word % 8 == 4 then
      t0 := subByte t0
      t1 := subByte t1
      t2 := subByte t2
      t3 := subByte t3
    let back := (word - 8) * 4
    schedule := schedule.push (schedule[back]! ^^^ t0)
    schedule := schedule.push (schedule[back + 1]! ^^^ t1)
    schedule := schedule.push (schedule[back + 2]! ^^^ t2)
    schedule := schedule.push (schedule[back + 3]! ^^^ t3)
  return schedule

/-- XORs round key `round` into the state. -/
def addRoundKey (schedule : Array UInt8) (round : Nat) (state : Array UInt8) : Array UInt8 :=
  state.mapIdx fun index byte => byte ^^^ schedule[round * 16 + index]!

/-- SubBytes then ShiftRows, on a column-first state. -/
def subShift (state : Array UInt8) : Array UInt8 :=
  (List.range 16).toArray.map fun index =>
    let column := index / 4
    let row := index % 4
    subByte state[((column + row) % 4) * 4 + row]!

/-- MixColumns. -/
def mixColumns (state : Array UInt8) : Array UInt8 :=
  (List.range 16).toArray.map fun index =>
    let base := index / 4 * 4
    let row := index % 4
    let a := state[base + row]!
    let b := state[base + (row + 1) % 4]!
    let c := state[base + (row + 2) % 4]!
    let d := state[base + (row + 3) % 4]!
    xtime a ^^^ (xtime b ^^^ b) ^^^ c ^^^ d

/-- AES-256 of one block, with a schedule from `expandKey`. -/
def encryptBlock (schedule : Array UInt8) (block : Array UInt8) : Array UInt8 := Id.run do
  let mut state := addRoundKey schedule 0 block
  for round in [1:14] do
    state := addRoundKey schedule round (mixColumns (subShift state))
  return addRoundKey schedule 14 (subShift state)

/-- Bytes read as a big-endian number. -/
def bytesToNat (bytes : List UInt8) : Nat :=
  bytes.foldl (fun total byte => total * 256 + byte.toNat) 0

/-- A number as `count` big-endian bytes. -/
def natToBytes (count value : Nat) : List UInt8 :=
  (List.range count).reverse.map fun index => (value >>> (index * 8)).toUInt8

/-- Multiplication in GCM's field, on 128-bit numbers whose top bit is the first coefficient. -/
def gfMul (left right : Nat) : Nat := Id.run do
  let reduce := 0xE1 <<< 120
  let mut product := 0
  let mut shifted := right
  for index in [0:128] do
    if left.testBit (127 - index) then
      product := product ^^^ shifted
    shifted := if shifted % 2 == 1 then (shifted >>> 1) ^^^ reduce else shifted >>> 1
  return product

/-- Splits bytes into 16-byte blocks; the last may be shorter. -/
def chunks : Nat → List UInt8 → List (List UInt8)
  | 0, _ => []
  | fuel + 1, bytes =>
    if bytes.isEmpty then [] else bytes.take 16 :: chunks fuel (bytes.drop 16)

/-- GHASH over whole blocks, padding each short block with zeros. -/
def ghash (subkey : Nat) (bytes : List UInt8) : Nat :=
  (chunks bytes.length bytes).foldl
    (fun total block =>
      let padded := block ++ List.replicate (16 - block.length) 0
      gfMul (total ^^^ bytesToNat padded) subkey)
    0

/-- A 16-byte counter block, incrementing only its low 32 bits. -/
def incrementCounter (counter : Nat) : Nat :=
  let low := counter % (1 <<< 32)
  counter - low + (low + 1) % (1 <<< 32)

/-- The keystream XOR over `bytes`, starting at `counter`. -/
def ctrBlocks (schedule : Array UInt8) (blocks : List (List UInt8)) (counter : Nat) : List UInt8 :=
  match blocks with
  | [] => []
  | block :: rest =>
    let stream := (encryptBlock schedule (natToBytes 16 counter).toArray).toList
    (block.zipWith (· ^^^ ·) stream) ++ ctrBlocks schedule rest (incrementCounter counter)

/-- AES-256-GCM with no associated data: the plaintext when `tag` authenticates, else `none`. An
empty `iv` or a tag that is not 16 bytes is refused, as Bun's `createDecipheriv` and `setAuthTag` do. -/
def gcmOpen (key iv tag ciphertext : List UInt8) : Option (List UInt8) :=
  let schedule := expandKey key.toArray
  let subkey := bytesToNat (encryptBlock schedule (List.replicate 16 (0 : UInt8)).toArray).toList
  let start :=
    if iv.length == 12 then bytesToNat (iv ++ [0, 0, 0, 1])
    else
      let padding := (16 - iv.length % 16) % 16
      ghash subkey (iv ++ List.replicate (padding + 8) 0 ++ natToBytes 8 (iv.length * 8))
  let padding := (16 - ciphertext.length % 16) % 16
  let lengths := natToBytes 8 0 ++ natToBytes 8 (ciphertext.length * 8)
  let hash := ghash subkey (ciphertext ++ List.replicate padding 0 ++ lengths)
  let mask := bytesToNat (encryptBlock schedule (natToBytes 16 start).toArray).toList
  let expected := natToBytes 16 (hash ^^^ mask)
  if iv.isEmpty || expected != tag then none
  else
    some (ctrBlocks schedule (chunks ciphertext.length ciphertext) (incrementCounter start))

end Spec.Access.Crypto
