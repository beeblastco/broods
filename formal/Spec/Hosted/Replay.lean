import Spec.Hosted.Model
namespace Spec.Hosted.Replay
open Lean

def row (kind name : String) (input expected : Json) : Json :=
  Json.mkObj [("kind", toJson kind), ("name", toJson name), ("input", input), ("expected", expected)]

def frames : List Frame :=
  [.final "1" (Json.mkObj [("status", toJson (200 : Nat)), ("headers", Json.mkObj []), ("body", "héllo\n🙂")]),
   .error "2" "failed\n\"quoted\"", .endBatch (some 47), .failedBatch "bad" (some 19),
   .chunk (toJson (7 : Nat)), .log "warn" "hi"]

def frameVectors : List Json :=
  frames.flatMap fun f =>
    let wire := encode f
    (List.range (wire.length + 1)).map fun n =>
      let chars := wire.toList
      let chunks := [chars.take n, chars.drop n]
      row "frames" s!"split-{n}-{wire}" (toJson (chunks.map String.ofList))
        (toJson (parseChunks chunks))

def trailingVectors : List Json :=
  frames.map fun f =>
    let line := String.ofList (encode f).toList.dropLast
    row "frames" "unterminated" (toJson [line]) (toJson (parseChunks [line.toList]))

def malformed : List String :=
  ["", "  ", "no json", "null", "[]", "7", "{}", "{\"t\":\"bogus\"}",
   "{\"t\":\"final\"}", "{\"t\":\"error\",\"error\":4}", " {\"t\":\"end\"} ",
   "{\"t\":\"log\",\"level\":null}", "{\"t\":\"chunk\"}", "{\"t\":\"end\"}"]

def bools : List Bool := [false, true]

def retryVectors : List Json :=
  ["ConnectionRefused", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "FailedToOpenSocket", "ECONNRESET"].map
    (fun code => row "retry" code (Json.mkObj [("code", toJson code)])
      (toJson [retry (if code == "ECONNRESET" then Failure.reset else .neverConnected), false])) ++
  ["TimeoutError", "AbortError", "Error"].map
    (fun name => row "retry" name (Json.mkObj [("name", toJson name)])
      (toJson [false, name == "TimeoutError"])) ++
  [422, 504, 503, 429].flatMap (fun status => bools.map (fun tagged =>
    row "retry" s!"{status}-{tagged}" (Json.mkObj [("status", toJson status), ("tagged", toJson tagged)])
      (toJson [retry (if tagged then Failure.nothingRan status else .http status), false])))

def vectors : List Json := retryVectors ++ frameVectors ++ trailingVectors ++
  malformed.map (fun line => row "parse" line (toJson line) (toJson (parseLine line))) ++
  ["README.md", " SKILL.md ", "a/b.json", "../a", "/a", "a//b", "a/../b", "a\\b", "a/./b", "", "a\x00b"].map
    (fun path => row "path" path (toJson path) (toJson (skillPath path))) ++
  [none, some 0, some 1, some 300000, some 3600001].map
    (fun ttl => row "ttl" s!"{ttl}" (toJson ttl) (toJson (listingTtl ttl))) ++
  (List.range 6).flatMap (fun n => [none, some 0, some 47000, some 60001].map
    (fun asked => row "wait" s!"{n}-{asked}" (toJson (n, asked)) (toJson (rateWait n asked)))) ++
  [RunStatus.awaitingInput, .awaitingApproval, .completed, .failed, .expired, .other].flatMap
    (fun status => bools.map (fun stopped =>
      let name := match status with
        | .awaitingInput => "awaiting_input" | .awaitingApproval => "awaiting_approval"
        | .completed => "completed" | .failed => "failed" | .expired => "expired" | .other => "running"
      row "task" s!"{name}-{stopped}" (toJson (name, stopped)) (toJson (taskStatus status stopped)))) ++
  bools.flatMap (fun machine => bools.flatMap (fun hosted => bools.flatMap (fun sandbox =>
    bools.flatMap (fun command => bools.flatMap (fun headers => bools.flatMap (fun runtime =>
    bools.flatMap (fun oauth => bools.flatMap (fun https => bools.map (fun auth =>
      let args := [machine, hosted, sandbox, command, headers, runtime, oauth, https, auth]
      row "row" s!"{args}" (toJson args)
        (toJson (validMcpRow machine hosted sandbox command (headers || auth) runtime oauth https auth)))))))))))

def filteredVectors : List Json :=
  vectors.filter fun v =>
    match (v.getObjValAs? String "kind").toOption with
    | some "row" =>
      match ((v.getObjVal? "input").toOption.bind (fun j => j.getArr?.toOption)) with
      | some args => !((args[0]?.bind (fun j => j.getBool?.toOption)).getD false &&
          (args[1]?.bind (fun j => j.getBool?.toOption)).getD false)
      | none => false
    | _ => true

def run (_args : List String) : IO Unit := do
  for v in filteredVectors do IO.println v.compress
end Spec.Hosted.Replay
