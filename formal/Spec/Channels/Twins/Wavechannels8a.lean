import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign8/channels8a.tsv`.
-/

namespace Spec.Channels.Wavechannels8a

open Lean Spec

def comparable : Nat → Json → Json
  | 0, value => value
  | fuel + 1, .arr values => .arr (values.map (comparable fuel))
  | fuel + 1, .obj fields => Json.mkObj (fields.toList.filterMap fun (key, value) =>
      if ["$fields", "$keys", "$class"].contains key then none
      else some (key, comparable fuel value))
  | _, value => value

def stateChange (path : String) (before after : Json) : Prog Unit :=
  if comparable 64 before == comparable 64 after then pure () else Prog.setState path after

def socketTimer : Json :=
  Json.mkObj [("$opaque", .str "Timeout")]

def socketFields (self : Json) (changes : List (String × Json)) : Prog Unit := do
  for (name, value) in changes do
    stateChange ("self." ++ name) (Twin.field self name) value

def mapEntries (value : Json) : List Json :=
  ((value.getObjVal? "$map").toOption.getD .null).getArr?.toOption.getD #[] |>.toList

def mapValue (entries : List Json) : Json :=
  Json.mkObj [("$map", .arr entries.toArray)]

def mapSet (value key item : Json) : Json :=
  let entries := mapEntries value
  let pair := Json.arr #[key, item]
  mapValue (if entries.any (fun entry => Twin.arg entry 0 == key) then
    entries.map (fun entry => if Twin.arg entry 0 == key then pair else entry)
  else entries ++ [pair])

/-- What the recorder keeps of a target list stored two maps deep: one marker per target. -/
def recordedTargets (targets : Json) : Json :=
  .arr ((targets.getArr?.toOption.getD #[]).map fun _ =>
    Json.mkObj [("$opaque", .str "too-deep")])

/-- `MAX_CACHED_CHANNELS` in `threads.ts`. -/
def maxCachedChannels : Nat := 10000

/-- `ThreadDirectory.lookup` storing an answer: the oldest entry goes first when the cache is full. -/
def threadCacheSet (cache key item : Json) : Json :=
  let entries := mapEntries cache
  mapSet (mapValue (if entries.length ≥ maxCachedChannels then entries.drop 1 else entries))
    key item

/-- `resolve` registers the promise as soon as `lookup` has started, so `lookup` and the first
`fetchChannel` end with it in place. A retry finds it already there. -/
def threadInFlightStarted (self channelId : Json) : Prog Unit :=
  let before := Twin.field self "inFlight"
  stateChange "self.inFlight" before
    (mapSet before channelId (Json.mkObj [("$opaque", .str "Promise")]))

private def undefinedOr (value fallback : Json) : Json :=
  if value == Twin.undefinedJson || value == .null then fallback else value

private def textOf (value : Json) : String :=
  match value with
  | .str body => body
  | other => other.compress

private def responseStatus (response : Json) : Nat :=
  (((response.getObjVal? "$response").toOption.getD .null).getObjValAs? Nat "status").toOption.getD 0

private def responseOk (response : Json) : Bool :=
  let status := responseStatus response
  200 ≤ status && status < 300

private def member (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

/-- The value `Outcome` carries, or a rethrow of what it threw. -/
private def settled : Outcome → Prog Json
  | .ok value => pure value
  | .threw error _ => .fail error
  | .pending => .fail (Json.mkObj [("pending", true)])

private def telegramResponse (method : String) (response : Json) (timer : Json) : Prog Json := do
  let status := responseStatus response
  if 300 ≤ status && status < 400 then
    let _ ← Prog.effect "clearTimeout" [timer]
    Prog.throwError "Error" s!"Telegram {method} answered a redirect ({status}); refusing to follow it with the bot token"
  let parsed ← Prog.attempt "response.json"
  let _ ← Prog.effect "clearTimeout" [timer]
  let result ← settled parsed
  if !responseOk response || member result "ok" != .bool true then
    let description := textOf (undefinedOr (member result "description") (.str "unknown error"))
    Prog.throwError "Error" s!"Telegram {method} failed ({status}): {description}"
  pure Twin.undefinedJson

/-- `callTelegramBotApi`. The timer is cleared on every path after it starts. -/
private def callTelegramBotApi (call : Json) : Prog Json := do
  let apiUrl := Twin.callArg call 0
  let method := Twin.callArg call 2
  let url ← Prog.effect "telegramBotApiUrl" [apiUrl, Twin.callArg call 1, method]
  let timer ← Prog.effect "setTimeout" [Json.mkObj [("$fn", .str "")], toJson (10000 : Nat)]
  let fetcher ← Prog.attempt "channelApiFetch" [apiUrl]
  match fetcher with
  | .ok _ =>
    let answer ← Prog.attempt "channelApiFetch(apiUrl)" [url, Json.mkObj
      [("method", .str "POST"),
       ("headers", Json.mkObj [("content-type", .str "application/json")]),
       ("body", .str (Twin.jsonStringify 64 (Twin.callArg call 3))),
       ("redirect", .str "manual"),
       ("signal", Json.mkObj [("$signal", .bool false)])]]
    match answer with
    | .ok response => telegramResponse (textOf method) response timer
    | failed =>
      let _ ← Prog.effect "clearTimeout" [timer]
      settled failed
  | failed =>
    let _ ← Prog.effect "clearTimeout" [timer]
    settled failed

private def trimTrailingSlashes (url : String) : String :=
  String.ofList ((url.toList.reverse.dropWhile (· == '/')).reverse)

/-- `callDiscordApi`. -/
private def callDiscordApi (call : Json) : Prog Json := do
  let apiUrl := Twin.callArg call 0
  let path := textOf (Twin.callArg call 2)
  let base := trimTrailingSlashes (textOf (if apiUrl == Twin.undefinedJson || apiUrl == .null
    then .str "https://discord.com/api/v10" else apiUrl))
  let _ ← Prog.effect "channelApiFetch" [apiUrl]
  let signal ← Prog.effect "AbortSignal.timeout" [toJson (30000 : Nat)]
  let response ← Prog.effect "channelApiFetch(apiUrl)" [.str s!"{base}/{path}", Json.mkObj
    [("method", .str "POST"),
     ("headers", Json.mkObj
       [("authorization", .str s!"Bot {textOf (Twin.callArg call 1)}"),
        ("content-type", .str "application/json")]),
     ("body", .str (Twin.jsonStringify 64 (Twin.callArg call 3))),
     ("signal", signal)]]
  if responseOk response then
    return Twin.undefinedJson
  let body ← Prog.effect "response.text"
  Prog.throwError "Error" s!"Discord {path} failed ({responseStatus response}): {textOf body}"

/-- `routeIncomingEvent`: builds the router from the options and hands it the request. -/
private def routeIncomingEvent (call : Json) : Prog Json := do
  let _ ← Prog.effect "createIncomingEventRouter" [Twin.param call 2]
  Prog.effect "createIncomingEventRouter(options)" [Twin.callArg call 0, Twin.callArg call 1]

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/shared/telegram-channel.ts#callTelegramBotApi" callTelegramBotApi,
   Twin.traced "apps/core/src/shared/discord-channel.ts#callDiscordApi" callDiscordApi,
   Twin.traced "apps/core/src/harness/integrations.ts#routeIncomingEvent" routeIncomingEvent]

end Spec.Channels.Wavechannels8a
