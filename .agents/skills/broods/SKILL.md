---
name: broods
description: Work on a broods account alongside a developer from Claude Code or a development agent. Covers onboarding and sign-in, creating a broods project, defining and deploying agents and their resources with the CLI, and integrating a deployed agent into existing code with the SDK. Use when asked to set up broods, create or work on a broods project, create or manage agents or any account resource, or call a deployed agent from application code.
---

# Broods

The `broods` CLI does the interaction: sign-in, project sync, env, logs, running agents. The docs at https://docs.broods.app are the information: read the relevant page before guessing a config shape or an API route. In this repo the same files live at `apps/docs/docs/`. The `broods` npm package is the SDK: it integrates a deployed agent into existing application code.

## Onboard

`scripts/onboard.sh` installs the CLI if missing, prints `broods whoami`, and starts `broods login` when nobody is signed in. Login opens a browser and only the user can finish it, so run the script where they can see it and wait. Never hunt for a credential in dotfiles or CI config instead.

`broods whoami` also answers "where am I pointed": org, project, stage, and whether the runtime key in `.env.local` matches. Check it before syncing anywhere shared.

## Create a project and agents

`broods dev` on first run does everything: scaffolds `broods/` with a starter agent, runs the browser login if needed, pushes model keys from `.env.local` to the cloud env store, syncs to the `development` stage, then watches for changes and tails logs. `broods init` and `broods login` exist standalone when you want the steps separate.

A project is the `broods/` directory. `broods/index.ts` exports resources built with the `define*` functions: `defineAgent`, `defineSandbox`, `defineWorkspace`, `defineSkill`, `defineCron`, `defineMcp`, `definePolicy`, and the channel helpers. An optional `export default defineBroods({...})` sets project defaults like project name and stage mapping. The full reference is `resources.md` in the docs; the starter agent in `broods/index.ts` shows the minimum shape.

To create an agent, add a `defineAgent` to the project and sync. Talk to it with `broods run <agent> "prompt"`. Day to day: `broods dev` watches, `broods diff` previews, `broods deploy` syncs the production stage. Always `diff` before the first `deploy` on a stage you did not create.

## Integrate with existing code

Use the SDK, not raw HTTP. `broods dev` generates `broods/_generated/api`, typed references to your deployed resources, and `BroodsClient` from the `broods` package takes them:

```ts
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();
const result = await client.run(api.agents.myAgent, { input: "..." });
```

`client.stream(...)` and `client.runAsync(...)` cover streaming and async runs. `_generated/` is empty until a sync has run at least once. The `sdk.md` docs page has the full client, including account operations through `BroodsAccountClient`.

## When the CLI has no command

Crons, skills, sandboxes, policies, roles, channels, and hooks have no CLI verb. Prefer changing them in the project definition and syncing. For one-off reads and operations a manifest cannot say, use the MCP server. `claude mcp add broods -- broods mcp` adds it, and its tool names mirror the SDK: `list-agents`, `create-cron`, `update-agent`, and so on. For scoped automation credentials, read `roles.md` in the docs.

## Rules that keep you out of trouble

- Say which stage you are touching before you touch it. Production is opt-in. Never write to a prod stage unless the request names it.
- Skills are account-scoped, so two projects on one account share a skill namespace and a same-named skill overwrites the other. A skill's stored name comes from its `SKILL.md` frontmatter, not the folder name.
- Env values are write-only. Reference them from configs as `${NAME}`. If the user pastes a secret at you, put it in the env store and use the ref.
- Deletes are confirmed, named, and singular. Never loop a delete over a list.
- Editing a manifest-declared resource outside the project drifts from the definition, and the next deploy silently reverts it.
