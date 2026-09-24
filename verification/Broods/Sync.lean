/-!
# SDK manifest sync

Model of `broods dev` / `broods deploy` against one stage. The CLI PUTs the whole
manifest with a `prune` flag (`packages/broods/src/sync.ts` `putManifest`). The
server upserts every resource by name, claims an undeclared CLI row with the same
content as a rename, and with prune drops the CLI-managed rows the manifest no
longer declares (`packages/convex/model/cliSyncResources.ts`, and
`recordExternalResourcesBySecretHash` for skills, hooks and MCP servers).
`GET /manifest` reads the CLI-managed rows back, and `diffManifests` compares them
with the local manifest.

Simplifications: names are `Nat`, a config is its settings plus artifact bytes,
env refs are already normalized, and the diff is unsorted (sorting is a
permutation). The account-wide rows behind skills and hooks are in
`Broods.SyncExternal`, crons in `Broods.SyncCron`, env vars in `Broods.SyncEnv`,
and two sessions at once in `Broods.SyncConcurrency`.
-/

namespace Broods.Sync

/-- `CliManifestResource.kind` (`packages/convex/cli/types.ts`). -/
inductive Kind where
  | agent | workspace | sandbox | cron | skill | hook | mcp | policy | channelRecord
  deriving DecidableEq, Repr

/-- What equality sees of a resource config: its settings, the inline bytes
(`bundle`, `contentBase64`), and the `{ bundleStorageId, sha256 }` pair a large
MCP bundle is uploaded as. -/
structure Config where
  settings : Nat
  bundle : Option Nat
  storage : Option Nat
  deriving DecidableEq, Repr

/-- A `CliManifestResource`, its name reduced to a `Nat`. -/
structure Resource where
  kind : Kind
  name : Nat
  config : Config
  deriving DecidableEq, Repr

/-- `CliManifest.resources`. -/
abbrev Manifest := List Resource

/-- `DiffOperation` (`packages/broods/src/sync.ts`). -/
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

/-- The stage's rows the server reconciles, across every resource family. -/
abbrev State := List Row

/-- Skills, hooks and MCP servers: account-service resources whose bytes the
server does not keep in the manifest snapshot. -/
def Kind.external : Kind → Bool
  | .skill | .hook | .mcp => true
  | _ => false

/-- Kinds the server and the diff pair up as renames. -/
def Kind.renamable : Kind → Bool
  | .agent | .workspace | .sandbox | .policy => true
  | _ => false

/-- The `${kind}:${name}` key `diffManifests` and `assertUniqueResources` use. -/
def Resource.key (r : Resource) : Kind × Nat := (r.kind, r.name)

/-- The resource with key `k`, as the `Map` lookups in `diffManifests` find it. -/
def lookup (m : Manifest) (k : Kind × Nat) : Option Resource := m.find? (·.key == k)

/-- A manifest declares each `kind:name` once (`assertUniqueResources`). -/
def Manifest.unique (m : Manifest) : Prop :=
  ∀ x ∈ m, ∀ y ∈ m, x.key = y.key → x = y

/-- An undeclared CLI row the server may rename to `r`: same kind, same stored
content, and a name the manifest no longer declares. -/
def claimable (store : Resource → Resource) (m : Manifest) (r : Resource) (row : Row) : Bool :=
  row.cli && r.kind.renamable && row.res.kind == r.kind &&
    !m.any (·.key == row.res.key) && row.res.config == (store r).config

/-- Upsert by name. With no same-name row, the first claimable row is renamed to
`r`. Either way the row becomes CLI-managed, including one the dashboard made. -/
def upsert (store : Resource → Resource) (m : Manifest) (s : State) (r : Resource) : State :=
  let gone :=
    if s.any (·.res.key == r.key) then none
    else (s.find? (claimable store m r)).map (·.res.key)
  ⟨store r, true⟩ :: s.filter (fun row => row.res.key != r.key && some row.res.key != gone)

/-- `diffManifests`: updates, greedy renames, creates, deletes. -/
def diff (localM remote : Manifest) : List Entry :=
  let ul := unmatched localM remote
  let ur := unmatched remote localM
  let pairs := renames ul ur
  updates localM remote ++ pairs.map (fun (x, _) => ⟨.rename, x.kind, x.name⟩) ++
    (ul.filter fun x => !pairs.any (·.1.key == x.key)).map (fun x => ⟨.create, x.kind, x.name⟩) ++
    (ur.filter fun y => !pairs.any (·.2.key == y.key)).map (fun y => ⟨.delete, y.kind, y.name⟩)
where
  /-- `snapshotResource`: artifact bytes and the large-bundle storage pair of
  skills, hooks and MCP servers are not compared. -/
  snapshot (r : Resource) : Resource :=
    if r.kind.external then { r with config := { r.config with bundle := none, storage := none } }
    else r
  /-- First-fit rename pairing in local order, as in `diffManifests`. -/
  renames (ul ur : Manifest) : List (Resource × Resource) :=
    ul.foldl (fun acc x =>
      match ur.find? (fun y => !acc.any (·.2.key == y.key) && x.kind.renamable &&
          x.kind == y.kind && (snapshot x).config == (snapshot y).config) with
      | some y => acc ++ [(x, y)]
      | none => acc) []
  /-- Resources on both sides whose snapshots differ. -/
  updates (localM remote : Manifest) : List Entry :=
    localM.filterMap fun x =>
      match lookup remote x.key with
      | some y => if snapshot y == snapshot x then none else some ⟨.update, x.kind, x.name⟩
      | none => none
  /-- Resources in `a` with no same-key resource in `b`. -/
  unmatched (a b : Manifest) : Manifest := a.filter fun x => (lookup b x.key).isNone

/-- `GET /manifest`: the CLI-managed rows. -/
def read (s : State) : Manifest := (s.filter (·.cli)).map (·.res)

/-- `PUT /manifest`. `store` is what the server keeps and reads back for a resource. -/
def sync (store : Resource → Resource) (m : Manifest) (prune : Bool) (s : State) : State :=
  let upserted := m.foldl (upsert store m) s
  if prune then upserted.filter (fun row => !row.cli || m.any (·.key == row.res.key))
  else upserted

/-- `externalizeLargeMcpBundles`: after the diff, a large MCP bundle is uploaded and
replaced by its storage pair. -/
def upload (large : Nat → Bool) (r : Resource) : Resource :=
  match r.kind, r.config.bundle with
  | .mcp, some b =>
    if large b then { r with config := { r.config with bundle := none, storage := some b } } else r
  | _, _ => r

/-- `snapshotExternalConfig`: the recorded snapshot of an external resource drops
its bytes and keeps everything else. -/
def storeExternal (r : Resource) : Resource :=
  if r.kind.external then { r with config := { r.config with bundle := none } } else r

/-- What the server keeps for a resource: external kinds as their recorded
snapshot of the uploaded config, every other kind through `normalize`. -/
def storeReal (large : Nat → Bool) (normalize : Resource → Resource) (r : Resource) : Resource :=
  if r.kind.external then storeExternal (upload large r) else normalize r

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

/-- A renamed-away row is never one the manifest declares. -/
private theorem claimable_undeclared {m : Manifest} {r : Resource} {row : Row}
    (h : claimable store m r row = true) : ∀ x ∈ m, x.key ≠ row.res.key := by
  intro x hx heq
  simp only [claimable, Bool.and_eq_true, Bool.not_eq_true', List.any_eq_false,
    beq_iff_eq] at h
  exact h.1.2 x hx heq

private theorem lookupRow_upsert (hkey : ∀ r, (store r).key = r.key)
    {m : Manifest} (s : State) (r : Resource) {k : Kind × Nat} (hk : ∃ x ∈ m, x.key = k) :
    lookupRow (upsert store m s r) k =
      if r.key = k then some ⟨store r, true⟩ else lookupRow s k := by
  by_cases hrk : r.key = k
  · simp [lookupRow, upsert, hkey, hrk]
  · have hrk' : (r.key == k) = false := by simpa using hrk
    simp only [hrk, ite_false]
    simp only [lookupRow, upsert, List.find?_cons, hkey, Bool.true_and, hrk']
    refine find?_filter_same s (fun row hp => ?_)
    simp only [Bool.and_eq_true, beq_iff_eq] at hp
    obtain ⟨x, hx, hxk⟩ := hk
    have hne : row.res.key ≠ r.key := fun heq => hrk (heq ▸ hp.2)
    simp only [Bool.and_eq_true, bne_iff_ne, ne_eq, hne, not_false_eq_true, true_and]
    split
    · simp
    · cases hf : s.find? (claimable store m r) with
      | none => simp
      | some old =>
        have hold := claimable_undeclared (List.find?_some hf) x hx
        simp only [Option.map_some, Option.some.injEq]
        intro heq
        exact hold (hxk.trans (hp.2.symm.trans heq))

private theorem lookupRow_fold (hkey : ∀ r, (store r).key = r.key)
    {m : Manifest} (l : Manifest) (s : State) {k : Kind × Nat} (hk : ∃ x ∈ m, x.key = k) :
    lookupRow (l.foldl (upsert store m) s) k =
      match l.reverse.find? (·.key == k) with
      | some x => some ⟨store x, true⟩
      | none => lookupRow s k := by
  induction l generalizing s with
  | nil => rfl
  | cons x xs ih =>
    rw [List.foldl_cons, ih, lookupRow_upsert hkey _ _ hk, List.reverse_cons, List.find?_append]
    cases xs.reverse.find? (·.key == k) <;> by_cases hxk : x.key = k <;> simp [hxk]

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

theorem lookup_self {m : Manifest} {x : Resource} (hx : x ∈ m) :
    (lookup m x.key).isSome := by
  cases h : lookup m x.key with
  | none =>
    simp only [lookup, List.find?_eq_none] at h
    exact absurd (by simp) (h x hx)
  | some _ => rfl

/-- After a sync every declared resource reads back as its stored form. -/
theorem lookup_after_sync (hkey : ∀ r, (store r).key = r.key)
    {m : Manifest} (hu : m.unique) (prune : Bool) (s : State) {x : Resource} (hx : x ∈ m) :
    lookup (read (sync store m prune s)) x.key = some (store x) := by
  rw [lookup_read]
  have hfold : lookupRow (m.foldl (upsert store m) s) x.key = some ⟨store x, true⟩ := by
    rw [lookupRow_fold hkey m s ⟨x, hx, rfl⟩, find_self hu hx]
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

/-- `dev` and `deploy` converge, with the server's rename matching in play: when
the server reads back what it was given (up to what the diff compares), the next
`broods diff` holds only deletes, and none at all after a pruning sync. -/
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

/-- Skills, hooks and MCP servers, small or large bundle, read back equal to what
the diff compares. -/
theorem storeExternal_snapshot (large : Nat → Bool) (r : Resource) (h : r.kind.external = true) :
    diff.snapshot (storeExternal (upload large r)) = diff.snapshot r := by
  obtain ⟨kind, name, ⟨settings, bundle, storage⟩⟩ := r
  cases bundle with
  | none => cases kind <;> simp_all [upload, storeExternal, diff.snapshot, Kind.external]
  | some b =>
    by_cases hl : large b <;> cases kind <;>
      simp_all [upload, storeExternal, diff.snapshot, Kind.external]

/-- Upload and the recorded snapshot keep a resource's key. -/
theorem storeExternal_key (large : Nat → Bool) (r : Resource) :
    (storeExternal (upload large r)).key = r.key := by
  have hu : (upload large r).key = r.key := by
    unfold upload
    split <;> (try split) <;> rfl
  rw [← hu]
  unfold storeExternal
  split <;> rfl

/-- The fixed sync converges for every kind: external kinds with the server's real
snapshot and upload, every other kind given its normalization round trip. -/
theorem sync_converges_real (large : Nat → Bool) (normalize : Resource → Resource)
    (hkey : ∀ r, (normalize r).key = r.key)
    (hround : ∀ r, r.kind.external = false → diff.snapshot (normalize r) = diff.snapshot r)
    {m : Manifest} (hu : m.unique) (prune : Bool) (s : State) :
    (∀ e ∈ diff m (read (sync (storeReal large normalize) m prune s)), e.op = .delete) ∧
      (prune = true → diff m (read (sync (storeReal large normalize) m prune s)) = []) := by
  refine sync_converges (fun r => ?_) (fun r => ?_) hu prune s
  · unfold storeReal
    split
    · exact storeExternal_key large r
    · exact hkey r
  · unfold storeReal
    split
    · exact storeExternal_snapshot large r (by assumption)
    · exact hround r (by simpa using ‹¬r.kind.external = true›)

/-! ## Findings, fixed, as executable witnesses -/

/-- A hosted MCP server now converges: small bundles are stored without their
bytes, large ones as a storage pair, and the diff compares neither. -/
example :
    let m : Manifest := [⟨.mcp, 1, ⟨0, some 42, none⟩⟩]
    diff m (read (sync (storeReal (· > 10) id) m true [])) = [] ∧
      diff m (read (sync (storeReal (· > 100) id) m true [])) = [] := by
  decide

/-- The server renames an undeclared CLI agent with the same content instead of
creating a second one, and the next diff is empty. -/
example :
    let old : Resource := ⟨.agent, 1, ⟨7, none, none⟩⟩
    let m : Manifest := [⟨.agent, 2, ⟨7, none, none⟩⟩]
    let s := sync id m false [⟨old, true⟩]
    read s = m ∧ diff m (read s) = [] := by
  decide

end Broods.Sync
