/-!
# Crons in a manifest sync

Model of how a manifest sync treats crons. `desiredCrons`
(`packages/convex/cli/httpRoutes.ts`) keys each cron by its resource name, whatever
`config.name` says, and carries a different `config.name` as the legacy name an older
sync created the cron under. The main sync prunes undeclared agents and deletes their
crons with them (`deleteAgentRow` in `packages/convex/model/agentSync.ts`). `syncCrons`
then lets each job claim one stage cron, by its own name first and by legacy name only
among unclaimed rows, patches it, which renames a legacy one in place, creates the
rest, and with prune drops the stage agents' unclaimed crons by id.
-/

namespace Broods.SyncCron

/-- A `crons` row; `id` is its `_id`. -/
structure Cron where
  name : Nat
  agent : Nat
  id : Nat
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

/-- One entry of `desiredCrons`: the job, and the `legacyName` it may exist under. -/
structure DesiredCron where
  name : Nat
  agent : Nat
  legacy : Option Nat
  deriving DecidableEq, Repr

/-- `desiredCrons`: a cron is keyed by its resource name; a different `config.name`
is only a legacy name to find it by. -/
def desiredCrons (rs : List CronResource) : List DesiredCron :=
  rs.map fun r => ⟨r.resourceName, r.agent, r.configName.filter (· != r.resourceName)⟩

/-- Every cron targets an agent that exists. -/
def Server.noOrphans (s : Server) : Prop := ∀ c ∈ s.crons, c.agent ∈ s.agents

/-- `pruneAgents`: undeclared stage agents go, and their crons with them. -/
def pruneAgents (stageAgents declared : List Nat) (s : Server) : Server :=
  { agents := s.agents.filter (fun a => !(stageAgents.contains a && !declared.contains a))
    crons := s.crons.filter (fun c => !(stageAgents.contains c.agent && !declared.contains c.agent)) }

/-- `stageCronByName`: the first stage agent's cron named `n`. -/
def byName (stageAgents : List Nat) (cs : List Cron) (n : Nat) : Option Cron :=
  cs.find? fun c => stageAgents.contains c.agent && c.name == n

/-- The `syncCrons` loop's claims, in job order: the row a job holds by its own name,
or else by its legacy name among the rows no claim holds yet. `kept` starts with every
own-name row. -/
def claims (stageAgents : List Nat) (existing : List Cron) :
    List Nat → List DesiredCron → List (DesiredCron × Option Nat)
  | _, [] => []
  | kept, d :: ds =>
    match byName stageAgents existing d.name with
    | some c => (d, some c.id) :: claims stageAgents existing kept ds
    | none =>
      match d.legacy.bind (byName stageAgents (existing.filter (!kept.contains ·.id))) with
      | some c => (d, some c.id) :: claims stageAgents existing (c.id :: kept) ds
      | none => (d, none) :: claims stageAgents existing kept ds

/-- A cron after the loop: patched with the job that claimed it, which renames a legacy
one in place, or else untouched. -/
def patch (cl : List (DesiredCron × Option Nat)) (c : Cron) : Cron :=
  match cl.find? (·.2 == some c.id) with
  | some p => { c with name := p.1.name, agent := p.1.agent }
  | none => c

/-- `syncCrons`: patch every claimed cron, create the jobs that claimed nothing (ids from
`fresh` up), and with prune drop the stage agents' crons no job claimed. -/
def syncCrons (stageAgents : List Nat) (desired : List DesiredCron) (prune : Bool)
    (fresh : Nat) (s : Server) : Server :=
  let own := desired.filterMap fun d => (byName stageAgents s.crons d.name).map (·.id)
  let cl := claims stageAgents s.crons own desired
  let rows := if prune then
    s.crons.filter (fun c => !stageAgents.contains c.agent || cl.any (·.2 == some c.id))
    else s.crons
  let created := (cl.filter (·.2.isNone)).mapIdx
    fun i p => (⟨p.1.name, p.1.agent, fresh + i⟩ : Cron)
  { s with crons := rows.map (patch cl) ++ created }

/-! ## Properties -/

theorem pruneAgents_noOrphans {stageAgents declared : List Nat} {s : Server}
    (h : s.noOrphans) : (pruneAgents stageAgents declared s).noOrphans := by
  intro c hc
  simp only [pruneAgents, List.mem_filter] at hc ⊢
  exact ⟨h c hc.1, hc.2⟩

/-- Every claim is one of the jobs. -/
theorem claims_mem {stageAgents : List Nat} {existing : List Cron} :
    ∀ {kept : List Nat} {ds : List DesiredCron} {p : DesiredCron × Option Nat},
      p ∈ claims stageAgents existing kept ds → p.1 ∈ ds
  | _, [], _, h => by simp [claims] at h
  | kept, d :: ds, p, h => by
    simp only [claims] at h
    split at h
    · rcases List.mem_cons.mp h with rfl | h
      · exact List.mem_cons_self
      · exact List.mem_cons_of_mem _ (claims_mem h)
    · split at h <;> rcases List.mem_cons.mp h with rfl | h
      all_goals first
        | exact List.mem_cons_self
        | exact List.mem_cons_of_mem _ (claims_mem h)

/-- A created cron carries a job's name and agent. -/
theorem created_job {cl : List (DesiredCron × Option Nat)} {fresh : Nat} {c : Cron}
    (h : c ∈ (cl.filter (·.2.isNone)).mapIdx
      fun i p => (⟨p.1.name, p.1.agent, fresh + i⟩ : Cron)) :
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

/-- After a pruning sync the stage agents' crons are exactly the declared names: an
unclaimed stage cron is pruned by id, whatever its name. -/
theorem syncCrons_converges {stageAgents : List Nat} {desired : List DesiredCron}
    {fresh : Nat} {s : Server} {c : Cron} (hc : stageAgents.contains c.agent = true) :
    c ∈ (syncCrons stageAgents desired true fresh s).crons →
      desired.any (·.name == c.name) = true := by
  intro h
  simp only [syncCrons, ite_true, List.mem_append, List.mem_map] at h
  rcases h with ⟨c0, hc0, rfl⟩ | h
  · have hkeep := (List.mem_filter.mp hc0).2
    unfold patch at hc ⊢
    split
    · rename_i p hfind
      exact List.any_eq_true.mpr
        ⟨p.1, claims_mem (List.mem_of_find?_eq_some hfind), by simp⟩
    · rename_i hnone
      simp only [hnone] at hc
      simp only [hc, Bool.not_true, Bool.false_or] at hkeep
      obtain ⟨p, hp, hpe⟩ := List.any_eq_true.mp hkeep
      exact absurd hpe (List.find?_eq_none.mp hnone p hp)
  · obtain ⟨p, hp, hname, _⟩ := created_job h
    exact List.any_eq_true.mpr ⟨p.1, claims_mem hp, by simp [hname]⟩

/-- After a pruning sync every stage cron carries the name of a declared cron
resource, the key the diff and the generated ids use. -/
theorem sync_resource_names {stageAgents : List Nat} {rs : List CronResource}
    {fresh : Nat} {s : Server} {c : Cron} (hc : stageAgents.contains c.agent = true)
    (h : c ∈ (syncCrons stageAgents (desiredCrons rs) true fresh s).crons) :
    ∃ r ∈ rs, r.resourceName = c.name := by
  have hany := syncCrons_converges hc h
  simp only [List.any_eq_true, beq_iff_eq, desiredCrons, List.mem_map] at hany
  obtain ⟨_, ⟨r, hr, rfl⟩, hname⟩ := hany
  exact ⟨r, hr, hname⟩

/-! ## Witnesses -/

/-- A stray `config.name` does not split the key: the cron is keyed `1`, and `9` is
only the name it may exist under. -/
example : desiredCrons [⟨1, some 9, 2⟩] = [⟨1, 2, some 9⟩] := by decide

/-- A cron an older sync created under `config.name` 9 is renamed in place: same row,
no duplicate firing next to it. -/
example : syncCrons [2] (desiredCrons [⟨1, some 9, 2⟩]) true 0 ⟨[2], [⟨9, 2, 5⟩]⟩ =
    ⟨[2], [⟨1, 2, 5⟩]⟩ := by decide

/-- A job's legacy name never takes the cron another job owns by name, even when that
job is listed first: job 2 is created instead of stealing job 1's row. -/
example : syncCrons [2] [⟨2, 2, some 1⟩, ⟨1, 2, none⟩] true 7 ⟨[2], [⟨1, 2, 5⟩]⟩ =
    ⟨[2], [⟨1, 2, 5⟩, ⟨2, 2, 7⟩]⟩ := by decide

/-- A cron under the job's name and another under its legacy name: the first is kept,
the second pruned, so the job fires once. -/
example : syncCrons [2] [⟨1, 2, some 9⟩] true 0 ⟨[2], [⟨1, 2, 5⟩, ⟨9, 2, 6⟩]⟩ =
    ⟨[2], [⟨1, 2, 5⟩]⟩ := by decide

/-- Pruning agent 2 takes its cron along instead of leaving it to fire at nothing. -/
example : pruneAgents [1, 2] [1] ⟨[1, 2], [⟨7, 2, 5⟩]⟩ = ⟨[1], []⟩ := by decide

end Broods.SyncCron
