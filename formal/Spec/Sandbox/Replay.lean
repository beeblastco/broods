import Lean.Data.Json
import Spec.Sandbox.Model

namespace Spec.Sandbox.Replay
open Lean

def providerName : Provider → String
  | .sandbox => "sandbox" | .lambda => "lambda" | .e2b => "e2b"
  | .daytona => "daytona" | .vercel => "vercel" | .cloudflare => "cloudflare"
  | .worker => "worker" | .machine => "machine" | .custom => "custom"

/-- Exhaustive capability flags and directed lexical vectors, independent of TypeScript. -/
def run (_args : List String) : IO Unit := do
  for p in providers do
    for disk in [false, true] do
      for persistent in [false, true] do
        for optIn in [false, true] do
          IO.println (Json.mkObj [("kind", "provider"), ("provider", toJson (providerName p)),
            ("disk", toJson disk), ("persistent", toJson persistent), ("optIn", toJson optIn),
            ("holds", toJson (holdsWorkspace p disk persistent optIn)),
            ("capabilities", toJson (capabilities p))]).compress
  for path in ["", ".", "/", "a", " a/b ", "/a//./b/", "../a", "a/../b", "a/..",
      "..", "...", "a..b", "a\\..\\b", "/a/%2e%2e/b", "//./", "link/target", " /a/./b﻿", " ../a ", "​a​"] do
    IO.println (Json.mkObj [("kind", "path"), ("path", toJson path),
      ("expected", toJson (lexicalPath path))]).compress
  for occupied in [false, true] do
    for previous in [none, some "", some "one", some "two"] do
      for incoming in [none, some "", some "one", some "two"] do
        for force in [false, true] do
          IO.println (Json.mkObj [("kind", "hello"), ("occupied", toJson occupied),
            ("previous", toJson previous), ("incoming", toJson incoming), ("force", toJson force),
            ("expected", toJson (acceptsHello occupied previous incoming force))]).compress
  for attached in [[], [1], [1, 2], [2, 1]] do
    for requested in [none, some 1, some 2, some 3] do
      IO.println (Json.mkObj [("kind", "computer"), ("attached", toJson attached),
        ("requested", toJson requested), ("expected", toJson (selectComputer attached requested))]).compress
      for mounted in [false, true] do
        IO.println (Json.mkObj [("kind", "bash"), ("attached", toJson attached), ("mounted", toJson mounted),
          ("requested", toJson requested), ("expected", toJson (selectBash attached mounted requested))]).compress
  -- One expired reservation whose teardown fails; `retained` and `kept` are the two claims.
  for retained in [false, true] do
    for kept in [false, true] do
      let (s, effects) := cleanupStep {} (.sweep true true true false retained kept)
      IO.println (Json.mkObj [("kind", "cleanup"), ("retained", toJson retained),
        ("kept", toJson kept), ("row", toJson s.row), ("physical", toJson s.physical),
        ("outcomes", toJson effects)]).compress

end Spec.Sandbox.Replay
