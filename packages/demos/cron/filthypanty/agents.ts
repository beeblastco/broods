import { defineAgent, defineCron, env } from "filthy-panty";

export const cron = defineAgent({
  name: "cron-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "You are a concise scheduled maintenance assistant.",
    },
  },
});

export const oneMinuteCron = defineCron({
  name: "one-minute-cron-test",
  config: {
    agent: cron,
    conversationKey: "cron:one-minute-test",
    input: "Say hello and the current time.",
    scheduleExpression: process.env.CRON_SCHEDULE_EXPRESSION ?? atExpressionOneMinuteFromNow("Europe/Amsterdam"),
    timezone: "Europe/Amsterdam",
  },
});

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
