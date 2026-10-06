# Skills

A skill is a folder of instructions, and optionally scripts, that an agent loads only when a request needs it. Use skills for playbooks, workflow rules, formatting standards or support procedures that would bloat every system prompt.

The agent sees a short list of its skills, with name and description. When one fits, it calls `load_skill` and gets the full `SKILL.md`.

## Create a skill

Skills follow the open [Agent Skills format](https://agentskills.io/home). Put the folder under `broods/`:

```text
broods/
  support-flow/
    SKILL.md
    examples/escalation-policy.md
    scripts/triage.py
```

```md title="broods/support-flow/SKILL.md"
---
name: support-flow
description: Handles support triage and escalation decisions.
---

# Support flow

Use this skill when a customer reports a product issue.

1. Classify urgency.
2. Identify the product area. See examples/escalation-policy.md.
3. Run scripts/triage.py with the ticket text to get a suggested queue.
```

Then declare it and allow it on the agent:

```ts title="broods/index.ts"
import { defineAgent, defineSkill } from "broods";

export const supportFlow = defineSkill({
  name: "support-flow",
  path: "support-flow",
});

export const support = defineAgent({
  name: "support",
  skills: { enabled: true, allowed: [supportFlow] },
});
```

`broods dev` checks that `SKILL.md` exists, bundles the folder and uploads it.

The `description` decides when the model loads the skill, so write it as a routing hint. Keep long examples and tables in separate files. The model asks for them by path only when `SKILL.md` points to them.

## Rules and limits

| Rule       | Value                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Name       | Lowercase letters, digits and hyphens, up to 64 characters. Names containing `anthropic`, `claude` or XML tags are rejected. |
| File size  | 5 MB per file, 30 MB per bundle                                                                                              |
| File types | Text only, meaning `.css .csv .html .js .json .md .mjs .py .sh .sql .svg .toml .ts .tsx .txt .xml .yaml .yml`                |
| Paths      | Relative to the skill root. Write `SKILL.md`, not `support-flow/SKILL.md`                                                    |
| Scope      | Skills belong to the account. A skill's name comes from `SKILL.md`, not from the folder name.                                |

Do not put credentials in a skill. Use [environment variables](deploying.md#secrets-and-environment-variables).

## Running scripts from a skill

When the agent has a workspace, `load_skill` also copies the bundle into it at `.claude/skills/<name>/`, mirrored at `.agents/skills/<name>/`. Scripts ending in `.sh`, `.bash`, `.zsh`, `.py`, `.js`, `.mjs` or `.ts` are marked executable, so the agent can run them with `bash`. Every load copies a fresh version.

Without a workspace, the instructions still load, but scripts cannot run in that turn.

## Editing skills with an agent

`load_skill` is read-only. To let an agent edit a skill, attach the skill's files as a workspace the agent can write to and let it use the normal file tools.

## Other ways to upload

The account API also takes skills from JSON, uploaded files, or a public GitHub tree URL of the form `https://github.com/{owner}/{repo}/tree/{ref}/{path}`. Only import from repositories you trust, and pin the ref. See `POST /v1/skills` in the [API reference](/api-reference).

The [`skill` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/skill) is a runnable example.
