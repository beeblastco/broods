# Agent skills for broods self-management

The deliverable for [#58](https://github.com/beeblastco/broods/issues/58): two skill bundles that let an agent operate the broods platform itself. Both use the Agent Skills format the platform already parses, a `SKILL.md` with `name` and `description` frontmatter plus optional scripts staged executable in the sandbox.

- `broods-account-ops/` is account scope. Give it to Claude Code or a development agent working for a human. It covers the config plane: agents, crons, sandboxes, skills, tools, policies, env, workspaces.
- `broods-agent-self/` is agent scope. Give it to a deployed agent. It covers self-scheduling, self-configuration, sandbox lifecycle, and the dreaming loop.

To deploy one, copy the folder into a `broods/` project dir and register it with `defineSkill`. `resolveContainedResourcePath` needs the bundle inside the project dir, so this folder is the source of truth and the project copy is vendored. Nothing checks the copies for drift yet.

## Credentials

Account roles shipped in [#355](https://github.com/beeblastco/broods/pull/355). A role is a scoped credential you exchange for a short-lived session, and it is what both bundles authenticate with. `apps/docs/docs/roles.md` is the reference; the skills do not restate it.

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
- A built-in `broods_self` tool in `apps/core/src/harness/tools/`, doing the role exchange server-side and exposing typed self-management calls, so a raw token never reaches the model loop. The scripts here stay for what the tool does not cover.
- Dreaming as a documented preset rather than new infrastructure. The operator sets it up once:

```ts
defineCron({
  name: "dream",
  agent: myAgent,
  scheduleExpression: "cron(0 3 * * ? *)",
  input: "Dream: run the dreaming loop from the broods-agent-self skill.",
});
```

The fired run reads `broods-agent-self/references/dreaming.md`: review the window, extract one lesson, patch its own instructions or skills, log the diff.
