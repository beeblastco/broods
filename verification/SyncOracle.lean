import Broods.Sync

/-! Runs `Broods.Sync.diff` on `LOCAL<TAB>REMOTE` lines from stdin, one diff per line.
A manifest is space-separated `kind:name:settings:bundle:storage` resources, `-` for an
absent bundle or storage. A diff is space-separated `op:kind:name` entries, unsorted.
`tests/sync-oracle.test.ts` diffs it against `diffManifests`. -/

open Broods.Sync

def kinds : List (String × Kind) :=
  [("agent", .agent), ("workspace", .workspace), ("sandbox", .sandbox), ("cron", .cron),
    ("skill", .skill), ("hook", .hook), ("mcp", .mcp), ("policy", .policy),
    ("channelRecord", .channelRecord)]

def kindName (k : Kind) : String :=
  ((kinds.find? (·.2 == k)).map (·.1)).getD "?"

def opName : Op → String
  | .create => "create"
  | .update => "update"
  | .delete => "delete"
  | .rename => "rename"

/-- `-` is none, a number is that number. -/
def parseOption (s : String) : Option (Option Nat) :=
  if s == "-" then some none else s.toNat?.map some

def parseResource (s : String) : Option Resource := do
  let [k, n, settings, bundle, storage] := s.splitOn ":" | none
  let kind ← (kinds.find? (·.1 == k)).map (·.2)
  pure ⟨kind, ← n.toNat?, ⟨← settings.toNat?, ← parseOption bundle, ← parseOption storage⟩⟩

def parseManifest (s : String) : Option Manifest :=
  ((s.splitOn " ").filter (· ≠ "")).mapM parseResource

def answer (line : String) : String :=
  match line.splitOn "\t" with
  | [l, r] =>
    match parseManifest l, parseManifest r with
    | some localM, some remote =>
      " ".intercalate ((diff localM remote).map fun e =>
        s!"{opName e.op}:{kindName e.kind}:{e.name}")
    | _, _ => s!"error: bad manifest in {line.quote}"
  | _ => s!"error: bad line {line.quote}"

def main : IO Unit := do
  let stdin ← IO.getStdin
  let mut out := ""
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    out := out ++ answer (line.dropEndWhile '\n').copy ++ "\n"
  IO.print out
