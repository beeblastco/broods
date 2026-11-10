import Spec.Twin

/-!
Twins of closures in the sandbox subsystem that run after the function that made them returned,
mostly the `execute` of each tool under `apps/core/src/harness/tools/`.
-/

namespace Spec.Sandbox.Closures

open Lean Spec

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool := value.compress == undef.compress

/-- A property of a plain object; `undefined` when it is missing. -/
private def get (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def truthy (value : Json) : Bool :=
  match value with
  | .null | .bool false => false
  | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def isTrue (value : Json) : Bool := value.compress == (toJson true).compress

/-- Template-literal rendering of a string or `undefined`. -/
private def render (value : Json) : String :=
  match value with
  | .str text => text
  | other => if isUndef other then "undefined" else other.compress

/-- The `message` of a thrown `Error`, or `String(cause)` for anything else. -/
private def causeMessage (cause : Json) : String :=
  match (cause.getObjVal? "$error").toOption with
  | some inner => render (get inner "message")
  | none => render cause

/-- An object literal with the `undefined` properties dropped, as the recorder shows it. -/
private def literal (fields : List (String × Json)) : Json :=
  Json.mkObj (fields.filter fun (_, value) => !isUndef value)

/-- `toolError(message)`: always throws. -/
private def toolError (message : String) : Prog Json :=
  Prog.effect "toolError" [toJson message]

/-- `try { body } catch (cause) { return toolError(cause.message) }`. -/
private def catchToolError (body : Prog Json) : Prog Json :=
  Prog.catchFail body fun cause => toolError (causeMessage cause)


/-- `catch (cause) { throw cause instanceof Error ? cause : new Error(String(cause)) }`. -/
private def rethrowAsError (body : Prog Json) : Prog Json :=
  Prog.catchFail body fun cause =>
    match (cause.getObjVal? "$error").toOption with
    | some _ => Prog.fail cause
    | none => Prog.throwError "Error" (render cause)

/-- `.replace(/\s+/g, " ").trim()`: the words of a string joined by single spaces. -/
private def collapseSpaces (text : String) : String :=
  " ".intercalate ((text.splitToList Char.isWhitespace).filter fun word => word != "")

/-- A string property, or `""` when it is missing, as in `(value ?? "")`. -/
private def textOr (value : Json) : String :=
  match value with
  | .str text => text
  | _ => ""

/-- `String.prototype.trim`. -/
private def trimText (text : String) : String := text.trimAscii.toString

/-- `JSON.stringify` of a string. -/
private def quoteJson (text : String) : String := (toJson text).compress

/-- `` `${r.stderr}${r.stdout}`.trim() || fallback ``, the text of a failed run. -/
private def failureText (result : Json) (fallback : String) : String :=
  let output := trimText (textOr (get result "stderr") ++ textOr (get result "stdout"))
  if output == "" then fallback else output

/-- `runSandbox` with the metadata `sandboxRunMetadata` gives for this workspace. -/
private def runWithMetadata (runner : Json) (context ws : Json) (code : String) : Prog Json := do
  let metadata ← Prog.effect "sandboxRunMetadata" [context, ws]
  Prog.effect "runSandbox"
    [runner, get ws "namespace", toJson code, literal [("metadata", metadata)]]

private def pad (width : Nat) (n : Int) : String :=
  let digits := toString n.toNat
  String.ofList (List.replicate (width - digits.length) '0') ++ digits

/-- `new Date(ms).toISOString()`, by the days-to-civil algorithm. -/
private def isoFromMillis (ms : Int) : String :=
  let day := ms / 86400000
  let rest := ms - day * 86400000
  let z := day + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let d := doy - (153 * mp + 2) / 5 + 1
  let m := if mp < 10 then mp + 3 else mp - 9
  let y := yoe + era * 400 + (if m <= 2 then 1 else 0)
  s!"{pad 4 y}-{pad 2 m}-{pad 2 d}T{pad 2 (rest / 3600000)}:{pad 2 (rest / 60000 % 60)}:{pad 2 (rest / 1000 % 60)}.{pad 3 (rest % 1000)}Z"

/-- `a ?? b`. -/
private def orElse (value fallback : Json) : Json :=
  if isUndef value || value == Json.null then fallback else value

/-- A callback the context may not carry: `context.name?.(...)`. -/
private def callIfPresent (context : Json) (name : String) (args : List Json) : Prog Unit := do
  if truthy (get context name) then
    let _ ← Prog.effect s!"context.{name}" args

/-! ## bash.tool.ts -/

/-- `bashTool/execute`: picks the sandbox, guards the command, then runs or dispatches it. -/
private def bashExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let options := Twin.callArg call 1
  let workspace := get input "workspace"
  let onSandbox := get input "sandbox"
  let trimmed := match get input "command" with
    | .str text => trimText text
    | _ => ""
  if trimmed == "" then
    return ← toolError "Error: command is required"
  catchToolError (do
    let selected ← Prog.effect "bashSandboxTarget" [onSandbox]
    if !isUndef onSandbox && isUndef selected then
      return ← toolError "Error: sandbox must be the name of a sandbox"
    let picked ← Prog.effect "resolveAgentSandbox" [context, selected]
    let onAgent ← Prog.effect "targetsAgentSandbox"
      [context, literal [("workspace", workspace), ("sandbox", selected)]]
    let ws ← if isTrue onAgent then pure undef
      else Prog.effect "resolveWorkspace" [get context "workspaces", workspace]
    let ignored :=
      if isTrue onAgent && !isUndef workspace then
        s!"Note: ran on sandbox {render (get picked "name")} with no workspace mounted; workspace {render workspace} was ignored. Omit sandbox to run in a workspace.\n"
      else ""
    let sandbox := if truthy ws then get ws "sandbox" else get picked "sandbox"
    if !truthy sandbox then
      return ← toolError "Error: no sandbox available for this command"
    let outside ← if truthy ws then do
        let allowed ← Prog.effect "writesOutsideAllowed" [ws, context]
        Prog.effect "outsideWorkspaceCommand"
          [toJson trimmed, Json.mkObj [("persistentOwnSandbox", allowed)]]
      else pure undef
    if truthy outside then
      return ← toolError (render outside)
    let disallowed ← Prog.effect "disallowedRuntimeCommand" [sandbox, toJson trimmed]
    if truthy disallowed then
      return ← toolError (render disallowed)
    let effective ← if isTrue (get input "pty") then
        Prog.effect "ptyCommand" [toJson trimmed]
      else pure (toJson trimmed)
    if isTrue (get input "background") then
      return ← Prog.effect "dispatchBackground"
        [context, ws, effective, get options "toolCallId"]
    let metadata ← Prog.effect "sandboxRunMetadata" [context, ws]
    let principal ← if truthy (get context "principal") then
        Prog.effect "context.principal" []
      else pure undef
    let ns := if truthy ws then get ws "namespace" else undef
    let ran ← Prog.effect "runSandbox"
      [sandbox, ns, effective,
       literal [("onSandboxCpu", get context "onSandboxCpu"), ("metadata", metadata),
         ("principal", principal)]]
    let seconds ← Prog.effect "sandboxTimeoutSeconds" [sandbox]
    let text ← Prog.effect "formatRunText" [ran, seconds]
    pure (toJson (ignored ++ render text)))


/-! ## memory.tool.ts -/

/-- `memoryTool/execute`: writes one memory file and rebuilds the index line in one shell command. -/
private def memoryExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  rethrowAsError (do
    let ws ← Prog.effect "resolveWorkspace" [get context "workspaces", get input "workspace"]
    let sandbox := get ws "sandbox"
    if !truthy sandbox then
      return ← toolError "Error: workspace is read-only"
    let enabled ← Prog.effect "workspaceMemoryHarnessEnabled" [get ws "config"]
    if !truthy enabled then
      return ← toolError s!"Error: the memory harness is disabled for workspace {render (get ws "name")}"
    let cleanTitle := collapseSpaces
      (String.map (fun c => if c == '[' || c == ']' then ' ' else c) (textOr (get input "title")))
    let cleanDescription := collapseSpaces (textOr (get input "description"))
    if cleanTitle == "" then
      return ← toolError "Error: title must not be empty"
    if cleanDescription == "" then
      return ← toolError "Error: description must not be empty"
    let memoryType :=
      match get input "type" with
      | .str kind => if ["user", "feedback", "project", "reference"].contains kind then kind else "project"
      | _ => "project"
    let origin ← Prog.effect "channelScopeKeyFromConversation" [get context "conversationKey"]
    let slug ← Prog.effect "memorySlug" [toJson cleanTitle]
    let filePath := s!"memory/{render slug}.md"
    let entry := "\n".intercalate
      ["---", s!"name: {render slug}", s!"description: {quoteJson cleanDescription}", "metadata:",
       "  node_type: memory", s!"  type: {memoryType}", s!"  originSessionId: {render origin}", "---",
       "", textOr (get input "content"), ""]
    let indexLine := s!"- [{cleanTitle}]({render slug}.md) — {cleanDescription}"
    let qFile ← Prog.effect "shellQuote" [toJson filePath]
    let qIndex ← Prog.effect "shellQuote" [toJson "memory/MEMORY.md"]
    let qDir ← Prog.effect "shellQuote" [toJson "memory"]
    let encoded ← Prog.effect "toBase64" [toJson entry]
    let qEntry ← Prog.effect "shellQuote" [encoded]
    let qPattern ← Prog.effect "shellQuote" [toJson s!"^- \\[[^]]*]({render slug}\\.md) — "]
    let qHeader ← Prog.effect "shellQuote" [toJson "# Memory Index"]
    let qLine ← Prog.effect "shellQuote" [toJson indexLine]
    let code :=
      s!"mkdir -p {render qDir} && printf '%s' {render qEntry} | base64 -d > {render qFile} && sync {render qFile} && " ++
      s!"index_body=$(\{ [ -f {render qIndex} ] && grep -v {render qPattern} {render qIndex}; } || printf '%s' {render qHeader}) && " ++
      s!"printf '%s\\n%s\\n' \"$index_body\" {render qLine} > {render qIndex} && " ++
      s!"sync {render qIndex} && printf 'Saved memory %s (indexed in %s)\\n' {render qFile} {render qIndex}"
    let metadata ← Prog.effect "sandboxRunMetadata" [context, ws]
    let result ← Prog.effect "runSandbox"
      [sandbox, get ws "namespace", toJson code,
       literal [("onSandboxCpu", get context "onSandboxCpu"), ("metadata", metadata)]]
    if !truthy (get result "ok") then
      let output := trimText (textOr (get result "stderr") ++ textOr (get result "stdout"))
      return ← toolError (if output == "" then "Error: memory save failed" else output)
    pure (toJson (trimText (textOr (get result "stdout")))))

/-! ## schedule.tool.ts -/

/-- `getStorage().crons.getById(...).catch(() => null)`, after the account and agent fence. -/
private def ownedCron (context cronId : Json) : Prog Json := do
  let _ ← Prog.effect "getStorage" []
  let found ← Prog.attempt "getStorage() .crons.getById" [get context "accountId", cronId]
  let existing := match found with
    | .ok value => value
    | _ => Json.null
  if !truthy existing || get existing "agentId" != get context "agentId" then
    return ← toolError s!"No scheduled task {render cronId} belongs to this agent"
  return existing

/-- `${updated.timezone ? ` in ${tz}` : " in UTC"}`. -/
private def zoneSuffix (cron : Json) : String :=
  if truthy (get cron "timezone") then s!" in {render (get cron "timezone")}" else " in UTC"

/-- `cancelScheduleTool/execute`. -/
private def cancelScheduleExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let cronId := get (Twin.callArg call 0) "cronId"
  let existing ← ownedCron context cronId
  let _ ← Prog.effect "getStorage" []
  let _ ← Prog.effect "getStorage().crons.remove" [get context "accountId", cronId]
  pure (toJson s!"Cancelled scheduled task '{render (get existing "name")}' ({render cronId}).")

/-- `ScheduleSummary`: the optional fields appear when truthy. -/
private def scheduleSummary (cron : Json) : Json :=
  let optional (key source : String) : List (String × Json) :=
    if truthy (get cron source) then [(key, get cron source)] else []
  Json.mkObj
    ([("cronId", get cron "cronId"), ("name", get cron "name"),
      ("schedule", get cron "scheduleExpression"), ("status", get cron "status")] ++
      optional "timezone" "timezone" ++ optional "conversationKey" "conversationKey" ++
      optional "lastStatus" "lastStatus" ++ optional "lastInvokedAt" "lastInvokedAt")

/-- `listSchedulesTool/execute`. -/
private def listSchedulesExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let _ ← Prog.effect "getStorage" []
  let crons ← Prog.effect "getStorage().crons.list" [get context "accountId", get context "agentId"]
  let rows := match crons with
    | .arr items => items.toList
    | _ => []
  return Json.mkObj [("schedules", .arr (rows.map scheduleSummary).toArray)]

/-- `scheduleTool/execute`. -/
private def scheduleExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let _ ← Prog.effect "getStorage" []
  let created ← Prog.effect "getStorage().crons.create"
    [get context "accountId",
     Json.mkObj
       ([("name", get input "name"), ("agentId", get context "agentId"),
         ("input", get input "instructions"), ("conversationKey", get context "conversationKey"),
         ("scheduleExpression", get input "schedule")] ++
        if truthy (get input "timezone") then [("timezone", get input "timezone")] else [])]
  pure (toJson s!"Scheduled task '{render (get created "name")}' ({render (get created "cronId")}) on {render (get created "scheduleExpression")}{zoneSuffix created}. It runs in this conversation.")

/-- `updateScheduleTool/execute`: only the fields passed go into the patch. -/
private def updateScheduleExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let cronId := get input "cronId"
  let present (key target : String) : List (String × Json) :=
    if isUndef (get input key) then [] else [(target, get input key)]
  let patch := Json.mkObj
    (present "name" "name" ++ present "instructions" "input" ++
      present "schedule" "scheduleExpression" ++ present "timezone" "timezone" ++
      present "status" "status")
  if patch == Json.mkObj [] then
    return ← toolError "Pass at least one of name, instructions, schedule, timezone or status to change"
  let _ ← catchToolError (Prog.effect "normalizeUpdateCronInput" [patch])
  let existing ← ownedCron context cronId
  if !isUndef (get input "instructions") &&
      get existing "conversationKey" != get context "conversationKey" then
    return ← toolError s!"Scheduled task {render cronId} answers in another conversation, so its instructions can only be rewritten there. Its name, schedule, timezone and status can be changed from here."
  let _ ← Prog.effect "getStorage" []
  let updated ← Prog.effect "getStorage().crons.update" [get context "accountId", cronId, patch]
  if !truthy updated then
    return ← toolError s!"Scheduled task {render cronId} no longer exists"
  pure (toJson s!"Updated scheduled task '{render (get updated "name")}' ({render (get updated "cronId")}): {render (get updated "scheduleExpression")}{zoneSuffix updated}, {render (get updated "status")}.")

/-! ## glob.tool.ts -/

/-- `globTool/execute`: lists files through the sandbox, filtering in core on a shell-only one. -/
private def globExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let pattern := get input "pattern"
  rethrowAsError (do
    match pattern with
    | .str text =>
      if trimText text == "" then
        return ← toolError "Error: pattern is required"
    | _ => return ← toolError "Error: pattern is required"
    let ws ← Prog.effect "resolveWorkspace" [get context "workspaces", get input "workspace"]
    if !truthy ws then
      return ← toolError "Error: no workspace attached"
    let runner := if truthy (get ws "sandbox") then get ws "sandbox" else get ws "readMount"
    if !truthy runner then
      return ← Prog.effect "s3Glob" [ws, pattern, get input "path"]
    let root ← if truthy (get input "path") then
        Prog.effect "toWorkspaceRelative" [get input "path"]
      else pure (toJson ".")
    if render (get runner "provider") == "worker" then
      let quoted ← Prog.effect "shellQuote" [toJson s!"./{render root}"]
      let listed ← runWithMetadata runner context ws s!"cd {render quoted} && find . -type f"
      if !truthy (get listed "ok") then
        return ← toolError (failureText listed "Error: glob failed")
      let _ ← Prog.effect "new Bun.Glob" [pattern]
      let mut found : Array String := #[]
      for line in (textOr (get listed "stdout")).splitOn "\n" do
        let rel := if line.startsWith "./" then (line.drop 2).toString else line
        if rel.length > 0 then
          let hit ← Prog.effect "matcher.match" [toJson rel]
          if truthy hit then
            found := found.push rel
      let sorted := found.qsort (· < ·)
      let cut := if truthy (get listed "truncated") then
          "(listing cut at the sandbox's output limit; narrow the path)\n"
        else ""
      return ← pure (toJson (if sorted.size > 0 then s!"{"\n".intercalate sorted.toList}\n{cut}"
          else s!"No files found\n{cut}"))
    let patternB64 ← Prog.effect "toBase64" [pattern]
    let rootB64 ← Prog.effect "toBase64" [root]
    let code ← Prog.effect "globScript" [patternB64, rootB64]
    let result ← runWithMetadata runner context ws (render code)
    if !truthy (get result "ok") then
      return ← toolError (failureText result "Error: glob failed")
    pure (get result "stdout"))

/-! ## async-status.tool.ts -/

/-- `handedOver()`: tells the session the model has read this result, when it listens. -/
private def handedOver (context toolCallId statusId : Json) : Prog Unit := do
  if truthy (get context "onResultRead") then
    let _ ← Prog.effect "context.onResultRead" [toolCallId, statusId]

/-- `asyncStatusTool/execute`: reports a stored result, or asks the sandbox about its job. -/
private def asyncStatusExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let toolCallId := get (Twin.callArg call 1) "toolCallId"
  let statusId := get input "statusId"
  let action := if isUndef (get input "action") then toJson "status" else get input "action"
  let record ← Prog.effect "getAsyncToolResult" [statusId]
  if !truthy record || get record "conversationKey" != get context "conversationKey" then
    return ← toolError s!"Error: no async result found for {render statusId}"
  if get record "status" != toJson "processing" then
    handedOver context toolCallId statusId
    return ← Prog.effect "settledResult" [record, action]
  let job ← Prog.effect "sandboxJobRef" [get record "input"]
  if !truthy job then
    return Json.mkObj [("status", toJson "processing"), ("delivery", toJson "automatic")]
  let sandbox ← Prog.effect "sandboxForNamespace" [context, get job "namespace"]
  if !truthy sandbox then
    return ← toolError s!"Error: no sandbox available to inspect job {render (get job "jobId")}"
  let executor ← Prog.effect "createSandboxExecutor" [sandbox]
  let jobArgs := Json.mkObj [("jobId", get job "jobId"), ("namespace", get job "namespace")]
  catchToolError (do
    if action == toJson "logs" then
      if !truthy (get executor "jobLogs") then
        return ← toolError "Error: this sandbox does not support job logs"
      let logs ← Prog.effect "executor.jobLogs"
        [Json.mkObj [("jobId", get job "jobId"), ("namespace", get job "namespace"),
          ("outputLimitBytes", toJson (65536 : Nat))]]
      return (if (textOr (get logs "logs")).length > 0 then get logs "logs"
        else toJson "(no output yet)")
    if action == toJson "stop" then
      if !truthy (get executor "stopJob") then
        return ← toolError "Error: this sandbox does not support stopping jobs"
      let stopped ← Prog.effect "executor.stopJob" [jobArgs]
      let settled ← Prog.effect "settleTerminalJob" [statusId, executor, job, stopped]
      handedOver context toolCallId statusId
      return settled
    if !truthy (get executor "jobStatus") then
      return Json.mkObj [("status", toJson "processing"), ("jobId", get job "jobId"),
        ("liveStatus", toJson "unsupported"), ("delivery", toJson "automatic")]
    let status ← Prog.effect "executor.jobStatus" [jobArgs]
    if get status "state" == toJson "running" then
      return Json.mkObj [("status", toJson "processing"), ("jobId", get job "jobId")]
    if get status "state" == toJson "unknown" then
      return Json.mkObj [("status", toJson "unknown"), ("jobId", get job "jobId")]
    let settled ← Prog.effect "settleTerminalJob" [statusId, executor, job, status]
    handedOver context toolCallId statusId
    return settled)

/-! ## ask-questions.tool.ts -/

/-- `askQuestionsTool/execute`: stores a pending result, posts the questions, returns its status id. -/
private def askQuestionsExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let toolCallId := get (Twin.callArg call 1) "toolCallId"
  let questions := get input "questions"
  let invalid ← Prog.effect "validateQuestions" [questions]
  if truthy invalid then
    return ← toolError s!"Error: {render invalid}"
  let blocking := isTrue (get input "blocking")
  let uuid ← Prog.effect "crypto.randomUUID" []
  let resultId := toJson s!"async_tool_{render uuid}"
  let now ← Prog.effect "Date.now" []
  let timeout := orElse (get input "timeoutSeconds") (toJson (86400 : Nat))
  let (some seconds, some start) := (timeout.getInt?.toOption, now.getInt?.toOption)
    | Prog.unsupported "a fractional timeout or time"
  let answerBy := toJson (isoFromMillis (start + seconds * 1000))
  let pending := Json.mkObj
    [("questions", questions), ("blocking", toJson blocking), ("answerBy", answerBy)]
  let _ ← Prog.effect "createDetachedAsyncToolResult"
    [Json.mkObj
      [("eventId", get context "eventId"), ("tag", toJson "async-question"),
       ("resultId", resultId), ("conversationKey", get context "conversationKey"),
       ("toolName", toJson "ask_questions"), ("toolCallId", toolCallId), ("input", pending),
       ("delivery", orElse (get context "delivery") (Json.mkObj [("kind", toJson "async")]))]]
  callIfPresent context "onDetachedResult" [resultId]
  if truthy (get context "channel") then
    let failure ← Prog.effect "postToChannel" [get context "channel", resultId, questions]
    if failure != Json.null then
      let _ ← Prog.attempt "markAsyncToolResultFailed"
        [Json.mkObj [("resultId", resultId), ("error", failure)]]
      return ← toolError s!"Error: {render failure}"
  if blocking then
    callIfPresent context "onBlockingQuestion"
      [Json.mkObj [("statusId", resultId), ("questions", questions), ("answerBy", answerBy)]]
  return Json.mkObj [("statusId", resultId), ("blocking", toJson blocking), ("answerBy", answerBy)]

/-! ## message-agents.tool.ts -/

/-- `Math.min(Math.max(Math.round(seconds), 1), 3600)`; `none` when it is not a number. -/
private def clampedWait (value : Json) : Option Json :=
  match value with
  | .num n =>
    let scale : Int := (10 : Int) ^ n.exponent
    let rounded := (2 * n.mantissa + scale) / (2 * scale)
    some (toJson (min (max rounded 1) 3600))
  | _ => none

/-- `messageAgentsTool/execute`: routes a message to the parent, or to a named child. -/
private def messageAgentsExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let text := trimText (textOr (get input "text"))
  if text == "" then
    return ← toolError "Error: message-agents requires a non-empty text"
  let followUp := trimText (textOr (get input "followUp"))
  let exchangeId ←
    if followUp != "" then pure (toJson followUp)
    else do
      let uuid ← Prog.effect "crypto.randomUUID" []
      pure (toJson s!"ex_{(render uuid).take 8}")
  let wait := (clampedWait (get input "waitSeconds")).map fun seconds => [("waitSeconds", seconds)]
  let message := Json.mkObj
    ([("text", toJson text), ("exchangeId", exchangeId), ("followUp", toJson (followUp != ""))] ++
      wait.getD [])
  let to := trimText (textOr (get input "to"))
  if to == "parent" then
    let parent := get context "parent"
    if !truthy parent then
      return ← toolError "Error: you have no parent agent to message"
    if wait.isNone then
      return ← Prog.effect "context.parent.note" [message]
    let accepted ← Prog.effect "context.parent.ask" [message]
    if !truthy accepted then
      return ← toolError "Error: you already wait on your parent this turn"
    return Json.mkObj
      [("status", toJson "delivered"), ("exchangeId", exchangeId),
       ("note", toJson "Sent. Stop here: your turn ends now and the reply arrives as your next message.")]
  if !truthy (get context "messageChild") then
    return ← toolError s!"Error: {to} is not an agent you can message. Use \"parent\""
  Prog.effect "context.messageChild" [toJson to, message]

/-! ## read.tool.ts, grep.tool.ts, write.tool.ts, edit.tool.ts -/

/-- `SHELL_ONLY_SANDBOX_PROVIDERS.has(sandbox.provider)`: only the `worker` provider. -/
private def isShellOnly (sandbox : Json) : Bool := get sandbox "provider" == toJson "worker"

/-- `{ onSandboxCpu: context.onSandboxCpu, metadata }`, the options the file tools hand to `runSandbox`. -/
private def runOptions (context metadata : Json) : Json :=
  literal [("onSandboxCpu", get context "onSandboxCpu"), ("metadata", metadata)]

/-- `typeof value === "number" && value > 0 ? value : fallback`. -/
private def positiveOr (value : Json) (fallback : Int) : Prog Int :=
  match value with
  | .num n =>
    if n.mantissa > 0 then
      match value.getInt? with
      | .ok whole => pure whole
      | .error _ => Prog.unsupported "a fractional offset or limit"
    else pure fallback
  | _ => pure fallback

/-- `readTool/execute`: numbered lines of one file, from storage or through the sandbox. -/
private def readExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  rethrowAsError (do
    let ws ← Prog.effect "resolveWorkspace" [get context "workspaces", get input "workspace"]
    if !truthy ws then
      return ← toolError "Error: no workspace attached"
    let rel ← Prog.effect "toWorkspaceRelative" [get input "file_path"]
    let spoken ← Prog.effect "spokenContents" [get context "agentConfig", ws, rel]
    if truthy spoken then
      return spoken
    let runner := if truthy (get ws "sandbox") then get ws "sandbox" else get ws "readMount"
    if !truthy runner then
      return ← Prog.effect "s3ReadNumbered" [ws, rel, get input "offset", get input "limit"]
    let q ← Prog.effect "shellQuote" [rel]
    let start ← positiveOr (get input "offset") 1
    let size ← positiveOr (get input "limit") 2000
    let last := start + size - 1
    let quotedPath ← Prog.effect "shellQuote" [toJson s!"./{render rel}"]
    let code := s!"if [ ! -f {render q} ]; then printf 'Error: file not found: %s\\n' {render q} >&2; exit 1; fi; " ++
      s!"sed -n '{start},{last}p' {render quotedPath} | nl -ba -v {start}"
    let result ← runWithMetadata runner context ws code
    if !truthy (get result "ok") then
      return ← toolError (failureText result "Error: read failed")
    pure (get result "stdout"))

/-- `searchCommand`'s count filter: drops lines that are `0` or end in `:0`. -/
private def dropZeroCounts (output : String) : String :=
  "\n".intercalate
    ((output.splitOn "\n").filter fun line => !(line == "0" || line.endsWith ":0"))

/-- `grepTool/execute`: runs `searchCommand` in the workspace sandbox and tidies the output. -/
private def grepExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  rethrowAsError (do
    match get input "pattern" with
    | .str text => if text == "" then return ← toolError "Error: pattern is required"
    | _ => return ← toolError "Error: pattern is required"
    let ws ← Prog.effect "resolveWorkspace" [get context "workspaces", get input "workspace"]
    if !truthy (get ws "sandbox") then
      return ← toolError "Error: workspace is read-only"
    let code ← Prog.effect "searchCommand" [input]
    let metadata ← Prog.effect "sandboxRunMetadata" [context, ws]
    let result ← Prog.effect "runSandbox"
      [get ws "sandbox", get ws "namespace", code, runOptions context metadata]
    if get result "exitCode" == toJson (1 : Nat) then
      let stderr := trimText (textOr (get result "stderr"))
      return ← pure (toJson ("\n".intercalate (["No matches found", stderr].filter fun part => part != "")))
    if !truthy (get result "ok") then
      return ← toolError (failureText result "Error: grep failed")
    let stdout := textOr (get result "stdout")
    let output := if get input "output_mode" == toJson "count" then dropZeroCounts stdout else stdout
    let trimmed := trimText output
    pure (toJson (if trimmed == "" then "No matches found" else trimmed)))

/-- `writeTool/execute`: writes base64 content through the workspace sandbox. -/
private def writeExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  rethrowAsError (do
    let ws ← Prog.effect "resolveWorkspace" [get context "workspaces", get input "workspace"]
    let sandbox := get ws "sandbox"
    if !truthy sandbox then
      return ← toolError "Error: workspace is read-only"
    let rel ← Prog.effect "toWorkspaceRelative" [get input "file_path"]
    if rel == toJson "." then
      return ← toolError "Error: file_path must reference a file"
    let q ← Prog.effect "shellQuote" [rel]
    let b64 ← Prog.effect "toBase64" [toJson (textOr (get input "content"))]
    let qData ← Prog.effect "shellQuote" [b64]
    let sync := if isShellOnly sandbox then "" else s!"sync {render q} && "
    let code := s!"mkdir -p \"$(dirname -- {render q})\" && printf '%s' {render qData} | base64 -d > {render q} && " ++
      sync ++ s!"printf 'Wrote %s (%s bytes)\\n' {render q} \"$(wc -c < {render q})\""
    let metadata ← Prog.effect "sandboxRunMetadata" [context, ws]
    let result ← Prog.effect "runSandbox"
      [sandbox, get ws "namespace", toJson code, runOptions context metadata]
    if !truthy (get result "ok") then
      return ← toolError (failureText result "Error: write failed")
    pure (toJson (trimText (textOr (get result "stdout")))))

/-- `editTool/execute`: replaces text in one file, on the shell or with an `editScript`. -/
private def editExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  rethrowAsError (do
    let ws ← Prog.effect "resolveWorkspace" [get context "workspaces", get input "workspace"]
    let sandbox := get ws "sandbox"
    if !truthy sandbox then
      return ← toolError "Error: workspace is read-only"
    let rel ← Prog.effect "toWorkspaceRelative" [get input "file_path"]
    if rel == toJson "." then
      return ← toolError "Error: file_path must reference a file"
    let metadata ← Prog.effect "sandboxRunMetadata" [context, ws]
    let oldText := toJson (textOr (get input "old_string"))
    let newText := toJson (textOr (get input "new_string"))
    let replaceAll := toJson (isTrue (get input "replace_all"))
    if isShellOnly sandbox then
      let edited ← Prog.effect "editOnShell"
        [Json.mkObj [("$fn", toJson "")], rel, oldText, newText, replaceAll]
      return ← pure (edited)
    let pathB64 ← Prog.effect "toBase64" [rel]
    let oldB64 ← Prog.effect "toBase64" [oldText]
    let newB64 ← Prog.effect "toBase64" [newText]
    let code ← Prog.effect "editScript" [pathB64, oldB64, newB64, replaceAll]
    let result ← Prog.effect "runSandbox"
      [sandbox, get ws "namespace", code, runOptions context metadata]
    if !truthy (get result "ok") then
      return ← toolError (failureText result "Error: edit failed")
    pure (toJson (trimText (textOr (get result "stdout")))))

/-! ## computer.tool.ts -/

/-- An object's own properties in key order, without the recorder's bookkeeping keys. -/
private def properties (value : Json) : List (String × Json) :=
  match value with
  | .obj kvs => kvs.toList.filter fun (key, _) => key != "$keys" && key != "$fields" && key != "$undefined"
  | _ => []

private def listOf (value : Json) : List Json :=
  match value with
  | .arr values => values.toList
  | _ => []

/-- `computerTool/execute`: runs one action on the chosen machine and shapes the reply. -/
private def computerExecute (call : Json) : Prog Json := do
  let machines := Twin.moduleValue call "machines"
  let names := (listOf (Twin.moduleValue call "names")).map render
  let picks := isTrue (Twin.moduleValue call "picks")
  let input := Twin.callArg call 0
  let action := Json.mkObj ((properties input).filter fun (key, _) => key != "sandbox")
  let machine ← Prog.effect "computerSandboxTarget" [machines, get input "sandbox"]
  if !truthy machine then
    return ← toolError s!"Error: pass sandbox with the computer to act on: {", ".intercalate names}"
  let reply ← Prog.effect "runMachineComputerAction" [get machine "sandbox", action]
  if truthy (get reply "error") then
    return ← toolError s!"Error: {render (get reply "error")}"
  let app := if truthy (get reply "app") then s!" (frontmost app: {render (get reply "app")})" else ""
  let on := if picks then s!" on {render (get machine "name")}" else ""
  if !truthy (get reply "image") then
    return Json.mkObj
      [("type", toJson "text"),
       ("value", toJson s!"{render (orElse (get reply "text") (toJson "OK"))}{on}{app}")]
  let label := if get action "action" == toJson "zoom" then "Zoomed region" else "Screenshot"
  return Json.mkObj
    [("type", toJson "content"),
     ("value", .arr #[
       Json.mkObj [("type", toJson "text"), ("text", toJson s!"{label}{on}{app}")],
       Json.mkObj [("type", toJson "image-data"), ("data", get (get reply "image") "data"),
         ("mediaType", get (get reply "image") "mediaType")]])]

/-- `computerTool/toModelOutput`: the tool's output goes to the model as it is. -/
private def computerToModelOutput (call : Json) : Prog Json :=
  pure (get (Twin.callArg call 0) "output")

/-! ## sandbox-stand-in.ts -/

/-- `shellQuote`: single quotes around the text, each inner quote closed, escaped and reopened. -/
private def shellQuoted (value : String) : String :=
  "'" ++ value.replace "'" "'\\''" ++ "'"

/-- `SandboxToolCall` from `bashCall`, which the effect form of `bashCall` also returns. -/
private def bashRun (command : Json) : Prog Json :=
  Prog.effect "bashCall" [command]

/-- `input.operation.type === "update_file" ? "edit" : "write"`, the file the patch names. -/
private def applyPatchToSandboxCall (call : Json) : Prog Json := do
  let operation := get (Twin.callArg call 0) "operation"
  let toolName := if get operation "type" == toJson "update_file" then "edit" else "write"
  return Json.mkObj
    [("toolName", toJson toolName), ("input", literal [("file_path", get operation "path")])]

/-- `anthropicBash/toSandboxCall`. -/
private def anthropicBashToSandboxCall (call : Json) : Prog Json :=
  bashRun (orElse (get (Twin.callArg call 0) "command") (toJson ""))

/-- `anthropicBash/execute`: a restart has nothing to reset, anything else runs. -/
private def anthropicBashExecute (call : Json) : Prog Json := do
  if isTrue (get (Twin.callArg call 0) "restart") then
    return toJson "Shell restarted."
  Prog.effect "run" [Twin.callArg call 0, Twin.callArg call 1]

/-- `customTool/toSandboxCall`: the text reaches the command as a quoted heredoc. -/
private def customToSandboxCall (call : Json) : Prog Json := do
  let command := Twin.moduleValue call "command"
  let input := textOr (Twin.callArg call 0)
  let lines := input.splitOn "\n"
  let rec marker (name : String) : Nat → String
    | 0 => name
    | fuel + 1 => if lines.contains name then marker (name ++ "_") fuel else name
  let name := marker "BROODS_INPUT" (lines.length + 1)
  bashRun (toJson s!"\{ {render command}\n} <<'{name}'\n{input}\n{name}")

/-- `localShell/toSandboxCall`: environment assignments, then the quoted command words. -/
private def localShellToSandboxCall (call : Json) : Prog Json := do
  let action := get (Twin.callArg call 0) "action"
  let assignments := (properties (get action "env")).map fun (name, value) =>
    s!"{name}={shellQuoted (render value)}"
  let words := (listOf (get action "command")).map fun word => shellQuoted (render word)
  let line := " ".intercalate (assignments ++ words)
  let directory := get action "workingDirectory"
  if truthy directory then
    let quoted ← Prog.effect "shellQuote" [directory]
    bashRun (toJson s!"cd {render quoted} && {line}")
  else bashRun (toJson line)

/-- `localShell/execute`: the run's text, as `{ output }`. -/
private def localShellExecute (call : Json) : Prog Json := do
  let result ← Prog.effect "run" [Twin.callArg call 0, Twin.callArg call 1]
  return Json.mkObj [("output", toJson (render result))]

/-- `runCall/return`: turns the input into a sandbox tool call, then runs that tool. -/
private def runCallReturn (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let sandboxCall ← Prog.effect "toSandboxCall" [Twin.callArg call 0]
  Prog.effect "callTool" [context, sandboxCall, Twin.callArg call 1]

/-- One command of `openaiShell/execute`: its output entry, whether it ran or threw. -/
private def shellEntry (context options command : Json) : Prog Json :=
  Prog.catchFail
    (do
      let sandboxCall ← bashRun command
      let ran ← Prog.effect "callTool" [context, sandboxCall, options]
      let text := render ran
      let code ← Prog.effect "exitCodeOf" [toJson text]
      return Json.mkObj
        [("stdout", toJson text), ("stderr", toJson ""),
         ("outcome", Json.mkObj [("type", toJson "exit"), ("exitCode", code)])])
    (fun cause => do
      let message ← Prog.effect "toErrorMessage" [cause]
      let text := render message
      let timedOut := (text.splitOn "[timed out").length > 1
      return Json.mkObj
        [("stdout", toJson ""), ("stderr", toJson text),
         ("outcome", if timedOut then Json.mkObj [("type", toJson "timeout")]
           else Json.mkObj [("type", toJson "exit"), ("exitCode", toJson (1 : Nat))])])

/-- `openaiShell/execute`: runs each command in turn on the bash tool. -/
private def openaiShellExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let commands := listOf (get (get (Twin.callArg call 0) "action") "commands")
  let mut output : Array Json := #[]
  for command in commands do
    output := output.push (← shellEntry context (Twin.callArg call 1) command)
  return Json.mkObj [("output", .arr output)]

/-- `textEditor/toSandboxCall`: maps an editor command onto the read, write or edit tool. -/
private def textEditorToSandboxCall (call : Json) : Prog Json := do
  let editor := Twin.callArg call 0
  let path := get editor "path"
  let command := get editor "command"
  let tool (name : String) (input : Json) : Json :=
    Json.mkObj [("toolName", toJson name), ("input", input)]
  if command == toJson "view" then
    let range := listOf (get editor "view_range")
    let start := range.headD undef
    let stop := (range.drop 1).headD undef
    let offset := if isUndef start then [] else [("offset", start)]
    let limit ←
      match (start.getInt?.toOption, stop.getInt?.toOption) with
      | (some first, some last) =>
        pure (if last >= first then [("limit", toJson (last - first + 1))] else [])
      | _ =>
        if isUndef start || isUndef stop then pure [] else Prog.unsupported "a fractional view range"
    return tool "read" (Json.mkObj ([("file_path", path)] ++ offset ++ limit))
  if command == toJson "create" then
    return tool "write"
      (Json.mkObj [("file_path", path), ("content", orElse (get editor "file_text") (toJson ""))])
  if command == toJson "insert" then
    let text ← Prog.effect "insertText" [editor]
    return tool "edit"
      (Json.mkObj [("file_path", path), ("insert_line", orElse (get editor "insert_line") (toJson (0 : Nat))),
        ("new_string", text)])
  return tool "edit"
    (Json.mkObj [("file_path", path), ("old_string", orElse (get editor "old_str") (toJson "")),
      ("new_string", orElse (get editor "new_str") (toJson ""))])

/-- `textEditor/execute`: runs a supported editor command; an insert goes through `runFileOperation`. -/
private def textEditorExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let commands := listOf (get (Twin.moduleValue call "TEXT_EDITOR_COMMANDS") "$set")
  let input := Twin.callArg call 0
  let command := get input "command"
  if !commands.contains command then
    return ← Prog.throwError "Error"
      s!"Error: {render command} is not supported here; use view, create, str_replace or insert"
  if command != toJson "insert" then
    return ← Prog.effect "run" [input, Twin.callArg call 1]
  let text ← Prog.effect "insertText" [input]
  let done ← Prog.effect "runFileOperation"
    [context, Json.mkObj [("type", toJson "insert"), ("path", get input "path"),
      ("line", orElse (get input "insert_line") (toJson (0 : Nat))), ("text", text)]]
  if !truthy (get done "ok") then
    return ← Prog.throwError "Error" (render (get done "output"))
  return get done "output"

/-! ## channel.tool.ts -/

/-- `await Promise.all(paths.map(...))` over calls made inside a callback: each is recorded on its
own, so they are asked in order and the first failure is raised after all have been asked. -/
private def allValues (calls : List (String × List Json)) : Prog (List Json) := do
  let mut values : Array Json := #[]
  let mut failure : Option Json := none
  for (name, args) in calls do
    match ← Prog.attempt name args with
    | .ok value => values := values.push value
    | .threw error _ => if failure.isNone then failure := some error
    | .pending => if failure.isNone then failure := some (Json.mkObj [("pending", true)])
  match failure with
  | some error => Prog.fail error
  | none => return values.toList

/-- `sendFilesTool/execute`: uploads workspace files to the channel after the outbound hook. -/
private def sendFilesExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let accountId := Twin.moduleValue call "accountId"
  let workspaces := Twin.moduleValue call "workspaces"
  let input := Twin.callArg call 0
  let paths := listOf (get input "file_paths")
  if paths.isEmpty then
    return ← toolError "Error: send-files needs at least one file_path"
  let ws ← Prog.effect "resolveWorkspace" [workspaces, get input "workspace"]
  if !truthy ws || !truthy accountId then
    return ← toolError "Error: no workspace attached"
  let files ← allValues (paths.map fun path => ("workspaceAttachment", [toJson "file", ws, path, accountId]))
  let transformed ← Prog.effect "context.transformText" [orElse (get input "caption") (toJson "")]
  if transformed == Json.null then
    return ← pure (toJson "Files blocked by the outbound message hook.")
  Prog.effect "deliverFiles" [context, .arr files.toArray, transformed]

/-- `toChannelFile`: an image attachment sent as a file. -/
private def toChannelFile (image : Json) : Json :=
  Json.mkObj ((properties image).filter (fun (key, _) => key != "type") ++ [("type", toJson "file")])

/-- `sendImagesTool/execute`: sends images as a batch, or falls back to files and links. -/
private def sendImagesExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let actions := Twin.moduleValue call "actions"
  let input := Twin.callArg call 0
  let images ← Prog.effect "resolveImages"
    [literal [("workspaces", Twin.moduleValue call "workspaces"),
       ("accountId", Twin.moduleValue call "accountId")],
     get input "urls", get input "file_paths", get input "workspace"]
  let transformed ← Prog.effect "context.transformText" [orElse (get input "caption") (toJson "")]
  if transformed == Json.null then
    return ← pure (toJson "Images blocked by the outbound message hook.")
  if truthy (get actions "sendImages") then
    let sent ← Prog.attempt "actions.sendImages"
      [images, if truthy transformed then transformed else undef]
    match sent with
    | .ok _ =>
      return ← pure (toJson s!"{(listOf images).length} image(s) sent to the current {render (Twin.moduleValue call "channelName")} conversation.")
    | _ => pure ()
  Prog.effect "deliverFiles" [context, .arr ((listOf images).map toChannelFile).toArray, transformed]

/-- `sendMessageTool/execute`. -/
private def sendMessageExecute (call : Json) : Prog Json := do
  let result ← Prog.effect "dispatch" [Twin.callArg call 0]
  pure (toJson s!"Message {render (get result "status")} for conversation {render (get result "conversationKey")}.")

/-- `sendReactionsTool/execute`. -/
private def sendReactionsExecute (call : Json) : Prog Json := do
  let _ ← Prog.effect "actions.reactToMessage" [get (Twin.callArg call 0) "emoji"]
  pure (toJson s!"Reaction added to the inbound {render (Twin.moduleValue call "channelName")} message.")

/-- `sendStickerTool/execute`. -/
private def sendStickerExecute (call : Json) : Prog Json := do
  let _ ← Prog.effect "sendSticker" [get (Twin.callArg call 0) "sticker"]
  pure (toJson s!"Sticker sent to the current {render (Twin.moduleValue call "channelName")} conversation.")

/-- `sendUpdateTool/execute`: sends a progress note unless the outbound hook blocks it. -/
private def sendUpdateExecute (call : Json) : Prog Json := do
  let transformed ← Prog.effect "context.transformText" [get (Twin.callArg call 0) "message"]
  if transformed == Json.null then
    return ← pure (toJson "Update blocked by the outbound message hook.")
  let _ ← Prog.effect "actions.sendText" [transformed]
  pure (toJson s!"Update sent to the current {render (Twin.moduleValue call "channelName")} conversation. The final reply is still owed.")

/-! ## load-skill, stop-subagent, run-subagent and small wiring closures -/

/-- `loadSkillTool/execute`: validates the input, loads the skill and reports what was loaded. -/
private def loadSkillExecute (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let skillPath := get input "path"
  let resources := get input "resources"
  match skillPath with
  | .str _ => pure ()
  | _ => return ← Prog.throwError "Error" "path is required"
  if !isUndef resources then
    match resources with
    | .arr items =>
      if !(items.all fun item => match item with | .str _ => true | _ => false) then
        return ← Prog.throwError "Error" "resources must be an array of strings"
    | _ => return ← Prog.throwError "Error" "resources must be an array of strings"
  let result ← Prog.effect "loadSkillPrompt" [skillPath, resources]
  let staged :=
    if truthy (get result "stagedPath") then
      s!". Skill files are staged for sandbox execution at {render (get result "stagedPath")}."
    else ". No sandbox staging path is available for bundled helper files in this turn."
  return toJson s!"Loaded skill {render (get result "path")}: {", ".intercalate ((listOf (get result "loadedPaths")).map render)}{staged}"

/-- `STOPPING_NOTE` in `stop-subagent.tool.ts`. -/
private def stoppingNote : String :=
  "It stops at its next model step and sends no report, so do not promise one. Only a final answer it was already writing can still arrive."

/-- `stopSubagentTool/execute`: stops a subagent task the caller owns. -/
private def stopSubagentExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let input := Twin.callArg call 0
  let record ← Prog.effect "getOwnedSubagent" [context, input]
  if !truthy record then
    let message ← Prog.effect "subagentNotFound" [get input "taskId"]
    return ← toolError (render message)
  let stopped ← Prog.effect "runtime.mutate"
    [toJson "stopIngressOwner",
     literal [("accountId", get context "accountId"), ("agentId", get input "agentId"),
       ("conversationKey", get record "conversationKey"),
       ("expectedOwnerTaskId", get input "taskId")]]
  if !truthy (get stopped "stopped") then
    return Json.mkObj [("status", toJson "not_running")]
  return Json.mkObj [("status", toJson "stopping"), ("note", toJson stoppingNote)]

/-- `runSubagentTool/execute`: normalises the tasks and hands them to the dispatcher. -/
private def runSubagentExecute (call : Json) : Prog Json := do
  let context := Twin.moduleValue call "context"
  let tasks ← Prog.effect "normalizeInput" [Twin.callArg call 0, get context "mode"]
  Prog.effect "context.dispatchSubagents" [tasks, get (Twin.callArg call 1) "messages"]

/-- `editTool/arg0`: the `run` callback `editOnShell` uses, bound to this workspace's sandbox. -/
private def editRunCallback (call : Json) : Prog Json := do
  let ws := Twin.moduleValue call "ws"
  Prog.effect "runSandbox"
    [Twin.moduleValue call "sandbox", get ws "namespace", Twin.callArg call 0,
     Twin.moduleValue call "options"]

/-- `createTools/arg1`: the skill loader handed to `loadSkillTool`, limited to the allowed paths. -/
private def skillLoaderCallback (call : Json) : Prog Json :=
  Prog.effect "context.session!.loadSkillPrompt"
    [Twin.moduleValue call "allowedSkillPaths", Twin.callArg call 0, Twin.callArg call 1]

/-- `workspaceAttachment/fetchData`: the file's bytes, read when a channel asks for them. -/
private def attachmentFetchData (call : Json) : Prog Json :=
  Prog.effect "workspaceMediaBytes" [Twin.moduleValue call "ws", Twin.moduleValue call "rel"]

/-! ## sandbox runtime closures -/

/-- `occupySandbox/return`: releases one event's hold, and drops the key when nobody holds it. -/
private def releaseOccupancy (call : Json) : Prog Json := do
  let eventId := Twin.moduleValue call "eventId"
  let key := Twin.moduleValue call "reservationKey"
  let holders := Twin.moduleValue call "holders"
  let occupants := Twin.moduleValue call "occupants"
  let held := listOf (get holders "$map")
  let remaining := held.filter fun entry => Twin.arg entry 0 != eventId
  let updated := Json.mkObj [("$map", .arr remaining.toArray)]
  if remaining.length != held.length then
    Prog.setState "module.holders" updated
  let entries := listOf (get occupants "$map")
  let ours (entry : Json) : Bool := Twin.arg entry 0 == key && Twin.arg entry 1 == holders
  let kept :=
    if remaining.isEmpty && entries.any ours then entries.filter fun entry => !ours entry
    else entries.map fun entry => if ours entry then Json.arr #[key, updated] else entry
  let next := Json.mkObj [("$map", .arr kept.toArray)]
  if next != occupants then
    Prog.setState "module.occupants" next
  return undef

/-- `meterEphemeralSandbox/return~2`: queues the row's removal. -/
private def meterRelease (call : Json) : Prog Json := do
  let sandboxId := Twin.moduleValue call "sandboxId"
  Prog.spawn "queueMirrorRemove" [Twin.moduleValue call "accountId", sandboxId, sandboxId]
  return undef

/-- `sendHeartbeats/arg0`: stamps one machine connection as seen. -/
private def heartbeatSeen (call : Json) : Prog Json := do
  let _ ← Prog.effect "getStorage" []
  Prog.effect "getStorage().machineConnections.seen"
    [get (Twin.moduleValue call "connection") "ref"]

private def tools : String := "apps/core/src/harness/tools/"

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (tools ++ "bash.tool.ts#bashTool/execute") bashExecute,
   Twin.traced (tools ++ "memory.tool.ts#memoryTool/execute") memoryExecute,
   Twin.traced (tools ++ "schedule.tool.ts#cancelScheduleTool/execute") cancelScheduleExecute,
   Twin.traced (tools ++ "schedule.tool.ts#listSchedulesTool/execute") listSchedulesExecute,
   Twin.traced (tools ++ "schedule.tool.ts#scheduleTool/execute") scheduleExecute,
   Twin.traced (tools ++ "schedule.tool.ts#updateScheduleTool/execute") updateScheduleExecute,
   Twin.traced (tools ++ "glob.tool.ts#globTool/execute") globExecute,
   Twin.traced (tools ++ "async-status.tool.ts#asyncStatusTool/execute") asyncStatusExecute,
   Twin.traced (tools ++ "ask-questions.tool.ts#askQuestionsTool/execute") askQuestionsExecute,
   Twin.traced (tools ++ "message-agents.tool.ts#messageAgentsTool/execute") messageAgentsExecute,
   Twin.traced (tools ++ "read.tool.ts#readTool/execute") readExecute,
   Twin.traced (tools ++ "grep.tool.ts#grepTool/execute") grepExecute,
   Twin.traced (tools ++ "write.tool.ts#writeTool/execute") writeExecute,
   Twin.traced (tools ++ "edit.tool.ts#editTool/execute") editExecute,
   Twin.traced (tools ++ "computer.tool.ts#computerTool/execute") computerExecute,
   Twin.traced (tools ++ "computer.tool.ts#computerTool/toModelOutput") computerToModelOutput,
   Twin.traced (tools ++ "sandbox-stand-in.ts#applyPatch/toSandboxCall") applyPatchToSandboxCall,
   Twin.traced (tools ++ "sandbox-stand-in.ts#anthropicBash/toSandboxCall") anthropicBashToSandboxCall,
   Twin.traced (tools ++ "sandbox-stand-in.ts#anthropicBash/execute") anthropicBashExecute,
   Twin.traced (tools ++ "sandbox-stand-in.ts#customTool/toSandboxCall") customToSandboxCall,
   Twin.traced (tools ++ "sandbox-stand-in.ts#localShell/toSandboxCall") localShellToSandboxCall,
   Twin.traced (tools ++ "sandbox-stand-in.ts#localShell/execute") localShellExecute,
   Twin.traced (tools ++ "sandbox-stand-in.ts#runCall/return") runCallReturn,
   Twin.traced (tools ++ "sandbox-stand-in.ts#openaiShell/execute") openaiShellExecute,
   Twin.traced (tools ++ "sandbox-stand-in.ts#textEditor/toSandboxCall") textEditorToSandboxCall,
   Twin.traced (tools ++ "sandbox-stand-in.ts#textEditor/execute") textEditorExecute,
   Twin.traced (tools ++ "channel.tool.ts#sendFilesTool/execute") sendFilesExecute,
   Twin.traced (tools ++ "channel.tool.ts#sendImagesTool/execute") sendImagesExecute,
   Twin.traced (tools ++ "channel.tool.ts#sendMessageTool/execute") sendMessageExecute,
   Twin.traced (tools ++ "channel.tool.ts#sendReactionsTool/execute") sendReactionsExecute,
   Twin.traced (tools ++ "channel.tool.ts#sendStickerTool/execute") sendStickerExecute,
   Twin.traced (tools ++ "channel.tool.ts#sendUpdateTool/execute") sendUpdateExecute,
   Twin.traced (tools ++ "load-skill.tool.ts#loadSkillTool/execute") loadSkillExecute,
   Twin.traced (tools ++ "stop-subagent.tool.ts#stopSubagentTool/execute") stopSubagentExecute,
   Twin.traced (tools ++ "run-subagent.tool.ts#runSubagentTool/execute") runSubagentExecute,
   Twin.traced (tools ++ "edit.tool.ts#editTool/arg0") editRunCallback,
   Twin.traced (tools ++ "index.ts#createTools/arg1") skillLoaderCallback,
   Twin.traced (tools ++ "channel.tool.ts#workspaceAttachment/fetchData") attachmentFetchData,
   Twin.traced "apps/core/src/harness/sandbox/live-status.ts#occupySandbox/return" releaseOccupancy,
   Twin.traced "apps/core/src/harness/sandbox/utils.ts#meterEphemeralSandbox/return~2" meterRelease,
   Twin.traced "apps/core/src/harness/sandbox/machine-executor.ts#sendHeartbeats/arg0" heartbeatSeen]

end Spec.Sandbox.Closures
