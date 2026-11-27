import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign6/sandbox6a.tsv`.
-/

namespace Spec.Sandbox.Wavesandbox6a

open Lean Spec

private def fnRef (name : String) : Json :=
  Json.mkObj [("$fn", toJson name)]

/-- `processFileStream`: the stream's `start` begins polling at offset 0 and is never awaited. -/
private def processFileStream (call : Json) : Prog Json := do
  Prog.drain (fun label _ =>
    if label == "start" then
      Prog.spawn "readFileChunk" [Twin.callArg call 0, Twin.callArg call 1, toJson (0 : Nat)]
    else Prog.unsupported "unexpected stream callback") 1
  let stream ← Prog.effect "new ReadableStream"
    [Json.mkObj [("start", fnRef "start"), ("cancel", fnRef "cancel")]]
  return Json.mkObj
    [("stream", stream), ("done", Json.mkObj [("$opaque", toJson "Promise")])]

/-- `runSweep`: a sweep already running makes this tick do nothing. -/
private def runSweep (call : Json) : Prog Json := do
  if Twin.moduleValue call "sweeping" == toJson true then
    return Twin.undefinedJson
  Prog.setState "module.sweeping" (toJson true)
  Prog.spawn "sweepExpiredSandboxes"
  return Twin.undefinedJson

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/sandbox/harness-shell-process.ts#processFileStream"
     processFileStream,
   Twin.traced "apps/core/src/shared/sandbox-sweeper.ts#runSweep" runSweep]

end Spec.Sandbox.Wavesandbox6a
