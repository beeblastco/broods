---
name: broods-agent-self
description: Self-management for a deployed broods agent. Schedule and maintain your own cron jobs, read and patch your own configuration, manage your sandboxes, and run the dreaming self-improvement loop. Use when asked to schedule future work, follow up later, adjust your own behavior or instructions, manage your sandbox, or when a dreaming cron fires.
---

# Broods agent self-management

You are a broods agent acting on yourself, under a role your operator scoped for you. A 403 means the role forbids it: report that and stop. Never ask for, search for, or accept a broader credential.

Your operator must set three values in your environment. If any is missing, say so and stop rather than guessing:

- `BROODS_AGENT_ID`, the agent you are allowed to touch, which is you.
- `BROODS_SESSION_TOKEN`, a role session your operator minted, or `BROODS_API_KEY` plus `BROODS_ROLE_ID` for the script to exchange itself.
- `BROODS_BASE_URL`, if your deployment is not on `https://gateway.broods.app`.

## Scheduling: use your built-in tools first

If you have `schedule`, `list_schedules`, `update_schedule`, and `cancel_schedule`, use them. They are bound to your own agent id in code, which the REST path is not.

If you do not have them and the request needs a schedule, go through the API with a `rate()`, `cron()` (6-field, AWS-style), or one-shot `at()` expression. `at()` deletes itself after firing.

If a cron started this run, your first message says so. Then you create, edit, and cancel nothing, by tools or by API. The platform strips the scheduling tools from a cron-fired run but does not close the REST path, so this one is on you: a run that reschedules itself is a loop nobody asked for.

## Calling the API on yourself

The `broods` CLI is not an option for you, so do not go looking for it. It authenticates with a login token and resolves its scope through a CLI-only route that rejects a role session, and `broods deploy` would sync a whole stage from a project directory you do not have, reverting everything not in it. You change one field over the API.

`scripts/self-api.sh METHOD PATH [JSON_BODY]`. It sends `BROODS_SESSION_TOKEN` if you have one, otherwise it exchanges `BROODS_API_KEY` and `BROODS_ROLE_ID` for a session and caches it until it expires.

```sh
scripts/self-api.sh GET   "/v1/agents/$BROODS_AGENT_ID"
scripts/self-api.sh PATCH "/v1/agents/$BROODS_AGENT_ID" '{"config":{"agent":{"system":"..."}}}'
scripts/self-api.sh POST  /v1/crons "{\"name\":\"follow-up-deploy\",\"agentId\":\"$BROODS_AGENT_ID\",\"scheduleExpression\":\"at(2026-09-01T09:00:00)\",\"input\":\"Follow up on the deploy.\"}"
scripts/self-api.sh POST  /v1/sandboxes/sbx_abc/suspend
```

What the script cannot enforce for you:

- Touch `$BROODS_AGENT_ID` and nothing else. Do not list agents to see who else is there. If another agent needs a change, say so and let a human make it.
- Patches are deep merges. `"********"` keeps a stored secret and `null` deletes a field. Read your config, change the one field you mean, and never write a literal `"********"` you did not read back. The `PATCH` response is your new config, so check it there.
- Never patch `policies`, `denyTools`, `scheduler`, or anything that names a credential or a role. Nothing in the platform stops you: an `agents:write` role covers every field of your own config, including the ones that bound you. Your behavior, instructions, skills, and schedules are yours to change.

## Sandboxes

Suspend a sandbox when you finish with it. Terminate only one you created in this conversation, and never one holding state you did not put there.

If a channel record lists `sandboxImages`, treat it as the only images you may use. Be aware that nothing enforces this yet: the field is stored and validated, and no runtime code reads it. Until that lands, if you cannot see an allow-list you provision nothing new and work with the sandbox you were given.

## Dreaming

When a cron fires you with dreaming instructions, follow `references/dreaming.md`.
