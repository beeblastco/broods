import Broods.Sync

/-!
# Account-wide external resources

Model of the account rows behind a manifest's skills, hooks and MCP servers
(`syncExternalResources` and `pruneExternalResources` in
`packages/convex/cli/httpRoutes.ts`). Skills (S3) and hooks (`accountHooks`) are
account-wide and keyed by name; MCP servers are rows scoped to one stage. Which stage
manages a resource, and which row, is recorded in `cliExternalResources`; a prune
reads those records after the manifest synced and removes rows by the recorded id.
-/

namespace Broods.SyncExternal

open Broods.Sync (Kind)

/-- A `cliExternalResources` row: `stage` records `kind:name` as CLI-managed, as the
row `id` (`externalId`). -/
structure Record where
  stage : Nat
  kind : Kind
  name : Nat
  id : Nat
  deriving DecidableEq, Repr

/-- The name of an account-wide resource. -/
abbrev Key := Kind × Nat

/-- An active account-wide row: an `accountHooks` row or an S3 skill. -/
structure Row where
  key : Key
  id : Nat
  deriving DecidableEq, Repr

/-- An active `mcp` row of one stage. -/
structure McpRow where
  stage : Nat
  name : Nat
  id : Nat
  deriving DecidableEq, Repr

/-- `externalOwnership(...).owned`: `stage` recorded this very row, and no other stage
records its name. -/
def owned (recs : List Record) (stage : Nat) (row : Row) : Bool :=
  recs.any (fun r => r.stage == stage && (r.kind, r.name) == row.key && r.id == row.id) &&
    !recs.any (fun r => r.stage != stage && (r.kind, r.name) == row.key)

/-- `externalOwnership(...).owned.mcp`: `stage` recorded this very server. MCP rows
belong to one stage, so another stage's record of the same name is its own server. -/
def ownedMcp (recs : List Record) (stage : Nat) (row : McpRow) : Bool :=
  recs.any (fun r => r.stage == stage && r.kind == .mcp && r.name == row.name && r.id == row.id)

/-- `syncSkillResources` and `syncHookResources` upsert the declared names (a new row
gets id `fresh`); with prune, `pruneExternalResources` then removes the undeclared rows
this stage alone owns. Runs with prune even when the manifest declares none. -/
def syncAccount (recs : List Record) (stage : Nat) (desired : List Key) (prune : Bool)
    (fresh : Nat) (rows : List Row) : List Row :=
  let upserted := rows ++
    (desired.filter (fun k => !rows.any (·.key == k))).map (fun k => ⟨k, fresh⟩)
  if prune then upserted.filter (fun row => desired.contains row.key || !owned recs stage row)
  else upserted

/-- `syncMcpResources` upserts by name within the stage (`listForStage`); with prune,
`pruneExternalResources` then removes the stage's undeclared servers this stage
recorded. Other stages' rows are never read, and a server the dashboard or config API
made is never recorded. -/
def syncMcp (recs : List Record) (stage : Nat) (desired : List Nat) (prune : Bool)
    (fresh : Nat) (rows : List McpRow) : List McpRow :=
  let upserted := rows ++
    (desired.filter fun n => !rows.any (fun r => r.stage == stage && r.name == n)).map
      (⟨stage, ·, fresh⟩)
  if prune then
    upserted.filter (fun row =>
      row.stage != stage || desired.contains row.name || !ownedMcp recs stage row)
  else upserted

/-- `handleManifestSync`: every external upsert, the main manifest sync, then
`pruneExternalResources` with the records read at that point. A declared resource or a
manifest that fails validation throws before any prune (`valid = false`); the upserts
that landed before the throw are at most all of them. -/
def syncExternal (recs : List Record) (stage : Nat) (desired : List Key)
    (desiredMcp : List Nat) (prune valid : Bool) (fresh : Nat) (rows : List Row)
    (mcp : List McpRow) : List Row × List McpRow :=
  let p := prune && valid
  (syncAccount recs stage desired p fresh rows, syncMcp recs stage desiredMcp p fresh mcp)

/-! ## Properties -/

/-- A declared name is present after the sync. -/
theorem desired_present {recs : List Record} {stage : Nat} {desired : List Key}
    {prune : Bool} {fresh : Nat} {rows : List Row} {k : Key} (hk : k ∈ desired) :
    ∃ row ∈ syncAccount recs stage desired prune fresh rows, row.key = k := by
  have hup : ∃ row ∈ rows ++
      (desired.filter (fun k => !rows.any (·.key == k))).map (fun k => (⟨k, fresh⟩ : Row)),
      row.key = k := by
    by_cases hr : rows.any (·.key == k) = true
    · obtain ⟨row, hrow, hkey⟩ := List.any_eq_true.mp hr
      exact ⟨row, List.mem_append_left _ hrow, by simpa using hkey⟩
    · exact ⟨⟨k, fresh⟩, List.mem_append_right _
        (List.mem_map.mpr ⟨k, List.mem_filter.mpr ⟨hk, by simpa using hr⟩, rfl⟩), rfl⟩
  obtain ⟨row, hrow, hkey⟩ := hup
  refine ⟨row, ?_, hkey⟩
  cases prune
  · simpa [syncAccount] using hrow
  · simp only [syncAccount, ite_true, List.mem_filter]
    exact ⟨hrow, by simp [hkey, hk]⟩

/-- A prune keeps every row this stage does not solely own. -/
theorem kept_unless_owned {recs : List Record} {stage : Nat} {desired : List Key}
    {prune : Bool} {fresh : Nat} {rows : List Row} {row : Row} (hr : row ∈ rows)
    (ho : owned recs stage row = false) :
    row ∈ syncAccount recs stage desired prune fresh rows := by
  cases prune
  · simp [syncAccount, hr]
  · simp [syncAccount, hr, ho]

/-- Pruning stage A never removes a hook or skill another stage records. -/
theorem prune_keeps_other_stage {recs : List Record} {stage : Nat} {desired : List Key}
    {prune : Bool} {fresh : Nat} {rows : List Row} {row : Row} (hr : row ∈ rows)
    (hother : ∃ r ∈ recs, r.stage ≠ stage ∧ (r.kind, r.name) = row.key) :
    row ∈ syncAccount recs stage desired prune fresh rows := by
  refine kept_unless_owned hr ?_
  obtain ⟨r, hmem, hs, hk⟩ := hother
  have : recs.any (fun r => r.stage != stage && (r.kind, r.name) == row.key) = true :=
    List.any_eq_true.mpr ⟨r, hmem, by simp [hs, hk]⟩
  simp [owned, this]

/-- Nor a row this stage never recorded: one made on the dashboard, also one made
there under a name this stage records. -/
theorem prune_keeps_unrecorded {recs : List Record} {stage : Nat} {desired : List Key}
    {prune : Bool} {fresh : Nat} {rows : List Row} {row : Row} (hr : row ∈ rows)
    (hnone : ∀ r ∈ recs, r.stage = stage → (r.kind, r.name) = row.key → r.id ≠ row.id) :
    row ∈ syncAccount recs stage desired prune fresh rows := by
  refine kept_unless_owned hr ?_
  have : recs.any (fun r => r.stage == stage && (r.kind, r.name) == row.key &&
      r.id == row.id) = false :=
    List.any_eq_false.mpr (fun r hmem h => by
      simp only [Bool.and_eq_true, beq_iff_eq] at h
      exact hnone r hmem h.1.1 h.1.2 h.2)
  simp [owned, this]

/-- After a prune, a row this stage owns is present exactly when its name is declared,
also when the manifest declares none: no account row outlives its record. -/
theorem prune_owned_agrees {recs : List Record} {stage : Nat} {desired : List Key}
    {fresh : Nat} {rows : List Row} {row : Row} (hr : row ∈ rows)
    (ho : owned recs stage row = true) :
    row ∈ syncAccount recs stage desired true fresh rows ↔ row.key ∈ desired := by
  constructor
  · intro h
    simp only [syncAccount, ite_true, List.mem_filter, ho, Bool.not_true, Bool.or_false,
      List.contains_iff_mem] at h
    exact h.2
  · intro hk
    simp only [syncAccount, ite_true, List.mem_filter]
    exact ⟨List.mem_append_left _ hr, by simp [hk]⟩

/-- Syncing MCP servers for stage A leaves every other stage's servers alone. -/
theorem mcp_other_stage {recs : List Record} {stage : Nat} {desired : List Nat}
    {prune : Bool} {fresh : Nat} {rows : List McpRow} {row : McpRow} (hr : row ∈ rows)
    (hs : row.stage ≠ stage) : row ∈ syncMcp recs stage desired prune fresh rows := by
  cases prune
  · simp [syncMcp, hr]
  · simp [syncMcp, hr, hs]

/-- A prune never removes an MCP server the stage did not record, such as one made on
the dashboard or through the config API, also under a recorded name. -/
theorem mcp_prune_keeps_unrecorded {recs : List Record} {stage : Nat} {desired : List Nat}
    {prune : Bool} {fresh : Nat} {rows : List McpRow} {row : McpRow} (hr : row ∈ rows)
    (ho : ownedMcp recs stage row = false) :
    row ∈ syncMcp recs stage desired prune fresh rows := by
  cases prune
  · simp [syncMcp, hr]
  · simp [syncMcp, hr, ho]

/-- A prune removes every server the stage recorded and no longer declares, the last
one too. -/
theorem mcp_prune_empty {recs : List Record} {stage fresh : Nat} {rows : List McpRow} :
    ∀ row ∈ syncMcp recs stage [] true fresh rows,
      row.stage ≠ stage ∨ ownedMcp recs stage row = false := by
  intro row h
  simp only [syncMcp, ite_true, List.mem_filter, List.contains_nil, Bool.or_false,
    Bool.or_eq_true, bne_iff_ne, Bool.not_eq_true'] at h
  exact h.2

/-- A sync that fails validation removes nothing, whatever it prunes. -/
theorem aborted_keeps {recs : List Record} {stage : Nat} {desired : List Key}
    {desiredMcp : List Nat} {prune : Bool} {fresh : Nat} {rows : List Row}
    {mcp : List McpRow} :
    (∀ row ∈ rows,
      row ∈ (syncExternal recs stage desired desiredMcp prune false fresh rows mcp).1) ∧
      ∀ row ∈ mcp,
        row ∈ (syncExternal recs stage desired desiredMcp prune false fresh rows mcp).2 := by
  constructor
  · intro row hr
    simp [syncExternal, syncAccount, hr]
  · intro row hr
    simp [syncExternal, syncMcp, hr]

/-! ## Findings, fixed, as executable witnesses -/

/-- `deploy --prune` on stage 1 keeps hook 9, which stage 2 records. -/
example : syncAccount [⟨1, .hook, 5, 50⟩, ⟨2, .hook, 9, 90⟩] 1 [(.hook, 5)] true 0
    [⟨(.hook, 5), 50⟩, ⟨(.hook, 9), 90⟩] = [⟨(.hook, 5), 50⟩, ⟨(.hook, 9), 90⟩] := by
  decide

/-- Removing the last hook prunes its account row along with its record. -/
example : syncAccount [⟨1, .hook, 5, 50⟩] 1 [] true 0 [⟨(.hook, 5), 50⟩] = [] := by decide

/-- A hook the dashboard recreated under a name stage 1 records is a different row,
so the prune keeps it. -/
example : syncAccount [⟨1, .hook, 5, 50⟩] 1 [] true 0 [⟨(.hook, 5), 51⟩] =
    [⟨(.hook, 5), 51⟩] := by decide

/-- `deploy --prune` of an empty manifest removes the MCP server stage 1 recorded and
keeps the one made on the dashboard. -/
example : syncMcp [⟨1, .mcp, 3, 30⟩] 1 [] true 0 [⟨1, 3, 30⟩, ⟨1, 4, 40⟩] =
    [⟨1, 4, 40⟩] := by decide

end Broods.SyncExternal
