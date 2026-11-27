import Spec.Twin
import Spec.Config.Twins.Js

/-!
The part of zod's parser the config schemas use, reduced to its first issue, since `parseInput` reports
only that. Fields run in shape order and a type failure stops the value. Object keys in a recorded call
arrive sorted, so when two keys of one value fail, which is first is out of reach and the parse is
`unknown`.
-/

namespace Spec.Zod

open Lean Spec.Js

/-- A step in an issue's path. -/
inductive Seg where
  | key (name : String)
  | index (position : Nat)
  deriving BEq, Inhabited

/-- The first issue of a parse. `code` is what `issueSentence` branches on. -/
structure Issue where
  code : String
  path : List Seg
  message : String
  deriving Inhabited

/-- A parse's result, with `none` for undefined. -/
inductive Parsed where
  | ok (value : Option Json)
  | bad (issue : Issue)
  | unknown (reason : String)
  deriving Inhabited

/-- A schema: `custom` holds a rule that needs its own code. -/
inductive Schema where
  | unknown
  | string (error : Option String)
  | bool
  | number (error : Option String)
  | enum (values : List String) (error : Option String)
  | optional (inner : Schema)
  | nullish (inner : Schema)
  | nullable (inner : Schema)
  | object (strict : Bool) (shape : List (String × Schema)) (error : Option String)
  | array (inner : Schema)
  | record (key value : Schema) (typeError : Option String)
  | union (options : List Schema) (error : Option String)
  | discriminated (tag : String) (options : List (String × Schema)) (error : String)
  | whole (inner : Schema) (error : String)
  | check (inner : Schema) (rule : Json → Parsed)
  | transform (inner : Schema) (apply : Json → Json)
  | custom (run : Option Json → Parsed)
  deriving Inhabited

/-- An issue with no path. -/
def customIssue (message : String) : Issue :=
  { code := "custom", path := [], message := message }

/-- A failed check at `path`. -/
def fail (path : List Seg) (message : String) : Parsed :=
  .bad { code := "custom", path := path, message := message }

/-- `defaultMessage` for `invalid_type`. -/
def typeMessage (expected : String) : String :=
  match expected with
  | "object" | "record" => "must be an object"
  | "array" => "must be an array"
  | "int" => "must be an integer"
  | other => s!"must be a {other}"

def invalidType (expected : String) (error : Option String) : Parsed :=
  .bad { code := "invalid_type", path := [], message := error.getD (typeMessage expected) }

def invalidValue (values : List String) (error : Option String) : Parsed :=
  .bad { code := "invalid_value", path := [],
         message := error.getD s!"must be one of: {", ".intercalate values}" }

/-- Prefixes an issue with the key it was found under. -/
def underSeg (seg : Seg) : Parsed → Parsed
  | .bad issue => .bad { issue with path := seg :: issue.path }
  | other => other

/-- The first branch whose first issue is not a root type failure, as `issueSentence` picks it. -/
def unionIssue (issues : List Issue) (error : Option String) : Issue :=
  let matched := issues.find? fun issue => !(issue.code == "invalid_type" && issue.path.isEmpty)
  match matched with
  | some issue => { issue with code := "invalid_union" }
  | none => { code := "invalid_union", path := [], message := error.getD "is invalid" }

/-- Runs the schema on `input`, with `fuel` bounding the schema's depth. -/
def run : Nat → Schema → Option Json → Parsed
  | 0, _, _ => .unknown "schema too deep"
  | fuel + 1, schema, input =>
    match schema with
    | .unknown => .ok input
    | .string error =>
      match input with
      | some (.str s) => .ok (some (.str s))
      | _ => invalidType "string" error
    | .bool =>
      match input with
      | some (.bool b) => .ok (some (.bool b))
      | _ => invalidType "boolean" none
    | .number error =>
      match input with
      | some (.num n) => .ok (some (.num n))
      | _ => invalidType "number" error
    | .enum values error =>
      match input with
      | some (.str s) =>
        if values.contains s then .ok (some (.str s)) else invalidValue values error
      | _ => invalidValue values error
    | .optional inner =>
      match input with
      | none => .ok none
      | some _ => run fuel inner input
    | .nullish inner =>
      match input with
      | none => .ok none
      | some .null => .ok (some .null)
      | some _ => run fuel inner input
    | .nullable inner =>
      match input with
      | some .null => .ok (some .null)
      | _ => run fuel inner input
    | .object strict shape error =>
      match input with
      | some (.obj kvs) =>
        let value : Json := .obj kvs
        let rec fields : List (String × Schema) → Json → Parsed
          | [], acc => .ok (some acc)
          | (key, inner) :: rest, acc =>
            match run fuel inner (field? value key) with
            | .ok (some next) => fields rest (set acc key next)
            | .ok none => fields rest (del acc key)
            | other => underSeg (.key key) other
        match fields shape value with
        | .ok (some output) =>
          let unknownKeys := (entries value).map Prod.fst |>.filter fun key =>
            !(shape.any fun field => field.1 == key)
          if strict then
            match unknownKeys with
            | [] => .ok (some output)
            | [key] => .bad { code := "unrecognized_keys", path := [],
                              message := s!"has unknown option \"{key}\"" }
            | _ => .unknown "two unknown keys: the first is not visible"
          else .ok (some (del output "__proto__"))
        | other => other
      | _ => invalidType "object" error
    | .array inner =>
      match input with
      | some (.arr items) =>
        let rec elements : List (Json × Nat) → List Json → Parsed
          | [], acc => .ok (some (.arr acc.reverse.toArray))
          | (item, index) :: rest, acc =>
            match run fuel inner (some item) with
            | .ok next => elements rest (next.getD .null :: acc)
            | other => underSeg (.index index) other
        elements items.toList.zipIdx []
      | _ => invalidType "array" none
    | .record key valueSchema typeError =>
      match input with
      | some (.obj kvs) =>
        let results := (kvs.toList.filter (·.1 != "__proto__")).map fun (name, item) =>
          let keyResult := run fuel key (some (.str name))
          match keyResult with
          | .bad issue =>
            (name, Parsed.bad { code := "invalid_key", path := [.key name], message := issue.message })
          | .unknown reason => (name, Parsed.unknown reason)
          | .ok _ => (name, underSeg (.key name) (run fuel valueSchema (some item)))
        let failed := results.filter fun (_, result) =>
          match result with
          | .ok _ => false
          | _ => true
        match failed with
        | [] =>
          .ok (some (Json.mkObj (results.filterMap fun (name, result) =>
            match result with
            | .ok (some item) => some (name, item)
            | _ => none)))
        | [(_, result)] => result
        | _ => .unknown "two keys fail: the first is not visible"
      | _ => invalidType "record" typeError
    | .union options error =>
      let results := options.map fun option => run fuel option input
      match results.find? (fun result => match result with | .ok _ => true | _ => false) with
      | some success => success
      | none =>
        if results.any (fun result => match result with | .unknown _ => true | _ => false) then
          .unknown "union branch depends on key order"
        else
          .bad (unionIssue (results.filterMap fun result =>
            match result with
            | .bad issue => some issue
            | _ => none) error)
    | .discriminated tag options error =>
      match input with
      | some (.obj _) =>
        let value := (input.bind (field? · tag)).bind str?
        match value.bind (fun name => (options.find? (·.1 == name))) with
        | some (_, option) => run fuel option input
        | none =>
          .bad { code := "invalid_union", path := [.key tag], message := error }
      | _ => invalidType "object" none
    | .whole inner error =>
      match run fuel inner input with
      | .ok output => .ok output
      | _ => .bad (customIssue error)
    | .check inner rule =>
      match run fuel inner input with
      | .ok (some output) =>
        match rule output with
        | .ok _ => .ok (some output)
        | other => other
      | other => other
    | .transform inner apply =>
      match run fuel inner input with
      | .ok (some output) => .ok (some (apply output))
      | other => other
    | .custom custom => custom input

/-- `parseInput`'s `renderPath`. -/
def renderPath (root : String) (path : List Seg) : String :=
  path.foldl (fun rendered seg =>
    match seg with
    | .index position => s!"{rendered}[{position}]"
    | .key name =>
      if !rendered.isEmpty && !rendered.endsWith " " then s!"{rendered}.{name}" else rendered ++ name) root

/-- `issueSentence`: the path, then the message with `{parent}` filled in. -/
def sentence (issue : Issue) (root : String) : String :=
  let message := issue.message.replace "{parent}" (renderPath root issue.path.dropLast)
  trim s!"{trimEnd (renderPath root issue.path)} {message}"

/-- A twin's answer: a JSON result, the thrown sentence, or a call out of reach. -/
inductive Out where
  | ok (value : Json)
  | threw (message : String)
  | unknown (reason : String)
  deriving Inhabited

namespace Out

/-- Sequencing: the first throw or unknown wins, as a throw leaves the function. -/
def bind (out : Out) (next : Json → Out) : Out :=
  match out with
  | .ok value => next value
  | other => other

/-- The checks that return nothing: `some message` throws. -/
def unless_ (problem : Option String) (next : Unit → Out) : Out :=
  match problem with
  | some message => .threw message
  | none => next ()

/-- The twin output for this result. -/
def json : Out → Json
  | .ok value => value
  | .threw message => Spec.Twin.threw message
  | .unknown reason => Spec.Twin.unsupported reason

end Out

/-- `parseInput(schema, value, root)`, with undefined output as null. -/
def parseInput (schema : Schema) (value : Option Json) (root : String) : Out :=
  match run 64 schema value with
  | .ok output => .ok (output.getD .null)
  | .bad issue => .threw (sentence issue root)
  | .unknown reason => .unknown reason

/-- `parseInput` of a record of unknown values. -/
def configObject : Schema :=
  .record (.string none) .unknown none

/-- `nonEmptyString`. -/
def nonEmptyString : Schema :=
  .check (.string (some "must be a non-empty string")) fun value =>
    match value with
    | .str s => if (trim s).isEmpty then fail [] "must be a non-empty string" else .ok (some value)
    | _ => .ok (some value)

/-- `nonEmptyStrings`. -/
def nonEmptyStrings : Schema :=
  .whole (.array nonEmptyString) "must be an array of non-empty strings"

/-- `positiveInteger(max)`. -/
def positiveInteger (max : Int) : Schema :=
  let error := s!"must be an integer from 1 to {max}"
  .check (.number (some error)) fun value =>
    match safeInt? value with
    | some n => if 1 ≤ n && n ≤ max then .ok (some value) else fail [] error
    | none => fail [] error

/-- `stringRecord(error)`. -/
def stringRecord (error : String) : Schema :=
  .whole (.record (.string none) (.string none) none) error

/-- `refusingProtoKey`: an own `__proto__` key is refused by name. -/
def refusingProtoKey (schema : Schema) (error : String) : Schema :=
  .custom fun input =>
    if (input.bind (field? · "__proto__")).isSome then fail [.key "__proto__"] error
    else run 64 schema input

/-- A string that must match `matches`, with `error` as the regex's message. -/
def patternString (matches_ : String → Bool) (error : String) : Schema :=
  .check (.string none) fun value =>
    match value with
    | .str s => if matches_ s then .ok (some value) else fail [] error
    | _ => .ok (some value)

/-- `parseOr(schema, value)`. -/
def parseOr (schema : Schema) (value : Option Json) : Option (Option Json) :=
  match run 64 schema value with
  | .ok output => some output
  | _ => none

end Spec.Zod
