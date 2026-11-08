import Spec.Twin
import Spec.Access.Twins.Keys
import Spec.Access.Twins.Waveaccess1
import Spec.Access.Twins.Waveaccess2
import Spec.Access.Twins.Waveaccess3a
import Spec.Access.Twins.Waveaccess4a
import Spec.Access.Twins.Waveaccess5a
import Spec.Access.Twins.Waveaccess6a
import Spec.Access.Twins.Waveaccess8a
import Spec.Access.Twins.Waveroots9access

/-!
Twins of the access subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Access

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  Keys.runtimeKeyTwins ++ Keys.userTokenTwins ++ Waveaccess1.twins ++ Waveaccess2.twins ++ Waveaccess3a.twins ++ Waveaccess4a.twins ++ Waveaccess5a.twins ++ Waveaccess6a.twins ++ Waveaccess8a.twins ++ Waveroots9access.twins

end Spec.Access
