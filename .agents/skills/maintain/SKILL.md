---
name: maintain
description: Self-maintenance for a deployed broods agent. Check your own health and configuration, review your system prompt, skills, model, and schedules, patch your own config, manage your sandboxes, and run the dreaming self-improvement loop. Use when asked to self-check, report your current setup, schedule future work, adjust your own behavior or instructions, manage your sandbox, or when a dreaming cron fires.
---

# Maintain yourself

You are a broods agent acting on yourself, under a role your operator scoped for you. Your built-in tools do the interaction: `schedule`, `list_schedules`, `update_schedule`, and `cancel_schedule` for future work, `memory` for durable facts. `scripts/self-api.sh` is the API path for what no built-in covers: reading and patching your own config, your sandboxes, your run history. `references/dreaming.md` is the dream loop.

A 403 means the role forbids the call. Report that and stop. Never ask for, search for, or accept a broader credential.

Your operator must set these in your environment. If one is missing, say so and stop rather than guessing:

- `BROODS_AGENT_ID`, the agent you are allowed to touch, which is you.
- `BROODS_SESSION_TOKEN`, a role session your operator minted, or `BROODS_API_KEY` plus `BROODS_ROLE_ID` for the script to exchange itself.
- `BROODS_BASE_URL`, if your deployment is not on `https://gateway.broods.app`.

## Self-check

When asked how you are doing, what you are running, or before any self-change:

1. Platform health: `curl -sS "$BROODS_BASE_URL/healthz"` returns `{"status":"ok"}` when the deployment is up. It is unauthenticated, so a failure here is infrastructure, not your role.
2. Your configuration: `scripts/self-api.sh GET "/v1/agents/$BROODS_AGENT_ID"` returns everything that shapes you, including the system prompt in `config.agent.system`, the model, skills, tools, and channels. Report from this response, not from memory. What you remember being configured as and what is stored can differ.
3. Your schedules: use `list_schedules` if you have it, otherwise `scripts/self-api.sh GET /v1/crons` filtered to your own `agentId`. `GET /v1/crons/{id}/runs` shows whether one actually fired.

A self-check that finds something wrong reports it. Fixing it is a separate decision. Apply the config rules below, and if the fix would touch a field you may not patch, hand it to a human instead.

## Schedule future work

Use `schedule`, `list_schedules`, `update_schedule`, and `cancel_schedule`. They are bound to your own agent id in code, which the REST path is not.

Only when you do not have them, go through the API with a `rate()`, `cron()` (6-field, AWS-style), or one-shot `at()` expression. `at()` deletes itself after firing.

If a cron started this run, your first message says so. Then you create, edit, and cancel nothing, by tools or by API. The platform strips the scheduling tools from a cron-fired run but does not close the REST path, so this one is on you. A run that reschedules itself is a loop nobody asked for.

## Change your own config

The `broods` CLI is not an option for you, so do not go looking for it. It authenticates with a login token and resolves its scope through a CLI-only route that rejects a role session, and `broods deploy` would sync a whole stage from a project directory you do not have, reverting everything not in it. You change one field over the API.

`scripts/self-api.sh METHOD PATH [JSON_BODY]`. It sends `BROODS_SESSION_TOKEN` if you have one, otherwise it exchanges `BROODS_API_KEY` and `BROODS_ROLE_ID` for a session and caches it until it expires.

```sh
scripts/self-api.sh GET   "/v1/agents/$BROODS_AGENT_ID"
scripts/self-api.sh PATCH "/v1/agents/$BROODS_AGENT_ID" '{"config":{"agent":{"system":"..."}}}'
scripts/self-api.sh POST  /v1/sandboxes/sbx_abc/suspend
```

Patches are deep merges. `"********"` keeps a stored secret and `null` deletes a field. Read your config, change the one field you mean, and never write a literal `"********"` you did not read back. The `PATCH` response is your new config, so check the change there.

## Sandboxes

Suspend a sandbox when you finish with it. Terminate only one you created in this conversation, and never one holding state you did not put there.

If a channel record lists `sandboxImages`, treat it as the only images you may use. Nothing enforces this yet: the field is stored and validated, and no runtime code reads it. Until that lands, if you cannot see an allow-list you provision nothing new and work with the sandbox you were given.

## Dreaming

When a cron fires you with dreaming instructions, follow `references/dreaming.md`.

## Rules that keep you out of trouble

- Touch `$BROODS_AGENT_ID` and nothing else. Do not list agents to see who else is there. If another agent needs a change, say so and let a human make it.
- Never patch `policies`, `denyTools`, `scheduler`, or anything that names a credential or a role. Nothing in the platform stops you: an `agents:write` role covers every field of your own config, including the ones that bound you. Your behavior, instructions, skills, and schedules are yours to change. The fields that constrain you are not.
- A cron-fired run touches no schedules, by tools or by API.
