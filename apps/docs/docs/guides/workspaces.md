# Workspaces

A workspace is a persistent folder of files. It lives in object storage, and each run mounts it into a sandbox. Everything the agent writes there survives the sandbox: notes, generated files, `memory/`, staged skills. Agents that attach the same workspace share the same files.

A workspace alone stores files. The agent needs a [sandbox](sandboxes/index.md) to mount it with full read and write tools; without one it can only read.

```ts title="broods/index.ts"
import { defineAgent, defineSandbox, defineWorkspace } from "broods";

export const box = defineSandbox({ name: "box", provider: "lambda" });

export const notes = defineWorkspace({
  name: "notes",
  storage: { provider: "s3" }, // the default, may be omitted
});

export const myAgent = defineAgent({
  name: "my-agent",
  sandboxes: [box],
  workspaces: [notes],
});
```

The first workspace is the default when a tool call leaves out the `workspace` argument.

## Which sandbox mounts a workspace

Each workspace entry resolves to an effective sandbox:

```ts
workspaces: [
  notes,                                   // inherit the agent's first sandbox
  { workspace: team, sandbox: lockedDown }, // pin its own sandbox
  { workspace: docs, sandbox: null },       // read-only, no compute
],
```

| Entry                | Effective sandbox                                                        |
| -------------------- | ------------------------------------------------------------------------ |
| bare workspace       | the agent's first sandbox, or read-only when the agent has none          |
| `sandbox: <sandbox>` | that sandbox, with its own `permissionMode`                              |
| `sandbox: null`      | none. Reads go straight to storage: cheapest, but they lag recent writes |

That lets one agent give different workspaces different sandboxes and approval rules, lets two agents reach one workspace through their own sandboxes, and makes a workspace read-only.

### Tools per workspace

| Effective sandbox     | Tools                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| a sandbox             | `read`, `write`, `edit`, `glob`, `grep`, `bash`, `memory_save`         |
| none                  | `read` and `glob` through a read-only mount, which sees writes at once |
| none, `sandbox: null` | `read` and `glob` straight from storage, no cold start, reads can lag  |

| Agent has                | Tools                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| sandboxes, no workspace  | `bash`, a fresh machine each call unless the sandbox is persistent |
| sandboxes and workspaces | the workspace tools, plus `bash` on the other sandboxes by name    |
| neither                  | none                                                               |

The file tools list every workspace, so the model picks one with the `workspace` argument, and each call runs on that workspace's sandbox with its `permissionMode`. Writing to a read-only workspace returns "workspace is read-only", and `bash` there returns "no sandbox available for this command". Neither asks for approval.

### Own machine or borrowed

It matters whether the workspace's sandbox is the agent's own first sandbox:

| Setup                                           | What the agent gets                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sandboxes: [a]`, workspace on `a` or inherited | Its own machine with the workspace mounted. On a persistent `a`, `bash` may write anywhere on the machine  |
| workspace on `b`, no `sandboxes`                | `b` only runs the workspace. `bash` writes outside the workspace are refused, except `/tmp` and `/var/tmp` |
| `sandboxes: [a]`, workspace on `b`              | Both. The workspace is scoped as above, and `a` stays reachable with `bash` `sandbox: "<name>"`            |

The refusal exists because the workspace is the only storage that outlives a sandbox. `sandboxes: [a, b]` with a workspace on `b` is rejected, since `b` would be reachable both with and without the mount.

## Partitioning

By default every run mounts the same folder. Partitioning gives each conversation, ticket or team its own folder under one workspace, so a GitHub issue cannot read another issue's files. It separates files, `memory/` and `TASKS.md`. The agent's prompt, tools, credentials and skills stay shared.

Turn it on with `partitioned: true` on the workspace and a `partition` on every connection the agent uses:

```ts
export const support = defineWorkspace({
  name: "support",
  partitioned: true,
});

export const slack = defineSlackConnection({
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});

export const github = defineGitHubConnection({
  partition: { by: "conversation", alias: "support" },
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
});
```

- `by: "shared"` mounts the workspace root. That run sees root files and every child folder.
- `by: "conversation"` mounts only a private child folder under `alias/`. It cannot see the root or its siblings.
- `alias` is the folder name under the root. It may contain letters, digits, dots, underscores and hyphens.

| Run                           | Agent sees          | Mounted folder                      |
| ----------------------------- | ------------------- | ----------------------------------- |
| Direct API or cron            | workspace `support` | root                                |
| Slack, any thread in `C456`   | workspace `support` | root                                |
| GitHub issue `owner/repo#123` | workspace `support` | `support/<hash of owner/repo#123>/` |
| GitHub issue `owner/repo#456` | workspace `support` | `support/<hash of owner/repo#456>/` |

A new child folder starts empty. Files at the root are not copied in. A [channel record](../channels/channel-records.md) can also set `partition` for one place.

The rules are checked on `broods dev`: a workspace with `partitioned: true` needs `partition` on every attached connection, and a connection with `partition` needs at least one partitioned workspace.

### When a child folder is deleted

| Channel                                         | End of conversation       | Folder deleted |
| ----------------------------------------------- | ------------------------- | -------------- |
| GitHub issue or pull request                    | closed                    | yes            |
| Slack, Discord, Telegram, Matrix, Pancake, Zalo | never, threads do not end | no             |

Only `conversation` folders are ever deleted, shortly after the close event. On chat channels they pile up one per thread, so prune them from the dashboard Files view or the files API, or use `shared` there.

## Bring your own bucket

A workspace can live in an S3 bucket you own. Your bucket needs your credentials:

```ts
export const notes = defineWorkspace({
  name: "notes",
  storage: {
    provider: "s3",
    bucket: "acme-workspaces",
    region: "us-west-2",
    prefix: "agents/", // required, the mount is scoped to bucket/prefix/
    auth: {
      type: "assumeRole",
      roleArn: "arn:aws:iam::111122223333:role/broods-mount",
      externalId: "<shared secret>",
    },
  },
});
```

| `auth.type`        | Credentials                         | Use                     |
| ------------------ | ----------------------------------- | ----------------------- |
| `managed`, default | the platform's role                 | the managed bucket only |
| `assumeRole`       | your IAM role, assumed for each run | required with `bucket`  |

A workspace with `bucket` is rejected unless:

- `auth.type` is `assumeRole` and `roleArn` is a role outside the platform's AWS account.
- `bucket` is not one of the platform's own buckets.
- `endpoint`, if set, is a public `https` URL. Other S3-compatible stores keep `provider: "s3"` and change `endpoint`.

The platform assumes your role for each run and narrows the session to `bucket/prefix*`, so code in the sandbox only ever holds credentials for that prefix. Set `externalId` when the role trusts Broods across accounts. No access keys are stored. Static access keys for R2 or MinIO are not supported yet, so a bring-your-own bucket needs an AWS IAM role. `deny-all` sandboxes cannot reach your bucket; use `allow-all`.

These rules are checked when you save and again whenever the storage is used, so a workspace saved before a rule existed fails with the same error until you fix it.

## Files and sharing

The dashboard Files tab lists, uploads, renames and deletes the same files the agent mounts. Uploads there are capped at 512 KiB per file; agents can write larger files through the mount.

To hand a file to a person, mint a download link:

```bash
curl -X POST "$BROODS_BASE_URL/v1/workspaces/$WORKSPACE_ID/download-links" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"path": "documents/report.docx", "expiresInSeconds": 86400}'
```

It returns a short `downloadPath` such as `/v1/downloads/K3n8…`. Join it to the base URL. It lasts as long as you asked, 24 hours by default and 30 days at most, and anyone holding it can download that one file. Deleting the workspace or the account revokes it.

`GET /v1/workspaces/{id}/files?path=…` returns a presigned storage URL instead. It expires in five minutes and breaks when a chat or email client rewrites it, so use it only for machine fetches you make right away.

## Freshness

The agent always sees its own writes, because its tools read through the mount. A file written through the mount reaches storage when it is closed, so other readers, such as the dashboard Files tab, another sandbox, or `memory/MEMORY.md` loaded at the start of a turn, can briefly see the older version. Details are in [Storage internals](../internals/storage.md).

See [Memory and sessions](memory-and-sessions.md) for what the agent stores in a workspace on its own.
