import Spec.Twin
import Spec.Config.Twins.Js

/-!
Wave 11 twins of the config subsystem: functions that no repository test reached, now driven by
`replay/extra`. See `AUTHORING.md`.
-/

namespace Spec.Config.Wave11

open Lean Spec Spec.Js

private def member (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def isUndefined (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

/-- `extractAgentFields`: a numeric `maxTurn` and a string `system` move into the flat patch. -/
private def extractAgentFields (call : Json) : Prog Json := do
  let agent := Twin.callArg call 0
  let patch := Twin.callArg call 1
  let (agent, patch) := match member agent "maxTurn" with
    | .num value => (del agent "maxTurn", set patch "maxTurns" (.num value))
    | _ => (agent, patch)
  let (agentNext, patchNext) := match member agent "system" with
    | .str text => (del agent "system", set patch "systemPrompt" (.str text))
    | _ => (agent, patch)
  Prog.setChanged "args.0" (Twin.callArg call 0) agentNext
  Prog.setChanged "args.1" (Twin.callArg call 1) patchNext
  return Twin.undefinedJson

/-- `extractSearchToolFields`: a boolean `enabled` moves to the patch; what is left of a copy of the
search config becomes `searchToolConfig`. -/
private def extractSearchToolFields (call : Json) : Prog Json := do
  let search := Twin.callArg call 0
  let patch := Twin.callArg call 1
  let (kept, patch) := match member search "enabled" with
    | .bool value => (del search "enabled", set patch "searchToolEnabled" (.bool value))
    | _ => (search, patch)
  let patchNext := if (entries kept).isEmpty then patch else set patch "searchToolConfig" kept
  Prog.setChanged "args.1" (Twin.callArg call 1) patchNext
  return Twin.undefinedJson

/-- `assertAgentHarnessSupport`: a config that sets a harness must pass the harness check. -/
private def assertAgentHarnessSupport (call : Json) : Prog Json := do
  let checked ← Prog.effect "parseInput"
    [Json.mkObj [("$opaque", toJson "ZodMiniObject")], Twin.callArg call 0, toJson "config"]
  let harness := member checked "harness"
  if isUndefined harness || harness == Json.null then
    return Twin.undefinedJson
  let policies := member checked "policies"
  let list := if isUndefined policies || policies == Json.null then Json.arr #[] else policies
  let _ ← Prog.effect "assertHarnessSupports" [checked, list]
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "packages/convex/model/agentConfigCodec.ts#extractAgentFields" extractAgentFields,
   Twin.traced "packages/convex/model/agentConfigCodec.ts#extractSearchToolFields" extractSearchToolFields,
   Twin.traced "packages/convex/model/agentRules.ts#assertAgentHarnessSupport" assertAgentHarnessSupport]

end Spec.Config.Wave11
