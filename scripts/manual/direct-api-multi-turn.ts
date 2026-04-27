import { fetchWithTiming, printTimingResults, requireManualEnv } from "./utils.ts";

const FUNCTION_URL = requireManualEnv("FUNCTION_URL");
const conversationKey = `multi-turn-${Date.now()}`;

async function sendUserTurn(content: string, turn: number) {
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

async function sendPromptedTurn(content: string, turn: number) {
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

const r1 = await sendUserTurn("Remember that my name is Taylor.", 1);
totalResponseBytes += r1.responseSizeBytes;

const r2 = await sendPromptedTurn("What is my name?", 2);
totalResponseBytes += r2.responseSizeBytes;

const r3 = await sendUserTurn("Search the web for the weather in Hanoi.", 3);
totalResponseBytes += r3.responseSizeBytes;

const r4 = await sendUserTurn("Search the web for the weather in Ho Chi Minh city.", 4);
totalResponseBytes += r4.responseSizeBytes;

const r5 = await sendPromptedTurn("Search the web for the weather in New York and Los Angeles. Compare them with Hanoi and Ho Chi Minh city.", 5);
totalResponseBytes += r5.responseSizeBytes;

const r6 = await sendUserTurn("What was the first question I asked you?", 6);
totalResponseBytes += r6.responseSizeBytes;

const r7 = await sendUserTurn("What name did I ask you to remember?", 7);
totalResponseBytes += r7.responseSizeBytes;

const totalMs = Date.now() - startTime;

console.log("\n=== All turns completed ===");
console.log(`\n--- Total Timing Results ---`);
console.log(`Total Time:    ${totalMs}ms`);
console.log(`Total Response Size: ${(totalResponseBytes / 1024).toFixed(1)} KB`);

printTimingResults({ ttfbMs: 0, totalMs, responseSizeBytes: totalResponseBytes, sseText: "", response: r7.response });
