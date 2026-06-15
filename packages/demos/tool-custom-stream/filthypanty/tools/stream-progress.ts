/**
 * A streaming tool: `execute` is an async *generator*. Each `yield` is surfaced by
 * the AI SDK as a preliminary tool-result; the last yield is repeated as the final
 * output. A non-generator `execute` (plain return) would simply emit one result.
 */
export default {
  name: "stream_progress",
  async *execute(ctx: unknown, input: { steps?: number }) {
    const steps = Math.max(1, Math.min(10, input.steps ?? 5));
    for (let i = 1; i <= steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      yield { type: "text", value: `progress ${i}/${steps}` };
    }
    // The last yield is also the final tool output the model reads.
    yield { type: "text", value: `done: counted to ${steps}` };
  },
};
