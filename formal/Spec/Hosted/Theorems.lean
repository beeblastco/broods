import Spec.Hosted.Proofs

/-! Safety and leakage hold for the model. Pool progress requires a scheduled release followed
by acquisition, not fairness of the actual event loop; see L602. -/
namespace Spec.Hosted

/-- Distinct tenant cache keys identify distinct isolates; host processes may still be shared. -/
theorem tenant_isolates_separate (a b : TenantKey) (h : a.tenant ≠ b.tenant) : a ≠ b :=
  Proofs.tenant_separate a b h

/-- A transport retry requires a no-execution signal; the G7 semantic exception is separate. -/
theorem transport_never_retries_possible_execution (f : Failure) :
    retry f = true → mayHaveRun f = false := Proofs.retry_safe f

/-- Only a tagged 422 pins a bundle away from Workers for ten minutes. -/
theorem worker_pin_exact (now : Nat) (f : Failure) :
    pinUntil now f = some (now + 600000) ↔ f = .nothingRan 422 := Proofs.pin_exact now f

/-- Repartitioning decoded characters into arbitrary chunks cannot change parsed frames. -/
theorem frames_chunk_independent (a b : List (List Char)) (same : a.flatten = b.flatten) :
    parseChunks a = parseChunks b := Proofs.chunk_independent a b same

/-- Settlement returns one outcome per live request, including missing responses. -/
theorem every_request_one_outcome (ids : List String) (s : Collection) :
    (settle ids s).length = ids.length ∧ (settle ids s).map Prod.fst = ids :=
  ⟨Proofs.settle_length ids s, Proofs.settle_ids ids s⟩

/-- Once a terminal arrives, later frames cannot change collected outcomes. -/
theorem terminal_is_final (ids : List String) (s : Collection) (f : BatchFrame) (h : s.ended = true) :
    collect ids s f = s := Proofs.terminal_stable ids s f h

/-- A released live worker can be acquired by the next scheduled caller. -/
theorem pool_acquisition_progress (tenants : List String) (now : Nat) (tenant : String) :
    chooseWorker [workerStep ⟨.busy, tenants, 0⟩ (.release tenant now)] tenant = some 0 ∧
    (workerStep (workerStep ⟨.busy, tenants, 0⟩ (.release tenant now)) .acquire).phase = .busy :=
  Proofs.acquire_progress tenants now tenant

/-- Secrets cannot change observations once host, listing hits and contention agree. -/
theorem tenant_observation_private (a b : World) (h : a.visible = b.visible) : observe a = observe b :=
  Proofs.private_public a b h

/-- The semantic rate-limit exception makes at most three additional calls. -/
theorem semantic_retry_bounded (e r a : Bool) (n : Nat) (h : semanticRetry e r a n = true) :
    n ≤ 3 := Proofs.semantic_bound e r a n h
/-- Valid SHA-256 digests have equal length, so distinct tenants cannot share a child/loader key. -/
theorem tenant_child_loader_keys_separate (a b : TenantKey) (tenants : a.tenant ≠ b.tenant)
    (digests : a.digest.length = b.digest.length) : loaderKey a ≠ loaderKey b :=
  Proofs.loader_separate a b tenants digests

/-- Every encoded terminal frame starts with the exact byte prefix the Lambda parent tests. -/
theorem terminal_encoder_agrees (f : Frame) (h : terminal f = true) :
    terminalPrefix (encode f) = true := Proofs.terminal_encoder f h

end Spec.Hosted
