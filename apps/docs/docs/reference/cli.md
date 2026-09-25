---
title: CLI
---

# CLI reference

`broods` syncs a local `broods/` project to a project and stage, manages stages, environment variables and organizations, and gives you logs and a terminal chat for deployed agents. It runs on Bun 1.2+ or Node 22.15+.

```bash
bun add -g broods      # or: npm install -g broods
broods                 # where you are pointed, what to run next, every command
broods <command> -h    # one command's flags
```

## Help and output

`broods` on its own shows where the next command acts. It reads only `.env.local`, your shell and the stored login, and makes no network call.

```text
broods v0.26.0

  org      beeblast
  project  my-app
  stage    development
  server   gateway.broods.app

Next
  broods dev          sync on save, tail logs
  broods run <agent>  chat with an agent

Commands
  Develop   dev  diff  run  logs  stream
  Ship      deploy  env  stage
  Inspect   agent  whoami
  Account   login  org  project
  Tools     init  machine  mcp  update
```

Help does not apply `defineBroods` project or stage settings, because it never loads your `broods/` code. `broods whoami` and the commands themselves do.

Pages of commands that act on a stage start with a target line. It appears on `--help` pages and on the page a grouped command prints with no subcommand. `org`, `stage`, `env`, `agent`, `project` and `machine` print their page that way. After `broods stage use staging`, `broods deploy -h` shows `now  my-app → production  (ignores stage staging)`. The note only appears when `BROODS_STAGE` or `--stage` names another stage.

Every command marks its output the same way. `✔` marks a completed change, `!` a warning and `✖` an error. Errors go to stderr and exit with code 1.

## Where a command acts

Four settings decide what a command touches.

| Setting      | Stored in                         | Changed by                       |
| ------------ | --------------------------------- | -------------------------------- |
| Server       | `BROODS_BASE_URL` in `.env.local` | `broods login`, `--base-url`     |
| Organization | the CLI login token, server-side  | `broods org use`                 |
| Project      | `BROODS_PROJECT` in `.env.local`  | `broods dev` prompt, `--project` |
| Stage        | `BROODS_STAGE` in `.env.local`    | `broods stage use`, `--stage`    |

- The organization lives on the login token, so every project directory on the machine shares it. Run `broods whoami` before syncing somewhere shared.
- `deploy` targets `production`, or the `stages.deploy` stage set with `defineBroods`, and ignores `BROODS_STAGE`. Pass `--stage <name>` to deploy elsewhere. Every other command follows `BROODS_STAGE`.
- A variable exported in your shell wins over `.env.local`. The CLI warns when an export shadows a value it just wrote. `unset BROODS_API_KEY` to let the file take effect.
- `~/.broods/config.json` keeps one login per server, so a dev dashboard login never replaces a production one. A command uses the login for the server `BROODS_BASE_URL` names and stops with `Not logged in to <server>` when there is none.
- The CLI writes `~/.broods/config.json` and `.env.local` with mode `0600`, and `~/.broods` with `0700`. The CLI adds `.env*.local` to `.gitignore` when nothing ignores `.env.local` yet.
- The dashboard tracks its own active organization. After `broods org use`, switch the dashboard too, or a `?project=…&stage=…` deep link resolves against the old one.

## Global options

Every command except `mcp` and `update` accepts these:

| Flag                    | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| `--project <name>`      | Project override. Default: package name or folder name                          |
| `--stage <name>`        | Stage override. Default: `BROODS_STAGE`                                         |
| `--base-url <url>`      | Broods API base URL for sync and env calls. Default: set at login               |
| `--dashboard-url <url>` | Dashboard URL for login and deep links. Default: `https://dashboard.broods.app` |
| `-h`, `--help`          | Show the command's help                                                         |

`broods -v` prints the CLI version. `org`, `stage`, `env`, `agent`, `project` and `machine` print their help page when run without a subcommand.

Subcommands accept short aliases. `ls` means `list`, `select` means `use`, `new` means `create`, `rm` means `project delete`, and `remove` means `env rm`.

## init

Creates the `broods/` project shell with a starter agent and sandbox, plus `.env.local` defaults.

```bash
broods init [--region <region>] [--force]
```

| Flag                | Description                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `--region <region>` | Service region preference, `eu-west-1`, `us-east-1` or `ap-southeast-1` |
| `--force`           | Overwrite existing starter files                                        |

In a repo that has `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agent/` or `.agents/`, `init` and `dev` also write the broods skill to `.agents/skills/broods/`. It is written once and your edits survive. Only `--force` rewrites it.

## login

Authenticates through the dashboard in your browser and stores the token in `~/.broods/config.json`.

```bash
broods login [--region <region>]
```

The browser hand-off uses PKCE, so only the CLI that started the login can exchange the code. The token belongs to an org owner or admin and is re-checked on every request. Demote or remove the user and it stops working.

`login` does not choose a project. It writes `BROODS_PROJECT`, `BROODS_STAGE` and `BROODS_REGION` to `.env.local` only when passed `--project`, `--stage` or `--region`. It records `BROODS_BASE_URL` so SDK clients in the project reach the same deployment.

Self-hosted:

```bash
export BROODS_BASE_URL="https://gateway.your-domain.example"
broods login --dashboard-url https://your-dashboard.example.com
```

## whoami

Shows the login, server, organization, plan, project and stage the next command will use.

```bash
broods whoami
```

```text
broods v0.26.0
Dashboard:   https://dashboard.broods.app
Project:     my-agent-project
Stage:       development
Server:      https://gateway.broods.app
User:        you@example.com
Org:         my-team (my-team, owner, free plan)
Account:     my-team (active)
Runtime key: fp_agent_…vK8s (matches this org and stage)
```

It also checks the local `BROODS_API_KEY` against the key that org and stage serve and warns when they differ, which happens after switching organizations without resyncing. Before a project exists it prints `Project: none` and the folder name `dev` would suggest.

## dev

Watches `broods/`, syncs the current stage on every change, and live-tails agent logs.

```bash
broods dev [--once] [--level <lvl>] [--all] [--region <region>]
```

| Flag                | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `--once`            | Sync once and exit. No watch, no log tail                              |
| `--level <lvl>`     | Minimum tail level, `DEBUG`, `INFO`, `WARN` or `ERROR`. Default `WARN` |
| `--all`             | Tail `INFO` and up. DEBUG lines are only in the dashboard              |
| `--region <region>` | Region preference used when `dev` onboards a new project               |

The first run in an empty folder does the setup. It opens the browser like `login`, asks for an organization, project, stage and service region, creates `broods/` like `init`, pushes referenced secrets from `.env.local`, syncs, and writes `BROODS_API_KEY` to `.env.local`.

On every sync `dev`:

- pushes each `env("NAME")` value from `.env.local` that the stage does not already hold, like `env sync`
- asks before deleting remote resources you removed from code
- regenerates `broods/_generated/`
- prints each channel's webhook URL

A sync that references an `env("NAME")` with no stored value fails before anything is written and names the missing variables. `dev` checks npm for a newer CLI at most once a day and prints a one-line notice.

## diff

Shows local desired state against the current stage, without writing anything.

```bash
broods diff
```

Markers are `[+]` create, `[~]` rename, `[*]` update and `[-]` delete. It also warns when the stage's value for a referenced `env("NAME")` no longer matches `.env.local`:

```text
! .env.local and demo-app/development disagree on 1 variable(s): ZALO_WEBHOOK_SECRET. Run `broods env sync` to push the local values.
```

## deploy

Syncs the `production` stage once, or the `stages.deploy` stage set with `defineBroods`, and writes its runtime key to `.env.local`.

```bash
broods deploy [--prune] [--rotate-key] [--stage <name>]
```

| Flag           | Description                                                                      |
| -------------- | -------------------------------------------------------------------------------- |
| `--prune`      | Delete remote resources the project no longer declares                           |
| `--rotate-key` | Mint a fresh runtime key and write it to `.env.local`. The old key stops working |

`deploy` ignores `BROODS_STAGE`. Unlike `dev`, it never pushes secrets from `.env.local`. Set production values with `broods env set` or `broods env sync --stage production`, so a stale local value cannot ride a deploy. It warns when an agent lists a policy the deploy does not declare. `--prune` fails when an agent or channel record still references a policy it would remove, and names them. It removes skills, hooks and MCP servers only when this stage created them, never ones another stage manages or you made on the dashboard, and only after the rest of the deploy is accepted, so a rejected deploy removes nothing. A removed agent takes its cron jobs with it.

## env

Manages encrypted environment variables in the current stage. Resources read them through `env("NAME")`.

```bash
broods env <set|get|list|rm|sync> [name]
```

| Subcommand   | Description                                                       |
| ------------ | ----------------------------------------------------------------- |
| `set <name>` | Store a value, read from a prompt or stdin                        |
| `get <name>` | Reveal a value. Audited. Needs a login token or the org secret    |
| `list`       | List names. Values stay hidden                                    |
| `rm <name>`  | Remove a variable                                                 |
| `sync`       | Push every `env("NAME")` the project references from `.env.local` |

```bash
echo "$VALUE" | broods env set SOME_NAME
```

- `rm` refuses while a synced agent or sandbox still references the name, and says which. Remove the reference and sync first. To rotate a secret, run `set` again instead.
- `sync` only touches names the project references. It skips values the stage already holds, never deletes, and never touches `BROODS_*` variables. It reports names that exist only on the stage.

```text
▌ ↑ Synced 1 env var(s) from .env.local: ZALO_WEBHOOK_SECRET
3 other referenced variable(s) already in step with demo-app/production.
1 referenced variable(s) live only on demo-app/production: SLACK_SIGNING_SECRET
```

The stage stores a SHA-256 digest next to each value, so `sync` and `diff` compare without revealing secrets. A stage-scoped deploy key can set and list variables but not read them.

## run

Opens a terminal chat with a deployed agent.

```bash
broods run <agent> [prompt]
```

```bash
broods run my-agent "Summarize the open issues"
broods run my-agent "ping" > answer.txt   # plain text, no UI
```

- The session streams reasoning, shows tool calls as cards with input and output, and stops for `y`/`n` on tools that need approval. It stays open for follow-ups.
- Enter sends, arrows or PgUp and PgDn scroll, Ctrl+L repaints, and Esc or Ctrl+C leaves.
- When stdin or stdout is not a terminal, `run` prints the answer as plain text. A prompt is then required.
- `run` uses the stage runtime key over the public endpoint, so the agent needs `publicAccess: true`. Without it you get `403 public_access_disabled`.
- Each turn is a normal run on one conversation. Tools, sandboxes and policies behave as in production.

## agent

Inspects the agents in the current project and stage.

```bash
broods agent list          # name, public or private, model, deploy status
broods agent get my-agent  # model, sandboxes, workspaces, tools, channels, webhooks
```

## logs

Backfills recent logs, then live-tails. Needs a `broods login` token and a deployed stage.

```bash
broods logs [-n <n>] [--level <lvl>] [--all] [--json] [--sandbox <id>]
```

| Flag             | Description                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `-n`, `--limit`  | Backfill line count. Default 100                                                                      |
| `--level <lvl>`  | Minimum level, `DEBUG`, `INFO`, `WARN` or `ERROR`. Default `WARN`                                     |
| `--all`          | Every level. DEBUG comes from the backfill only                                                       |
| `--json`         | Print the backfill as raw JSON                                                                        |
| `--sandbox <id>` | Tail one sandbox instance's guest output instead. The id is the UUID in the dashboard Instances sheet |

The CLI trades your login token for a 15-minute stage session ticket and refreshes it on reconnect. The runtime key in `BROODS_API_KEY` cannot open logs, because logs carry every end user's chats. Code hook `console.*` lines appear here too, tagged `source: "user-code"`.

## stream

Live-tails logs for the whole project and stage until Ctrl+C. No backfill.

```bash
broods stream [--level <lvl>] [--all]
```

`--level` works as in `logs`. `--all` streams `INFO` and up. Authentication is the same as `logs`.

## org

Lists, switches and creates organizations.

```bash
broods org list              # current org marked with *
broods org use beeblast      # slug, name or id
broods org create "New Org"
```

Only organizations where you are owner or admin, with a provisioned API account, can be selected. `use` and `create` store the choice and rewrite `BROODS_API_KEY` for the current project and stage in the new organization. If the project does not exist there yet, the CLI warns and keeps the old key. Run `broods dev` to create the project and mint a key.

## project

Lists projects in the organization, or deletes one.

```bash
broods project list
broods project delete abandoned-e2e [--yes]
```

```text
Projects:
  tracy: 1 stage(s), 1 agent(s), 7 env var(s), 1 deployment(s), 0 workspace file(s)
  abandoned-e2e: empty
```

`delete` removes the project on every stage, including agent configs, canvas, environment variables, deploy keys, cron schedules, and workspace files with their stored blobs. It needs the org admin role. There is no undo. The prompt shows the counts first. `--yes` skips it. Without a TTY the prompt answers no, so a CI run without `--yes` deletes nothing.

## stage

Lists, switches and creates stages in the current project.

```bash
broods stage list
broods stage create staging --from development [--use]
broods stage use staging
```

| Flag             | Description                                                                    |
| ---------------- | ------------------------------------------------------------------------------ |
| `--from <stage>` | Deep-copy agent configs, MCP servers, canvas and every env var from that stage |
| `--use`          | Switch to the new stage right away                                             |

- Without `--from` the new stage is empty. Cloned secrets live in both stages, so removing one later means removing it twice.
- `use` writes `BROODS_STAGE` and refreshes `BROODS_API_KEY`, since the runtime key is per stage. Run `broods dev` afterwards to sync your resources there.
- `development` and `production` are reserved names. Other names must be lowercase letters, digits and dashes, such as `staging` or `qa-2`, because they appear in URLs and log labels.

## machine

Connects this computer to a `machine` sandbox, so agents on it run `bash` here as you. See [Machine](../guides/sandboxes/machine.md).

```bash
broods machine <sandbox> [--cwd <dir>] [--computer] [--mcp <file>] [--force]
broods machine --doctor [--request]
```

| Flag                   | Description                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--cwd <dir>`          | Working directory for commands. Default: current directory                                                  |
| `--computer`           | Also serve the `computer` tool for screenshots, mouse and keyboard. macOS only                              |
| `--mcp <file>`         | Run the stdio MCP servers in this `.mcp.json` for MCP rows on this sandbox                                  |
| `--force`              | Take the record over from another daemon                                                                    |
| `--doctor [--request]` | Check the Screen Recording and Accessibility grants `--computer` needs. `--request` shows the macOS prompts |

- Needs a `broods login` token and a deployed stage. The daemon uses a 15-minute stage ticket and refreshes it before each reconnect.
- It reconnects after a network drop. Another daemon on any computer is refused while this one holds the record, and the refusal names the host. `--force` is only needed after a daemon died while offline.
- Agent commands and `--mcp` servers never see `BROODS_*` variables.

## mcp

Serves the account config plane to a coding agent over MCP on stdio. Start it from an MCP client, not a terminal.

```bash
claude mcp add broods -- broods mcp
```

Tools mirror the account SDK in kebab-case, so `listAgents` is `list-agents`. Every config resource gets the verbs it supports. That covers agents, crons, sandboxes, workspaces, policies, roles, channels, skills and MCP servers. The extra tools are `list-cron-runs` and `upload-skill`. The sandbox lifecycle tools are `suspend-sandbox`, `resume-sandbox`, `terminate-sandbox`, `snapshot-sandbox` and `open-sandbox-terminal`. The env tools are `list-env-vars`, `set-env-var` and `delete-env-var`. The account tools are `get-account`, `update-account`, `rotate-secret` and `assume-role`. MCP server tools take `project` and `stage`, defaulted from `BROODS_PROJECT` and `BROODS_STAGE`.

With a stored `broods login`, it also registers `list-orgs`, `create-org`, `select-org`, `list-projects`, `list-stages` and `create-stage`. Creating a stage under a new project name creates the project.

The server reads credentials from the environment once, at startup.

| Credential                             | What the agent can reach                 |
| -------------------------------------- | ---------------------------------------- |
| `BROODS_SESSION_TOKEN`, a role session | What the role's policy allows. Preferred |
| `BROODS_ACCOUNT_SECRET`                | The whole account                        |
| Stored `broods login` only             | Org, project and stage tools only        |

The server enforces these guards itself.

- A delete needs `confirm: true` and takes one id.
- There is no tool that reads env values.
- A stage-scoped resource refuses a call with no scope.
- `rotate-secret` and `delete-project` stay unregistered unless `BROODS_MCP_ALLOW_DESTRUCTIVE=1` is exported in the shell that starts the server. A value in `.env` or `.env.local` is ignored, since the agent can write those files.

See [Security](../guides/security.md) for minting a role session.

## update

Installs the newest release with the package manager that installed the CLI.

```bash
broods update
```

A global bun or npm install is replaced in place. Inside a project, the dependency is upgraded instead.

## Upgrading from older versions

| Old                                   | Now                                                        |
| ------------------------------------- | ---------------------------------------------------------- |
| `broods status`                       | `broods whoami`                                            |
| `--env <name>`                        | `--stage <name>`                                           |
| `BROODS_ENVIRONMENT` in `.env.local`  | `BROODS_STAGE`                                             |
| `BROODS_CONTROL_URL`, `--control-url` | Removed. `BROODS_BASE_URL` serves both the CLI and the SDK |
| `/api/cli/*` routes                   | `/v1/account/*`                                            |

`status`, `--env` and `BROODS_ENVIRONMENT` fail with an error that names the replacement. `BROODS_CONTROL_URL`, `--control-url` and the `/api/cli/*` routes no longer exist, so they do nothing. Environment-based auth needs both `BROODS_TOKEN` and `BROODS_BASE_URL`. Logins from before the base URL change need `broods login` again.
