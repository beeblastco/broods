/-!
# Env vars in `broods dev`

Model of `pushLocalEnvVars` (`packages/broods/src/cli/index.ts`), which runs
before the manifest PUT, and `assertEnvRefsResolved`
(`packages/convex/model/cliSync.ts`), which rejects the PUT when an `env()` ref
has no stage value. The stage stores a value's digest; the CLI compares digests.
-/

namespace Broods.SyncEnv

/-- `EnvRefState`. -/
inductive RefState where
  | unresolved | stageOnly | unset | synced | drifted
  deriving DecidableEq, Repr

/-- `envRefState`: the local value (`none` when unset or empty) against the stage digest. -/
def refState (hash : Nat → Nat) (localValue digest : Option Nat) : RefState :=
  match localValue, digest with
  | none, none => .unresolved
  | none, some _ => .stageOnly
  | some _, none => .unset
  | some v, some d => if d == hash v then .synced else .drifted

/-- `pushLocalEnvVars`: `setEnv` every unset or drifted ref with its local value.
Returns the stage digests afterwards. -/
def push (hash : Nat → Nat) (localEnv : Nat → Option Nat) (refs : List Nat)
    (remote : Nat → Option Nat) : Nat → Option Nat :=
  fun n =>
    if refs.contains n then
      match refState hash (localEnv n) (remote n) with
      | .unset | .drifted => (localEnv n).map hash
      | _ => remote n
    else remote n

/-- `assertEnvRefsResolved`: every referenced name has a stage value. -/
def resolved (refs : List Nat) (remote : Nat → Option Nat) : Bool :=
  refs.all (fun n => (remote n).isSome)

/-! ## Properties -/

/-- After the push, a ref with a local value holds exactly that value on the stage. -/
theorem push_synced {hash : Nat → Nat} {localEnv : Nat → Option Nat} {refs : List Nat}
    {remote : Nat → Option Nat} {n v : Nat} (hn : n ∈ refs) (hv : localEnv n = some v) :
    push hash localEnv refs remote n = some (hash v) := by
  simp only [push, List.contains_iff_mem, hn, ite_true, hv]
  cases hr : remote n with
  | none => simp [refState]
  | some d =>
    by_cases hd : d = hash v
    · simp [refState, hd]
    · simp [refState, hd]

/-- The PUT that follows passes `assertEnvRefsResolved` exactly when no ref is
`unresolved`, the state the CLI lists before syncing. -/
theorem push_resolves {hash : Nat → Nat} {localEnv : Nat → Option Nat} {refs : List Nat}
    {remote : Nat → Option Nat} :
    resolved refs (push hash localEnv refs remote) = true ↔
      ∀ n ∈ refs, refState hash (localEnv n) (remote n) ≠ .unresolved := by
  simp only [resolved, List.all_eq_true]
  refine forall_congr' (fun n => imp_congr_right (fun hn => ?_))
  cases hl : localEnv n with
  | none =>
    simp only [push, List.contains_iff_mem, hn, ite_true, hl]
    cases remote n <;> simp [refState]
  | some v =>
    have hs := push_synced (hash := hash) (refs := refs) (remote := remote) hn hl
    simp only [push, List.contains_iff_mem, hn, ite_true] at hs ⊢
    rw [hs]
    cases remote n with
    | none => simp [refState]
    | some d => by_cases hd : d = hash v <;> simp [refState, hd]

/-- Pushing twice changes nothing more. -/
theorem push_idempotent {hash : Nat → Nat} {localEnv : Nat → Option Nat} {refs : List Nat}
    {remote : Nat → Option Nat} (n : Nat) :
    push hash localEnv refs (push hash localEnv refs remote) n =
      push hash localEnv refs remote n := by
  by_cases hn : n ∈ refs
  · cases hl : localEnv n with
    | some v => rw [push_synced hn hl, push_synced hn hl]
    | none =>
      simp only [push, List.contains_iff_mem, hn, ite_true, hl]
      cases remote n <;> simp [refState]
  · simp [push, hn]

/-! ## Executable witness -/

/-- A drifted stage value is replaced by the local one before the PUT. -/
example : push id (fun _ => some 5) [1] (fun _ => some 3) 1 = some 5 := by decide

end Broods.SyncEnv
