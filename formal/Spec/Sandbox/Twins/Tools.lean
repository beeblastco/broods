import Spec.Twin
import Spec.Sandbox.Model
import Spec.Sandbox.Twins.Tools.Filesystem

/-!
Twins of the built-in tools' functions (`apps/core/src/harness/tools/`). See `AUTHORING.md`.
-/

namespace Spec.Sandbox

/-- The twins in this file. -/
def toolTwins : List Spec.Twin :=
  Tools.filesystemTwins

end Spec.Sandbox
