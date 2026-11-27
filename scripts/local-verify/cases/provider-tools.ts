import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  lastJsonLine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

// What the CLI syncs for `anthropic.tools.*(...)`: JSON keeps type, id and args.
const WEB_SEARCH = {
  type: "provider",
  isProviderExecuted: true,
  id: "anthropic.web_search_20260318",
  args: { maxUses: 1 },
};
const BASH = {
  type: "provider",
  isProviderExecuted: false,
  id: "anthropic.bash_20250124",
  args: {},
};

export async function providerTools(context: VerifyContext): Promise<void> {
  const name = `provider-tools-${context.runId}`;
  let refusal = "";
  try {
    await context.account.createAgent({
      name: `${name}-refused`,
      config: { ...context.model, tools: { bash: { enabled: true } } },
    });
  } catch (error) {
    refusal = String(error);
  }
  assertStep(
    "a Broods tool name keys only a provider tool",
    refusal.includes("is a Broods tool name"),
    refusal || "accepted",
  );

  const machine = await connectMachine(context, {
    computer: false,
    name: name,
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        agent: {
          system:
            "Call the bash tool exactly once, with the command `echo provider-bash-ok`. Then reply with exactly its output and nothing else.",
        },
        tools: { search: WEB_SEARCH, bash: BASH },
        sandboxes: [machine.sandboxId],
      },
    });
    const status = await context.measure(
      "provider bash run",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: name,
          eventId: `${name}-run`,
          text: "Run the echo with bash and reply with its output.",
        }),
    );
    const detail = `${JSON.stringify(status)}\n${machine.output()}`;
    if (!context.hasModelKey) {
      const started = lastJsonLine<{ eventType: string; eventId: string }>(
        context.coreLogPath,
        (record): boolean =>
          record.eventType === "model.invocation.started" &&
          record.eventId.endsWith(`:${name}-run`),
      );
      assertStep(
        `provider tools by id built and reached the model (${MODEL_KEY_HINT})`,
        started !== null && !detail.includes("config.tools"),
        detail,
      );
      return;
    }
    assertStep(
      "Anthropic bash ran on the agent's machine as Broods bash",
      status.status === "completed" &&
        machine.output().includes("echo provider-bash-ok") &&
        JSON.stringify(status.response ?? "").includes("provider-bash-ok"),
      detail,
    );
  } finally {
    await machine.stop();
  }
}
