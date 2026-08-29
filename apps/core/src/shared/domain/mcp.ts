/**
 * Connected MCP server registration contract (issue #331 phase 1). The
 * persisted row and its normalizer live in the config plane
 * (packages/convex/model/mcp.ts, packages/convex/account/mcp.ts); this file
 * owns the core-side record shape the storage adapter returns. Connection and
 * tool registration live in harness/mcp/.
 */

export { ACCOUNT_ENV_PLACEHOLDER_PATTERN as ENV_PLACEHOLDER_PATTERN } from "@broods/convex/model/envRefs";

export type McpStatus = "active" | "deleted";

export type McpTransport = "http" | "hosted";

export interface McpRecord {
  accountId: string;
  serverId: string;
  projectId: string;
  stageId: string;
  name: string;
  description?: string;
  transport: McpTransport;
  /** Present on "http" rows; a "hosted" row's endpoint is the Lambda host. */
  url?: string;
  /** Hosted-only: the uploaded server bundle's S3 key and sha256. */
  bundleStorageKey?: string;
  sha256?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  disabled?: boolean;
  status: McpStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
