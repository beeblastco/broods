/-!
# SDK manifest sync

Model of `broods dev` / `broods deploy`. The CLI PUTs the whole manifest with a
`prune` flag (`packages/broods/src/sync.ts` `putManifest`). The server upserts every
resource by name and, with prune, drops CLI-managed rows the manifest no longer
declares (`packages/convex/model/cliSyncResources.ts`). `GET /manifest` reads the
CLI-managed rows back, and `diffManifests` compares them with the local manifest.

Simplifications: names are `Nat`, a config is its settings plus an optional
artifact bundle, env refs are already normalized, the diff is unsorted (sorting
is a permutation), and server-side rename matching is left out.
-/

namespace Broods.Sync

inductive Kind where
  | agent | workspace | sandbox | cron | skill | hook | mcp | policy | channelRecord
  deriving DecidableEq, Repr

/-- What equality sees of a resource config: its settings and, for skills, hooks
and hosted MCP servers, the bundle or file bytes. -/
structure Config where
  settings : Nat
  bundle : Option Nat
  deriving DecidableEq, Repr

structure Resource where
  kind : Kind
  name : Nat
  config : Config
  deriving DecidableEq, Repr

abbrev Manifest := List Resource

inductive Op where
  | create | update | delete | rename
  deriving DecidableEq, Repr

/-- A `DiffEntry`. -/
structure Entry where
  op : Op
  kind : Kind
  name : Nat
  deriving DecidableEq, Repr

/-- A server row for one resource; `cli` is `managedBy === "cli"`. -/
structure Row where
  res : Resource
  cli : Bool
  deriving DecidableEq, Repr

abbrev State := List Row

def Resource.key (r : Resource) : Kind × Nat := (r.kind, r.name)

/-- Upsert by name: the same-name row is replaced and becomes CLI-managed,
including a row the dashboard created. -/
def upsert (store : Resource → Resource) (s : State) (r : Resource) : State :=
  ⟨store r, true⟩ :: s.filter (fun row => row.res.key != r.key)

def lookup (m : Manifest) (k : Kind × Nat) : Option Resource := m.find? (·.key == k)

/-- A manifest declares each `kind:name` once (`assertUniqueResources`). -/
def Manifest.unique (m : Manifest) : Prop :=
  ∀ x ∈ m, ∀ y ∈ m, x.key = y.key → x = y

/-- `diffManifests`: updates, greedy renames, creates, deletes. -/
def diff (localM remote : Manifest) : List Entry :=
  let ul := unmatched localM remote
  let ur := unmatched remote localM
  let pairs := renames ul ur
  updates localM remote ++ pairs.map (fun (x, _) => ⟨.rename, x.kind, x.name⟩) ++
    (ul.filter fun x => !pairs.any (·.1.key == x.key)).map (fun x => ⟨.create, x.kind, x.name⟩) ++
    (ur.filter fun y => !pairs.any (·.2.key == y.key)).map (fun y => ⟨.delete, y.kind, y.name⟩)
where
  /-- Resources on both sides whose snapshots differ. -/
  updates (localM remote : Manifest) : List Entry :=
    localM.filterMap fun x =>
      match lookup remote x.key with
      | some y => if snapshot y == snapshot x then none else some ⟨.update, x.kind, x.name⟩
      | none => none
  /-- Resources in `a` with no same-key resource in `b`. -/
  unmatched (a b : Manifest) : Manifest := a.filter fun x => (lookup b x.key).isNone
  /-- `snapshotResource`: skill and hook bytes are not compared. -/
  snapshot (r : Resource) : Resource :=
    if r.kind == .skill || r.kind == .hook then { r with config := { r.config with bundle := none } }
    else r
  /-- First-fit rename pairing in local order, as in `diffManifests`. -/
  renames (ul ur : Manifest) : List (Resource × Resource) :=
    ul.foldl (fun acc x =>
      match ur.find? (fun y => !acc.any (·.2.key == y.key) && renamable x.kind &&
          x.kind == y.kind && (snapshot x).config == (snapshot y).config) with
      | some y => acc ++ [(x, y)]
      | none => acc) []
  renamable : Kind → Bool
    | .agent | .workspace | .sandbox | .policy => true
    | _ => false

/-- `GET /manifest`: the CLI-managed rows. -/
def read (s : State) : Manifest := (s.filter (·.cli)).map (·.res)

/-- `PUT /manifest`. `store` is what the server keeps and reads back for a resource. -/
def sync (store : Resource → Resource) (m : Manifest) (prune : Bool) (s : State) : State :=
  let upserted := m.foldl (upsert store) s
  if prune then upserted.filter (fun row => !row.cli || m.any (·.key == row.res.key))
  else upserted

/-! ## Lemmas -/

section
variable {store : Resource → Resource}

/-- The CLI-managed row with key `k`, as `read` sees it. -/
private def lookupRow (s : State) (k : Kind × Nat) : Option Row :=
  s.find? (fun row => row.cli && row.res.key == k)

private theorem lookup_read (s : State) (k : Kind × Nat) :
    lookup (read s) k = (lookupRow s k).map (·.res) := by
  induction s with
  | nil => rfl
  | cons row rest ih =>
    simp only [read, lookupRow, lookup] at ih ⊢
    cases hc : row.cli <;> by_cases hk : row.res.key = k <;>
      simp_all

private theorem find?_filter_same {p q : Row → Bool} (s : State)
    (h : ∀ row, p row = true → q row = true) :
    (s.filter q).find? p = s.find? p := by
  induction s with
  | nil => rfl
  | cons row rest ih =>
    by_cases hp : p row = true
    · simp [hp, h row hp]
    · cases hq : q row <;> simp_all

private theorem find?_filter_none {p q : Row → Bool} (s : State)
    (h : ∀ row, p row = true → q row = false) : (s.filter q).find? p = none := by
  rw [List.find?_eq_none]
  intro row hrow hp
  have := (List.mem_filter.mp hrow).2
  simp_all

private theorem lookupRow_upsert (hkey : ∀ r, (store r).key = r.key)
    (s : State) (r : Resource) (k : Kind × Nat) :
    lookupRow (upsert store s r) k =
      if r.key = k then some ⟨store r, true⟩ else lookupRow s k := by
  by_cases hk : r.key = k
  · simp [lookupRow, upsert, hkey, hk]
  · have hk' : (r.key == k) = false := by simpa using hk
    simp only [hk, ite_false]
    simp only [lookupRow, upsert, List.find?_cons, hkey, Bool.true_and, hk']
    exact find?_filter_same s (fun row hp => by
      simp only [Bool.and_eq_true, beq_iff_eq] at hp
      simp only [bne_iff_ne, ne_eq]
      intro heq
      exact hk (heq ▸ hp.2))

private theorem lookupRow_fold (hkey : ∀ r, (store r).key = r.key)
    (m : Manifest) (s : State) (k : Kind × Nat) :
    lookupRow (m.foldl (upsert store) s) k =
      match m.reverse.find? (·.key == k) with
      | some x => some ⟨store x, true⟩
      | none => lookupRow s k := by
  induction m generalizing s with
  | nil => rfl
  | cons x xs ih =>
    rw [List.foldl_cons, ih, lookupRow_upsert hkey, List.reverse_cons, List.find?_append]
    cases xs.reverse.find? (·.key == k) <;> by_cases hk : x.key = k <;> simp [hk]

private theorem find_self {m : Manifest} (hu : m.unique) {x : Resource} (hx : x ∈ m) :
    m.reverse.find? (·.key == x.key) = some x := by
  cases h : m.reverse.find? (·.key == x.key) with
  | none =>
    rw [List.find?_eq_none] at h
    exact absurd (by simp) (h x (List.mem_reverse.mpr hx))
  | some y =>
    have hy := List.mem_reverse.mp (List.mem_of_find?_eq_some h)
    have hk := List.find?_some h
    simp only [beq_iff_eq] at hk
    rw [hu y hy x hx hk]

private theorem lookup_self {m : Manifest} {x : Resource} (hx : x ∈ m) :
    (lookup m x.key).isSome := by
  cases h : lookup m x.key with
  | none =>
    simp only [lookup, List.find?_eq_none] at h
    exact absurd (by simp) (h x hx)
  | some _ => rfl

/-- After a sync every declared resource reads back as its stored form. -/
private theorem lookup_after_sync (hkey : ∀ r, (store r).key = r.key)
    {m : Manifest} (hu : m.unique) (prune : Bool) (s : State) {x : Resource} (hx : x ∈ m) :
    lookup (read (sync store m prune s)) x.key = some (store x) := by
  rw [lookup_read]
  have hfold : lookupRow (m.foldl (upsert store) s) x.key = some ⟨store x, true⟩ := by
    rw [lookupRow_fold hkey, find_self hu hx]
  cases prune
  · simp [sync, hfold]
  · simp only [sync, ite_true, lookupRow]
    rw [find?_filter_same]
    · simp only [lookupRow] at hfold
      simp [hfold]
    · intro row hp
      simp only [Bool.and_eq_true, beq_iff_eq] at hp
      simp only [Bool.or_eq_true, Bool.not_eq_true', List.any_eq_true, beq_iff_eq]
      exact Or.inr ⟨x, hx, hp.2.symm⟩

/-- When every local resource reads back unchanged, the diff is only deletes. -/
private theorem diff_of_lookups {m r : Manifest}
    (hl : ∀ x ∈ m, ∃ y, lookup r x.key = some y ∧ diff.snapshot y = diff.snapshot x) :
    diff m r = (diff.unmatched r m).map (fun y => ⟨.delete, y.kind, y.name⟩) := by
  have hupd : diff.updates m r = [] := by
    rw [diff.updates, List.filterMap_eq_nil_iff]
    intro x hx
    obtain ⟨y, hy, hs⟩ := hl x hx
    simp [hy, hs]
  have hul : diff.unmatched m r = [] := by
    rw [diff.unmatched, List.filter_eq_nil_iff]
    intro x hx
    obtain ⟨y, hy, _⟩ := hl x hx
    simp [hy]
  simp only [diff, hupd, hul, diff.renames, List.foldl_nil, List.any_nil, Bool.not_false,
    List.filter_nil, List.map_nil, List.nil_append]
  congr 1
  exact List.filter_eq_self.mpr (fun _ _ => rfl)

/-! ## Properties -/

/-- `dev` and `deploy` converge: when the server reads back what it was given (up to
what the diff compares), the next `broods diff` holds only deletes, and none at all
after a pruning sync. -/
theorem sync_converges (hkey : ∀ r, (store r).key = r.key)
    (hsnap : ∀ r, diff.snapshot (store r) = diff.snapshot r)
    {m : Manifest} (hu : m.unique) (prune : Bool) (s : State) :
    (∀ e ∈ diff m (read (sync store m prune s)), e.op = .delete) ∧
      (prune = true → diff m (read (sync store m prune s)) = []) := by
  have hd := diff_of_lookups (m := m) (r := read (sync store m prune s))
    (fun x hx => ⟨store x, lookup_after_sync hkey hu prune s hx, hsnap x⟩)
  refine ⟨fun e he => ?_, fun hp => ?_⟩
  · rw [hd, List.mem_map] at he
    obtain ⟨_, _, rfl⟩ := he
    rfl
  · subst hp
    rw [hd, List.map_eq_nil_iff, diff.unmatched, List.filter_eq_nil_iff]
    intro y hy
    simp only [read, sync, ite_true, List.mem_map, List.mem_filter] at hy
    obtain ⟨row, ⟨⟨_, hkeep⟩, _⟩, rfl⟩ := hy
    simp only [Bool.or_eq_true, Bool.not_eq_true', List.any_eq_true, beq_iff_eq] at hkeep
    rcases hkeep with hc | ⟨x, hx, hk⟩
    · simp_all
    · have hs := lookup_self hx
      rw [hk] at hs
      cases hl : lookup m row.res.key <;> simp_all

end

/-! ## Findings, as executable witnesses -/

/-- Server read-back for external kinds: `snapshotExternalConfig` drops the bundle. -/
def storeExternal (r : Resource) : Resource :=
  if r.kind == .skill || r.kind == .hook || r.kind == .mcp then
    { r with config := { r.config with bundle := none } }
  else r

/-- The client strips bytes for skills and hooks but not hosted MCP servers, so a
hosted MCP server never converges: every `diff` and `dev` prints `update mcp:X`. -/
example :
    let m : Manifest := [⟨.mcp, 1, ⟨0, some 42⟩⟩]
    diff m (read (sync storeExternal m true [])) = [⟨.update, .mcp, 1⟩] := by
  decide

/-- An account hook row (`accountHooks`), with the stage that declares it. -/
structure Hook where
  name : Nat
  stage : Nat
  deriving DecidableEq, Repr

/-- `syncHookResources` with prune: it returns early when the manifest declares no
hooks, and otherwise prunes every account hook not declared by this manifest. -/
def syncHooks (desired : List Nat) (stage : Nat) (prune : Bool) (hooks : List Hook) :
    List Hook :=
  if desired.isEmpty then hooks
  else
    let kept := if prune then hooks.filter (fun h => desired.contains h.name) else hooks
    kept ++ (desired.filter fun n => !kept.any (·.name == n)).map (⟨·, stage⟩)

/-- With a login token, `deploy --prune` on stage 1 deletes hook 9 that stage 2 declares. -/
example : syncHooks [5] 1 true [⟨5, 1⟩, ⟨9, 2⟩] = [⟨5, 1⟩] := by decide

/-- Removing the last hook never prunes it: the account row survives while the stage
snapshot row is deleted, so `broods diff` shows nothing to do. -/
example : syncHooks [] 1 true [⟨5, 1⟩] = [⟨5, 1⟩] := by decide

end Broods.Sync
