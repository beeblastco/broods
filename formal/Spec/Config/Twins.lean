import Spec.Twin
import Spec.Config.Twins.AgentRules
import Spec.Config.Twins.Rest

/-!
Twins of the config subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Config

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  (agentRuleTwins ++ restTwins).map Spec.Js.guardNull

end Spec.Config
