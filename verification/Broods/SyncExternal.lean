import Broods.Sync

/-!
# Account-wide external resources

Model of the account rows behind a manifest's skills, hooks and MCP servers
(`syncExternalResources` in `packages/convex/cli/httpRoutes.ts`). Skills (S3) and
hooks (`accountHooks`) are account-wide and keyed by name; MCP servers are rows
scoped to one stage. Which stage manages an account-wide name is recorded in
`cliExternalResources`.
-/

namespace Broods.SyncExternal

open Broods.Sync (Kind)

/-- A `cliExternalResources` row: `stage` records `kind:name` as CLI-managed. -/
structure Record where
  stage : Nat
  kind : Kind
  name : Nat
  deriving DecidableEq, Repr

/-- An active account-wide row: an `accountHooks` row or an S3 skill. -/
abbrev Key := Kind × Nat

/-- An active `mcp` row of one stage. -/
structure McpRow where
  stage : Nat
  name : Nat
  deriving DecidableEq, Repr

/-- `externalOwnership(...).owned`: `stage` records the key and no other stage does. -/
def owned (recs : List Record) (stage : Nat) (k : Key) : Bool :=
  recs.any (fun r => r.stage == stage && (r.kind, r.name) == k) &&
    !recs.any (fun r => r.stage != stage && (r.kind, r.name) == k)

/-- `syncSkillResources` and `syncHookResources`: upsert the declared names, and
with prune remove only undeclared names this stage alone owns. Runs with prune
even when the manifest declares none. -/
def syncAccount (recs : List Record) (stage : Nat) (desired : List Key) (prune : Bool)
    (rows : List Key) : List Key :=
  let upserted := rows ++ desired.filter (fun k => !rows.contains k)
  if prune then upserted.filter (fun k => desired.contains k || !owned recs stage k)
  else upserted

/-- `syncMcpResources`: upsert by name within the stage (`listForStage`), and with
prune remove the stage's undeclared servers. Other stages' rows are never read. -/
def syncMcp (stage : Nat) (desired : List Nat) (prune : Bool) (rows : List McpRow) :
    List McpRow :=
  let upserted := rows ++ (desired.filter fun n => !rows.contains ⟨stage, n⟩).map (⟨stage, ·⟩)
  if prune then upserted.filter (fun row => row.stage != stage || desired.contains row.name)
  else upserted

/-! ## Properties -/

/-- A declared name is present after the sync. -/
theorem desired_present {recs : List Record} {stage : Nat} {desired : List Key} {prune : Bool}
    {rows : List Key} {k : Key} (hk : k ∈ desired) :
    k ∈ syncAccount recs stage desired prune rows := by
  have hup : k ∈ rows ++ desired.filter (fun k => !rows.contains k) := by
    by_cases hr : k ∈ rows
    · exact List.mem_append_left _ hr
    · exact List.mem_append_right _ (List.mem_filter.mpr ⟨hk, by simpa using hr⟩)
  cases prune
  · simpa [syncAccount] using hup
  · simp only [syncAccount, ite_true, List.mem_filter]
    exact ⟨hup, by simp [hk]⟩

/-- A prune keeps every row this stage does not solely own. -/
theorem kept_unless_owned {recs : List Record} {stage : Nat} {desired : List Key} {prune : Bool}
    {rows : List Key} {k : Key} (hr : k ∈ rows) (ho : owned recs stage k = false) :
    k ∈ syncAccount recs stage desired prune rows := by
  cases prune
  · simp [syncAccount, hr]
  · simp [syncAccount, hr, ho]

/-- Pruning stage A never removes a hook or skill another stage records. -/
theorem prune_keeps_other_stage {recs : List Record} {stage : Nat} {desired : List Key}
    {prune : Bool} {rows : List Key} {k : Key} (hr : k ∈ rows)
    (hother : ∃ r ∈ recs, r.stage ≠ stage ∧ (r.kind, r.name) = k) :
    k ∈ syncAccount recs stage desired prune rows := by
  refine kept_unless_owned hr ?_
  obtain ⟨r, hmem, hs, hk⟩ := hother
  have : recs.any (fun r => r.stage != stage && (r.kind, r.name) == k) = true :=
    List.any_eq_true.mpr ⟨r, hmem, by simp [hs, hk]⟩
  simp [owned, this]

/-- Nor one no stage records, such as a hook made on the dashboard. -/
theorem prune_keeps_unrecorded {recs : List Record} {stage : Nat} {desired : List Key}
    {prune : Bool} {rows : List Key} {k : Key} (hr : k ∈ rows)
    (hnone : ∀ r ∈ recs, (r.kind, r.name) ≠ k) :
    k ∈ syncAccount recs stage desired prune rows := by
  refine kept_unless_owned hr ?_
  have : recs.any (fun r => r.stage == stage && (r.kind, r.name) == k) = false :=
    List.any_eq_false.mpr (fun r hmem h => hnone r hmem (by simp_all))
  simp [owned, this]

/-- After a prune, a name this stage owns is present exactly when it is declared,
also when the manifest declares none: no account row outlives its record. -/
theorem prune_owned_agrees {recs : List Record} {stage : Nat} {desired : List Key}
    {rows : List Key} {k : Key} (ho : owned recs stage k = true) :
    k ∈ syncAccount recs stage desired true rows ↔ k ∈ desired := by
  refine ⟨fun h => ?_, desired_present⟩
  simp only [syncAccount, ite_true, List.mem_filter, ho, Bool.not_true, Bool.or_false,
    List.contains_iff_mem] at h
  exact h.2

/-- Syncing MCP servers for stage A leaves every other stage's servers alone. -/
theorem mcp_other_stage {stage : Nat} {desired : List Nat} {prune : Bool} {rows : List McpRow}
    {row : McpRow} (hr : row ∈ rows) (hs : row.stage ≠ stage) :
    row ∈ syncMcp stage desired prune rows := by
  cases prune
  · simp [syncMcp, hr]
  · simp [syncMcp, hr, hs]

/-- A prune removes the stage's last MCP server too. -/
theorem mcp_prune_empty {stage : Nat} {rows : List McpRow} :
    ∀ row ∈ syncMcp stage [] true rows, row.stage ≠ stage := by
  intro row h
  simp only [syncMcp, ite_true, List.mem_filter, List.contains_nil, Bool.or_false,
    bne_iff_ne] at h
  exact h.2

/-! ## Findings, fixed, as executable witnesses -/

/-- `deploy --prune` on stage 1 keeps hook 9, which stage 2 records. -/
example : syncAccount [⟨1, .hook, 5⟩, ⟨2, .hook, 9⟩] 1 [(.hook, 5)] true
    [(.hook, 5), (.hook, 9)] = [(.hook, 5), (.hook, 9)] := by decide

/-- Removing the last hook now prunes its account row along with its record. -/
example : syncAccount [⟨1, .hook, 5⟩] 1 [] true [(.hook, 5)] = [] := by decide

end Broods.SyncExternal
