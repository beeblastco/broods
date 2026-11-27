import Spec.Twin
import Spec.Agent.Model
import Spec.Agent.Twins.Loop.Policy
import Spec.Agent.Twins.Loop.Harness

/-!
Twins of the agent subsystem's functions outside `session.ts` and `subagents.ts`. See `AUTHORING.md`.
-/

namespace Spec.Agent

/-- The twins in this file. -/
def loopTwins : List Spec.Twin :=
  (policyTwinList ++ providerTwinList ++ harnessTwinList).map Js.comparable

end Spec.Agent
