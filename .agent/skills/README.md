# Agent skills for broods self-management (issue #58)

This folder is the design and the deliverable for [#58](https://github.com/beeblastco/broods/issues/58): skills that let an agent operate the broods platform itself. Two bundles, both in the open Agent Skills format the platform already parses (`SKILL.md` with `name` and `description` frontmatter, optional scripts staged executable in the sandbox):

- `broods-account-ops/` is the account-scope skill. Give it to Claude Code or any development agent working on behalf of a human. It covers the whole config plane: agents, crons, sandboxes, skills, tools, policies, env, workspaces. Auth is the account secret today, a scoped role session once phase 1 lands.
- `broods-agent-self/` is the agent-scope skill. Give it to a deployed broods agent. It covers self-scheduling, self-configuration, sandbox lifecycle, and the dreaming loop. It assumes the narrowest credential the platform can mint and refuses to escalate.

Both bundles pass the platform validator (name regex, `SKILL.md` at root, allowed extensions). To deploy one to an account, copy the folder into a `broods/` project dir and register it with `defineSkill`; `resolveContainedResourcePath` requires the bundle to live inside the project dir, so this folder is the source of truth and the project copy is vendored.

## What exists today

The exploration behind this design (config plane, harness, auth) found the platform closer to done than the issue implies. The gap is almost entirely authorization, not capability.

| Capability                                                                                       | Status                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Cron pipeline (EventBridge → gateway → core `POST /v1/cron-runs`)                                | complete                                                                                                                          |
| Agent self-scheduling tools (`schedule`, `list_schedules`, `update_schedule`, `cancel_schedule`) | complete, gated on `config.scheduler.enabled`, fenced so a fired run cannot reschedule itself                                     |
| Config-plane CRUD for agents, crons, sandboxes, skills, tools, policies, env, workspaces         | complete, account secret bearer                                                                                                   |
| SDK (`BroodsAccountClient`, ~60 methods)                                                         | complete                                                                                                                          |
| Runtime policy engine (`agentPolicies`, OPA rego, `tool.call` / `skill.load` / etc.)             | complete for in-run decisions                                                                                                     |
| Scoped or policied API keys                                                                      | missing. Every credential is all-or-nothing                                                                                       |
| Agent access to the config plane                                                                 | missing. The stage runtime key (`fp_agent_`) is rejected by `configHttp.ts` (`kind:"deployment"` is stripped of scope and denied) |
| `sandboxImages` on channel records                                                               | dead config. Validated and stored, read by nothing (`applyChannelRecord` never touches it)                                        |
| Dreaming / self-improvement                                                                      | does not exist                                                                                                                    |

## Auth design: account roles and assume-role

The issue asks for two things: a hardened way to hand a development agent less than the full account secret, and a way for a deployed agent to act on itself under a policy "stricted by account-role-id". One mechanism serves both. Model it on AWS STS.

New table `accountRoles` in `packages/convex/schema.ts`:

```ts
accountRolesFields = {
  accountId, projectId?, stageId?,        // structural scope, same shape as deployKeys
  roleId,                                  // fp_role_...
  name, status,                            // active | disabled
  policy,                                  // PolicyDocument, version 1
}
```

The policy document reuses the existing `PolicyRule { effect, actions, resources }` shape from `apps/core/src/shared/domain/policy.ts`, with a new action namespace for the API surface: `agents:read`, `agents:write`, `crons:write`, `sandboxes:write`, `skills:read`, and so on, one pair per resource route. Reusing the shape means the normalizer, the validator mirror in `packages/convex/model/policyRules.ts`, and the dashboard editor all extend instead of fork.

New endpoint `POST /v1/account/assume-role`, body `{ roleId, ttlSeconds? }`. Three credentials may call it:

1. The account secret (`fp_acct_`). This is the human path: hold the master credential, mint a narrow session for the tool you are about to hand it to.
2. A CLI login token (`fp_cli_`). Same, for `broods` CLI users.
3. A stage runtime key (`fp_agent_`). This is the agent path. The role's `projectId`/`stageId` must match the key's, so a leaked runtime key can only assume roles already scoped to its own stage.

The response is a session token `fp_sts_...` with a hash-stored row (`roleSessions`: tokenHash, roleId, accountId, expiresAt, default TTL 1h, max 12h). `resolveBearerAuth` in `packages/convex/configHttp.ts` learns a fourth kind, `role`, carrying `{ accountId, roleId, scope, policy }`. Enforcement is one function, `authorizeRoleAction(auth, action, resource)`, called at the top of each route handler. That funnel already exists; every handler goes through `requireAccount` today, and `role` slots in beside it. Core's `handleHttpRequest` (`apps/core/src/harness/integrations.ts:404`) gets the same check for the sandbox lifecycle verbs it serves directly.

Deliberate choices, and why:

- Exchange, not scoped long-lived keys. Minting a policied permanent key is simpler but leaves narrow-but-immortal credentials scattered everywhere. Short sessions expire on their own, and revocation is "disable the role", one row.
- One decision contract, in-process backing. Every enforcement point calls a single interface, `authorize(principal, action, resource) -> allow | deny`, whose input shape matches an OPA query. Phase 1 backs it with an in-process table lookup, because API authorization is a per-request allow/deny over a small closed action set: the rego sidecar earns its cost for in-run tool decisions with conditions, and a network hop plus a tier-0 OPA dependency on every CRUD call buys nothing today. Handlers never read the roles table directly, only the interface.
- Central OPA service: deferred, interface-compatible. Deploying OPA as a cluster service that both core and a self-hosted Convex reach is buildable, but managed Convex cannot reach it (forking the code path by topology), and it makes OPA availability equal API availability. When a trigger lands (ABAC conditions on API routes, a third enforcement plane, unified decision logs for compliance, or self-hosted Convex becoming the primary topology) the swap is a backend change behind `authorize()` plus a rego package; the shared `PolicyRule` document shape already parses on both sides.
- The runtime key never gains direct config-plane power. It only gets `assume-role`, and only into stage-matched roles. The blast radius of a leaked `fp_agent_` stays exactly one stage, same as today.

## Plan

Phase 0, this PR: this folder. Both skills work now for everything with an existing endpoint. `broods-account-ops` is fully functional with `BROODS_ACCOUNT_SECRET`. `broods-agent-self` works where the operator injects credentials via the env store (`/v1/env` refs into tool or sandbox config), which is the documented interim path.

Phase 1, account roles: `accountRoles` + `roleSessions` tables, `POST /v1/account/assume-role`, `kind:"role"` in `resolveBearerAuth`, `authorizeRoleAction` at the config-plane funnel and in core `handleHttpRequest`. Dashboard CRUD for roles, `broods role` CLI subcommand. Contract move, so: `openapi.yaml`, docs, SDK (`assumeRole()` on both clients), demos.

Phase 2, agent self-service: accept `fp_agent_` at `assume-role` (stage-matched roles only). Ship a built-in `broods_self` tool in `apps/core/src/harness/tools/` that performs the exchange server-side and exposes typed self-management calls (get own config, patch own config, sandbox lifecycle), so the common path never handles raw tokens in the model loop. The scripts in `broods-agent-self` remain the escape hatch for anything the tool does not cover.

Phase 3, sandbox images: wire the dead `sandboxImages` field. `applyChannelRecord` (`apps/core/src/shared/domain/channel-record.ts`) copies it onto the runtime `AgentConfig`; sandbox provisioning validates any requested image against it (allow-list, not default, per #74). The agent-initiated path is a `provision_sandbox` request through `broods_self` or the REST script; the runtime rejects images outside the list regardless of who asks.

Phase 4, dreaming: a documented preset, not new infrastructure. A `defineCron` template fires the agent on a schedule with instructions to run the loop in `broods-agent-self/references/dreaming.md`: review recent conversations and memory, extract what worked and what failed, patch its own instructions and skills through its role, log the diff. The existing cron fences already prevent the failure mode that matters (a fired run cannot touch schedules), and the role policy caps what a bad reflection can break.

## Open decisions

- Session TTL bounds (proposed 1h default, 12h max) and whether sessions are revocable individually or only via role disable.
- Whether `assume-role` lives in the config plane (natural, it owns the tables) or core (natural, it owns `resolveBearerAuth` for runtime routes). Proposed: config plane mints, both planes validate, shared by the same secret-hash lookup pattern crons already use.
- Whether the dashboard needs role-session visibility at launch or just role CRUD. Proposed: role CRUD only, sessions are ephemeral.
