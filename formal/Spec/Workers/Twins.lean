import Spec.Twin
import Spec.Workers.Twins.Closures

/-!
Twins of the workers subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Workers

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  [] ++ Closures.twins

end Spec.Workers
