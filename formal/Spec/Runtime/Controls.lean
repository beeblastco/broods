import Spec.Runtime.Theorems

/-!
Controls, checked by the kernel: each removes one real check from the runtime and proves the matching
theorem false. So the theorems depend on those checks, and do not hold merely by how the model is built.
-/

namespace Spec.Runtime.Controls

/-- One agent, enough to break by hand. -/
def small : Config :=
  [{ account := 1, agent := 2, tools := [3], sandboxes := [4] }]

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
  | .request c _ ag conv id _ => admit s (rootRun c.account ag conv id [] []) c.account
  | i => accountStep cfg s i

/-- `tenant_isolation` fails without the conversation scope check: account 1 holds a run in a
conversation of account 9. -/
theorem no_scope_check_breaks_isolation :
    ¬ Spec.Always (withStep (noScope small)) fun w => ∀ a, ∀ r ∈ (w a).runs,
      r.conversation.account = a := by
  intro holds
  let trace : List Input :=
    [.request { kind := .account, account := 1 } {} 2 { account := 9, agent := 2, name := 0 } 7 true]
  have state := holds _ ⟨trace, rfl⟩ 1
  have broken := state (rootRun 1 2 { account := 9, agent := 2, name := 0 } 7 [] [] |>.status |>
    fun st => { (rootRun 1 2 { account := 9, agent := 2, name := 0 } 7 [] []) with status := .running })
    (by simp [trace, withStep, System.final, System.runFrom, noScope, admit, busy, emptyWorld, Input.account])
  simp [rootRun] at broken

/-- Drops the owner check: a new run always starts. -/
def noOwnerCheck (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c _ ag conv id _ =>
    let run := { (rootRun c.account ag conv id [] []) with status := .running }
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
    [.request credential {} 2 conversation 7 true, .request credential {} 2 conversation 8 true]
  have state := holds _ ⟨trace, rfl⟩ 1
  have broken := state
    { (rootRun 1 2 conversation 7 [] []) with status := .running }
    (by simp [trace, withStep, System.final, System.runFrom, noOwnerCheck, emptyWorld, Input.account, credential])
    { (rootRun 1 2 conversation 8 [] []) with status := .running }
    (by simp [trace, withStep, System.final, System.runFrom, noOwnerCheck, emptyWorld, Input.account, credential])
    rfl rfl rfl
  have ids := congrArg Run.id broken
  simp [rootRun] at ids

/-- Drops credential resolution: any request starts a run. -/
def noCredentialCheck (cfg : Config) (s : AccountState) : Input → AccountState × List Effect
  | .request c _ ag conv id _ => admit s (rootRun c.account ag conv id [] []) c.account
  | i => accountStep cfg s i

/-- `sound_effects` fails without credential resolution: an invalid credential causes an effect that
no input authorises. -/
theorem no_credential_check_breaks_soundness :
    ¬ ∀ (trace : List Input) (i : Input) (e : Effect),
      e ∈ ((withStep (noCredentialCheck small)).step ((withStep (noCredentialCheck small)).final trace) i).2 →
        ∃ w ∈ trace ++ [i], Authorizes w e.account e.root := by
  intro holds
  let bad : Access.Credential := { kind := .account, account := 1, valid := false }
  let request : Input := .request bad {} 2 { account := 1, agent := 2, name := 0 } 7 true
  obtain ⟨w, hw, ha⟩ := holds [] request (.started 1 7 7)
    (by
      simp [withStep, System.final, System.runFrom, noCredentialCheck, admit, busy, emptyWorld, rootRun,
        request, bad, Input.account]
      exact List.mem_singleton.2 rfl)
  simp only [List.nil_append, List.mem_singleton] at hw
  subst hw
  obtain ⟨_, _, auth, hres, _⟩ := ha
  simp [Access.resolve, bad] at hres

end Spec.Runtime.Controls
