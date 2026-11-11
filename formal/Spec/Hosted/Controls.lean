import Spec.Hosted.Theorems
namespace Spec.Hosted.Controls

def brokenKey (k : TenantKey) : String := k.digest

theorem dropped_tenant_collides : brokenKey ⟨"a", "sha"⟩ = brokenKey ⟨"b", "sha"⟩ := rfl

def retryEverything (_ : Failure) : Bool := true

theorem retry_reset_unsafe : retryEverything .reset = true ∧ mayHaveRun .reset = true := by cbv

def splitWithoutBuffer (chunks : List (List Char)) : List Lean.Json :=
  chunks.flatMap (fun c => parseChunks [c])

theorem no_buffer_loses_frame :
    (feed {} "{\"t\":".toList).pending ≠ [] := by cbv; decide

theorem reordered_terminal_not_detected :
    terminalPrefix "{\"error\":\"failed\",\"t\":\"error\"}\n" = false := by cbv

def missingOnly (s : Collection) : List (String × Outcome) := s.outcomes

theorem missing_outcome_breaks_totality : (missingOnly {}).length ≠ (["1"] : List String).length := by cbv

def noRelease (w : Worker) : Worker := w

theorem no_release_stalls :
    chooseWorker [noRelease ⟨.busy, [], 0⟩] "waiting" = none := by cbv

def leakyObserve (w : World) : String := w.otherTenantSecret

theorem exposed_secret_breaks_privacy :
    leakyObserve ⟨⟨0, false, 0, "ok"⟩, "a"⟩ ≠ leakyObserve ⟨⟨0, false, 0, "ok"⟩, "b"⟩ := by decide

theorem malformed_known_tag_accepted : acceptJson (Lean.Json.mkObj [("t", "final")]) ≠ none := by cbv; simp

theorem delimiter_collision_without_digest_validation :
    loaderKey ⟨"a:b", "c"⟩ = loaderKey ⟨"a", "b:c"⟩ := rfl
def forgetChunks (chunks : List (List Char)) : List String :=
  chunks.flatMap (fun chunk => (feed {} chunk).complete)

theorem no_buffer_breaks_chunk_invariance :
    forgetChunks ["ab".toList, "cd\n".toList] ≠ forgetChunks ["abcd\n".toList] := by cbv; decide

def disabledPin (_now : Nat) (_failure : Failure) : Option Nat := none

theorem disabled_pin_misses_422 : disabledPin 10 (.nothingRan 422) ≠ pinUntil 10 (.nothingRan 422) := by decide

theorem pin_nonvacuous : pinUntil 10 (.nothingRan 422) = some 600010 := rfl

theorem semantic_exception_nonvacuous : semanticRetry true true false 3 = true := by decide

theorem unbounded_semantic_control : 4 > 3 ∧ mayHaveRun .batchError = true := by decide

end Spec.Hosted.Controls
