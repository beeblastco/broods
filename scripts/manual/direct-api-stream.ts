import { fetchWithTiming, printTimingResults, requireManualEnv } from "./direct-api-utils.ts";

const FUNCTION_URL = requireManualEnv("FUNCTION_URL");

const result = await fetchWithTiming(FUNCTION_URL, {
  eventId: `test-${Date.now()}`,
  conversationKey: `test-${Date.now()}`,
  events: [
    {
      role: "system",
      content: "Reply with plain text only and no commentary.",
      persist: false,
    },
    {
      role: "user",
      content: [{ type: "text", text: "Count from 1 to 10 slowly, one number per line." }],
    },
  ],
});

console.log("\nStatus:", result.response.status);
printTimingResults(result);
