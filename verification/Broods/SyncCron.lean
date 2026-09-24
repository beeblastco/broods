/-!
# Crons in a manifest sync

Model of how a manifest sync treats crons. `desiredCrons`
(`packages/convex/cli/httpRoutes.ts`) keys each cron by its resource name, whatever
`config.name` says, and carries a different `config.name` as the legacy name an older
sync created the cron under. The main sync prunes undeclared agents and deletes their
crons with them (`deleteAgentRow` in `packages/convex/model/agentSync.ts`). `syncCrons`
then patches the stage cron found by name, or else by legacy name, which renames it in
place, creates the rest, and with prune drops the stage agents' other crons.
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

/-- `stageCronByName` for a desired job: a stage agent's cron under the job's name,
or else under its legacy name. -/
def DesiredCron.matches (stageAgents : List Nat) (d : DesiredCron) (c : Cron) : Bool :=
  stageAgents.contains c.agent && (c.name == d.name || d.legacy == some c.name)

/-- `syncCrons`: patch each found cron with its job, which renames a legacy one in
place, create the jobs nothing matched (`fresh` is the new row's id), and with prune
drop the stage agents' crons no job kept. -/
def syncCrons (stageAgents : List Nat) (desired : List DesiredCron) (prune : Bool)
    (fresh : Nat) (s : Server) : Server :=
  let patched := s.crons.map fun c =>
    match desired.find? (·.matches stageAgents c) with
    | some d => { c with name := d.name, agent := d.agent }
    | none => c
  let created := (desired.filter fun d => !s.crons.any (d.matches stageAgents)).map
    fun d => ⟨d.name, d.agent, fresh⟩
  let crons := patched ++ created
  { s with
    crons := if prune then
      crons.filter (fun c => !stageAgents.contains c.agent || desired.any (·.name == c.name))
      else crons }

/-! ## Properties -/

theorem pruneAgents_noOrphans {stageAgents declared : List Nat} {s : Server}
    (h : s.noOrphans) : (pruneAgents stageAgents declared s).noOrphans := by
  intro c hc
  simp only [pruneAgents, List.mem_filter] at hc ⊢
  exact ⟨h c hc.1, hc.2⟩

/-- `desiredCrons` refuses a cron whose agent is not deployed, so a sync that runs
keeps every cron pointing at a live agent. -/
theorem syncCrons_noOrphans {stageAgents : List Nat} {desired : List DesiredCron}
    {prune : Bool} {fresh : Nat} {s : Server} (h : s.noOrphans)
    (hd : ∀ d ∈ desired, d.agent ∈ s.agents) :
    (syncCrons stageAgents desired prune fresh s).noOrphans := by
  have hall : ∀ c ∈ (s.crons.map fun c =>
      match desired.find? (·.matches stageAgents c) with
      | some d => { c with name := d.name, agent := d.agent }
      | none => c) ++
      (desired.filter fun d => !s.crons.any (d.matches stageAgents)).map
        (fun d => (⟨d.name, d.agent, fresh⟩ : Cron)), c.agent ∈ s.agents := by
    intro c hc
    rcases List.mem_append.mp hc with hc | hc
    · obtain ⟨c0, hc0, rfl⟩ := List.mem_map.mp hc
      split
      · rename_i d hfind
        exact hd d (List.mem_of_find?_eq_some hfind)
      · exact h c0 hc0
    · obtain ⟨d, hdm, rfl⟩ := List.mem_map.mp hc
      exact hd d (List.mem_filter.mp hdm).1
  intro c hc
  cases prune
  · exact hall c hc
  · exact hall c (List.mem_filter.mp hc).1

/-- A pruning sync, agents first and crons after, leaves no cron without its agent. -/
theorem sync_noOrphans {stageAgents declared : List Nat} {desired : List DesiredCron}
    {fresh : Nat} {s : Server} (h : s.noOrphans)
    (hd : ∀ d ∈ desired, d.agent ∈ (pruneAgents stageAgents declared s).agents) :
    (syncCrons stageAgents desired true fresh (pruneAgents stageAgents declared s)).noOrphans :=
  syncCrons_noOrphans (pruneAgents_noOrphans h) hd

/-- After a pruning sync the stage agents' crons are exactly the declared names. -/
theorem syncCrons_converges {stageAgents : List Nat} {desired : List DesiredCron}
    {fresh : Nat} {s : Server} {c : Cron} (hc : stageAgents.contains c.agent = true) :
    c ∈ (syncCrons stageAgents desired true fresh s).crons →
      desired.any (·.name == c.name) = true := by
  intro h
  simp only [syncCrons, ite_true, List.mem_filter, hc, Bool.not_true, Bool.false_or] at h
  exact h.2

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

/-- Pruning agent 2 takes its cron along instead of leaving it to fire at nothing. -/
example : pruneAgents [1, 2] [1] ⟨[1, 2], [⟨7, 2, 5⟩]⟩ = ⟨[1], []⟩ := by decide

end Broods.SyncCron
