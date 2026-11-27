import Spec.Twin
import Spec.Sandbox.Twins.Tools.Js

/-!
Twins of the MicroVM executor's lifecycle verbs that no repository test reaches, driven by the
focused tests in `replay/extra/core/sandbox13-*.test.ts`.
-/

namespace Spec.Sandbox.Wave12

open Lean Spec

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def truthy (value : Json) : Bool := value != Twin.undefinedJson && Tools.truthy value

private def microvm : String := "apps/core/src/harness/sandbox/microvm-executor.ts#MicrovmSandboxExecutor."

/-- `#reservedId`: the stored VM id for the request's reservation key, or null without a key. -/
private def reservedId (request : Json) : Prog Json := do
  let key ← Prog.effect "sandboxReservationKey" [request]
  if !truthy key then return Json.null
  Prog.effect "getSandboxExternalId" [toJson "lambda", key]

/-- `suspend` and `resume` send one command for the reserved VM, and nothing without one. -/
private def lifecycleVerb (command : String) (call : Json) : Prog Json := do
  let microvmId ← reservedId (Twin.callArg call 0)
  if truthy microvmId then
    let built ← Prog.effect command [Json.mkObj [("microvmIdentifier", microvmId)]]
    let _ ← Prog.effect "this.#client.send" [built]
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (microvm ++ "suspend") (lifecycleVerb "new SuspendMicrovmCommand"),
   Twin.traced (microvm ++ "resume") (lifecycleVerb "new ResumeMicrovmCommand")]

end Spec.Sandbox.Wave12
