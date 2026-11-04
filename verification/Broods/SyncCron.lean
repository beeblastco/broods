/-!
# Crons in a manifest sync

Model of how a manifest sync treats crons. `desiredCrons`
(`packages/convex/cli/httpRoutes.ts`) keys each cron by its resource name, whatever
`config.name` says. The main sync prunes undeclared agents and deletes their crons with
them (`deleteAgentRow` in `packages/convex/model/agentSync.ts`). `syncCrons` then lets
each job claim the stage cron under its own name, patches it as `managedBy: "cli"`
(adopting one an agent made under that name), creates the rest, and with prune drops
the stage agents' unclaimed CLI-managed crons by id. A cron an agent scheduled at
runtime or the dashboard made survives the prune.
-/

namespace Broods.SyncCron

/-- A `crons` row; `id` is its `_id`, `cli` is `managedBy === "cli"`. -/
structure Cron where
  name : Nat
  agent : Nat
  id : Nat
  cli : Bool
  deriving DecidableEq, Repr

/-- The account's agents and crons. -/
structure Server where
  agents : List Nat
  crons : List Cron
  deriving DecidableEq, Repr

/-- A cron resource as a manifest carries it. -/
structure CronResource where
  resourceName : Nat
  configName : Option Nat
  agent : Nat
  deriving DecidableEq, Repr

/-- One entry of `desiredCrons`. -/
structure DesiredCron where
  name : Nat
  agent : Nat
  deriving DecidableEq, Repr

/-- `desiredCrons`: a cron is keyed by its resource name; `config.name` plays no part. -/
def desiredCrons (rs : List CronResource) : List DesiredCron :=
  rs.map fun r => ⟨r.resourceName, r.agent⟩

/-- Every cron targets an agent that exists. -/
def Server.noOrphans (s : Server) : Prop := ∀ c ∈ s.crons, c.agent ∈ s.agents

/-- `pruneAgents`: undeclared stage agents go, and their crons with them. -/
def pruneAgents (stageAgents declared : List Nat) (s : Server) : Server :=
  { agents := s.agents.filter (fun a => !(stageAgents.contains a && !declared.contains a))
    crons := s.crons.filter (fun c => !(stageAgents.contains c.agent && !declared.contains c.agent)) }

/-- `stageCronByName`: the first stage agent's cron named `n`. -/
def byName (stageAgents : List Nat) (cs : List Cron) (n : Nat) : Option Cron :=
  cs.find? fun c => stageAgents.contains c.agent && c.name == n

/-- The `syncCrons` loop's claims, in job order: the stage cron each job holds by its
own name. -/
def claims (stageAgents : List Nat) (existing : List Cron) (ds : List DesiredCron) :
    List (DesiredCron × Option Nat) :=
  ds.map fun d => (d, (byName stageAgents existing d.name).map (·.id))

/-- A cron after the loop: patched and marked CLI-managed by the job that claimed
it, or else untouched. -/
def patch (cl : List (DesiredCron × Option Nat)) (c : Cron) : Cron :=
  match cl.find? (·.2 == some c.id) with
  | some p => { c with name := p.1.name, agent := p.1.agent, cli := true }
  | none => c

/-- `syncCrons`: patch every claimed cron, create the jobs that claimed nothing (ids from
`fresh` up, CLI-managed), and with prune drop the stage agents' CLI-managed crons no
job claimed. -/
def syncCrons (stageAgents : List Nat) (desired : List DesiredCron) (prune : Bool)
    (fresh : Nat) (s : Server) : Server :=
  let cl := claims stageAgents s.crons desired
  let rows := if prune then
    s.crons.filter (fun c =>
      !c.cli || !stageAgents.contains c.agent || cl.any (·.2 == some c.id))
    else s.crons
  let created := (cl.filter (·.2.isNone)).mapIdx
    fun i p => (⟨p.1.name, p.1.agent, fresh + i, true⟩ : Cron)
  { s with crons := rows.map (patch cl) ++ created }

/-! ## Properties -/

theorem pruneAgents_noOrphans {stageAgents declared : List Nat} {s : Server}
    (h : s.noOrphans) : (pruneAgents stageAgents declared s).noOrphans := by
  intro c hc
  simp only [pruneAgents, List.mem_filter] at hc ⊢
  exact ⟨h c hc.1, hc.2⟩

/-- Every claim is one of the jobs. -/
theorem claims_mem {stageAgents : List Nat} {existing : List Cron} {ds : List DesiredCron}
    {p : DesiredCron × Option Nat} (h : p ∈ claims stageAgents existing ds) : p.1 ∈ ds := by
  obtain ⟨d, hd, rfl⟩ := List.mem_map.mp h
  exact hd

/-- A created cron carries a job's name and agent. -/
theorem created_job {cl : List (DesiredCron × Option Nat)} {fresh : Nat} {c : Cron}
    (h : c ∈ (cl.filter (·.2.isNone)).mapIdx
      fun i p => (⟨p.1.name, p.1.agent, fresh + i, true⟩ : Cron)) :
    ∃ p ∈ cl, c.name = p.1.name ∧ c.agent = p.1.agent := by
  obtain ⟨i, hi, rfl⟩ := List.mem_mapIdx.mp h
  exact ⟨_, (List.mem_filter.mp (List.getElem_mem hi)).1, rfl, rfl⟩

/-- `desiredCrons` refuses a cron whose agent is not deployed, so a sync that runs
keeps every cron pointing at a live agent. -/
theorem syncCrons_noOrphans {stageAgents : List Nat} {desired : List DesiredCron}
    {prune : Bool} {fresh : Nat} {s : Server} (h : s.noOrphans)
    (hd : ∀ d ∈ desired, d.agent ∈ s.agents) :
    (syncCrons stageAgents desired prune fresh s).noOrphans := by
  intro c hc
  simp only [syncCrons, List.mem_append, List.mem_map] at hc
  rcases hc with ⟨c0, hc0, rfl⟩ | hc
  · have hs : c0 ∈ s.crons := by
      split at hc0
      · exact (List.mem_filter.mp hc0).1
      · exact hc0
    unfold patch
    split
    · rename_i p hfind
      exact hd _ (claims_mem (List.mem_of_find?_eq_some hfind))
    · exact h c0 hs
  · obtain ⟨p, hp, _, hagent⟩ := created_job hc
    exact hagent ▸ hd _ (claims_mem hp)

/-- A pruning sync, agents first and crons after, leaves no cron without its agent. -/
theorem sync_noOrphans {stageAgents declared : List Nat} {desired : List DesiredCron}
    {fresh : Nat} {s : Server} (h : s.noOrphans)
    (hd : ∀ d ∈ desired, d.agent ∈ (pruneAgents stageAgents declared s).agents) :
    (syncCrons stageAgents desired true fresh (pruneAgents stageAgents declared s)).noOrphans :=
  syncCrons_noOrphans (pruneAgents_noOrphans h) hd

/-- After a pruning sync the stage agents' CLI-managed crons are exactly the declared
names: an unclaimed one is pruned by id, whatever its name. -/
theorem syncCrons_converges {stageAgents : List Nat} {desired : List DesiredCron}
    {fresh : Nat} {s : Server} {c : Cron} (hc : stageAgents.contains c.agent = true)
    (hcli : c.cli = true) :
    c ∈ (syncCrons stageAgents desired true fresh s).crons →
      desired.any (·.name == c.name) = true := by
  intro h
  simp only [syncCrons, ite_true, List.mem_append, List.mem_map] at h
  rcases h with ⟨c0, hc0, rfl⟩ | h
  · have hkeep := (List.mem_filter.mp hc0).2
    unfold patch at hc hcli ⊢
    split
    · rename_i p hfind
      exact List.any_eq_true.mpr
        ⟨p.1, claims_mem (List.mem_of_find?_eq_some hfind), by simp⟩
    · rename_i hnone
      simp only [hnone] at hc hcli
      simp only [hc, hcli, Bool.not_true, Bool.false_or] at hkeep
      obtain ⟨p, hp, hpe⟩ := List.any_eq_true.mp hkeep
      exact absurd hpe (List.find?_eq_none.mp hnone p hp)
  · obtain ⟨p, hp, hname, _⟩ := created_job h
    exact List.any_eq_true.mpr ⟨p.1, claims_mem hp, by simp [hname]⟩

/-- After a pruning sync every CLI-managed stage cron carries the name of a declared
cron resource, the key the diff and the generated ids use. -/
theorem sync_resource_names {stageAgents : List Nat} {rs : List CronResource}
    {fresh : Nat} {s : Server} {c : Cron} (hc : stageAgents.contains c.agent = true)
    (hcli : c.cli = true)
    (h : c ∈ (syncCrons stageAgents (desiredCrons rs) true fresh s).crons) :
    ∃ r ∈ rs, r.resourceName = c.name := by
  have hany := syncCrons_converges hc hcli h
  simp only [List.any_eq_true, beq_iff_eq, desiredCrons, List.mem_map] at hany
  obtain ⟨_, ⟨r, hr, rfl⟩, hname⟩ := hany
  exact ⟨r, hr, hname⟩

/-- A pruning sync keeps every cron an agent scheduled or the dashboard made, by id:
patched in place when a job claims its name, untouched otherwise. -/
theorem syncCrons_keeps_unmanaged {stageAgents : List Nat} {desired : List DesiredCron}
    {prune : Bool} {fresh : Nat} {s : Server} {c : Cron} (hc : c ∈ s.crons)
    (hcli : c.cli = false) :
    ∃ c' ∈ (syncCrons stageAgents desired prune fresh s).crons, c'.id = c.id := by
  have hrow : c ∈ (if prune then
      s.crons.filter (fun c => !c.cli || !stageAgents.contains c.agent ||
        (claims stageAgents s.crons desired).any (·.2 == some c.id))
      else s.crons) := by
    cases prune
    · exact hc
    · exact List.mem_filter.mpr ⟨hc, by simp [hcli]⟩
  refine ⟨patch (claims stageAgents s.crons desired) c,
    List.mem_append_left _ (List.mem_map.mpr ⟨c, hrow, rfl⟩), ?_⟩
  unfold patch
  split <;> rfl

/-! ## Witnesses -/

/-- A stray `config.name` does not split the key: the cron is keyed `1`. -/
example : desiredCrons [⟨1, some 9, 2⟩] = [⟨1, 2⟩] := by decide

/-- A cron stored under another name is not found by `config.name`: a pruning sync
replaces it, so the job still fires once. -/
example : syncCrons [2] (desiredCrons [⟨1, some 9, 2⟩]) true 0 ⟨[2], [⟨9, 2, 5, true⟩]⟩ =
    ⟨[2], [⟨1, 2, 0, true⟩]⟩ := by decide

/-- A cron under the job's name is patched in place and a stray one beside it pruned. -/
example : syncCrons [2] [⟨1, 2⟩] true 0 ⟨[2], [⟨1, 2, 5, true⟩, ⟨9, 2, 6, true⟩]⟩ =
    ⟨[2], [⟨1, 2, 5, true⟩]⟩ := by decide

/-- An agent's own cron survives the prune; one under a declared name is adopted. -/
example : syncCrons [2] [⟨1, 2⟩] true 0 ⟨[2], [⟨1, 2, 5, false⟩, ⟨9, 2, 6, false⟩]⟩ =
    ⟨[2], [⟨1, 2, 5, true⟩, ⟨9, 2, 6, false⟩]⟩ := by decide

/-- Pruning agent 2 takes its cron along, an agent's own included, instead of leaving
it to fire at nothing. -/
example : pruneAgents [1, 2] [1] ⟨[1, 2], [⟨7, 2, 5, false⟩]⟩ = ⟨[1], []⟩ := by decide

end Broods.SyncCron
