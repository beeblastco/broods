import Spec.Twin
import Spec.Sandbox.Model
import Spec.Sandbox.Twins.Runtime.SandboxRules

/-!
Twins of the sandbox runtime's functions, everything in the subsystem outside `harness/tools/`. See
`AUTHORING.md`.
-/

namespace Spec.Sandbox

/-- The twins in this file. -/
def runtimeTwins : List Spec.Twin :=
  Rt.sandboxRulesTwins

end Spec.Sandbox
