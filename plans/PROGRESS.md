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
