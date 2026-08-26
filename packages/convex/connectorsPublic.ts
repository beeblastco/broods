"use node";
/**
 * Dashboard-facing connector actions (ticket 19, executing 04/06's backend):
 * create with validate-before-connect, delete, and re-check. Runs in the Node
 * runtime for the crypto used by the existing encrypted-secret mechanism.
 * `connected` status only ever follows a real successful call — a GitHub
 * GET /user or a full MCP initialize + tools/list handshake.
 */

import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { authKit } from "./auth";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "./model/agentConfigCodec";
import {
  validateGithubToken,
  validateMcpServer,
} from "./model/connectorValidation";

const connectorSummary = v.object({
  connectorId: v.id("connectors"),
  provider: v.string(),
  label: v.string(),
  authKind: v.union(v.literal("token"), v.literal("mcp")),
  url: v.optional(v.string()),
  status: v.union(v.literal("connected"), v.literal("error")),
  lastCheckedAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
  toolNames: v.optional(v.array(v.string())),
  validatedLogin: v.optional(v.string()),
});

type ConnectorSummary = {
  connectorId: Id<"connectors">;
  provider: string;
  label: string;
  authKind: "token" | "mcp";
  url?: string;
  status: "connected" | "error";
  lastCheckedAt?: number;
  lastError?: string;
  toolNames?: string[];
  validatedLogin?: string;
};

/** Secret-free view of a connector row for the dashboard. */
function toSummary(row: Doc<"connectors">): ConnectorSummary {
  return {
    connectorId: row._id,
    provider: row.provider,
    label: row.label,
    authKind: row.authKind,
    ...(row.url !== undefined ? { url: row.url } : {}),
    status: row.status,
    ...(row.lastCheckedAt !== undefined
      ? { lastCheckedAt: row.lastCheckedAt }
      : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.toolNames !== undefined ? { toolNames: row.toolNames } : {}),
    ...(row.validatedLogin !== undefined
      ? { validatedLogin: row.validatedLogin }
      : {}),
  };
}

async function requireActiveAccountId(ctx: ActionCtx): Promise<Id<"accounts">> {
  // Check authenticated user
  const user = await authKit.getAuthUser(ctx);
  if (!user) {
    throw new Error("User not found or not authenticated");
  }
  const active: {
    accountId: Id<"accounts">;
    status: "active" | "disabled";
  } | null = await ctx.runQuery(api.org.getActiveAccount, {});
  if (!active) throw new Error("No active workspace for this user.");

  return active.accountId;
}

function encryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is not configured");
  }

  return secret;
}

export const listConnectors = action({
  args: {},
  returns: v.array(connectorSummary),
  handler: async (ctx): Promise<ConnectorSummary[]> => {
    const accountId = await requireActiveAccountId(ctx);
    const rows: Doc<"connectors">[] = await ctx.runQuery(
      internal.connectors.listForAccount,
      { accountId: accountId },
    );

    return rows.map(toSummary);
  },
});

/**
 * Connect GitHub with a pasted token. One real validating call decides —
 * a bad paste fails here, specifically, and no `connected` row is created.
 */
export const createTokenConnector = action({
  args: {
    provider: v.literal("github"),
    label: v.string(),
    token: v.string(),
  },
  returns: connectorSummary,
  handler: async (ctx, args): Promise<ConnectorSummary> => {
    const accountId = await requireActiveAccountId(ctx);
    const label = args.label.trim();
    if (!label) throw new Error("Label must not be empty.");
    if (!args.token.trim()) throw new Error("Token must not be empty.");

    // Validate BEFORE storing anything — the provider's own error surfaces.
    const validated = await validateGithubToken(args.token.trim());

    const encrypted = await encryptAgentConfigBlob(
      { token: args.token.trim() },
      encryptionSecret(),
    );
    const connectorId: Id<"connectors"> = await ctx.runMutation(
      internal.connectors.create,
      {
        accountId: accountId,
        provider: args.provider,
        label: label,
        authKind: "token",
        encryptedSecret: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretTag: encrypted.tag,
        status: "connected",
        validatedLogin: validated.login,
      },
    );
    const row: Doc<"connectors"> | null = await ctx.runQuery(
      internal.connectors.getById,
      { accountId: accountId, connectorId: connectorId },
    );
    if (!row) throw new Error("Connector row vanished after creation");

    return toSummary(row);
  },
});

/**
 * Connect a custom MCP server. A real initialize + tools/list handshake
 * decides; the advertised tool names are stored on the row.
 */
export const createCustomMcpConnector = action({
  args: {
    label: v.string(),
    url: v.string(),
    headers: v.optional(v.record(v.string(), v.string())),
  },
  returns: connectorSummary,
  handler: async (ctx, args): Promise<ConnectorSummary> => {
    const accountId = await requireActiveAccountId(ctx);
    const label = args.label.trim();
    if (!label) throw new Error("Label must not be empty.");
    const url = args.url.trim();
    if (!/^https?:\/\//.test(url)) {
      throw new Error("MCP server URL must be an http(s) URL.");
    }

    const headers = args.headers ?? {};
    const validated = await validateMcpServer(url, headers);

    const hasHeaders = Object.keys(headers).length > 0;
    const encrypted = hasHeaders
      ? await encryptAgentConfigBlob({ headers: headers }, encryptionSecret())
      : null;
    const connectorId: Id<"connectors"> = await ctx.runMutation(
      internal.connectors.create,
      {
        accountId: accountId,
        provider: "mcp",
        label: label,
        authKind: "mcp",
        url: url,
        ...(encrypted
          ? {
              encryptedSecret: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretTag: encrypted.tag,
            }
          : {}),
        status: "connected",
        toolNames: validated.toolNames,
      },
    );
    const row: Doc<"connectors"> | null = await ctx.runQuery(
      internal.connectors.getById,
      { accountId: accountId, connectorId: connectorId },
    );
    if (!row) throw new Error("Connector row vanished after creation");

    return toSummary(row);
  },
});

/** Re-run the connector's validation; updates status/lastError (ticket 23). */
export const checkConnector = action({
  args: { connectorId: v.id("connectors") },
  returns: connectorSummary,
  handler: async (ctx, args): Promise<ConnectorSummary> => {
    const accountId = await requireActiveAccountId(ctx);
    const row: Doc<"connectors"> | null = await ctx.runQuery(
      internal.connectors.getById,
      { accountId: accountId, connectorId: args.connectorId },
    );
    if (!row) throw new Error("Connector not found");

    let status: "connected" | "error" = "connected";
    let lastError: string | undefined;
    let toolNames: string[] | undefined;
    let validatedLogin: string | undefined;
    try {
      if (row.authKind === "token") {
        const secret = await decryptSecretPayload(row);
        const token = typeof secret.token === "string" ? secret.token : "";
        const validated = await validateGithubToken(token);
        validatedLogin = validated.login;
      } else {
        const secret = row.encryptedSecret
          ? await decryptSecretPayload(row)
          : {};
        const headers =
          (secret.headers as Record<string, string> | undefined) ?? {};
        const validated = await validateMcpServer(row.url ?? "", headers);
        toolNames = validated.toolNames;
      }
    } catch (err) {
      status = "error";
      lastError = err instanceof Error ? err.message : String(err);
    }

    await ctx.runMutation(internal.connectors.patchStatus, {
      accountId: accountId,
      connectorId: args.connectorId,
      status: status,
      ...(lastError !== undefined ? { lastError: lastError } : {}),
      ...(toolNames !== undefined ? { toolNames: toolNames } : {}),
      ...(validatedLogin !== undefined
        ? { validatedLogin: validatedLogin }
        : {}),
    });
    const updated: Doc<"connectors"> | null = await ctx.runQuery(
      internal.connectors.getById,
      { accountId: accountId, connectorId: args.connectorId },
    );
    if (!updated) throw new Error("Connector not found");

    return toSummary(updated);
  },
});

export const deleteConnector = action({
  args: { connectorId: v.id("connectors") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const accountId = await requireActiveAccountId(ctx);
    await ctx.runMutation(internal.connectors.remove, {
      accountId: accountId,
      connectorId: args.connectorId,
    });

    return null;
  },
});

/** Decrypt a connector row's secret payload with the shared account secret. */
async function decryptSecretPayload(
  row: Doc<"connectors">,
): Promise<Record<string, unknown>> {
  if (!row.encryptedSecret || !row.secretIv || !row.secretTag) return {};

  return (await decryptAgentConfigBlob(
    {
      ciphertext: row.encryptedSecret,
      iv: row.secretIv,
      tag: row.secretTag,
    },
    encryptionSecret(),
  )) as Record<string, unknown>;
}
