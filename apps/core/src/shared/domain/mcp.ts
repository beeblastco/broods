/**
 * Registered MCP server contract (#331): external "http" rows, uploaded
 * "hosted" rows, and "machine" rows a stdio server on a sandbox serves: a
 * daemon on the user's own computer, or a lambda MicroVM. The persisted row and its normalizer live in the config
 * plane (packages/convex/model/mcp.ts, packages/convex/account/mcp.ts); this
 * file owns the core-side record shape the storage adapter returns.
 * Connection and tool registration live in harness/mcp/.
 */

import type { McpOauth, McpTransport } from "@broods/convex/model/mcp";

export { ACCOUNT_ENV_PLACEHOLDER_PATTERN as ENV_PLACEHOLDER_PATTERN } from "@broods/convex/model/envRefs";
export {
  authorizationHeaderName,
  type McpOauth,
  type McpTransport,
} from "@broods/convex/model/mcp";

export type McpStatus = "active" | "deleted";

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
  /** "machine" rows: name of the sandbox (machine daemon or lambda VM) that serves the server. */
  sandbox?: string;
  /** "machine" rows: argv of the stdio server; a lambda sandbox runs it, a daemon ignores it. */
  command?: string[];
  /** Hosted-only: the uploaded server bundle's S3 key and sha256. */
  bundleStorageKey?: string;
  sha256?: string;
  headers?: Record<string, string>;
  /** OAuth 2.0 refresh-token grant; secret fields carry ${NAME} refs on the row. */
  oauth?: McpOauth;
  allowedTools?: string[];
  disabled?: boolean;
  status: McpStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
