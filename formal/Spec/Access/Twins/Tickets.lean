import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

/-!
Twins of the sealed tickets: `apps/core/src/shared/terminal-ticket.ts` and `media-ticket.ts`, which run
real AES-256-GCM over recorded tokens, and the signed `packages/convex/model/stageSessionTicket.ts`.
-/

namespace Spec.Access.Tickets

open Lean Js Crypto

/-- A ticket's clock: a recorded `now`, or `none` when the call took `Date.now()`. -/
def clockOf : Json → Option JsonNumber
  | .num now => some now
  | _ => none

/-- A Buffer as `JSON.stringify` writes it. -/
def bufferJson (bytes : List UInt8) : Json :=
  Json.mkObj [("type", .str "Buffer"),
    ("data", Json.arr (bytes.map fun byte => Json.num (natNum byte.toNat)).toArray)]

/-- `ticketKey` in `terminal-ticket.ts`. -/
def terminalKey (secret : String) : List UInt8 :=
  sha256 (utf8 ("sandbox-terminal-ticket:" ++ secret))

/-- `ticketKey` in `media-ticket.ts`. -/
def mediaKey (secret : String) : List UInt8 :=
  sha256 (utf8 ("workspace-media-link:" ++ secret))

/-- The destructuring both tickets open with: a version and exactly three non-empty fields. -/
def tokenFields (version token : String) : Option (String × String × String) :=
  match token.splitOn "." with
  | [first, iv, tag, ciphertext] =>
    if first == version && iv != "" && tag != "" && ciphertext != "" then
      some (iv, tag, ciphertext)
    else none
  | _ => none

/-- Decrypts and parses, `none` for what `catch` turns into null. -/
def openJson (key iv tag ciphertext : List UInt8) : Option Json := do
  let plaintext ← gcmOpen key iv tag ciphertext
  let text ← String.fromUTF8? (ByteArray.mk plaintext.toArray)
  (Json.parse text).toOption

/-- `SEALED_TICKET.safeParse`, stripped of unknown keys and of an empty `authorizationHeader`. -/
def terminalPayload (value : Json) : Option (Json × JsonNumber) := do
  let url ← strProp value "url"
  let authorization ← strProp value "authorization"
  let accountId ← strProp value "accountId"
  let expiresAt ← match prop value "expiresAt" with
    | some (.num number) => some number
    | _ => none
  let header ← match prop value "authorizationHeader" with
    | none => some none
    | some (.str text) => some (some text)
    | some _ => none
  let headerField := match header with
    | some text => if text != "" then [("authorizationHeader", Json.str text)] else []
    | none => []
  some (Json.mkObj ([("url", .str url), ("authorization", .str authorization),
    ("accountId", .str accountId), ("expiresAt", .num expiresAt)] ++ headerField), expiresAt)

/-- The ticket up to its expiry check. Only the canonical base64url spelling opens. -/
def terminalBeforeClock (token secret : String) : Option (Json × JsonNumber) := do
  let (iv, tag, ciphertext) ← tokenFields "st1" token
  let ivBytes := base64Decode iv
  let tagBytes := base64Decode tag
  let cipherBytes := base64Decode ciphertext
  if base64UrlEncode ivBytes != iv || base64UrlEncode tagBytes != tag ||
      base64UrlEncode cipherBytes != ciphertext then none
  else terminalPayload (← openJson (terminalKey secret) ivBytes tagBytes cipherBytes)

/-- `openTerminalTicket`. A ticket that opens with no recorded `now` depends on the clock. -/
def openTerminal (token secret : String) (now : Option JsonNumber) : Json :=
  match terminalBeforeClock token secret, now with
  | none, _ => nullResult
  | some _, none => Spec.Twin.unsupported "the expiry check reads Date.now()"
  | some (ticket, expiresAt), some clock => if numLe expiresAt clock then nullResult else ticket

/-- `openTerminalTicketWithSecrets`, whose expiry check always reads the clock. -/
def openTerminalWithSecrets (token : String) (secrets : List Json) : Json :=
  if trim token == "" then nullResult
  else
    let opened := secrets.any fun secret =>
      match secret with
      | .str text => (terminalBeforeClock token text).isSome
      | _ => false
    if opened then Spec.Twin.unsupported "the expiry check reads Date.now()" else nullResult

/-- Whether an object has exactly these keys, as `z.strictObject` demands. -/
def hasExactKeys (value : Json) (keys : List String) : Bool :=
  let present := (entries value).map Prod.fst
  present.length == keys.length && keys.all present.contains

/-- `ticketPayload.safeParse`: two strict shapes, with the expiry returned alongside. -/
def mediaPayload (value : Json) : Option (Json × JsonNumber) := do
  let exp ← match prop value "exp" with
    | some (.num number) => some number
    | _ => none
  let isString (key : String) : Bool := (strProp value key).isSome
  let attachment := hasExactKeys value ["accountId", "path", "exp"]
  let workspace := hasExactKeys value ["accountId", "workspaceId", "namespace", "path", "exp"]
  if (attachment || (workspace && isString "workspaceId" && isString "namespace")) &&
      isString "accountId" && isString "path" then
    some (value, exp)
  else none

/-- The ticket up to its expiry check. Unlike the terminal ticket, spelling is not checked. -/
def mediaBeforeClock (token secret : String) : Option (Json × JsonNumber) := do
  let (iv, tag, ciphertext) ← tokenFields "ml2" token
  mediaPayload (← openJson (mediaKey secret) (base64Decode iv) (base64Decode tag)
    (base64Decode ciphertext))

/-- `parsed.data.exp * 1000 > now`. -/
def mediaLive (exp now : JsonNumber) : Bool :=
  !numLe (numAdd exp (natNum 0) |>.mul1000) now
where
  /-- Multiplies a JSON number by 1000. -/
  JsonNumber.mul1000 (number : JsonNumber) : JsonNumber :=
    ⟨number.mantissa * 1000, number.exponent⟩

end Spec.Access.Tickets
