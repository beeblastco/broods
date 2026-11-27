import Spec.Twin
import Spec.Access.Twins.Js

/-!
Twins of closures that outlive their maker in `inputSchema.ts`. See `AUTHORING.md`.
-/

namespace Spec.Config.Closures

open Lean Spec

private def undef (value : Json) : Bool := value == Twin.undefinedJson

/-- The keys of a plain record in `Object.keys` order, from the recorder's `$keys` when it has them. -/
private def keysOf (value : Json) : List String :=
  match value with
  | .obj entries =>
    match value.getObjVal? "$keys" with
    | .ok (.arr names) => names.toList.filterMap fun name => (Json.getStr? name).toOption
    | _ => entries.toList.map (·.1)
  | _ => []

/-- `Number.isSafeInteger(value) && value >= 1 && value <= max`: the check `positiveInteger` runs. -/
def withinRange (call : Json) : Prog Json := do
  let max := Twin.moduleValue call "max"
  let ok := match Twin.callArg call 0, max with
    | .num value, .num cap =>
      let size := Spec.Access.Js.numFloat value
      size == size.floor && size.abs ≤ 9007199254740991.0 && size ≥ 1.0 &&
        size ≤ Spec.Access.Js.numFloat cap
    | _, _ => false
  return toJson ok

/-- zod's `NEVER` is the frozen `{status: "aborted"}`; identity is unobservable here, so its shape stands in. -/
private def isNever (value : Json) : Bool :=
  match value with
  | .obj _ => keysOf value == ["status"] && (value.getObjVal? "status").toOption == some (toJson "aborted")
  | _ => false

/-- `wholeValue`'s transform: passes a value through, or reports the one error when zod gave `NEVER`. -/
def wholeValueTransform (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  if !isNever value then return value
  let context := Twin.callArg call 1
  let issues := match context.getObjVal? "issues" with | .ok (.arr items) => items.toList | _ => []
  let issue := Json.mkObj [("code", toJson "custom"), ("message", Twin.moduleValue call "error")]
  Prog.setState "args.1.issues" (toJson (issues ++ [issue]))
  return value

/-- `refusingProtoKey`'s check: an own `__proto__` key is reported by name. -/
def protoKeyCheck (call : Json) : Prog Json := do
  let value := Twin.callArg call 0
  let hasProto := match value with
    | .obj entries => entries.toList.any (·.1 == "__proto__")
    | _ => false
  if hasProto then
    let _ ← Prog.effect "ctx.addIssue"
      [Json.mkObj [("code", toJson "custom"), ("path", toJson ["__proto__"]),
        ("message", Twin.moduleValue call "error")]]
  return Twin.undefinedJson

/-- `unsupportedKeys`' check: every key outside the allowed list is reported. -/
def unsupportedKeyCheck (call : Json) : Prog Json := do
  let allowed := match Twin.moduleValue call "keys" with
    | .arr names => names.toList
    | _ => []
  for key in keysOf (Twin.callArg call 0) do
    if !allowed.contains (toJson key) then
      let _ ← Prog.effect "ctx.addIssue"
        [Json.mkObj [("code", toJson "custom"), ("path", toJson [key]),
          ("message", toJson "is not supported")]]
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "packages/convex/model/inputSchema.ts#positiveInteger/arg0" withinRange,
   Twin.traced "packages/convex/model/inputSchema.ts#wholeValue/arg0" wholeValueTransform,
   Twin.traced "packages/convex/model/inputSchema.ts#refusingProtoKey/arg0" protoKeyCheck,
   Twin.traced "packages/convex/model/inputSchema.ts#unsupportedKeys/arg0" unsupportedKeyCheck]

end Spec.Config.Closures
