# Agent skills for broods self-management

The deliverable for [#58](https://github.com/beeblastco/broods/issues/58): two skill bundles that let an agent operate the broods platform itself. Both use the Agent Skills format the platform already parses, a `SKILL.md` with `name` and `description` frontmatter plus optional scripts staged executable in the sandbox.

- `broods/` is account scope. Give it to Claude Code or a development agent working with a developer. It covers onboarding and sign-in, creating a broods project, defining and deploying agents with the CLI, and integrating deployed agents into application code with the SDK. It points at the docs for information instead of restating routes, and ships an onboard script that installs the CLI and walks the user through browser login.
- `maintain/` is agent scope. Give it to a deployed agent running on broods infra. It covers self-check across health, current config, system prompt, skills, and schedules, plus self-scheduling, self-configuration, sandbox lifecycle, and the dreaming loop.

To deploy one, copy the folder into a `broods/` project dir and register it with `defineSkill`. `resolveContainedResourcePath` needs the bundle inside the project dir, so this folder is the source of truth and the project copy is vendored. The `broods/` bundle is also vendored at `packages/broods/skills/broods/`, which the CLI inlines and installs into user repos on `broods dev`/`init` (agent-marker repos only, at `.agents/skills/broods/`). Nothing checks any of the copies for drift yet.

## Credentials

The `broods/` bundle authenticates the way a developer does: `broods login` in the browser, driven by its onboard script. The `maintain/` bundle authenticates with account roles, shipped in [#355](https://github.com/beeblastco/broods/pull/355). A role is a scoped credential you exchange for a short-lived session. `apps/docs/docs/roles.md` is the reference; the skills do not restate it.

For the agent bundle, mint a role pinned to the agent's own stage and hand the agent either a session token or the runtime key plus the role id, through the env store.

## What the skills ask for but nothing enforces

Each of these is prose in a `SKILL.md` today. An agent that ignores it meets no error, so treat this as the work left on #58, not as behavior you can rely on.

| Rule                                                                                   | Where it would belong                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| An agent may not patch the fields that bound it (`policies`, `denyTools`, `scheduler`) | field granularity in the agents PATCH normalizer, or its own action in `API_POLICY_ACTIONS`                         |
| An agent may only patch its own id                                                     | an agent binding on `accountRoles`, which today scopes by project and stage only                                    |
| A cron-fired run may not touch schedules                                               | `apps/core/src/harness/tools/index.ts` fences the tools, `/v1/crons` does not. deny `crons:write` in the run's role |
| A sandbox may only use an image the channel record allows                              | `sandboxImages` is stored and validated but read by no runtime code                                                 |

## Remaining phases

- Sandbox images: `applyChannelRecord` copies `sandboxImages` onto the runtime config, and provisioning rejects anything outside it, as an allow-list rather than a default (see #74).
- A self-handle tool in `apps/core/src/harness/tools/`, exposing a deployed agent to itself for self-update and self-configuration. It does the role exchange server-side, so a raw token never reaches the model loop, and it takes the agent id from the run context the way `schedule.tool.ts` already does, which turns three of the four prose rules above into code. The agent-scope counterpart to the MCP server: MCP serves agents outside the platform, a built-in tool serves the one inside it, because only the built-in tool knows which agent is calling.
- Dreaming as a documented preset rather than new infrastructure. The operator sets it up once:

```ts
defineCron({
  name: "dream",
  agent: myAgent,
  scheduleExpression: "cron(0 3 * * ? *)",
  input: "Dream: run the dreaming loop from the maintain skill.",
});
```

The fired run reads `maintain/references/dreaming.md`: review the window, extract one lesson, patch its own instructions or skills, log the diff.
