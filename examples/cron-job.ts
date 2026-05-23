/**
 * Cron job API example.
 * Creates a test account, agent, and one-time schedule for one minute from now.
 */

import { ACCOUNT_SERVICE_URL, createAccount, createAgent } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const timezone = process.env.CRON_TIMEZONE ?? "Europe/Amsterdam";

const account = await createAccount(`cron-${Date.now()}`);
const agent = await createAgent(account.accountSecret, "Cron test assistant", {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: "You are a concise scheduled maintenance assistant.",
  },
});

const scheduleExpression = atExpressionOneMinuteFromNow(timezone);
const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/cron-jobs`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${account.accountSecret}`,
  },
  body: JSON.stringify({
    name: "One minute cron test",
    agentId: agent.agent.agentId,
    conversationKey: "cron:one-minute-test",
    prompt: "Confirm this scheduled cron test ran successfully in one sentence.",
    scheduleExpression,
    timezone,
  }),
});

if (!response.ok) {
  throw new Error(`Create cron job failed: ${response.status} ${await response.text()}`);
}

console.log(JSON.stringify({
  accountId: account.account.accountId,
  accountSecret: account.accountSecret,
  agentId: agent.agent.agentId,
  scheduleExpression,
  timezone,
  cronJob: await response.json(),
}, null, 2));

function atExpressionOneMinuteFromNow(timeZone: string): string {
  const date = new Date(Date.now() + 60_000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `at(${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second})`;
}
