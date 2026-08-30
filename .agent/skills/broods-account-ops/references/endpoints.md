# Config plane and runtime routes

All paths are relative to `BROODS_BASE_URL` (default `https://gateway.broods.app`). Auth is `Authorization: Bearer <credential>`. The gateway sends config-plane paths to Convex and everything else to core; the split matters only where noted.

Request and response schemas live in the OpenAPI spec (`/api-reference` in the docs). This file carries the route map, the fields that are easy to get wrong, and the credential table.

## Config plane

Every resource below has the same five routes unless the notes say otherwise: `POST /v1/<resource>`, `GET /v1/<resource>`, and `GET`/`PATCH`/`DELETE` on `/v1/<resource>/{id}`.

| Resource     | Notes                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`     | create returns 409 with the existing `agentId`, so you can adopt it. list redacts configs. delete also drops the agent's runtime rows. `GET /v1/agents/{id}/channels/{channel}/directory` serves the channel directory |
| `crons`      | create needs `name`, `agentId`, `scheduleExpression`, and `input` or `events`. optional `conversationKey`, `timezone`, `description`. `GET /v1/crons/{id}/runs` is the run history                                     |
| `sandboxes`  | CRUD here, lifecycle in core (below)                                                                                                                                                                                   |
| `skills`     | keyed by name: `PUT`/`DELETE /v1/skills/{name}`. create takes `source: "files"` (base64), `"json"`, or `"github"` (public repo, fetched server-side)                                                                   |
| `tools`      |                                                                                                                                                                                                                        |
| `mcp`        | `/v1/mcp/{serverId}`                                                                                                                                                                                                   |
| `policies`   | agent-runtime policy documents, not credential scoping                                                                                                                                                                 |
| `channels`   | records carry `instructions`, `policies`, `denyTools`, `sandboxImages`                                                                                                                                                 |
| `hooks`      |                                                                                                                                                                                                                        |
| `workspaces` | plus `/v1/workspaces/{id}/files` (upload, rename, delete) and `/download-links`                                                                                                                                        |
| `roles`      | account secret only. a role session cannot read or write roles                                                                                                                                                         |
| `env`        | `GET /v1/env` lists names, values are write-only. `PUT`/`DELETE /v1/env/{name}`. reference from configs as `${NAME}`                                                                                                   |

`GET`/`PATCH /v1/account`, `POST /v1/account/rotate-secret`, and `POST /v1/account/assume-role` (body `{ roleId, ttlSeconds? }`, returns `{ token, expiresAt }`) round out the plane.

Schedule expressions are AWS-style syntax: `rate(...)`, `cron(...)` with 6 fields, or one-shot `at(...)`, which deletes itself after firing.

## Core

Sandbox lifecycle: `POST /v1/sandboxes/{id}/` + `suspend`, `resume`, `terminate`, `snapshot`, `refresh`, `exec`, or `terminal`. The last returns a 2-minute sealed terminal ticket. `refresh` and `exec` are not in the OpenAPI spec yet.

Runtime invoke, with a stage key: `POST /` for a synchronous SSE run, `POST /async` for an `eventId`, `GET /status/{eventId}` to poll it, an upgrade at `POST /v1/agents/{endpointId}/ws`, and channel ingress at `/webhooks/{account}/{channel}`.

## Credentials

| Prefix       | What it is                         | Where it works                                                                                   |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `fp_acct_`   | account secret, full tenant        | config plane + core account routes                                                               |
| `fp_agent_`  | stage runtime key                  | runtime invoke, and assume-role into a role pinned to its own stage. the config plane rejects it |
| `fp_cli_`    | CLI login token, 90 days           | CLI ingress, resolves to account authority                                                       |
| `fp_deploy_` | CI deploy key, project/stage bound | CLI ingress                                                                                      |
| `fp_role_`   | role id, never sent as a bearer    | names the policy you assume                                                                      |
| `fp_sts_`    | role session, 1h default, 12h max  | config plane + core, every request checked against the role policy                               |
