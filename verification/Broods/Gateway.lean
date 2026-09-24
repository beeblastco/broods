/-!
# Gateway routing

Model of `apps/gateway/src/routes.ts` and the dispatcher `route()` in
`apps/gateway/src/main.ts`. It decides where a request goes once every admission
check (origin, rate limits, capacity, socket auth) has passed. Rejections are
not modelled.
-/

namespace Broods.Gateway

/-- HTTP method after `toUpperCase()`. -/
inductive Method where
  | get | head | post | put | patch | delete | options | other
  deriving DecidableEq, Repr

/-- `url.pathname` split on `/` with the leading empty segment dropped:
`/v1/agents/x` is `["v1", "agents", "x"]`, `/v1/agents/` is `["v1", "agents", ""]`. -/
abbrev Path := List String

/-- One anchored regex segment: a literal, or `[^/]+`. -/
inductive Pat where
  | lit (s : String)
  | any

/-- WebSocket surfaces the gateway terminates. -/
inductive Socket where
  | terminal | machine | observability | agent
  deriving DecidableEq, Repr

/-- Where `route()` sends a request. -/
inductive Dest where
  | health | preflight | socket (s : Socket) | config | core | notFound
  deriving DecidableEq, Repr

/-- `stripTrailingSlashes` inside `normalizePathname` (`apps/core/src/shared/paths.ts`,
`apps/gateway/src/routes.ts`), on segments: drops trailing empty segments. -/
def stripTrailing : Path → Path
  | [] => []
  | x :: xs => if (stripTrailing xs).isEmpty && x.isEmpty then [] else x :: stripTrailing xs

/-- `normalizePathname`: strip trailing slashes, and `/` stays `/`. -/
def normalize (p : Path) : Path :=
  match stripTrailing p with
  | [] => [""]
  | q => q

/-- `isInternalCorePath`: exact match after `normalizePathname`. -/
def isInternal (p : Path) : Bool :=
  normalize p == ["v1", "cron-runs"] || normalize p == ["v1", "mcp-service", "rpc"]

/-- Anchored match of a regex like `^/v1/agents/[^/]+$`. -/
def shape : List Pat → Path → Bool
  | [], [] => true
  | .lit s :: qs, x :: xs => x == s && shape qs xs
  | .any :: qs, x :: xs => !x.isEmpty && shape qs xs
  | _, _ => false

/-- `^/v1/<root>(?:/[^/]+)?$`. -/
def rootOrItem (root : String) (p : Path) : Bool :=
  shape [.lit "v1", .lit root] p || shape [.lit "v1", .lit root, .any] p

/-- The decisions in `route()` on an already normalized path: health, CORS
preflight, a matched socket upgrade, config plane, then core. An upgrade on a
non-socket path falls through to HTTP. -/
def dispatch (denyInternal upgrade : Bool) (m : Method) (p : Path) : Dest :=
  if (p == [""] || p == ["healthz"]) && m == .get then .health
  else if m == .options then .preflight
  else match (if upgrade then socket p else none) with
    | some s => .socket s
    | none =>
      if isConfig m p then .config
      else if !isCore p || (denyInternal && isInternal p) then .notFound
      else .core
where
  /-- `isConfigHttpPath`, rule for rule and in the same order. -/
  isConfig (m : Method) (p : Path) : Bool :=
    if p == ["v1", "account"] then m == .get || m == .patch
    else if underAccount p then true
    else if p == ["v1", "accounts"] then m == .get
    else if shape [.lit "v1", .lit "accounts", .any] p then m == .get || m == .patch
    else if shape [.lit "v1", .lit "accounts", .any, .lit "rotate-secret"] p then m == .post
    else if p == ["v1", "agents"] then m == .get || m == .post
    else if shape [.lit "v1", .lit "agents", .any] p then
      m == .get || m == .patch || m == .delete
    else if shape [.lit "v1", .lit "agents", .any, .lit "channels", .any, .lit "directory"] p then
      m == .get
    else if p == ["v1", "env"] then m == .get
    else if shape [.lit "v1", .lit "env", .any] p then m == .put || m == .delete
    else if shape [.lit "v1", .lit "downloads", .any] p then m == .get || m == .head
    else if shape [.lit "v1", .lit "workspaces", .any, .lit "download-links"] p then m == .post
    else
      rootOrItem "skills" p || rootOrItem "mcp" p || rootOrItem "hooks" p ||
      shape [.lit "v1", .lit "workspaces", .any, .lit "files"] p ||
      rootOrItem "workspaces" p || rootOrItem "sandboxes" p || rootOrItem "policies" p ||
      rootOrItem "roles" p || rootOrItem "channels" p || rootOrItem "crons" p ||
      shape [.lit "v1", .lit "crons", .any, .lit "runs"] p
  /-- `isCoreHttpRoute`: `/v1` or anything under `/v1/`. -/
  isCore : Path → Bool
    | "v1" :: _ => true
    | _ => false
  /-- The socket branches in `route()`, checked only on an upgrade. -/
  socket (p : Path) : Option Socket :=
    if p == ["v1", "sandboxes", "terminal", "ws"] then some .terminal
    else if p == ["v1", "machines", "ws"] then some .machine
    else if shape [.lit "v1", .lit "projects", .any, .lit "stages", .any,
        .lit "observability", .lit "ws"] p then some .observability
    else if shape [.lit "v1", .lit "projects", .any, .lit "stages", .any,
        .lit "agents", .any, .lit "ws"] p ||
      shape [.lit "v1", .lit "agents", .any, .lit "ws"] p then some .agent
    else none
  /-- `pathname.startsWith("/v1/account/")`. -/
  underAccount : Path → Bool
    | "v1" :: "account" :: _ :: _ => true
    | _ => false

/-- `route()`: normalize the path once, then dispatch. The upstream receives the
same normalized path (`proxyHttp`). -/
def route (denyInternal upgrade : Bool) (m : Method) (raw : Path) : Dest :=
  dispatch denyInternal upgrade m (normalize raw)

/-! ## Properties -/

/-- Stripping twice is stripping once. -/
theorem stripTrailing_idem : ∀ p : Path, stripTrailing (stripTrailing p) = stripTrailing p
  | [] => rfl
  | x :: xs => by
    have ih := stripTrailing_idem xs
    by_cases hc : ((stripTrailing xs).isEmpty && x.isEmpty) = true
    · simp only [stripTrailing.eq_2, hc, ↓reduceIte, stripTrailing.eq_1]
    · simp only [stripTrailing.eq_2, ih, hc, Bool.false_eq_true, ↓reduceIte]

theorem normalize_idem (p : Path) : normalize (normalize p) = normalize p := by
  cases h : stripTrailing p with
  | nil =>
    simp only [normalize, h]
    decide
  | cons x xs =>
    have hn : normalize p = x :: xs := by simp only [normalize, h]
    have hs : stripTrailing (x :: xs) = x :: xs := by rw [← h, stripTrailing_idem]
    rw [hn]
    simp only [normalize, hs]

/-- Nothing `isInternalCorePath` matches is ever proxied to core while the deny is on. -/
theorem core_never_internal {u : Bool} {m : Method} {p : Path}
    (h : route true u m p = .core) : isInternal p = false := by
  unfold route dispatch at h
  split at h
  · contradiction
  split at h
  · contradiction
  split at h
  · contradiction
  split at h
  · contradiction
  split at h
  · contradiction
  rename_i hn
  simp only [Bool.not_eq_true, Bool.or_eq_false_iff, Bool.and_eq_false_iff] at hn
  have := hn.2
  simp only [isInternal, normalize_idem] at this ⊢
  simpa using this

/-- One more trailing slash does not change the stripped path. -/
theorem stripTrailing_snoc : ∀ p : Path, stripTrailing (p ++ [""]) = stripTrailing p
  | [] => rfl
  | x :: xs => by simp only [List.cons_append, stripTrailing, stripTrailing_snoc xs]

/-- A trailing slash never changes where a request goes. -/
theorem route_trailing_slash (d u : Bool) (m : Method) (p : Path) :
    route d u m (p ++ [""]) = route d u m p := by
  simp only [route, normalize, stripTrailing_snoc]

/-- Any number of trailing slashes never changes where a request goes. -/
theorem route_trailing_slashes (d u : Bool) (m : Method) (p : Path) (n : Nat) :
    route d u m (p ++ List.replicate n "") = route d u m p := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [List.replicate_succ', ← List.append_assoc, route_trailing_slash, ih]

/-- The whole routing table sends an internal path to 404 for every method and
upgrade flag, except that OPTIONS is answered locally as a preflight. -/
theorem internal_is_not_found {u : Bool} {m : Method} {p : Path}
    (hm : m ≠ .options) (h : isInternal p = true) : route true u m p = .notFound := by
  simp only [isInternal, Bool.or_eq_true, beq_iff_eq] at h
  rcases h with h | h <;> cases u <;> cases m <;> simp only [route, h] <;> first
    | decide
    | exact absurd rfl hm

/-! ## Findings, as executable witnesses -/

/-- Fixed: `/v1/agents/` stays on the config plane with `/v1/agents`. -/
example : route true false .get ["v1", "agents", ""] = .config := by decide

/-- Fixed: `DELETE /v1/account/` goes to core like `DELETE /v1/account`. -/
example : route true false .delete ["v1", "account", ""] = .core := by decide

/-- `/healthz/` is a health check now. -/
example : route true false .get ["healthz", ""] = .health := by decide

/-- An upgrade on a non-socket path is proxied as plain HTTP. -/
example : route true true .get ["v1", "agents"] = .config := by decide

/-- `/v1/internal/observability-scope` is public by design (tested in route.test.ts). -/
example : route true false .post ["v1", "internal", "observability-scope"] = .core := by decide

end Broods.Gateway
