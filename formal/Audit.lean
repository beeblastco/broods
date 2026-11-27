import Lean
import Spec

/-!
The kernel-side audit. `lake env lean Audit.lean` fails if any declaration under `Spec` rests on an
axiom other than Lean's three standard ones, so `sorry` and `native_decide` fail it, or is `unsafe`
or `partial`. It then prints every front theorem's statement as the kernel holds it, and
`scripts/check.ts` compares that with the pinned `STATEMENTS.txt`, so a changed claim shows in review
even if the source is hidden behind a macro.
-/

open Lean Elab Command

/-- The only axioms a theorem may depend on. -/
def allowedAxioms : List Name :=
  [``propext, ``Classical.choice, ``Quot.sound]

/-- The module a declaration comes from, if it is one of this library's own. -/
def ownModule (env : Environment) (name : Name) : Option Name :=
  match env.getModuleIdxFor? name with
  | some idx =>
    let moduleName := env.header.moduleNames[idx.toNat]!
    if (`Spec).isPrefixOf moduleName then some moduleName else none
  | none => none

/-- True for a theorem stating a claim: subsystem `Theorems` modules and `Spec.Top` hold those, and
`Proofs` modules hold the lemmas beneath them. The equations Lean generates for a definition
(`f.eq_1`, `f.eq_def`) are not claims: their names are reserved, so no written theorem can take one. -/
def isFront (env : Environment) (name : Name) : Bool :=
  match ownModule env name with
  | some moduleName =>
    !name.isInternal && !isReservedName env name &&
      (moduleName == `Spec.Top || moduleName.getString! == "Theorems")
  | none => false

elab "#audit_spec" : command => do
  let env ← getEnv
  let own := env.constants.fold (init := #[]) fun acc name info =>
    if (ownModule env name).isSome then acc.push (name, info) else acc
  let mut theorems : Nat := 0
  let mut rejected : Array String := #[]
  for (name, info) in own do
    -- The compiler's own recursion helpers are internal names, and proofs cannot use them.
    if !name.isInternal && info.isUnsafe then
      rejected := rejected.push s!"{name} is unsafe"
    if !name.isInternal && info.isPartial then
      rejected := rejected.push s!"{name} is partial"
    if let .thmInfo _ := info then
      theorems := theorems + 1
      let axioms ← liftCoreM (collectAxioms name)
      for axiomName in axioms do
        if !allowedAxioms.contains axiomName then
          rejected := rejected.push s!"{name} rests on {axiomName}"
  if !rejected.isEmpty then
    throwError "audit failed:\n{String.intercalate "\n" rejected.toList}"
  logInfo m!"AUDIT PASSED: {own.size} declarations, {theorems} theorems, standard axioms only"

elab "#print_statements" : command => do
  let env ← getEnv
  let front := env.constants.fold (init := #[]) fun acc name info =>
    match info with
    | .thmInfo val =>
      if isFront env name then acc.push (name, val.type) else acc
    | _ => acc
  let sorted := front.qsort fun a b => a.1.toString < b.1.toString
  for (name, type) in sorted do
    let text ← liftTermElabM (Meta.ppExpr type)
    IO.println s!"{name}\n  {text}\n"

#audit_spec
#print_statements
