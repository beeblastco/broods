import Spec.Twin

/-!
Twins of the MicroVM executor's public methods. Its private helpers (`#acquire`, `#reconnect`,
`#exec`, `#whileWarming`, `#post`, `#runLifecycle`, ...) are shared Lean functions in the `M` monad:
an exception that leaves module state as the throw found it, and a state of the module caches the
methods read and write.
-/

namespace Spec.Sandbox.Wave13

open Lean Spec

/-! ## JSON helpers -/

private def undef : Json := Twin.undefinedJson

private def isUndef (value : Json) : Bool := value.compress == undef.compress

private def nullish (value : Json) : Bool := isUndef value || value == .null

private def field (value : Json) (name : String) : Json :=
  (value.getObjVal? name).toOption.getD undef

private def str (value : Json) : String := value.getStr?.toOption.getD ""

private def truthy (value : Json) : Bool :=
  match value with
  | .null | .bool false | .str "" => false
  | .num n => n.mantissa != 0
  | other => !isUndef other

private def orElse (value fallback : Json) : Json := if nullish value then fallback else value

private def items (value : Json) : List Json := (value.getArr?.toOption.getD #[]).toList

private def intOf (value : Json) : Int := value.getInt?.toOption.getD 0

/-- Template-literal text of a string or number. -/
private def jsText (value : Json) : String :=
  match value with
  | .str text => text
  | other => other.compress

/-- Entries of an object in the key order the recorder saw. -/
private def entriesOf (value : Json) : List (String × Json) :=
  match isUndef value, value with
  | false, .obj kvs =>
    let keys : List String :=
      match value.getObjVal? "$keys" with
      | .ok (.arr names) => names.toList.filterMap fun name => name.getStr?.toOption
      | _ => kvs.toArray.toList.map (·.1)
    keys.filterMap fun key =>
      match value.getObjVal? key with
      | .ok item => if key == "$keys" || key == "$fields" then none else some (key, item)
      | _ => none
  | _, _ => []

/-- An object that remembers the order of its keys, for `JSON.stringify`. -/
private def ordered (entries : List (String × Json)) : Json :=
  Json.mkObj (entries ++ [("$keys", Json.arr (entries.map fun entry => toJson entry.1).toArray)])

/-- Object spread: later keys replace the value but keep the first position. -/
private def spreadAll (objects : List Json) : List (String × Json) :=
  objects.foldl
    (fun acc object =>
      (entriesOf object).foldl
        (fun inner entry =>
          if inner.any (·.1 == entry.1) then
            inner.map fun existing => if existing.1 == entry.1 then entry else existing
          else inner ++ [entry])
        acc)
    []

private def errorOf (message : String) (class_ : String := "Error") : Json :=
  Json.mkObj [("$error", Json.mkObj
    [("name", toJson "Error"), ("message", toJson message), ("fields", Json.mkObj []),
     ("$class", toJson class_)])]

private def errorClass (error : Json) : String := str (field (field error "$error") "$class")

private def errorMessage (error : Json) : Option String :=
  (field (field error "$error") "message").getStr?.toOption

private def stripScheme (endpoint : String) : String :=
  if endpoint.startsWith "https://" then (endpoint.drop 8).toString
  else if endpoint.startsWith "http://" then (endpoint.drop 7).toString
  else endpoint

/-- `.replace(/\/+$/, "")`. -/
private def trimSlashes (text : String) : String :=
  String.ofList (text.toList.reverse.dropWhile (· == '/')).reverse

private def fnRef : Json := Json.mkObj [("$fn", toJson "")]

private def promiseRef : Json := Json.mkObj [("$opaque", toJson "Promise"), ("$fields", Json.mkObj [])]

/-! ## Module state and the monad -/

/-- The module-level `Map` caches of `microvm-executor.ts`, as the recorder shows them. -/
inductive Cache where
  | burst
  | refresh
  | reserved
  | tokens
  deriving BEq

/-- A closure handed to `queueMirrorWrite`, run when the recording enters it. -/
inductive Closure where
  /-- `upsertSandboxInstance` of a row, with the specs read when the write runs. -/
  | upsert (cfg key id metadata : Json) (extras : List (String × Json))
  /-- As `upsert`, with the row key read from the request when the write runs. -/
  | upsertKeyed (cfg request id : Json)
  /-- `recordSandboxBurst`, then remember the totals. -/
  | burst (accountId id totals : Json)

structure Mod where
  tokens : List (String × Json) := []
  reserved : List (String × Json) := []
  refresh : List (String × Json) := []
  burst : List (String × Json) := []
  pending : List Closure := []
  tails : List (Json × Json) := []
  /-- What a traced callee left in a cache; the caller answers for it only if it changes again. -/
  byCallee : List (Cache × List (String × Json)) := []

private def Mod.entries (state : Mod) : Cache → List (String × Json)
  | .tokens => state.tokens
  | .reserved => state.reserved
  | .refresh => state.refresh
  | .burst => state.burst

private def Mod.withEntries (state : Mod) : Cache → List (String × Json) → Mod
  | .tokens, next => { state with tokens := next }
  | .reserved, next => { state with reserved := next }
  | .refresh, next => { state with refresh := next }
  | .burst, next => { state with burst := next }

private def mapJson (entries : List (String × Json)) : Json :=
  Json.mkObj [("$map", Json.arr (entries.map fun entry => Json.arr #[toJson entry.1, entry.2]).toArray)]

private def mapEntries (value : Json) : List (String × Json) :=
  (items (field value "$map")).filterMap fun entry =>
    match entry with
    | .arr #[.str key, item] => some (key, item)
    | _ => none

private def cacheName : Cache → String
  | .tokens => "authTokens"
  | .reserved => "reservedEndpoints"
  | .refresh => "mountCredentialRefreshes"
  | .burst => "burstReported"

private def initialMod (call : Json) : Mod :=
  { tokens := mapEntries (Twin.moduleValue call "authTokens")
    reserved := mapEntries (Twin.moduleValue call "reservedEndpoints")
    refresh := mapEntries (Twin.moduleValue call "mountCredentialRefreshes")
    burst := mapEntries (Twin.moduleValue call "burstReported") }

/-- A method body: it may throw, and what it did to the caches survives the throw. -/
abbrev M := ExceptT Json (StateT Mod Prog)

private def liftP {α : Type} (prog : Prog α) : M α := ExceptT.lift (StateT.lift prog)

private def raise {α : Type} (error : Json) : M α := ExceptT.mk (pure (Except.error error))

private def fail {α : Type} (message : String) : M α := raise (errorOf message)

private def unsupported {α : Type} (reason : String) : M α := liftP (Prog.unsupported reason)

private def getMod : M Mod := ExceptT.lift (get : StateT Mod Prog Mod)

private def setMod (next : Mod) : M Unit := ExceptT.lift (set next : StateT Mod Prog Unit)

/-- `try` around a body. The caches keep what the body did before it threw. -/
private def attemptM {α : Type} (body : M α) : M (Except Json α) := ExceptT.lift body.run

private def cacheEntries (cache : Cache) : M (List (String × Json)) := do
  return (← getMod).entries cache

private def cacheGet (cache : Cache) (key : String) : M (Option Json) := do
  return ((← cacheEntries cache).find? (·.1 == key)).map (·.2)

private def cacheSet (cache : Cache) (key : String) (value : Json) : M Unit := do
  let state ← getMod
  let entries := state.entries cache
  let next :=
    if entries.any (·.1 == key) then
      entries.map fun entry => if entry.1 == key then (key, value) else entry
    else entries ++ [(key, value)]
  setMod (state.withEntries cache next)

private def cacheDelete (cache : Cache) (keep : String → Bool) : M Unit := do
  let state ← getMod
  setMod (state.withEntries cache ((state.entries cache).filter fun entry => keep entry.1))

/-- Runs the twin's view of a traced callee's writes, noting each cache that callee changed. -/
private def calleeWrites (body : M Unit) : M Unit := do
  let before ← getMod
  body
  let after ← getMod
  let changed := [Cache.tokens, Cache.reserved, Cache.refresh, Cache.burst].filter fun cache =>
    (mapJson (before.entries cache)).compress != (mapJson (after.entries cache)).compress
  setMod { after with
    byCallee := changed.map (fun cache => (cache, after.entries cache)) ++
      after.byCallee.filter fun entry => !changed.contains entry.1 }

private def push (closure : Closure) : M Unit := do
  let state ← getMod
  setMod { state with pending := state.pending ++ [closure] }

/-- An effect that may throw, which here is a throw of this method. -/
private def rawEffect (fn : String) (args : List Json) : M Json := do
  match ← liftP (Prog.attempt fn args) with
  | .ok value => pure value
  | .threw error _ => raise error
  | .pending => unsupported s!"{fn} never settled"

private def rawOutcome (fn : String) (args : List Json) : M Outcome :=
  liftP (Prog.attempt fn args)

private def rawSpawn (fn : String) (args : List Json) : M Unit := liftP (Prog.spawn fn args)

private def promoteSpecs (specs : Json) : List (String × Json) :=
  if isUndef specs then [] else [("specs", specs)]

/-- Runs one queued mirror write, as `queueMirrorWrite` does once the caller yields. -/
private def runClosure : Closure → M Unit
  | .upsert cfg key id metadata extras => do
    let specs ← rawEffect "configuredSandboxSpecs" [cfg]
    rawSpawn "upsertSandboxInstance"
      [field cfg "controlPlane", toJson "lambda", key, id, metadata,
       Json.mkObj (extras ++ promoteSpecs specs)]
  | .upsertKeyed cfg request id => do
    let reserved ← rawEffect "sandboxReservationKey" [request]
    let specs ← rawEffect "configuredSandboxSpecs" [cfg]
    rawSpawn "upsertSandboxInstance"
      [field cfg "controlPlane", toJson "lambda", orElse reserved id, id, field request "metadata",
       Json.mkObj (promoteSpecs specs)]
  | .burst accountId id totals => do
    let recorded ← rawEffect "recordSandboxBurst" [accountId, id, totals]
    if truthy recorded then
      let state ← getMod
      setMod { state with tails := state.tails ++ [(id, totals)] }

/-- What follows an answered `recordSandboxBurst`: it runs once the caller's own steps are done. -/
private def burstTail (id totals : Json) : M Unit := do
  let now ← rawEffect "Date.now" []
  let state ← getMod
  if state.burst.length ≥ 512 then
    return ← unsupported "burst cache at its cap"
  let _ ← rawEffect "evictToCap" [mapJson state.burst, now]
  cacheSet .burst (str id)
    (Json.mkObj [("vcpuSeconds", field totals "vcpuSeconds"), ("gbSeconds", field totals "gbSeconds"),
      ("expiresAt", toJson (intOf now + 86400000))])

/-- Every yield lets queued mirror writes run, so they are handled wherever the recording enters one. -/
private def drain : Nat → M Unit
  | 0 => pure ()
  | limit + 1 => do
    match ← liftP (Prog.input Prog.done) with
    | none => pure ()
    | some (label, _) =>
      if label == "arg1" then
        let state ← getMod
        match state.pending with
        | closure :: rest =>
          setMod { state with pending := rest }
          runClosure closure
        | [] => pure ()
      drain limit

private def effect (fn : String) (args : List Json := []) : M Json := do
  let value ← rawEffect fn args
  drain 4
  return value

private def outcomeOf (fn : String) (args : List Json := []) : M Outcome := do
  let outcome ← rawOutcome fn args
  drain 4
  return outcome

private def nowMs : M Int := do
  return intOf (← effect "Date.now")

/-- Runs what follows answered burst writes, which happens while the caller's last call is pending. -/
private def flushTails : M Unit := do
  let state ← getMod
  setMod { state with tails := [] }
  for tail in state.tails do
    burstTail tail.1 tail.2

/-- `queueMirrorWrite(id, write)` with its result dropped. -/
private def queueMirror (id : Json) (closure : Closure) : M Unit := do
  rawSpawn "queueMirrorWrite" [id, fnRef]
  push closure
  drain 4

/-- Runs a method body and states the cache changes it left, whether or not it threw. -/
private def execute (call : Json) (body : M Json) : Prog Json := do
  let init := initialMod call
  let (outcome, afterBody) ← (body.run).run init
  let (_, final) ← ((do
    for tail in afterBody.tails do
      burstTail tail.1 tail.2 : M Unit).run).run { afterBody with tails := [] }
  for cache in [Cache.tokens, Cache.reserved, Cache.burst] do
    let before := mapJson (init.entries cache)
    let after := mapJson (final.entries cache)
    let absent := isUndef (Twin.moduleValue call (cacheName cache))
    let left := (final.byCallee.find? (·.1 == cache)).map fun entry => (mapJson entry.2).compress
    if before.compress != after.compress && !(absent && (final.entries cache).isEmpty) &&
        left != some after.compress then
      Prog.setState s!"module.{cacheName cache}" after
  match outcome with
  | .ok value => pure value
  | .error error => Prog.fail error

/-! ## Constants -/

private def proxyPort : Nat := 8080
private def warmupBudgetMs : Int := 30000
private def cachedWarmupBudgetMs : Int := 1200
private def retryMinDelayMs : Int := 150
private def retryMaxDelayMs : Int := 750
private def execGraceMs : Int := 15000
private def endpointTtlMs : Int := 180000
private def authTtlMs : Int := 600000
private def defaultWorkspaceRoot : String := "/mnt/workspaces"
private def mountAssertBudgetMs : Int := 30000
private def mountAssertMinDelayMs : Int := 250
private def mountAssertMaxDelayMs : Int := 2000
private def maxMicrovmSeconds : Int := 28800
private def releaseGraceSeconds : Int := 604800
private def snapshotPrefix : String := "broods-snapshot-"
private def provider : Json := toJson "lambda"

private def minInt (a b : Int) : Int := if a ≤ b then a else b

/-! ## Configuration -/

private def cfgOf (call : Json) : Json := Twin.field (Twin.self call) "#config"

private def accountOf (cfg : Json) : Json := field (field cfg "controlPlane") "accountId"

private def commandInput (id : Json) : Json := Json.mkObj [("microvmIdentifier", id)]

/-- `#persistent`: the key is only computed for a persistent config. -/
private def isPersistent (cfg request : Json) : M Bool := do
  if field cfg "persistent" != toJson true then return false
  return truthy (← effect "sandboxReservationKey" [request])

/-- `#workspaceRoot`. -/
private def workspaceRoot (cfg : Json) : M String := do
  let options := orElse (field cfg "options") (Json.mkObj [])
  let configured ← effect "configString" [field options "workspaceRoot"]
  let root := orElse configured (toJson defaultWorkspaceRoot)
  return str (← effect "stripTrailingSlashes" [root])

/-- `#workDir`. -/
private def workDirOf (cfg : Json) (key : String) : M String := do
  return s!"{← workspaceRoot cfg}/{key}"

/-- `#workspaceKey`. -/
private def workspaceKey (_cfg request : Json) : M String := do
  let key ←
    if truthy (field request "namespace") then effect "microvmLocalNamespace" [field request "namespace"]
    else effect "sandboxReservationKey" [request]
  if !truthy key then
    return ← fail "persistent MicroVM lifecycle requires a workspace namespace or reservation key"
  return str key

/-- `#image`: the image to run, as the SDK input names it. -/
private def image (cfg : Json) : M (List (String × Json)) := do
  let fallback ← effect "optionalEnv" [toJson "MICROVM_IMAGE_IDENTIFIER"]
  let pinned ← effect "configString" [field cfg "snapshot"]
  if truthy pinned then
    let scope ←
      if truthy fallback then effect "microvmImageScope" [fallback] else pure undef
    if !truthy scope then
      return ← fail "config.snapshot must name a platform MicroVM image in this region"
    let pinnedScope ← effect "microvmImageScope" [pinned]
    if pinnedScope != scope then
      return ← fail "config.snapshot must name a platform MicroVM image in this region"
    return [("imageIdentifier", pinned)]
  if truthy (field cfg "image") then
    let variant ←
      if truthy fallback then effect "microvmImageVariant" [fallback, field cfg "image"] else pure undef
    if !truthy variant then
      return ← fail "config.image needs MICROVM_IMAGE_IDENTIFIER to be a MicroVM image ARN in the harness runtime."
    return [("imageIdentifier", variant)]
  if !truthy fallback then
    return ← fail "MicroVM sandbox requires MICROVM_IMAGE_IDENTIFIER in the harness runtime."
  let version ← effect "optionalEnv" [toJson "MICROVM_IMAGE_VERSION"]
  return [("imageIdentifier", fallback)] ++ (if truthy version then [("imageVersion", version)] else [])

private def imageIdentifier (entries : List (String × Json)) : Json :=
  ((entries.find? (·.1 == "imageIdentifier")).map (·.2)).getD undef

/-- `#imageName`. -/
private def imageName (cfg : Json) : M Json := do
  effect "microvmImageName" [imageIdentifier (← image cfg)]

/-- `#cachedTarget`. -/
private def cachedTarget (cfg request : Json) : M (Option (Json × Json)) := do
  let key ← effect "sandboxReservationKey" [request]
  let cached ← if truthy key then cacheGet .reserved (str key) else pure none
  let some entry := cached | return none
  let now ← nowMs
  if intOf (field entry "expiresAt") ≤ now then return none
  if field entry "image" != (← imageName cfg) then return none
  return some (field entry "microvmId", field entry "endpoint")

/-- `#cacheTarget`. -/
private def cacheTarget (cfg : Json) (key : String) (id endpoint : Json) : M Unit := do
  let now ← nowMs
  let state ← getMod
  if state.reserved.length ≥ 512 then return ← unsupported "reserved endpoint cache at its cap"
  let _ ← effect "evictToCap" [mapJson state.reserved, toJson now]
  let name ← imageName cfg
  cacheSet .reserved key
    (Json.mkObj [("microvmId", id), ("endpoint", endpoint), ("image", name),
      ("expiresAt", toJson (now + endpointTtlMs))])

/-! ## Auth token, terminate, reconnect -/

/-- `#authToken`. -/
private def authToken (id : Json) (port : Nat) : M Json := do
  let cacheKey := s!"{jsText id}:{port}"
  let now ← nowMs
  let cached ← cacheGet .tokens cacheKey
  match cached with
  | some entry =>
    if intOf (field entry "expiresAt") > now then return field entry "token"
  | none => pure ()
  let command ← effect "new CreateMicrovmAuthTokenCommand"
    [Json.mkObj [("microvmIdentifier", id), ("expirationInMinutes", toJson (15 : Nat)),
      ("allowedPorts", Json.arr #[Json.mkObj [("port", toJson port)]])]]
  let result ← effect "this.#client.send" [command]
  let token := field (field result "authToken") "X-aws-proxy-auth"
  if !truthy token then
    return ← fail "CreateMicrovmAuthToken did not return an X-aws-proxy-auth token"
  let state ← getMod
  if state.tokens.length ≥ 512 then return ← unsupported "token cache at its cap"
  let _ ← effect "evictToCap" [mapJson state.tokens, toJson now]
  cacheSet .tokens cacheKey
    (Json.mkObj [("token", token), ("expiresAt", toJson (now + authTtlMs))])
  return token

/-- `#terminate`: true when the VM is gone, including one that was already gone. -/
private def terminate (id : Json) : M Bool := do
  cacheDelete .tokens fun key => !key.startsWith s!"{jsText id}:"
  let command ← effect "new TerminateMicrovmCommand" [commandInput id]
  match ← outcomeOf "this.#client .send" [command] with
  | .ok _ => return true
  | .threw error _ => return truthy (← effect "isMicrovmGone" [error])
  | .pending => unsupported "terminate never settled"

/-- `#terminate` without waiting, as the ephemeral run's `finally` hands it to `waitUntil`. -/
private def terminateDetached (id : Json) : M Unit := do
  cacheDelete .tokens fun key => !key.startsWith s!"{jsText id}:"
  let command ← effect "new TerminateMicrovmCommand" [commandInput id]
  flushTails
  rawSpawn "this.#client .send" [command]
  drain 4
  let _ ← effect "waitUntil" [promiseRef]

private def delayMs (ms : Int) : M Unit := do
  let _ ← effect "delay" [toJson ms]

/-- `#reconnect`: a VM's endpoint, resuming a suspended one and dropping one on another image. -/
private def reconnect (cfg id : Json) : M (Json × Json) := do
  let command ← effect "new GetMicrovmCommand" [commandInput id]
  let mut info ← effect "this.#client.send" [command]
  let terminalFirst ← effect "isTerminalMicrovmState" [field info "state"]
  if !truthy terminalFirst && truthy (field info "imageArn") then
    let running ← effect "microvmImageName" [field info "imageArn"]
    if running != (← imageName cfg) then
      let _ ← terminate id
      let error ← effect "new MicrovmGoneError"
        [toJson s!"MicroVM {jsText id} runs {jsText (field info "imageArn")}, not the sandbox's image"]
      return ← raise error
  let state := str (field info "state")
  if state == "SUSPENDED" || state == "SUSPENDING" then
    let resume ← effect "new ResumeMicrovmCommand" [commandInput id]
    let _ ← effect "this.#client.send" [resume]
    let start ← nowMs
    let deadline := start + warmupBudgetMs
    let mut wait := retryMinDelayMs
    for _ in List.range 64 do
      if truthy (field info "endpoint") then break
      if truthy (← effect "isTerminalMicrovmState" [field info "state"]) then break
      if (← nowMs) ≥ deadline then break
      delayMs wait
      wait := minInt (wait * 2) retryMaxDelayMs
      let again ← effect "new GetMicrovmCommand" [commandInput id]
      info ← effect "this.#client.send" [again]
  if truthy (← effect "isTerminalMicrovmState" [field info "state"]) then
    let error ← effect "new MicrovmGoneError"
      [toJson s!"MicroVM {jsText id} is {jsText (field info "state")}"]
    return ← raise error
  if !truthy (field info "endpoint") then
    return ← fail s!"MicroVM {jsText id} has no endpoint"
  return (id, field info "endpoint")

/-! ## Guest calls -/

/-- What one attempt at a guest call answered: try again, or the parsed response. -/
inductive Warm where
  | done (response : Json)
  | retry (status : Json)

/-- `#post`. `parse` runs on the body text and the response headers. -/
private def post (id endpoint : Json) (path : String) (body : Json) (timeoutMs : Int) (abort : Json)
    (warming : Bool) (parse : Json → Json → M Json) : M Warm := do
  let token ← authToken id proxyPort
  let deadline ← effect "AbortSignal.timeout" [toJson (timeoutMs + execGraceMs)]
  let signal ←
    if truthy abort then effect "AbortSignal.any" [Json.arr #[deadline, abort]] else pure deadline
  let url := s!"https://{stripScheme (jsText endpoint)}{path}"
  let options := Json.mkObj
    [("method", toJson "POST"),
     ("headers", Json.mkObj [("content-type", toJson "application/json"),
        ("X-aws-proxy-auth", token), ("X-aws-proxy-port", toJson (toString proxyPort))]),
     ("body", toJson (Twin.jsonStringify 64 body)), ("signal", signal)]
  match ← outcomeOf "fetch" [toJson url, options] with
  | .threw error _ =>
    if !truthy (← effect "retry.fetchError" [error]) then return ← raise error
    return .retry (toJson ((errorMessage error).getD "fetch error"))
  | .pending => unsupported "fetch never settled"
  | .ok response =>
    let status := intOf (field (field response "$response") "status")
    if warming && (status == 502 || status == 503) then return .retry (toJson status)
    let text ← effect "boundedText" [response, toJson path]
    if status < 200 || status > 299 then
      if str text == "" then return ← unsupported "an error answer with an empty body"
      return ← fail s!"MicroVM {path} failed ({status}): {str text}"
    return .done (← parse text (field (field response "$response") "headers"))

/-- `#whileWarming`: repeats a guest call while the VM answers that it is still starting. -/
private def whileWarming (id : Json) (budgetMs : Int) (attempt : M Warm) : M Json := do
  let deadline := (← nowMs) + budgetMs
  let mut wait := retryMinDelayMs
  for _ in List.range 128 do
    match ← attempt with
    | .done response => return response
    | .retry status =>
      if (← nowMs) ≥ deadline then
        let error ← effect "new MicrovmNotReadyError"
          [toJson s!"MicroVM {jsText id} did not become ready within {budgetMs}ms (last status {jsText status})"]
        return ← raise error
      delayMs wait
      wait := minInt (wait * 2) retryMaxDelayMs
  unsupported "more warm-up attempts than the model allows"

/-- `#sandboxEnvVars`. -/
private def sandboxEnv (cfg envVars principal : Json) : M Json :=
  effect "mergeSandboxEnv" [field cfg "envVars", envVars, principal]

/-- `#reportBurst`. -/
private def reportBurst (cfg id burst : Json) : M Unit := do
  let accountId := accountOf cfg
  if !truthy burst || !truthy accountId then return
  let totals := Json.mkObj
    [("vcpuSeconds", field burst "vcpu_seconds"), ("gbSeconds", field burst "gb_seconds")]
  let vcpu := (field totals "vcpuSeconds").getNum?.toOption.map JsonNumber.toFloat |>.getD 0.0
  let gb := (field totals "gbSeconds").getNum?.toOption.map JsonNumber.toFloat |>.getD 0.0
  let last ← cacheGet .burst (str id)
  let lastNum (name : String) : Float :=
    ((last.map (field · name)).bind fun v => v.getNum?.toOption.map JsonNumber.toFloat).getD 0.0
  let usable := last.isSome && vcpu ≥ lastNum "vcpuSeconds" && gb ≥ lastNum "gbSeconds"
  let sinceV := if usable then lastNum "vcpuSeconds" else 0.0
  let sinceG := if usable then lastNum "gbSeconds" else 0.0
  if vcpu - sinceV < 0.01 && gb - sinceG < 0.01 then return
  rawSpawn "queueMirrorWrite" [id, fnRef]
  push (.burst accountId id totals)
  let _ ← effect "waitUntil" [promiseRef]

/-- `#exec`. -/
private def exec (cfg id endpoint payload : Json) (budgetMs : Int := warmupBudgetMs) : M Json := do
  let timeoutMs := intOf (field payload "timeout_ms")
  let response ← whileWarming id budgetMs
    (post id endpoint "/exec" payload timeoutMs undef true fun text _ =>
      effect "parseExecResponse" [text, toJson "MicroVM exec"])
  reportBurst cfg id (field response "burst")
  return response

/-- `#shell`: a bash script on the VM, as stdout, stderr and the exit code. -/
private def shell (cfg id endpoint : Json) (script : String) (timeoutSeconds : Int := 60)
    (budgetMs : Int := warmupBudgetMs) (extraEnv : Json := undef) (home : Json := undef) :
    M (Json × Json × Json) := do
  let merged ← sandboxEnv cfg undef undef
  let homeVars ← effect "homeEnv" [home]
  let payload := ordered
    [("runtime", toJson "bash"), ("code", toJson script), ("timeout_ms", toJson (timeoutSeconds * 1000)),
     ("env", ordered (spreadAll [merged, extraEnv, homeVars]))]
  let response ← exec cfg id endpoint payload budgetMs
  let code := field response "exit_code"
  return (field response "stdout", field response "stderr", if isUndef code then Json.null else code)

/-! ## Workspace mounts and lifecycle -/

/-- `#assertWorkspaceMounted`. -/
private def assertWorkspaceMounted (cfg id endpoint : Json) (workDir : String) : M Unit := do
  let deadline := (← nowMs) + mountAssertBudgetMs
  let mut wait := mountAssertMinDelayMs
  for _ in List.range 128 do
    let quoted ← effect "shellQuote" [toJson workDir]
    let (_, _, code) ← shell cfg id endpoint s!"mountpoint -q {str quoted}" 30
    if code == toJson (0 : Nat) then return
    if (← nowMs) ≥ deadline then break
    delayMs wait
    wait := minInt (wait * 2) mountAssertMaxDelayMs
  fail s!"MicroVM workspace mount is not live at {workDir}; the sandbox would write to local disk instead of S3"

/-- `#s3Context`. -/
private def s3Context (cfg request : Json) : M Json := do
  let bucket ← effect "optionalEnv" [toJson "FILESYSTEM_BUCKET_NAME"]
  let region ← effect "optionalEnv" [toJson "AWS_REGION"]
  let region ← if truthy region then pure region else effect "optionalEnv" [toJson "AWS_DEFAULT_REGION"]
  let attribution ← effect "mountAttribution" [cfg, request]
  let present (name : String) (value : Json) : List (String × Json) :=
    if isUndef value then [] else [(name, value)]
  return Json.mkObj
    (present "storage" (field cfg "storage") ++ [("namespace", field request "namespace")] ++
     present "managedBucket" bucket ++ present "region" region ++ present "attribution" attribution)

/-- `#refreshMountCredentials`: best effort, a failed push never fails the caller. -/
private def refreshMountCredentials (cfg request id endpoint : Json) : M Unit := do
  if !truthy (field request "namespace") then return
  let key ← effect "sandboxReservationKey" [request]
  if !truthy key then return
  let refreshed ← cacheGet .refresh (str key)
  match refreshed with
  | some entry => if intOf (field entry "expiresAt") > (← nowMs) then return
  | none => pure ()
  let attempted ← attemptM (do
    let context ← s3Context cfg request
    let mount ← effect "resolveS3Mount" [context]
    if !truthy (field mount "credentials") then
      let _ ← effect "markMountCredentialsFresh" [key]
      return
    let token ← authToken id proxyPort
    let options := Json.mkObj
      [("method", toJson "POST"),
       ("headers", Json.mkObj [("content-type", toJson "application/json"),
          ("X-aws-proxy-auth", token), ("X-aws-proxy-port", toJson (toString proxyPort))]),
       ("body", toJson (Twin.jsonStringify 64 (field mount "credentials")))]
    let url := s!"https://{stripScheme (jsText endpoint)}/workspace/credentials"
    let response ← effect "fetch" [toJson url, options]
    let status := intOf (field (field response "$response") "status")
    if (status ≥ 200 && status ≤ 299) || status == 404 then
      let _ ← effect "markMountCredentialsFresh" [key]
    )
  match attempted with
  | .ok _ => pure ()
  | .error error =>
    if (error.getObjVal? "$unsupported").toOption.isSome then raise error else pure ()

/-- `#runLifecycle`. -/
private def runLifecycle (cfg id endpoint : Json) (workDir : String)
    (budgetMs : Int := warmupBudgetMs) : M Unit := do
  let script ← effect "lifecycleScript" [toJson workDir, field cfg "onCreate", field cfg "onResume"]
  if isUndef script then return
  let seconds := match field cfg "timeout" with
    | .num _ => intOf (field cfg "timeout")
    | _ => 120
  let (stdout, stderr, code) ← shell cfg id endpoint (str script) seconds budgetMs undef (toJson workDir)
  if code != Json.null && code != toJson (0 : Nat) then
    let message := if truthy stderr then stderr else if truthy stdout then stdout
      else toJson "MicroVM lifecycle hook failed"
    return ← fail (str message)

/-- The VM a call acquired. -/
structure Acquired where
  id : Json
  endpoint : Json
  first : Bool

/-- `release(request)` on the VM this call created, which the store names: it drops the key's
cached entries and the VM's auth tokens. -/
private def releaseCreated (request id : Json) : M Unit := do
  let _ ← outcomeOf "this.release" [request]
  let key := str (orElse (field request "reservationKey") (field request "namespace"))
  calleeWrites do
    cacheDelete .reserved (· != key)
    cacheDelete .refresh (· != key)
    cacheDelete .tokens fun name => !name.startsWith s!"{jsText id}:"

/-- `#prepareWorkspaceMount`. -/
private def prepareWorkspaceMount (cfg request : Json) (acquired : Acquired) (workDir : String) :
    M Unit := do
  if !acquired.first || !truthy (field request "namespace") then
    refreshMountCredentials cfg request acquired.id acquired.endpoint
    return
  let key ← effect "sandboxReservationKey" [request]
  if truthy key then
    let _ ← effect "markMountCredentialsFresh" [key]
  match ← attemptM (assertWorkspaceMounted cfg acquired.id acquired.endpoint workDir) with
  | .ok _ => pure ()
  | .error error =>
    if (error.getObjVal? "$unsupported").toOption.isSome then return ← raise error
    releaseCreated request acquired.id
    raise error

/-! ## Creating VMs -/

/-- `#networkConnectors`. -/
private def networkConnectors (cfg : Json) (persistent : Bool) : M (List (String × Json)) := do
  let ingress ←
    if persistent then
      let http ← effect "managedIngressConnectorArn" [toJson "HTTP_INGRESS"]
      let shellArn ← effect "managedIngressConnectorArn" [toJson "SHELL_INGRESS"]
      pure [("ingressNetworkConnectors", Json.arr #[http, shellArn])]
    else pure []
  let network := orElse (field cfg "network") (Json.mkObj [("mode", toJson "deny-all")])
  let mode := str (field network "mode")
  if mode == "allow-all" then return ingress
  let egress ← effect "optionalEnv" [toJson "MICROVM_EGRESS_NETWORK_CONNECTOR_ARN"]
  if !truthy egress then
    return ← fail s!"MicroVM sandbox cannot enforce {mode} egress without MICROVM_EGRESS_NETWORK_CONNECTOR_ARN"
  if (items (field network "allowDomains")).length > 0 || (items (field network "allowCidrs")).length > 0 then
    return ← fail "MicroVM sandbox cannot enforce network.allowDomains or network.allowCidrs; use deny-all or allow-all"
  return ingress ++ [("egressNetworkConnectors", Json.arr #[egress])]

/-- `#runHookPayload`: the workspace mount the VM sets up itself, as the JSON string the hook reads. -/
private def runHookPayload (cfg request : Json) : M Json := do
  if !truthy (field request "namespace") then return undef
  let context ← s3Context cfg request
  let mount ← effect "resolveS3Mount" [context]
  let root := toJson (trimSlashes (str (orElse (field request "workspaceRoot") (toJson defaultWorkspaceRoot))))
  let localNs ← effect "microvmLocalNamespace" [field request "namespace"]
  let present (name : String) (value : Json) : List (String × Json) :=
    if truthy value then [(name, value)] else []
  let payload := ordered
    [("workspace", ordered
      [("namespace", localNs), ("root", root),
       ("mount", ordered
         ([("bucket", field mount "bucket"), ("prefix", field mount "prefix")] ++
          present "region" (field mount "region") ++ present "endpoint" (field mount "endpoint") ++
          present "env" (field mount "credentials")))])]
  return toJson (Twin.jsonStringify 64 payload)

/-- `#logStream`: `<account>/<project>/<stage>/<uuid>`. -/
private def logStream (call cfg : Json) : M Json := do
  let scope := Twin.observabilityContext call
  let part (name : String) (fallback : Json) : Json :=
    let value := field scope name
    if truthy value then value else fallback
  let account := part "accountId" (if truthy (accountOf cfg) then accountOf cfg else toJson "-")
  let uuid ← effect "crypto.randomUUID" []
  let name := s!"{jsText account}/{jsText (part "project" (toJson "-"))}/{jsText (part "stage" (toJson "-"))}/{jsText uuid}"
  let key ← effect "optionalEnv" [toJson "OTEL_EXPORTER_OTLP_HEADERS"]
  if truthy key then return ← unsupported "a signed log stream name"
  return toJson name

/-- `#runInput`. -/
private def runInput (cfg request stream : Json) : M Json := do
  let imageEntries ← image cfg
  let identifier := imageIdentifier imageEntries
  let imageName := (str identifier).splitOn ":" |>.getD 6 ""
  if imageName.startsWith snapshotPrefix then
    let name ← effect "microvmImageName" [identifier]
    let registered ← effect "assertSnapshotBootable" [field cfg "controlPlane", name]
    if !truthy registered then return ← fail "config.snapshot names a snapshot of another account"
  let executionRole ← effect "optionalEnv" [toJson "MICROVM_EXECUTION_ROLE_ARN"]
  let logGroup ← effect "optionalEnv" [toJson "MICROVM_LOG_GROUP_NAME"]
  let persistent ← isPersistent cfg request
  let lifecycle ← effect "resolveSandboxLifecycle" [field cfg "lifecycle"]
  let hook ← runHookPayload cfg request
  let connectors ← networkConnectors cfg persistent
  let maxLifetime := field lifecycle "maxLifetimeSeconds"
  let duration :=
    if persistent then minInt (if nullish maxLifetime then maxMicrovmSeconds else intOf maxLifetime) maxMicrovmSeconds
    else minInt (intOf (field request "timeoutSeconds") + 60) maxMicrovmSeconds
  return Json.mkObj
    (imageEntries ++
     (if truthy executionRole then [("executionRoleArn", executionRole)] else []) ++
     (if truthy logGroup then
        [("logging", Json.mkObj [("cloudWatch", Json.mkObj [("logGroup", logGroup), ("logStream", stream)])])]
      else []) ++
     (if persistent then
        [("idlePolicy", Json.mkObj
          [("maxIdleDurationSeconds", field lifecycle "idleTimeoutSeconds"),
           ("suspendedDurationSeconds",
             if nullish maxLifetime then toJson releaseGraceSeconds else maxLifetime),
           ("autoResumeEnabled", toJson true)])]
      else []) ++
     [("maximumDurationInSeconds", toJson duration)] ++ connectors ++
     (if truthy hook then [("runHookPayload", hook)] else []))

/-- `#runMicrovm`: the new VM's id, endpoint and log stream. -/
private def runMicrovm (call cfg request : Json) : M (Json × Json × Json) := do
  let stream ← logStream call cfg
  let input ← runInput cfg request stream
  let command ← effect "new RunMicrovmCommand" [input]
  let result ←
    match ← outcomeOf "this.#client.send" [command] with
    | .ok value => pure value
    | .threw error _ =>
      let capacity := ["InsufficientCapacityException", "ServiceQuotaExceededException",
        "ThrottlingException", "TooManyRequestsException"]
      if capacity.contains (str (field (field error "$error") "name")) then
        let wrapped ← effect "new SandboxCapacityError"
          [toJson ((errorMessage error).getD "")]
        return ← raise wrapped
      return ← raise error
    | .pending => unsupported "RunMicrovm never settled"
  if !truthy (field result "microvmId") || !truthy (field result "endpoint") then
    return ← fail "RunMicrovm did not return a microvmId and endpoint"
  return (field result "microvmId", field result "endpoint", stream)

/-- `#acquire`: the VM of a reservation, or a new one. -/
private def acquire (call cfg request : Json) : M Acquired := do
  if !(← isPersistent cfg request) then
    let (id, endpoint, stream) ← runMicrovm call cfg request
    queueMirror id
      (.upsert cfg id id (field request "metadata") [("ephemeral", toJson true), ("logStream", stream)])
    return { id := id, endpoint := endpoint, first := true }
  let keyJson ← effect "sandboxReservationKey" [request]
  let key := str keyJson
  let existing ← effect "getSandboxExternalId" [provider, keyJson]
  if truthy existing then
    let reconnected ← attemptM (do
      let target ← reconnect cfg existing
      rawSpawn "saveSandboxInstance"
        [provider, keyJson, existing, accountOf cfg, field (field cfg "controlPlane") "releaseAfterIdleSeconds"]
      queueMirror existing (.upsert cfg keyJson existing (field request "metadata") [])
      cacheTarget cfg key target.1 target.2
      return target)
    match reconnected with
    | .ok target => return { id := target.1, endpoint := target.2, first := false }
    | .error error =>
      if !truthy (← effect "isMicrovmGone" [error]) then return ← raise error
      let _ ← outcomeOf "deleteSandboxInstance" [provider, keyJson, accountOf cfg, existing]
  let (id, endpoint, stream) ← runMicrovm call cfg request
  let claimed ← attemptM (effect "claimSandboxInstance"
    [provider, keyJson, id, accountOf cfg, field (field cfg "controlPlane") "releaseAfterIdleSeconds"])
  match claimed with
  | .error _ => return ← unsupported "the claim was rejected and both sides are undone together"
  | .ok won =>
    if truthy won then
      queueMirror id (.upsert cfg keyJson id (field request "metadata") [("logStream", stream)])
      cacheTarget cfg key id endpoint
      return { id := id, endpoint := endpoint, first := true }
  let winner ← effect "getSandboxExternalId" [provider, keyJson]
  let _ ← terminate id
  let reconnected ←
    if truthy winner then
      match ← attemptM (reconnect cfg winner) with
      | .ok target => pure (some target)
      | .error error =>
        if (error.getObjVal? "$unsupported").toOption.isSome then return ← raise error
        pure none
    else pure none
  match reconnected with
  | none => fail "failed to reserve MicroVM (lost create race)"
  | some target =>
    cacheTarget cfg key target.1 target.2
    return { id := target.1, endpoint := target.2, first := false }

/-! ## run -/

/-- `#execPayload`. -/
private def execPayload (cfg request : Json) : M Json := do
  let home ←
    if (← isPersistent cfg request) && !truthy (field request "namespace") then
      pure (toJson (← workDirOf cfg (← workspaceKey cfg request)))
    else pure undef
  let localNs ←
    if truthy (field request "namespace") then
      pure [("namespace", ← effect "microvmLocalNamespace" [field request "namespace"])]
    else pure []
  let merged ← sandboxEnv cfg (field request "envVars") (field request "principal")
  let homeVars ← effect "homeEnv" [home]
  let args := items (field request "args")
  return ordered
    ([("runtime", orElse (field request "runtime") (toJson "bash")), ("code", field request "code")] ++
     localNs ++
     (if truthy (field request "workspaceRoot") then [("workspace_root", field request "workspaceRoot")] else []) ++
     [("timeout_ms", toJson (intOf (field request "timeoutSeconds") * 1000))] ++
     (if args.isEmpty then [] else [("args", field request "args")]) ++
     [("env", ordered (spreadAll [merged, homeVars]))])

/-- `#execReserved`: a run on a cached VM, or nothing when the cache was stale. -/
private def execReserved (cfg request : Json) (target : Json × Json) (payload : Json) :
    M (Option Json) := do
  queueMirror target.1 (.upsertKeyed cfg request target.1)
  let attempted ← attemptM (do
    let workDir ← workDirOf cfg (← workspaceKey cfg request)
    runLifecycle cfg target.1 target.2 workDir cachedWarmupBudgetMs
    exec cfg target.1 target.2 payload cachedWarmupBudgetMs)
  match attempted with
  | .ok response => return some response
  | .error error =>
    if errorClass error != "MicrovmNotReadyError" then return ← raise error
    let key ← effect "sandboxReservationKey" [request]
    if truthy key then cacheDelete .reserved (· != str key)
    return none

/-- `run`. -/
def run (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    let startedAt ← effect "Date.now"
    let persistent ← isPersistent cfg request
    let payload ← execPayload cfg request
    let cached ← if persistent then cachedTarget cfg request else pure none
    match cached with
    | some target =>
      refreshMountCredentials cfg request target.1 target.2
      match ← execReserved cfg request target payload with
      | some response => return ← effect "execRunResult" [request, response, provider, startedAt]
      | none => pure ()
    | none => pure ()
    let acquired ← acquire call cfg request
    let outcome ← attemptM (do
      if persistent then
        let workDir ← workDirOf cfg (← workspaceKey cfg request)
        prepareWorkspaceMount cfg request acquired workDir
        runLifecycle cfg acquired.id acquired.endpoint workDir
      else if truthy (field request "namespace") then
        let local_ ← effect "microvmLocalNamespace" [field request "namespace"]
        assertWorkspaceMounted cfg acquired.id acquired.endpoint (← workDirOf cfg (str local_))
      let response ← exec cfg acquired.id acquired.endpoint payload
      effect "execRunResult" [request, response, provider, startedAt])
    if !persistent then terminateDetached acquired.id
    match outcome with
    | .ok result => pure result
    | .error error => raise error)

/-! ## Harness reservations and commands -/

/-- `request.abortSignal?.throwIfAborted()`. -/
private def abortCheck (request : Json) : M Unit := do
  if truthy (field request "abortSignal") then
    let _ ← effect "request.abortSignal?.throwIfAborted"

private def reservationJson (id endpoint : Json) (first : Option Bool) : Json :=
  Json.mkObj
    ([("microvmId", id), ("endpoint", endpoint)] ++
     (match first with | some value => [("isFirstCreate", toJson value)] | none => []))

/-- `#harnessRequest`: the request a harness reservation acquires with. -/
private def harnessRequest (cfg key metadata : Json) : Json :=
  Json.mkObj
    ([("code", toJson "true"), ("reservationKey", key),
      ("timeoutSeconds", orElse (field cfg "timeout") (toJson (120 : Nat))),
      ("outputLimitBytes", orElse (field cfg "outputLimitBytes") (toJson (65536 : Nat)))] ++
     (if truthy metadata then [("metadata", metadata)] else []))

private def persistentMessage : String :=
  "Harness sessions require a persistent lambda (MicroVM) reservation key"

/-- `acquireHarnessReservation`. -/
def acquireHarnessReservation (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    abortCheck request
    if !(← isPersistent cfg request) then return ← fail persistentMessage
    let key := field request "reservationKey"
    let reservation ← acquire call cfg (harnessRequest cfg key (field request "metadata"))
    let outcome ← attemptM (do
      let workDir ← workDirOf cfg (str key)
      runLifecycle cfg reservation.id reservation.endpoint workDir
      abortCheck request
      return reservationJson reservation.id reservation.endpoint (some reservation.first))
    match outcome with
    | .ok value => pure value
    | .error error =>
      if reservation.first && field request "shared" != toJson true then
        releaseCreated request reservation.id
      raise error)

/-- `resumeHarnessReservation`. -/
def resumeHarnessReservation (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    abortCheck request
    if !(← isPersistent cfg request) then return ← fail persistentMessage
    let key := field request "reservationKey"
    let id ← effect "getSandboxExternalId" [provider, key]
    if !truthy id then
      let gone ← effect "new SandboxGoneError" [toJson "no reserved MicroVM for this Harness session"]
      return ← raise gone
    let (_, endpoint) ← reconnect cfg id
    runLifecycle cfg id endpoint (← workDirOf cfg (str key))
    let _ ← outcomeOf "saveSandboxInstance"
      [provider, key, id, accountOf cfg, field (field cfg "controlPlane") "releaseAfterIdleSeconds"]
    queueMirror id (.upsert cfg key id (field request "metadata") [])
    abortCheck request
    return reservationJson id endpoint none)

/-- `runHarnessCommand`. -/
def runHarnessCommand (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    abortCheck request
    let merged ← sandboxEnv cfg (field request "env") undef
    let homeVars ← effect "homeEnv" [toJson (← workDirOf cfg (str (field request "reservationKey")))]
    let seconds := intOf (orElse (field request "timeoutSeconds")
      (orElse (field cfg "timeout") (toJson (120 : Nat))))
    let payload := ordered
      [("runtime", toJson "bash"), ("code", field request "code"), ("timeout_ms", toJson (seconds * 1000)),
       ("env", ordered (spreadAll [merged, homeVars]))]
    let response ← exec cfg (field request "microvmId") (field request "endpoint") payload
    abortCheck request
    if field response "truncated" == toJson true then
      return ← fail "MicroVM harness command output passed the exec cap"
    let code := field response "exit_code"
    return Json.mkObj
      [("stdout", field response "stdout"), ("stderr", field response "stderr"),
       ("exitCode", if nullish code then toJson (if field response "ok" == toJson true then 0 else 1 : Nat) else code)])

/-! ## Guest routes -/

/-- `#ready`: one health probe of the VM. -/
private def ready (id endpoint : Json) (readyBy : Int) (abort : Json) : M Warm := do
  let token ← authToken id proxyPort
  let now ← nowMs
  let remaining := if readyBy - now < 1 then 1 else readyBy - now
  let deadline ← effect "AbortSignal.timeout" [toJson remaining]
  let signal ←
    if truthy abort then effect "AbortSignal.any" [Json.arr #[deadline, abort]] else pure deadline
  let options := Json.mkObj
    [("headers", Json.mkObj [("X-aws-proxy-auth", token), ("X-aws-proxy-port", toJson (toString proxyPort))]),
     ("signal", signal)]
  let probe : M Warm := do
    let response ← effect "fetch" [toJson s!"https://{stripScheme (jsText endpoint)}/healthz", options]
    let _ ← effect "res.body?.cancel"
    let status := intOf (field (field response "$response") "status")
    return if status ≥ 200 && status ≤ 299 then .done undef else .retry (toJson status)
  match ← attemptM probe with
  | .ok warm => return warm
  | .error error =>
    if truthy abort then
      let _ ← effect "abortSignal?.throwIfAborted"
    return .retry (toJson ((errorMessage error).getD "fetch error"))

/-- The parse step of a guest route: report the burst the answer carries, then read the JSON. -/
private def routeParse (cfg id : Json) (text headers : Json) : M Json := do
  let burst ← effect "burstHeader" [Json.mkObj [("$headers", headers)]]
  reportBurst cfg id burst
  match Json.parse (str text) with
  | .ok value => return value
  | .error _ => unsupported "a route answer that is not JSON"

/-- `post` in `postReserved`: wait for the health check, then make the call in what time is left. -/
private def postRoute (cfg request id endpoint : Json) (budgetMs : Int) : M Json := do
  let readyBy := (← nowMs) + budgetMs
  let abort := field request "abortSignal"
  let _ ← whileWarming id budgetMs (ready id endpoint readyBy abort)
  let left := readyBy - (← nowMs)
  whileWarming id (if left < 0 then 0 else left)
    (post id endpoint (str (field request "path")) (field request "body")
      (intOf (field request "timeoutMs")) abort false (routeParse cfg id))

/-- `postReserved`. -/
def postReserved (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    if !(← isPersistent cfg request) then
      return ← fail "a guest route needs a persistent lambda (MicroVM) sandbox reservation"
    let key ← effect "sandboxReservationKey" [request]
    let base := entriesOf (harnessRequest cfg (orElse key (toJson "")) undef)
    let overridden := ["reservationKey", "namespace", "workspaceRoot"].foldl
      (fun acc name =>
        let kept := acc.filter (·.1 != name)
        let value := field request name
        if isUndef value then kept else kept ++ [(name, value)])
      base
    let reach := Json.mkObj overridden
    let cached ← cachedTarget cfg request
    match cached with
    | some target =>
      refreshMountCredentials cfg reach target.1 target.2
      let attempted ← attemptM (do
        let workDir ← workDirOf cfg (← workspaceKey cfg reach)
        runLifecycle cfg target.1 target.2 workDir cachedWarmupBudgetMs
        postRoute cfg request target.1 target.2 cachedWarmupBudgetMs)
      match attempted with
      | .ok value => return value
      | .error error =>
        if errorClass error != "MicrovmNotReadyError" then return ← raise error
        let dropped ← effect "sandboxReservationKey" [request]
        cacheDelete .reserved (· != str (orElse dropped (toJson "")))
    | none => pure ()
    let acquired ← acquire call cfg reach
    let workDir ← workDirOf cfg (← workspaceKey cfg reach)
    prepareWorkspaceMount cfg reach acquired workDir
    runLifecycle cfg acquired.id acquired.endpoint workDir
    abortCheck request
    postRoute cfg request acquired.id acquired.endpoint warmupBudgetMs)

/-! ## Snapshots -/

/-- `CAPTURE_PY` in `microvm-snapshot.ts`, with its two limits filled in. -/
private def capturePython : String :=
  r###"
import json, os, shutil, sys, tarfile, tempfile, time, urllib.request, zipfile

started = float(os.environ["BROODS_STARTED_AT"]) - float(os.environ["BROODS_START_SLACK"])
skew = abs(time.time() - float(os.environ["BROODS_NOW"]))
if skew > 300:
    sys.exit("the VM clock is %ds off, so a snapshot could miss changed files" % skew)
skipped = json.loads(os.environ["BROODS_SKIPPED"])
top = os.environ["BROODS_ROOT"]
limit = int(os.environ["BROODS_MAX_BYTES"])
name = os.environ["BROODS_TAR_NAME"]


def inside(path):
    """Return the path as the VM sees it, from the capture root."""
    rel = os.path.relpath(path, top)
    return "/" if rel == "." else "/" + rel


def is_skipped(path):
    """Return whether the path sits under a root a snapshot never carries."""
    rel = inside(path)
    return any(rel == root or rel.startswith(root + "/") for root in skipped)


def capture(work):
    """Tar the changes, rebuild the image zip around them and upload it."""
    tar_path = os.path.join(work, name)
    root_dev = os.lstat(top).st_dev
    files = 0
    size = 0
    with tarfile.open(tar_path, "w") as tar:
        for here, dirs, names in os.walk(top, topdown=True):
            dirs[:] = [d for d in dirs if not is_skipped(os.path.join(here, d))]
            for entry in dirs + names:
                path = os.path.join(here, entry)
                try:
                    st = os.lstat(path)
                except FileNotFoundError:
                    continue
                if st.st_dev != root_dev:
                    continue
                if max(st.st_mtime, st.st_ctime) <= started:
                    continue
                tar.add(path, arcname=inside(path).lstrip("/"), recursive=False)
                files += 1
                size += st.st_size
                if size > limit:
                    sys.exit("the changes pass %d bytes, too large to snapshot" % limit)
    source = os.path.join(work, "source.zip")
    urllib.request.urlretrieve(os.environ["BROODS_SOURCE_URL"], source)
    out = os.path.join(work, "out.zip")
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "Dockerfile":
                data += ("\nADD %s /\n" % name).encode()
            zout.writestr(item, data)
        zout.write(tar_path, name, compress_type=zipfile.ZIP_STORED)
    length = os.path.getsize(out)
    if length > 5368709120:
        sys.exit("the image zip is %d bytes, past the 5 GiB upload limit" % length)
    with open(out, "rb") as body:
        request = urllib.request.Request(
            os.environ["BROODS_UPLOAD_URL"],
            data=body,
            method="PUT",
            headers={"Content-Length": str(length)},
        )
        urllib.request.urlopen(request).close()
    return {"files": files, "bytes": length}


# Each capture works in its own directory, removed however the capture ends.
work = tempfile.mkdtemp(prefix="broods-snapshot-")
try:
    print(json.dumps(capture(work)))
finally:
    shutil.rmtree(work, ignore_errors=True)
"###

/-- `String(ms / 1000)`: whole seconds, or the milliseconds as a decimal fraction. -/
private def jsSeconds (ms : Int) : String :=
  let whole := ms / 1000
  let frac := (ms % 1000).toNat
  if frac == 0 then toString whole
  else
    let digits := (toString frac).toList
    let padded := List.replicate (3 - digits.length) '0' ++ digits
    toString whole ++ "." ++ String.ofList (padded.reverse.dropWhile (· == '0')).reverse

/-- `SKIPPED_ROOTS` in `microvm-snapshot.ts`. -/
private def skippedRoots : List String :=
  ["/proc", "/sys", "/dev", "/run", "/tmp", "/var/tmp", "/var/run", "/mnt", "/lost+found"]

/-- `snapshotCapture`: the script a VM runs to capture its changes, and its environment. -/
def snapshotCapture (call : Json) : Prog Json := do
  let input := Twin.callArg call 0
  let quoted ← Prog.effect "shellQuote" [toJson capturePython]
  let now ← Prog.effect "Date.now"
  let startedMs := intOf (field (field input "startedAt") "$date")
  let id := field input "snapshotId"
  let roots := skippedRoots.map toJson ++ [field input "workspaceRoot"]
  return Json.mkObj
    [("script", toJson s!"python3 -c {str quoted}"),
     ("env", ordered
       [("BROODS_ROOT", toJson "/"), ("BROODS_STARTED_AT", toJson (jsSeconds startedMs)),
        ("BROODS_START_SLACK", toJson "60"), ("BROODS_NOW", toJson (jsSeconds (intOf now))),
        ("BROODS_SKIPPED", toJson (Json.arr roots.toArray).compress),
        ("BROODS_MAX_BYTES", toJson "4294967296"),
        ("BROODS_TAR_NAME", toJson s!"broods-snapshot-{jsText id}.tar"),
        ("BROODS_SOURCE_URL", field input "sourceUrl"), ("BROODS_UPLOAD_URL", field input "uploadUrl")])]

private def snapshotStagingPrefix : String := "sandbox-snapshots/"
private def snapshotArtifactPrefix : String := "microvm-images/broods-snapshots/"
private def snapshotImagePrefix : String := "broods-snapshot-"
private def captureTimeoutSeconds : Int := 600

/-- `#reservedId`. -/
private def reservedId (request : Json) : M Json := do
  let key ← effect "sandboxReservationKey" [request]
  if truthy key then effect "getSandboxExternalId" [provider, key] else pure Json.null

/-- `snapshot`. -/
def snapshot (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    let id ← reservedId request
    if !truthy id then return ← fail "no reserved MicroVM to snapshot for this sandbox"
    let (_, endpoint) ← reconnect cfg id
    let vmCommand ← effect "new GetMicrovmCommand" [commandInput id]
    let vm ← effect "this.#client.send" [vmCommand]
    if !truthy (field vm "imageArn") || !truthy (field vm "imageVersion") || !truthy (field vm "startedAt") then
      return ← fail s!"MicroVM {jsText id} does not report the image it runs"
    let versionCommand ← effect "new GetMicrovmImageVersionCommand"
      [Json.mkObj [("imageIdentifier", field vm "imageArn"), ("imageVersion", field vm "imageVersion")]]
    let source ← effect "this.#client.send" [versionCommand]
    let artifact ← effect "s3Location" [field (field source "codeArtifact") "uri"]
    if !truthy artifact then
      return ← fail s!"MicroVM image {jsText (field vm "imageArn")} has no S3 code artifact"
    let staging ← effect "requireEnv" [toJson "FILESYSTEM_BUCKET_NAME"]
    let uuid ← effect "randomUUID" []
    let snapshotId := String.ofList (((str uuid).toList.filter (· != '-')).take 20)
    let stagedSource := s!"{snapshotStagingPrefix}{snapshotId}/source.zip"
    let stagedImage := s!"{snapshotStagingPrefix}{snapshotId}/image.zip"
    let artifactKey := s!"{snapshotArtifactPrefix}{snapshotId}.zip"
    let bucket := field artifact "bucket"
    let captured ← attemptM (do
      let _ ← effect "copyS3Object" [bucket, field artifact "key", staging, toJson stagedSource]
      let sourceUrl ← effect "getS3ObjectUrl"
        [staging, toJson stagedSource, Json.mkObj [("expiresInSeconds", toJson captureTimeoutSeconds)]]
      let uploadUrl ← effect "putS3ObjectUrl"
        [staging, toJson stagedImage, Json.mkObj [("expiresInSeconds", toJson captureTimeoutSeconds)]]
      let root ← workspaceRoot cfg
      let capture ← effect "snapshotCapture"
        [Json.mkObj [("snapshotId", toJson snapshotId), ("startedAt", field vm "startedAt"),
          ("sourceUrl", sourceUrl), ("uploadUrl", uploadUrl), ("workspaceRoot", toJson root)]]
      let (stdout, stderr, code) ← shell cfg id endpoint (str (field capture "script"))
        captureTimeoutSeconds warmupBudgetMs (field capture "env")
      if code != toJson (0 : Nat) then
        return ← fail s!"snapshot capture failed: {str (if truthy stderr then stderr else stdout)}"
      let _ ← effect "copyS3Object" [staging, toJson stagedImage, bucket, toJson artifactKey]
      return undef)
    let _ ← liftP (Prog.all [("deleteS3Object", [staging, toJson stagedSource]),
      ("deleteS3Object", [staging, toJson stagedImage])])
    match captured with
    | .error error => return ← raise error
    | .ok _ => pure ()
    let baseVersion := (field source "baseImageVersion").getStr?.toOption.map fun text =>
      toJson ((text.splitOn ".").headD text)
    let present (name : String) (value : Json) : List (String × Json) :=
      if isUndef value then [] else [(name, value)]
    let createCommand ← effect "new CreateMicrovmImageCommand"
      [Json.mkObj
        ([("name", toJson s!"{snapshotImagePrefix}{snapshotId}"),
          ("description", toJson s!"Broods snapshot of {jsText id} on {jsText (field vm "imageArn")}"),
          ("codeArtifact", Json.mkObj [("uri", toJson s!"s3://{jsText bucket}/{artifactKey}")])] ++
         present "baseImageArn" (field source "baseImageArn") ++
         present "baseImageVersion" (baseVersion.getD undef) ++
         present "buildRoleArn" (field source "buildRoleArn") ++
         present "hooks" (field source "hooks") ++
         present "additionalOsCapabilities" (field source "additionalOsCapabilities") ++
         present "cpuConfigurations" (field source "cpuConfigurations") ++
         present "resources" (field source "resources") ++
         present "environmentVariables" (field source "environmentVariables") ++
         present "egressNetworkConnectors" (field source "egressNetworkConnectors") ++
         present "logging" (field source "logging"))]
    let created ←
      match ← outcomeOf "this.#client .send" [createCommand] with
      | .ok value => pure value
      | .threw error _ =>
        let _ ← outcomeOf "deleteS3Object" [bucket, toJson artifactKey]
        return ← raise error
      | .pending => unsupported "CreateMicrovmImage never settled"
    if !truthy (field created "imageArn") then
      return ← fail "CreateMicrovmImage returned no image ARN"
    return Json.mkObj
      [("snapshotId", toJson snapshotId), ("externalImageId", field created "imageArn"),
       ("status", toJson "building")])

/-! ## Background jobs -/

/-- `#jobsDir`. -/
private def jobsDirOf (cfg : Json) (key : String) : M String := do
  return s!"{← workspaceRoot cfg}/.fp-jobs/{key}"

/-- `#jobContext`: the VM, its endpoint and the jobs directory of a job request. -/
private def jobContext (cfg request : Json) : M (Json × Json × String) := do
  let key ← effect "sandboxReservationKey" [request]
  if !truthy key then return ← fail "job operations require a persistent sandbox reservation key"
  let id ← effect "getSandboxExternalId" [provider, key]
  if !truthy id then return ← fail "no reserved MicroVM for this workspace"
  let (_, endpoint) ← reconnect cfg id
  return (id, endpoint, ← jobsDirOf cfg (str key))

/-- A job script run on the VM, read as its stdout. -/
private def jobShell (cfg id endpoint script : Json) : M Json := do
  let (stdout, _, _) ← shell cfg id endpoint (str script)
  return stdout

/-- `runBackground`. -/
def runBackground (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    let key ← effect "sandboxReservationKey" [request]
    if field cfg "persistent" != toJson true || !truthy key then
      return ← fail "background jobs require a persistent lambda (MicroVM) sandbox reservation key"
    let acquired ← acquire call cfg request
    let workDir ← workDirOf cfg (← workspaceKey cfg request)
    prepareWorkspaceMount cfg request acquired workDir
    runLifecycle cfg acquired.id acquired.endpoint workDir
    let jobId ← if nullish (field request "jobId") then effect "generateJobId" [] else pure (field request "jobId")
    let callback := field request "callback"
    let script ← effect "launchScript"
      [toJson (← jobsDirOf cfg (str key)), jobId, toJson workDir, field request "code",
       Json.mkObj ([("maxConcurrentJobs", toJson (10 : Nat))] ++
         (if truthy callback then [("callback", callback)] else []))]
    let callbackVars ← effect "callbackEnv" [callback]
    let (stdout, stderr, code) ← shell cfg acquired.id acquired.endpoint (str script) 30
      warmupBudgetMs callbackVars (toJson workDir)
    if code != Json.null && code != toJson (0 : Nat) then
      return ← fail (str (if truthy stderr then stderr else if truthy stdout then stdout
        else toJson "failed to launch background job"))
    return Json.mkObj [("jobId", jobId), ("externalId", acquired.id)])

/-- `jobStatus`. -/
def jobStatus (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    let (id, endpoint, jobsDir) ← jobContext cfg request
    let script ← effect "statusScript" [toJson jobsDir, field request "jobId"]
    let stdout ← jobShell cfg id endpoint script
    effect "parseJobStatus" [field request "jobId", stdout])

/-- `jobLogs`. -/
def jobLogs (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    let bytes := orElse (field request "outputLimitBytes") (toJson (65536 : Nat))
    let (id, endpoint, jobsDir) ← jobContext cfg request
    let script ← effect "logsScript" [toJson jobsDir, field request "jobId", bytes]
    let stdout ← jobShell cfg id endpoint script
    let logs ← effect "truncateText" [stdout, bytes]
    return Json.mkObj
      [("jobId", field request "jobId"), ("logs", field logs "value"),
       ("truncated", field logs "truncated")])

/-- `stopJob`. -/
def stopJob (call : Json) : Prog Json :=
  execute call (do
    let cfg := cfgOf call
    let request := Twin.callArg call 0
    let (id, endpoint, jobsDir) ← jobContext cfg request
    let stop ← effect "stopScript" [toJson jobsDir, field request "jobId"]
    let _ ← jobShell cfg id endpoint stop
    let script ← effect "statusScript" [toJson jobsDir, field request "jobId"]
    let stdout ← jobShell cfg id endpoint script
    effect "parseJobStatus" [field request "jobId", stdout])

private def microvm (name : String) : String :=
  "apps/core/src/harness/sandbox/microvm-executor.ts#MicrovmSandboxExecutor." ++ name

/-- This file's twins. -/
def twins : List Spec.Twin :=
  [Twin.traced (microvm "run") run,
   Twin.traced (microvm "acquireHarnessReservation") acquireHarnessReservation,
   Twin.traced (microvm "resumeHarnessReservation") resumeHarnessReservation,
   Twin.traced (microvm "runHarnessCommand") runHarnessCommand,
   Twin.traced (microvm "runBackground") runBackground,
   Twin.traced (microvm "jobStatus") jobStatus,
   Twin.traced (microvm "jobLogs") jobLogs,
   Twin.traced (microvm "stopJob") stopJob,
   Twin.traced (microvm "postReserved") postReserved,
   Twin.traced (microvm "snapshot") snapshot,
   Twin.traced "apps/core/src/harness/sandbox/microvm-snapshot.ts#snapshotCapture" snapshotCapture]

end Spec.Sandbox.Wave13
