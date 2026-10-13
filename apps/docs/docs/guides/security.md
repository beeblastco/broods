# Security

Who can see and change what, which credential to use where, and how your data is stored.

## Dashboard roles

Access follows organization membership. A member reads, an admin or owner writes. Removing or demoting someone takes effect on their next request, and their `broods login` stops working.

A custom role, made under Organization settings, Roles, sits on the member tier and adds what its policies allow: seeing or changing keys, changing members, changing access. A policy or a rule scoped to a project or a stage counts only there, and only an enforce-mode policy counts. A member grants no more than they hold: `members:write` cannot hand out the admin tier or a role with a permission the caller lacks, nor change or remove a member whose role holds one, and `access:write` can still attach any policy to any role, including one's own, so give it as you would admin. Policies and permissions are the organization's, under the tabs beside it, so one policy can serve a role, an agent or a key. Roles and policies are read with the same deny-wins order OPA uses for agents at run time.

| Operation                                                                    | Member | Admin, owner |
| ---------------------------------------------------------------------------- | ------ | ------------ |
| Read agents, stages, canvas, files, logs, traces, usage                      | yes    | yes          |
| Test an agent in the dashboard chat                                          | yes    | yes          |
| Create or edit agents, the canvas, workspace files, MCP servers              | no     | yes          |
| Reveal, set or delete an environment variable                                | no     | yes          |
| Reveal or rotate the runtime key                                             | no     | yes          |
| Generate or rotate the user token signing secret                             | no     | yes          |
| Turn an agent's user token requirement on or off                             | no     | yes          |
| Create, clone or promote a stage. Create or delete a project.                | no     | yes          |
| Manage agent webhooks and scheduled jobs                                     | no     | yes          |
| Exec, open a terminal, snapshot, suspend or terminate a sandbox              | no     | yes          |
| Call an MCP tool from the explorer. Create or revoke project keys and roles. | no     | yes          |

The CLI only works for owners and admins.

## Credentials

Three keys are yours to hold. Use the narrowest one that works.

| Key            | Prefix  | Scope                 | What it can do                                                           | Never                                       |
| -------------- | ------- | --------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| Account key    | `bask_` | The whole account     | Everything: create and change agents, crons, files and roles, run agents | Put it in a frontend or hand it to an agent |
| Project key    | `bpdk_` | One project and stage | Deploy, set and list environment variables, rotate the signing secret    | Expect it to read a variable's value        |
| Runtime key    | `bsk_`  | One project and stage | Run agents with `publicAccess: true`                                     | Expect it to read logs or change config     |
| Signing secret | `bsig_` | One project and stage | Sign user tokens on your server                                          | Put it in a frontend                        |

`BROODS_ACCOUNT_SECRET` holds the account key, `BROODS_TOKEN` a project key, `BROODS_API_KEY` the runtime key, and `BROODS_USER_TOKEN_SECRET` the signing secret.

The rest are issued for you and expire or follow your membership:

| Credential           | Prefix  | Use it for                                        | Never                                              |
| -------------------- | ------- | ------------------------------------------------- | -------------------------------------------------- |
| CLI login            | `bcli_` | Your own machine                                  | Share it                                           |
| Role session         | `bsts_` | Handing a tool or agent narrow API access         | Expect it to outlive 12 hours                      |
| Stage session ticket | `bdts_` | Minted for you by the dashboard and `broods logs` | Store it. It lasts 15 minutes.                     |
| Run token            | `brt_`  | Sandbox code reading its agent's runs             | Start a run with it, or expect it past the run     |
| User token           | `buat_` | Telling a run which of your users is calling      | Mint it in a browser. It lasts 60 minutes at most. |

Every Broods credential starts with `b`, so you and a secret scanner can tell it from another vendor's key.

The runtime key is the one key meant to sit in a frontend, so it is limited:

- It only reaches agents with `publicAccess: true` in its own stage. Another stage's agent answers `404`.
- It cannot send `system` messages or `model` overrides unless the agent sets `allowRunOverrides: true`.
- `continue` with it only reopens conversations the direct API started, never a channel conversation.
- It cannot open logs, traces or the machine socket.
- An agent that requires a user token refuses it without one. See below.

## Users behind the runtime key

:::warning Conversation keys are readable by anyone with the runtime key

The runtime key sits in your website's code, so every visitor has it. Without a user token, a request names its conversation with `conversationKey` and Broods takes it as given. A visitor who guesses another user's key (a user id, an email, `ticket-42`) can read that conversation's runs, steer it, answer its approvals and continue it. Send a user token on every runtime-key request, and turn the requirement on for every agent your frontend reaches.

:::

Your backend knows who is signed in, so it vouches for them. It signs a short-lived user token with the stage's signing secret, and your frontend sends that token beside the runtime key.

```ts
// On your server, after your own sign-in check.
import { signUserToken } from "broods";

const userToken = await signUserToken({
  userId: session.user.id,
  ttlMs: 10 * 60 * 1000, // 10 minutes is the default, 60 the most
}); // reads BROODS_USER_TOKEN_SECRET
```

```ts
// In the browser.
import { BroodsClient } from "broods";

const client = new BroodsClient({
  apiKey: "bsk_...",
  userToken: () => fetch("/api/broods-token").then((r) => r.text()),
});
await client.run(api.agents.support, {
  conversationKey: "ticket-42",
  input: "Where is my order?",
});
```

With a valid token, every conversation key and event id of that request lives under that user. `ticket-42` becomes `bsu:<userId>:ticket-42`, and responses name it that way. Another user's token, or no token, cannot reach it, for new runs, steering, approvals, `continue` or reading a run.

| Token field     | What it does                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| `userId`        | Your id for the user. Letters, digits and `._@+=-`, at most 128 characters                   |
| `conversations` | Optional. The only conversation keys this user may use. Omit to allow any key under the user |
| `ttlMs`         | Lifetime. Default 10 minutes, at most 60                                                     |

- `broods dev` and `broods deploy` write the signing secret to `.env.local` when the stage has none yet. They never rotate a secret the stage already has; they warn when your checkout does not hold it. You can also generate or rotate it on the dashboard's Runtime key tab. It is shown once. Rotating it voids every token it signed at once.
- Every agent created from now on requires a user token with the runtime key. An agent made before keeps working without one until you turn the requirement on in its Details tab. Plan to turn it on for every existing agent your frontend reaches within 30 days; a token is honored even while the requirement is off, so send tokens first, then flip the switch.
- A forged or expired token fails the whole request with `401`. A missing one on an agent that requires it is `403 user_token_required`. A conversation the token does not list is `403 user_token_conversation`.
- On the WebSocket, `BroodsWebSocketClient` takes `userToken` too. It rides the upgrade as a `broods.user.<token>` subprotocol entry. The gateway closes the socket with `4419` when the token expires; open a new one with a fresh token.
- The account key and the dashboard's stage session ticket speak for the whole stage and take no user token.
- Keys starting with `bsu:` are reserved for user namespaces.

The account key is shown once when your organization's API account is provisioned. Rotate it under Organization settings, API access; that takes `keys:write` for the organization, which admins hold and a role can be granted. The account key is the whole account API, so give organization-wide `keys:write` as you would admin. Rotation breaks everything holding the old one.

A project key is an API key created for one stage under Project settings, Keys, and shown once. That page asks `keys:write` per stage, so a grant on one stage rotates or revokes only that stage's keys; `keys:write` also sees the keys it may change. See [Deploying from CI](deploying.md#deploying-from-ci).

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
- `projectId` and `stageId` pin a role to one stage. A pinned session reaches only agents, crons, channels, MCP servers, policies, sandboxes and workspaces on that stage. Lists, creates, and account-wide resources such as the account, audit, env, hooks and skills answer `403`. A write that points one of its resources at another stage's, such as a production sandbox on a development agent or a cron moved to a production agent, answers `400`. So does an agent or workspace write that names an account env var as `${NAME}` the session may not read with `env:read` (a workspace's R2 keys are such names), which a pinned session never may, or that repoints an MCP server (its URL, transport, bundle or OAuth) whose agents send it such a name.
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
