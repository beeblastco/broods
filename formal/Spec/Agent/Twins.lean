import Spec.Agent.Twins.Session
import Spec.Agent.Twins.Loop
import Spec.Agent.Twins.Continuation
import Spec.Agent.Twins.Waveagent1
import Spec.Agent.Twins.Waveagent2
import Spec.Agent.Twins.Waveagent3a
import Spec.Agent.Twins.Waveagent3b
import Spec.Agent.Twins.Waveagent4a
import Spec.Agent.Twins.Waveagent4b
import Spec.Agent.Twins.Waveagent5a
import Spec.Agent.Twins.Waveagent5b
import Spec.Agent.Twins.Waveagent6a
import Spec.Agent.Twins.Waveagent6b
import Spec.Agent.Twins.Waveagent8a
import Spec.Agent.Twins.Waveagent8b
import Spec.Agent.Twins.Wave10
import Spec.Agent.Twins.Wave11
import Spec.Agent.Twins.Closures

/-!
Twins of the agent subsystem's functions.
-/

namespace Spec.Agent

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  sessionTwins ++ loopTwins ++ Continuation.continuationTwins ++ Waveagent1.twins ++ Waveagent2.twins ++ Waveagent3a.twins ++ Waveagent3b.twins ++ Waveagent4a.twins ++ Waveagent4b.twins ++ Waveagent5a.twins ++ Waveagent5b.twins ++ Waveagent6a.twins ++ Waveagent6b.twins ++ Waveagent8a.twins ++ Waveagent8b.twins ++ Wave10.twins ++ Wave11.twins ++ Closures.twins

end Spec.Agent
