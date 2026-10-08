# Security

Who can see and change what, which credential to use where, and how your data is stored.

## Dashboard roles

Access follows organization membership. A member reads, an admin or owner writes. Removing or demoting someone takes effect on their next request, and their `broods login` stops working.

A custom role, made under Organization settings, Roles, sits on the member tier and adds what its policies allow: seeing or changing keys, changing members, changing access. A policy or a rule scoped to a project or a stage counts only there, and only an enforce-mode policy counts. A member grants no more than they hold: `members:write` cannot hand out the admin tier or a role with a permission the caller lacks, and `access:write` can still attach any policy to any role, including one's own, so give it as you would admin. Policies and permissions are the organization's, under the tabs beside it, so one policy can serve a role, an agent or a key. Roles and policies are read with the same deny-wins order OPA uses for agents at run time.

| Operation                                                                    | Member | Admin, owner |
| ---------------------------------------------------------------------------- | ------ | ------------ |
| Read agents, stages, canvas, files, logs, traces, usage                      | yes    | yes          |
| Test an agent in the dashboard chat                                          | yes    | yes          |
| Create or edit agents, the canvas, workspace files, MCP servers              | no     | yes          |
| Reveal, set or delete an environment variable                                | no     | yes          |
| Reveal or rotate the runtime key                                             | no     | yes          |
| Create, clone or promote a stage. Create or delete a project.                | no     | yes          |
| Manage agent webhooks and scheduled jobs                                     | no     | yes          |
| Exec, open a terminal, snapshot, suspend or terminate a sandbox              | no     | yes          |
| Call an MCP tool from the explorer. Create or revoke project keys and roles. | no     | yes          |

The CLI only works for owners and admins.

## Credentials

Three keys are yours to hold. Use the narrowest one that works.

| Key         | Prefix  | Scope                 | What it can do                                                           | Never                                       |
| ----------- | ------- | --------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| Account key | `bask_` | The whole account     | Everything: create and change agents, crons, files and roles, run agents | Put it in a frontend or hand it to an agent |
| Project key | `bpdk_` | One project and stage | Deploy, and set and list environment variables                           | Expect it to read a variable's value        |
| Runtime key | `bsk_`  | One project and stage | Run agents with `publicAccess: true`                                     | Expect it to read logs or change config     |

`BROODS_ACCOUNT_SECRET` holds the account key, `BROODS_TOKEN` a project key, and `BROODS_API_KEY` the runtime key.

The rest are issued for you and expire or follow your membership:

| Credential           | Prefix  | Use it for                                        | Never                                          |
| -------------------- | ------- | ------------------------------------------------- | ---------------------------------------------- |
| CLI login            | `bcli_` | Your own machine                                  | Share it                                       |
| Role session         | `bsts_` | Handing a tool or agent narrow API access         | Expect it to outlive 12 hours                  |
| Stage session ticket | `bdts_` | Minted for you by the dashboard and `broods logs` | Store it. It lasts 15 minutes.                 |
| Run token            | `brt_`  | Sandbox code reading its agent's runs             | Start a run with it, or expect it past the run |

Every Broods credential starts with `b`, so you and a secret scanner can tell it from another vendor's key.

The runtime key is the one key meant to sit in a frontend, so it is limited:

- It only reaches agents with `publicAccess: true` in its own stage. Another stage's agent answers `404`.
- It cannot send `system` messages or `model` overrides unless the agent sets `allowRunOverrides: true`.
- `continue` with it only reopens conversations the direct API started, never a channel conversation.
- It cannot open logs, traces or the machine socket.

The account key is shown once when your organization's API account is provisioned. Rotate it under Organization settings, API access. Rotation breaks everything holding the old one.

A project key is an API key created for one stage under Project settings, Keys, and shown once. See [Deploying from CI](deploying.md#deploying-from-ci).

## Roles

A role gives a tool or agent less than the full account key. You create a role with a policy over the config-plane API, then trade it for a short-lived session token, the way AWS STS works.

```ts
import { BroodsAccountClient } from "broods/account";

const owner = new BroodsAccountClient({
  accountSecret: process.env.BROODS_ACCOUNT_SECRET,
});

const role = await owner.createRole({
  name: "agents-reader",
  policy: {
    version: 1,
    rules: [{ id: "r1", effect: "allow", actions: ["agents:read"] }],
  },
});

const session = await owner.assumeRole(role.roleId, { ttlSeconds: 900 });
const scoped = new BroodsAccountClient({ sessionToken: session.token }); // can list and read agents, nothing else
```

- Actions are `<resource>:read` and `<resource>:write` for `account`, `agents`, `audit`, `channels`, `crons`, `env`, `hooks`, `mcp`, `policies`, `sandboxes`, `skills`, `tools` and `workspaces`.
- `resources.resourceIds` limits a rule to specific ids, `"*"` for all. A deny beats an allow, and no matching allow means `403`.
- `projectId` and `stageId` pin a role to one stage.
- Sessions last 1 hour by default, 12 at most. Only a hash is stored, and the token is shown once.
- The account key, a CLI login, or a runtime key can assume a role. A runtime key may only assume roles pinned to its own stage.
- Sessions cannot mint sessions, rotate the account key, or manage roles.
- `PATCH` the role with `status: "disabled"` to end every live session at once.
- Opening the machine socket for a sandbox needs `sandboxes:write` on it.

For the CLI's MCP server, prefer a role session in `BROODS_SESSION_TOKEN` over the account key. See [CLI reference](../reference/cli.md).

## How your data is stored

- Agent configs, including provider keys and channel tokens, are encrypted with AES-256-GCM before they are stored. API responses show secret fields as `********`. Sending `********` back in an update keeps the stored value.
- Environment variable values are encrypted and write-only for project keys. Webhook signing secrets are write-only in the dashboard.
- The account key is stored as a hash only.
- Workspace files, skills, and hook and MCP bundles are in private S3 buckets with public access blocked.
- Deleting a project removes everything under it on every stage. Deleting the account removes all of its data. Neither can be undone.

## Code you upload

- [Code hooks](hooks.md) run in an isolated V8 sandbox with no file system, no imports, and network only through a `fetch` that blocks private and metadata addresses.
- Hosted MCP servers run outside the Broods core in a child process per bundle, with nothing but log-writing permissions. The child is containment, not a trust boundary: accounts can share a warm runner environment until per-account isolation is switched on, so treat anything the server can reach as reachable by its code and keep secrets out of the bundle.
- Sandbox commands start with a clean environment. Only the `envVars` you declare reach them. Workspace mounts use short-lived credentials limited to that workspace's own files.

## Outbound URLs

MCP server URLs, OAuth token URLs, webhook URLs and custom channel API URLs must be public `https`. Private, loopback, link-local and metadata addresses are refused when you save and again when used, and redirects are not followed.

Self-hosters and contributors can read [Security internals](../internals/security.md) for the details.
