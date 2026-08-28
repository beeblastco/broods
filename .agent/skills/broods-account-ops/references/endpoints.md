# Config plane and runtime endpoints

All paths are relative to `BROODS_BASE_URL` (default `https://gateway.broods.app`). Auth is `Authorization: Bearer <credential>`. The gateway routes config-plane paths to Convex and everything else to core; you never need to know which is which, but mixed routes are flagged below.

## Agents

| Method and path                                         | Notes                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /v1/agents`                                       | create; 409 returns the existing `agentId` so you can adopt it            |
| `GET /v1/agents`                                        | list, configs redacted                                                    |
| `GET /v1/agents/{agentId}`                              |                                                                           |
| `PATCH /v1/agents/{agentId}`                            | deep merge; `"********"` keeps an existing secret, `null` deletes a field |
| `DELETE /v1/agents/{agentId}`                           | also deletes the agent's runtime rows                                     |
| `GET /v1/agents/{agentId}/channels/{channel}/directory` |                                                                           |

## Crons

| Method and path               | Notes                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/crons`              | body: `agentId`, `schedule` (`rate()`/`cron()`/`at()`), `input` or `events`, optional `conversationKey`, `timezone` |
| `GET /v1/crons`               |                                                                                                                     |
| `GET /v1/crons/{cronId}`      |                                                                                                                     |
| `PATCH /v1/crons/{cronId}`    |                                                                                                                     |
| `DELETE /v1/crons/{cronId}`   |                                                                                                                     |
| `GET /v1/crons/{cronId}/runs` | run history                                                                                                         |

## Sandboxes

CRUD is config plane, lifecycle verbs are core.

| Method and path                               | Notes                                           |
| --------------------------------------------- | ----------------------------------------------- |
| `POST /v1/sandboxes` / `GET /v1/sandboxes`    |                                                 |
| `GET /v1/sandboxes/{id}` / `PATCH` / `DELETE` |                                                 |
| `POST /v1/sandboxes/{id}/suspend`             | core                                            |
| `POST /v1/sandboxes/{id}/resume`              | core                                            |
| `POST /v1/sandboxes/{id}/terminate`           | core                                            |
| `POST /v1/sandboxes/{id}/snapshot`            | core                                            |
| `POST /v1/sandboxes/{id}/refresh`             | core                                            |
| `POST /v1/sandboxes/{id}/exec`                | core                                            |
| `POST /v1/sandboxes/{id}/terminal`            | core, returns a 2-minute sealed terminal ticket |

## Skills, tools, policies, channels, hooks

| Method and path                                      | Notes                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /v1/skills` / `POST /v1/skills`                 | create accepts `source: "files" \| "json" \| "github"`                         |
| `PUT /v1/skills/{name}` / `DELETE /v1/skills/{name}` | name comes from `SKILL.md` frontmatter                                         |
| `GET /v1/tools` and per-tool routes                  | tools are stage-scoped, unlike skills                                          |
| `GET /v1/policies` and per-policy routes             | agent-runtime policy documents                                                 |
| `GET /v1/channels` and per-channel routes            | channel records carry `instructions`, `policies`, `denyTools`, `sandboxImages` |
| `GET /v1/hooks` and per-hook routes                  |                                                                                |

## Env and workspaces

| Method and path                                | Notes                                             |
| ---------------------------------------------- | ------------------------------------------------- |
| `GET /v1/env`                                  | names only, values are write-only                 |
| `PUT /v1/env/{name}` / `DELETE /v1/env/{name}` | reference from configs as `${NAME}`               |
| `GET /v1/workspaces` and per-workspace routes  |                                                   |
| `GET /v1/workspaces/{id}/files`                | plus upload, rename, delete, download-link routes |

## Account

| Method and path                         | Notes                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /v1/account` / `PATCH /v1/account` |                                                                                                          |
| `POST /v1/account/assume-role`          | phase 1, see the folder README; exchanges a credential plus `roleId` for a short-lived `fp_sts_` session |

## Runtime (core, `BROODS_API_KEY` stage key)

| Method and path                           | Notes                   |
| ----------------------------------------- | ----------------------- |
| `POST /`                                  | synchronous run, SSE    |
| `POST /async`                             | returns `eventId`       |
| `GET /status/{eventId}`                   |                         |
| `POST /v1/agents/{endpointId}/ws` upgrade | agent WebSocket         |
| `/webhooks/{account}/{channel}`           | channel webhook ingress |

## Credential cheat sheet

| Prefix       | What it is                         | Where it works                                  |
| ------------ | ---------------------------------- | ----------------------------------------------- |
| `fp_acct_`   | account secret, full tenant        | config plane + core account routes              |
| `fp_agent_`  | stage runtime key                  | runtime invoke only; config plane rejects it    |
| `fp_cli_`    | CLI login token (90 days)          | CLI ingress, resolves to account authority      |
| `fp_deploy_` | CI deploy key, project/stage bound | CLI ingress                                     |
| `fp_sts_`    | role session (phase 1)             | config plane + core, limited by the role policy |
