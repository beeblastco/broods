import Spec.Workers.Twins
import Spec.Access.Twins
import Spec.Runs.Twins
import Spec.Agent.Twins
import Spec.Sandbox.Twins
import Spec.Channels.Twins
import Spec.Hosted.Twins
import Spec.Config.Twins

/-!
Every twin in the library.
-/

namespace Spec

/-- All twins, across subsystems. -/
def allTwins : List Twin :=
  Workers.twins ++ Access.twins ++ Runs.twins ++ Agent.twins ++ Sandbox.twins ++ Channels.twins ++ Hosted.twins ++ Config.twins

end Spec
