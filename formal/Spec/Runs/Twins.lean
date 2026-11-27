import Spec.Twin
import Spec.Runs.Twins.Waveruns1
import Spec.Runs.Twins.Waveruns3a
import Spec.Runs.Twins.Waveruns4a
import Spec.Runs.Twins.Waveruns5a
import Spec.Runs.Twins.Waveruns6a
import Spec.Runs.Twins.Waveruns8a
import Spec.Runs.Twins.Wave10
import Spec.Runs.Twins.Wave11
import Spec.Runs.Twins.Wave12
import Spec.Runs.Twins.Closures

/-!
Twins of the runs subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Runs

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  [] ++ Waveruns1.twins ++ Waveruns3a.twins ++ Waveruns4a.twins ++ Waveruns5a.twins ++ Waveruns6a.twins ++ Waveruns8a.twins ++ Wave10.twins ++ Wave11.twins ++ Wave12.twins ++ Closures.twins

end Spec.Runs
