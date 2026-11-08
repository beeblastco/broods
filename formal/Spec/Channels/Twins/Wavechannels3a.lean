import Spec.Channels.Twins.Wavechannels8a
import Spec.Channels.Twins.Support
import Spec.Sandbox.Twins.Tools.Js

/-!
Twins for the functions listed in `.lake/worklist/assign3/channels3a.tsv`.
-/

namespace Spec.Channels.Wavechannels3a

open Lean Spec Spec.Channels Spec.Sandbox.Tools.Re
open Spec.Sandbox.Tools (Re)

private def get (v : Json) (k : String) : Json := (v.getObjVal? k).toOption.getD Twin.undefinedJson
private def text (v : Json) : String := v.getStr?.toOption.getD ""
private def items (v : Json) : List Json := v.getArr?.toOption.getD #[] |>.toList
private def undef : Json := Twin.undefinedJson
private def isUndef (v : Json) : Bool := v == Twin.undefinedJson
private def live (v : Json) : Bool := !isUndef v && v != .null && truthy v
private def a (c : Json) (n : Nat) : Json := Twin.callArg c n
private def obj (pairs : List (String × Json)) : Json := Json.mkObj pairs
private def fnValue (name : String) : Json := obj [("$fn", .str name)]
private def int (v : Json) : Int := v.getInt?.toOption.getD 0
private def selfField (c : Json) (k : String) : Json := Twin.field (Twin.self c) k

/-- The entries of a recorded `Map`. -/
private def mapEntries (m : Json) : List (Json × Json) :=
  (items (get m "$map")).filterMap fun pair =>
    match items pair with
    | [k, v] => some (k, v)
    | _ => none

private def mapGet? (m : Json) (key : String) : Option Json :=
  (mapEntries m).find? (fun entry => entry.1 == .str key) |>.map (·.2)

private def core (file name : String) : String := s!"apps/core/src/shared/{file}.ts#{name}"
private def media (name : String) : String := s!"apps/core/src/harness/channel-media.ts#{name}"
private def integrations (name : String) : String := s!"apps/core/src/harness/integrations.ts#{name}"
private def cron (name : String) : String := s!"packages/convex/model/cronRules.ts#{name}"
private def forwarder (file name : String) : String := s!"apps/discord-forwarder/src/{file}.ts#{name}"

/-! ## discord-forwarder -/

/-- `IdentifyBudget.live`: stamps still inside the window. -/
private def budgetLive (c : Json) : Prog Json :=
  let cutoff := int (a c 1) - int (selfField c "windowMs")
  let stamps := (mapGet? (selfField c "stamps") (text (a c 0))).getD (.arr #[])
  pure (.arr ((items stamps).filter (fun stamp => int stamp > cutoff)).toArray)

/-- `GATEWAY_INTENTS` in `config.ts`, and the Identify and Resume opcodes. -/
private def gatewayIntents : Nat := 33281
private def opIdentify : Nat := 2
private def opResume : Nat := 6

private def identifyPayload (c : Json) : Prog Json :=
  let name := Json.str "broods-discord-forwarder"
  pure (obj [("op", toJson opIdentify), ("d", obj
    [("token", get (selfField c "options") "botToken"),
     ("intents", toJson gatewayIntents),
     ("properties", obj [("os", .str "linux"), ("browser", name), ("device", name)])])])

private def resumePayload (c : Json) : Prog Json :=
  pure (obj [("op", toJson opResume), ("d", obj
    [("token", get (selfField c "options") "botToken"),
     ("session_id", selfField c "sessionId"),
     ("seq", selfField c "sequence")])])

/-- `ThreadDirectory.resolve`. A shared in-flight promise's answer is not in the recording. -/
private def threadResolve (c : Json) : Prog Json := do
  let channelId := text (a c 0)
  match mapGet? (selfField c "cache") channelId with
  | some cached => pure cached
  | none =>
    if (mapGet? (selfField c "inFlight") channelId).isSome then
      Prog.unsupported "the answer of a lookup already in flight is not recorded"
    else do
      Prog.effect "this.lookup" [a c 0]

private def forwarderOpen (c : Json) : Prog Json := do
  let token := a c 0
  let _ ← Prog.effect "new ThreadDirectory" [token]
  let socket ← Prog.effect "this.createSocket" [obj
    [("botToken", token),
     ("budget", selfField c "budget"),
     ("config", selfField c "config"),
     ("onMessageCreate", fnValue "onMessageCreate")]]
  let _ ← Prog.effect "tokenHint" [token]
  let _ ← Prog.effect "socket.start"
  let before := selfField c "managed"
  let next := Spec.Channels.Wavechannels8a.mapSet before token
    (obj [("socket", socket),
      ("targets", Spec.Channels.Wavechannels8a.recordedTargets (a c 1))])
  Spec.Channels.Wavechannels8a.stateChange "self.managed" before next
  pure undef

private def forwarderStatus (c : Json) : Prog Json := do
  let mut sockets : Array Json := #[]
  let mut total : Nat := 0
  for (token, entry) in mapEntries (selfField c "managed") do
    let socket := get entry "socket"
    let targets := (items (get entry "targets")).length
    let hint ← Prog.effect "tokenHint" [token]
    total := total + targets
    sockets := sockets.push (obj
      [("botUserId", Twin.field socket "botIdentity"),
       ("state", Twin.field socket "state"),
       ("targets", toJson targets),
       ("tokenHint", hint)])
  pure (obj [("sockets", .arr sockets), ("targets", toJson total)])

private def forwarderStop (c : Json) : Prog Json := do
  for _ in mapEntries (selfField c "managed") do
    let _ ← Prog.effect "entry.socket.stop"
  Spec.Channels.Wavechannels8a.stateChange "self.managed" (selfField c "managed")
    (Spec.Channels.Wavechannels8a.mapValue [])
  pure undef

/-! ## telegram-channel.ts -/

private def telegramStickerMime : String := "image/webp"

private def telegramAttachments (c : Json) : Prog Json := do
  let sticker := a c 1
  let attachments := Twin.field (a c 2) "attachments"
  if !live sticker then
    return attachments
  let media := (items attachments).filter fun attachment =>
    get (get attachment "fetchMetadata") "fileId" != get sticker "file_id"
  if live (get sticker "is_animated") || live (get sticker "is_video") then
    return .arr media.toArray
  let emoji := get sticker "emoji"
  let name := if live emoji then s!"sticker-{text emoji}.webp" else "sticker.webp"
  let size := get sticker "file_size"
  let rebuilt ← Prog.effect "transport.rehydrateAttachment" [obj
    ([("type", .str "image"), ("name", .str name), ("mimeType", .str telegramStickerMime)] ++
      (if isUndef size then [] else [("size", size)]) ++
      [("fetchMetadata", obj [("fileId", get sticker "file_id")])])]
  pure (.arr (media ++ [rebuilt]).toArray)

/-! ## harness -/

/-- `CHANNEL_AGENT_LIST_RELOAD_AFTER_MS`. -/
private def agentListReloadAfterMs : Int := 1000

private def dropAgedChannelAgentList (c : Json) : Prog Json := do
  match mapGet? (Twin.moduleValue c "channelAgentLists") (text (a c 0)) with
  | none => pure (.bool false)
  | some cached =>
    let now ← Prog.effect "Date.now"
    let aged := int now - int (get cached "loadedAt") >= agentListReloadAfterMs
    if aged then
      let before := Twin.moduleValue c "channelAgentLists"
      let after := Spec.Channels.Wavechannels8a.mapValue
        ((Spec.Channels.Wavechannels8a.mapEntries before).filter
          (fun entry => Twin.arg entry 0 != a c 0))
      Spec.Channels.Wavechannels8a.stateChange "module.channelAgentLists" before after
    pure (.bool aged)

/-- `cachedMedia`. Moving a hit to the back of the cache is a module write, not compared. -/
private def cachedMedia (c : Json) : Prog Json :=
  pure ((mapGet? (Twin.moduleValue c "mediaCache") (text (a c 0))).getD undef)

/-! ## cronRules.ts -/

/-- The `z.looseObject` schema as a recording shows it once its fields are erased. -/
private def zodObject : Json := obj [("$opaque", .str "ZodMiniObject"), ("$fields", obj [])]

private def clientError (message : String) : Prog Json := do
  let error ← Prog.effect "new ClientError" [.str message]
  Prog.fail error

private def isDigits (value : String) : Bool := !value.isEmpty && value.all Char.isDigit

/-- `Number(token)` for a decimal or for text with no digits. Other numeric forms are not modelled. -/
private def numberOf? (token : String) : Option (Option Nat) :=
  let trimmed := jsTrim token
  if trimmed.isEmpty then some (some 0)
  else if isDigits trimmed then some trimmed.toNat?
  else if trimmed.any Char.isDigit then none
  else some none

private def requireDayOfWeekNumber (c : Json) : Prog Json := do
  let token := text (a c 0)
  match numberOf? token with
  | none => Prog.unsupported "a numeric form other than plain decimal"
  | some (some value) =>
    if 1 ≤ value ∧ value ≤ 7 then return toJson value
    clientError s!"cron(...) day-of-week must be 1-7 (1 = Sunday) or SUN-SAT, got '{token}'"
  | some none =>
    clientError s!"cron(...) day-of-week must be 1-7 (1 = Sunday) or SUN-SAT, got '{token}'"

private def dayNames : List String := ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

private def convertToken (token : String) : Prog String := do
  let pieces := token.splitOn "/"
  let base := pieces.headD ""
  let converted ←
    if dayNames.contains base.toUpper then pure base
    else do
      let value ← Prog.effect "requireDayOfWeekNumber" [.str base]
      pure (toString (int value - 1))
  match pieces[1]? with
  | some step => pure s!"{converted}/{step}"
  | none => pure converted

private def convertDayOfWeekText (field : String) : Prog String := do
  if field == "?" || field == "*" then return "*"
  let items ← (field.splitOn ",").mapM fun item => do
    let tokens ← (item.splitOn "-").mapM convertToken
    pure ("-".intercalate tokens)
  pure (",".intercalate items)

private def convertDayOfWeek (c : Json) : Prog Json := do
  pure (.str (← convertDayOfWeekText (text (a c 0))))

/-- `value.split(/\s+/)`. Whitespace at either end leaves an empty first or last piece. -/
private def splitWhitespace (value : String) : List String :=
  let step (acc : List String × String × Bool) (ch : Char) :=
    let (done, current, inSpace) := acc
    if Spec.Sandbox.jsWhitespace ch then
      if inSpace then (done, current, true) else (current :: done, "", true)
    else (done, current.push ch, false)
  let (done, current, _) := value.toList.foldl step ([], "", false)
  (current :: done).reverse

private def cronExpressionToCronspec (c : Json) : Prog Json := do
  match splitWhitespace (text (a c 0)) with
  | [minute, hour, dayOfMonth, month, dayOfWeek, year] =>
    if year != "*" then
      return ← clientError "cron(...) year field must be *. Years cannot be pinned"
    for field in [minute, hour, dayOfMonth, month, dayOfWeek] do
      if field.any (fun ch => "LlWw#".toList.contains ch) then
        return ← clientError s!"cron(...) does not support L, W, or # in '{field}'"
    let day ← Prog.effect "convertDayOfWeek" [.str dayOfWeek]
    pure (.str (" ".intercalate
      [minute, hour, if dayOfMonth == "?" then "*" else dayOfMonth, month, text day]))
  | _ =>
    clientError "cron(...) must have six fields: minute hour day-of-month month day-of-week year"

private def rateRe : Re :=
  let lower : Re := .chr fun ch => 'a' ≤ ch ∧ ch ≤ 'z'
  seqs [.bol, lit "rate(", .group 1 (plus digit), plus space, .group 2 (plus lower), lit ")", .eol]

private def cronRe : Re :=
  seqs [.bol, lit "cron(", .group 1 (plus (noneOf "\n\r  ")), lit ")", .eol]

private def rateUnitMs (unit : String) : Option Nat :=
  match unit with
  | "minute" | "minutes" => some 60000
  | "hour" | "hours" => some 3600000
  | "day" | "days" => some 86400000
  | _ => none

private def translateScheduleExpression (c : Json) : Prog Json := do
  let expression := text (a c 0)
  let chars := expression.toList.toArray
  if let some found := execFrom rateRe chars 0 then
    let unit := (groupText chars found 2).getD ""
    if unit == "constructor" then
      return ← Prog.unsupported "Object.prototype.constructor is taken for a rate unit"
    let count := ((groupText chars found 1).getD "0").toNat!
    return ← match rateUnitMs unit with
      | some unitMs =>
        if count < 1 then
          clientError "rate(...) must use a positive count of minutes, hours, or days"
        else pure (obj [("kind", .str "interval"), ("ms", toJson (count * unitMs))])
      | none => clientError "rate(...) must use a positive count of minutes, hours, or days"
  let oneTime ← Prog.effect "isOneTimeSchedule" [a c 0]
  if oneTime == .bool true then
    let timestamp ← Prog.effect "atExpressionToTimestamp" [a c 0, a c 1]
    return obj [("kind", .str "at"), ("timestamp", timestamp)]
  match firstGroup cronRe expression with
  | none => clientError "scheduleExpression must use cron(...), rate(...), or at(...)"
  | some inner =>
    let spec ← Prog.effect "cronExpressionToCronspec" [.str (jsTrim inner)]
    pure (obj ([("kind", .str "cron"), ("cronspec", spec)] ++
      (if live (a c 1) then [("tz", a c 1)] else [])))

/-- Days from 1970-01-01 to a proleptic Gregorian date. The month is already in `0...11`. -/
private def daysFromEpoch (year : Int) (month : Nat) (day : Int) : Int :=
  let shifted := if month < 2 then year - 1 else year
  let era := shifted / 400
  let yearOfEra := shifted - era * 400
  let monthFromMarch : Int := if month < 2 then month + 10 else month - 2
  let dayOfYear := (153 * monthFromMarch + 2) / 5 + day - 1
  let dayOfEra := yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
  era * 146097 + dayOfEra - 719468

/-- `Date.UTC`. A year below 100 means 19xx, and an out-of-range field carries over. -/
private def dateUtc (year month day hour minute second : Nat) : Int :=
  let fullYear : Int := if year ≤ 99 then year + 1900 else year
  let days := daysFromEpoch (fullYear + (month / 12 : Nat)) (month % 12) (day : Int)
  days * 86400000 + (hour : Int) * 3600000 + (minute : Int) * 60000 + (second : Int) * 1000

/-- Calendar fields of an `at(...)`, or `none` when it does not have that form. -/
private def atFields (expression : String) : Option (List Nat) :=
  let chars := expression.toList
  let digits (start count : Nat) : Option Nat :=
    let part := String.ofList ((chars.drop start).take count)
    if isDigits part && part.length == count then part.toNat? else none
  let literalsMatch := expression.startsWith "at(" && chars.length == 23 &&
    chars[7]? == some '-' && chars[10]? == some '-' && chars[13]? == some 'T' &&
    chars[16]? == some ':' && chars[19]? == some ':' && chars[22]? == some ')'
  if !literalsMatch then none else
  [digits 3 4, digits 8 2, digits 11 2, digits 14 2, digits 17 2, digits 20 2].mapM id

private def atExpressionToTimestamp (c : Json) : Prog Json := do
  match atFields (text (a c 0)) with
  | some [year, month, day, hour, minute, second] =>
    let asUtc := if month == 0
      then dateUtc (year - 1) 11 day hour minute second
      else dateUtc year (month - 1) day hour minute second
    let zone := a c 1
    if !live zone then return toJson asUtc
    let first ← Prog.effect "timezoneOffsetMs" [toJson asUtc, zone]
    let adjusted := asUtc - int first
    let second' ← Prog.effect "timezoneOffsetMs" [toJson adjusted, zone]
    pure (toJson (asUtc - int second'))
  | _ => clientError "at(...) must use the at(yyyy-mm-ddThh:mm:ss) form"

private def timezoneOffsetMs (c : Json) : Prog Json := do
  let timestamp := a c 0
  let _ ← Prog.effect "timezoneFormatter" [a c 1]
  let parts ← Prog.effect "formatter.formatToParts" [obj [("$date", timestamp)]]
  let part (name : String) : Option String :=
    ((items parts).find? (fun entry => text (get entry "type") == name)).map
      (fun entry => text (get entry "value"))
  let number (name : String) : Nat := ((part name).bind String.toNat?).getD 0
  let hour := if part "hour" == some "24" then 0 else number "hour"
  let monthIndex := number "month"
  let asUtc := if monthIndex == 0
    then dateUtc (number "year" - 1) 11 (number "day") hour (number "minute") (number "second")
    else dateUtc (number "year") (monthIndex - 1) (number "day") hour (number "minute") (number "second")
  pure (toJson (asUtc - int timestamp))

/-- A trimmed optional field: absent stays absent. -/
private def trimmedField (cron : Json) (name : String) : List (String × Json) :=
  let value := get cron name
  if isUndef value then [] else [(name, .str (jsTrim (text value)))]

private def trimmedOf (cron : Json) (name : String) : Json := .str (jsTrim (text (get cron name)))

private def normalizeCreateCronInput (c : Json) : Prog Json := do
  let cron ← Prog.effect "parseInput" [zodObject, a c 0, .str ""]
  let events ← Prog.effect "runPayloadToEvents" [cron]
  let status := get cron "status"
  pure (obj ([("name", trimmedOf cron "name"), ("agentId", trimmedOf cron "agentId"),
      ("events", events), ("scheduleExpression", trimmedOf cron "scheduleExpression")] ++
    trimmedField cron "description" ++ trimmedField cron "conversationKey" ++
    trimmedField cron "timezone" ++ (if isUndef status then [] else [("status", status)])))

/-- `null` clears. Text that trims to nothing keeps its key, valued `undefined`, so it still counts
as a field in the emptiness check but does not appear in what is returned. -/
private def clearableField (cron : Json) (name : String) : List (String × Json) :=
  let value := get cron name
  if isUndef value then []
  else if value == .null then [(name, .null)]
  else
    let trimmed := jsTrim (text value)
    [(name, if trimmed.isEmpty then undef else .str trimmed)]

private def normalizeUpdateCronInput (c : Json) : Prog Json := do
  let cron ← Prog.effect "parseInput" [zodObject, a c 0, .str ""]
  let eventFields ←
    if isUndef (get cron "input") && isUndef (get cron "events") then pure []
    else do
      let events ← Prog.effect "runPayloadToEvents" [cron]
      pure [("events", events)]
  let zone := get cron "timezone"
  let status := get cron "status"
  let normalized : List (String × Json) :=
    trimmedField cron "name" ++ clearableField cron "description" ++
    trimmedField cron "agentId" ++ eventFields ++ clearableField cron "conversationKey" ++
    trimmedField cron "scheduleExpression" ++
    (if isUndef zone then [] else [("timezone", if zone == .null then .null else trimmedOf cron "timezone")]) ++
    (if isUndef status then [] else [("status", status)])
  if normalized.isEmpty then
    return ← clientError "Request body must include at least one cron job field"
  pure (obj (normalized.filter (fun entry => !isUndef entry.2)))

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (forwarder "identify-budget" "IdentifyBudget.live") budgetLive,
   Twin.traced (forwarder "socket" "GatewaySocket.identifyPayload") identifyPayload,
   Twin.traced (forwarder "socket" "GatewaySocket.resumePayload") resumePayload,
   Twin.traced (forwarder "threads" "ThreadDirectory.resolve") threadResolve,
   Twin.traced (forwarder "supervisor" "Forwarder.open") forwarderOpen,
   Twin.traced (forwarder "supervisor" "Forwarder.status") forwarderStatus,
   Twin.traced (forwarder "supervisor" "Forwarder.stop") forwarderStop,
   Twin.traced (core "telegram-channel" "telegramAttachments") telegramAttachments,
   Twin.traced (integrations "dropAgedChannelAgentList") dropAgedChannelAgentList,
   Twin.traced (media "cachedMedia") cachedMedia,
   Twin.traced (cron "requireDayOfWeekNumber") requireDayOfWeekNumber,
   Twin.traced (cron "convertDayOfWeek") convertDayOfWeek,
   Twin.traced (cron "cronExpressionToCronspec") cronExpressionToCronspec,
   Twin.traced (cron "translateScheduleExpression") translateScheduleExpression,
   Twin.traced (cron "atExpressionToTimestamp") atExpressionToTimestamp,
   Twin.traced (cron "timezoneOffsetMs") timezoneOffsetMs,
   Twin.traced (cron "normalizeCreateCronInput") normalizeCreateCronInput,
   Twin.traced (cron "normalizeUpdateCronInput") normalizeUpdateCronInput]

end Spec.Channels.Wavechannels3a
