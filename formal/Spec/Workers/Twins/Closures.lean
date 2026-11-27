import Spec.Twin

/-!
Twins of closures that outlive their maker in the worker queue. See `AUTHORING.md`.
-/

namespace Spec.Workers.Closures

open Lean Spec

private def undef (value : Json) : Bool := value == Twin.undefinedJson
private def anonymous : Json := Json.mkObj [("$fn", toJson "")]

/-- The slot timer's callback: aborts the overrunning run, frees its slot and settles it. -/
def slotOverrun (call : Json) : Prog Json := do
  let releaseSlot := Twin.moduleValue call "releaseSlot"
  let _ ← Prog.effect "runAbort.abort" [Prog.errorJson "Error" "I ran out of time on this turn."]
  if !undef releaseSlot then
    let _ ← Prog.effect "releaseSlot" []
    let _ ← Prog.effect "clearTimeout" [Json.mkObj [("$opaque", toJson "Timeout"), ("$fields", Json.mkObj [])]]
    Prog.setChanged "module.releaseSlot" releaseSlot Twin.undefinedJson
    let _ ← Prog.effect "startNextWorker" []
  if !undef (Twin.moduleValue call "abandon") then
    let _ ← Prog.effect "abandon" []
  return Twin.undefinedJson

/-- The promise executor `yieldSlot` waits on: queues the run to take a slot again, never shed. -/
def requeueForSlot (call : Json) : Prog Json := do
  Prog.drain (fun entered _ => if entered == "arg0" then pure () else Prog.unsupported entered) 1
  let entry := Json.arr #[Twin.moduleValue call "kind", anonymous, Twin.moduleValue call "heldLease"]
  Prog.effect "enqueueWorker" [entry, toJson false]

/-- The queue's lease timer: renews the leases of queued runs without waiting for it. -/
def renewTick (_call : Json) : Prog Json := do
  Prog.spawn "renewQueuedLeases" []
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/worker-queue.ts#dispatchInProcessWorker/arg0" slotOverrun,
   Twin.traced "apps/core/src/harness/worker-queue.ts#dispatchInProcessWorker/arg0~2" requeueForSlot,
   Twin.traced "apps/core/src/harness/worker-queue.ts#enqueueWorker/arg0" renewTick]

end Spec.Workers.Closures
