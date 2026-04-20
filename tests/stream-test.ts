const FUNCTION_URL = "https://redactedharnessurlid.lambda-url.eu-central-1.on.aws/";
import { fetchWithTiming, printTimingResults } from "./utils";

const result = await fetchWithTiming(FUNCTION_URL, {
  eventId: `test-${Date.now()}`,
  conversationKey: `test-${Date.now()}`,
  content: [{ type: "text", text: "Count from 1 to 10 slowly, one number per line." }],
});

console.log("\nStatus:", result.response.status);
printTimingResults(result);