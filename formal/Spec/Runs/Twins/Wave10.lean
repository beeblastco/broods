import Spec.Twin
import Spec.Runs.Twins.Waveruns8a

/-!
Twins of the test resets of core's cached connections, keyrings, Convex client and storage.
-/

namespace Spec.Runs.Wave10

open Lean Spec

private def undef (value : Json) : Bool := value == Twin.undefinedJson

private def emptyMap : Json := Json.mkObj [("$map", .arr #[])]

private def named (name : String) : Json := Json.mkObj [("$fn", toJson name)]

/-- `resetConnectionsForTests`: the three connection maps are emptied. -/
def resetConnectionsForTests (call : Json) : Prog Json := do
  for name in ["cache", "inFlight", "rejected"] do
    Waveruns8a.changed s!"module.{name}" (Twin.moduleValue call name) emptyMap
  return Twin.undefinedJson

/-- `resetAccountKeysForTests`: the keyrings are dropped and the loader is the override or Convex. -/
def resetAccountKeysForTests (call : Json) : Prog Json := do
  Waveruns8a.changed "module.keyrings" (Twin.moduleValue call "keyrings") emptyMap
  let override := Twin.callArg call 0
  let next := if undef override || override == Json.null then named "loadFromConvex" else override
  Waveruns8a.changed "module.loader" (Twin.moduleValue call "loader") next
  return Twin.undefinedJson

/-- `resetConvexClientForTests`: the cached client is dropped. -/
def resetConvexClientForTests (call : Json) : Prog Json := do
  Waveruns8a.changed "module.cached" (Twin.moduleValue call "cached") Json.null
  return Twin.undefinedJson

/-- `resetStorageForTests`: the cached storage is dropped. -/
def resetStorageForTests (call : Json) : Prog Json := do
  Waveruns8a.changed "module.cached" (Twin.moduleValue call "cached") Json.null
  return Twin.undefinedJson

/-- `setStorageForTests`: the cached storage is the argument. -/
def setStorageForTests (call : Json) : Prog Json := do
  Waveruns8a.changed "module.cached" (Twin.moduleValue call "cached") (Twin.callArg call 0)
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/connections.ts#resetConnectionsForTests" resetConnectionsForTests,
   Twin.traced "apps/core/src/shared/convex/account-keys.ts#resetAccountKeysForTests" resetAccountKeysForTests,
   Twin.traced "apps/core/src/shared/convex/client.ts#resetConvexClientForTests" resetConvexClientForTests,
   Twin.traced "apps/core/src/shared/storage.ts#resetStorageForTests" resetStorageForTests,
   Twin.traced "apps/core/src/shared/storage.ts#setStorageForTests" setStorageForTests]

end Spec.Runs.Wave10
