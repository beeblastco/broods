/**
 * Cron job SDK example using declarative filthy-panty resources.
 *
 * The agent is defined in filthypanty/agents.ts and deployed via the CLI.
 * This script creates a one-time schedule for one minute from now using the
 * deployed agent's ID.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const timezone = process.env.CRON_TIMEZONE ?? "Europe/Amsterdam";

const scheduleExpression = atExpressionOneMinuteFromNow(timezone);

const client = new FilthyPantyClient({
  host: process.env.FILTHY_PANTY_HOST,
  apiKey: process.env.FILTHY_PANTY_API_KEY!,
});

const cronJob = await client.createCronJob({
  name: "One minute cron test",
  agent: api.agents.cronAgent,
  conversationKey: "cron:one-minute-test",
  prompt: "Confirm this scheduled cron test ran successfully in one sentence.",
  scheduleExpression,
  timezone,
});

console.log(JSON.stringify({
  agentId: api.agents.cronAgent.id,
  scheduleExpression,
  timezone,
  cronJob,
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
