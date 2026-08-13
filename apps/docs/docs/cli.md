# CLI

`broods` is the command-line face of the config plane. It syncs a local `broods/`
project to a project and stage, and it selects which organization those writes
land in.

## Where a command acts

Three separate things decide what a command touches:

| Setting      | Stored in                        | Changed by                       |
| ------------ | -------------------------------- | -------------------------------- |
| Organization | the CLI login token, server-side | `broods org use`                 |
| Project      | `BROODS_PROJECT` in `.env.local` | `broods dev` prompt, `--project` |
| Stage        | `BROODS_STAGE` in `.env.local`   | `broods stage use`, `--stage`    |

The organization lives on the token, not in `.env.local`, so it is shared by
every project directory on the machine. Run `broods status` before a sync when
you are unsure.

`deploy` is the exception to the stage row: it always targets `production` and
ignores `BROODS_STAGE`, so `broods stage use staging` followed by `broods deploy`
writes to Production, not staging. Pass `--stage staging` to deploy elsewhere.
`dev`, `diff`, `env`, `logs`, `stream`, `agent` and `run` all follow
`BROODS_STAGE`.

Stages were called environments before v0.9. There is no fallback: `--env` and
`BROODS_ENVIRONMENT` are rejected with an error naming their replacement, rather
than resolving to Development and acting on a stage you did not name. Rename the
key in `.env.local` to `BROODS_STAGE`.

A variable exported in your shell wins over `.env.local` for every command. The
CLI still rewrites the file when you switch scope, and warns when an export is
shadowing what it just wrote — `unset BROODS_API_KEY` (or `BROODS_STAGE`) to let
the file take effect.

The dashboard tracks its own active organization, separate from the CLI's. After
`broods org use`, switch the dashboard organization too, otherwise a
`?project=…&stage=…` deep link resolves against the organization the browser is
still on.

## Help

`broods` on its own lists the commands, grouped by what they act on. Each
command carries its own page, reached with `--help` — or, for the commands that
take a subcommand, by typing the command alone:

```bash
broods            # the command list
broods org        # org's subcommands and flags
broods deploy -h  # deploy's flags
```

`org`, `stage`, `env` and `agent` print their page instead of guessing a
default, so `broods org` no longer lists organizations — that is
`broods org list`. An unrecognized subcommand prints the same page alongside the
error.

## status

```bash
broods status
```

Prints the login, control-plane URL, organization, plan, API account, and the
project and stage the next command will act on. It also compares the local
`BROODS_API_KEY` against the key that org and stage actually serve, and warns
when they disagree, which is what happens after switching organizations without
resyncing.

## org

```bash
broods org list
broods org use beeblast
broods org create "New Org"
```

`list` marks the current organization with `*`. Only organizations where you are
owner or admin are selectable; membership alone is not enough, and the target
organization needs a provisioned API account.

`use` and `create` switch the token, store the choice in `~/.broods/config.json`,
and rewrite `BROODS_API_KEY` for the current project and stage in the new
organization. When that project does not exist in the new organization, or the
key lookup fails, the CLI warns and leaves the old key alone rather than writing
a wrong one — the organization switch itself still stands, so run `broods dev` to
create the project there and mint its key.

## stage

Stages are the deploy targets of a project. `Development` is created by the first
`broods dev`, and `broods stage` manages the rest.

```bash
broods stage list
broods stage create staging --from development
broods stage use staging
```

`create --from <stage>` deep-copies the source stage: agent configs, custom
tools, the canvas layout, and every environment variable. This is the same copy
the dashboard's duplicate button performs. Without `--from`, the new stage is
empty. Pass `--use` to switch to the new stage immediately.

Cloning copies secret values into the new stage. Removing a secret later means
removing it from both stages.

`use` writes `BROODS_STAGE` and refreshes `BROODS_API_KEY`, because the
runtime key is per stage. Resources come from your code, so run `broods dev`
after switching to sync them into the new stage.

The names `development` and `production` are reserved: they always become the
`Development` and `Production` stages with their matching kinds.

## Reference

| Command                   | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `init`                    | Create a `broods/` project shell                       |
| `login`                   | Authenticate through the dashboard                     |
| `status`                  | Show the login, org, plan, project and stage in effect |
| `org list\|use\|create`   | Inspect and switch organizations                       |
| `stage list\|use\|create` | Inspect, switch and clone stages                       |
| `dev`                     | Watch, sync the current stage, live-tail logs          |
| `dev --once`              | Sync once and exit                                     |
| `diff`                    | Local desired state against remote state               |
| `deploy`                  | Sync Production once (ignores `BROODS_STAGE`)          |
| `env set\|get\|list\|rm`  | Manage environment variables                           |
| `stream` / `logs`         | Live logs, with or without backfill                    |
| `agent list\|get`         | Inspect synced agents                                  |
| `run <agent>`             | Chat with an agent in a terminal UI                    |

`env` manages variables inside a stage. `stage` manages the stages themselves.
