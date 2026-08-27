# PROGRESS — autonomous run, 2026-08-27 (Revision 3)

Running report per §4. One section per ticket, updated after every ticket.
Stack base: `feat/tool-visibility` @ `8fc84006` (tickets 01, 11, 12, 14, 15 done — see 00 §2a).

Build order: 16 → 17 → 18 → 13 → 19 → [core deploy] → 20 → 21 → [core deploy] → 22 → 23 → 24.

## Credentials provided with the dispatch

- GitHub PAT: **BLANK** — parked: ticket 19/20/22/24 GitHub-connector live steps need a
  throwaway repo-read PAT.
- Telegram bot token: **BLANK** — parked: ticket 20/24 live channel proof via Telegram needs a
  @BotFather token.
- Slack bot token + signing secret: **BLANK** — parked: fallback channel proof needs it.
  → With all three blank, the "live channel end-to-end (message the bot from a phone)" and
  "GitHub token connector with real PAT" validations are parked. Everything validatable without
  them (wrong-token rejection paths, MCP connectors against a self-hosted server, all UI truth)
  proceeds.

## GLOBAL BLOCKER — Convex free-plan limit (hit 2026-08-26 ~21:00 UTC+7)

Every Convex function call on the shared dev deployment `cheerful-orca-414` now returns:

    Server Error: You have exceeded the free plan limits, so your deployments have
    been disabled. Please upgrade to a Pro plan or reach out to us at
    support@convex.dev for help.   (HTTP 500 on all queries/mutations/actions/httpActions)

Confirmed by a single probe (curl to the internal test endpoint + the dashboard failing on
`user:getCurrent`). Management API (deploy key data reads, codegen, `deploy-convex.yaml`)
still works — only function EXECUTION is disabled.

**Impact:** every live-in-browser validation step of every ticket is blocked (the dashboard
cannot load; agent runs read config through Convex so the runtime is down too).
**Needs (human):** upgrade the Convex team `an-tq` / project `broods` to Pro, or clear the
limit. Nothing in this repo can fix it (deleting live data is forbidden).
**Autonomous-mode handling (§6 "Convex plan limits" + park-don't-stop):** BUILD + TEST
(unit/integration/typecheck/format/lint) proceed for every ticket; commits are made with
live validation explicitly PARKED and labeled; the blocker is re-probed once between
tickets; all parked validations re-run before ticket 24 if it clears.

## Ticket 16 — agent panel v2 shell

- Status: **built + unit-tested; live validation PARKED on the Convex plan limit**
- Branch: `feat/agent-panel-v2` (base `feat/tool-visibility` @ 8fc84006), pushed
- Convex deploy: `skillsLibraryPublic.list` shipped via run **33012952825** (success)
- Built:
  - Agent tabs now `Details | Agent | Skills | Connectors | Context | Settings`;
    Test→Agent rename (tab id `agent`, same TestTab component); Config tab removed for
    agent nodes only (tool/workspace/sandbox/skill keep theirs).
  - Details humanized: editable Description + Instructions (system prompt) added
    (`agentConfig.update` description/systemPrompt), "Public API"→"Access" with plain
    copy, agentId copy hint reworded; Runtime Policy / Provider Tools / Output Format /
    Channels sections removed from Details.
  - Settings for agents: new `AgentAdvancedSettings` = Guardrail Policies + Provider
    Tools + Output Format (moved verbatim) + collapsed "Advanced — raw configuration"
    editor loading the FULL nested config.
  - **Defect fix (00 §2a):** save path now `mergeNestedAgentConfig` — edited branches
    replace, unmentioned branches survive. Unit test proves a `scheduler` branch
    survives a model edit through the real codec round-trip
    (`tests/agentConfigMerge.test.ts`, 2 tests).
  - New honest shells: `AgentSkillsTab` (cross-refs `skills.allowed` against the real
    library via new WorkOS-auth query `skillsLibraryPublic.list`, flags unresolved
    refs), `AgentConnectorsTab` (ChannelsSection moved here + honest connectors empty
    state), `AgentContextTab` (real `config.workspaces`/`config.sandbox` or empty states).
- Tests: dashboard `bun test` 76 pass / 0 fail; convex vitest exit 0 (197 tests);
  dashboard+convex `bun run check` exit 0; root `bun run lint` exit 0 (44 pre-existing
  warnings, 0 errors).
- Live validation steps 1–6 of the ticket: **PARKED (Convex plan limit)** — will run the
  moment the deployment is re-enabled.


## Ticket 17 — skills library

- Status: **built + unit-tested; live validation PARKED on the Convex plan limit**
- Branch: `feat/skills-library` (base `feat/agent-panel-v2`), pushed
- **Premise fork documented:** the `skills` TABLE is empty and has no writers anywhere —
  the real library is S3 (`SKILLS_BUCKET_NAME`, `listAccountSkills`). Ticket 16's
  `skillsLibraryPublic.list` query read that dead table; replaced in this ticket with
  S3-backed identity-auth actions. Least-destructive resolution; the user journey is
  unchanged.
- Auth wart fixed the touch-less way the ticket offered: `bearerToken` is now OPTIONAL on
  all four `skillsPublic` actions — absent token resolves the account from the signed-in
  user's active workspace (`org.getActiveAccount`); CLI/REST token path unchanged. The
  dashboard no longer passes tokens anywhere; `skillsCredentials.ts` (sessionStorage
  account-secret cache) is DELETED, along with the token prompts in
  SkillDetailsTab/SkillFilesTab.
- New actions in `skillsPublic.ts`: `listLibrary`, `getSkillDetail`, `updateSkillMd`
  (same-name in-place bundle rewrite), `renameSkill` (frontmatter rewrite + move +
  old-prefix delete + agent-ref keepalive in the UI), `deleteSkillByName`.
- Skills tab is now the full library: browse/search, per-agent enable toggle writing the
  real skill `path` into `skills.allowed` (merge-safe extraConfig write), detail view
  (SKILL.md rendered/raw/edit, file list, rename, delete w/ confirm), New skill +
  Import-from-GitHub forms, broken-ref one-click removal.
- Agent tab composer: `/skill-name` autocomplete against the enabled list (same source of
  truth) + expansion into an explicit load-skill ask (`app/lib/skillSlash.ts`).
- Tests: `skillsLibrary.test.ts` (create-form output satisfies bundle validation, name
  rejection, rename-frontmatter rewrite parses) — convex 200 tests pass; dashboard
  `skillSlash.test.ts` — 80 tests pass; both `bun run check` exit 0; root lint exit 0
  (2 new react(set-state-in-effect) warnings on AgentSkillsTab are heuristic
  false-positives: the flagged setStates run after an await inside a useEffect-driven
  action fetch).
- Live validation steps 1–7: **PARKED (Convex plan limit)**.


## Ticket 18 — context tab (the agent's desk)

- Status: **built + unit-tested; live validation PARKED on the Convex plan limit**
- Branch: `feat/context-tab` (base `feat/skills-library`), pushed
- Backend: `workspaceConfigsPublic.{createWorkingFolder,detachWorkingFolder}` mutations
  (WorkOS auth → conversationHistory scope resolver → stage-scoped `workspaceConfigs`
  insert `managedBy:"dashboard"` mirroring canvas.ts's shape, sandbox ensured with the
  default `{provider:"sandbox", permissionMode:"ask", network:deny-all}` config encrypted
  via `encryptAgentConfigBlob`, refs attached through `pushEncryptedConfigToAgentRow`).
  Narrow-and-add transforms extracted pure into `model/workingFolders.ts` and unit-tested
  (attach preserves every branch; detach removes exactly one ref; 4 tests).
- UI: Context tab now real — create folder (one click + name), per-folder file browser
  (upload/download/delete/refresh via the already-real `workspaceFilesPublic` actions,
  modified-time shown), Memory section (renders memory/MEMORY.md, edit + save, clear with
  confirm — same file actions), detach with confirm.
- Tests: convex 204 pass (4 new), dashboard 80 pass, checks exit 0, root lint exit 0
  (2 more heuristic set-state-in-effect warnings on the new effect-driven action fetches).
- Live validation steps 1–6 (upload→agent quotes file, agent writes file→appears+downloads,
  memory teach/edit/fresh-conversation, detach removes access): **PARKED (Convex plan
  limit)** — additionally these need the runtime (agent replies), also down.
- NOTE: ticket 13 (attachments in chat) is next per build order and depends on this
  ticket's folders; it is buildable but its live proof has the same park.


## Ticket 13 — attachments in, deliverables out

- Status: **built + unit-tested; live validation PARKED on the Convex plan limit**
- Branch: `feat/chat-attachments` (base `feat/context-tab`), pushed
- Attachments in: paperclip in the Agent-tab composer; uploads go through the real
  `workspaceFilesPublic.upload` into the agent's first attached folder under
  `chat-uploads/<conversationKey>/` (the hook grew `ensureSessionId()` so a fresh
  conversation gets its stable key before the first send); removable chips above the
  composer; on send the message text lists the real workspace paths ("read them with
  your file tools"); with no folder attached the control shows a plain-language hint
  with an "Open Context" jump — nothing silently uploads.
- Deliverables out: at send time the workspace file list is snapshotted; when the run
  leaves `streaming`, a second listing is diffed (new or modified, excluding `memory/`
  and `chat-uploads/`) and recorded via `conversationsPublic.recordDeliverables` onto
  the ticket-11 annotation row (new optional `deliverables` column on `conversations`);
  the transcript renders a reactive "Files from this conversation" card block
  (name/size/download via `getDownloadUrl`) that persists across close/reopen because
  it reads the annotation (`listDeliverables` query).
- Scope note: cards render as a per-conversation block at the end of the transcript
  rather than interleaved at the exact message position — the runtime store carries no
  per-turn marker to anchor them to; the ticket's persistence requirement is met.
- Tests: `deliverables.test.ts` (merge semantics, annotation round-trip across runs,
  cross-account scope nulls) — convex 207 pass; dashboard 80 pass; checks exit 0; root
  lint exit 0.
- Live validation steps 1–5: **PARKED (Convex plan limit + runtime down)**.


## Ticket 19 — connectors substrate

- Status: **built + unit/integration-tested; Convex deployed; core deploy checkpoint next;
  live validation PARKED on the Convex plan limit**
- Branch: `feat/connectors-substrate` (base `feat/chat-attachments`), pushed
- Schema (public contract, all surfaces walked):
  - core `AgentConnectorRef`/`AgentConnectorsConfig` + `normalizeConnectorsConfig`
    (scheduler pattern) wired into `normalizeAgentConfig`; codec flat↔nested
    (`connectors` in NESTED_BRANCHES both directions); SDK `AgentDefinitionConfig` +
    manifest allowed keys; `openapi.yaml` ConnectorsConfig schema; docs/tools.md.
  - `connectors` table (account-scoped; secrets as AES-GCM blobs via the EXISTING
    account-config mechanism — encryptAgentConfigBlob convex-side,
    decodeStoredConfigObject core-side; no second secrets path; the sandbox rows
    already prove this cross-plane round-trip, and a core test re-proves it).
- `connectorsPublic.ts`: createTokenConnector (real GET /user BEFORE `connected`;
  GitHub's own error surfaces), createCustomMcpConnector (real initialize +
  tools/list handshake; advertised tool names stored), checkConnector (re-validates,
  updates status/lastError — ticket 23's hook), deleteConnector, listConnectors
  (secret-free summaries). All WorkOS-authenticated via the active workspace.
- Core MCP client (`harness/connectors.ts`): @modelcontextprotocol/sdk streamable
  HTTP; per-connector auth headers from the decrypted secret; resolves enabled refs
  in `createTools` BEFORE denyTools; naming `mcp_<label>_<tool>` /
  `github_<label>_request` (documented in apps/core/AGENTS.md); connect/list/call
  timeouts; failure containment per connector (absent tools + WARN, never a crash).
- **Reuse decision (ticket 04's question):** token-kind execution does NOT reuse the
  account-tools endpoint tier — that tier executes uploaded bundles, not
  per-connector credentialed HTTP; a dedicated ~40-line `github_<label>_request`
  tool was smaller than adapting it.
- Tests: core `connectors-config.test.ts` (normalize accept/reject) +
  `connectors-mcp.test.ts` — a REAL in-process streamable-HTTP MCP server (SDK server
  half over node:http): initialize → tools/list → registered tool → call round-trips
  (echo_upper returns HELLO), auth header from the encrypted secret reaches the
  server, disabled ref resolves nothing, unreachable server degrades gracefully;
  plus the cross-plane secret round-trip. Convex `connectorValidation.test.ts`
  (GitHub ok/Bad-credentials, full MCP handshake incl. session header + SSE-framed
  responses + specific initialize failure). 212 convex tests pass, core suite next
  to run in full at the checkpoint.
- Live validation (steps 1–4 of the ticket): **PARKED (Convex plan limit)** — and
  step 4's GitHub PAT is additionally parked on missing credentials.


## Core deploy checkpoint #1 (after ticket 19)

- Executed per §5a. Complication found: local `dev` carried **two unpushed commits by
  the user** (07158e21 "bring-your-own endpoint tier", 487a8279 "agents go live
  automatically", authored 2026-08-25) that were never on origin/dev and conflicted
  with the stack (schema.ts). NOT resolved blind and NOT published: preserved
  untouched on branch **`dev-local-unpushed-20260825`**; local dev reset to
  origin/dev (a clean ancestor of the stack) and the stack merged with a merge
  commit. → **Needs (human):** decide whether to rebase/push those two commits;
  nothing was lost.
- Merge 8c26279e pushed. First CI wave: Build Core failed on a test-only zod import
  (hoisted locally, absent from @broods/core's manifest). Fixed forward
  (b98043a1, zod-free low-level MCP test server), cherry-picked onto the substrate
  branch, dev re-merged (661a8eb8 after integrating the SDK version-bump bot commit
  18c35c7a). Second CI wave in progress; runtime probe follows green CI.

## Ticket 20 — connectors tab

- Status: **built; unit-covered via 19's suites; live validation PARKED (Convex plan
  limit + no GitHub PAT/Telegram token provided)**
- Branch: `feat/connectors-tab` (base `feat/connectors-substrate`), pushed
- Manage list: connector cards with the row's REAL status (`connected` /
  `connected as <login>` / error + lastError with time), per-agent toggle writing
  `connectors.allowed` merge-safe, Check (re-runs validation via
  `checkConnector`), Remove (two-step confirm; deletes row + this agent's ref).
- Add flows: Custom MCP (label/URL/headers → real handshake; card shows the
  server's real tool names; handshake failures shown verbatim), GitHub PAT
  (password field → `createTokenConnector`; card shows the authenticated login).
  Google Drive rendered as an honest "coming soon" (ticket 09 blocked), no dead
  button.
- Channels upgraded: per-configured-channel status card validating with ONE real
  call via new `channelsPublic.validateChannel` — Telegram getMe, Slack auth.test,
  Discord /users/@me; GitHub App/Pancake/Zalo honestly say "Saved — will verify on
  first message" (no cheap authenticated call; documented). `${ENV}` placeholder
  secrets also report unverified. Re-validates automatically when the saved config
  changes (validate-on-save via Convex reactivity). Each card shows the
  `/webhooks/{accountId}/{kind}` URL with copy + a per-provider "where to paste"
  hint. ChannelsSection itself remains the editor (move, not rewrite).
- Live validation steps 1–5 (incl. the real Telegram end-to-end proof): **PARKED —
  Convex plan limit; steps 3–4 additionally need the GitHub PAT / Telegram bot
  token, both blank in the dispatch credentials.**

## Ticket 21 — self-config toolset

- Status: **built + fully unit-tested; Convex half DEPLOYED (run 33018935886,
  success); core deploy checkpoint #2 merged to dev as bc6d2115 (carries stacked
  tickets 20+21 — checkpoint #1 had merged only through feat/connectors-substrate);
  CI watch running; live validation PARKED (Convex plan limit)**
- Branch: `feat/self-config-tools` (base `feat/connectors-tab`), commit 03087734, pushed
- Security boundary implemented exactly as specced:
  - `X-Broods-Owner-Session: 1` stamped by `packages/convex/agentTestHttp.ts` on its
    upstream service-auth call.
  - ONE seam in core decides it: `directOwnerSession(authKind, headers)`
    (`apps/core/src/harness/owner-session.ts`) — true only for auth kind `account`.
    BOTH direct call sites in `integrations.ts` route through it (the deployment-key
    site passes its own auth kind, so the spoof case is refused by construction).
  - Threading: `DirectInboundEvent.ownerSession` → `SessionOptions` →
    `Session.ownerSession` → `createTools` gate. `prepareDirectTurn` clears the flag
    on cron triggers. Channel paths never set it. Background/async continuations do
    NOT inherit it (fails closed — deliberate).
- Tools (`harness/tools/self-config.tool.ts`), all read or propose, zero writes:
  read_own_config (via `sanitizeConfigForSelfInspection`), list_skill_library
  (real S3 store), list_connectors (no encrypted fields), read_recent_failures
  (REAL source: failed `runtimeIngressEnvelopes` rows via new internal query
  `listRecentAgentFailures` + new index `by_agentId_and_status_and_updatedAt` —
  account-checked), run_health_check (key-resolution check, per-skill SKILL.md
  existence, live MCP initialize→tools/list per enabled connector, working-folder
  S3 write/read/delete round-trip with cleanup), propose_skill,
  propose_config_change (allowlist: agent.system, model, skills.allowed,
  connectors.allowed, workspaces — everything else is a tool error),
  propose_connector, request_credential, propose_context_folder. Proposals return
  versioned `{version: 1, proposal: {kind, payload}, status: "pending_user_review"}`
  (`shared/domain/self-config.ts`).
- Owner system-prompt part added in `Session.buildSystemPromptParts` (inspect before
  answering; propose, never apply; credentials only via request_credential; never
  ask for secrets in chat).
- Deviation (documented): run_health_check's model check is config-level (key
  present + `${VAR}` reference resolved — the observed live failure mode) rather
  than a paid live provider ping; detail string says when a provider is "not
  checked". Token-connector checks quote the stored validation row rather than
  re-spending the token on every health check (Check button in ticket 20 does the
  live re-validation).
- Tests (apps/core/tests/self-config.test.ts, 16 pass): the spoof test
  (deployment+marker → false), gating present/absent at createTools, Session
  defaults + cron clearing, sanitizer leak check over every secret-bearing branch
  (provider key, telegram/slack tokens, signing secret, connector token, env),
  proposal round-trips, allowlist rejections (publicAccess, agent.name),
  health check naming the broken part (`config.provider.google.apiKey` +
  `${NO_SUCH_KEY}` named specifically; missing provider; vanished connector row).
- Full core suite: 1059 pass / 1 fail = the KNOWN pre-existing
  isolate-executor.test.ts timeout. Convex vitest: 212/212 pass. check + format +
  root lint: clean (exit 0).
- Live validation steps 1–4 (owner chat walks + live spoof): **PARKED — Convex
  plan limit (re-probed at this checkpoint: still the free-plan 500).**

## Core deploy checkpoint #1 — CLOSED

- Second dev CI wave on 661a8eb8: ALL GREEN (Deploy 33017446929, CI 33017446952,
  Build Core Image 33017447126, CodeQL 33017446966).
- Runtime probe: `GET https://gateway.dev.broods.app/healthz` →
  `{"status":"ok","activeWebSockets":0,"maxWebSockets":10000}`. Deeper probe
  through an agent run remains impossible while the Convex function plane is
  disabled (plan limit) — noted as degraded probe, not skipped.

## Core deploy checkpoint #2 (after ticket 21) — IN PROGRESS

- Convex deploy: workflow run **33018935886** (`deploy-convex.yaml` @
  feat/self-config-tools) → success. Carries: agentTestHttp owner-session marker,
  `listRecentAgentFailures` + envelope index, channelsPublic.validateChannel,
  connectorsPublic/connectors (already live from checkpoint #1's convex deploy of
  the substrate; this one re-deploys the superset).
- Core: dev fetched first — no colleague commits (origin/dev == 661a8eb8). Merged
  `feat/self-config-tools` with a merge commit → **bc6d2115**, pushed. CI watch
  running in background; healthz probe after green.

## Core deploy checkpoint #2 — CLOSED (one parked item)

- dev CI wave on bc6d2115: Deploy Convex, Deploy, CI, Build Core Image, Build
  Dashboard Image, CodeQL all SUCCESS. Runtime probe:
  `GET https://gateway.dev.broods.app/healthz` → `{"status":"ok",...}`.
- **Build Discord Forwarder Image: FAILURE — caused by the Convex plan limit,
  not by code.** Evidence: my merges touched zero files under
  apps/discord-forwarder (`git log 18c35c7a..bc6d2115 -- apps/discord-forwarder`
  is empty); the downstream infra run (beeblastco/infra 33019180833) failed at
  "Roll the Helm release" with `Deployment/beeblast/discord-forwarder not ready
  ... Available: 0/1` — the forwarder's `/readyz` stays false until its first
  successful config-plane poll BY DESIGN (apps/discord-forwarder/AGENTS.md), and
  the dev Convex plane rejects every function call while the free-plan limit
  stands. PARKED: after the Convex Pro upgrade, re-run "Build Discord Forwarder
  Image" (or the infra deploy workflow) and it should roll clean. Same failure
  already occurred on checkpoint #1's merge (run 33017014774), confirming it
  predates ticket 21's changes.

## Ticket 22 — agent tab cards

- Status: **built + contract-tested; live walks 1–8 PARKED (Convex plan limit;
  walk 2 additionally needs the blank GitHub PAT)**
- Branch: `feat/agent-tab-cards` (base `feat/self-config-tools`), commit 1ae653d6, pushed
- ProposalCard.tsx renders each ticket-21 proposal kind with Approve/Decline;
  approvals run the SAME public actions the manual tabs use (createFromJson,
  createCustomMcpConnector, createTokenConnector, createWorkingFolder,
  agentConfig.update merge-safe). agent.system applies to the flat systemPrompt
  column so DetailsTab keeps showing the truth (deliberate — extraConfig.agent.system
  would shadow that editor per the codec's precedence).
- Credential card: password inputs; github → token connector (+enable); channel
  kinds (telegram/slack/discord/zalo/pancake) → merge into config.channels.<kind>
  (the exact write ChannelsSection does); other providers → honest error pointing
  at the Connectors tab. Values never enter transcript/notes/model context.
- Decision notes posted as "[Approved — …]"/"[Declined — …]"/"[Failed — …]" via the
  normal send path; isOutcomeNote() renders them as small system notes. Failure
  keeps the card actionable (retry) and shows the real error.
- Contract mirrored in app/lib/selfConfigProposals.ts; validated against frames
  CAPTURED from core's actual tool implementations (executed directly — live
  stream capture impossible while Convex is down; the fixtures are byte-identical
  to what the stream will carry since the tool result IS the payload).
  tests/selfConfigProposals.test.ts: 5 pass. Dashboard suite: 85 pass. check/format/
  root lint clean.
- Hint chips on empty owner chats ("Build me a skill for…", "Connect this agent to
  GitHub", "Give yourself a working folder", "What can you currently do?").

## Ticket 23 — health & diagnostics

- Status: **built + typechecked + unit-covered where pure; live steps 1–5 PARKED
  (Convex plan limit)**
- Branch: `feat/health-diagnostics` (base `feat/agent-tab-cards`), commit 67e364a5, pushed
- `agentHealthPublic.check` (WorkOS auth + ownership via
  resolveAgentConversationScope): model ping (FREE countTokens for google/vertex,
  GET /models for anthropic + the OpenAI-compatible family, honest "not pinged"
  otherwise; unresolved `${VAR}` named specifically), per-enabled-skill S3 read,
  per-enabled-connector via the SAME connectorsPublic.checkConnector the tab's
  Check button uses (row status refreshes → tab shows identical truth),
  per-configured-channel via channelsPublic.validateChannel on the env-RESOLVED
  config, per-working-folder write/read/delete round-trip through
  workspaceFilesPublic with cleanup in `finally`. Secret values never appear in
  messages (variable NAMES only). Internal half: agentHealth.getHealthContext.
- UI: AgentHealthCheck section on Details ("Check everything" → plain pass/fail
  list, fix-links via ticket-12 pattern: env-vars route push, tab switches via
  new DetailsTab onOpenTab). Per-card refresh in Connectors = ticket 20's Check
  button (same action, deliberately not duplicated).
- Error-resolver wiring: latest results lift to NodeSidePanel →
  TestTab error cards quote the known failing model check
  ("Health check found it: <target> — <message>") via withKnownHealthCause
  (chatErrors.ts, 2 new tests; dashboard suite 87 pass).
- Convex deploy dispatched for the new action: run id recorded below.
- Convex deploy for agentHealthPublic/agentHealth: run **33026138173** → success.
  (Function EXECUTION remains disabled by the plan limit; the deploy itself is
  accepted, same as every deploy this run.)

## Ticket 24 — the full journey (acceptance run)

- Status: **PARKED WHOLESALE — blocked by the Convex free-plan limit.**
- Branch: `feat/full-journey-fixes` (base `feat/health-diagnostics`), created and
  pushed (no commits — no seam fixes could be exercised).
- Every one of the 13 steps is UI-driven through the dashboard, and the dashboard
  cannot execute a single Convex function while the plan limit stands (re-probed
  immediately before this ticket: the internal test endpoint still returns the
  free-plan 500). Even step 1 (create an agent) is impossible.
- Additionally blocked even after the plan upgrade: step 6 (GitHub PAT blank in
  dispatch credentials), step 9 (Telegram/Slack tokens blank), part of step 13
  (needs the GitHub connector from step 6).
- What ticket 24 needs from a human, in order:
  1. Upgrade cheerful-orca-414 to Convex Pro (or resolve the limit).
  2. Re-run "Build Discord Forwarder Image" on dev (parked rollout self-heals).
  3. Provide a GitHub PAT (+ optionally Telegram/Slack bot tokens) for steps 6/9/13.
  4. Re-dispatch the acceptance run (all code is built, deployed to dev where
     authorized, and every branch pushed).

## Final re-check of parked items (pre-24 sweep, per dispatch)

- Convex plan limit: STILL BLOCKED (probe output in ticket 24 section).
- ALL live browser validations for tickets 16, 17, 18, 13, 19, 20, 21, 22, 23:
  still parked behind the same limit; each ticket's section lists its steps.
- GitHub PAT / Telegram / Slack credential steps: still blank, still parked.
- dev-local-unpushed-20260825 (two user commits from Aug 25 preserved on that
  branch): still needs a human decision.
- Discord forwarder dev rollout: parked on the plan limit (see checkpoint #2).

## Final branch stack (all pushed)

  origin/dev @ bc6d2115 (carries everything through ticket 21)
  feat/tool-visibility        8fc84006  (base of this run, previously merged)
  feat/agent-panel-v2         (16)
  feat/skills-library         (17)
  feat/context-tab            (18)
  feat/chat-attachments       (13)
  feat/connectors-substrate   (19)  → merged to dev, checkpoint #1
  feat/connectors-tab         (20)
  feat/self-config-tools      (21) 03087734  → merged to dev, checkpoint #2
  feat/agent-tab-cards        (22) 1ae653d6
  feat/health-diagnostics     (23) 67e364a5
  feat/full-journey-fixes     (24) branch only, no commits

Convex dev deployment additionally carries tickets 22–23's functions
(deploy runs 33018935886 and 33026138173).
