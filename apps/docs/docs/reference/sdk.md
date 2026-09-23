---
title: TypeScript SDK
---

# TypeScript SDK reference

The `broods` package ships three clients:

| Client                | Import           | Credential                     | Use it to                                    |
| --------------------- | ---------------- | ------------------------------ | -------------------------------------------- |
| `BroodsClient`        | `broods`         | Stage runtime key              | Run agents over HTTP and SSE, manage crons   |
| `WebSocketClient`     | `broods`         | Stage runtime key              | Run and steer agents over one socket         |
| `BroodsAccountClient` | `broods/account` | Account secret or role session | Create and change config while your app runs |

There is no Python SDK yet. Call the [HTTP API](http-api.md) directly.

## Install

```bash
bun add broods     # or: npm install broods
```

`ai` (the Vercel AI SDK) is a peer dependency. npm and bun install it for you. On a package manager that skips peers, add it yourself, or valid agent configs fail to compile.

## Generated references

`broods dev` and `broods deploy` write typed references to `broods/_generated/api.ts`. The folder is empty until the first sync.

```ts
import { api } from "./broods/_generated/api";

api.agents.myAgent; // AgentReference: id, project, stage, endpoint
api.channels.myTelegram; // ChannelReference: type, agent, webhook path
api.workspaces.notes; // workspace id
api.sandboxes.lambda; // sandbox id
```

Pass an `AgentReference` to the client. It carries the routing metadata, and the gateway rejects a reference whose scope does not match the key.

## BroodsClient

```ts
import { BroodsClient } from "broods";

const client = new BroodsClient();
```

| Option    | Default                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `apiKey`  | `BROODS_API_KEY`, loaded from `.env` and `.env.local`                                 |
| `baseUrl` | `BROODS_BASE_URL`, then `https://gateway.broods.app`                                  |
| `host`    | Hostname form of `baseUrl`. `gateway.broods.app` becomes `https://gateway.broods.app` |
| `fetch`   | Global `fetch`                                                                        |

The runtime key (`fp_agent_...`) is scoped to one project and stage. It reaches only agents with `publicAccess: true` in that stage.

### Methods

| Method                                         | Returns                          | What it does                                                     |
| ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `run(agent, input)`                            | `{ text, events }`               | Streams a run and collects the text and parts                    |
| `stream(agent, input)`                         | `AsyncGenerator<TextStreamPart>` | Yields AI SDK stream parts as they arrive                        |
| `runAsync(agent, input)`                       | `AsyncAgentRun`                  | Starts a background run, returns `runId` and `statusUrl`         |
| `continue(agent, { conversationKey })`         | `AsyncAgentRun`                  | Re-enters a run that stopped on the step cap or a provider fault |
| `getAsyncStatus(runOrUrl)`                     | `AsyncStatus`                    | One status snapshot. `{ status: "not_found" }` on 404            |
| `waitForAsyncStatus(runOrUrl, options)`        | `AsyncStatus`                    | Polls until a settled status or timeout                          |
| `agent(ref)`                                   | `AgentHandle`                    | Binds `run`, `stream`, `runAsync`, `continue` to one agent       |
| `createCron(input)`                            | `Cron`                           | Creates a schedule. `agent` takes a reference                    |
| `listCrons()`, `getCron(id)`                   | `Cron[]`, `Cron \| null`         | Reads schedules                                                  |
| `listCronRuns(id, { limit })`                  | `CronRun[]`                      | Recent runs of one schedule                                      |
| `updateCron(id, patch)`                        | `Cron`                           | Changes fields, including `status: "paused"`                     |
| `deleteCron(id)`                               | `boolean`                        | Deletes the schedule and its run history                         |
| `channelWebhookUrl(ref)`                       | `string`                         | Webhook URL for a generated channel reference                    |
| `accountWebhookUrl(accountId, type)`           | `string`                         | Production webhook URL for a channel type                        |
| `stageWebhookUrl(accountId, endpointId, type)` | `string`                         | Webhook URL pinned to one non-production stage                   |

`AsyncAgentRun` has `runId`, `eventId`, `statusUrl`, `conversationKey`, `poll()` and `wait(options)`. `wait` and `waitForAsyncStatus` take `intervalMs` (default 2000), `timeoutMs` (default 180000) and `signal`, and return on `completed`, `failed`, `expired`, `awaiting_approval`, `awaiting_input` or `not_found`.

```ts
const result = await client.run(api.agents.myAgent, { input: "Hello" });

for await (const part of client.stream(api.agents.myAgent, {
  input: "Tell me a story.",
})) {
  if (part.type === "text-delta") process.stdout.write(part.text);
}

const job = await client.runAsync(api.agents.myAgent, {
  input: "Write the report.",
});
const status = await job.wait({ timeoutMs: 300_000 });
```

### Run input

Pass exactly one of `input` or `events`.

| Field             | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `input`           | One user text message                                                                        |
| `events`          | AI SDK model messages, for images, files, tool approval responses                            |
| `conversationKey` | Conversation to continue. Omit for a new one                                                 |
| `eventId`         | Correlation id. Generated when omitted                                                       |
| `idempotencyKey`  | Retry identity within the conversation. Defaults to `eventId`, bound for 7 days              |
| `mode`            | What to do when the conversation is busy: `steer` (default), `followup`, `collect`, `reject` |
| `system`          | One-turn system message or messages, not persisted                                           |
| `model`           | Per-run call settings: `temperature`, `maxOutputTokens`, `reasoning`, `providerOptions`, ... |

`model` rejects `provider`, `modelId`, `output` and `apiKey`, so a request cannot swap the model or credentials. With a runtime key, `system` and `model` need `allowRunOverrides: true` on the agent, or the run fails with `403 run_overrides_disabled`.

```ts
await client.run(api.agents.myAgent, {
  events: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", image: "data:image/png;base64,iVBORw0KGgo..." },
      ],
    },
  ],
  model: { temperature: 0.3, reasoning: "high" },
});
```

### Stream parts

`stream` yields the AI SDK `TextStreamPart` shape: `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `finish`, `error` and the rest. An `error` part throws. Closing the stream before the run finishes aborts the run and marks it failed. Steps that already finished stay in the conversation. Use `runAsync` when the caller may disconnect.

### Async status

| `status`                                      | Meaning                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `accepted`, `queued`, `applied`, `processing` | Not finished                                                        |
| `awaiting_approval`                           | A tool needs approval. `approvals` lists them                       |
| `awaiting_input`                              | The agent asked with `ask_questions`. `questions` lists the prompts |
| `completed`                                   | Done. `response` and `result` hold the answer                       |
| `failed`                                      | `error` explains. `stoppedByUser: true` means a deliberate stop     |
| `expired`                                     | Queued work was never run                                           |

Every status also carries `requestedMode`, `appliedMode` and `appliedToEventId`, which say whether a busy request steered the live run or became a follow-up. See [Conversations](../guides/conversations.md).

### Busy conversations

A `stream` call that lands on a busy conversation and is queued instead of streamed throws `IngressAcceptedError`. Its `accepted` field holds the run id, so you can poll it:

```ts
import { IngressAcceptedError } from "broods";

try {
  for await (const part of client.stream(api.agents.myAgent, {
    conversationKey,
    mode: "followup",
    input: "Then summarize.",
  })) {
    // ...
  }
} catch (error) {
  if (!(error instanceof IngressAcceptedError)) throw error;
  const final = await client.waitForAsyncStatus(error.accepted);
}
```

## WebSocketClient

Runs agents over one socket with durable replay, steering and cancel. Also exported as `BroodsWebSocketClient`.

```ts
import { WebSocketClient } from "broods";

const ws = new WebSocketClient();
```

| Option             | Default                                            |
| ------------------ | -------------------------------------------------- |
| `apiKey`           | `BROODS_API_KEY`. Required                         |
| `baseUrl`, `host`  | As for `BroodsClient`. `https` becomes `wss`       |
| `WebSocket`        | `globalThis.WebSocket`. Pass one on older runtimes |
| `connectTimeoutMs` | 2000                                               |

The key travels as a `Sec-WebSocket-Protocol` entry (`broods.v1`, `broods.token.<key>`), never in the URL.

| Method                        | What it does                                            |
| ----------------------------- | ------------------------------------------------------- |
| `subscribe(input, handlers)`  | Starts a run and calls handlers. Returns a subscription |
| `stream(input)`               | Same run as an async generator of messages              |
| `attach(input, handlers)`     | Reattaches to a running event and replays from a cursor |
| `subscription.sendControl(m)` | Sends more input to the live run. Steers by default     |
| `subscription.close()`        | Closes the socket                                       |

`subscribe` input takes the run input fields above plus `agent` (a reference), `sessionId` (the conversation key) and `signal`. An aborted signal sends `cancel`. Pass `answers` instead of `input` to answer an open `ask_questions` prompt; the resumed run streams back on the same socket.

| Handler     | Receives                                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| `onMessage` | Every message, with output envelopes unwrapped to the stream part              |
| `onOutput`  | The raw output envelope `{ cursor, replay, data }`. Store `cursor` to resume   |
| `onMeta`    | `{ sessionId, taskId }` once the socket is ready. Safe point for `sendControl` |
| `onDone`    | The run finished                                                               |
| `onError`   | An error frame or a socket failure                                             |

```ts
const sub = ws.subscribe(
  {
    agent: api.agents.myAgent,
    sessionId: "ticket-42",
    input: "Investigate the failure.",
  },
  {
    onMeta() {
      sub.sendControl({
        requestId: "c1",
        eventId: "turn-2",
        input: "Check the gateway first.",
      });
    },
    onMessage(message) {
      if (message.type === "text-delta") process.stdout.write(message.text);
    },
  },
);
```

`attach` takes `agentId`, `conversationKey`, `eventId`, `runId`, `requestId` and an optional `afterCursor`. See the [WebSocket protocol](http-api.md) for frames, and the [`websocket` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/websocket).

## BroodsAccountClient

Creates and changes config at runtime, for example one agent per customer. Resources you declare in `broods/` belong to `broods dev` and `broods deploy`; use this client for everything created on the fly.

```ts
import { BroodsAccountClient } from "broods/account";

const account = new BroodsAccountClient({
  accountSecret: process.env.BROODS_ACCOUNT_SECRET,
});
```

| Option          | Default                                                     |
| --------------- | ----------------------------------------------------------- |
| `accountSecret` | `BROODS_ACCOUNT_SECRET` (`fp_acct_...`)                     |
| `sessionToken`  | `BROODS_SESSION_TOKEN` (`fp_sts_...`). Wins over the secret |
| `baseUrl`       | `BROODS_BASE_URL`, then `https://gateway.broods.app`        |
| `fetch`         | Global `fetch`                                              |

The entry point has no dependencies and uses plain `fetch`, so it runs in Convex actions, Cloudflare Workers and other edge runtimes where the main `broods` entry cannot load.

| Resource   | Methods                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account    | `getAccount`, `updateAccount`, `rotateSecret`, `deleteAccount`, `assumeRole`, `webhookUrl`                                                                                        |
| Agents     | `listAgents`, `createAgent`, `getAgent`, `updateAgent`, `deleteAgent`                                                                                                             |
| Env        | `listEnvVars`, `setEnvVar`, `deleteEnvVar`                                                                                                                                        |
| Crons      | `listCrons`, `createCron`, `getCron`, `updateCron`, `deleteCron`, `listCronRuns`                                                                                                  |
| Workspaces | `listWorkspaces`, `createWorkspace`, `getWorkspace`, `updateWorkspace`, `deleteWorkspace`                                                                                         |
| Files      | `listWorkspaceFiles`, `getWorkspaceFileUrl`, `uploadWorkspaceFile`, `renameWorkspaceFile`, `deleteWorkspaceFile`                                                                  |
| Sandboxes  | `listSandboxes`, `createSandbox`, `getSandbox`, `updateSandbox`, `deleteSandbox`, `suspendSandbox`, `resumeSandbox`, `terminateSandbox`, `snapshotSandbox`, `openSandboxTerminal` |
| MCP        | `listMcp(scope)`, `createMcp`, `uploadMcpBundle`, `getMcp`, `updateMcp`, `deleteMcp`                                                                                              |
| Policies   | `listPolicies`, `createPolicy`, `getPolicy`, `updatePolicy`, `deletePolicy`                                                                                                       |
| Roles      | `listRoles`, `createRole`, `getRole`, `updateRole`, `deleteRole`                                                                                                                  |
| Channels   | `listChannels`, `createChannel`, `getChannel`, `updateChannel`, `deleteChannel`                                                                                                   |
| Skills     | `listSkills`, `createSkill`, `getSkill`, `uploadSkill`, `deleteSkill`                                                                                                             |

Behavior shared by every method:

- `get*` returns `null` on 404 and `delete*` returns `false`, so upserts need no try/catch.
- Other failures throw `BroodsAccountApiError` with the HTTP `status` and response body.
- Updates deep-merge `config` into the stored config. A `null` value deletes a key.
- Secrets inside configs are encrypted at rest and come back as `********`. Sending `********` back keeps the stored value.

```ts
const existing = await account.getAgent(savedAgentId);
const agent = existing
  ? await account.updateAgent(savedAgentId, { config: config })
  : await account.createAgent({ name: `tenant-${customerId}`, config: config });

const role = await account.createRole({
  name: "agents-reader",
  policy: {
    version: 1,
    rules: [{ id: "r1", effect: "allow", actions: ["agents:read"] }],
  },
});
const session = await account.assumeRole(role.roleId, { ttlSeconds: 900 });
const scoped = new BroodsAccountClient({ sessionToken: session.token });
```

See [Security](../guides/security.md) for roles and sessions, and the [API reference](/api-reference) for request and response schemas.
