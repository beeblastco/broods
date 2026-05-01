import { fetchWithTiming, manualFunctionUrl, printTimingResults, withManualTestAccount } from "./utils.ts";

const FUNCTION_URL = manualFunctionUrl();

await withManualTestAccount(async ({ accountSecret }) => {
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
  }, accountSecret);

  console.log("\nStatus:", result.response.status);
  printTimingResults(result);
});
