import Spec.Statements
import Lean.Data.Json

/-! Tenant execution decisions from mcp/hosted.ts, frames.ts, isolate/executor.ts and both runners.
JSON payload values are opaque; ordered fields, line splitting and decisions are executable.
-/
namespace Spec.Hosted
open Lean

/-- Lambda handler and Worker loader append the digest to the tenant; isolate cache uses tenant only. -/
structure TenantKey where
  tenant : String
  digest : String
  deriving DecidableEq, Repr

def loaderKey (k : TenantKey) : String := k.tenant ++ ":" ++ k.digest

def tenantId (account : String) (agent : Option String) : String :=
  match agent with
  | some a => if a.isEmpty then account else account ++ ":" ++ a
  | none => account

/-- Ordered JSON grammar: tag, request id if present, payload, optional CPU stamp. -/
inductive Frame where
  | final (id : String) (result : Json)
  | error (id : String) (message : String)
  | endBatch (cpu : Option Nat)
  | failedBatch (message : String) (cpu : Option Nat)
  | chunk (output : Json)
  | log (level message : String)

def fields : Frame → List (String × Json)
  | .final id result => [("t", "final"), ("id", toJson id), ("result", result)]
  | .error id message => [("t", "error"), ("id", toJson id), ("error", toJson message)]
  | .endBatch cpu => [("t", Json.str "end")] ++ cpu.toList.map (fun n => ("cpuUsec", toJson n))
  | .failedBatch message cpu => [("t", Json.str "error"), ("error", toJson message)] ++
      cpu.toList.map (fun n => ("cpuUsec", toJson n))
  | .chunk output => [("t", "chunk"), ("output", output)]
  | .log level message => [("t", "log"), ("level", toJson level), ("message", toJson message)]

/-- Fixed prefixes preserve the actual emitters' insertion order. -/
def encode (f : Frame) : String :=
  match f with
  | .final id result => "{\"t\":\"final\",\"id\":" ++ (toJson id).compress ++ ",\"result\":" ++ result.compress ++ "}\n"
  | .error id msg => "{\"t\":\"error\",\"id\":" ++ (toJson id).compress ++ ",\"error\":" ++ (toJson msg).compress ++ "}\n"
  | .endBatch none => "{\"t\":\"end\"}\n"
  | .endBatch (some cpu) => "{\"t\":\"end\",\"cpuUsec\":" ++ toString cpu ++ "}\n"
  | .failedBatch msg cpu => "{\"t\":\"error\",\"error\":" ++ (toJson msg).compress ++
      (match cpu with | none => "" | some n => ",\"cpuUsec\":" ++ toString n) ++ "}\n"
  | .chunk output => "{\"t\":\"chunk\",\"output\":" ++ output.compress ++ "}\n"
  | .log level message => "{\"t\":\"log\",\"level\":" ++ (toJson level).compress ++ ",\"message\":" ++ (toJson message).compress ++ "}\n"

def terminal : Frame → Bool
  | .endBatch _ | .failedBatch _ _ => true
  | _ => false

/-- Lambda handler.mjs:25 checks bytes at the beginning of each LF-terminated line. -/
def hasPrefix : List Char → List Char → Bool
  | [], _ => true
  | _, [] => false
  | p :: ps, c :: cs => p == c && hasPrefix ps cs

def terminalPrefix (s : String) : Bool :=
  hasPrefix "{\"t\":\"end\"".toList s.toList ||
    hasPrefix "{\"t\":\"error\",\"error\"".toList s.toList

def acceptJson (j : Json) : Option Json := do
  let t ← (j.getObjValAs? String "t").toOption
  if t ∈ ["chunk", "final", "end", "error", "log"] then some j else none

/-- frames.ts:56 intentionally accepts known-tag JSON without validating other fields (G600). -/
def parseLine (s : String) : Option Json := do
  let j ← (Json.parse s.trimAscii.toString).toOption
  acceptJson j

structure Lines where
  pending : List Char := []
  complete : List String := []
  deriving DecidableEq, Repr

def feedChar (s : Lines) (c : Char) : Lines :=
  if c = '\n' then ⟨[], s.complete ++ [String.ofList s.pending]⟩
  else { s with pending := s.pending ++ [c] }

def feed (s : Lines) (cs : List Char) : Lines := cs.foldl feedChar s

def closeLines (s : Lines) : List Json :=
  (s.complete ++ [String.ofList s.pending]).filterMap parseLine

/-- One push per chunk; close also attempts the unterminated trailing line. -/
def parseChunks (chunks : List (List Char)) : List Json :=
  closeLines (chunks.foldl feed {})

inductive Failure where
  | neverConnected | nothingRan (status : Nat) | timeout | abort | reset | http (status : Nat)
  | missingBody | missingEnd | batchError | malformed
  deriving DecidableEq, Repr

/-- Only the Worker's no-execution signal and the six never-connected codes permit fallback. -/
def retry : Failure → Bool
  | .neverConnected | .nothingRan _ => true
  | _ => false

def mayHaveRun : Failure → Bool
  | .neverConnected | .nothingRan _ => false
  | _ => true

/-- mcp/hosted.ts:544 pins only tagged HTTP 422, for account:digest rather than agent. -/
def pinUntil (now : Nat) : Failure → Option Nat
  | .nothingRan 422 => some (now + 600000)
  | _ => none

def useWorker (now : Nat) (pin : Option Nat) (lambda compatible key url : Bool) : Bool :=
  !(pin.any (fun expiry => now < expiry)) && !lambda && compatible && key && url

def batchKey (tenant route digest : String) : String := tenant ++ ":" ++ route ++ ":" ++ digest

def batchFlush (age count : Nat) (window : Nat := 10) (maximum : Nat := 8) : Bool :=
  decide (window ≤ age ∨ maximum ≤ count)

inductive Outcome where
  | response (status : Nat) (body : String) | failure (message : String)
  deriving DecidableEq, Repr

structure Collection where
  outcomes : List (String × Outcome) := []
  ended : Bool := false
  cpu : Option Nat := none
  deriving DecidableEq, Repr

inductive BatchFrame where
  | answer (id : String) (outcome : Outcome)
  | endBatch (cpu : Option Nat)
  | failedBatch (message : String) (cpu : Option Nat)
  | ignore
  deriving Repr

def put (xs : List (String × Outcome)) (id : String) (v : Outcome) : List (String × Outcome) :=
  (id, v) :: xs.filter (fun p => p.1 != id)

def collect (requests : List String) (s : Collection) (f : BatchFrame) : Collection :=
  if s.ended then s else
  match f with
  | .answer id v => { s with outcomes := put s.outcomes id v }
  | .endBatch cpu => { s with ended := true, cpu := cpu }
  | .failedBatch msg cpu =>
    { ended := true, cpu := cpu, outcomes := requests.foldl (fun xs id =>
        if (xs.lookup id).isSome then xs else put xs id (.failure msg)) s.outcomes }
  | .ignore => s

/-- Every non-aborted promise settles, even when its id was absent; duplicate frames overwrite. -/
def settle (requests : List String) (s : Collection) : List (String × Outcome) :=
  requests.map (fun id => (id, (s.outcomes.lookup id).getD (.failure "no response")))

inductive WorkerPhase where
  | starting | idle | busy | dead
  deriving DecidableEq, Repr

structure Worker where
  phase : WorkerPhase
  tenants : List String := []
  idleAt : Nat := 0
  deriving DecidableEq, Repr

/-- Affinity is only a preference: an idle host may carry another tenant's separate isolate. -/
def chooseWorker (pool : List Worker) (tenant : String) : Option Nat :=
  (pool.findIdx? (fun w => w.phase == .idle && tenant ∈ w.tenants)).orElse
    (fun _ => pool.findIdx? (fun w => w.phase == .idle))

inductive PoolEvent where
  | ready | acquire | release (tenant : String) (now : Nat) | die
  deriving Repr

def workerStep (w : Worker) : PoolEvent → Worker
  | .ready => if w.phase == .starting then { w with phase := .idle } else w
  | .acquire => if w.phase == .idle then { w with phase := .busy } else w
  | .release t now => if w.phase == .busy then
      { phase := .idle, tenants := t :: w.tenants, idleAt := now } else w
  | .die => { w with phase := .dead }

/-- acquireWorker retries startup three times, 100/200ms; death after ready does not count. -/
def startupResult (failures : Nat) (ready alive : Bool) : String :=
  if alive then "acquired" else if ready then "replace"
  else if failures + 1 ≥ 3 then "failed" else "backoff"

def reapable (size now ttl : Nat) (w : Worker) : Bool :=
  size > 1 && w.phase != .busy && ttl ≤ now && w.idleAt + ttl ≤ now

/-- runner.mjs cache LRU, default cap two; execution failure or watchdog poisons this entry. -/
def isolateCache (cache : List String) (tenant : String) (cap : Nat) (poisoned : Bool) : List String :=
  let touched := (cache.filter (fun t => t != tenant)) ++ [tenant]
  let trimmed := touched.drop (touched.length - cap)
  if poisoned then trimmed.filter (fun t => t != tenant) else trimmed

structure Listing where
  key : String
  expiresAt : Nat
  deriving Repr

def listingHit (now : Nat) (uncached machineWithoutSandbox : Bool) (entry : Option Listing) : Bool :=
  !uncached && !machineWithoutSandbox && entry.any (fun e => now < e.expiresAt)

def listingTtl (asked : Option Nat) : Nat :=
  min (match asked with | some n => if n > 0 then n else 300000 | none => 300000) 3600000

/-- G7: semantic rate-limit errors may retry three times after acting; transport errors do not. -/
def semanticRetry (isError rateLimited aborted : Bool) (attempt : Nat) : Bool :=
  isError && rateLimited && !aborted && decide (1 ≤ attempt ∧ attempt ≤ 3)

def rateWait (attempt : Nat) (asked : Option Nat) : Nat :=
  min (asked.getD (if attempt = 0 then 1000 else 2000 * 2 ^ (attempt - 1))) 60000

inductive RunStatus where
  | awaitingInput | awaitingApproval | completed | failed | expired | other
  deriving Repr, DecidableEq

/-- mcp-tasks.ts:149; failed tasks are successful protocol replies carrying isError. -/
def taskStatus (status : RunStatus) (stopped : Bool) : String × Bool :=
  match status with
  | .awaitingInput | .awaitingApproval => ("input_required", false)
  | .completed => ("completed", false)
  | .failed => if stopped then ("cancelled", false) else ("completed", true)
  | .expired => ("completed", true)
  | .other => ("working", false)

def completedError (responsePresent errorPresent : Bool) : Bool := !responsePresent && errorPresent

def writeAccepted (ok : Bool) (status : Nat) (settledOnConflict : Bool) : Bool :=
  ok || (settledOnConflict && status == 409)

/-- All deliberate side channels, including listing cache and shared host scheduling, are public. -/
structure Observation where
  host : Nat
  listingHit : Bool
  contention : Nat
  result : String
  deriving DecidableEq, Repr

structure World where
  visible : Observation
  otherTenantSecret : String

def observe (w : World) : Observation := w.visible

def observationSystem : Spec.System where
  State := World
  Input := World
  Effect := Observation
  init := ⟨⟨0, false, 0, ""⟩, ""⟩
  step := fun _ w => (w, [observe w])

/-- Skill paths reject traversal and empty segments, but permit a literal dot segment. -/
def skillPath (path : String) : Bool :=
  let s := path.trimAscii.toString
  !s.isEmpty && !s.startsWith "/" && !s.contains '\\' && !s.contains '\x00' &&
    !(s.splitOn "/").any (fun part => part == ".." || part == "")

def skillName (s : String) : Bool :=
  !s.isEmpty && s.length ≤ 64 && s.toList.all (fun c => (c ≥ 'a' && c ≤ 'z') || (c ≥ '0' && c ≤ '9') || c == '-') &&
    !(s.splitOn "anthropic").length > 1 && !(s.splitOn "claude").length > 1

/-- MCP row cross-field rules, after field syntax normalization. -/
def validMcpRow (machine hosted sandbox command headers runtime oauth https authorization : Bool) : Bool :=
  (!machine || sandbox) && (machine || !command) && (!machine || !headers) &&
  (!runtime || hosted) && (!oauth || (!machine && !hosted && https && !authorization))

end Spec.Hosted
