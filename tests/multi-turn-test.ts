const FUNCTION_URL = "https://redactedharnessurlid.lambda-url.eu-central-1.on.aws/";
import { fetchWithTiming, printTimingResults } from "./utils";

const conversationKey = `multi-turn-${Date.now()}`;

async function send(content: string, turn: number) {
  console.log(`\n--- Turn ${turn}: ${content.substring(0, 40)}... ---`);
  return fetchWithTiming(FUNCTION_URL, {
    eventId: `${conversationKey}-${turn}`,
    conversationKey,
    content: [{ type: "text", text: content }],
  });
}

const startTime = Date.now();
let totalResponseBytes = 0;

const r1 = await send("What is my name?", 1);
totalResponseBytes += r1.responseSizeBytes;

const r2 = await send("What's the weather in Hanoi?", 2);
totalResponseBytes += r2.responseSizeBytes;

const r3 = await send("What's the weather in Ho Chi Minh city?", 3);
totalResponseBytes += r3.responseSizeBytes;

const r4 = await send("What's the weather in New York and Los Angeles? Compare them with Hanoi and Ho Chi Minh.", 4);
totalResponseBytes += r4.responseSizeBytes;

const r5 = await send("What was the first question I asked you?", 5);
totalResponseBytes += r5.responseSizeBytes;

const totalMs = Date.now() - startTime;

console.log("\n=== All turns completed ===");
console.log(`\n--- Total Timing Results ---`);
console.log(`Total Time:    ${totalMs}ms`);
console.log(`Total Response Size: ${(totalResponseBytes / 1024).toFixed(1)} KB`);

printTimingResults({ ttfbMs: 0, totalMs, responseSizeBytes: totalResponseBytes, sseText: "", response: r5.response });