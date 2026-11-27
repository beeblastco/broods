import Spec.Sandbox.Twins.Runtime.WorkspaceRules

/-!
Twins of `apps/core/src/shared/`: `workspaces.ts`, `sandbox-sizes.ts`, `sandbox-cleanup.ts`.
-/

namespace Spec.Sandbox.Rt

open Lean

/-- The source path of a shared module. -/
def shared (file name : String) : String :=
  s!"apps/core/src/shared/{file}#{name}"

/-- A size's `{vcpu, memoryMb, storageGb}`. -/
def specsJson (vcpu : JsonNumber) (memoryMb storageGb : Nat) : Json :=
  Json.mkObj [("vcpu", .num vcpu), ("memoryMb", toJson memoryMb), ("storageGb", toJson storageGb)]

/-- `SANDBOX_SIZES` as `(vcpu, memoryMb, storageGb)`. -/
def sandboxSize (size : String) : Option (JsonNumber × Nat × Nat) :=
  match size with
  | "tiny" => some (⟨25, 2⟩, 512, 8)
  | "xsmall" => some (⟨5, 1⟩, 1024, 8)
  | "small" => some (⟨1, 0⟩, 2048, 8)
  | "medium" => some (⟨2, 0⟩, 4096, 16)
  | "large" => some (⟨4, 0⟩, 8192, 32)
  | _ => none

/-- `CLOUDFLARE_INSTANCE_TYPES[size].specs`. -/
def cloudflareSpecs (size : String) : Option Json :=
  match size with
  | "tiny" | "xsmall" => some (specsJson ⟨5, 1⟩ 4096 8)
  | "small" => some (specsJson ⟨1, 0⟩ 6144 12)
  | "medium" => some (specsJson ⟨2, 0⟩ 8192 16)
  | "large" => some (specsJson ⟨4, 0⟩ 12288 20)
  | _ => none

/-- `positiveNumber`. -/
def positiveNumber (value : Json) : Option Json :=
  match value with
  | .num number => if number.mantissa > 0 then some value else none
  | _ => none

/-- `workdirSizeResources`. -/
def workdirSizeResources (size : String) : R Json :=
  match sandboxSize size with
  | none => unsup "an unknown size reads a property of undefined"
  | some (vcpu, memoryMb, storageGb) =>
    let choices : List JsonNumber := [⟨5, 1⟩, ⟨1, 0⟩, ⟨2, 0⟩, ⟨4, 0⟩]
    let cpu := (choices.find? (numLe vcpu ·)).getD ⟨4, 0⟩
    pure (Json.mkObj [("cpu", .num cpu), ("memoryMb", toJson memoryMb), ("diskGb", toJson storageGb)])

/-- `workdirResources`, returning null for undefined. -/
def workdirResources (input : Json) : R Json := do
  let options := get input "options"
  let sized ←
    match get input "size" with
    | .str size => if size.isEmpty then pure .null else workdirSizeResources size
    | _ => pure .null
  let pick := fun (option field : String) =>
    match positiveNumber (get options option) with
    | some value => some value
    | none => opt sized field
  let cpu := pick "cpu" "cpu"
  let memoryMb := pick "memoryMb" "memoryMb"
  let diskGb := pick "diskGb" "diskGb"
  if cpu.isNone && memoryMb.isNone && diskGb.isNone then return .null
  pure (objOf [("cpu", cpu), ("memoryMb", memoryMb), ("diskGb", diskGb)])

/-- `resolveSandboxSpecs`. -/
def resolveSandboxSpecs (input : Json) : R Json := do
  let provider := get input "provider"
  let base : JsonNumber × Nat × Nat := (⟨5, 1⟩, 1024, 8)
  let baseCpu := Json.num base.1
  let baseMemory : Json := toJson base.2.1
  let baseDisk : Json := toJson base.2.2
  if provider == .str "sandbox" then
    let resources ← workdirResources input
    return Json.mkObj [("vcpu", (opt resources "cpu").getD baseCpu),
      ("memoryMb", (opt resources "memoryMb").getD baseMemory),
      ("storageGb", (opt resources "diskGb").getD baseDisk)]
  if provider == .str "lambda" then return specsJson ⟨4, 0⟩ 8192 8
  if provider == .str "worker" then return specsJson ⟨1, 0⟩ 128 0
  if provider == .str "cloudflare" then
    match cloudflareSpecs ((strAt input "size").getD "xsmall") with
    | some specs => return specs
    | none => unsup "an unknown size reads a property of undefined"
  match get input "size" with
  | .str size =>
    if !size.isEmpty then
      match sandboxSize size with
      | some (vcpu, memoryMb, storageGb) => return specsJson vcpu memoryMb storageGb
      | none => unsup "an unknown size has no specs"
  | _ => pure ()
  let options := get input "options"
  pure (Json.mkObj [("vcpu", (positiveNumber (get options "cpu")).getD baseCpu),
    ("memoryMb", (positiveNumber (get options "memoryMb")).getD baseMemory),
    ("storageGb", (positiveNumber (get options "diskGb")).getD baseDisk)])

/-- A string with something in it after trimming. -/
def blankFree (value : Json) : Bool :=
  match value with
  | .str text => !(jsTrim text).isEmpty
  | _ => false

/-- `runsOnOwnCredentials`, with none when the switch matches no case. -/
def runsOnOwnCredentials (config : Json) : Option Bool :=
  let options := get config "options"
  match get config "provider" with
  | .str "daytona" | .str "e2b" => some (blankFree (get options "apiKey"))
  | .str "vercel" => some (blankFree (get options "token"))
  | .str "sandbox" => some (blankFree (get options "workdirUrl"))
  | .str "machine" | .str "custom" => some true
  | .str "cloudflare" | .str "worker" | .str "lambda" => some false
  | _ => none

/-- `sandboxControlPlane`. -/
def sandboxControlPlane (accountId record : Json) : R Json := do
  let config := get record "config"
  let specs ← resolveSandboxSpecs (objOf [("provider", opt config "provider"), ("size", opt config "size"),
    ("options", opt config "options")])
  let truthyAt := fun (source : Json) (key : String) =>
    if truthy (get source key) then opt source key else none
  let network := get config "network"
  let idle := (get config "lifecycle" |> (opt · "idleTimeoutSeconds")).getD (toJson (900 : Nat))
  pure (objOf [("accountId", some accountId), ("projectId", truthyAt record "projectId"),
    ("stageId", truthyAt record "stageId"), ("sandboxConfigId", opt record "sandboxId"),
    ("name", opt record "name"), ("specs", some specs),
    ("snapshotId", truthyAt config "snapshot"),
    ("egress", if truthy network then opt network "mode" else none),
    ("permissionMode", truthyAt config "permissionMode"),
    ("ownCredentials", if runsOnOwnCredentials config == some true then some (.bool true) else none),
    ("idleTimeoutSeconds", some idle)])

/-- `agentSandboxReservationKey`. -/
def agentSandboxReservationKey (accountId agentId sandboxId : String) : String :=
  filesystemNamespace s!"{accountId}:{agentId}:{sandboxId}"

/-- `pinnedSandboxReservationKey`. -/
def pinnedSandboxReservationKey (accountId reservationKey : String) : String :=
  filesystemNamespace s!"{accountId}:pinned:{reservationKey}"

/-- `agentSandboxReservation`. -/
def agentSandboxReservation (sandbox accountId agentId sandboxId : Json) : R (Option String) := do
  if get sandbox "persistent" != .bool true || !truthy accountId then return none
  let account := (strOf accountId).getD ""
  match get (get sandbox "options") "reservationKey" with
  | .str pinned =>
    if !(jsTrim pinned).isEmpty then return some (pinnedSandboxReservationKey account (jsTrim pinned))
  | _ => pure ()
  if !truthy agentId then return none
  match agentId, sandboxId with
  | .str agent, .str id => return some (agentSandboxReservationKey account agent id)
  | _, _ => unsup "agent or sandbox id is not a string"

/-- `reservedAgentSandbox`. -/
def reservedAgentSandbox (sandbox accountId agentId sandboxId userKey : Json) : R Json := do
  let agentKey ← agentSandboxReservation sandbox accountId agentId sandboxId
  let options := get sandbox "options"
  let pinned := blankFree (get options "reservationKey")
  let reservationKey :=
    match agentKey, userKey with
    | some key, .str user =>
      if !user.isEmpty && !pinned then some (filesystemNamespace s!"{key}:{user}") else some key
    | key, _ => key
  match reservationKey with
  | none => pure sandbox
  | some key =>
    if get options "reservationKey" == .str key then pure sandbox
    else pure (sandbox.setObjVal! "options" (options.setObjVal! "reservationKey" (.str key)))

/-- `sharedWorkspaceNamespace`. -/
def sharedWorkspaceNamespace (base : String) (isolation scope : Json) : R String := do
  if isolation == .null then return base
  if isolation == .str "agent" then
    match get scope "agentId" with
    | .str agent =>
      if agent.isEmpty then fail "Workspace isolation \"agent\" requires an agent identity"
      return s!"{base}/{agentNamespaceFolder agent}"
    | _ => fail "Workspace isolation \"agent\" requires an agent identity"
  let partition := get scope "partition"
  if !truthy partition then
    if !truthy (get scope "channelName") then return base
    fail "Workspace isolation requires the active channel to define partition"
  if get partition "by" == .str "shared" then return base
  let conversationKey :=
    match get scope "conversationKey" with
    | .null => get scope "channelScopeKey"
    | key => key
  match conversationKey with
  | .str key =>
    if key.isEmpty then fail "Conversation workspace isolation requires an active conversation key"
    match strAt partition "alias" with
    | some alias => return s!"{base}/{alias}/{filesystemNamespace key}"
    | none => unsup "partition alias is not a string"
  | _ => fail "Conversation workspace isolation requires an active conversation key"

/-- `isolatedWorkspaceNamespace`. -/
def isolatedWorkspaceNamespace (base : String) (isolation scope : Json) : R String := do
  match get scope "userConversationKey" with
  | .str user =>
    if user.isEmpty then sharedWorkspaceNamespace base isolation scope
    else
      let namespace ←
        if isolation == .str "agent" then sharedWorkspaceNamespace base isolation scope else pure base
      pure s!"{namespace}/users/{filesystemNamespace user}"
  | _ => sharedWorkspaceNamespace base isolation scope

/-- `assertSandboxReachesWorkspace`. -/
def assertSandboxReachesWorkspace (name : String) (sandbox : Json) (ownBucket onDisk : Bool) : R Unit := do
  let provider := (strAt sandbox "provider").getD ""
  if onDisk then
    if truthy sandbox && provider == "worker" && get sandbox "persistent" == .bool true then return
    fail s!"Workspace \"{name}\": a \"disk\" workspace lives on its sandbox's own disk: give it a worker sandbox with persistent: true"
  let fallback := strAt sandbox "fallbackProvider"
  let unmountable :=
    if !truthy sandbox then none
    else if !supportsS3WorkspaceMount provider (get sandbox "options") then some provider
    else
      match fallback with
      | some other =>
        if !other.isEmpty && !supportsS3WorkspaceMount other .null then some other else none
      | none => none
  match unmountable with
  | some target =>
    if !target.isEmpty then
      fail s!"Workspace \"{name}\" cannot run on a {target} sandbox; give it its own sandbox or set sandbox: null"
  | none => pure ()
  if provider == "lambda" && get (get sandbox "network") "mode" != .str "allow-all" && ownBucket then
    fail s!"Workspace \"{name}\" uses its own bucket, which a lambda sandbox reaches only with network allow-all; set that or sandbox: null"

/-- `assertDistinctSandboxNames`. -/
def assertDistinctSandboxNames (sandboxes : List Json) : R Unit := do
  let _ ← sandboxes.foldlM (init := ([] : List Json)) fun seen entry => do
    let name := get entry "name"
    if seen.contains name then
      fail s!"Sandbox \"{(strOf name).getD ""}\" is attached twice; bash picks a sandbox by name"
    pure (name :: seen)

/-- `releaseCandidates`. -/
def releaseCandidates (provider : String) (records : List Json) (instance : Json) : Json :=
  let sameProvider := records.filter fun record => get (get record "config") "provider" == .str provider
  let own := fun config => runsOnOwnCredentials config == some true
  let platform := Json.mkObj [("provider", .str provider)]
  let list :=
    if truthy (get instance "ownCredentials") then
      (sameProvider.filter fun record =>
        get record "sandboxId" == get instance "sandboxConfigId" && own (get record "config")).map
        (get · "config")
    else
      let configs := sameProvider.map (get · "config")
      if truthy instance then configs.filter (!own ·) ++ [platform]
      else if provider == "lambda" || platformWorkerProviders.contains provider then [platform]
      else configs
  Json.arr list.toArray

/-- The twins of the shared modules. -/
def sharedTwins : List Spec.Twin :=
  [ twin (shared "workspaces.ts" "sharedWorkspaceNamespace") fun args => do
      match Spec.Twin.arg args 0 with
      | .str base => pure (.str (← sharedWorkspaceNamespace base (Spec.Twin.arg args 1) (Spec.Twin.arg args 2)))
      | _ => unsup "namespace is not a string",
    twin (shared "workspaces.ts" "isolatedWorkspaceNamespace") fun args => do
      match Spec.Twin.arg args 0 with
      | .str base => pure (.str (← isolatedWorkspaceNamespace base (Spec.Twin.arg args 1) (Spec.Twin.arg args 2)))
      | _ => unsup "namespace is not a string",
    twin (shared "sandbox-sizes.ts" "resolveSandboxSpecs") fun args =>
      resolveSandboxSpecs (Spec.Twin.arg args 0),
    twin (shared "sandbox-sizes.ts" "workdirResources") fun args =>
      workdirResources (Spec.Twin.arg args 0),
    twin (shared "sandbox-sizes.ts" "workdirSizeResources") fun args => do
      match Spec.Twin.arg args 0 with
      | .str size => workdirSizeResources size
      | _ => unsup "size is not a string",
    twin (shared "sandbox-sizes.ts" "positiveNumber") fun args =>
      pure ((positiveNumber (Spec.Twin.arg args 0)).getD .null),
    twin (shared "workspaces.ts" "assertSandboxReachesWorkspace") fun args => do
      match Spec.Twin.arg args 0, Spec.Twin.arg args 2, Spec.Twin.arg args 3 with
      | .str name, .bool ownBucket, .bool onDisk =>
        assertSandboxReachesWorkspace name (Spec.Twin.arg args 1) ownBucket onDisk
        pure .null
      | _, _, _ => unsup "name or flag has the wrong type",
    twin (shared "workspaces.ts" "reservedAgentSandbox") fun args =>
      reservedAgentSandbox (Spec.Twin.arg args 0) (Spec.Twin.arg args 1) (Spec.Twin.arg args 2)
        (Spec.Twin.arg args 3) (Spec.Twin.arg args 4),
    twin (shared "sandbox-cleanup.ts" "releaseCandidates") fun args => do
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
      | .str provider, .arr records =>
        pure (releaseCandidates provider records.toList (Spec.Twin.arg args 2))
      | _, _ => unsup "provider or records has the wrong type",
    twin (shared "workspaces.ts" "sandboxControlPlane") fun args =>
      sandboxControlPlane (Spec.Twin.arg args 0) (Spec.Twin.arg args 1),
    twin (shared "workspaces.ts" "runsOnOwnCredentials") fun args =>
      pure (((runsOnOwnCredentials (Spec.Twin.arg args 0)).map Json.bool).getD .null),
    twin (shared "workspaces.ts" "agentSandboxReservation") fun args => do
      let key ← agentSandboxReservation (Spec.Twin.arg args 0) (Spec.Twin.arg args 1) (Spec.Twin.arg args 2)
        (Spec.Twin.arg args 3)
      pure ((key.map Json.str).getD .null),
    twin (shared "workspaces.ts" "assertDistinctSandboxNames") fun args => do
      match Spec.Twin.arg args 0 with
      | .arr sandboxes =>
        assertDistinctSandboxNames sandboxes.toList
        pure .null
      | _ => unsup "sandboxes is not an array",
    twin (shared "workspaces.ts" "workspaceNamespace") fun args => do
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
      | .str account, .str workspace =>
        pure (.str (filesystemNamespace (if account.isEmpty then workspace else s!"{account}:{workspace}")))
      | .null, .str workspace => pure (.str (filesystemNamespace workspace))
      | _, _ => unsup "account or workspace id has the wrong type",
    twin (shared "workspaces.ts" "agentSandboxReservationKey") fun args => do
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2 with
      | .str account, .str agent, .str sandbox => pure (.str (agentSandboxReservationKey account agent sandbox))
      | _, _, _ => unsup "an id is not a string",
    twin (shared "workspaces.ts" "pinnedSandboxReservationKey") fun args => do
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
      | .str account, .str key => pure (.str (pinnedSandboxReservationKey account key))
      | _, _ => unsup "an id is not a string" ]

end Spec.Sandbox.Rt
