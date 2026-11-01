import type { McpOauth, McpTransport } from "@broods/convex/model/mcp";

export { ACCOUNT_ENV_PLACEHOLDER_PATTERN as ENV_PLACEHOLDER_PATTERN } from "@broods/convex/model/envRefs";
export {
  authorizationHeaderName,
  type McpOauth,
  type McpTransport,
} from "@broods/convex/model/mcp";

export type McpStatus = "active" | "deleted";

/** Hosted rows only; "auto" (or absent) picks Workers when the bundle can run there. */
export type McpRuntime = "auto" | "lambda";

export interface McpRecord {
  accountId: string;
  serverId: string;
  projectId: string;
  stageId: string;
  name: string;
  description?: string;
  transport: McpTransport;
  workersCompatible?: boolean;
  runtime?: McpRuntime;
  url?: string;
  sandbox?: string;
  /** "machine" rows: a lambda sandbox runs this stdio argv, a machine daemon ignores it. */
  command?: string[];
  bundleStorageKey?: string;
  sha256?: string;
  headers?: Record<string, string>;
  /** Secret fields carry ${NAME} env refs on the row, never the values. */
  oauth?: McpOauth;
  allowedTools?: string[];
  disabled?: boolean;
  status: McpStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
