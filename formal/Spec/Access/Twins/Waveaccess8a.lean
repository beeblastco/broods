import Spec.Twin
import Spec.Access.Twins.Js

namespace Spec.Access.Waveaccess8a

open Lean Spec

private def normalized : Nat → Json → Json
  | 0, value => value
  | fuel + 1, .arr values => .arr (values.map (normalized fuel))
  | fuel + 1, .obj fields => Json.mkObj (fields.toList.filterMap fun (key, value) =>
      if ["$fields", "$keys", "$class"].contains key then none
      else some (key, normalized fuel value))
  | _, value => value

def setModule (call : Json) (name : String) (value : Json) : Prog Unit := do
  let old := Twin.moduleValue call name
  if old != Twin.undefinedJson && normalized 32 old != normalized 32 value then
    Prog.setState ("module." ++ name) value

private def parseCursor (args : Json) : Json :=
  let value := (Twin.arg args 0).getStr?.toOption.getD ""
  let parts := value.splitOn ":"
  let parsed : Option (String × String × String) := match parts with
    | ["ws-responses", generation, sequence, eventKey] =>
      if eventKey.isEmpty then none else some (generation, sequence, eventKey)
    | _ => none
  match parsed with
  | none => Json.null
  | some (generation, digits, eventKey) =>
    if generation.isEmpty || digits.isEmpty ||
        !(digits.toList.all fun c => '0' <= c && c <= '9') then Json.null
    else match digits.toNat? with
      | none => Json.null
      | some sequence =>
        if sequence > 9007199254740991 then Json.null
        else Json.mkObj ([("generation", toJson generation), ("sequence", toJson sequence)] ++
          [("eventKey", toJson eventKey)])

private def undefinedField (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD Twin.undefinedJson

private def isTrue (value : Json) : Bool := value == toJson true

private def numberOf (value : Json) : Nat := value.getNat?.toOption.getD 0

/-- `STATUS_POLL_INTERVAL_MS`, `NATS_TAIL_GRACE_POLLS`, `NATS_TAIL_MAX_WAIT_MS` in `agent.ts`. -/
private def statusPollMs : Nat := 500
private def tailGracePolls : Nat := 4
private def tailMaxWaitMs : Nat := 10000

/-- What `waitForNatsTail` carries between passes. `reads` counts `signal.aborted` reads so far. -/
structure TailState where
  boundary : Nat
  stable : Nat := 0
  reads : Nat := 0

/-- The `while` of `waitForNatsTail`, bounded by the deadline: at most one pass per poll interval. -/
private def tailLoop (call options : Json) (deadline : Nat) : Nat → TailState → Prog Unit
  | 0, _ => Prog.unsupported "more polls than the deadline allows"
  | fuel + 1, tail => do
    if Twin.abortedRead call tail.reads then return ()
    let tail := { tail with reads := tail.reads + 1 }
    if isTrue (← Prog.effect "options.sawDone") then return ()
    if isTrue (← Prog.effect "options.streamSettled") then return ()
    if tail.stable >= tailGracePolls then return ()
    if numberOf (← Prog.effect "Date.now") >= deadline then return ()
    let consumed ← Prog.effect "options.lastConsumedSequence"
    let _ ← Prog.effect "Bun.sleep" [toJson statusPollMs]
    if numberOf consumed < tail.boundary then
      return ← tailLoop call options deadline fuel tail
    if Twin.abortedRead call tail.reads then return ()
    let tail := { tail with reads := tail.reads + 1 }
    if isTrue (← Prog.effect "options.sawDone") then return ()
    if isTrue (← Prog.effect "options.streamSettled") then return ()
    let latest ← Prog.attempt "conversationReplaySnapshot" [options]
    let last : Option Nat ← match latest with
      | .ok value =>
        pure (if value == .null then none else some (numberOf (undefinedField value "lastSequence")))
      | .threw _ _ => pure none
      | .pending => Prog.unsupported "the snapshot never settled"
    match last with
    | some sequence =>
      if sequence > tail.boundary then
        tailLoop call options deadline fuel { tail with boundary := sequence, stable := 0 }
      else
        tailLoop call options deadline fuel { tail with stable := tail.stable + 1 }
    | none => tailLoop call options deadline fuel { tail with stable := tail.stable + 1 }

/-- `waitForNatsTail`: waits for the consumer to pass the boundary, then for the tail to go quiet. -/
private def waitForNatsTail (call : Json) : Prog Json := do
  let options := Twin.callArg call 0
  let now ← Prog.effect "Date.now"
  let boundary := numberOf (undefinedField options "initialBoundary")
  tailLoop call options (numberOf now + tailMaxWaitMs) 64 { boundary := boundary }
  return Twin.undefinedJson

/-- `getNatsConnection`: one shared connection, created on first use; a failed dial is not kept. -/
private def getNatsConnection (call : Json) : Prog Json := do
  let cached := Twin.moduleValue call "natsConnectionPromise"
  if cached != .null && cached != Twin.undefinedJson then
    let value := Twin.resolved cached
    if value == Twin.undefinedJson then return ← Prog.unsupported "the shared connection has not resolved"
    return value
  let trimmed (name : String) : String :=
    match Twin.env call name with
    | .str value => Js.trim value
    | _ => ""
  let natsUrl := trimmed "NATS_URL"
  if natsUrl.isEmpty then return ← Prog.throwError "Error" "Gateway requires NATS_URL"
  let token := trimmed "NATS_TOKEN"
  let tokenField := if token.isEmpty then [] else [("token", toJson token)]
  let answer ← Prog.attempt "connectNats"
    [Json.mkObj ([("servers", toJson natsUrl), ("maxReconnectAttempts", toJson (-1 : Int))] ++ tokenField)]
  match answer with
  | .ok connection =>
    Prog.spawn "connection.closed"
    setModule call "natsConnectionPromise" (Json.mkObj [("$opaque", toJson "Promise")])
    return connection
  | .threw error _ => throw error
  | .pending => Prog.unsupported "the dial never settled"

def twins : List Spec.Twin :=
  [{ source := "apps/gateway/src/agent.ts#parseCursor", run := parseCursor },
   Twin.traced "apps/gateway/src/agent.ts#waitForNatsTail" waitForNatsTail,
   Twin.traced "apps/gateway/src/main.ts#getNatsConnection" getNatsConnection]

end Spec.Access.Waveaccess8a
