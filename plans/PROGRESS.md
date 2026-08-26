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
