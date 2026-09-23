# Deploying

How code in `broods/` reaches a stage, how secrets get there, and how to run it from CI.

## Development and production

| Command             | Target                                | Pushes `.env.local` values | Watches             |
| ------------------- | ------------------------------------- | -------------------------- | ------------------- |
| `broods dev`        | `BROODS_STAGE`, default `development` | yes                        | yes, plus live logs |
| `broods dev --once` | same                                  | yes                        | no                  |
| `broods deploy`     | always `production`                   | no                         | no                  |

Both commands compile `broods/`, validate it, sync it, regenerate `broods/_generated/`, and write the stage runtime key to `.env.local` as `BROODS_API_KEY`. A broken config fails before anything is written.

`deploy` ignores `BROODS_STAGE`. After `broods stage use staging`, `broods deploy` still writes to production. Pass `--stage staging` to deploy elsewhere.

Preview first with `broods diff`. It compares your code with the stage, including environment variables that differ from `.env.local`.

### Removing resources

A sync creates and updates, but never deletes. `broods deploy --prune` deletes resources on the stage that your code no longer declares. It fails if a policy it would remove is still used by an agent or channel record.

## Stages

```bash
broods stage list
broods stage create staging --from development   # copies agents, MCP servers, canvas and env vars
broods stage use staging                          # sets BROODS_STAGE and refreshes BROODS_API_KEY
broods dev                                        # sync your code into it
```

`development` and `production` are reserved names. Other stage names must be lowercase letters, digits and dashes, such as `staging` or `qa-2`, because they appear in URLs.

Cloning copies secret values. Removing a secret later means removing it from both stages.

## Secrets and environment variables

Reference secrets with `env("NAME")`. The value is stored encrypted on the stage and resolved on the server:

```ts
provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
```

Never use `process.env.OPENAI_API_KEY` in `broods/`. That bakes your local value into the synced config.

```bash
broods env set OPENAI_API_KEY                 # prompts for the value
echo "$VALUE" | broods env set OPENAI_API_KEY # or pipe it
broods env list                               # names only
broods env get OPENAI_API_KEY                 # reveals the value, audited
broods env rm OPENAI_API_KEY
broods env sync                               # push every referenced env("NAME") from .env.local
```

- Every `env("NAME")` must have a value on the stage, or the sync fails and names the missing variables.
- `env rm` refuses while a synced agent or sandbox still reads the variable.
- To rotate a secret, `env set` it again. Do not remove it first.
- `broods dev` pushes referenced values from `.env.local` on every sync. `broods deploy` does not, so a stale local value never reaches production by accident. Use `env set` or `env sync --stage production`.
- `env sync` only touches names your code references, never deletes, and reports names that live only on the stage.

## The runtime key

Each stage has one runtime key, `fp_agent_...`, that your app uses to run agents. `broods dev` and `broods deploy` write it to `.env.local` as `BROODS_API_KEY`. `broods deploy --rotate-key` mints a new one and invalidates the old one.

The key only reaches agents in its own stage that set `publicAccess: true`. It cannot read logs or change config. See [Security](security.md).

## Where a command acts

Four settings decide where a command writes. Run `broods whoami` when in doubt.

| Setting      | Stored in                                             | Change with                   |
| ------------ | ----------------------------------------------------- | ----------------------------- |
| Server       | `BROODS_BASE_URL` in `.env.local`                     | `broods login`, `--base-url`  |
| Organization | your CLI login, shared by all projects on the machine | `broods org use`              |
| Project      | `BROODS_PROJECT` in `.env.local`                      | `--project`                   |
| Stage        | `BROODS_STAGE` in `.env.local`                        | `broods stage use`, `--stage` |

A variable exported in your shell wins over `.env.local`. Run `unset BROODS_STAGE` to let the file take effect.

## Deploying from CI

Create a deploy key for the project and stage in the dashboard. A deploy key can sync only that stage, set and list environment variables but never read them, and cannot replace skills or hooks another stage manages. Then:

```yaml title=".github/workflows/deploy.yaml"
- run: bunx broods deploy
  env:
    BROODS_TOKEN: ${{ secrets.BROODS_DEPLOY_KEY }}
    BROODS_BASE_URL: https://gateway.broods.app
    BROODS_PROJECT: my-agents
```

`BROODS_TOKEN` and `BROODS_BASE_URL` together replace a stored login. Set production secrets with `broods env set` from a trusted machine, or from CI with an org admin login.

## Checking a deployment

```bash
broods agent list                 # name, public or private, model, deploy status
broods agent get support          # resolved config: model, sandboxes, workspaces, tools, channels, webhooks
broods run support "ping" | cat   # one plain-text round trip
broods logs --limit 100           # recent logs, then live
```

See the [CLI reference](../reference/cli.md) for every command.
