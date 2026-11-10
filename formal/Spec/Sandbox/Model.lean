import Spec.Statements
import Std

/-! Decision kernels from sandboxProviders.ts, filesystem-utils.ts, jobs.ts and platform-worker.ts. -/
namespace Spec.Sandbox

inductive Provider where
  | sandbox | lambda | e2b | daytona | vercel | cloudflare | worker | machine | custom
  deriving DecidableEq, Repr

def providers : List Provider := [.sandbox, .lambda, .e2b, .daytona, .vercel,
  .cloudflare, .worker, .machine, .custom]

/-- packages/convex/model/sandboxProviders.ts: workspace capability, including Daytona opt-in. -/
def s3Mount (p : Provider) (optIn : Bool) : Bool :=
  p == .lambda || p == .sandbox || p == .vercel || (p == .daytona && optIn)

def holdsWorkspace (p : Provider) (disk persistent optIn : Bool) : Bool :=
  if disk then p == .worker && persistent else s3Mount p optIn

def capabilities (p : Provider) : List Bool :=
  [p == .machine || p == .custom,
   p == .cloudflare || p == .worker,
   [.sandbox, .lambda, .daytona, .e2b, .vercel].contains p,
   p == .worker,
   p == .sandbox || p == .lambda,
   p == .sandbox || p == .lambda || p == .cloudflare,
   p == .daytona || p == .sandbox,
   [.daytona, .lambda, .sandbox, .vercel].contains p]

/-- ECMAScript TrimString WhiteSpace and LineTerminator code points. -/
def jsWhitespace (c : Char) : Bool :=
  [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
    8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279].contains c.toNat

def jsTrim (path : String) : String :=
  String.ofList ((path.toList.dropWhile jsWhitespace).reverse.dropWhile jsWhitespace).reverse

/-- filesystem-utils.ts:673; slash components after trim and removal of empty and dot segments. -/
def pathParts (path : String) : List String :=
  ((jsTrim path).splitOn "/").filter (fun p => p != "" && p != ".")

def lexicalPath (path : String) : Option String :=
  let parts := pathParts path
  if parts.contains ".." then none
  else some (if parts.isEmpty then "." else String.intercalate "/" parts)

/-- Bash selection when no workspace mounts the first sandbox, equal to `selectBash attached false`.
Computer actions use `selectComputer`. Account ownership of `attached` is a storage contract (A3). -/
def select (attached : List Nat) (requested : Option Nat) : Option Nat :=
  match requested with
  | none => attached.head?
  | some id => if id ∈ attached then some id else none

/-- resolveAgentSandbox in filesystem-utils.ts: unnamed takes the first sandbox; a name searches
`selectableSandboxes`, which leaves the first out when a workspace mounts it (`mounted`). -/
def selectBash (attached : List Nat) (mounted : Bool) (requested : Option Nat) : Option Nat :=
  match requested with
  | none => attached.head?
  | some id => if id ∈ (if mounted then attached.tail else attached) then some id else none

/-- computerSandboxTarget in filesystem-utils.ts: a name always decides; an unnamed call needs at
most one attached machine. -/
def selectComputer (machines : List Nat) (requested : Option Nat) : Option Nat :=
  match requested with
  | none => if machines.length ≤ 1 then machines.head? else none
  | some id => if id ∈ machines then some id else none

/-- machine-executor.ts:399; absent instance strings do not reclaim an occupied machine. -/
def acceptsHello (occupied : Bool) (previous incoming : Option String) (force : Bool) : Bool :=
  !occupied || force || (incoming.isSome && incoming != some "" && incoming == previous)

/-- jobs.ts:77 count and marker creation are separate scheduling inputs. -/
structure Jobs where
  running : Nat := 0
  admitted : Nat := 0
  deriving DecidableEq, Repr

inductive JobInput where
  | check | launch | finish
  deriving Repr

def jobStep (cap : Nat) (s : Jobs) : JobInput → Jobs
  | .check => if s.running < cap then { s with admitted := s.admitted + 1 } else s
  | .launch => if s.admitted > 0 then
      { running := s.running + 1, admitted := s.admitted - 1 } else s
  | .finish => { s with running := s.running - 1 }

/-- One physical externalId; a read in flight survives deletion in reservePlatformSandbox. -/
structure Instance where
  row : Bool := true
  physical : Bool := true
  cached : Bool := false
  returned : Bool := false
  deriving DecidableEq, Repr

inductive InstanceInput where
  | read | drop | delete | refreshReturn
  deriving Repr

def instanceStep (s : Instance) : InstanceInput → Instance
  | .read => { s with cached := s.row }
  | .drop => { s with physical := false }
  | .delete => { s with row := false }
  | .refreshReturn => { s with returned := s.cached }

/-- One expired reservation: active-account lease, CAS take, provider teardown and mirror removal. -/
structure Cleanup where
  row : Bool := true
  physical : Bool := true
  mirror : Bool := true
  deriving DecidableEq, Repr

inductive CleanupInput where
  | sweep (active lease cas providerSuccess : Bool)
  deriving Repr

def cleanupStep (s : Cleanup) : CleanupInput → Cleanup × List Bool
  | .sweep active lease cas success =>
    if active && lease && cas then
      if success then (⟨false, false, false⟩, [true])
      else (s, [false])
    else (s, [])

def cleanupSystem : Spec.System where
  State := Cleanup
  Input := CleanupInput
  Effect := Bool
  init := {}
  step := cleanupStep

/-- Cleanup outcomes are visible; account identity, provider credentials and file contents are not. -/
def cleanupLeak (trace : List CleanupInput) : List Bool :=
  trace.flatMap fun i => match i with
    | .sweep a l c p => if a && l && c then [p] else []

/-- Arbitrarily many concurrent callers can pass the check before any creates its marker. -/
def checkBurst (cap : Nat) : Nat → Jobs → Jobs
  | 0, s => s
  | n + 1, s => checkBurst cap n (jobStep cap s .check)

def launchBurst (cap : Nat) : Nat → Jobs → Jobs
  | 0, s => s
  | n + 1, s => launchBurst cap n (jobStep cap s .launch)

end Spec.Sandbox
