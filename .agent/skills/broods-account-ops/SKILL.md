---
name: broods-account-ops
description: Manage a broods cloud account from a development agent or Claude Code. Covers agents, crons, sandboxes, skills, tools, policies, env vars, and workspaces through the config plane REST API, SDK, and CLI. Use when asked to inspect, create, update, or delete any broods account resource, deploy or sync a broods project, or set up scoped credentials for automation.
---

# Broods account operations

Everything here goes through the gateway at `BROODS_BASE_URL` (default `https://gateway.broods.app`). Routes are in `references/endpoints.md`.

## Authenticate first

Pick the narrowest credential that does the job:

1. A role session, if the owner has a role for this task. `POST /v1/account/assume-role` with `{"roleId":"fp_role_..."}` returns `{"token":"fp_sts_...","expiresAt":"..."}`. Export the token as `BROODS_SESSION_TOKEN`, and every later call uses it. Default life is 1 hour, maximum 12. Prefer this whenever the task touches only part of the account.
2. `broods login`, when a human is at the keyboard. It requires org admin and stores a 90-day token in `~/.broods/config.json`, which every `broods` command then uses.
3. `BROODS_ACCOUNT_SECRET` (`fp_acct_`) for headless work with no role. This is full tenant authority. Never echo it, never write it to a file, never pass it as a command argument where it lands in shell history. The scripts read it from the environment only.

Creating roles needs the account secret: a session cannot mint another session or touch `/v1/roles`. If the owner wants a hardened credential for a tool you are about to run, create the role first, assume it, and hand over the session.

If no credential exists, stop and ask the owner. Do not hunt for one in dotfiles or CI config.

## Reach for the CLI first

If the work sits in a repo with a `broods/` dir, the CLI is the right tool and the API is not. `broods diff` previews, `broods deploy` syncs, `broods dev` watches, plus `broods env`, `broods logs`, `broods stream`, and `broods agent list|get`. The CLI reconciles the whole manifest against the code definition. Editing one resource over the API instead drifts from that definition, and the next deploy silently reverts you.

The CLI needs a login token, from `broods login` or `BROODS_TOKEN`. A role session cannot drive it: `broods` resolves its scope through a CLI-only route that rejects any other credential.

## Calling the API

The CLI has commands for projects, stages, env, agents and logs, and nothing else. Crons, sandboxes, skills, tools, policies, roles, channels, hooks, workspaces and MCP servers have no CLI verb, so they go over the API. So does anything a manifest cannot say: run history, a sandbox you want suspended now, a one-off read.

`scripts/broods-api.sh METHOD PATH [JSON_BODY]`:

```sh
scripts/broods-api.sh GET /v1/agents
scripts/broods-api.sh POST /v1/crons '{"name":"daily-maintenance","agentId":"agent_abc","scheduleExpression":"rate(1 day)","input":"Run daily maintenance."}'
scripts/broods-api.sh PATCH /v1/agents/agent_abc '{"config":{"agent":{"system":"..."}}}'
```

If the resource is one the project manifest declares, change the manifest and deploy instead of patching it here.

From TypeScript use the SDK. `new BroodsAccountClient({})` from the `broods` package reads the same env vars and has a typed method per route, including `createRole` and `assumeRole`.

## Rules that keep you out of trouble

- Read before write, once. `PATCH` is a deep merge: `"********"` keeps an existing secret and `null` deletes a field. `GET` first when you need a current value to build the merge. The `PATCH` response is the updated resource, so show the changed field from it instead of reading back.
- Deletes are confirmed, named, and singular. Before any `DELETE`, say exactly what goes away and wait for the owner, unless they already named the resource. Never loop a delete over a list.
- Env values are write-only. `GET /v1/env` returns names, never values. Reference them from configs as `${NAME}`. If an owner pastes a secret at you, put it in the env store and use the ref.
- Say which stage you are touching before you touch it. Crons, tools, and deployments are stage-scoped. Skills are account-scoped, so two projects on one account share a skill namespace and a same-named skill overwrites the other.
- Production is opt-in. If the account has a prod stage, do not write to it unless the request names it.

## Things the route list will not tell you

- `conversationKey` on a cron decides where the result goes. A live channel key resumes that channel session and posts back to it. Anything else runs in its own conversation, which you read through the async status API.
- A skill's stored name comes from its `SKILL.md` frontmatter, not the folder name.
- `/v1/policies` holds agent-runtime policy documents: what a running agent may do (`tool.call`, `skill.load`, `workspace.exec`). Those are not API credential scoping. `/v1/roles` is.
- Check `GET /v1/crons/{id}/runs` before telling anyone a cron fired.
