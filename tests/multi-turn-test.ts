import { fetchWithTiming, printTimingResults, requireTestEnv } from "./utils";

const FUNCTION_URL = requireTestEnv("FUNCTION_URL");

const conversationKey = `multi-turn-${Date.now()}`;

async function sendLegacy(content: string, turn: number) {
  console.log(`\n--- Turn ${turn}: ${content.substring(0, 40)}... ---`);
  return fetchWithTiming(FUNCTION_URL, {
    eventId: `${conversationKey}-${turn}`,
    conversationKey,
    events: [
      {
        role: "user",
        content: [{ type: "text", text: content }],
      },
    ],
  });
}

async function sendWithEvents(content: string, turn: number) {
  console.log(`\n--- Turn ${turn} (events): ${content.substring(0, 40)}... ---`);
  return fetchWithTiming(FUNCTION_URL, {
    eventId: `${conversationKey}-${turn}`,
    conversationKey,
    events: [
      {
        role: "system",
        content: "Keep answers short unless the user asks for more detail.",
        persist: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: content }],
      },
    ],
  });
}

const startTime = Date.now();
let totalResponseBytes = 0;

const r1 = await sendLegacy("Remember that my name is Taylor.", 1);
totalResponseBytes += r1.responseSizeBytes;

const r2 = await sendWithEvents("What is my name?", 2);
totalResponseBytes += r2.responseSizeBytes;

const r3 = await sendLegacy("Search the web for the weather in Hanoi.", 3);
totalResponseBytes += r3.responseSizeBytes;

const r4 = await sendLegacy("Search the web for the weather in Ho Chi Minh city.", 4);
totalResponseBytes += r4.responseSizeBytes;

const r5 = await sendWithEvents("Search the web for the weather in New York and Los Angeles. Compare them with Hanoi and Ho Chi Minh city.", 5);
totalResponseBytes += r5.responseSizeBytes;

const r6 = await sendLegacy("What was the first question I asked you?", 6);
totalResponseBytes += r6.responseSizeBytes;

const r7 = await sendLegacy("What name did I ask you to remember?", 7);
totalResponseBytes += r7.responseSizeBytes;

const totalMs = Date.now() - startTime;

console.log("\n=== All turns completed ===");
console.log(`\n--- Total Timing Results ---`);
console.log(`Total Time:    ${totalMs}ms`);
console.log(`Total Response Size: ${(totalResponseBytes / 1024).toFixed(1)} KB`);

printTimingResults({ ttfbMs: 0, totalMs, responseSizeBytes: totalResponseBytes, sseText: "", response: r7.response });
