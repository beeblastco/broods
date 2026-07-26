/**
 * AI SDK adapter for account-uploaded custom tool metadata.
 * Execution is delegated to custom-tools/executor.ts, which dispatches by runtime tier.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AccountToolRecord } from "../../shared/domain/account-tools.ts";
import { streamAccountTool } from "../custom-tools/executor.ts";
import type { ToolContext } from "./index.ts";

export default function accountTool(
  record: AccountToolRecord,
  context: ToolContext & { accountId: string },
): ToolSet {
  return {
    [record.name]: tool({
      description: record.description,
      inputSchema: jsonSchema(record.inputSchema),
      // Declared `async function*`, not an arrow returning the generator, so the
      // wrappers in tool-execute.ts can see this tool streams and keep that shape.
      // Every yield reaches the SDK as a preliminary tool result; the last one is
      // the tool's result, which is the only yield a non-streaming bundle makes.
      execute: async function* (input, options) {
        yield* streamAccountTool({
          accountId: context.accountId,
          tool: record,
          input,
          config: context.config,
          options,
        });
      },
    }),
  };
}
