import { fetchWithTiming, printTimingResults, requireTestEnv } from "./utils";

const FUNCTION_URL = requireTestEnv("FUNCTION_URL");

const result = await fetchWithTiming(FUNCTION_URL, {
  eventId: `test-${Date.now()}`,
  conversationKey: `test-${Date.now()}`,
  events: [
    {
      role: "system",
      content: "Be concise after using tools.",
      persist: false,
    },
    {
      role: "user",
      content: [{ type: "text", text: "Search the web for the latest weather in Hanoi." }],
    },
  ],
});

console.log("\nStatus:", result.response.status);
printTimingResults(result);
