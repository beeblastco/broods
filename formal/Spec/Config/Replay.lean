import Spec.Config.Model
namespace Spec.Config.Replay
open Lean

def row (kind : String) (input : Json) (expected : Json) : Json :=
  Json.mkObj [("kind", toJson kind), ("input", input), ("expected", expected)]

def scalarValues : List Value :=
  [.null, .bool false, .bool true, .num (-1), .num 0, .num 1, .num 2,
   .num 9007199254740992, .str "", .str " ", .str "${TOKEN}", .str "secret",
   .arr [], .arr [.null], .obj [], .obj [("x", .str "${TOKEN}")],
   .obj [("__proto__", .str "x")], .obj [("constructor", .num 1)]]

def strings : List String :=
  ["", "A", "TOKEN", "_X", "a", "A_1", "${TOKEN}", "${A}${B}", "${a}",
   "Bearer ${TOKEN}", "Basic ${A}${B}", "Bearer secret${A}", "${A}literal", "${A", "${}",
   "${1A}", "${A_${B}}", "localhost", "localhost.", "a.local", "a.internal", "[::1]",
   "::ffff:808:808", "fc00::1", "fe80::1", "feb0::1", "fec0::1", "2001:db8::1",
   "10.0.0.1", "100.64.0.1", "100.127.0.1", "100.128.0.1", "172.16.0.1", "172.32.0.1",
   "192.168.0.1", "8.8.8.8", "tool_old", "bash", "foo-bar", "1bad", "ümlaut",
   String.ofList (List.replicate 64 'A'), String.ofList (List.replicate 65 'A'),
   String.ofList (List.replicate 128 'A'), String.ofList (List.replicate 129 'A')]

def next (seed : Nat) : Nat := (1664525 * seed + 1013904223) % 4294967296

def randomValue : Nat → Nat → Value
  | 0, seed => scalarValues[seed % scalarValues.length]!
  | depth+1, seed =>
    let seed := next seed
    match seed % 5 with
    | 0 => .null
    | 1 => .str (["********","${TOKEN}","secret",""][seed % 4]!)
    | 2 => .arr [randomValue depth (next seed),randomValue depth (next (next seed))]
    | _ => .obj [("a",randomValue depth (next seed)),("b",randomValue depth (next (next seed)))]

def urlCases : List (String × Option (String × String)) :=
  [("https://example.com/",some ("https:","example.com")),
   ("http://example.com/",some ("http:","example.com")),
   ("https://127.0.0.1/",some ("https:","127.0.0.1")),
   ("https://localhost./",some ("https:","localhost.")),
   ("broken",none),("${URL}",none)]

def testUrlProblem (s : String) : Option String :=
  publicHttpsProblem ((urlCases.find? (fun p => p.1 == s)).bind Prod.snd)

def vectors : List Json := Id.run do
  let mut out : List Json := []
  for s in strings do
    out := out ++ [row "env" (toJson s) (Json.mkObj [
      ("nameError", toJson (envNameError s)), ("only", toJson (refsOnly s)),
      ("header", toJson (headerRefs s)),
      ("single",toJson (refsOnly s && (refsScan s.length s.toList).length == 1)), ("names", toJson ((refsScan s.length s.toList).eraseDups))]),
      row "request" (toJson s) (toJson (resolveRequestId (some s) "fresh")),
      row "private" (toJson s) (toJson (privateHostname s)),
      row "toolName" (toJson s) (toJson (providerToolName s))]
  for v in scalarValues do
    out := out ++ [row "stored" v.json (Json.mkObj [
      ("object", (objectOr v (.str "fallback")).json),
      ("strings", (stringValuesOr v (.str "fallback")).json)]),
      row "primitive" v.json (Json.mkObj [("positive", toJson (positiveInteger 2 v)),
        ("nonempty", toJson (nonEmpty v))])]
  for status in [-1, 200, 399, 400, 401, 402, 403, 404, 405, 409, 410, 413, 415, 422, 429,
      499, 500, 501, 502, 503, 504, 599, 600] do
    for code in [none, some "", some "custom"] do
      out := out ++ [row "api" (Json.mkObj [("status", toJson status), ("code", toJson code)])
        (apiError status "message ${TOKEN}" code (some "field")).json]
  for code in ["invalid_request", "unauthorized", "payment_required", "forbidden", "not_found",
      "conflict", "manifest_conflict", "__proto__", "constructor", "nope"] do
    for genuine in [false, true] do
      let v := Value.obj [("code", .str code), ("message", .str "failure")]
      out := out ++ [row "client" (Json.mkObj [("genuine",toJson genuine), ("data",v.json)])
        (clientData genuine v).json]
  for old in scalarValues do
    for patch in scalarValues do
      out := out ++ [row "merge" (Json.mkObj [("old",old.json),("patch",patch.json)])
        (mergeObjects old patch).json]
  for text in ["", "v1:x", "v2:", "v2:x", "v2:x:", "v2::", "v2:old:payload", "v2:retired:abc"] do
    let keys := [("old",false),("retired",true),("x",false)]
    out := out ++ [row "envelope" (toJson text) (Json.mkObj [
      ("keyId",toJson (currentKey keys)), ("hasKey",toJson (hasKey keys text)),
      ("needsRewrite",toJson (needsRewrite keys text))])]
  for base in [none, some "", some " ", some "https://example.com/", some " https://example.com/ "] do
    for alias in [none, some "", some "https://other.example/"] do
      let result := canonicalBase base alias
      out := out ++ [row "canonical" (Json.mkObj [("base_url",toJson base),("baseURL",toJson alias)])
        (Json.mkObj [("base_url",toJson result.1),("baseURL",toJson result.2)])]
  for host in ["localhost", "localhost.", "a.local", "example.com", "10.0.0.1", "8.8.8.8", "[::1]", "[fc00::1]"] do
    for protocol in ["http:","https:","file:"] do
      let parsed := some (protocol,host)
      out := out ++ [row "url" (toJson [protocol,host]) (toJson (publicHttpsProblem parsed))]
  for name in ["bash", "googleSearch", "tool_old", "1bad", "__proto__", "constructor", "read", "_valid"] do
    for entry in scalarValues ++ [.obj [("type",.str "provider")],
        .obj [("enabled",.str "yes")], .obj [("needsApproval",.null)],
        .obj [("config",.arr [])], .obj [("enabled",.str "bad"),("config",.num 1)]] do
      let input := Value.obj [(name,entry)]
      let result := match normaliseTools input with
        | .ok value => Json.mkObj [("ok",value.json)]
        | .error error => Json.mkObj [("error",toJson error)]
      out := out ++ [row "tools" input.json result]
  for v in scalarValues do
    out := out ++ [row "defaultSandbox" v.json (toJson (defaultSandbox (.obj [("sandboxes",v)]))),
      row "objects" v.json (sortValue 100 v).json]
  for n in [-10,0,1,2,30] do
    out := out ++ [row "rate" (toJson n) (rateHeaders 100 n).json]
  for methods in [[],["GET"],["GET","POST"]] do
    out := out ++ [row "method" (toJson methods) (methodError methods).json]
  let refs := [Mount.mk "first" "w1" (some "a"), Mount.mk "second" "w2" (some "b")]
  for sandboxes in [[],["a"],["a","b"],["b","a"],["b","b"],["z","b","a"]] do
    let result := (findLaterSandboxMount sandboxes refs).map fun (index,id,mount) =>
      Json.mkObj [("index",toJson index),("sandboxId",toJson id),("workspace",Json.mkObj [
        ("name",toJson mount.name),("workspaceId",toJson mount.workspaceId),("sandbox",toJson mount.sandbox)])]
    out := out ++ [row "mount" (toJson sandboxes) (toJson result)]
  for system in ["", "${TOKEN}", "normal prompt"] do
    for turns in [-1,0,1,100] do
      let fragment := AgentFragment.mk turns system
      out := out ++ [row "codecFragment"
        (Json.mkObj [("maxTurns",toJson turns),("systemPrompt",toJson system)])
        (encodeFragment fragment).json]
  for index in List.range 250 do
    let old := randomValue 3 (next (20261105 + index))
    let patch := randomValue 3 (next (30361105 + index))
    out := out ++ [row "merge" (Json.mkObj [("old",old.json),("patch",patch.json)])
      (mergeObjects old patch).json]
  let old := Value.obj [("a",.obj [("x",.str "old"),("y",.str "keep")])]
  for patch in [.obj [("a",.null)],.obj [("a",.obj [("x",.null)])],
      .obj [("a",.str "********")],.obj [("__proto__",.obj [("polluted",.bool true)])]] do
    out := out ++ [row "merge" (Json.mkObj [("old",old.json),("patch",patch.json)])
      (mergeObjects old patch).json]
  for s in strings do
    out := out ++ [row "requestHeader" (toJson s) (toJson (withRequestId (some s) "fresh"))]
  for v in scalarValues do
    let mapping := Value.obj [("x",.str "renamed"),("constructor",.str "other")]
    out := out ++ [row "remap" v.json (remapKeys (.obj (entries v)) mapping).json]
  out := out ++ [row "canonical"
    (Json.mkObj [("base_url",toJson ""),("baseURL",toJson "http://127.0.0.1/")])
    (Json.mkObj [("base_url",toJson ""),("baseURL",toJson "http://127.0.0.1/")])]
  for key in ["apiKey","gatewayId","base_url","baseURL","headers","apiUrl","otherURL","other"] do
    for x in scalarValues ++ (urlCases.map fun p => Value.str p.1) ++
        [.str "  https://example.com/  ",.obj [("Authorization",.str "Bearer ${TOKEN}")]] do
      let settings := Value.obj [(key,x)]
      let result := match normaliseProviderSettings testUrlProblem settings with
        | .ok value => Json.mkObj [("ok",value.json)]
        | .error error => Json.mkObj [("error",toJson error)]
      out := out ++ [row "providerSettings" settings.json result]
  return out

/-- Kept compatible with the shared replay entrypoint without editing it. -/
def run (_args : List String) : IO Unit := do
  for v in vectors do IO.println v.compress
end Spec.Config.Replay
