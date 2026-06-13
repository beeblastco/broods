# @filthy-panty/demos

Runnable demos for the deployed filthy-panty core API and the local CLI/SDK.

## Layout

Every demo is self-contained in its own folder so each can carry the exact
configuration it needs:

```
examples/
  <name>/
    index.ts        # the demo script
    .env.example    # only the env vars THIS demo uses
```

`ACCOUNT_SERVICE_URL` and `AGENT_SERVICE_URL` (from `sst deploy` outputs) are
required by every demo; demo-specific keys (sandbox providers, webhook secrets,
etc.) appear only in the folders that use them.

## Running a demo

```bash
cp examples/stream/.env.example examples/stream/.env   # fill in values
bun run demo:stream
```

Each `demo:<name>` script `cd`s into `examples/<name>`, so Bun auto-loads that
folder's `.env`. Run `bun run` with no script name to list them all.

## CLI / SDK login

The CLI demo lives in `examples/cli/` (with its `filthypanty/` project).

```bash
bun run cli:login          # prod dashboard (CLI default: dashboard.beeblast.co)
bun run cli:login:dev      # https://dashboard.dev.beeblast.co
bun run cli:login:local    # http://localhost:3000 (local dashboard + convex dev)
```

Login opens a browser, authenticates through the dashboard (WorkOS), and stores
a token at `~/.filthy-panty/config.json` (outside this repo). The remaining
`cli:diff` / `cli:dev` / `cli:deploy` / `cli:run` scripts reuse that token.

> Note: login requires the dashboard's `cliAuth` Convex functions to be deployed
> in the target environment. If you see the CLI hang after "Opening …", check the
> browser tab / dashboard logs for a 500 — an undeployed `cliAuth:createLoginCode`
> is the usual cause.
