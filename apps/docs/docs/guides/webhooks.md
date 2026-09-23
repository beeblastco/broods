# Webhooks

Lifecycle webhooks POST a signed JSON event to your HTTPS endpoint when a run starts, runs a tool, finishes or fails. Use them for audit logs, alerts or analytics. They cannot change the run. For that, use [hooks](hooks.md).

These are not the provider webhooks that bring chat messages in. Those are covered in [Channels](../channels/index.md).

```ts title="broods/index.ts"
import { defineAgent, env } from "broods";

export const agent = defineAgent({
  name: "agent",
  hooks: {
    webhooks: [
      {
        enabled: true,
        url: "https://example.com/agent-events",
        secret: env("WEBHOOK_SECRET"),
        events: [
          "agent.started",
          "tool.call.finished",
          "agent.finished",
          "agent.failed",
        ],
      },
      {
        enabled: true,
        url: "https://audit.example.com/events",
        secret: env("AUDIT_WEBHOOK_SECRET"),
        events: ["agent.failed"],
      },
    ],
  },
});
```

| Field     | Description                                  |
| --------- | -------------------------------------------- |
| `enabled` | Turns delivery on for this entry             |
| `url`     | Public HTTPS endpoint                        |
| `secret`  | HMAC signing secret                          |
| `events`  | Events to send. Omit it to send all of them. |

Every enabled entry whose `events` match gets its own delivery. Private, loopback, link-local and internal hosts are rejected when you save and again at delivery. Redirects are not followed.

You can also add, toggle and remove webhooks in the dashboard under Settings, Webhooks, which needs the org admin role. The signing secret is write-only there. `broods agent get <name>` lists them.

## Events

| Event                     | Sent when                              |
| ------------------------- | -------------------------------------- |
| `agent.started`           | a run starts                           |
| `agent.step.finished`     | a model step finishes                  |
| `agent.finished`          | the agent produces its final answer    |
| `agent.failed`            | the run fails                          |
| `agent.approval.required` | a tool waits for approval              |
| `tool.call.started`       | a tool call starts                     |
| `tool.call.finished`      | a tool call finishes or fails          |
| `tool.result`             | tool results from a step are available |
| `subagent.task.started`   | a subagent task starts                 |
| `subagent.task.finished`  | a subagent task finishes or fails      |

## Payload and signature

```json
{
  "type": "tool.call.finished",
  "timestamp": "2026-05-17T20:00:00.000Z",
  "accountId": "acct_...",
  "agentId": "agent_...",
  "eventId": "acct:...:api:...",
  "conversationKey": "acct:...:conversation:...",
  "payload": { "success": true }
}
```

Each request carries `X-Webhook-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body with your secret. Verify it before trusting the body:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function isValid(rawBody: string, header: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  return (
    header.length === expected.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(expected))
  );
}
```

Delivery is best effort. A failed delivery is logged and never fails the run.

The [`webhook` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/webhook) is a runnable example.
