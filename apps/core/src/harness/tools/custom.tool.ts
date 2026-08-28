/**
 * AI SDK adapter for account-uploaded custom tool metadata.
 * Execution is delegated to bundles/executor.ts, which dispatches by runtime tier.
 */

import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { AccountToolRecord } from "../../shared/domain/account-tools.ts";
import { streamAccountTool } from "../bundles/executor.ts";
import type { ToolContext } from "./index.ts";
import { normalizeToolResultOutput } from "./utils.ts";

export default function accountTool(
  record: AccountToolRecord,
  context: ToolContext & { accountId: string },
): ToolSet {
  return {
    [record.name]: tool({
      description: record.description,
      inputSchema: jsonSchema(record.inputSchema),
      toModelOutput: ({ output }): ToolResultOutput =>
        normalizeToolResultOutput(output),
      // Declared `async function*` so tool-execute.ts can see this streams. Each
      // yield is a preliminary tool result; the last one is the tool's result.
      execute: async function* (input, options) {
        yield* streamAccountTool({
          accountId: context.accountId,
          tool: record,
          input: input,
          config: context.config,
          options: options,
          ...(context.onSandboxCpu
            ? { onSandboxCpu: context.onSandboxCpu }
            : {}),
        });
      },
    }),
  };
}
