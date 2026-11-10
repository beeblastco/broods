import Spec.Runtime.Theorems

/-!
Controls, checked by the kernel: each removes one real check from the runtime and proves the matching
theorem false. So the theorems depend on those checks, and do not hold merely by how the model is built.
-/

namespace Spec.Runtime.Controls

/-- One agent, enough to break by hand. -/
def small : Config :=
  [{ account := 1, agent := 2, tools := [3], sandboxes := [4] }]

/-- An agent row with nothing in it, for runs a broken step makes up. -/
def blank (account : AccountId) (agent : AgentId) : AgentConfig :=
  { account := account, agent := agent, tools := [], sandboxes := [] }

/-- The runtime with its account step replaced, otherwise the same. -/
def withStep (replace : AccountState → Input → AccountState × List Effect) : Spec.System where
  State := World
  Input := Input
  Effect := Effect
  init := emptyWorld
  step := fun w i =>
    let account := i.account
    let result := replace (w account) i
    (fun a => if a = account then { result.1 with log := i :: (w account).log } else w a, result.2)

/-- Drops `assertConversationScope`: a request may name another account's conversation. -/
def noScope (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c _ _ ag conv id arrival =>
    admit s (rootRun c.account ag conv id (blank c.account ag) [] []) c.account arrival
  | i => accountStep cfg s i

/-- `tenant_isolation` fails without the conversation scope check: account 1 holds a run in a
conversation of account 9. -/
theorem no_scope_check_breaks_isolation :
    ¬ Spec.Always (withStep (noScope small)) fun w => ∀ a, ∀ r ∈ (w a).runs,
      r.conversation.account = a := by
  intro holds
  let conversation : Conversation := { account := 9, agent := 2, name := 0 }
  let trace : List Input :=
    [.request { kind := .account, account := 1 } {} {} 2 conversation 7 {}]
  have state := holds _ ⟨trace, rfl⟩ 1
  have broken := state { rootRun 1 2 conversation 7 (blank 1 2) [] [] with status := .running }
    (by
      simp [trace, withStep, System.final, System.runFrom, noScope, admit, promote, busy, nextQueued,
        emptyWorld, Input.account])
  simp [rootRun, conversation] at broken

/-- Drops the owner check: a new run always starts. -/
def noOwnerCheck (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c _ _ ag conv id _ =>
    let run := { rootRun c.account ag conv id (blank c.account ag) [] [] with status := .running }
    ({ s with runs := s.runs ++ [run] }, [.started c.account id id])
  | i => accountStep cfg s i

/-- `conversation_exclusive` fails without the owner check: two runs own one conversation. -/
theorem no_owner_check_breaks_exclusive :
    ¬ Spec.Always (withStep (noOwnerCheck small)) fun w => ∀ a, ∀ x ∈ (w a).runs, ∀ y ∈ (w a).runs,
      x.status = .running → y.status = .running → x.conversation = y.conversation → x = y := by
  intro holds
  let conversation : Conversation := { account := 1, agent := 2, name := 0 }
  let credential : Access.Credential := { kind := .account, account := 1 }
  let trace : List Input :=
    [.request credential {} {} 2 conversation 7 {}, .request credential {} {} 2 conversation 8 {}]
  have state := holds _ ⟨trace, rfl⟩ 1
  have broken := state
    { rootRun 1 2 conversation 7 (blank 1 2) [] [] with status := .running }
    (by simp [trace, withStep, System.final, System.runFrom, noOwnerCheck, emptyWorld, Input.account,
      credential])
    { rootRun 1 2 conversation 8 (blank 1 2) [] [] with status := .running }
    (by simp [trace, withStep, System.final, System.runFrom, noOwnerCheck, emptyWorld, Input.account,
      credential])
    rfl rfl rfl
  have ids := congrArg Run.id broken
  simp [rootRun] at ids

/-- Drops credential resolution: any request starts a run. -/
def noCredentialCheck (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c _ _ ag conv id arrival =>
    admit s (rootRun c.account ag conv id (blank c.account ag) [] []) c.account arrival
  | i => accountStep cfg s i

/-- `sound_effects` fails without credential resolution: an invalid credential causes an effect that
no input authorises. -/
theorem no_credential_check_breaks_soundness :
    ¬ ∀ (trace : List Input) (i : Input) (e : Effect),
      e ∈ ((withStep (noCredentialCheck small)).step ((withStep (noCredentialCheck small)).final trace) i).2 →
        ∃ w ∈ trace ++ [i], Authorizes small w e.account e.root := by
  intro holds
  let bad : Access.Credential := { kind := .account, account := 1, valid := false }
  let request : Input := .request bad {} {} 2 { account := 1, agent := 2, name := 0 } 7 {}
  obtain ⟨w, hw, ha⟩ := holds [] request (.started 1 7 7)
    (by
      simp [withStep, System.final, System.runFrom, noCredentialCheck, admit, promote, busy, nextQueued,
        emptyWorld, rootRun, request, bad, Input.account]
      exact List.mem_singleton.2 rfl)
  simp only [List.nil_append, List.mem_singleton] at hw
  subst hw
  obtain ⟨_, _, auth, _, hres, _⟩ := ha
  simp [startAuth, Access.resolve, bad] at hres

/-- Drops `mayStart`: any credential that resolves starts a run, as the model did before. -/
def noStartScope (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c r route ag conv id arrival =>
    match startAuth c r route with
    | some _ => admit s (rootRun c.account ag conv id (blank c.account ag) [] []) c.account arrival
    | none => (s, [])
  | i => accountStep cfg s i

/-- `sound_effects` fails without `mayStart`: a run token (`brt_`) starts a run, and no input
authorises it, since `integrations.ts` answers a run token with its scope and never starts a run. -/
theorem no_start_scope_breaks_soundness :
    ¬ ∀ (trace : List Input) (i : Input) (e : Effect),
      e ∈ ((withStep (noStartScope small)).step ((withStep (noStartScope small)).final trace) i).2 →
        ∃ w ∈ trace ++ [i], Authorizes small w e.account e.root := by
  intro holds
  let token : Access.Credential := { kind := .run, account := 1 }
  let request : Input := .request token {} {} 2 { account := 1, agent := 2, name := 0 } 7 {}
  obtain ⟨w, hw, ha⟩ := holds [] request (.started 1 7 7)
    (by
      simp [withStep, System.final, System.runFrom, noStartScope, startAuth, Access.resolve, admit,
        promote, busy, nextQueued, emptyWorld, rootRun, request, token, Input.account]
      exact List.mem_singleton.2 rfl)
  simp only [List.nil_append, List.mem_singleton] at hw
  subst hw
  obtain ⟨_, _, auth, entry, hres, _, _, hmay⟩ := ha
  simp [startAuth, Access.resolve, token] at hres
  subst hres
  simp [mayStart] at hmay

/-- Agent 2 denies tool 3 and may spawn agent 5, which has tool 3. -/
def parentDenies : Config :=
  [{ account := 1, agent := 2, tools := [3], sandboxes := [4], deny := [3], subagents := some [5] },
    { account := 1, agent := 5, tools := [3], sandboxes := [4] }]

/-- Drops the parent's `denyTools` from a spawned child, keeping the child's own. -/
def noDenyInherit (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .spawn account parent target child persistent arrival =>
    match liveRun s.runs parent with
    | none => (s, [])
    | some p =>
      match childRun cfg account { p with deny := [] } target child with
      | none => (s, [])
      | some c => if persistent then arrive s c account arrival else detach s c account
  | i => accountStep cfg s i

/-- `delegation_bounded` fails without inheriting the parent's denials: agent 2's run spawns agent 5,
whose child run holds tool 3 that agent 2 denies. -/
theorem no_deny_inherit_breaks_delegation :
    ¬ Spec.Always (withStep (noDenyInherit parentDenies)) fun w => ∀ a, ∀ c ∈ (w a).runs, ∀ pid,
      c.parent = some pid → ∃ p ∈ (w a).runs, p.id = pid ∧ ∀ t ∈ c.tools, t ∉ p.deny := by
  intro holds
  let trace : List Input :=
    [.request { kind := .account, account := 1 } {} {} 2 { account := 1, agent := 2, name := 0 } 7 {},
      .spawn 1 7 (.named 5) 8 false {}]
  have state := holds _ ⟨trace, rfl⟩ 1
  simp [trace, withStep, System.final, System.runFrom, noDenyInherit, accountStep, requestRun,
    startAuth, Access.resolve, Access.authAccount, mayStart, parentDenies, Config.lookup, arrive,
    fresh, admit, promote, busy, nextQueued, rootRun, liveRun, childRun, detach, emptyWorld,
    Channels.allowedTools, Input.account] at state

/-- `mayStart` without the stage and public checks: a resolved stage credential reaches any agent. -/
def anyStage (auth : Access.Auth) (route : DirectRoute) : Bool :=
  route.directApi && match auth with
    | .account _ _ => route.urlStage.isNone
    | .deployment _ => true
    | _ => false

/-- `requestRun` with `anyStage` in place of `mayStart`. -/
def noStageScope (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c r route ag conv id arrival =>
    match startAuth c r route, cfg.lookup c.account ag with
    | some auth, some entry =>
      if anyStage auth route && conv.account == c.account && conv.agent == ag then
        arrive s (rootRun c.account ag conv id entry entry.deny entry.sandboxes) c.account arrival
      else (s, [])
    | _, _ => (s, [])
  | i => accountStep cfg s i

/-- `stage_credential_scope` fails without the stage check: an embeddable `bsk_` key of stage 5
starts agent 2, a private agent of stage 0. -/
theorem no_stage_scope_breaks_stage_scope :
    let key : Access.Credential := { kind := .runtime, account := 1, stage := 5 }
    let request : Input := .request key {} {} 2 { account := 1, agent := 2, name := 0 } 7 {}
    Effect.started 1 7 7 ∈ (noStageScope small { runs := [], log := [] } request).2 ∧
      ¬ ∃ entry, small.lookup 1 2 = some entry ∧ entry.stage = key.stage ∧ entry.publicAccess = true := by
  refine ⟨?_, ?_⟩
  · simp [noStageScope, startAuth, Access.resolve, anyStage, small, Config.lookup, arrive, fresh, admit,
      promote, busy, nextQueued, rootRun]
  · simp [small, Config.lookup]

/-- The `/mcp` path is live: an AuthKit sign-in, which the direct API refuses
(`authkit_only_through_mcp`), starts a run through `/mcp`. -/
theorem mcp_signin_starts :
    Effect.started 1 7 7 ∈ (accountStep small { runs := [], log := [] }
      (.request { kind := .authkit, account := 1 } {} { mcp := true } 2
        { account := 1, agent := 2, name := 0 } 7 {})).2 := by
  simp [accountStep, requestRun, startAuth, Access.mcpResolve, Access.resolve, Access.authAccount,
    mayStart, small, Config.lookup, arrive, fresh, admit, promote, busy, nextQueued, rootRun]

/-- `recover_drains` needs its account-active hypothesis: request 7 owns, request 8 queues, 7 is
released, the account is suspended, and the sweep skips it, leaving 8 queued with no owner. -/
theorem inactive_queue_stays_unowned :
    ¬ Spec.Progress (system small) (fun _ => True)
      (fun _ schedule => ∃ pre, schedule = pre ++ [.recover 1 { account := 1, agent := 2, name := 0 }])
      (fun _ => True)
      (fun w => ∀ r ∈ (w 1).runs, r.status = .queued →
        r.conversation = { account := 1, agent := 2, name := 0 } →
        busy (w 1).runs { account := 1, agent := 2, name := 0 } = true) := by
  intro holds
  let key : Access.Credential := { kind := .account, account := 1 }
  let conversation : Conversation := { account := 1, agent := 2, name := 0 }
  let pre : List Input :=
    [.request key {} {} 2 conversation 7 {}, .request key {} {} 2 conversation 8 {}, .release 1 7,
      .status 1 false]
  let entry : AgentConfig := { account := 1, agent := 2, tools := [3], sandboxes := [4] }
  have done := holds [] trivial trivial (pre ++ [.recover 1 conversation]) ⟨pre, rfl⟩
    { rootRun 1 2 conversation 8 entry [] [4] with status := .queued }
    (by
      simp [pre, System.final, System.runFrom, system, step, accountStep, requestRun, startAuth,
        Access.resolve, Access.authAccount, mayStart, small, Config.lookup, arrive, fresh, admit,
        promote, busy, nextQueued, ownerRun, setStatus, emptyWorld, Input.account, key, conversation,
        rootRun, entry])
    rfl rfl
  simp [pre, System.final, System.runFrom, system, step, accountStep, requestRun, startAuth,
    Access.resolve, Access.authAccount, mayStart, small, Config.lookup, arrive, fresh, admit, promote,
    busy, nextQueued, ownerRun, setStatus, emptyWorld, Input.account, key, conversation, rootRun] at done

/-- A public agent 2 of stage 0. -/
def publicAgent : Config :=
  [{ account := 1, agent := 2, tools := [3], sandboxes := [4], publicAccess := true }]

/-- An embeddable key whose user token lists its conversations starts a run over the direct API but
not through `/mcp`, where `listRunnableAgents` returns no agent. -/
theorem listed_user_token_only_direct :
    let key : Access.Credential :=
      { kind := .runtime, account := 1, userPresent := true, userConversations := true }
    let conversation : Conversation := { account := 1, agent := 2, name := 0 }
    Effect.started 1 7 7 ∈ (accountStep publicAgent { runs := [], log := [] }
        (.request key {} {} 2 conversation 7 {})).2 ∧
      accountStep publicAgent { runs := [], log := [] }
        (.request key {} { mcp := true } 2 conversation 7 {}) = ({ runs := [], log := [] }, []) := by
  refine ⟨?_, ?_⟩ <;>
    simp [accountStep, requestRun, startAuth, Access.mcpResolve, Access.resolve, Access.authAccount,
      mayStart, publicAgent, Config.lookup, arrive, fresh, admit, promote, busy, nextQueued, rootRun]

/-- Request 7 owns, request 8 queues behind it, the account is suspended, and 7 settles. -/
def suspendedSettle (handoff : Handoff) : List Input :=
  let key : Access.Credential := { kind := .account, account := 1 }
  let conversation : Conversation := { account := 1, agent := 2, name := 0 }
  [.request key {} {} 2 conversation 7 {}, .request key {} {} 2 conversation 8 {}, .status 1 false,
    .settle 1 7 false handoff]

/-- In an inactive account no hand-off hands on: 8 stays queued with no owner, so `settle_hands_on`
needs its account-active hypothesis. Replays `inactive-settle-drain` and `inactive-inline-takeNext`
show the same in Convex. -/
theorem inactive_settle_strands (handoff : Handoff) :
    let w := (system small).final (suspendedSettle handoff)
    (∃ r ∈ (w 1).runs, r.id = 8 ∧ r.status = .queued) ∧
      busy (w 1).runs { account := 1, agent := 2, name := 0 } = false := by
  cases handoff <;>
    simp [suspendedSettle, System.final, System.runFrom, system, step, accountStep, requestRun,
      startAuth, Access.resolve, Access.authAccount, mayStart, small, Config.lookup, arrive, fresh,
      admit, promote, busy, nextQueued, liveRun, endRun, settledStatus, setStatus, emptyWorld,
      Input.account, rootRun]

/-- A background run in an inactive account loses its outcome (its refused settle leaves the envelope
to expire, `failed` here), and its queue waits: 8 stays queued. -/
theorem inactive_background_settle_loses_outcome :
    let w := (system small).final (suspendedSettle .background)
    (∃ r ∈ (w 1).runs, r.id = 7 ∧ r.status = .failed) ∧
      ∃ r ∈ (w 1).runs, r.id = 8 ∧ r.status = .queued := by
  simp [suspendedSettle, System.final, System.runFrom, system, step, accountStep, requestRun,
    startAuth, Access.resolve, Access.authAccount, mayStart, small, Config.lookup, arrive, fresh, admit,
    promote, busy, nextQueued, liveRun, endRun, settledStatus, setStatus, emptyWorld,
    Input.account, rootRun]

/-- The account step with a settle that hands on whatever the account, as `takeNext` did before
it checked the account. -/
def drainAlways (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .settle account id failed handoff =>
    match liveRun s.runs id with
    | none => (s, [])
    | some run => endRun s account run (settledStatus s.active handoff failed) true
  | i => accountStep cfg s i

/-- With `drainAlways`, a drain in a suspended account starts 8, so `inactive_starts_nothing` needs
`takeNext` to check the account. -/
theorem drain_always_starts :
    let pre := (system small).final ((suspendedSettle .drain).take 3)
    Effect.started 1 8 8 ∈ (drainAlways small (pre 1) (.settle 1 7 false .drain)).2 := by
  simp [suspendedSettle, System.final, System.runFrom, system, step, accountStep, requestRun,
    startAuth, Access.resolve, Access.authAccount, mayStart, small, Config.lookup, arrive, fresh, admit,
    promote, busy, nextQueued, liveRun, endRun, settledStatus, setStatus, emptyWorld,
    Input.account, rootRun, drainAlways]

/-- `detach` without the account check: a non-persistent child starts in any account. -/
def detachUnchecked (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .spawn account parent target child false _ =>
    match liveRun s.runs parent with
    | none => (s, [])
    | some p =>
      match childRun cfg account p target child with
      | none => (s, [])
      | some c =>
        if !fresh s.runs c.id then (s, [])
        else ({ s with runs := s.runs ++ [{ c with status := .detached }] },
          [.started account c.id c.root])
  | i => accountStep cfg s i

/-- With `detachUnchecked`, a running run's non-persistent child starts in a suspended account, so
`inactive_starts_nothing` needs `detach` to check the account; the real step starts nothing. -/
theorem detach_without_check_starts :
    let key : Access.Credential := { kind := .account, account := 1 }
    let conversation : Conversation := { account := 1, agent := 2, name := 0 }
    let delegating : Config :=
      [{ account := 1, agent := 2, tools := [3], sandboxes := [4], subagents := some [] }]
    let pre := (system delegating).final [.request key {} {} 2 conversation 7 {}, .status 1 false]
    Effect.started 1 9 7 ∈ (detachUnchecked delegating (pre 1) (.spawn 1 7 (.virtual 5) 9 false {})).2 ∧
      (accountStep delegating (pre 1) (.spawn 1 7 (.virtual 5) 9 false {})).2 = [] := by
  simp [System.final, System.runFrom, system, step, accountStep, requestRun, startAuth,
    Access.resolve, Access.authAccount, mayStart, Config.lookup, arrive, fresh, admit, promote, busy,
    nextQueued, liveRun, emptyWorld, Input.account, rootRun, childRun, detach, detachUnchecked]

/-- A shed dispatch strands nothing for good: 7 owns, 8 queues, 7's dispatch is shed and requeued, so
both wait with no owner; the next recovery sweep promotes 7 again, ahead of 8. -/
theorem requeue_then_recover :
    let key : Access.Credential := { kind := .account, account := 1 }
    let conversation : Conversation := { account := 1, agent := 2, name := 0 }
    let shed := (system small).final
      [.request key {} {} 2 conversation 7 {}, .request key {} {} 2 conversation 8 {}, .requeue 1 7]
    let swept := (system small).final
      [.request key {} {} 2 conversation 7 {}, .request key {} {} 2 conversation 8 {}, .requeue 1 7,
        .recover 1 conversation]
    busy (shed 1).runs conversation = false ∧ (shed 1).runs.map (·.status) = [.queued, .queued] ∧
      (swept 1).runs.map (·.status) = [.running, .queued] := by
  simp [System.final, System.runFrom, system, step, accountStep, requestRun, startAuth,
    Access.resolve, Access.authAccount, mayStart, small, Config.lookup, arrive, fresh, admit, promote,
    busy, nextQueued, ownerRun, setStatus, emptyWorld, Input.account, rootRun]

end Spec.Runtime.Controls
