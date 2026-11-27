import Spec.Twin

/-!
The command-line side of twins, shared by the full binary and each subsystem's own.
-/

namespace Spec

/-- Prints each recorded call's model output. Reads one `{"fn": source, "args": [...]}` per line. -/
def runTwins (stdin : IO.FS.Stream) (byName : String → Option Twin) : IO Unit := do
  repeat
    let line ← stdin.getLine
    if line.isEmpty then
      break
    match Lean.Json.parse line with
    | .error message =>
      IO.println (Twin.unsupported s!"bad input: {message}").compress
    | .ok call =>
      let source := (call.getObjValAs? String "fn").toOption.getD ""
      let args := (call.getObjVal? "args").toOption.getD (Lean.Json.arr #[])
      let effects := match (call.getObjVal? "effects").toOption with
        | some (.arr items) => items.toList.map Recorded.ofJson
        | _ => []
      match byName source with
      | some { prog := some prog, .. } =>
        let field (name : String) := (call.getObjVal? name).toOption.getD Lean.Json.null
        let input := Lean.Json.mkObj
          [("args", args), ("self", field "self"), ("params", field "params"),
           ("env", field "env"), ("module", field "module"), ("aborted", field "aborted")]
        let changes : List (String × Lean.Json) := match (call.getObjVal? "state").toOption with
          | some (.arr items) =>
            items.toList.filterMap fun item =>
              match item.getObjValAs? String "path", item.getObjVal? "value" with
              | .ok path, .ok value => some (path, value)
              | _, _ => none
          | _ => []
        IO.println ((prog input).replay ((effects.length + 1) * 64 + 65536) effects 0 changes).compress
      | some twin =>
        if twin.gapCovers args then
          IO.println (Lean.Json.mkObj [("gapCovered", true), ("output", twin.run args)]).compress
        else
          IO.println (twin.run args).compress
      | none => IO.println (Twin.unsupported "no twin").compress

/-- `twins` lists sources and gaps. `twin-run` checks calls from standard input. -/
def twinMain (table : List Twin) (args : List String) : IO UInt32 := do
  match args with
  | ["twins"] =>
    for twin in table do
      IO.println (Lean.Json.mkObj
        [("source", Lean.toJson twin.source), ("gaps", Lean.toJson twin.gaps),
         ("traced", Lean.toJson twin.prog.isSome)]).compress
    return 0
  | ["twin-run"] =>
    runTwins (← IO.getStdin) fun source =>
      (table.find? fun twin => twin.source == source && twin.prog.isSome) <|>
        table.find? fun twin => twin.source == source
    return 0
  | _ =>
    IO.eprintln "usage: <binary> twins | twin-run"
    return 2

end Spec
