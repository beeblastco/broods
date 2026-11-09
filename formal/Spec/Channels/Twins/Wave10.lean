import Spec.Twin
import Spec.Channels.Twins.Wavechannels8a

/-!
Wave 10 twins of the channels subsystem. See `AUTHORING.md`.
-/

namespace Spec.Channels.Wave10

open Lean Spec Spec.Channels.Wavechannels8a

/-- The factories `createChannelRegistry` asks, in its order. -/
private def registryFactories : List String :=
  ["createTelegramChannelFromConfig", "createGoogleChatChannelFromConfig",
   "createGitHubChannelFromConfig", "createLinearChannelFromConfig",
   "createSlackChannelFromConfig", "createDiscordChannelFromConfig",
   "createPancakeChannelFromConfig", "createTeamsChannelFromConfig",
   "createTwilioChannelFromConfig", "createZaloChannelFromConfig",
   "createInstagramChannelFromConfig", "createMessengerChannelFromConfig",
   "createWhatsAppChannelFromConfig"]

/-- `createChannelRegistry`: every factory sees the config, and the adapters that exist are kept. -/
private def createChannelRegistry (call : Json) : Prog Json := do
  let mut adapters : Array Json := #[]
  for factory in registryFactories do
    let adapter ← Prog.effect factory [Twin.callArg call 0]
    if adapter != Json.null then adapters := adapters.push adapter
  return Json.mkObj [("webhookChannels", .arr adapters)]

/-- `TELEGRAM_API_URL` in `telegram-channel.ts`. -/
private def telegramApiUrl : String := "https://api.telegram.org"

def jsonText (value : Json) : String :=
  match value with
  | .str body => body
  | other => other.compress

private def isMissing (value : Json) : Bool :=
  value == Twin.undefinedJson || value == .null

private def member (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def responseStatus (response : Json) : Nat :=
  (((response.getObjVal? "$response").toOption.getD .null).getObjValAs? Nat "status").toOption.getD 0

/-- `BroodsTelegramAdapter.telegramFetch`. The stock Telegram host goes to the SDK, and an error
answer is raised by the SDK, so neither is modelled. -/
private def telegramFetch (call : Json) : Prog Json := do
  let self := Twin.self call
  let apiBase := Twin.field self "apiBaseUrl"
  if jsonText apiBase == telegramApiUrl then
    Prog.unsupported "the SDK's own request is not recorded"
  let stored := Twin.field self "staticBotToken"
  let botToken ← if isMissing stored then Prog.effect "this.resolveBotToken" else pure stored
  let payload := Twin.callArg call 1
  let isForm := member payload "$opaque" == .str "FormData"
  let body : List (String × Json) :=
    if isForm then [("body", payload)]
    else
      [("body", .str (if payload == Twin.undefinedJson then "{}" else Twin.jsonStringify 64 payload)),
       ("headers", Json.mkObj [("Content-Type", .str "application/json")])]
  let signal := member (Twin.callArg call 2) "signal"
  let init := Json.mkObj
    ([("method", .str "POST")] ++ body ++ (if isMissing signal then [] else [("signal", signal)]))
  let response ← Prog.effect "publicHostFetch"
    [.str s!"{jsonText apiBase}/bot{jsonText botToken}/{jsonText (Twin.callArg call 0)}", init]
  let parsed ← Prog.attempt "response .json"
  let data : Json := match parsed with
    | .ok value => value
    | _ => Json.mkObj [("ok", .bool false)]
  let status := responseStatus response
  if !(200 ≤ status && status < 300) || member data "ok" != .bool true ||
      member data "result" == Twin.undefinedJson then
    Prog.unsupported "the SDK raises the Telegram API error"
  pure (member data "result")

/-- `new URL(url).host` for an absolute URL: lowercase, userinfo and path dropped. -/
def urlHost (url : String) : String :=
  let rest := (url.splitOn "://").getD 1 ""
  let authority := (rest.takeWhile fun c => c != '/' && c != '?' && c != '#').toString
  let host := (authority.splitOn "@").getLast?.getD authority
  host.toLower

/-- `BroodsWhatsAppAdapter.graphApiRequest`. The stock Graph host goes to the SDK, which is not
recorded. -/
private def graphApiRequest (call : Json) : Prog Json := do
  let graphUrl := Twin.field (Twin.self call) "graphApiUrl"
  if urlHost (jsonText graphUrl) == "graph.facebook.com" then
    Prog.unsupported "the SDK's own request is not recorded"
  Prog.effect "this.tenantGraphApi"
    [Twin.callArg call 0,
     Json.mkObj [("body", .str (Twin.jsonStringify 64 (Twin.callArg call 1))),
       ("headers", Json.mkObj [("Content-Type", .str "application/json")])]]

/-- `MEDIA_CACHE_MAX_BYTES` in `channel-media.ts`. -/
private def mediaCacheMaxBytes : Nat := 32 * 1024 * 1024

/-- The byte length of a recorded `Buffer`, or `none` when the recorder could not keep it. -/
private def byteLength? (value : Json) : Option Nat :=
  match value.getObjVal? "$bytes" with
  | .ok (.str encoded) =>
    let digits := (encoded.toList.filter (· != '=')).length
    some (digits * 3 / 4)
  | _ => none

/-- Drops entries from the front while the cache holds more than its limit. -/
private def evictOldest : Nat → Nat → List Json → Prog (Nat × List Json)
  | 0, total, entries => pure (total, entries)
  | fuel + 1, total, entries =>
    match entries with
    | [] => pure (total, [])
    | entry :: rest =>
      if total ≤ mediaCacheMaxBytes then pure (total, entries)
      else
        match byteLength? (Twin.arg entry 1) with
        | some size => evictOldest fuel (total - size) rest
        | none => Prog.unsupported "an evicted entry was too big to record"

/-- `cacheMedia`: replaces any entry for the reference, then evicts the oldest past the limit. -/
private def cacheMedia (call : Json) : Prog Json := do
  let reference := Twin.callArg call 0
  let bytes := Twin.callArg call 1
  let size ← match byteLength? bytes with
    | some size => pure size
    | none => Prog.unsupported "the bytes were too big to record"
  if size > mediaCacheMaxBytes then return Twin.undefinedJson
  let cache := Twin.moduleValue call "mediaCache"
  let held := (Twin.moduleValue call "mediaCacheBytes").getNat?.toOption.getD 0
  let previous := mapEntries cache
  let replaced := previous.find? fun entry => Twin.arg entry 0 == reference
  let afterRemoval ← match replaced with
    | some entry =>
      match byteLength? (Twin.arg entry 1) with
      | some old => pure (held - old)
      | none => Prog.unsupported "a replaced entry was too big to record"
    | none => pure held
  let kept := previous.filter fun entry => Twin.arg entry 0 != reference
  let entries := kept ++ [Json.arr #[reference, bytes]]
  let (total, left) ← evictOldest (entries.length + 1) (afterRemoval + size) entries
  stateChange "module.mediaCache" cache (mapValue left)
  stateChange "module.mediaCacheBytes" (toJson held) (toJson total)
  return Twin.undefinedJson

/-- `Forwarder.reconcile`. A token already managed compares `JSON.stringify` of its stored targets,
which the recording keeps only as markers, so that case is not modelled. -/
private def reconcile (call : Json) : Prog Json := do
  let self := Twin.self call
  let desired := mapEntries (← Prog.effect "groupConnectionsByToken" [Twin.callArg call 0])
  let managed := mapEntries (Twin.field self "managed")
  let wanted := fun (token : Json) => desired.any fun entry => Twin.arg entry 0 == token
  for entry in managed do
    let token := Twin.arg entry 0
    if !wanted token then
      let _ ← Prog.effect "entry.socket.stop"
      let _ ← Prog.effect "tokenHint" [token]
  for entry in desired do
    let token := Twin.arg entry 0
    let targets := Twin.arg entry 1
    let urls ← Prog.effect "webhookUrls" [targets]
    if managed.any fun held => Twin.arg held 0 == token then
      Prog.unsupported "stored targets are too deep to record"
    let _ ← Prog.effect "warnOnSharedToken" [token, urls]
    let _ ← Prog.effect "this.open" [token, targets]
  -- With nothing desired every entry went, and `open` writes the map itself otherwise.
  if desired.isEmpty && !managed.isEmpty then
    Prog.setState "self.managed" (mapValue [])
  return Twin.undefinedJson

/-- `BroodsDiscordAdapter.discordFetch`. The stock Discord host goes to the SDK, which is not
recorded. -/
private def discordFetch (call : Json) : Prog Json := do
  let apiBase := jsonText (Twin.field (Twin.self call) "apiBaseUrl")
  if urlHost apiBase == "discord.com" then
    Prog.unsupported "the SDK's own request is not recorded"
  let token ← Prog.effect "this.resolveBotToken"
  let signal ← Prog.effect "AbortSignal.timeout" [toJson (30000 : Nat)]
  let payload := Twin.callArg call 2
  let hasBody := !isMissing payload && payload != .bool false
  let headers := Json.mkObj
    ([("Authorization", .str s!"Bot {jsonText token}")] ++
      (if hasBody then [("Content-Type", .str "application/json")] else []))
  let init := Json.mkObj
    ([("method", Twin.callArg call 1), ("headers", headers)] ++
      (if hasBody then [("body", .str (Twin.jsonStringify 64 payload))] else []) ++
      [("signal", signal)])
  let response ← Prog.effect "publicHostFetch"
    [.str s!"{apiBase}{jsonText (Twin.callArg call 0)}", init]
  let status := responseStatus response
  if 200 ≤ status && status < 300 then
    return response
  let body ← Prog.effect "response.text"
  Prog.throwError "Error" s!"Discord API error: {status} {jsonText body}"

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/integrations.ts#createChannelRegistry" createChannelRegistry,
   Twin.traced "apps/core/src/shared/telegram-channel.ts#BroodsTelegramAdapter.telegramFetch"
     telegramFetch,
   Twin.traced "apps/core/src/shared/whatsapp-channel.ts#BroodsWhatsAppAdapter.graphApiRequest"
     graphApiRequest,
   Twin.traced "apps/core/src/harness/channel-media.ts#cacheMedia" cacheMedia,
   Twin.traced "apps/discord-forwarder/src/supervisor.ts#Forwarder.reconcile" reconcile,
   Twin.traced "apps/core/src/shared/discord-channel.ts#BroodsDiscordAdapter.discordFetch" discordFetch]

end Spec.Channels.Wave10
