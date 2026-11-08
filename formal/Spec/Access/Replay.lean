import Lean.Data.Json
import Spec.Access.Model

namespace Spec.Access.Replay
open Lean
open Lean

def paths : List String :=
  ["/", "/healthz", "/unknown", "/v1", "/mcp", "/v1/downloads/key", "/v1/accounts", "/v1/accounts/a",
   "/v1/accounts/a/rotate-secret", "/v1/account", "/v1/account/x", "/v1/agents", "/v1/agents/a",
   "/v1/agents/a/channels/c/directory", "/v1/env", "/v1/env/x", "/v1/workspaces/w/download-links",
   "/v1/audit", "/v1/audit/verify", "/v1/usage", "/v1/audit/sink", "/v1/workspaces/w/files", "/v1/crons/c/runs",
   "/v1/sandboxes/terminal/ws", "/v1/machines/ws", "/v1/agents/a/ws",
   "/v1/projects/p/stages/s/agents/a/ws", "/v1/projects/p/stages/s/observability/ws",
   "/v1/webhooks/a/pancake", "/v1/webhooks/a/dev/b/pancake", "/v1/webhooks/a/other", "/v1/media/key",
   "/v1/webhooks/", "/v1/media/", "/v1/downloads/a/b", "/v1/projects//stages/s/agents/a/ws"] ++
   ["skills", "mcp", "hooks", "workspaces", "sandboxes", "policies", "roles", "channels", "crons"].flatMap
      (fun r => ["/v1/" ++ r, "/v1/" ++ r ++ "/id"])

def routeRun : IO Unit := do
  for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get", "TRACE"] do
    for path in paths.flatMap (fun p => [p, p ++ "///"]) do
      let r := resolveRoute method path
      IO.println (Json.mkObj [("kind", toJson "route"), ("method", toJson method), ("path", toJson path),
        ("route", toJson (r.map routeName)), ("secret", toJson (r.any secretPath))]).compress
  for n in [0:8] do
    for m in [0:8] do
      let rule : ApiRule := ⟨"r", n % 2 == 1, if n / 2 % 2 == 1 then ["agents:read"] else [],
        if n / 4 == 1 then some ["x"] else none⟩
      let resource : ApiResource := ⟨if m % 2 == 1 then some "x" else none, if m / 2 % 2 == 1 then some "p" else none, none⟩
      IO.println (Json.mkObj [("kind", toJson "api"), ("n", toJson n), ("m", toJson m),
        ("allow", toJson (authorize (if m / 4 == 1 then some "p" else none) none [rule] "agents:read" resource))]).compress
  for required in [false, true] do
    for present in [false, true] do
      for isPublic in [false, true] do
        for ticket in [false, true] do
          for scope in [false, true] do
            for owns in [false, true] do
              IO.println (Json.mkObj [("kind", toJson "status"), ("required", toJson required),
                ("present", toJson present), ("public", toJson isPublic), ("ticket", toJson ticket),
                ("scope", toJson scope), ("owns", toJson owns),
                ("result", toJson (statusDecision true isPublic ticket scope true required present owns))]).compress

end Spec.Access.Replay


namespace Spec.Access.Replay
open Lean

def authRun : IO Unit := do
  let kinds := [Kind.role, .stage, .run, .admin, .service, .account, .runtime, .user, .terminal, .media, .unknown, .scoped]
  for (kind, index) in kinds.zipIdx do
    for bits in [0:64] do
      let flag := fun n => bits / 2^n % 2 == 1
      let c : Credential := ⟨kind, 7, flag 0, flag 1, flag 4, flag 5⟩
      let r : Request := ⟨flag 2, flag 3⟩
      let resolved := resolve c r
      let name := resolved.map fun a => match a with
        | .admin => "admin" | .account _ _ => "account" | .role _ => "role"
        | .deployment _ => "deployment" | .agent _ => "agent"
      IO.println (Json.mkObj [("kind", toJson "auth"), ("index", toJson index), ("bits", toJson bits),
        ("result", toJson name), ("account", toJson (resolved.bind authAccount))]).compress
  let purposes := [Purpose.run, .terminal, .media, .stage, .user]
  for (source, i) in purposes.zipIdx do
    for (target, j) in purposes.zipIdx do
      let expires := if source == .media then 2592100000 else 101000
      for moment in [100000, expires - 1, expires, expires + 1, 3000000000] do
        let t : Ticket := ⟨source, 7, expires, true, true, true⟩
        IO.println (Json.mkObj [("kind", toJson "ticket"), ("source", toJson i), ("target", toJson j),
          ("at", toJson moment), ("accepted", toJson ((openTicket target moment t).isSome))]).compress

end Spec.Access.Replay


namespace Spec.Access.Replay
open Lean

def upgradeRun : IO Unit := do
  for route in [0:5] do
    for bits in [0:256] do
      let flag := fun n => bits / 2^n % 2 == 1
      let result := upgrade (flag 0) (flag 1) (flag 2) (route == 0) (route == 1)
        (route == 2 || route == 3) (flag 3) (flag 4) (flag 5) (flag 6)
        (route != 2 || flag 7)
      IO.println (Json.mkObj [("kind", toJson "upgrade"), ("route", toJson route),
        ("bits", toJson bits), ("result", toJson result)]).compress

end Spec.Access.Replay


namespace Spec.Access.Replay
open Lean

def keysRun : IO Unit := do
  for value in reservedEvents.map (· ++ "id") ++ ["", " key ", "subagent~id", "slack-command:id", "public"] do
    for event in [false, true] do
      IO.println (Json.mkObj [("kind", toJson "identifier"), ("value", toJson value), ("event", toJson event),
        ("valid", toJson (validPublicIdentifier event value))]).compress
  for value in ["acct:a:agent:g:api:key", "acct:b:agent:g:api:key", "acct:a:agent:h:api:key", "acct::agent:g:api:key", "acct:a:agent:g:", "acct:a:agent:g::", "api:key", "bsu:u:key"] do
    IO.println (Json.mkObj [("kind", toJson "key"), ("value", toJson value),
      ("parsed", toJson ((parseScopedKey value).map fun (a, g, k) => [a, g, k])),
      ("public", toJson (publicConversation value "a" (some "g")))]).compress
  for n in [0:8] do
    let supplied := if n % 2 == 1 then some [Link.user "u"] else none
    let cron := n / 2 % 2 == 1
    let user := if n / 4 == 1 then some "channel-user" else none
    let chain := directChain supplied cron user
    IO.println (Json.mkObj [("kind", toJson "principal"), ("n", toJson n),
      ("chain", toJson (chain.map (·.map principalLabel))),
      ("delegated", toJson ((delegatedChain "g" chain).map (·.map principalLabel)))]).compress
  for now in [0, 59999, 60000, 60001] do
    for count in [0, 1, 2, 3] do
      let window : Window := ⟨0, count⟩
      let current := if count == 0 then none else some window
      let hit := hitWindow now 60000 2 current
      IO.println (Json.mkObj [("kind", toJson "limiter"), ("now", toJson now), ("count", toJson count),
        ("blocked", toJson (blocked now 60000 2 current)), ("allow", toJson hit.2), ("retry", toJson (retryAfterSeconds now 60000 current))]).compress

end Spec.Access.Replay


namespace Spec.Access.Replay
open Lean

def childRun : IO Unit := do
  for fault in [0:18] do
    let good := fun n => fault != n
    let result := subagentStatus (good 1) (good 2) (good 3) (good 4) (good 5)
      (good 6) (good 7) (good 8) false (good 9) (good 10) (good 11) (good 12)
      (fault == 13) (fault != 13) (good 14)
    IO.println (Json.mkObj [("kind", toJson "child"), ("fault", toJson fault), ("result", toJson result)]).compress

end Spec.Access.Replay


namespace Spec.Access.Replay
open Lean

def namesRun : IO Unit := do
  for name in ["", "key", "monkey", "oauth", "Authorization", "API_KEY", "apiKey", "userToken", "inputTokens", "max_output_tokens",
    "clientSecret", "PASSWORD", "kubeconfig", "reservationKey", "public_key", "conversationKey", "objectKey", "privateKey",
    "cacheKey", "embeddableKey", "secretariat", "PasswordHash", "mycredential", "user.token", "auth", "tokens", "keys", "cookie"] ++
    ["event", "password", "public", "private", "storage", "cache"].flatMap (fun a => [a ++ "Key", a ++ "_keys", a ++ "-token", a ++ "APIKey"]) do
    IO.println (Json.mkObj [("kind", toJson "secretName"), ("name", toJson name), ("secret", toJson (isSecretName name))]).compress

end Spec.Access.Replay

namespace Spec.Access.Replay

def run (_args : List String) : IO Unit := do
  Spec.Access.Replay.routeRun
  Spec.Access.Replay.authRun
  Spec.Access.Replay.upgradeRun
  Spec.Access.Replay.keysRun
  Spec.Access.Replay.childRun
  Spec.Access.Replay.namesRun

end Spec.Access.Replay
