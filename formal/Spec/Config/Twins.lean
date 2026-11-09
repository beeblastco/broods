import Spec.Twin
import Spec.Config.Twins.AgentRules
import Spec.Config.Twins.Rest
import Spec.Config.Twins.Wave10

/-!
Twins of the config subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Config

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  (agentRuleTwins ++ restTwins ++ Wave10.twins).map Spec.Js.guardNull

end Spec.Config
