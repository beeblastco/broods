import Spec.Twin
import Spec.Runs.Twins.Waveruns8a
import Spec.Access.Twins.Js

/-!
Twins of access functions that hold module state or ask another function for an answer.
-/

namespace Spec.Access.Wave10

open Lean Spec

private def entries (value : Json) : List Json :=
  ((value.getObjVal? "$map").toOption.getD Json.null).getArr?.toOption.getD #[] |>.toList

/-- `MAX_CACHED_NAMES` in `secretNames.ts`. -/
private def maxCachedNames : Nat := 4096

/-- `isSecretName`: a name judged once is answered from the cache, which empties when it is full. -/
def isSecretName (call : Json) : Prog Json := do
  let name := Twin.callArg call 0
  let cache := Twin.moduleValue call "cachedNames"
  match (entries cache).findSome? fun entry =>
      if Twin.arg entry 0 == name then some (Twin.arg entry 1) else none with
  | some secret => return secret
  | none =>
    let secret ← Prog.effect "judgeName" [name]
    let kept := if (entries cache).length >= maxCachedNames then Json.mkObj [("$map", .arr #[])] else cache
    Prog.setState "module.cachedNames" (Runs.Waveruns8a.mapPut kept name secret)
    return secret

/-- `resetTempoTraceCacheForTests`: the trace cache is emptied. -/
def resetTempoTraceCacheForTests (call : Json) : Prog Json := do
  Runs.Waveruns8a.changed "module.tempoTraces" (Twin.moduleValue call "tempoTraces")
    (Json.mkObj [("$map", .arr #[])])
  return Twin.undefinedJson


/-- `sealObservabilityTicket`: signs the ticket under its own prefix and key context. -/
def sealObservabilityTicket (call : Json) : Prog Json :=
  Prog.effect "sealSignedTicket"
    [toJson "bdob_", toJson "observability-read-ticket:", Twin.callArg call 0, Twin.callArg call 1]

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "packages/convex/model/secretNames.ts#isSecretName" isSecretName,
   Twin.traced "apps/gateway/src/observability.ts#resetTempoTraceCacheForTests" resetTempoTraceCacheForTests,
   Twin.traced "packages/convex/model/observabilityTicket.ts#sealObservabilityTicket" sealObservabilityTicket]

end Spec.Access.Wave10
