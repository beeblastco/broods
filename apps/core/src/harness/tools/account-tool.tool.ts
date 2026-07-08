/**
 * AI SDK adapter for account-uploaded custom tool metadata.
 * Execution is delegated to custom-tool-executor.ts, which dispatches by runtime tier.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AccountToolRecord } from "../../shared/storage/index.ts";
import type { ToolContext } from "./index.ts";
import { streamAccountTool } from "./custom-tool-executor.ts";

export default function accountTool(record: AccountToolRecord, context: ToolContext & { accountId: string }): ToolSet {
  return {
    [record.name]: tool({
      description: record.description,
      inputSchema: jsonSchema(record.inputSchema),
      // Return the async generator synchronously (no `async` wrapper) so the AI SDK
      // detects an async-iterable and streams a bundle's `yield`s as preliminary
      // tool results; a non-streaming bundle simply yields once (its result).
      execute: (input, options) => streamAccountTool({
        accountId: context.accountId,
        tool: record,
        input,
        config: context.config,
        options,
      }),
    }),
  };
}
