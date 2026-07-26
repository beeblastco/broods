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
      // Drain the stream here and return its last value: the AI SDK takes what
      // execute returns as the result, so handing back the generator itself
      // serialized to `{}` and the bundle never ran. The final yield is the
      // result for both tiers; earlier yields are a streaming bundle's chunks.
      execute: async (input, options) => {
        let result: unknown;
        for await (const value of streamAccountTool({
          accountId: context.accountId,
          tool: record,
          input,
          config: context.config,
          options,
        })) {
          result = value;
        }

        return result;
      },
    }),
  };
}
