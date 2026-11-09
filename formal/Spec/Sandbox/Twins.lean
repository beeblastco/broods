import Spec.Sandbox.Twins.Tools
import Spec.Sandbox.Twins.Runtime
import Spec.Sandbox.Twins.Wavesandbox1
import Spec.Sandbox.Twins.Wavesandbox2
import Spec.Sandbox.Twins.Wavesandbox3a
import Spec.Sandbox.Twins.Wavesandbox3b
import Spec.Sandbox.Twins.Wavesandbox4a
import Spec.Sandbox.Twins.Wavesandbox4b
import Spec.Sandbox.Twins.Wavesandbox5a
import Spec.Sandbox.Twins.Wavesandbox5b
import Spec.Sandbox.Twins.Wavesandbox6a
import Spec.Sandbox.Twins.Wavesandbox6b
import Spec.Sandbox.Twins.Wavesandbox8a
import Spec.Sandbox.Twins.Wavesandbox8b
import Spec.Sandbox.Twins.Waveroots9sandbox
import Spec.Sandbox.Twins.Wave10
import Spec.Sandbox.Twins.Wave11
import Spec.Sandbox.Twins.Wave12
import Spec.Sandbox.Twins.Closures

/-!
Twins of the sandbox subsystem's functions.
-/

namespace Spec.Sandbox

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  toolTwins ++ runtimeTwins ++ Wavesandbox1.twins ++ Wavesandbox2.twins ++ Wavesandbox3a.twins ++ Wavesandbox3b.twins ++ Wavesandbox4a.twins ++ Wavesandbox4b.twins ++ Wavesandbox5a.twins ++ Wavesandbox5b.twins ++ Wavesandbox6a.twins ++ Wavesandbox6b.twins ++ Wavesandbox8a.twins ++ Wavesandbox8b.twins ++ Waveroots9sandbox.twins ++ Wave10.twins ++ Wave11.twins ++ Wave12.twins ++ Closures.twins

end Spec.Sandbox
