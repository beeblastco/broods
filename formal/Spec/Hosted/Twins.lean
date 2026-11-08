import Spec.Twin
import Spec.Hosted.Twins.Wavehosted1
import Spec.Hosted.Twins.Wavehosted3a
import Spec.Hosted.Twins.Wavehosted4a
import Spec.Hosted.Twins.Wavehosted5a
import Spec.Hosted.Twins.Wavehosted6a
import Spec.Hosted.Twins.Wavehosted8a

/-!
Twins of the hosted subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Hosted

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  [] ++ Wavehosted1.twins ++ Wavehosted3a.twins ++ Wavehosted4a.twins ++ Wavehosted5a.twins ++ Wavehosted6a.twins ++ Wavehosted8a.twins

end Spec.Hosted
