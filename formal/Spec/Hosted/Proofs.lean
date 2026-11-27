import Spec.Hosted.Model
set_option maxRecDepth 4096
set_option maxHeartbeats 1000000
namespace Spec.Hosted.Proofs

theorem tenant_separate (a b : TenantKey) (h : a.tenant ≠ b.tenant) : a ≠ b := by
  intro same
  exact h (congrArg TenantKey.tenant same)

theorem retry_safe (f : Failure) : retry f = true → mayHaveRun f = false := by
  cases f <;> simp [retry, mayHaveRun]

theorem pin_exact (now : Nat) (f : Failure) :
    pinUntil now f = some (now + 600000) ↔ f = .nothingRan 422 := by
  cases f <;> simp [pinUntil]
  case nothingRan status => split <;> simp_all

theorem feed_append (s : Lines) (a b : List Char) :
    feed s (a ++ b) = feed (feed s a) b := by
  exact List.foldl_append

theorem chunks_flat (s : Lines) (chunks : List (List Char)) :
    chunks.foldl feed s = feed s chunks.flatten := by
  induction chunks generalizing s with
  | nil => rfl
  | cons head tail ih => simp [List.foldl, ih, List.flatten_cons, feed_append]

theorem chunk_independent (a b : List (List Char)) (h : a.flatten = b.flatten) :
    parseChunks a = parseChunks b := by
  simp only [parseChunks, chunks_flat, h]

theorem settle_length (ids : List String) (s : Collection) :
    (settle ids s).length = ids.length := by simp [settle]

theorem settle_ids (ids : List String) (s : Collection) :
    (settle ids s).map Prod.fst = ids := by simp [settle, List.map_map, Function.comp_def]

theorem terminal_stable (ids : List String) (s : Collection) (f : BatchFrame)
    (h : s.ended = true) : collect ids s f = s := by simp [collect, h]

theorem acquire_progress (ts : List String) (now : Nat) (tenant : String) :
    chooseWorker [workerStep ⟨.busy, ts, 0⟩ (.release tenant now)] tenant = some 0 ∧
    (workerStep (workerStep ⟨.busy, ts, 0⟩ (.release tenant now)) .acquire).phase = .busy := by
  constructor
  · simp [chooseWorker, workerStep]
  · rfl

theorem private_public (a b : World) (h : a.visible = b.visible) : observe a = observe b := h

theorem semantic_bound (e r a : Bool) (n : Nat) (h : semanticRetry e r a n = true) :
    n ≤ 3 := by
  simp [semanticRetry] at h
  omega

theorem token_fetch_sends (signedIn : Bool) (server : Nat → Answer) (sent : Nat) :
    (tokenFetch signedIn server sent).1 ≤ (if signedIn then 2 else 1) := by
  unfold tokenFetch
  cases signedIn <;> simp <;> split <;> simp

theorem request_legs_bound (signedIn modern : Bool) (server : Nat → Answer) (sent rounds : Nat) :
    (requestLegs signedIn modern server sent rounds).1 ≤
      (if modern then rounds + 1 else 1) * (if signedIn then 2 else 1) := by
  induction rounds generalizing sent with
  | zero =>
    have := token_fetch_sends signedIn server sent
    cases modern <;> simpa [requestLegs] using this
  | succ r ih =>
    have once := token_fetch_sends signedIn server sent
    have rest := ih (sent + (tokenFetch signedIn server sent).1)
    simp only [requestLegs]
    rcases hp : tokenFetch signedIn server sent with ⟨n, answer⟩
    rw [hp] at once rest
    simp only at once rest ⊢
    cases modern
    · simpa using once
    · simp only [ite_true] at rest ⊢
      split
      · rcases hq : requestLegs signedIn true server (sent + n) r with ⟨m, last⟩
        rw [hq] at rest
        simp only at rest ⊢
        rw [Nat.succ_mul]; omega
      · rw [Nat.succ_mul]; omega

theorem sdk_call_bound (signedIn modern defined : Bool) (server : Nat → Answer) (sent : Nat) :
    (sdkCallTool signedIn modern defined server sent).1 ≤
      (if modern then (if defined then 1 else 2) * (maxRounds + 1) else 1) *
        (if signedIn then 2 else 1) := by
  have first := request_legs_bound signedIn modern server sent maxRounds
  have second := request_legs_bound signedIn modern server
    (sent + (requestLegs signedIn modern server sent maxRounds).1) maxRounds
  simp only [sdkCallTool]
  rcases hp : requestLegs signedIn modern server sent maxRounds with ⟨n, answer⟩
  rw [hp] at first second
  simp only at first second ⊢
  cases modern
  · simpa using first
  · simp only [ite_true] at first second ⊢
    cases defined
    · simp only [Bool.false_eq_true, ↓reduceIte, Bool.not_false, Bool.true_and]
      split
      · rcases hq : requestLegs signedIn true server (sent + n) maxRounds with ⟨m, last⟩
        rw [hq] at second
        simp only at second ⊢
        rw [Nat.mul_assoc]
        generalize (maxRounds + 1) * (if signedIn = true then 2 else 1) = k at *
        omega
      · rw [Nat.mul_assoc]
        generalize (maxRounds + 1) * (if signedIn = true then 2 else 1) = k at *
        omega
    · simpa using first

theorem call_sends_bound (signedIn modern defined : Bool) (server : Nat → Answer)
    (sent retries : Nat) :
    callSends signedIn modern defined server sent retries ≤
      (retries + 1) * ((if modern then (if defined then 1 else 2) * (maxRounds + 1) else 1) *
        (if signedIn then 2 else 1)) := by
  induction retries generalizing sent with
  | zero => simpa [callSends] using sdk_call_bound signedIn modern defined server sent
  | succ r ih =>
    have once := sdk_call_bound signedIn modern defined server sent
    have rest := ih (sent + (sdkCallTool signedIn modern defined server sent).1)
    simp only [callSends]
    rcases hp : sdkCallTool signedIn modern defined server sent with ⟨n, answer⟩
    rw [hp] at once rest
    simp only at once rest ⊢
    split <;> rw [Nat.succ_mul] <;> omega

theorem tool_call_bound (signedIn modern defined : Bool) (server : Nat → Answer) :
    toolCallSends signedIn modern defined server ≤
      4 * (if modern then (if defined then 1 else 2) * (maxRounds + 1) else 1) *
        (if signedIn then 2 else 1) := by
  have := call_sends_bound signedIn modern defined server 0 3
  rw [Nat.mul_assoc]
  simpa [toolCallSends] using this

theorem explorer_bound (signedIn modern : Bool) (server : Nat → Answer) :
    explorerSends signedIn modern server ≤
      (if modern then 2 * (maxRounds + 1) else 1) * (if signedIn then 2 else 1) := by
  simpa [explorerSends] using sdk_call_bound signedIn modern false server 0

theorem isolation_nonvacuous :
    tenantId "account" (some "agent-a") ≠ tenantId "account" (some "agent-b") := by cbv

theorem retry_nonvacuous : retry .neverConnected = true ∧ retry (.nothingRan 422) = true := by cbv

theorem framing_nonvacuous :
    (feed {} "{\"t\":\"end\"}\n".toList).complete = ["{\"t\":\"end\"}"] := by cbv

theorem terminal_nonvacuous : terminalPrefix (encode (.endBatch none)) = true := by cbv

theorem batch_nonvacuous :
    (settle ["1", "2"] (collect ["1", "2"] {} (.answer "1" (.response 200 "ok")))).length = 2 := rfl

theorem leakage_nonvacuous :
    observe ⟨⟨0, false, 0, "ok"⟩, "secret"⟩ ≠ observe ⟨⟨0, true, 1, "ok"⟩, "secret"⟩ := by decide
theorem loader_separate (a b : TenantKey) (tenants : a.tenant ≠ b.tenant)
    (digests : a.digest.length = b.digest.length) : loaderKey a ≠ loaderKey b := by
  intro same
  have h := congrArg String.toList same
  simp only [loaderKey, String.toList_append] at h
  have lengths := congrArg List.length h
  simp only [List.length_append, String.length_toList] at lengths
  have pre : (a.tenant.toList ++ ":".toList).length = (b.tenant.toList ++ ":".toList).length := by
    simp only [List.length_append, String.length_toList]
    omega
  have eq := List.append_inj_left h pre
  exact tenants (String.toList_inj.mp (List.append_cancel_right eq))

theorem prefix_append (p s : List Char) : hasPrefix p (p ++ s) = true := by
  induction p with
  | nil => rfl
  | cons c cs ih => simp [hasPrefix, ih]

theorem terminal_encoder (f : Frame) (h : terminal f = true) : terminalPrefix (encode f) = true := by
  cases f <;> simp only [terminal] at h
  all_goals try contradiction
  case endBatch cpu =>
    cases cpu <;> simp only [encode, terminalPrefix, String.toList_append]
    all_goals apply Bool.or_eq_true_iff.mpr; left
    all_goals simp [hasPrefix]
  case failedBatch msg cpu =>
    simp only [encode, terminalPrefix, String.toList_append]
    apply Bool.or_eq_true_iff.mpr; right
    simp [hasPrefix]

end Spec.Hosted.Proofs
