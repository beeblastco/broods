# Scheduling

Run an agent on a schedule with a cron job. Declare it in code, create it at runtime from the SDK, or let the agent schedule its own work.

## Declare a cron job

```ts title="broods/index.ts"
import { defineAgent, defineCron, env } from "broods";

export const maintainer = defineAgent({
  name: "maintainer",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
});

export const dailyDigest = defineCron({
  name: "daily-digest",
  agent: maintainer,
  input: "Summarize yesterday's activity.",
  scheduleExpression: "cron(0 9 * * ? *)",
  timezone: "Europe/Amsterdam",
});
```

Use `events` instead of `input` for images or several messages:

```ts
events: [{ role: "user", content: [{ type: "text", text: "Check status." }] }],
```

A cron job belongs to the stage of the agent it targets, so each stage can have its own `daily-digest`.

## Schedule expressions

| Cadence                 | Expression                |
| ----------------------- | ------------------------- |
| Every hour              | `rate(1 hour)`            |
| Every Monday 09:00      | `cron(0 9 ? * MON *)`     |
| 1st of each month 08:00 | `cron(0 8 1 * ? *)`       |
| Yearly, Jan 1 09:00     | `cron(0 9 1 1 ? *)`       |
| Once                    | `at(2027-01-01T09:00:00)` |

The cron form is `cron(minutes hours day-of-month month day-of-week year)`. One of day-of-month and day-of-week may be `?`, and year must be `*`. `L`, `W`, `#` and pinned years are rejected.

`timezone` is an IANA name and handles daylight saving. Without it, schedules run in UTC.

A one-time `at(...)` job deletes itself, and its run history, once its run finishes. Read its result from the conversation, not the job. Recurring jobs live until you delete them.

## Where the answer goes

`conversationKey` decides which conversation the run continues:

- The key of an existing channel conversation, such as a Slack thread the agent already answered in: the run continues that conversation with the same channel rules, and the reply is posted there.
- Anything else, including the default `cron:<cronId>`: the run gets its own conversation. Read the result through the run status API. Nothing is posted.

A run that fires while its conversation is busy is skipped and recorded as failed.

## What the agent sees

A scheduled run starts with a note before the instructions: the task name, the schedule and timezone, when it fired, when it was created, whether it fires again, and that nobody is waiting for a reply. In traces the run is labelled `cron`.

Scheduled runs never get the scheduling tools below, so a task cannot reschedule itself by reading its own instructions.

## Manage jobs at runtime

```ts
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

const cron = await client.createCron({
  name: "weekly-digest",
  agent: api.agents.maintainer,
  input: "Summarize this week.",
  scheduleExpression: "cron(0 9 ? * MON *)",
  timezone: "Europe/Amsterdam",
});

await client.updateCron(cron.cronId, { status: "paused" });
const runs = await client.listCronRuns(cron.cronId, { limit: 10 });
await client.deleteCron(cron.cronId); // deletes its run history too
```

Jobs report `status`, `lastInvokedAt`, `lastStatus` and `lastError`. Paused jobs are skipped. The same operations are on `/v1/crons` with the account secret. See the [API reference](/api-reference).

## Let the agent schedule work

```ts
export const assistant = defineAgent({
  name: "assistant",
  scheduler: { enabled: true },
});
```

This is off by default, because a scheduled task starts billable runs long after the request. Turning it on gives the agent four tools and a clock with the current UTC time on every run:

| Tool              | Input                                                                   | Does                                                      |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `schedule`        | `name`, `instructions`, `schedule`, `timezone?`                         | Creates a job for this agent in this conversation         |
| `list_schedules`  | none                                                                    | Lists this agent's jobs                                   |
| `update_schedule` | `cronId`, `name?`, `instructions?`, `schedule?`, `timezone?`, `status?` | Changes only the given fields. `status: "paused"` pauses. |
| `cancel_schedule` | `cronId`                                                                | Deletes the job and its history                           |

An agent can only schedule itself and only manage its own jobs. A job answers in the conversation that created it, so "summarize every morning" asked in Slack is answered in that Slack thread. Instructions can only be changed from that same conversation. Renaming, retiming and pausing work from anywhere.

These are ordinary cron jobs. They show on the dashboard scheduler page, where changing them needs the org admin role. Withhold a tool in one channel with `denyTools` on its [channel record](../channels/channel-records.md).

Runnable example: [`cron` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/cron).
