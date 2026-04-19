const FUNCTION_URL = "https://redactedharnessurlid.lambda-url.eu-central-1.on.aws/";

const response = await fetch(FUNCTION_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    eventId: `test-${Date.now()}`,
    conversationKey: `test-${Date.now()}`,
    content: "Count from 1 to 10 slowly, one number per line.",
  }),
});

console.log("Status:", response.status);
console.log("Content-Type:", response.headers.get("Content-Type"));
console.log();

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value, { stream: true }));
}
