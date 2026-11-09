import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of `Session` ownership calls and small harness helpers that no test reached before.
-/

namespace Spec.Agent.Wave11

open Lean Spec

private def field (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

private def defined (value : Json) : Bool := value != Twin.undefinedJson

private def truthy (value : Json) : Bool := defined value && Access.Js.truthy value

/-- The `{ conversationKey, ownerEventId, ownerGeneration }` every ownership call sends. -/
private def owner (call : Json) : List (String × Json) :=
  let self := Twin.self call
  [("conversationKey", Twin.field self "conversationKey"), ("ownerEventId", Twin.field self "eventId"),
   ("ownerGeneration", Twin.field self "ownerGeneration")]

private def hasGeneration (call : Json) : Bool :=
  defined (Twin.field (Twin.self call) "ownerGeneration")

/-- `Session.renewConversationLease`: without an owner generation there is nothing to renew; a
renewal confirms ownership and the other answers are passed back. -/
def renewConversationLease (call : Json) : Prog Json := do
  if !hasGeneration call then return toJson "renewed"
  let startedAt ← Prog.effect "performance.now"
  let renewal ← Prog.effect "renewIngressOwner" [Json.mkObj (owner call)]
  if renewal == toJson "renewed" then
    let _ ← Prog.effect "this.confirmOwner" [startedAt]
  return renewal

/-- `Session.applySteeringIngress`: claims queued steering under the owner's generation, and confirms
ownership whatever came back. -/
def applySteeringIngress (call : Json) : Prog Json := do
  if !hasGeneration call then return Json.null
  let startedAt ← Prog.effect "performance.now"
  let textOnly := truthy (field (Twin.callArg call 0) "textOnly")
  let steering ← Prog.effect "applySteering"
    [Json.mkObj (owner call ++ if textOnly then [("textOnly", toJson true)] else [])]
  let _ ← Prog.effect "this.confirmOwner" [startedAt]
  return steering

/-- `Session.sandboxPrincipal`: the run token and public base URL a sandbox exec calls back with. -/
def sandboxPrincipal (call : Json) : Prog Json := do
  let principal := Twin.field (Twin.self call) "principal"
  if !truthy principal then return Twin.undefinedJson
  let baseUrl ← Prog.effect "getHarnessPublicUrl"
  let runToken ← Prog.effect "sealRunToken" [principal]
  return Json.mkObj (
    [("accountId", field principal "accountId"), ("agentId", field principal "agentId"),
     ("runToken", runToken)] ++
    if truthy baseUrl then [("baseUrl", baseUrl)] else [])

/-- `SubagentCoordinator.resolveAllowedAgent`: only an agent on the parent's allow list, and one that
still exists. -/
def resolveAllowedAgent (call : Json) : Prog Json := do
  let config := Twin.field (Twin.self call) "parentAgentConfig"
  let allowed := (field (field config "subagent") "allowed").getArr?.toOption.getD #[]
  let agentId := Twin.callArg call 1
  if !allowed.contains agentId then
    return ← Prog.throwError "Error" ("Subagent is not allowed: " ++ (agentId.getStr?.toOption.getD ""))
  let _ ← Prog.effect "getStorage"
  let agent ← Prog.effect "getStorage().agents.getById" [Twin.callArg call 0, agentId]
  if !truthy agent then
    return ← Prog.throwError "Error" ("Subagent not found: " ++ (agentId.getStr?.toOption.getD ""))
  return agent

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/session.ts#Session.renewConversationLease" renewConversationLease,
   Twin.traced "apps/core/src/harness/session.ts#Session.applySteeringIngress" applySteeringIngress,
   Twin.traced "apps/core/src/harness/session.ts#Session.sandboxPrincipal" sandboxPrincipal,
   Twin.traced "apps/core/src/harness/subagents.ts#SubagentCoordinator.resolveAllowedAgent" resolveAllowedAgent]

end Spec.Agent.Wave11
