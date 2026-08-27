---
name: broods-account-ops
description: Manage a broods cloud account from a development agent or Claude Code. Covers agents, crons, sandboxes, skills, tools, policies, env vars, and workspaces through the config plane REST API, SDK, and CLI. Use when asked to inspect, create, update, or delete any broods account resource, deploy or sync a broods project, or set up scoped credentials for automation.
---

# Broods account operations

You are operating a broods account on behalf of its owner. Everything below goes through the gateway at `BROODS_BASE_URL` (default `https://gateway.broods.app`). The full endpoint list is in `references/endpoints.md`.

## Authenticate first

Pick the strongest credential available, in this order:

1. Interactive human present: run `broods login`. It opens the dashboard, requires org admin, and stores a 90-day CLI token in `~/.broods/config.json`. All `broods` CLI commands then work.
2. Headless with an account secret: set `BROODS_ACCOUNT_SECRET` (starts with `fp_acct_`). This is full tenant authority. Treat it like a root credential: never echo it, never write it into files, never pass it on a command line where it lands in shell history. The scripts read it from env only.
3. Scoped role session (once assume-role ships): call `scripts/broods-api.sh POST /v1/account/assume-role '{"roleId":"fp_role_..."}'` with the account secret, then export the returned `fp_sts_` token as `BROODS_ACCOUNT_SECRET` for the rest of the session. Prefer this whenever the task touches only part of the account; the session expires on its own.

If none of these exist, stop and ask the owner. Do not go hunting for credentials in dotfiles or CI config.

## Calling the API

`scripts/broods-api.sh METHOD PATH [JSON_BODY]` wraps curl with the bearer header and JSON content type.

```sh
scripts/broods-api.sh GET /v1/agents
scripts/broods-api.sh POST /v1/crons '{"agentId":"...","schedule":"rate(1 day)","input":"Run daily maintenance."}'
scripts/broods-api.sh PATCH /v1/agents/agent_abc '{"config":{"agent":{"system":"..."}}}'
```

From TypeScript, use the SDK instead: `new BroodsAccountClient({})` from the `broods` package reads the same env vars and has a typed method for every route.

For project-shaped work (a repo with a `broods/` dir), prefer the CLI over raw API calls: `broods diff` to preview, `broods deploy` to sync, `broods dev` to watch, `broods env sync` for env drift, `broods logs` and `broods stream` to observe. The CLI reconciles the whole manifest; hand-editing resources one call at a time drifts from the code definition and the next deploy reverts it.

## Rules that keep you out of trouble

- Read before write. `GET` the resource, show the relevant part, then patch. `PATCH /v1/agents/{id}` is a deep merge: `"********"` preserves an existing secret, an explicit `null` deletes the field. Never send a secret placeholder you did not receive from a `GET`.
- Deletes are confirmed, named, and singular. Before any `DELETE`, state exactly what will be removed and wait for the owner to confirm, unless they already named the resource in the request. Never loop a delete over a list.
- Env values are write-only. `GET /v1/env` returns names, never values. Reference them from configs as `${NAME}`. If an owner pastes a secret at you, put it in the env store and use the ref; do not inline it in an agent config.
- Stage awareness. Crons, tools, and deployments are stage-scoped; skills are account-scoped, so two projects sharing an account share the skill namespace and same-named skills overwrite each other. Say which stage you are touching before you touch it.
- Production is opt-in. If the account has a prod stage, do not write to it unless the request names it.

## What lives where

- `/v1/agents` also serves per-agent channel directories at `/v1/agents/{id}/channels/{channel}/directory`.
- Cron schedules use EventBridge syntax: `rate(...)`, `cron(...)` (6 fields), or one-shot `at(...)` which self-deletes after firing. `conversationKey` decides where the result goes: a live channel key resumes that channel session and posts back to it; anything else runs in its own conversation, readable via the async status API.
- Sandbox CRUD is config plane, lifecycle verbs are core: `POST /v1/sandboxes/{id}/suspend|resume|terminate|snapshot|refresh|exec|terminal`.
- Skill bundles upload as `source: "files"` (base64), `"json"`, or `"github"` (public repo URL, fetched server-side). The stored name comes from the `SKILL.md` frontmatter, not the folder.
- Policies (`/v1/policies`) are agent-runtime policy documents (what a running agent may do: `tool.call`, `skill.load`, `workspace.exec`, ...). They are not API-key scoping; that is the role system.

## Verify what you did

After a mutation, `GET` the resource back and show the changed field. After creating or updating a cron, `GET /v1/crons/{id}/runs` on the next occasion you are asked about it rather than assuming it fired. After a deploy, `broods diff` should come back clean.
