import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { LambdaMicrovms } from "@aws-sdk/client-lambda-microvms";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import { MicrovmSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/microvm-executor.ts";

interface SentCommand {
  input: { microvmIdentifier: string };
}

const sent: SentCommand[] = [];
const client = {
  send: async (command: SentCommand): Promise<Record<string, unknown>> => {
    sent.push(command);

    return {};
  },
} as unknown as LambdaMicrovms;

function executor(): MicrovmSandboxExecutor {
  return new MicrovmSandboxExecutor(
    { provider: "lambda", persistent: true },
    client,
  );
}

afterEach((): void => {
  sent.length = 0;
});

describe("MicroVM suspend and resume", () => {
  test.each(["suspend", "resume"] as const)(
    "%s sends the command for the reserved VM",
    async (verb): Promise<void> => {
      const lookup = spyOn(
        instanceStore,
        "getSandboxExternalId",
      ).mockResolvedValue("microvm-7");
      await executor()[verb]({ namespace: "fs-abc" });
      expect(lookup).toHaveBeenCalledWith("lambda", "fs-abc");
      expect(sent.map((command) => command.input)).toEqual([
        { microvmIdentifier: "microvm-7" },
      ]);
      lookup.mockRestore();
    },
  );

  test.each(["suspend", "resume"] as const)(
    "%s does nothing without a reservation",
    async (verb): Promise<void> => {
      const lookup = spyOn(
        instanceStore,
        "getSandboxExternalId",
      ).mockResolvedValue(undefined as unknown as string);
      await executor()[verb]({ namespace: "fs-abc" });
      await executor()[verb]({});
      expect(sent).toEqual([]);
      lookup.mockRestore();
    },
  );
});
