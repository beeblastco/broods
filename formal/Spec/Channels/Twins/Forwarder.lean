import Spec.Channels.Twins.Support

/-!
Twins of the Discord forwarder's pure functions: `apps/discord-forwarder/src/discord.ts`, `config.ts` and
the helpers of `supervisor.ts`.
-/

namespace Spec.Channels

open Lean

private def planesEnv : String := "BROODS_CONFIG_PLANES"

/-- `HEARTBEAT_MAX_MS` and `HEARTBEAT_MIN_MS` in `discord.ts:20`. -/
def heartbeatMaxMs : Nat := 300000
def heartbeatMinMs : Nat := 1000

/-- `heartbeatIntervalMs`: anything but a number is the maximum, and a number is clamped. -/
def heartbeatIntervalMs : Json → Json
  | .num n =>
    if !numLe n heartbeatMaxMs then toJson heartbeatMaxMs
    else if !numGe n heartbeatMinMs then toJson heartbeatMinMs
    else .num n
  | _ => toJson heartbeatMaxMs

private def gatewayLabelOk (label : String) : Bool :=
  let lowerDigit := fun (c : Char) => ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9')
  match label.toList with
  | first :: rest => lowerDigit first && rest.length ≤ 62 && rest.all fun c => lowerDigit c || c == '-'
  | [] => false

/-- `resumeGatewayUrl`: one validated DNS label rebuilt onto `.discord.gg`. -/
def resumeGatewayUrl (value : String) : Option (Option String) :=
  match parseUrl value with
  | .unknown => none
  | .invalid => some none
  | .ok url =>
    if url.protocol != "wss:" || url.port != "" || url.pathname != "/" then some none
    else if !url.hostname.endsWith ".discord.gg" then some none
    else
      let label := String.ofList (url.hostname.toList.take (url.hostname.length - ".discord.gg".length))
      if gatewayLabelOk label then some (some s!"wss://{label}.discord.gg") else some none

private def trimTrailingSlashes (value : String) : String :=
  String.ofList (value.toList.reverse.dropWhile (· == '/')).reverse

/-- What `planeUrl` does: the trimmed URL, a thrown message, or `none` where the URL model stops. -/
def planeUrl (plane field' : String) (value : Json) : Option (Except String String) :=
  match value with
  | .str "" => some (.error s!"{planesEnv} plane {plane} is missing {field'}")
  | .str text =>
    let trimmed := trimTrailingSlashes text
    match parseUrl trimmed with
    | .unknown => none
    | .ok _ => some (.ok trimmed)
    | .invalid =>
      some (.error s!"{planesEnv} plane {plane} has an invalid {field'}: {(toJson text).compress}")
  | _ => some (.error s!"{planesEnv} plane {plane} is missing {field'}")

private def planeNameOk (name : String) : Bool :=
  !name.isEmpty && name.toList.all fun c =>
    ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z') || ('0' ≤ c && c ≤ '9') || c == '-'

private def nameFieldText : Option Json → String
  | none => "undefined"
  | some value => value.compress

private def parsePlane (entry : Json) : Option (Except String Json) :=
  match entry with
  | .obj _ | .arr _ =>
    let name := field? entry "name"
    match name with
    | some (.str text) =>
      if !planeNameOk text then
        some (.error s!"{planesEnv} plane names must match ^[a-z0-9-]+$, got {nameFieldText name}")
      else
        match planeUrl text "convexUrl" (field entry "convexUrl") with
        | none => none
        | some (.error message) => some (.error message)
        | some (.ok convexUrl) =>
          match planeUrl text "webhookBaseUrl" (field entry "webhookBaseUrl") with
          | none => none
          | some (.error message) => some (.error message)
          | some (.ok webhookBaseUrl) =>
            some (.ok (Json.mkObj
              [("convexUrl", toJson convexUrl), ("name", toJson text),
                ("webhookBaseUrl", toJson webhookBaseUrl)]))
    | _ => some (.error s!"{planesEnv} plane names must match ^[a-z0-9-]+$, got {nameFieldText name}")
  | _ => some (.error s!"{planesEnv} entries must be objects")

private def parsePlanes : List Json → List Json → Option (Except String (List Json))
  | [], acc => some (.ok acc.reverse)
  | entry :: rest, acc =>
    match parsePlane entry with
    | none => none
    | some (.error message) => some (.error message)
    | some (.ok plane) => parsePlanes rest (plane :: acc)

private def parseConfigPlanesTwin : Spec.Twin where
  source := "apps/discord-forwarder/src/config.ts#parseConfigPlanes"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str raw =>
      match Json.parse raw with
      | .error _ => Spec.Twin.threw s!"{planesEnv} is not valid JSON"
      | .ok (.arr items) =>
        if items.isEmpty then Spec.Twin.threw s!"{planesEnv} must be a non-empty JSON array"
        else
          match parsePlanes items.toList [] with
          | none => Spec.Twin.unsupported "a plane URL is outside the URL model"
          | some (.error message) => Spec.Twin.threw message
          | some (.ok planes) =>
            let names := planes.map fun plane => field plane "name"
            if (uniq names).length != planes.length then
              Spec.Twin.threw s!"{planesEnv} has duplicate plane names"
            else jarr planes
      | .ok _ => Spec.Twin.threw s!"{planesEnv} must be a non-empty JSON array"
    | _ => Spec.Twin.unsupported "raw is not a string"

private def planeUrlTwin : Spec.Twin where
  source := "apps/discord-forwarder/src/config.ts#planeUrl"
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
    | .str plane, .str name =>
      match planeUrl plane name (Spec.Twin.arg args 2) with
      | none => Spec.Twin.unsupported "the URL is outside the URL model"
      | some (.error message) => Spec.Twin.threw message
      | some (.ok url) => toJson url
    | _, _ => Spec.Twin.unsupported "plane or field is not a string"

private def heartbeatTwin : Spec.Twin where
  source := "apps/discord-forwarder/src/discord.ts#heartbeatIntervalMs"
  run := fun args => heartbeatIntervalMs (Spec.Twin.arg args 0)

private def resumeTwin : Spec.Twin where
  source := "apps/discord-forwarder/src/discord.ts#resumeGatewayUrl"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str value =>
      match resumeGatewayUrl value with
      | none => Spec.Twin.unsupported "the URL is outside the URL model"
      | some (some url) => toJson url
      | some none => .null
    | _ => Spec.Twin.unsupported "value is not a string"

private def sortStrings (items : List String) : List String :=
  (items.toArray.qsort (· < ·)).toList

private def webhookUrlsTwin : Spec.Twin where
  source := "apps/discord-forwarder/src/supervisor.ts#webhookUrls"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .arr targets =>
      let urls := targets.toList.filterMap fun target => str? (field target "webhookUrl")
      if urls.length != targets.size then Spec.Twin.unsupported "a target has no webhook URL"
      else jstrs (sortStrings (uniq urls))
    | _ => Spec.Twin.unsupported "targets is not an array"

/-- The twins in this file. -/
def forwarderTwins : List Spec.Twin :=
  [parseConfigPlanesTwin, planeUrlTwin, heartbeatTwin, resumeTwin, webhookUrlsTwin]

end Spec.Channels
