const FUNCTION_URL = "https://redactedharnessurlid.lambda-url.eu-central-1.on.aws/";
import { fetchWithTiming, printTimingResults } from "./utils";

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
