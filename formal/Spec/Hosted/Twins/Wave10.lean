import Spec.Twin
import Spec.Channels.Twins.Wavechannels8a

/-!
Wave 10 twins of the hosted subsystem. See `AUTHORING.md`.
-/

namespace Spec.Hosted.Wave10

open Lean Spec

/-- `MAX_RESULT_IMAGES` in `tools/utils.ts`. -/
private def maxResultImages : Nat := 8

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def str (value : Json) : String := (value.getStr?).toOption.getD ""

private def items (value : Json) : List Json :=
  match value with
  | .arr values => values.toList
  | _ => []

/-- JavaScript truthiness of a recorded value, for the shapes `structuredContent` takes. -/
private def truthy (value : Json) : Bool :=
  match value with
  | .null => false
  | .bool flag => flag
  | .str text => !text.isEmpty
  | .num number => number.mantissa != 0
  | other => other != Twin.undefinedJson

/-- `isImageLink`: an http(s) resource link with an image media type. -/
private def isImageLink (block : Json) : Bool :=
  let uri := (str (field block "uri")).toLower
  field block "type" == toJson "resource_link" && (str (field block "mimeType")).startsWith "image/" &&
    (uri.startsWith "https://" || uri.startsWith "http://")

/-- One block turned into its parts, given what `linkedImage` answered for it. -/
private def blockParts (text : Json) (linked : Option Json) : List Json :=
  let textPart := Json.mkObj [("type", toJson "text"), ("text", text)]
  match linked with
  | some part => if part == Twin.undefinedJson then [textPart] else [textPart, part]
  | none => [textPart]

/-- The effects a non-image block starts, as one entry per call in order. -/
private def blockEffects (fetched : Json → Nat → Bool) (index : Nat) (block : Json) :
    List (String × List Json) :=
  [("renderContent", [.arr #[block]]), ("isImageLink", [block])] ++
    (if fetched block index then
      [("linkedImage", [field block "uri", field block "mimeType"])] else [])

/-- `imageContentOutput`. Once a linked image is fetched the later blocks start while it runs, so
everything from that fetch until the last one is one overlapping group. -/
private def imageContentOutput (call : Json) : Prog Json := do
  let content := items (Twin.callArg call 0)
  let indexed := content.zipIdx
  let links := (indexed.filter fun (block, _) => isImageLink block).take maxResultImages |>.map (·.2)
  let isImage := fun (block : Json) => field block "type" == toJson "image"
  let fetched := fun (block : Json) (index : Nat) => isImageLink block && links.contains index
  let mut parts : Array Json := #[]
  let mut pending : List (Nat × Json) := indexed.map fun (block, index) => (index, block)
  let mut grouped : List (Nat × Json) := []
  -- Blocks before the first fetch run one effect at a time.
  while !pending.isEmpty do
    match pending with
    | [] => pure ()
    | (index, block) :: rest =>
      if isImage block then
        parts := parts.push (Json.mkObj
          [("type", toJson "image-data"), ("data", field block "data"),
           ("mediaType", field block "mimeType")])
        pending := rest
      else if fetched block index then
        grouped := pending
        pending := []
      else
        let rendered ← Prog.effect "renderContent" [.arr #[block]]
        let _ ← Prog.effect "isImageLink" [block]
        parts := parts ++ (blockParts rendered none).toArray
        pending := rest
  if !grouped.isEmpty then
    -- The first fetch's block already rendered and checked before the fetch started.
    let (_, first) := grouped.head!
    let rendered ← Prog.effect "renderContent" [.arr #[first]]
    let _ ← Prog.effect "isImageLink" [first]
    let later := grouped.tail!.filter fun (_, block) => !isImage block
    let wanted : List (String × List Json) :=
      [("linkedImage", [field first "uri", field first "mimeType"])] ++
        later.flatMap fun (index, block) => blockEffects fetched index block
    let outcomes ← Prog.all wanted
    let mut answers : List Json := []
    for outcome in outcomes do
      match outcome with
      | .ok value => answers := answers ++ [value]
      | .threw error _ => .fail error
      | .pending => Prog.unsupported "a fetch never settled"
    let mut rest := answers.tail!
    let firstLinked := answers.head!
    parts := parts ++ (blockParts rendered (some firstLinked)).toArray
    for (index, block) in grouped.tail! do
      if isImage block then
        parts := parts.push (Json.mkObj
          [("type", toJson "image-data"), ("data", field block "data"),
           ("mediaType", field block "mimeType")])
      else
        let rendered := rest.head!
        let wantsLink := fetched block index
        let linked := if wantsLink then some (rest.drop 2).head! else none
        parts := parts ++ (blockParts rendered linked).toArray
        rest := rest.drop (if wantsLink then 3 else 2)
  let structured := Twin.callArg call 1
  let tail : List Json :=
    if truthy structured then
      [Json.mkObj [("type", toJson "text"), ("text", toJson (Twin.jsonStringify 64 structured))]]
    else []
  let limited ← Prog.effect "withImageLimits" [.arr (parts.toList ++ tail).toArray]
  return Json.mkObj [("type", toJson "content"), ("value", limited)]

/-- `dropDeadWorkers`: the pool keeps only workers still alive. -/
private def dropDeadWorkers (call : Json) : Prog Json := do
  let pool := items (Twin.moduleValue call "pool")
  let alive := pool.filter fun worker => truthy (Twin.field worker "alive")
  if alive.length != pool.length then
    Prog.setState "module.pool" (.arr alive.toArray)
  return Twin.undefinedJson

/-- A module `Map` as the recorder writes it, with `$map` entries, or none when it is not one. -/
private def mapPairs (value : Json) : List Json :=
  Spec.Channels.Wavechannels8a.mapEntries value

/-- `setHostedMcpSendBatchForTests`: swaps the sender and forgets every open batch and cooldown. -/
private def setHostedMcpSendBatchForTests (call : Json) : Prog Json := do
  let send := Twin.callArg call 0
  let before := Twin.moduleValue call "sendOverride"
  if before != send then
    Prog.setState "module.sendOverride" send
  let batches := mapPairs (Twin.moduleValue call "openBatches")
  for entry in batches do
    let _ ← Prog.effect "clearTimeout" [field (Twin.arg entry 1) "timer"]
  if !batches.isEmpty then
    Prog.setState "module.openBatches" (Spec.Channels.Wavechannels8a.mapValue [])
  if !(mapPairs (Twin.moduleValue call "unloadableOnWorker")).isEmpty then
    Prog.setState "module.unloadableOnWorker" (Spec.Channels.Wavechannels8a.mapValue [])
  return Twin.undefinedJson

/-- `clearMcpOauthTokens`: the token cache and the rotated refresh tokens are emptied. -/
private def clearMcpOauthTokens (call : Json) : Prog Json := do
  if !(mapPairs (Twin.moduleValue call "tokenCache")).isEmpty then
    Prog.setState "module.tokenCache" (Spec.Channels.Wavechannels8a.mapValue [])
  if !(mapPairs (Twin.moduleValue call "rotatedRefreshTokens")).isEmpty then
    Prog.setState "module.rotatedRefreshTokens" (Spec.Channels.Wavechannels8a.mapValue [])
  return Twin.undefinedJson

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced "apps/core/src/harness/mcp/client.ts#imageContentOutput" imageContentOutput,
   Twin.traced "apps/core/src/harness/isolate/executor.ts#dropDeadWorkers" dropDeadWorkers,
   Twin.traced "apps/core/src/harness/mcp/oauth.ts#clearMcpOauthTokens" clearMcpOauthTokens,
   Twin.traced "apps/core/src/harness/mcp/hosted.ts#setHostedMcpSendBatchForTests"
     setHostedMcpSendBatchForTests]

end Spec.Hosted.Wave10
