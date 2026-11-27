import Spec.Channels.Twins.Wavechannels8a
import Spec.Twin

/-!
Twins for the functions listed in `.lake/worklist/assign6/channels6a.tsv`.
-/

namespace Spec.Channels.Wavechannels6a

open Lean Spec

private def get (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def mapPairs (map : Json) : List (String × Json) :=
  match map.getObjVal? "$map" with
  | .ok (.arr entries) =>
    entries.toList.filterMap fun entry =>
      match Twin.arg entry 0 with
      | .str key => some (key, Twin.arg entry 1)
      | _ => none
  | _ => []

private def milliseconds (value : Json) : Nat :=
  (value.getNat?).toOption.getD 0

private def isUndefined (value : Json) : Bool :=
  value.compress == Twin.undefinedJson.compress

/-- `cachedChannelAgentList`: a live entry answers without loading; misses prune and replace the cache. -/
private def cachedChannelAgentList (call : Json) : Prog Json := do
  let lists := Twin.moduleValue call "channelAgentLists"
  if !(lists.getObjVal? "$map").toOption.isSome then
    return ← Prog.unsupported "the cache was too big to record"
  let now ← Prog.effect "Date.now"
  let key := match Twin.callArg call 0 with
    | .str value => value
    | _ => ""
  match (mapPairs lists).lookup key with
  | some entry =>
    if milliseconds (get entry "expiresAt") > milliseconds now then
      let agents := Twin.resolved (get entry "agents")
      if isUndefined agents then
        return ← Prog.unsupported "the cached load had not settled when recorded"
      return agents
    freshLoad lists now
  | none => freshLoad lists now
where
  freshLoad (lists now : Json) : Prog Json := do
    let retained := (Spec.Channels.Wavechannels8a.mapEntries lists).filter fun pair =>
      milliseconds (get (Twin.arg pair 1) "expiresAt") > milliseconds now
    let _ ← Prog.effect "channelAgentLists.keys().next"
    let retained := if retained.length >= 256 then retained.drop 1 else retained
    match ← Prog.attempt "load" with
    | .pending => Prog.unsupported "the load did not settle"
    | .threw error _ =>
      let remaining := retained.filter (fun pair => Twin.arg pair 0 != Twin.callArg call 0)
      Spec.Channels.Wavechannels8a.stateChange "module.channelAgentLists" lists
        (Spec.Channels.Wavechannels8a.mapValue remaining)
      throw error
    | .ok agents =>
      let promise := Json.mkObj [("$opaque", .str "Promise"),
        ("$fields", Json.mkObj [("$resolved", agents)])]
      let entry := Json.mkObj [("agents", promise), ("loadedAt", now),
        ("expiresAt", toJson (milliseconds now + 10000))]
      let next := Spec.Channels.Wavechannels8a.mapSet
        (Spec.Channels.Wavechannels8a.mapValue retained) (Twin.callArg call 0) entry
      Spec.Channels.Wavechannels8a.stateChange "module.channelAgentLists" lists next
      return agents

/-- This author's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/integrations.ts#cachedChannelAgentList" cachedChannelAgentList]

end Spec.Channels.Wavechannels6a
