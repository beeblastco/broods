import Lean
import Broods.Gateway
import Broods.Ingress
import Broods.AsyncResults
import Broods.Cron
import Broods.Sync
import Broods.SyncExternal
import Broods.SyncCron
import Broods.SyncEnv
import Broods.SyncConcurrency

open Lean Elab Command

/- Fails `lake build` when a `Broods` declaration rests on anything past the three
standard axioms: a new `axiom` (private too), `sorry` (`sorryAx`), or `native_decide`
(`Lean.ofReduceBool`). -/
run_cmd do
  let env ← getEnv
  let allowed := [``propext, ``Quot.sound, ``Classical.choice]
  for (name, _) in env.constants.map₁.toList do
    let some idx := env.getModuleIdxFor? name | continue
    unless (`Broods).isPrefixOf env.allImportedModuleNames[idx]! do continue
    for ax in ← collectAxioms name do
      unless allowed.contains ax do
        throwError "{name} rests on the axiom {ax}"
