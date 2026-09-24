/-!
# Crons in a manifest sync

Model of how a manifest sync treats crons. `desiredCrons`
(`packages/convex/cli/httpRoutes.ts`) keys each cron by its resource name, whatever
`config.name` says. The main sync prunes undeclared agents and deletes their crons
with them (`deleteAgentRow` in `packages/convex/model/agentSync.ts`). `syncCrons`
then upserts by name among the stage agents' crons and, with prune, drops the stage
agents' undeclared crons.
-/

namespace Broods.SyncCron

/-- A `crons` row. -/
structure Cron where
  name : Nat
  agent : Nat
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

/-- `desiredCrons`: a cron is keyed by its resource name. -/
def desiredCrons (rs : List CronResource) : List Cron :=
  rs.map fun r => ⟨r.resourceName, r.agent⟩

/-- Every cron targets an agent that exists. -/
def Server.noOrphans (s : Server) : Prop := ∀ c ∈ s.crons, c.agent ∈ s.agents

/-- `pruneAgents`: undeclared stage agents go, and their crons with them. -/
def pruneAgents (stageAgents declared : List Nat) (s : Server) : Server :=
  { agents := s.agents.filter (fun a => !(stageAgents.contains a && !declared.contains a))
    crons := s.crons.filter (fun c => !(stageAgents.contains c.agent && !declared.contains c.agent)) }

/-- `syncCrons`: upsert declared crons by name among the stage agents' crons, and
with prune drop the stage agents' undeclared crons. -/
def syncCrons (stageAgents : List Nat) (desired : List Cron) (prune : Bool) (s : Server) :
    Server :=
  let declared (c : Cron) := desired.any (·.name == c.name)
  let crons := s.crons.filter (fun c => !(stageAgents.contains c.agent && declared c)) ++ desired
  { s with
    crons := if prune then crons.filter (fun c => !stageAgents.contains c.agent || declared c)
      else crons }

/-! ## Properties -/

theorem pruneAgents_noOrphans {stageAgents declared : List Nat} {s : Server}
    (h : s.noOrphans) : (pruneAgents stageAgents declared s).noOrphans := by
  intro c hc
  simp only [pruneAgents, List.mem_filter] at hc ⊢
  exact ⟨h c hc.1, hc.2⟩

/-- `desiredCrons` refuses a cron whose agent is not deployed, so a sync that runs
keeps every cron pointing at a live agent. -/
theorem syncCrons_noOrphans {stageAgents : List Nat} {desired : List Cron} {prune : Bool}
    {s : Server} (h : s.noOrphans) (hd : ∀ c ∈ desired, c.agent ∈ s.agents) :
    (syncCrons stageAgents desired prune s).noOrphans := by
  have hall : ∀ c ∈ s.crons.filter (fun c => !(stageAgents.contains c.agent &&
      desired.any (·.name == c.name))) ++ desired, c.agent ∈ s.agents := by
    intro c hc
    rcases List.mem_append.mp hc with hc | hc
    · exact h c (List.mem_filter.mp hc).1
    · exact hd c hc
  intro c hc
  cases prune
  · exact hall c hc
  · exact hall c (List.mem_filter.mp hc).1

/-- A pruning sync, agents first and crons after, leaves no cron without its agent. -/
theorem sync_noOrphans {stageAgents declared : List Nat} {desired : List Cron} {s : Server}
    (h : s.noOrphans)
    (hd : ∀ c ∈ desired, c.agent ∈ (pruneAgents stageAgents declared s).agents) :
    (syncCrons stageAgents desired true (pruneAgents stageAgents declared s)).noOrphans :=
  syncCrons_noOrphans (pruneAgents_noOrphans h) hd

/-- After a pruning sync the stage agents' crons are exactly the declared names. -/
theorem syncCrons_converges {stageAgents : List Nat} {desired : List Cron} {s : Server}
    {c : Cron} (hc : stageAgents.contains c.agent = true) :
    c ∈ (syncCrons stageAgents desired true s).crons →
      desired.any (·.name == c.name) = true := by
  intro h
  simp only [syncCrons, ite_true, List.mem_filter, hc, Bool.not_true, Bool.false_or] at h
  exact h.2

/-- After a pruning sync every stage cron carries the name of a declared cron
resource, the key the diff and the generated ids use. -/
theorem sync_resource_names {stageAgents : List Nat} {rs : List CronResource} {s : Server}
    {c : Cron} (hc : stageAgents.contains c.agent = true)
    (h : c ∈ (syncCrons stageAgents (desiredCrons rs) true s).crons) :
    ∃ r ∈ rs, r.resourceName = c.name := by
  have hany := syncCrons_converges hc h
  simp only [List.any_eq_true, beq_iff_eq, desiredCrons, List.mem_map] at hany
  obtain ⟨_, ⟨r, hr, rfl⟩, hname⟩ := hany
  exact ⟨r, hr, hname⟩

/-! ## Witnesses -/

/-- A stray `config.name` does not split the key: the cron is keyed `1`, not `9`. -/
example : desiredCrons [⟨1, some 9, 2⟩] = [⟨1, 2⟩] := by decide

/-- Pruning agent 2 takes its cron along instead of leaving it to fire at nothing. -/
example : pruneAgents [1, 2] [1] ⟨[1, 2], [⟨7, 2⟩]⟩ = ⟨[1], []⟩ := by decide

end Broods.SyncCron
