/**
 * Test async tool that simulates a long-running operation.
 */
export default {
  name: "test_async",
  async execute(ctx: unknown, input: Record<string, unknown>) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return { type: "text", value: "test_async completed successfully" };
  },
};
