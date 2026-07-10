# broods

CLI and TypeScript SDK for the Broods agent platform.

## Install

```bash
bun add broods
# or
npm install broods
```

The CLI requires Bun:

```bash
bun add -g broods
broods dev
```

## Invoke an Agent

```ts
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient({
  apiKey: process.env.BROODS_API_KEY,
});

const result = await client.run(api.agents.myAgent, {
  input: "Hello",
});

console.log(result.text);
```

Runtime calls use an environment runtime API key. After `broods deploy`, the CLI
writes `BROODS_API_KEY` to `.env.local`; the SDK also accepts `apiKey`,
`BROODS_API_KEY`, `baseUrl`, and `BROODS_BASE_URL`.

## Two ways to configure agents

**Config-first (`broods dev` / `broods deploy`).** Resources declared in your
`broods/` folder with `defineAgent`, `defineWorkspace`, etc. are *predefined
configs*: the CLI syncs them to your project on deploy and codegen gives you
typed references. Use this when the set of agents is fixed and versioned with
your code.

**Dynamic config at runtime (`BroodsAccountClient`).** When your app needs to
create or mutate config while it runs — for example a multi-tenant product that
provisions one agent per customer — use the account config client with your
account secret. It is the complete typed client for the account config plane:
agents, sandboxes (config + suspend/resume/terminate/snapshot/terminal),
workspaces (config + file upload/rename/delete/download), tools, policies,
skills, crons (+ run history), and the account itself (metadata, secret
rotation, deletion). It is a separate, dependency-free entry point
(`broods/account`) built on plain `fetch`, so it also works in edge runtimes
such as Convex actions and Cloudflare Workers where the main SDK entry (which
reads `.env` files from disk) cannot load:

```ts
import { BroodsAccountClient } from "broods/account";

// baseUrl defaults to https://gateway.broods.app (override with BROODS_BASE_URL);
// the secret falls back to BROODS_ACCOUNT_SECRET from the runtime's environment.
const account = new BroodsAccountClient({
  accountSecret: process.env.BROODS_ACCOUNT_SECRET,
});

// Provision a tenant agent (config is deep-merged on update; null deletes keys).
const created = await account.createAgent({
  name: `tenant-agent-${customerId}`,
  config: {
    model: { provider: "custom", modelId: "Qwen3.6-27B" },
    agent: { system: "You are the tenant's sales assistant." },
    publicAccess: true,
  },
});
await account.updateAgent(created.agentId, {
  config: { channels: { slack: { id: "conn-1", botToken: "xoxb-…" } } },
});

// Schedule it, browse its workspace, surface its webhook URL.
await account.createCron({
  name: "daily-digest",
  agentId: created.agentId,
  input: "Summarize yesterday's conversations.",
  scheduleExpression: "cron(0 8 * * ? *)",
});
const { accountId } = await account.getAccount();
const url = account.webhookUrl(accountId, created.agentId, "slack");

// The same client covers the rest of the config plane: standalone sandboxes and
// workspaces, uploaded tools, reusable policies, skills, and cron run history.
const sandbox = await account.createSandbox({
  name: "reserved",
  config: { provider: "lambda", persistent: true, permissionMode: "ask" },
});
await account.uploadWorkspaceFile("ws_1", { path: "memory/seed.md", contentBase64: "IyBTZWVk" });
await account.createSkill({ source: "json", name: "triage", description: "Triage flow", content: "# Triage" });
const runs = await account.listCronRuns("cron_1", { limit: 20 });

// Persistent sandbox lifecycle is driven by reservationKey.
await account.suspendSandbox(sandbox.sandboxId, "ws-namespace");

// Rotate the account secret when needed (the returned secret is shown once).
const { secret } = await account.rotateSecret();
```

`get`/`update` methods return `null` (and `delete` returns `false`) when the
resource does not exist, so upsert flows need no try/catch; other API errors
throw `BroodsAccountApiError` with the HTTP status. Secrets inside configs are
encrypted at rest and come back redacted on reads.

## License

The `broods` npm package, including the CLI and TypeScript client SDK, is MIT
licensed. The core server code in the monorepo is licensed separately.

Documentation: https://github.com/beeblastco/broods/tree/dev/apps/docs/docs
