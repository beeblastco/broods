# Real Agent Features Plan

This plan turns the current agent settings UI into backend-backed product
features. The target is a non-technical, Manus-like flow inside the real
dashboard: chat with an agent, build skills from plain English, connect apps,
attach files/context, and test the whole setup without touching JSON.

## Current Truth

- Local dashboard uses DEV Convex and DEV gateway.
- The provided `fp_acct_...` account secret works against
  `https://gateway.dev.broods.app`.
- The same account secret is rejected by `https://gateway.broods.app`.
- The DEV account currently has no agents, skills, workspaces, sandboxes,
  policies, channels, env vars, or tools.
- The CLI `broods whoami/dev` does not accept the account secret as its CLI
  login token. It expects a WorkOS-derived CLI token stored by `broods login` or
  provided through `BROODS_TOKEN`.
- The public account REST client accepts the account secret through
  `BROODS_ACCOUNT_SECRET`.

## Existing UI Work

- Agent settings now show `Details`, `Playground`, `Skills`, `Connect`,
  `Context`, and `Settings`.
- The old agent `Config` tab is hidden from the non-technical agent flow.
- `Details` exposes system prompt editing.
- `Playground` can chat through runtime when an active deployment key exists,
  and falls back to a local setup assistant when runtime is missing.
- `Skills` supports add, edit, remove, and slash-command previews.
- `Connect` supports a searchable app catalog and connect/disconnect state.
- `Context` summarizes memory, skills, connectors, and folders.

## Phase 1: Auth And Environment

Goal: make every local command point at the same DEV account.

- Keep dashboard local dev on DEV Convex:
  `NEXT_PUBLIC_CONVEX_URL=https://cheerful-orca-414.eu-west-1.convex.cloud`.
- Keep dashboard runtime calls on DEV gateway:
  `NEXT_PUBLIC_BROODS_BASE_URL=https://gateway.dev.broods.app`.
- Keep root Broods account API calls on DEV gateway:
  `BROODS_BASE_URL=https://gateway.dev.broods.app`.
- Store the account secret as `BROODS_ACCOUNT_SECRET`.
- Do not use the account secret as a CLI login token unless the CLI is updated
  to support that mode.
- Add a dashboard-side server-only env for account mutations, never expose it as
  `NEXT_PUBLIC_*`.

## Phase 2: Account Inventory And Setup

Goal: make the DEV account contain the actual resources the UI edits.

- Add an account bootstrap script using `BroodsAccountClient`.
- Ensure a default workspace for each agent.
- Ensure a default sandbox for each agent that needs file/tool execution.
- Ensure a default agent named `tracy`.
- Store provider secrets in account env vars with `setEnvVar`.
- Attach workspace and sandbox references to the agent config.
- Store runtime public access according to the dashboard toggle.

## Phase 3: Real Skill Library

Goal: saved skills become real Broods skills, not just names in config.

- Add Convex action or dashboard route handler: `draftSkill`.
- Input: natural language request, selected agent, optional sample files.
- Output: proposed skill name, description, and `SKILL.md` content.
- Add server action/API: `saveSkill`.
- `saveSkill` uploads a skill bundle through the account API.
- Saved skill returns a real skill path/ref.
- Agent config stores that ref under `skills.allowed`.
- Playground slash menu reads actual account skills.
- `/skill-name` inserts or triggers the corresponding skill ref.
- Skill detail view supports rename, edit `SKILL.md`, duplicate, delete, and
  version history.

## Phase 4: Real Connectors

Goal: connector cards authorize real tools.

- Define a connector schema in Convex:
  provider, status, account id, scopes, auth metadata, last check, error.
- Add OAuth start/callback routes for Google, Slack, GitHub, Notion, and other
  web connectors.
- Store tokens encrypted or via an existing secrets path.
- Add custom MCP connector type:
  URL or command, args, env vars, auth header, allowed tools.
- Add connection health check.
- Runtime resolves connected apps into actual tools before model execution.
- Context panel shows connected tools and missing permissions in plain English.

## Phase 5: Real Files And Context

Goal: folders and context become workspace-backed storage.

- Use account workspaces as the source of truth.
- Add upload/list/rename/delete flows through workspace file APIs.
- Bind selected workspace IDs into the agent config.
- Use `memory/MEMORY.md` for durable agent memory.
- Add context cards for files, memory, connectors, skills, policies, and recent
  sessions.
- Playground can reference files with `@file` or a picker.
- Agent runtime receives the workspace mount and file tools.

## Phase 6: Real Playground

Goal: one chat box can test the whole agent.

- Runtime chat path streams SSE/WebSocket events.
- Tool calls render as cards.
- Skill load/use events render as cards.
- Connector auth failures render as fix buttons.
- File references render as attached context chips.
- `/` opens skill commands.
- `@` opens file/context picker.
- `+` opens upload, new skill, new connector, new folder.
- When runtime is missing, show a setup checklist instead of a dead chat.

## Phase 7: Test Everything Button

Goal: a non-technical user can know if the agent works.

Checks:

- Model/provider key resolves.
- Runtime public/private access matches settings.
- Agent responds to a hello prompt.
- Each skill can be loaded.
- Each connector auth token is valid.
- Custom MCP server responds to initialize/list tools.
- Workspace can read/write/delete a temp test file.
- Memory file can be read and updated.

## Phase 8: Product Polish

- Add a setup checklist in the agent header.
- Hide advanced JSON by default.
- Add clear labels for what is live, draft, broken, or missing.
- Add undo/toast feedback for save/delete actions.
- Add import/export skill bundle.
- Add connector permission summaries.
- Add skill templates by role: sales, support, research, coding, ops.
- Add context timeline: what the agent learned, which source added it, and when.

## Dashboard-First Backend Provisioning Plan

Goal: a user can create and deploy a complete backend-backed agent from the
dashboard UI without running `broods init`, `broods login`, or `broods dev`.

### User Flow

1. User opens dashboard and clicks `New Agent`.
2. Dashboard asks for a plain-English purpose, model/provider, and optional
   starter skills/connectors/files.
3. Dashboard creates the missing backend resources:
   account setup, project, stage, agent, workspace, sandbox, runtime key, skills,
   connector records, env refs, and file storage.
4. User lands directly in the agent settings panel.
5. `Playground` can immediately run a health check and chat.
6. `Skills`, `Connect`, and `Context` all show real backend state.
7. A `Deploy` or `Publish` button promotes draft edits into a live stage.

### Backend Shape

- Add server-only dashboard actions/routes that wrap `BroodsAccountClient`.
- Store `BROODS_ACCOUNT_SECRET` only on the server. Never expose it to browser
  code.
- Add Convex tables for dashboard-owned drafts:
  agent draft, skill draft, connector draft, file draft, deploy job.
- Add account API calls for committed/live state:
  agents, skills, workspaces, sandboxes, tools, channels, policies, env vars.
- Add a deploy coordinator:
  validate draft, create/update resources, fetch runtime key, run smoke tests,
  mark deployment status.
- Add idempotency keys for every create/update operation so retrying a failed
  deploy does not duplicate agents or skills.

### Data Model

- `agentDrafts`: name, purpose, provider, model, system prompt, workspace refs,
  sandbox ref, skill refs, connector refs, public access, status.
- `skillDrafts`: name, description, generated `SKILL.md`, files, validation
  status, published skill ref.
- `connectorDrafts`: provider, auth status, scopes, token ref, MCP config,
  health status.
- `contextItems`: workspace file path, memory path, connector id, skill ref, or
  note.
- `deployJobs`: draft id, target project, target stage, status, error, created
  resource ids, smoke test results.

### Required Dashboard APIs

- `POST /api/account/bootstrap`
  Ensures account/project/stage defaults.
- `POST /api/agents`
  Creates a draft and optionally provisions the live account agent.
- `PATCH /api/agents/:id`
  Updates details, model, system prompt, public access, workspace, sandbox.
- `POST /api/agents/:id/deploy`
  Publishes the draft into Broods account resources.
- `POST /api/agents/:id/test`
  Runs model/runtime/skill/connector/workspace checks.
- `POST /api/skills/draft`
  Generates a proposed skill from chat.
- `POST /api/skills/publish`
  Uploads the skill bundle and attaches it to the agent.
- `POST /api/connectors/:provider/start`
  Starts OAuth or MCP setup.
- `POST /api/connectors/:provider/callback`
  Stores provider credentials and marks connector connected.
- `POST /api/workspaces/:id/files`
  Uploads context files into the selected workspace.

### Runtime Behavior

- `Playground` uses the runtime key for live chat.
- If the agent is not deployed, `Playground` runs in draft mode and offers a
  `Deploy to test` action.
- Slash commands come from real published skills.
- Connector tools are resolved from connector records at run time.
- Workspace/file tools are enabled only when the agent has a workspace and
  sandbox policy that permits them.
- Failed runtime calls should return fixable states:
  missing model key, missing runtime key, missing connector auth, missing
  workspace, missing skill bundle, or backend deploy failure.

### Non-Technical UX Rules

- Default view is always plain English.
- Advanced JSON is behind an `Advanced` disclosure.
- Every broken state has one action button.
- Every destructive action has undo or confirmation.
- Every connector explains what it can read/write before OAuth.
- Every deploy shows what changed before publishing.
- Skill generation asks clarifying questions before writing when the request is
  vague.

### Implementation Order

1. Add server-only account client wrapper in dashboard.
2. Add account bootstrap endpoint and health check.
3. Add real agent create/update/deploy endpoint.
4. Wire `New Agent` and agent `Details` to backend provisioning.
5. Convert Skills tab from local names to real account skills.
6. Convert Connect tab from local names to connector records.
7. Convert Context tab from labels to workspace files/memory.
8. Add deploy job status and one-click smoke test.
9. Add Playwright flow tests for create agent, save skill, connect mock MCP,
   upload context, deploy, and chat.

## Required Inputs

- A CLI login token or browser login session if we want `broods dev` to sync
  code-first resources.
- Account secret for DEV account API mutations.
- Correct model/provider key for the desired agent model.
- OAuth client IDs/secrets and callback URLs for web connectors.
- Custom MCP server commands or URLs plus required env vars.
- Decision: keep this DEV-only first, or build promotion/copy to production.
