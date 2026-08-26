/**
 * Connector resolution (ticket 19): turns `config.connectors.allowed` into
 * live tools. MCP connectors get a real client connection (initialize →
 * tools/list) with every advertised tool registered; GitHub token connectors
 * get one request tool against api.github.com. A broken or unreachable
 * connector degrades to "its tools are absent" plus a logged warning — never
 * a crashed run. Naming convention (documented in apps/core/AGENTS.md):
 * `mcp_<label>_<toolName>` and `github_<label>_request`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  decodeStoredConfigObject,
  type AgentConnectorRef,
  type AgentConnectorsConfig,
} from "../shared/domain/agent-config.ts";
import { isPlainObject } from "../shared/object.ts";
import { logWarn } from "../shared/log.ts";
import { runtime } from "../shared/convex/runtime.ts";
import { toolError, toolText } from "./tools/utils.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

/** A connector row as served by `internal.connectors.listForRuntime`. */
export interface ConnectorRow {
  _id: string;
  provider: string;
  label: string;
  authKind: "token" | "mcp";
  url?: string;
  encryptedSecret?: string;
  secretIv?: string;
  secretTag?: string;
  status: "connected" | "error";
  toolNames?: string[];
}

/** Tool-name-safe slug of a connector label. */
export function connectorSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "connector"
  );
}

/** Decrypt a connector row's secret payload ({token} or {headers}). */
export function decryptConnectorSecret(
  row: Pick<ConnectorRow, "encryptedSecret" | "secretIv" | "secretTag">,
): Record<string, unknown> {
  if (!row.encryptedSecret || !row.secretIv || !row.secretTag) {
    return {};
  }

  return decodeStoredConfigObject({
    encrypted: true,
    algorithm: "aes-256-gcm",
    ciphertext: row.encryptedSecret,
    iv: row.secretIv,
    tag: row.secretTag,
  });
}

/** The enabled refs of a connectors config. */
export function enabledConnectorRefs(
  config: AgentConnectorsConfig | undefined,
): AgentConnectorRef[] {
  return (config?.allowed ?? []).filter((ref) => ref.enabled === true);
}

/**
 * Resolve every enabled connector into tools. Failures are contained per
 * connector: the run proceeds without that connector's tools.
 */
export async function createConnectorTools(
  accountId: string | undefined,
  config: AgentConnectorsConfig | undefined,
): Promise<ToolSet> {
  const tools: ToolSet = {};
  const refs = enabledConnectorRefs(config);
  if (refs.length === 0 || !accountId) {
    return tools;
  }

  let rows: ConnectorRow[] = [];
  try {
    rows = await runtime.query<ConnectorRow[]>("listConnectors", {
      accountId: accountId,
      connectorIds: refs.map((ref) => ref.connectorId),
    });
  } catch (err) {
    logWarn("Connector rows could not be loaded; connector tools absent", {
      error: err instanceof Error ? err.message : String(err),
    });

    return tools;
  }

  for (const row of rows) {
    try {
      if (row.authKind === "mcp") {
        Object.assign(tools, await createMcpTools(row));
      } else if (row.provider === "github") {
        Object.assign(tools, createGithubTools(row));
      }
    } catch (err) {
      logWarn("Connector failed to resolve; its tools are absent this run", {
        connectorId: row._id,
        label: row.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return tools;
}

/** Connect to one MCP server and register every advertised tool. */
async function createMcpTools(row: ConnectorRow): Promise<ToolSet> {
  if (!row.url) {
    throw new Error("MCP connector has no URL");
  }
  const secret = decryptConnectorSecret(row);
  const headers = isPlainObject(secret.headers)
    ? (secret.headers as Record<string, string>)
    : {};

  const client = new Client({ name: "broods-core", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(row.url), {
    requestInit: { headers: headers },
  });
  await withTimeout(
    client.connect(transport),
    CONNECT_TIMEOUT_MS,
    `MCP connect to ${row.label} timed out`,
  );
  const listed = await withTimeout(
    client.listTools(),
    CONNECT_TIMEOUT_MS,
    `MCP tools/list on ${row.label} timed out`,
  );

  const slug = connectorSlug(row.label);
  const tools: ToolSet = {};
  for (const mcpTool of listed.tools) {
    const name = `mcp_${slug}_${mcpTool.name}`.slice(0, 64);
    const schema: JSONSchema7 = isPlainObject(mcpTool.inputSchema)
      ? (mcpTool.inputSchema as JSONSchema7)
      : { type: "object", properties: {} };
    tools[name] = tool({
      description:
        mcpTool.description ??
        `Tool "${mcpTool.name}" from the ${row.label} MCP server`,
      inputSchema: jsonSchema<Record<string, unknown>>(schema),
      execute: async (input) => {
        try {
          const result = await withTimeout(
            client.callTool({
              name: mcpTool.name,
              arguments: input,
            }),
            CALL_TIMEOUT_MS,
            `MCP call ${mcpTool.name} on ${row.label} timed out`,
          );
          if (result.isError === true) {
            return toolError(mcpToolResultText(result));
          }

          return toolText(mcpToolResultText(result));
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  return tools;
}

/** Flatten an MCP tool result's content into text for the model. */
function mcpToolResultText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return JSON.stringify(result);
  }
  const texts = content
    .map((part) => {
      const candidate = part as { type?: string; text?: unknown };

      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : JSON.stringify(part);
    })
    .join("\n");

  return texts || JSON.stringify(result);
}

interface GithubRequestInput {
  method?: string;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * GitHub token connector: one authenticated request tool against
 * api.github.com. The reuse question from ticket 04 (endpoint-tier
 * execution) was investigated and declined: the endpoint tier executes
 * uploaded bundles, not per-connector credentialed HTTP — a dedicated
 * 30-line tool is smaller than adapting it (decision recorded in the
 * ticket-19 report).
 */
function createGithubTools(row: ConnectorRow): ToolSet {
  const secret = decryptConnectorSecret(row);
  const token = typeof secret.token === "string" ? secret.token : "";
  if (!token) {
    throw new Error("GitHub connector has no stored token");
  }
  const slug = connectorSlug(row.label);
  const name = `github_${slug}_request`.slice(0, 64);

  return {
    [name]: tool({
      description: `Call the GitHub REST API as the connected account (connector "${row.label}"). Use standard GitHub REST v3 paths like /user, /user/repos, /repos/{owner}/{repo}/pulls?state=open.`,
      inputSchema: jsonSchema<GithubRequestInput>({
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
            description: "HTTP method (default GET)",
          },
          path: {
            type: "string",
            description: "GitHub API path starting with /, query allowed",
          },
          body: {
            type: "object",
            description: "JSON body for write methods",
            additionalProperties: true,
          },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        try {
          const path = input.path.startsWith("/")
            ? input.path
            : `/${input.path}`;
          const response = await fetch(`https://api.github.com${path}`, {
            method: input.method ?? "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "broods-agent",
              ...(input.body ? { "Content-Type": "application/json" } : {}),
            },
            ...(input.body ? { body: JSON.stringify(input.body) } : {}),
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          });
          const text = await response.text();
          if (!response.ok) {
            return toolError(
              `GitHub API ${response.status}: ${text.slice(0, 2000)}`,
            );
          }

          return toolText(text.slice(0, 20_000));
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    }),
  };
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
