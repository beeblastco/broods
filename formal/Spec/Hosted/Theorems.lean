import Spec.Hosted.Proofs

/-! Safety and leakage hold for the model. Pool progress requires a scheduled release followed
by acquisition, not fairness of the actual event loop; see L602. -/
namespace Spec.Hosted

/-- Cache keys with different tenant fields are different keys. By construction (L22): the
content is in `tenant_child_loader_keys_separate`; host processes may still be shared. -/
theorem tenant_keys_distinct (a b : TenantKey) (h : a.tenant ≠ b.tenant) : a ≠ b :=
  Proofs.tenant_separate a b h

/-- The hosted runner falls back from the Worker only on a no-execution signal (a tagged status
or a never-connected code). This is mcp/hosted.ts only: a signed-in HTTP row's 401 resend, the
SDK's `input_required` resends (and its -32020 resend when no definition is passed) and the G7
rate-limit retry do re-send possibly executed calls (`tool_call_sends_bounded`, G602). By construction (L22): `retry` is `¬mayHaveRun`; the
content is the `retry` replay through the real `drainBridgeStream`. -/
theorem hosted_fallback_never_reruns (f : Failure) :
    retry f = true → mayHaveRun f = false := Proofs.retry_safe f

/-- One tool call through `callMcpTool` makes at most this many `tools/call` sends: the first call
and three rate-limit retries (G7); in the 2026-07-28 era the SDK re-sends each after an
`input_required` answer up to `maxRounds` = 10 more times, and once more after a -32020 only when
the caller passed no tool definition (`defined` false); a signed-in row resends each send once
after a 401 (G602). The agent's tools pass the definition: 44 or 88 sends in the new era, 4 or 8
in the older one; without it 88 or 176. No resend checks that nothing ran. Connect, discover and
list requests are not counted; the hosted Worker-to-Lambda fallback and `LambdaClient`'s default
retries sit below this layer. -/
theorem tool_call_sends_bounded (signedIn modern defined : Bool) (server : Nat → Answer) :
    toolCallSends signedIn modern defined server ≤
      4 * (if modern then (if defined then 1 else 2) * (maxRounds + 1) else 1) *
        (if signedIn then 2 else 1) :=
  Proofs.tool_call_bound signedIn modern defined server

/-- The dashboard tool explorer calls once, with no definition and no rate-limit retry: at most
44 `tools/call` sends on a signed-in row in the 2026-07-28 era, 22 unsigned, 2 or 1 in the older
era. The same uncounted requests and lower layers as `tool_call_sends_bounded`. -/
theorem explorer_sends_bounded (signedIn modern : Bool) (server : Nat → Answer) :
    explorerSends signedIn modern server ≤
      (if modern then 2 * (maxRounds + 1) else 1) * (if signedIn then 2 else 1) :=
  Proofs.explorer_bound signedIn modern server

/-- The worst answer at the `n`-th send without a definition: a 401 on every even send; otherwise
`input_required`, except a -32020 closing the first request and a rate limit closing the second. -/
def worstAnswer (n : Nat) : Answer :=
  if n % 2 = 0 then ⟨401, false, false, false⟩
  else if n / 2 % 22 = 10 then ⟨400, false, false, true⟩
  else if n / 2 % 22 = 21 then ⟨200, true, false, false⟩
  else ⟨200, false, true, false⟩

/-- The worst answer with a definition: a 401 on every even send; otherwise `input_required`,
except a rate limit closing each request. -/
def worstDefinedAnswer (n : Nat) : Answer :=
  if n % 2 = 0 then ⟨401, false, false, false⟩
  else if n / 2 % 11 = 10 then ⟨200, true, false, false⟩
  else ⟨200, false, true, false⟩

/-- The agent's bound is reached on a signed-in row in the 2026-07-28 era: 88 sends. -/
example : toolCallSends true true true worstDefinedAnswer = 88 := by decide

/-- With a definition, a -32020 ends the call: the sends that served `worstAnswer` stop at 22. -/
example : toolCallSends true true true worstAnswer = 22 := by decide

/-- Without a definition the bound is reached: 176 sends. -/
example : toolCallSends true true false worstAnswer = 176 := by decide

/-- The explorer's bound is reached on a signed-in row in the 2026-07-28 era: 44 sends. -/
example : explorerSends true true worstAnswer = 44 := by decide

/-- The older era reaches eight: alternating 401 and a rate-limit result. -/
example : toolCallSends true false true (fun n => if n % 2 = 0 then ⟨401, false, false, false⟩
    else ⟨200, true, false, false⟩) = 8 := by decide

/-- A 401 alone is resent even though the first send may have run: no no-execution signal. -/
example : toolCallSends true false true (fun _ => ⟨401, false, false, false⟩) = 2 := by decide

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

/-- The rate-limit rule allows a retry only at attempts 1 to 3: at most three more tool calls.
Each call may be sent more than once: the SDK resends after an `input_required` answer (and
after a -32020 only without a tool definition), and a signed-in row after a 401
(`tool_call_sends_bounded`). By construction (L22). -/
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
