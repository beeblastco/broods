import Spec.Channels.Twins.Wavechannels1.Base

namespace Spec.Channels.Wavechannels1.Providers

open Lean Spec Spec.Channels.Wavechannels1.Base

private def core (file name : String) : String :=
  "apps/core/src/shared/" ++ file ++ "-channel.ts#" ++ name

private def adapterKeys (name : String) (keys : List String) : List (String × Json) :=
  [("name", .str name)] ++ keys.map fun key => (key, fnJson key)

private def channelObject (name : String) (keys : List String) : Json :=
  Json.mkObj (adapterKeys name keys)

private def picked (options : Json) (keys : List String) : List (String × Json) :=
  keys.filterMap fun key =>
    let value := get options key
    if missing value then none else some (key, value)

/-- The two effects every chat-sdk adapter runs to build its child logger. -/
private def childLogger (name : String) : Prog Json := do
  let _ ← Prog.effect "new ConsoleLogger" [.str "error"]
  Prog.effect "new ConsoleLogger(\"error\").child" [.str name]

private def jsonField (key : String) (value : Json) : String :=
  (toJson key).compress ++ ":" ++ value.compress

/-- `JSON.stringify` of a Zalo request, in the order its object literals are written. -/
private def zaloBody (body : Json) : String :=
  let keys := ["chat_id", "text", "photo", "caption", "sticker", "action"]
  "{" ++ ",".intercalate ((picked body keys).map fun (key, value) => jsonField key value) ++ "}"

private def zaloStatus (response : Json) : Int :=
  (asNum (get (get response "$response") "status")).mantissa

private def callZaloApi (call : Json) : Prog Json := do
  let method := text (Twin.callArg call 1)
  let timeout ← Prog.effect "setTimeout" [fnJson, num 10000]
  let clear : Prog Unit := do let _ ← Prog.effect "clearTimeout" [timeout]
  let body : Prog Json := do
    let response ← Prog.effect "fetch"
      [.str s!"https://bot-api.zaloplatforms.com/bot{text (Twin.callArg call 0)}/{method}",
       Json.mkObj [("method", .str "POST"),
         ("headers", Json.mkObj [("Content-Type", .str "application/json")]),
         ("body", .str (zaloBody (Twin.callArg call 2))),
         ("signal", Json.mkObj [("$signal", .bool false)])]]
    let bodyText ← Prog.effect "response.text"
    let parsed ← Prog.effect "parseJsonBody" [bodyText]
    let status := zaloStatus response
    if status < 200 || status > 299 || get parsed "ok" == .bool false then
      let detail ← Prog.effect "formatZaloError" [parsed, bodyText]
      return ← Prog.throwError "Error" s!"Zalo {method} failed ({status}): {text detail}"
    return if nullish parsed then Json.mkObj [("ok", .bool true)] else parsed
  let result ← Prog.catchFail body fun error => do
    clear
    Prog.fail error
  clear
  return result

private def createTwilioChannel (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let fetchFn ← Prog.effect "twilioFetch" [get options "transport"]
  let logger ← childLogger "twilio"
  let userName := get options "userName"
  let _ ← Prog.effect "new TwilioAdapter" [Json.mkObj (
    picked options ["accountSid", "apiUrl", "authToken", "messagingServiceSid", "phoneNumber",
      "statusCallbackUrl"] ++
    [("fetch", fetchFn), ("logger", logger),
     ("userName", if nullish userName then .str "twilio-bot" else userName)])]
  return channelObject "twilio"
    ["rehydrateAttachment", "canHandle", "authenticate", "parse", "actions"]

private def createTeamsChannel (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let logger ← childLogger "teams"
  let tenant := if get options "appType" == .str "MultiTenant" then undef
    else get options "appTenantId"
  let _ ← Prog.effect "new TeamsAdapter" [Json.mkObj (
    picked options ["apiUrl", "appId", "appPassword", "appType", "userName"] ++
    [("logger", logger)] ++ (if missing tenant then [] else [("appTenantId", tenant)]))]
  return channelObject "teams"
    ["rehydrateAttachment", "canHandle", "authenticate", "parse", "actions"]

private def createLinearChannel (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let _ ← Prog.effect "new LinearWebhookClient" [get options "webhookSecret"]
  let logger ← childLogger "linear"
  let _ ← Prog.effect "new BroodsLinearAdapter" [Json.mkObj (
    picked options ["apiKey", "apiUrl", "userName", "webhookSecret"] ++ [("logger", logger)])]
  return channelObject "linear" ["canHandle", "authenticate", "parse", "actions"]

private def createMessengerChannel (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let logger ← childLogger "messenger"
  let transport ← Prog.effect "new BroodsMessengerAdapter" [Json.mkObj (
    picked options ["apiVersion", "appSecret", "pageAccessToken", "userName", "verifyToken"] ++
    [("logger", logger)])]
  Prog.effect "createMetaChannel" [Json.mkObj (
    picked options ["allowedChannelIds", "allowedUserIds", "appSecret", "verifyToken"] ++
    [("name", .str "messenger"), ("object", .str "page"), ("ownerId", fnJson "ownerId"),
     ("postsAttachments", .bool false), ("prefix", .str "messenger:"),
     ("textLimit", Json.mkObj [("max", num 1900), ("unit", .str "chars")]),
     ("transport", transport)])]

private def zaloActions : Json :=
  Json.mkObj (["sendText", "sendImages", "sendSticker", "sendTyping", "reactToMessage"].map
    fun key => (key, fnJson key))

private def metaChannel (call : Json) : Json :=
  Json.mkObj (adapterKeys (text (get (Twin.callArg call 0) "name"))
    ["canHandle", "authenticate", "parse", "actions"] ++ [("routesEachEntry", .bool true)])

/-- This file's twins. -/
def twins : List Twin :=
  [Twin.traced (core "zalo" "callZaloApi") callZaloApi,
   Twin.traced (core "zalo" "createZaloActions") (fun _ => pure zaloActions),
   Twin.traced (core "zalo" "createZaloChannel") (fun _ =>
     pure (channelObject "zalo" ["canHandle", "authenticate", "parse", "actions"])),
   Twin.traced (core "meta" "createMetaChannel") (fun call => pure (metaChannel call)),
   Twin.traced (core "twilio" "twilioFetch") (fun _ => pure (fnJson "request")),
   Twin.traced (core "twilio" "createTwilioChannel") createTwilioChannel,
   Twin.traced (core "teams" "createTeamsChannel") createTeamsChannel,
   Twin.traced (core "linear" "createLinearChannel") createLinearChannel,
   Twin.traced (core "messenger" "createMessengerChannel") createMessengerChannel]

end Spec.Channels.Wavechannels1.Providers
