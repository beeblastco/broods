import Lean.Data.Json

/-!
A twin is the Lean counterpart of one TypeScript function. `scripts/conform.ts` records the real
function's calls while the repository's own tests run, then checks each call against its twin. The
same recorded calls can later grade a port.
-/

namespace Spec

open Lean

/-- What one effect gave back: a value, what it threw (and whether that was synchronous), or
nothing yet. A program must not read a value out of an effect that has not finished. -/
inductive Outcome where
  | ok (value : Json)
  | threw (error : Json) (sync : Bool)
  | pending

/-- A function written as the effects it performs. `call` names one effect and goes on with what came
back. `par` starts several at once and goes on when all have finished. One definition can be replayed
against a recording, or reasoned about over every possible answer from the outside world. -/
inductive Prog (α : Type) where
  | done (value : α)
  | fail (error : Json)
  | call (fn : String) (args : Json) (next : Outcome → Prog α)
  | par (calls : List (String × Json)) (next : List Outcome → Prog α)
  /-- Starts an effect and does not wait for it, as `void f()` does. Its answer cannot be read. -/
  | detach (fn : String) (args : Json) (next : Prog α)
  /-- Says the call left this field or module binding holding this value. -/
  | state (path : String) (value : Json) (next : Prog α)
  /-- Asks whether something outside has just entered one of this function's callbacks, and if so
  which and with what. `none` means nothing has. The outside world decides, so this is an input. -/
  | input (next : Option (String × Json) → Prog α)

namespace Prog

variable {α β : Type}

/-- Runs `p`, then `f` on its result. A failure stops the rest. -/
def bind : Prog α → (α → Prog β) → Prog β
  | .done value, f => f value
  | .fail error, _ => .fail error
  | .call fn args next, f => .call fn args fun outcome => (next outcome).bind f
  | .par calls next, f => .par calls fun outcomes => (next outcomes).bind f
  | .detach fn args next, f => .detach fn args (next.bind f)
  | .state path value next, f => .state path value (next.bind f)
  | .input next, f => .input fun entered => (next entered).bind f

/-- Runs `p`, and `handler` if it fails. -/
def catchFail : Prog α → (Json → Prog α) → Prog α
  | .done value, _ => .done value
  | .fail error, handler => handler error
  | .call fn args next, handler => .call fn args fun outcome => (next outcome).catchFail handler
  | .par calls next, handler => .par calls fun outcomes => (next outcomes).catchFail handler
  | .detach fn args next, handler => .detach fn args (next.catchFail handler)
  | .state path value next, handler => .state path value (next.catchFail handler)
  | .input next, handler => .input fun entered => (next entered).catchFail handler

instance : Monad Prog where
  pure := .done
  bind := bind

instance : MonadExcept Json Prog where
  throw := .fail
  tryCatch := catchFail

/-- Performs an effect and returns its value. If it throws, so does this. -/
def effect (fn : String) (args : List Json := []) : Prog Json :=
  .call fn (.arr args.toArray) fun
    | .ok value => .done value
    | .threw error _ => .fail error
    | .pending => .fail (Json.mkObj [("pending", true)])

/-- Performs an effect and hands back its outcome, for code that handles a throw itself. -/
def attempt (fn : String) (args : List Json := []) : Prog Outcome :=
  .call fn (.arr args.toArray) .done

/-- States a change the call made: `self.#windows`, `self.closed`, `module.cache`, `args.0.data.token`. A function whose
recording shows a state change earns no credit until its twin states that change. -/
def setState (path : String) (value : Json) : Prog Unit :=
  .state path value (.done ())

/-- Starts an effect without waiting for it. -/
def spawn (fn : String) (args : List Json := []) : Prog Unit :=
  .detach fn (.arr args.toArray) (.done ())

/-- Starts effects together and hands back their outcomes in the same order. -/
def all (calls : List (String × List Json)) : Prog (List Outcome) :=
  .par (calls.map fun (fn, args) => (fn, Json.arr args.toArray)) .done

/-- Handles every callback entered since the last check, in order. `limit` bounds how many. -/
def drain (handle : String → Json → Prog Unit) : Nat → Prog Unit
  | 0 => pure ()
  | limit + 1 =>
    .input fun
      | none => pure ()
      | some (label, args) => bind (handle label args) fun _ => drain handle limit

/-- Stops on a call the model does not cover, which `conform.ts` counts as unsupported. -/
def unsupported (reason : String) : Prog α :=
  .fail (Json.mkObj [("$unsupported", toJson reason)])

/-- The JSON the recorder writes for a thrown `Error`. -/
def errorJson (name message : String) (fields : List (String × Json) := []) : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("name", toJson name), ("message", toJson message), ("fields", Json.mkObj fields)])]

/-- Throws an `Error` with this name and message. -/
def throwError (name message : String) (fields : List (String × Json) := []) : Prog α :=
  .fail (errorJson name message fields)

end Prog

/-- The JSON the recorder writes for a value of `undefined`. -/
def Twin.undefinedJson : Json :=
  Json.mkObj [("$undefined", true)]

/-- One TypeScript function's counterpart. `source` is `path#name` or `path#Class.method`. `run` takes
the call's arguments as a JSON array and returns what the function returned. Use `Twin.threw` for a
call that throws, and `Twin.unsupported` for arguments outside what the model covers, which are counted
and reported so that a narrow twin cannot look like a complete one. -/
structure Twin where
  source : String
  run : Json → Json
  gaps : List String := []
  /-- Set for a traced twin: it is judged on the effects it asks for, not only on its result. -/
  prog : Option (Json → Prog Json) := none
  /-- Which calls a listed gap explains. A mismatch outside these still fails the check. -/
  gapCovers : Json → Bool := fun _ => false

/-- The output for a call that throws `message`. -/
def Twin.threw (message : String) : Json :=
  Json.mkObj [("threw", toJson message)]

/-- The output for arguments the twin does not model. -/
def Twin.unsupported (reason : String) : Json :=
  Json.mkObj [("unsupported", toJson reason)]

/-- The call's argument at `index`, or null when the caller left it out. -/
def Twin.arg (args : Json) (index : Nat) : Json :=
  match args with
  | .arr items => items.getD index Json.null
  | _ => Json.null

/-- A twin of a function that has effects. `prog` takes `{"args": [...], "self": ...}`. -/
def Twin.traced (source : String) (prog : Json → Prog Json) (gaps : List String := []) : Twin :=
  { source := source
    run := fun _ => Twin.unsupported "traced twin"
    gaps := gaps
    prog := some prog }

/-- The traced call's argument at `index`, or the recorded `undefined` when it was left out. -/
def Twin.callArg (call : Json) (index : Nat) : Json :=
  match call.getObjVal? "args" with
  | .ok (.arr items) => items.getD index Twin.undefinedJson
  | _ => Twin.undefinedJson

/-- A scalar field of a recorded class instance, such as `session.accountId`. -/
def Twin.field (value : Json) (name : String) : Json :=
  ((value.getObjVal? "$fields").toOption.bind fun fields =>
    (fields.getObjVal? name).toOption).getD Twin.undefinedJson

/-- A parameter after its default ran, for a function that has defaults. -/
def Twin.param (call : Json) (index : Nat) : Json :=
  match call.getObjVal? "params" with
  | .ok (.arr items) => items.getD index Twin.undefinedJson
  | _ => Twin.undefinedJson

/-- What `process.env.NAME` held when the function read it. -/
def Twin.env (call : Json) (name : String) : Json :=
  (((call.getObjVal? "env").toOption.bind fun env => (env.getObjVal? name).toOption)).getD
    Twin.undefinedJson

/-- A module-level binding as it stood when the function was called. -/
def Twin.moduleValue (call : Json) (name : String) : Json :=
  (((call.getObjVal? "module").toOption.bind fun table => (table.getObjVal? name).toOption)).getD
    Twin.undefinedJson

/-- `JSON.stringify`, using the key order recorded in `$keys`. Without it keys come out sorted. -/
def Twin.jsonStringify : Nat → Json → String
  | 0, _ => "null"
  | fuel + 1, value =>
    match value with
    | .arr items => "[" ++ ",".intercalate (items.toList.map (Twin.jsonStringify fuel)) ++ "]"
    | .obj kvs =>
      let order : List String := match value.getObjVal? "$keys" with
        | .ok (.arr keys) => keys.toList.filterMap (fun key => (Json.getStr? key).toOption)
        | _ => kvs.keys
      let parts := order.filterMap fun key =>
        match key != "$keys" && key != "$fields", value.getObjVal? key with
        | true, .ok item =>
          some (Json.compress (toJson key) ++ ":" ++ Twin.jsonStringify fuel item)
        | _, _ => none
      "{" ++ ",".intercalate parts ++ "}"
    | other => other.compress

/-- What a recorded promise resolved to, when it had by the time it was recorded. -/
def Twin.resolved (value : Json) : Json :=
  Twin.field value "$resolved"

/-- The request-scoped observability context the function read, secrets included. -/
def Twin.observabilityContext (call : Json) : Json :=
  Twin.env call "$observabilityContext"

/-- The result of the function's `index`th read of an `aborted` or `closed` flag, in order. -/
def Twin.abortedRead (call : Json) (index : Nat) : Bool :=
  match call.getObjVal? "aborted" with
  | .ok (.arr items) =>
    match items.getD index Json.null with
    | .bool value => value
    | _ => false
  | _ => false

/-- The receiver of a traced method call. -/
def Twin.self (call : Json) : Json :=
  (call.getObjVal? "self").toOption.getD Json.null

/-- One effect from a recording, and the group of overlapping effects it ran in. -/
structure Recorded where
  fn : String
  args : Json
  outcome : Outcome
  block : Nat
  blockSize : Nat

/-- Reads a recorded outcome. -/
def Outcome.ofJson (json : Json) : Outcome :=
  match json.getObjVal? "returned", json.getObjVal? "threw" with
  | .ok value, _ => .ok value
  | _, .ok error => .threw error ((json.getObjValAs? Bool "sync").toOption.getD false)
  | _, _ => .pending

/-- Reads one recorded effect. -/
def Recorded.ofJson (json : Json) : Recorded :=
  { fn := (json.getObjValAs? String "fn").toOption.getD ""
    args := (json.getObjVal? "args").toOption.getD Json.null
    outcome := Outcome.ofJson ((json.getObjVal? "outcome").toOption.getD Json.null)
    block := (json.getObjValAs? Nat "block").toOption.getD 0
    blockSize := (json.getObjValAs? Nat "blockSize").toOption.getD 1 }

private def diverged (at_ : Nat) (reason : String) (wanted : Json) : Json :=
  Json.mkObj [("diverged", Json.mkObj
    [("at", toJson at_), ("reason", toJson reason), ("wanted", wanted)])]

/-- Removes every `"$fields":...` and `"$keys":...` from compressed JSON. A twin may read them, but they
are not part of what is compared: fields change as an object is used, and key order is only for rendering. -/
private def stripFields (text : String) : String :=
  let markers := ["\"$fields\":".toList, "\"$keys\":".toList, "\"$class\":".toList]
  let rec dropValue (fuel depth : Nat) (rest : List Char) (inString escaped : Bool) : List Char :=
    match fuel, rest with
    | 0, _ => rest
    | _, [] => []
    | fuel + 1, c :: tail =>
      if inString then
        if escaped then dropValue fuel depth tail true false
        else if c == '\\' then dropValue fuel depth tail true true
        else if c == '"' then
          if depth == 0 then tail else dropValue fuel depth tail false false
        else dropValue fuel depth tail true false
      else if c == '"' then dropValue fuel depth tail true false
      else if c == '{' || c == '[' then dropValue fuel (depth + 1) tail false false
      else if c == '}' || c == ']' then
        if depth == 0 then rest
        else if depth == 1 then tail
        else dropValue fuel (depth - 1) tail false false
      else if c == ',' && depth == 0 then rest
      else dropValue fuel depth tail false false
  let rec go (fuel : Nat) (rest : List Char) (out : List Char) : List Char :=
    match fuel, rest with
    | 0, _ => out.reverse ++ rest
    | _, [] => out.reverse
    | fuel + 1, c :: tail =>
      match markers.find? (fun marker => rest.take marker.length == marker) with
      | some marker =>
        let after := dropValue (rest.length + 1) 0 (rest.drop marker.length) false false
        let afterComma := match after with
          | ',' :: more => more
          | _ => after
        let cleaned := match out, afterComma with
          | ',' :: earlier, '}' :: _ => earlier
          | _, _ => out
        go fuel afterComma cleaned
      | none => go fuel tail (c :: out)
  String.ofList (go (text.length + 1) text.toList [])

private def same (a b : Json) : Bool :=
  stripFields a.compress == stripFields b.compress

private def isRecord (value : Json) : Bool :=
  match value with
  | .obj _ => value.compress != Twin.undefinedJson.compress
  | _ => false

private def recordFields (value : Json) : Json :=
  match value.getObjVal? "$fields" with
  | .ok fields@(.obj _) => fields
  | _ => value

/-- The leaves a write changed, as the recording lists them: two records compare key by key, anything
else is one leaf, `undefined` reads as a deleted key, and a handed value is that effect's. -/
private def changedLeaves : Nat → String → Json → Json → List (String × Json)
  | 0, path, _, after => [(path, after)]
  | fuel + 1, path, before, after =>
    if same before after || (after.getObjVal? "$handed").toOption == some (toJson true) then []
    else if isRecord before && isRecord after then
      let was := recordFields before
      let now := recordFields after
      let keysOf (record : Json) : List String := match record with
        | .obj kvs => kvs.keys
        | _ => []
      let keys := keysOf was ++ (keysOf now).filter (!(keysOf was).contains ·)
      (keys.filter (fun key => key != "$keys" && key != "$class")).flatMap fun key =>
        changedLeaves fuel s!"{path}.{key}"
          ((was.getObjVal? key).toOption.getD Twin.undefinedJson)
          ((now.getObjVal? key).toOption.getD Twin.undefinedJson)
    else [(path, if after.compress == Twin.undefinedJson.compress then .null else after)]

/-- States a write to `path`, which held `before` at entry. A write that left it as it was states
nothing, and an object written over an object states each leaf that differs. -/
def Prog.setChanged (path : String) (before after : Json) : Prog Unit :=
  (changedLeaves 32 path before after).foldr
    (fun (leaf, value) rest => .state leaf value rest) (.done ())

private def callJson (fn : String) (args : Json) : Json :=
  Json.mkObj [("fn", toJson fn), ("args", args)]

private def agrees (fn : String) (args : Json) (recorded : Recorded) : Bool :=
  fn == recorded.fn && same args recorded.args

/-- Removes the first recorded effect equal in identity and arguments. -/
private def removeFirst (fn : String) (args : Json) : List Recorded → List Recorded
  | [] => []
  | head :: rest => if agrees fn args head then rest else head :: removeFirst fn args rest

private def callbackPrefix : String := "$enter:"

/-- Pairs each asked-for effect with an unused recorded one. Effects that overlap have no fixed order,
so only the set of them matters. Gives the outcomes in the order asked. -/
private def matchGroup : List (String × Json) → List Recorded → Option (List Outcome)
  | [], [] => some []
  | [], _ :: _ => none
  | (fn, args) :: wanted, recorded =>
    match recorded.find? (agrees fn args) with
    | none => none
    | some head => (matchGroup wanted (removeFirst fn args recorded)).map (head.outcome :: ·)

/-- Plays a program against a recording. Each effect's identity and arguments are checked before its
outcome is handed over, so a program cannot read an answer to a question it did not ask. A plain `call`
must be alone in its overlap group, and a `par` must be a whole group. -/
def Prog.replay (fuel : Nat) (prog : Prog Json) (recorded : List Recorded) (at_ : Nat := 0)
    (changes : List (String × Json) := []) (checked : Array Json := #[]) : Json :=
  match fuel with
  | 0 => diverged at_ "out of fuel" Json.null
  | fuel + 1 =>
    match prog, recorded with
    | .done value, [] =>
      Json.mkObj [("outcome", Json.mkObj [("returned", value)]), ("stateChecked", .arr checked)]
    | .done _, _ :: _ => diverged at_ "returned with recorded effects left over" Json.null
    | .fail error, rest =>
      match error.getObjVal? "$unsupported", rest with
      | .ok reason, _ => Json.mkObj [("unsupported", reason)]
      | _, [] => Json.mkObj [("outcome", Json.mkObj [("threw", error)]), ("stateChecked", .arr checked)]
      | _, _ :: _ => diverged at_ "threw with recorded effects left over" Json.null
    | .state path value next, rest =>
      match changes.find? (fun change => change.1 == path) with
      | none => diverged at_ s!"recording shows no change to {path}" value
      | some change =>
        if same change.2 value then
          next.replay fuel rest at_ changes (checked.push (toJson path))
        else
          diverged at_ s!"recording shows {path} left holding something else" value
    | .detach fn args _, [] => diverged at_ "started an effect the recording does not have" (callJson fn args)
    | .detach fn args next, head :: rest =>
      if !agrees fn args head then
        diverged at_ s!"recording has {head.fn}" (callJson fn args)
      else
        next.replay fuel rest (at_ + 1) changes checked
    | .input next, [] => (next none).replay fuel [] at_ changes checked
    | .input next, head :: rest =>
      if head.fn.startsWith callbackPrefix then
        match head.outcome with
        | .ok args =>
          (next (some ((head.fn.drop callbackPrefix.length).toString, args))).replay fuel rest (at_ + 1) changes checked
        | _ => diverged at_ "a callback entry with no arguments" Json.null
      else
        (next none).replay fuel (head :: rest) at_ changes checked
    | .call fn args _, [] => diverged at_ "asked for an effect the recording does not have" (callJson fn args)
    | .call fn args next, head :: rest =>
      if !agrees fn args head then
        diverged at_ s!"recording has {head.fn}" (callJson fn args)
      else if head.blockSize != 1 then
        diverged at_ "this effect overlapped others in the recording: use par" (callJson fn args)
      else
        -- A twin that reads the answer through `Prog.effect` fails on `.pending`, so it mismatches.
        -- `Prog.attempt` sees `.pending` and must say what happens when an await never settles.
        (next head.outcome).replay fuel rest (at_ + 1) changes checked
    | .par calls next, recorded =>
      let taken := recorded.take calls.length
      let group := taken.head?.map (·.block)
      if calls.isEmpty then
        (next []).replay fuel recorded at_ changes checked
      else if taken.length != calls.length then
        diverged at_ "asked for more effects than the recording has" Json.null
      else if !taken.all (fun head => some head.block == group && head.blockSize == calls.length) then
        diverged at_ "par is not one whole overlap group in the recording" Json.null
      else if taken.any (fun head => match head.outcome with | .pending => true | _ => false) then
        diverged at_ "the recording never saw one of these effects finish" Json.null
      else
        match matchGroup calls taken with
        | none => diverged at_ "par does not match the recording" Json.null
        | some outcomes =>
          (next outcomes).replay fuel (recorded.drop calls.length) (at_ + calls.length) changes checked

end Spec
