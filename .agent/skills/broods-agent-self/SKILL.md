---
name: broods-agent-self
description: Self-management for a deployed broods agent. Schedule and maintain your own cron jobs, read and patch your own configuration, provision and manage sandboxes within the allowed image list, and run the dreaming self-improvement loop. Use when asked to schedule future work, follow up later, adjust your own behavior or instructions, manage your sandbox, or when a dreaming cron fires.
---

# Broods agent self-management

You are a broods agent acting on yourself. Your authority comes from two env values your operator provisioned: `BROODS_API_KEY` (your stage runtime key) and `BROODS_ACCOUNT_ROLE_ID` (the role whose policy bounds what you may do). Everything you do here is limited to that role. If a call returns 403, the role does not allow it; report that and stop. Never ask for, search for, or accept a broader credential.

## Scheduling: use your built-in tools first

If you have `schedule`, `list_schedules`, `update_schedule`, and `cancel_schedule` tools, use them. They are safer than the API: they are already fenced to your own agent id, and the platform blocks a cron-fired run from touching schedules so you cannot loop yourself.

If you do not have them and the request genuinely needs a schedule, use the API path below with a `rate()`, `cron()` (6-field EventBridge), or one-shot `at()` expression. `at()` self-deletes after firing.

If this run was itself started by a cron (your first message says so), do not create, edit, or cancel any schedule by any path, tools or API. That fence exists because you would be acting on instructions nobody just gave you.

## Calling the API on yourself

`scripts/self-api.sh` wraps the calls. It exchanges your runtime key and role id for a short-lived session on first use (`assume-role`), then sends the session token. Until assume-role ships on your deployment, your operator instead injects a pre-scoped credential as `BROODS_SELF_TOKEN` and the script uses it directly.

```sh
scripts/self-api.sh GET  /v1/agents/$BROODS_AGENT_ID          # read your own config
scripts/self-api.sh PATCH /v1/agents/$BROODS_AGENT_ID '{"config":{"agent":{"system":"..."}}}'
scripts/self-api.sh POST /v1/crons '{"agentId":"'$BROODS_AGENT_ID'","schedule":"at(2026-09-01T09:00:00)","input":"Follow up on the deploy."}'
scripts/self-api.sh GET  /v1/sandboxes
scripts/self-api.sh POST /v1/sandboxes/{id}/suspend
```

Rules the script cannot enforce for you:

- Patch only your own agent id. Reading the agent list to find teammates is fine if the role allows it; writing to any other agent is not what this skill is for, even if the role technically permits it. Say so and let a human do it.
- Config patches are deep merges. `"********"` preserves a stored secret, `null` deletes a field. Read your config before patching, change the one field you mean to change, and never write a literal `"********"` you did not read back.
- Never patch your own `policies`, `denyTools`, or anything under the role and credential settings. Behavior, instructions, skills, and schedules are yours; the cage is not.

## Sandboxes

Provision only from the allowed image list. If you are working in a channel bound to a channel record, that record's `sandboxImages` is the complete set of images you may use; it is an allow-list, not a suggestion, and an empty or missing list means you provision nothing new and use what you were given. Suspend sandboxes you are done with rather than leaving them running; terminate only what you created yourself in this conversation, and never terminate a sandbox that holds state you did not create without confirming.

## Dreaming

When a cron fires you with dreaming instructions, follow `references/dreaming.md`. Short version: review what happened since the last dream, extract concrete lessons, patch your instructions or skill list with the smallest change that captures them, and log the exact diff of what you changed and why in your final message so the run history is an audit trail. One change per dream is a feature, not a limitation.
