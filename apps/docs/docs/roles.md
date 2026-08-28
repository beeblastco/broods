# Account Roles

Every account credential used to be all-or-nothing: whoever holds the account secret holds the whole config plane. Account roles fix that. A role is a named, scoped API credential (`fp_role_...`) carrying a policy over the config-plane API, and it is never used directly — you exchange it for a short-lived session token, modeled on AWS STS.

## The model

- **Role** (`fp_role_...`): created with the account secret under `/v1/roles`. Carries a version-1 policy document whose rule actions use the API namespace: one `<resource>:read` / `<resource>:write` pair per config-plane resource — `agents`, `channels`, `crons`, `env`, `hooks`, `policies`, `sandboxes`, `skills`, `tools`, `workspaces`, and `account`. Optional `projectId`/`stageId` pin the role to one stage.
- **Session** (`fp_sts_...`): minted by `POST /v1/account/assume-role` with `{ roleId, ttlSeconds? }`. Default TTL is 1 hour, maximum 12. Only the hash is stored; the token is shown once. A session authenticates the same `/v1/*` routes as the account secret but every request is checked against the role's policy — no matching allow rule means 403.

Three credentials may call assume-role:

1. The account secret (`fp_acct_...`) — the human path: hold the master credential, mint a narrow session for the tool you are about to hand it to.
2. A CLI login token (`fp_cli_...`) — same, for `broods` CLI users.
3. A stage runtime key (`fp_agent_...`) — the agent path. The key may only assume roles whose `projectId`/`stageId` match its own deployment, so a leaked runtime key cannot widen past the stage it already controls.

Sessions cannot chain into new sessions, cannot rotate the account secret, and cannot touch `/v1/roles` — role management is account-secret only. Revocation is one PATCH: `status: "disabled"` kills every live session of the role.

## Example

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

// This client can list and read agents, and nothing else.
const scoped = new BroodsAccountClient({ sessionToken: session.token });
const agents = await scoped.listAgents();
```

Rules can also scope to specific resources with `resources.resourceIds` (`"*"` matches every id), and a `deny` rule always beats an `allow`. The full endpoint contract lives in the [API reference](/api-reference).
