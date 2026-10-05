/-!
# Edge routing

Model of the public route table `ROUTES` and `resolveRoute` in
`apps/edge/src/routes.ts`, which `apps/edge/src/traefik.ts` renders as the
Traefik routers in front of every environment. It decides where a request to the
API host goes. Traefik's per-address limits and CORS, and the gateway's socket
admission checks (origin, failed logins, capacity, token scope), are not
modelled.
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

/-- Where `resolveRoute` sends a request: the gateway (`health` and the sockets),
the config plane, core, refused at the edge (`blocked`), or no route (404). -/
inductive Dest where
  | health | socket (s : Socket) | config | core | blocked | notFound
  deriving DecidableEq, Repr

/-- `stripTrailingSlashes` in `apps/edge/src/routes.ts`, on segments: drops
trailing empty segments. -/
def stripTrailing : Path → Path
  | [] => []
  | x :: xs => if (stripTrailing xs).isEmpty && x.isEmpty then [] else x :: stripTrailing xs

/-- `stripTrailingSlashes`: strip trailing slashes, and `/` stays `/`. -/
def normalize (p : Path) : Path :=
  match stripTrailing p with
  | [] => [""]
  | q => q

/-- The `internal` route: `/v1/cron-runs` and `/v1/mcp-service/rpc`, exact after
stripping. Only in-cluster callers use them. -/
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

/-- `resolveRoute` on an already stripped path, where the first route in `ROUTES`
that matches wins: health, the internal block, a socket on an upgrade, the config
rules, then core. An upgrade on a non-socket path routes as plain HTTP. -/
def dispatch (upgrade : Bool) (m : Method) (p : Path) : Dest :=
  if (p == [""] || p == ["healthz"]) && m == .get then .health
  else if isInternal p then .blocked
  else match (if upgrade then socket p else none) with
    | some s => .socket s
    | none =>
      if isConfig m p then .config
      else if isCore p then .core
      else .notFound
where
  /-- The config rules of `ROUTES`, rule for rule. A method miss falls through
  to the next rule, so a request is config when any rule matches it. -/
  isConfig (m : Method) (p : Path) : Bool :=
    (p == ["v1", "account"] && (m == .get || m == .patch)) ||
    underAccount p ||
    (p == ["v1", "accounts"] && m == .get) ||
    (shape [.lit "v1", .lit "accounts", .any] p && (m == .get || m == .patch)) ||
    (shape [.lit "v1", .lit "accounts", .any, .lit "rotate-secret"] p && m == .post) ||
    (p == ["v1", "agents"] && (m == .get || m == .post)) ||
    (shape [.lit "v1", .lit "agents", .any] p &&
      (m == .get || m == .patch || m == .delete)) ||
    (shape [.lit "v1", .lit "agents", .any, .lit "channels", .any, .lit "directory"] p &&
      m == .get) ||
    (p == ["v1", "env"] && m == .get) ||
    (shape [.lit "v1", .lit "env", .any] p && (m == .put || m == .delete)) ||
    (shape [.lit "v1", .lit "downloads", .any] p && (m == .get || m == .head)) ||
    (shape [.lit "v1", .lit "workspaces", .any, .lit "download-links"] p && m == .post) ||
    rootOrItem "skills" p || rootOrItem "mcp" p || rootOrItem "hooks" p ||
    rootOrItem "workspaces" p || rootOrItem "sandboxes" p || rootOrItem "policies" p ||
    rootOrItem "roles" p || rootOrItem "channels" p || rootOrItem "crons" p ||
    shape [.lit "v1", .lit "workspaces", .any, .lit "files"] p ||
    shape [.lit "v1", .lit "crons", .any, .lit "runs"] p
  /-- The `webhooks` and `core` routes: `/v1` or anything under `/v1/`. -/
  isCore : Path → Bool
    | "v1" :: _ => true
    | _ => false
  /-- The four socket routes, which match only an upgrade. -/
  socket (p : Path) : Option Socket :=
    if p == ["v1", "sandboxes", "terminal", "ws"] then some .terminal
    else if p == ["v1", "machines", "ws"] then some .machine
    else if shape [.lit "v1", .lit "projects", .any, .lit "stages", .any,
        .lit "observability", .lit "ws"] p then some .observability
    else if shape [.lit "v1", .lit "projects", .any, .lit "stages", .any,
        .lit "agents", .any, .lit "ws"] p ||
      shape [.lit "v1", .lit "agents", .any, .lit "ws"] p then some .agent
    else none
  /-- The `account-sub` route, `^/v1/account/.*[^/]$` on a stripped path. -/
  underAccount : Path → Bool
    | "v1" :: "account" :: _ :: _ => true
    | _ => false

/-- `resolveRoute`: strip the path once, then dispatch. Traefik forwards the same
stripped path (the `strip-trailing-slash` middleware). -/
def route (upgrade : Bool) (m : Method) (raw : Path) : Dest :=
  dispatch upgrade m (normalize raw)

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

/-- Nothing the `internal` route matches ever reaches core. -/
theorem core_never_internal {u : Bool} {m : Method} {p : Path}
    (h : route u m p = .core) : isInternal p = false := by
  unfold route dispatch at h
  split at h
  · contradiction
  split at h
  · contradiction
  rename_i hi
  simp only [Bool.not_eq_true, isInternal, normalize_idem] at hi ⊢
  simpa using hi

/-- One more trailing slash does not change the stripped path. -/
theorem stripTrailing_snoc : ∀ p : Path, stripTrailing (p ++ [""]) = stripTrailing p
  | [] => rfl
  | x :: xs => by simp only [List.cons_append, stripTrailing, stripTrailing_snoc xs]

/-- A trailing slash never changes where a request goes. -/
theorem route_trailing_slash (u : Bool) (m : Method) (p : Path) :
    route u m (p ++ [""]) = route u m p := by
  simp only [route, normalize, stripTrailing_snoc]

/-- Any number of trailing slashes never changes where a request goes. -/
theorem route_trailing_slashes (u : Bool) (m : Method) (p : Path) (n : Nat) :
    route u m (p ++ List.replicate n "") = route u m p := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [List.replicate_succ', ← List.append_assoc, route_trailing_slash, ih]

/-- The edge refuses an internal path for every method and upgrade flag. -/
theorem internal_is_blocked {u : Bool} {m : Method} {p : Path}
    (h : isInternal p = true) : route u m p = .blocked := by
  simp only [isInternal, Bool.or_eq_true, beq_iff_eq] at h
  rcases h with h | h <;> cases u <;> cases m <;> simp only [route, h] <;> decide

/-! ## Findings, as executable witnesses -/

/-- Fixed: `/v1/agents/` stays on the config plane with `/v1/agents`. -/
example : route false .get ["v1", "agents", ""] = .config := by decide

/-- Fixed: `DELETE /v1/account/` goes to core like `DELETE /v1/account`. -/
example : route false .delete ["v1", "account", ""] = .core := by decide

/-- `/healthz/` is a health check. -/
example : route false .get ["healthz", ""] = .health := by decide

/-- An upgrade on a non-socket path routes as plain HTTP. -/
example : route true .get ["v1", "agents"] = .config := by decide

/-- `/v1/internal/observability-scope` is public by design (tested in apps/edge). -/
example : route false .post ["v1", "internal", "observability-scope"] = .core := by decide

/-- An inner empty segment stays in the `/v1/account/` subtree. -/
example : route false .get ["v1", "account", "", "x"] = .config := by decide

end Broods.Gateway
