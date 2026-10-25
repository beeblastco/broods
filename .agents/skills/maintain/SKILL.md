---
name: maintain
description: Self-maintenance for a deployed broods agent. Check your own health and configuration, review your system prompt, skills, model, and schedules, patch your own config, manage your sandboxes, and run the dreaming self-improvement loop. Use when asked to self-check, report your current setup, schedule future work, adjust your own behavior or instructions, manage your sandbox, or when a dreaming cron fires.
---

# Maintain yourself

You are a broods agent acting on yourself, under a role your operator scoped for you. Your built-in tools do the interaction: `schedule`, `list_schedules`, `update_schedule`, and `cancel_schedule` for future work (only when your scheduler is enabled), `memory_save` to write a durable fact (only with a workspace on a sandbox and memory left on). Recall a fact with `read`, `glob`, or `grep` on `memory/`; the `memory/MEMORY.md` index is already in your prompt. For long work, run `bash` with `background: true` and check it with `async_status`. On a channel, `send-update` posts a progress note. `scripts/self-api.sh` is the API path for what no built-in covers: reading and patching your own config, your sandboxes, your run history. `references/dreaming.md` is the dream loop.

A 403 means the role forbids the call. Report that and stop. Never ask for, search for, or accept a broader credential.

Core sets `BROODS_AGENT_ID` (you) in every blocking `bash` command, plus `BROODS_BASE_URL` when the deployment publishes one, and drops any copy your operator sets. Your operator sets only the credential. If it is missing, say so and stop rather than guessing:

- `BROODS_SESSION_TOKEN`, a role session your operator minted, or `BROODS_API_KEY` plus `BROODS_ROLE_ID` for the script to exchange itself.

## Self-check

When asked how you are doing, what you are running, or before any self-change:

1. Platform health: `curl -sS "$BROODS_BASE_URL/healthz"` returns `{"status":"ok","activeWebSockets":...,"maxWebSockets":...}`. The gateway answers it itself, so it proves only that the gateway is up, not core. It is unauthenticated, so a failure here is infrastructure, not your role.
2. Your configuration: `scripts/self-api.sh GET "/v1/agents/$BROODS_AGENT_ID"` returns everything that shapes you, including the system prompt in `config.agent.system`, the model, skills, tools, and channels. Report from this response, not from memory. What you remember being configured as and what is stored can differ.
3. Your schedules: use `list_schedules`. Your role cannot list crons over the API (`GET /v1/crons` answers `403` for a stage-pinned role), so without the tool you can only read one whose id you know: `GET /v1/crons/{id}`, and `GET /v1/crons/{id}/runs` shows whether it actually fired.

A self-check that finds something wrong reports it. Fixing it is a separate decision. Apply the config rules below, and if the fix would touch a field you may not patch, hand it to a human instead.

## Schedule future work

Use `schedule`, `list_schedules`, `update_schedule`, and `cancel_schedule`. They are bound to your own agent id in code, which the REST path is not.

They exist only when your scheduler is enabled. Without them you cannot create a schedule: `POST /v1/crons` answers `403` for your role. The API only reads, patches, or deletes a cron by id. Expressions are `rate()`, `cron()` (6-field, AWS-style), or one-shot `at()`, which deletes itself after firing.

If a cron started this run, your first message says so. Then you create, edit, and cancel nothing, by tools or by API. The platform strips the scheduling tools and `ask_questions` from a cron-fired run, but `PATCH` and `DELETE /v1/crons/{id}` stay open, so this one is on you. A run that reschedules itself is a loop nobody asked for.

## Change your own config

The `broods` CLI is not an option for you, so do not go looking for it. It authenticates with a login token and resolves its scope through a CLI-only route that rejects a role session, and `broods deploy` would sync a whole stage from a project directory you do not have, reverting everything not in it. You change one field over the API.

`scripts/self-api.sh METHOD PATH [JSON_BODY]`. It sends `BROODS_SESSION_TOKEN` if you have one, otherwise it exchanges `BROODS_API_KEY` and `BROODS_ROLE_ID` for a session and caches it until it expires.

```sh
scripts/self-api.sh GET   "/v1/agents/$BROODS_AGENT_ID"
scripts/self-api.sh PATCH "/v1/agents/$BROODS_AGENT_ID" '{"config":{"agent":{"system":"..."}}}'
scripts/self-api.sh POST  /v1/sandboxes/sbx_abc/suspend '{"reservationKey":"..."}'
```

Patches are deep merges. `"********"` keeps a stored secret and `null` deletes a field. Read your config, change the one field you mean, and never write a literal `"********"` you did not read back. The `PATCH` response is your new config, so check the change there. A changed section that names an env var as `${NAME}` answers `400` unless your role has `env:read` on it, so hand a change to such a section to a human.

## Sandboxes

You never create a sandbox. Core reserves one for you when a tool first needs it, and `POST /v1/sandboxes` answers `403` for your role. An idle reservation suspends itself after its idle timeout. Suspend or terminate only your own reservation, never one holding state you did not put there, and never one running a background job: check `async_status` first.

If a channel record lists `sandboxImages`, treat it as the only images you may use. Nothing enforces this yet. The field is stored and validated, and no runtime code reads it. Until that lands, if you cannot see an allow-list you provision nothing new and work with the sandbox you were given.

## Dreaming

When a cron fires you with dreaming instructions, follow `references/dreaming.md`.

## Rules that keep you out of trouble

- Touch `$BROODS_AGENT_ID` and nothing else. Do not list agents to see who else is there. If another agent needs a change, say so and let a human make it.
- Never patch `policies`, `denyTools`, `scheduler`, or anything that names a credential or a role. Nothing in the platform stops you. An `agents:write` role covers every field of your own config, including the ones that bound you. Your behavior, instructions, the `skills.allowed` list in your config, and your schedules are yours to change. Skill content is account-wide and answers `403` for your role. The fields that constrain you are not yours.
- A cron-fired run touches no schedules, by tools or by API.
