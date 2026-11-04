import Broods

open Lean Elab Command Meta

/- `lake env lean Statements.lean` fails when a public `Broods` theorem's printed statement
differs from `statements.txt`, so a weakened theorem shows in review even when its proof
compiles. `STATEMENTS=write` rewrites the file. Run after `lake build`; not cached by lake. -/
run_cmd do
  let env ← getEnv
  let mut lines : Array String := #[]
  for (name, info) in env.constants.map₁.toList do
    let some idx := env.getModuleIdxFor? name | continue
    unless (`Broods).isPrefixOf env.allImportedModuleNames[idx]! do continue
    let .thmInfo thm := info | continue
    if name.isInternalDetail || (← findDeclarationRanges? name).isNone then continue
    let shown ← liftTermElabM (ppExpr thm.type)
    let flat := " ".intercalate ((toString shown).splitOn "\n" |>.map (·.trimAscii.copy))
    lines := lines.push s!"{name} : {flat}"
  let text := "\n".intercalate (lines.qsort (· < ·)).toList ++ "\n"
  if (← IO.getEnv "STATEMENTS") == some "write" then
    IO.FS.writeFile "statements.txt" text
    logInfo m!"wrote {lines.size} statements"
  else
    let pinned ← IO.FS.readFile "statements.txt"
    unless pinned == text do
      let old := pinned.splitOn "\n"
      let new := text.splitOn "\n"
      let gone := old.filter (!new.contains ·)
      let added := new.filter (!old.contains ·)
      throwError m!"theorem statements differ from statements.txt\n- {gone}\n+ {added}\n{""
        }review the change, then `STATEMENTS=write lake env lean Statements.lean`"
