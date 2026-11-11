import Spec.Statements
import Lean.Data.Json
import Spec.Config.Twins.Js

/-! `packages/convex/model` pure configuration rules. Scheduling progress does not apply.
URL parsing and cryptography are external contracts. See L700 onward for coverage limits. -/
namespace Spec.Config
inductive Value where
  | null | bool (b : Bool) | num (n : Int) | str (s : String)
  | arr (xs : List Value) | obj (xs : List (String × Value))
  deriving BEq, Repr, Inhabited

def Value.get (v : Value) (key : String) : Option Value :=
  match v with
  | .obj xs => (xs.find? (fun p => p.1 == key)).map Prod.snd
  | _ => none

def objectOr (v fallback : Value) : Value :=
  match v with
  | .obj xs => .obj (xs.filter (fun p => p.1 != "__proto__"))
  | _ => fallback

def stringValuesOr (v fallback : Value) : Value :=
  match v with
  | .obj xs => if xs.all (fun p => match p.2 with | .str _ => true | _ => false)
    then objectOr v fallback else fallback
  | _ => fallback

def envName (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: rest => c >= 'A' && c <= 'Z' && rest.all (fun x =>
    (x >= 'A' && x <= 'Z') || x.isDigit || x == '_')

def envNameError (s : String) : Option String :=
  if envName s && s.length ≤ 64 then none
  else some "env name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters"

def refsScan : Nat → List Char → List String
  | 0, _ => []
  | n+1, '$' :: '{' :: rest =>
    let name := rest.takeWhile (fun c => c != '}')
    if envName (String.ofList name) && rest[name.length]? == some '}'
    then String.ofList name :: refsScan n (rest.drop (name.length + 1))
    else refsScan n ('{' :: rest)
  | n+1, _ :: rest => refsScan n rest
  | _, [] => []

def refsOnlyScan : Nat → List Char → Bool
  | 0, cs => cs.isEmpty
  | n+1, '$' :: '{' :: rest =>
    let name := rest.takeWhile (fun c => c != '}')
    envName (String.ofList name) && rest[name.length]? == some '}' &&
      refsOnlyScan n (rest.drop (name.length + 1))
  | _, [] => true
  | _, _ => false

def refsOnly (s : String) : Bool :=
  !s.isEmpty && refsOnlyScan s.length s.toList

def headerRefs (s : String) : Bool :=
  refsOnly s ||
    let word := s.toList.takeWhile Char.isAlpha
    !word.isEmpty && (s.toList.drop word.length).head? == some ' ' &&
      refsOnly (String.ofList (s.toList.drop (word.length + 1)))

def requestIdValid (s : String) : Bool :=
  0 < s.length && s.length ≤ 128 && s.toList.all (fun c =>
    c.isAlphanum && c.toNat < 128 || c == '.' || c == '_' || c == '-')

def resolveRequestId (inbound : Option String) (fresh : String) : String :=
  match inbound with
  | some s => if requestIdValid s then s else fresh
  | none => fresh

def withRequestId (existing : Option String) (fresh : String) : String :=
  match existing with
  | some s => if s == "" then fresh else s
  | none => fresh

def apiStatus (status : Int) : String × String :=
  match status with
  | 400 => ("invalid_request", "invalid_request_error")
  | 401 => ("unauthorized", "authentication_error")
  | 403 => ("forbidden", "permission_error")
  | 404 => ("not_found", "not_found_error")
  | 405 => ("method_not_allowed", "invalid_request_error")
  | 409 => ("conflict", "conflict_error")
  | 410 => ("gone", "not_found_error")
  | 413 => ("payload_too_large", "invalid_request_error")
  | 415 => ("unsupported_media_type", "invalid_request_error")
  | 422 => ("unprocessable_entity", "invalid_request_error")
  | 429 => ("rate_limited", "rate_limit_error")
  | 500 => ("internal_error", "api_error")
  | 502 => ("bad_gateway", "api_error")
  | 503 => ("service_unavailable", "overloaded_error")
  | 504 => ("gateway_timeout", "api_error")
  | n => if n ≥ 500 then ("internal_error", "api_error")
    else ("invalid_request", "invalid_request_error")

def apiError (status : Int) (message : String) (code param : Option String) : Value :=
  .obj [("error", .obj ([("message", .str message), ("type", .str (apiStatus status).2),
    ("code", .str (code.getD (apiStatus status).1))] ++
    (param.toList.map (fun p => ("param", .str p)))))]

def clientStatus (code : String) : Option Nat :=
  match code with
  | "invalid_request" => some 400
  | "unauthorized" => some 401
  | "payment_required" => some 402
  | "forbidden" => some 403
  | "not_found" => some 404
  | "conflict" | "manifest_conflict" => some 409
  | _ => none

def clientData (isConvex : Bool) (v : Value) : Value :=
  if !isConvex then .null else
  match v.get "code", v.get "message" with
  | some (.str c), some (.str m) =>
    if (clientStatus c).isSome then .obj [("code", .str c), ("message", .str m)] else .null
  | _, _ => .null

def positiveInteger (max : Int) (v : Value) : Option String :=
  match v with
  | .num n => if 1 ≤ n && n ≤ max && n ≤ 9007199254740991 then none
    else some s!"must be an integer from 1 to {max}"
  | _ => some s!"must be an integer from 1 to {max}"

def nonEmpty (v : Value) : Option String :=
  match v with
  | .str s => if (Spec.Js.trim s).isEmpty then some "must be a non-empty string" else none
  | _ => some "must be a non-empty string"

def privateIpv4 (a b : Nat) : Bool :=
  a == 0 || a == 10 || a == 127 || (a == 100 && b ≥ 64 && b ≤ 127) ||
  (a == 169 && b == 254) || (a == 172 && b ≥ 16 && b ≤ 31) || (a == 192 && b == 168)

/-- `/^\[/` in `replace(/^\[|\]$/g, "")`. -/
def dropOpen (chars : List Char) : List Char :=
  if chars.head? == some '[' then chars.tail else chars

/-- Drops one trailing `c`, if there is one. -/
def dropLastIf (c : Char) (chars : List Char) : List Char :=
  if chars.getLast? == some c then chars.dropLast else chars

/-- The host the deny list reads: lowercased, one leading `[` and one trailing `]` dropped, then
one trailing DNS dot (`agentRules.ts` `isPrivateHostname`). -/
def hostKey (hostname : String) : String :=
  String.ofList (dropLastIf '.' (dropLastIf ']' (dropOpen (hostname.toList.map Char.toLower))))

/-- The name rules of the deny list, before the address rules. -/
def deniedName (host : String) : Bool :=
  host == "localhost" || host.endsWith ".localhost" || host.endsWith ".local" ||
    host.endsWith ".internal"

def privateHostname (hostname : String) : Bool :=
  let host := hostKey hostname
  if deniedName host
  then true
  else
    let parts := host.splitOn "."
    if parts.length == 4 && parts.all (fun p => !p.isEmpty && p.length ≤ 3 && p.toList.all Char.isDigit)
    then privateIpv4 ((parts[0]?.getD "").toNat?.getD 0) ((parts[1]?.getD "").toNat?.getD 0)
    else if host.contains ':' then
      host == "::" || host == "::1" || host.startsWith "::ffff:" || host.startsWith "fc" ||
      host.startsWith "fd" || ["fe8", "fe9", "fea", "feb"].any (fun pre => host.startsWith pre)
    else false

/-- WHATWG URL parse result is an explicit input, never a DNS lookup. -/
def publicHttpsProblem (parsed : Option (String × String)) : Option String :=
  match parsed with
  | none => some "must be a valid URL"
  | some (protocol, host) =>
    if protocol != "https:" then some "must use https"
    else if privateHostname host then some "must not point to a private or internal address"
    else none

/-- The post-validation provider base spelling transformation; `.trim()` is ECMAScript trim. -/
def canonicalBase (base_url baseURL : Option String) : Option String × Option String :=
  let chosen := (base_url.or baseURL).map (fun s => Spec.Js.trim s)
  match chosen with
  | some s => if s == "" then (base_url, baseURL) else (none, some s)
  | none => (base_url, baseURL)

def providerToolName (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: cs =>
    !s.startsWith "tool_" && s.length ≤ 64 &&
    (c.isAlpha && c.toNat < 128 || c == '_') &&
    cs.all (fun x => x.isAlphanum && x.toNat < 128 || x == '_' || x == '-')

def reservedTools : List String :=
  ["ask_questions", "async_status", "bash", "browse", "cancel_schedule", "computer", "edit",
   "glob", "grep", "list_schedules", "load_skill", "memory_save", "message-agents", "read",
   "run_subagent", "schedule", "stop_subagent", "update_schedule", "write"]

def toolProblem (name : String) (entry : Value) : Option String :=
  if reservedTools.contains name && entry.get "type" != some (.str "provider") then
    some s!"is a Broods tool name; only a provider tool that runs as {name} may use it"
  else none

def blobKeyId (ciphertext : String) : Option String :=
  if !ciphertext.startsWith "v2:" then none else
  let rest := String.ofList (ciphertext.toList.drop 3)
  if rest.contains ':' then some ((rest.splitOn ":").head!) else none

def currentKey (keys : List (String × Bool)) : Option String :=
  ((keys.reverse.find? (fun p => !p.2)).map Prod.fst)

def hasKey (keys : List (String × Bool)) (ciphertext : String) : Bool :=
  match blobKeyId ciphertext with
  | none => false
  | some k => keys.any (fun p => p.1 == k)

def needsRewrite (keys : List (String × Bool)) (ciphertext : String) : Bool :=
  blobKeyId ciphertext != currentKey keys

structure Mount where
  name : String
  workspaceId : String
  sandbox : Option String
  deriving BEq, Repr

def workspaceOnLaterSandbox (sandboxes : List String) (index : Nat) (refs : List Mount) : Option Mount :=
  if index == 0 then none else refs.find? (fun r => r.sandbox == sandboxes[index]?)

def findLaterSandboxMount (sandboxes : List String) (refs : List Mount) : Option (Nat × String × Mount) :=
  ((sandboxes.zipIdx).findSome? fun (id, index) =>
    (workspaceOnLaterSandbox sandboxes index refs).map (fun ref => (index, id, ref)))
end Spec.Config
namespace Spec.Config
open Lean

def Value.json : Value → Json
  | .null => .null
  | .bool b => toJson b
  | .num n => toJson n
  | .str s => toJson s
  | .arr xs => toJson (xs.map Value.json)
  | .obj xs => Json.mkObj (xs.map (fun p => (p.1, p.2.json)))

termination_by v => sizeOf v
decreasing_by
  all_goals have h := List.sizeOf_lt_of_mem ‹_ ∈ _›
  all_goals simp_all
  all_goals try omega
  cases p
  simp_all
  omega

def entries : Value → List (String × Value)
  | .obj xs => xs
  | _ => []

def put (v : Value) (k : String) (x : Value) : Value :=
  .obj ((entries v).filter (fun p => p.1 != k) ++ [(k, x)])

def remove (v : Value) (k : String) : Value :=
  .obj ((entries v).filter (fun p => p.1 != k))

/-- `configValues.ts:mergeConfigValue`, with explicit recursion budget (L700). -/
def mergeValue : Nat → Option Value → Value → Option Value
  | 0, old, _ => old
  | n+1, old, patch =>
    if patch == .str "********" then old else
    match patch with
    | .null => none
    | .obj xs => some (xs.foldl (fun acc (key, value) =>
      if key == "__proto__" || key == "constructor" || key == "prototype" then acc else
      match mergeValue n ((old.getD .null).get key) value with
      | none => remove acc key
      | some next => put acc key next) (objectOr (old.getD .null) (.obj [])))
    | other => some other

def mergeObjects (old patch : Value) : Value :=
  objectOr ((mergeValue 100 (some old) patch).getD .null) (.obj [])

def remapKeys (v mapping : Value) : Value :=
  (entries v).foldl (fun acc (k, x) =>
    let key := match mapping.get k with
      | some (.str s) => s
      | _ => if k == "__proto__" then "[object Object]" else k
    put acc key x) (.obj [])

/-- JSON-only inputs have no undefined fields, so stripUndefined is identity. -/
def stripUndefined (v : Value) : Value := v

/-- Canonical key order is represented as JSON, leaving its JS string encoding to replay. -/
def sortValue : Nat → Value → Value
  | 0, v => v
  | n+1, .arr xs => .arr (xs.map (sortValue n))
  | n+1, .obj xs => .obj ((xs.mergeSort (fun a b => a.1 ≤ b.1)).map (fun (k,v) => (k, sortValue n v)))
  | _, v => v

/-- Config normalisation has no environment input; changing a secret map cannot influence it. -/
def normaliseCredential (value : String) (_environment : List (String × String)) : String := value

/-- Envelope sealing consumes the caller's JSON unchanged; no placeholder or secret check occurs. -/
def envelopePlaintext (value : Value) : Value := value

/-- The codec's flat/nested lens on its maxTurn/system string fragment. -/
structure AgentFragment where
  maxTurns : Int
  system : String
  deriving DecidableEq, Repr

def encodeFragment (v : AgentFragment) : Value :=
  .obj [("agent", .obj ([("maxTurn", .num v.maxTurns)] ++
    (if v.system == "" then [] else [("system",.str v.system)])))]
def decodeFragment (v : Value) : AgentFragment :=
  let agent := (v.get "agent").getD (.obj [])
  let turns := match agent.get "maxTurn" with | some (.num n) => n | _ => 0
  let system := match agent.get "system" with | some (.str s) => s | _ => ""
  ⟨turns,system⟩
end Spec.Config
namespace Spec.Config

def typeProblem (expected : String) (value : Value) : Option String :=
  match expected, value with
  | "boolean", .bool _ | "object", .obj _ | "string", .str _ => none
  | _, _ => some (if expected == "object" then "must be an object" else s!"must be a {expected}")

def fieldProblem (v : Value) (fields : List (String × String)) (path : String) : Option String :=
  fields.findSome? fun (key, expected) =>
    (v.get key).bind fun x => (typeProblem expected x).map fun e => s!"{path}.{key} {e}"

def normaliseTools (v : Value) : Except String Value :=
  match v with
  | .null => .ok v
  | .obj raw =>
    let xs := raw.filter (fun p => p.1 != "__proto__")
    match xs.findSome? (fun (name, entry) =>
      if !providerToolName name then some s!"config.tools.{name} is not a supported tool"
      else match typeProblem "object" entry with
      | some _ => some s!"config.tools.{name} must be an object"
      | none => fieldProblem entry [("enabled","boolean"),("needsApproval","boolean"),("config","object")]
        s!"config.tools.{name}") with
    | some error => .error error
    | none =>
      match xs.findSome? (fun (name,entry) => (toolProblem name entry).map (fun e => s!"config.tools.{name} {e}")) with
      | some error => .error error
      | none => .ok (.obj (xs.map fun (name,entry) =>
        let clean := objectOr entry (.obj [])
        let clean := match entry.get "config" with
          | some config => put clean "config" (objectOr config (.obj []))
          | none => clean
        (name,clean)))
  | _ => .error "config.tools must be an object"

def defaultSandbox (config : Value) : Option String :=
  match config.get "sandboxes" with
  | some (.arr (.str s :: _)) => some s
  | _ => none

def mergeCanvas (canvas stored visible : List String) : List String :=
  (canvas ++ stored.filter (fun id => !visible.contains id)).eraseDups

/-- Explicit integer form of httpJson's ceil and minimum-one Retry-After rule. -/
def rateHeaders (limit resetCeil : Int) : Value :=
  let seconds := toString (max 1 resetCeil)
  .obj [("Retry-After", .str seconds), ("RateLimit-Limit", .str (toString limit)),
    ("RateLimit-Remaining", .str "0"), ("RateLimit-Reset", .str seconds)]

def methodError (allowed : List String) : Value :=
  apiError 405 ("Method not allowed. Allowed: " ++ String.intercalate ", " allowed ++ ".") none none
end Spec.Config
namespace Spec.Config

def providerBase (v : Value) : Option String :=
  let raw := match v.get "base_url" with
    | some (.str s) => some s
    | _ => match v.get "baseURL" with | some (.str s) => some s | _ => none
  raw.bind fun s => let trimmed := Spec.Js.trim s
                   if trimmed == "" then none else some trimmed

def gatewayIdValid (s : String) : Bool :=
  0 < s.length && s.length ≤ 64 && s.toList.all (fun c =>
    (c.isAlphanum && c.toNat < 128) || c == '_' || c == '-')

def settingsOrder (v : Value) : List (String × Value) :=
  let known := ["apiKey","gatewayId","base_url","baseURL","headers"]
  known.filterMap (fun key => (v.get key).map (fun x => (key,x))) ++
    (entries v).filter (fun p => !known.contains p.1 && p.1 != "__proto__")

/-- `PROVIDER_ENDPOINT_SETTING` (`/url$/i`), ASCII case only. -/
def endpointSetting (key : String) : Bool := key.toLower.endsWith "url"

/-- The refinement's verdict on one setting: a URL-named key, `base_url` and `baseURL` included,
holds a string whose trimmed value is blank or passes `urlProblem`. -/
def endpointProblem (urlProblem : String → Option String) (root : String)
    (entry : String × Value) : Option String :=
  if !endpointSetting entry.1 then none
  else match entry.2 with
    | .str s => if Spec.Js.trim s == "" then none
      else (urlProblem (Spec.Js.trim s)).map (fun e => s!"{root}.{entry.1} {e}")
    | _ => some s!"{root}.{entry.1} must be a string"

/-- PROVIDER_SETTINGS parse/refinement/transform, with WHATWG parsing supplied explicitly (L701). -/
def normaliseProviderSettings (urlProblem : String → Option String) (v : Value) : Except String Value :=
  let root := "config.provider.openai"
  match v with
  | .obj _ =>
    let ordered := settingsOrder v
    let shapeError := ["apiKey","gatewayId","base_url","baseURL","headers"].findSome? fun key =>
      (v.get key).bind fun x =>
        if key == "headers" then
          if stringValuesOr x (.str "bad") == .str "bad"
          then some s!"{root}.headers must be an object with string values" else none
        else if key == "gatewayId" then
          let valid := match x with | .str s => gatewayIdValid s | _ => false
          if valid then none else some s!"{root}.gatewayId must be an AI Gateway id (letters, digits, - and _)"
        else (typeProblem "string" x).map (fun e => s!"{root}.{key} {e}")
    match shapeError with
    | some e => .error e
    | none =>
      match ordered.findSome? (endpointProblem urlProblem root) with
      | some e => .error e
      | none =>
        let result := Value.obj (ordered.map fun (key,x) =>
          (key, if key == "headers" then objectOr x (.obj []) else x))
        match providerBase v with
        | none => .ok result
        | some s => .ok (remove (put result "baseURL" (.str s)) "base_url")
  | _ => .error s!"{root} must be an object"
end Spec.Config
