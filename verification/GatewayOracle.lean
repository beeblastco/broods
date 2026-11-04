import Broods.Gateway

/-! Runs `Broods.Gateway.route` on `METHOD<TAB>/path` lines from stdin, one `Dest` per line.
`tests/gateway-oracle.test.ts` diffs it against `resolveRouter`. -/

open Broods.Gateway

def parseMethod (s : String) : Method :=
  match s.toUpper with
  | "GET" => .get
  | "HEAD" => .head
  | "POST" => .post
  | "PUT" => .put
  | "PATCH" => .patch
  | "DELETE" => .delete
  | "OPTIONS" => .options
  | _ => .other

/-- `url.pathname` to `Path`: split on `/`, leading empty segment dropped. -/
def parsePath (s : String) : Path :=
  (s.splitOn "/").drop 1

def render : Dest → String
  | .health => "health"
  | .socket .terminal => "socket:terminal"
  | .socket .machine => "socket:machine"
  | .socket .observability => "socket:observability"
  | .socket .agent => "socket:agent"
  | .config => "config"
  | .core => "core"
  | .notFound => "notFound"

def answer (line : String) : String :=
  match line.splitOn "\t" with
  | [m, p] => render (route (parseMethod m) (parsePath p))
  | _ => s!"error: bad line {line.quote}"

def main : IO Unit := do
  let stdin ← IO.getStdin
  let mut out := ""
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    out := out ++ answer (line.dropEndWhile '\n').copy ++ "\n"
  IO.print out
