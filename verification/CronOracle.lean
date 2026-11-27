import Broods.Cron

/-! Runs `Broods.Cron.run` from `fresh` on step lines from stdin, one final state per line.
Steps are space-separated `start:r:t`, `complete:r`, `fail:r` or `refuse:t`. A state is
the run rows `0..max` as `r=status` (`-` for no row), then `cron=lastRunId,lastStatus,
lastFired` with `-` for none. `packages/convex/tests/cronOracle.test.ts` drives the
Convex mutations through the same steps and compares. -/

open Broods.Cron

def statusName : Option Status → String
  | none => "-"
  | some .started => "started"
  | some .completed => "completed"
  | some .failed => "failed"

def optNat : Option Nat → String
  | none => "-"
  | some n => toString n

def parseStep (s : String) : Option Step :=
  match s.splitOn ":" with
  | ["start", r, t] => do pure (.start (← r.toNat?) (← t.toNat?))
  | ["complete", r] => do pure (.settle (← r.toNat?) .complete)
  | ["fail", r] => do pure (.settle (← r.toNat?) .fail)
  | ["refuse", t] => do pure (.refuse (← t.toNat?))
  | _ => none

/-- Run ids a step names, to know which rows to print. -/
def runId : Step → Option Nat
  | .start r _ | .settle r _ => some r
  | .refuse _ => none

def answer (line : String) : String :=
  match ((line.splitOn " ").filter (· ≠ "")).mapM parseStep with
  | none => s!"error: bad steps {line.quote}"
  | some steps =>
    let s := run fresh steps
    let top := (steps.filterMap runId).foldl max 0
    let rows := (List.range (top + 1)).map fun r => s!"{r}={statusName (s.runs r)}"
    let c := s.cron
    " ".intercalate rows ++
      s!" cron={optNat c.lastRunId},{statusName c.lastStatus},{optNat c.lastFired}"

def main : IO Unit := do
  let stdin ← IO.getStdin
  let mut out := ""
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    out := out ++ answer (line.dropEndWhile '\n').copy ++ "\n"
  IO.print out
