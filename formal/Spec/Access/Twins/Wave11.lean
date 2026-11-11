import Spec.Twin

/-!
Wave 11 twins of the access subsystem: functions that no repository test reached, now driven by
`replay/extra`. See `AUTHORING.md`.
-/

namespace Spec.Access.Wave11

open Lean Spec

private def member (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def intOf : Json → Option Int
  | .num n => if n.exponent == 0 then some n.mantissa else none
  | _ => none

private def intJson (value : Int) : Json := .num { mantissa := value, exponent := 0 }

private def isUndefined (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

/-- `OBSERVABILITY_TICKET_TTL_MS` in `observabilityTicket.ts`. -/
private def ticketTtlMs : Int := 5 * 60 * 1000

/-- `observabilityTicketExpiry`: the ttl from now, or the login's end if that comes first. -/
private def observabilityTicketExpiry (call : Json) : Prog Json := do
  match intOf (Twin.callArg call 0) with
  | none => Prog.unsupported "now is not an integer"
  | some now =>
    let expiry := now + ticketTtlMs
    let login := Twin.callArg call 1
    if isUndefined login then
      return intJson expiry
    match intOf login with
    | some end_ => return intJson (min expiry end_)
    | none => Prog.unsupported "login expiry is not an integer"

/-- `openObservabilityTicket`: a signed, well-shaped ticket that has not expired, else null. -/
private def openObservabilityTicket (call : Json) : Prog Json := do
  let decoded ← Prog.effect "openSignedTicket"
    [toJson "bdob_", toJson "observability-read-ticket:", Twin.callArg call 0, Twin.callArg call 1]
  let parsed ← Prog.effect "observabilityTicketSchema.safeParse" [decoded]
  if member parsed "success" != toJson true then
    return Json.null
  let data := member parsed "data"
  match intOf (member data "expiresAt"), intOf (Twin.param call 2) with
  | some expiresAt, some now => return if expiresAt > now then data else Json.null
  | _, _ => Prog.unsupported "expiry or clock is not an integer"

/-- `deleteWorkspaceFilesystem`: a bucketless workspace needs the platform bucket, else there is nothing to delete. -/
private def deleteWorkspaceFilesystem (call : Json) : Prog Json := do
  let accountId := Twin.callArg call 0
  let workspaceId := Twin.callArg call 1
  let storage := Twin.callArg call 2
  let bucket := member storage "bucket"
  let hasBucket := match bucket with
    | .str text => !text.isEmpty
    | _ => false
  if !hasBucket then
    let platform ← Prog.effect "optionalEnv" [toJson "FILESYSTEM_BUCKET_NAME"]
    let present := match platform with
      | .str text => !text.isEmpty
      | _ => false
    if !present then
      return intJson 0
  let base ← Prog.effect "workspaceNamespace" [accountId, workspaceId]
  let context ← Prog.effect "workspaceReadContext" [storage, base]
  let target ← Prog.effect "resolveS3ReadTarget" [context]
  Prog.effect "deleteS3Prefix"
    [member target "bucket", member target "prefix", member target "access"]

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "packages/convex/model/observabilityTicket.ts#observabilityTicketExpiry" observabilityTicketExpiry,
   Twin.traced "packages/convex/model/observabilityTicket.ts#openObservabilityTicket" openObservabilityTicket,
   Twin.traced "apps/core/src/accounts/cleanup.ts#deleteWorkspaceFilesystem" deleteWorkspaceFilesystem]

end Spec.Access.Wave11
