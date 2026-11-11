import Spec.Sandbox.Twins.Tools.Js
import Spec.Sandbox.Twins.Tools.Filesystem

/-!
Twins of `apps/core/src/harness/tools/bash.tool.ts`: the `bash` tool's description and input schema,
which are built from the context.
-/

namespace Spec.Sandbox.Tools

open Lean

private def file : String := "bash.tool.ts"

private def throwawayNote : String :=
  "Nothing written there reaches durable storage, so use it for throwaway work"

private def names (workspaces : List Json) : String :=
  String.intercalate ", " (workspaces.map fun workspace => text (field workspace "name"))

private def backgroundSupported (sandbox : Json) : Bool :=
  field sandbox "persistent" == Json.bool true

def backgroundAvailable (context : Json) : Bool :=
  truthy (field context "background") &&
    (contextWorkspaces context).any fun workspace => backgroundSupported (field workspace "sandbox")

def backgroundNote (context : Json) : String :=
  if !backgroundAvailable context then ""
  else "\n- Set background:true for long-running commands in a reserved workspace; the result is delivered back automatically when it finishes, and you can check on it with async_status."

def isReservedStandalone (sandbox : Json) : Bool :=
  field sandbox "persistent" == Json.bool true && (statelessReservationKeyFor sandbox).isSome

def reservedStandaloneNote (sandbox : Json) : String :=
  if !isReservedStandalone sandbox then ""
  else " That sandbox is reserved, so its own filesystem does survive between calls until the reservation ends — but only the workspace outlives it."

def ownSandboxNote (context : Json) : String :=
  let owned := (contextWorkspaces context).filter fun workspace => writesOutsideAllowed workspace context
  if owned.isEmpty then ""
  else s!"\n- Your own reserved sandbox backs {names owned}: the whole filesystem there is yours and survives between calls, so writing outside the workspace directory is allowed. It still dies with the reservation — keep anything that must outlive it in the workspace directory."

def reservedNote (context : Json) : String :=
  let borrowed := (contextWorkspaces context).filter fun workspace =>
    fieldAt workspace ["sandbox", "persistent"] == Json.bool true && !isAgentOwnSandbox workspace context
  if borrowed.isEmpty then ""
  else s!"\n- {names borrowed} run on a reserved (persistent) sandbox: packages installed under $HOME (e.g. a uv/venv or npm prefix) survive across calls until the reservation ends. It is an execution layer you borrow, so writes outside the workspace directory are still rejected — keep results in the workspace."

/-- `S3_MOUNT_SANDBOX_PROVIDERS`, convex/model/sandboxProviders.ts:39. -/
private def s3MountProviders : List String := ["daytona", "lambda", "sandbox", "vercel"]

def s3MountNote (context : Json) : String :=
  let mounted := (contextWorkspaces context).any fun workspace =>
    match fieldAt workspace ["sandbox", "provider"] with
    | .str provider => s3MountProviders.contains provider
    | _ => false
  if !mounted then ""
  else "\n- The workspace is an S3 mount with no rename or append: `sed -i`, `mv` and `>>` on its files fail. Use edit/write, or work in /tmp and `cp` back."

/-- `choice === context.sandboxes?.[0]`: only the unsliced list can hold the first entry. -/
private def choicesWithDefault (context : Json) : List (Json × Bool) :=
  let standalone := hasStandaloneSandbox context
  (sandboxParamChoices context).zipIdx.map fun (choice, index) =>
    (choice, standalone && index == 0)

def sandboxesNote (context : Json) : String :=
  let choices := choicesWithDefault context
  if choices.isEmpty then ""
  else
    let hasWorkspaces := !(contextWorkspaces context).isEmpty
    let lines := choices.map fun (choice, isDefault) =>
      let label :=
        match field choice "description" with
        | .null => if isDefault then "your own sandbox" else ""
        | other => text other
      let reserved :=
        if isDefault && hasWorkspaces then reservedStandaloneNote (field choice "sandbox") else ""
      let labelled := if label != "" then s!": {label}." else ""
      s!"  - {text (field choice "name")}{labelled}{reserved}"
    s!"\n- sandbox:\"<name>\" runs on that sandbox with no workspace mounted. {throwawayNote}:\n{String.intercalate "\n" lines}"

def sandboxParamSchema (context : Json) : Json :=
  let choices := sandboxParamChoices context
  if choices.isEmpty then Json.null
  else
    let ignoresWorkspace :=
      if (contextWorkspaces context).isEmpty then "" else " When set, `workspace` is ignored."
    Json.mkObj [
      ("type", Json.str "string"),
      ("enum", Json.arr (choices.map fun choice => field choice "name").toArray),
      ("description", Json.str s!"Sandbox to run on, with no workspace mounted. {throwawayNote}.{ignoresWorkspace}")]

private def insertSorted (value : Int) : List Int → List Int
  | [] => [value]
  | head :: rest =>
    if value == head then head :: rest
    else if value < head then value :: head :: rest
    else head :: insertSorted value rest

def timeoutNote (context : Json) : R String := do
  let reachable :=
    ((contextWorkspaces context).map fun workspace => field workspace "sandbox") ++
      (selectableSandboxes context).map fun entry => field entry "sandbox"
  let limits ← (reachable.filter truthy).mapM fun sandbox => sandboxTimeoutSeconds sandbox
  let sorted := limits.foldl (fun kept limit => insertSorted limit kept) []
  if sorted.isEmpty then return ""
  let shown := String.intercalate " or " (sorted.map fun seconds => s!"{seconds}s")
  return s!"\n- Each call is limited to {shown}; past it the call fails."

def writeGuardNote (context : Json) : String :=
  let workspaces := contextWorkspaces context
  let guarded := workspaces.filter fun workspace => !writesOutsideAllowed workspace context
  if guarded.isEmpty then ""
  else
    let scope := if guarded.length == workspaces.length then "Writes" else s!"In {names guarded}, writes"
    s!" {scope} to an absolute path elsewhere are rejected, except /tmp and /var/tmp, which are available for genuine scratch and are discarded when the sandbox stops."

def description (context : Json) : R String := do
  let timeout ← timeoutNote context
  if (contextWorkspaces context).isEmpty then
    let sandbox := fieldAt (defaultSandbox context) ["sandbox"]
    let reserved := isReservedStandalone sandbox
    let kind := if reserved then "a reserved" else "an ephemeral"
    let state :=
      if reserved then
        "The sandbox is reserved: files persist across calls until the reservation ends, but nothing reaches durable storage. Shell state (working directory, environment variables, background processes) resets every call, so chain dependent steps with && or ;."
      else
        "The sandbox is stateless: each call runs in a fresh container with no persistent storage. Files do NOT persist across calls, and shell state (working directory, environment variables, background processes) resets every call — keep the whole task in a single command, chaining steps with && or ;."
    return s!"Executes a bash command in {kind} Linux sandbox (bash, python3, and node on PATH).\n\nUsage notes:\n- {runtimeDescription sandbox}\n- Use proper quoting for paths or arguments containing spaces (e.g. cd \"path with spaces\").\n- Run programs directly, e.g. `python3 script.py` or `node app.js`. stdout and stderr are returned together, followed by `[exit code N]` when the command fails; very large output is truncated.{timeout}\n- {state}{sandboxesNote context}"
  return s!"Executes a bash command on the attached workspace in a Linux sandbox (bash, python3, and node on PATH).\n\nUsage notes:\n- The selected workspace's sandbox may restrict runtimes; commands using disallowed runtimes are rejected before execution.\n- Use proper quoting for paths or arguments containing spaces (e.g. cd \"path with spaces\").\n- IMPORTANT: prefer the dedicated `read`, `write`, `edit`, `glob`, and `grep` tools over their bash equivalents (cat/sed/find/grep) — they are faster, safer, and return structured results.\n- Run programs directly, e.g. `python3 script.py` or `node app.js`. stdout and stderr are returned together, followed by `[exit code N]` when the command fails; very large output is truncated.{timeout}\n- Each command starts in the current workspace directory; use relative paths.{s3MountNote context}\n- DURABILITY: the workspace directory is the only storage that outlives the sandbox. Anything the task should keep — results, generated code, reports — must be written to a workspace-relative path.{writeGuardNote context}\n- Reading outside the workspace is fine: the sandbox is a whole Linux machine, so inspecting system files, installed packages, or /proc needs no special handling.\n- Files you write to the workspace persist across calls, but shell state does not: the working directory, environment variables, and background processes reset every call — chain dependent steps with && in a single command.{reservedNote context}{ownSandboxNote context}{sandboxesNote context}{backgroundNote context}"

private def describedProp (kind description : String) : Json :=
  Json.mkObj [("type", Json.str kind), ("description", Json.str description)]

def inputSchema (context : Json) : Json :=
  let workspaceProp := workspaceParamSchema (contextWorkspaces context)
  let sandboxProp := sandboxParamSchema context
  Json.mkObj [
    ("type", Json.str "object"),
    ("properties", object ([
      ("command", describedProp "string" "The bash command to run."),
      ("workspace", workspaceProp),
      ("sandbox", sandboxProp),
      ("pty", describedProp "boolean" "Run the command attached to a real interactive TTY (pseudo-terminal). Use when a program refuses to run or degrades without a terminal (isatty checks, TTY-only prompts, terminal UIs). Note: stderr merges into stdout and lines end with CRLF.")] ++
      if backgroundAvailable context then
        [("background", describedProp "boolean" "Run the command as a detached background job in the reserved sandbox and return immediately with a statusId. Use for long-running tasks in the background. The result is delivered back into the conversation automatically when the job finishes; you can also check progress meanwhile with async_status.")]
      else [])),
    ("required", strs ["command"]),
    ("additionalProperties", Json.bool false)]

/-- The checks before `dispatchBackground` starts a job. The job itself is a storage write and a
sandbox launch with random ids, neither of which the arguments hold. -/
def dispatchBackground (context workspace : Json) : R Json := do
  if field (field workspace "sandbox") "persistent" != Json.bool true then
    jsThrow "Error: background jobs require a persistent workspace sandbox"
  if !truthy (field context "background") then
    jsThrow "Error: background jobs are not available in this context"
  noModel "starting a job uses storage, a sandbox and random ids"

def bashTwins : List Spec.Twin := [
  tool file "backgroundAvailable" fun a => pure (Json.bool (backgroundAvailable (arg a 0))),
  tool file "backgroundNote" fun a => pure (Json.str (backgroundNote (arg a 0))),
  tool file "description" fun a => do return Json.str (← description (arg a 0)),
  tool file "dispatchBackground" fun a => dispatchBackground (arg a 0) (arg a 1),
  tool file "inputSchema" fun a => pure (inputSchema (arg a 0)),
  tool file "isReservedStandalone" fun a => pure (Json.bool (isReservedStandalone (arg a 0))),
  tool file "ownSandboxNote" fun a => pure (Json.str (ownSandboxNote (arg a 0))),
  tool file "ptyCommand" (fun a =>
    match arg a 0 with
    | .str command => pure (Json.str s!"script -qec {shellQuote command} /dev/null")
    | _ => noModel "command is not a string"),
  tool file "reservedNote" fun a => pure (Json.str (reservedNote (arg a 0))),
  tool file "reservedStandaloneNote" fun a => pure (Json.str (reservedStandaloneNote (arg a 0))),
  tool file "s3MountNote" fun a => pure (Json.str (s3MountNote (arg a 0))),
  tool file "sandboxesNote" fun a => pure (Json.str (sandboxesNote (arg a 0))),
  tool file "sandboxParamSchema" fun a => pure (sandboxParamSchema (arg a 0)),
  tool file "timeoutNote" fun a => do return Json.str (← timeoutNote (arg a 0)),
  tool file "writeGuardNote" fun a => pure (Json.str (writeGuardNote (arg a 0)))]

end Spec.Sandbox.Tools
