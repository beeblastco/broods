/**
 * The account's Sign in with ChatGPT login (`/v1/account/chatgpt`), which the
 * `chatgpt` model provider runs on. The CLI does the browser sign-in and PUTs
 * the tokens here; GET answers what is connected, never the tokens; DELETE
 * revokes at OpenAI, then forgets. Refresh is core's, not this route's.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ProviderCredentialStatus } from "../../account/providerCredentials";
import { type ConfigAuditActor } from "../../model/auditEvents";
import {
  CHATGPT_DIRECT_SCOPE,
  CHATGPT_DISCOVERY_URL,
  CHATGPT_MANAGED_SERVICE_REFUSAL,
  type ChatGPTConnection,
  type ChatGPTSignIn,
} from "../../model/chatgpt";
import { ClientError } from "../../model/clientError";
import { isManagedService } from "../../model/planLimits";
import {
  json,
  jsonError,
  methodNotAllowed,
  parseJsonRequest,
  writeAudit,
} from "./shared";

const REVOKE_TIMEOUT_MS = 5_000;

export async function handleChatGPTRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
): Promise<Response> {
  const ref = { accountId: accountId, provider: "chatgpt" as const };
  if (req.method === "GET") {
    const status: ProviderCredentialStatus | null = await ctx.runQuery(
      internal.account.providerCredentials.status,
      ref,
    );

    return json(publicStatus(status));
  }
  if (req.method === "PUT") {
    if (isManagedService())
      return jsonError(403, CHATGPT_MANAGED_SERVICE_REFUSAL);
    const signIn = readSignIn(await parseJsonRequest(req));
    await ctx.runMutation(internal.account.providerCredentials.set, {
      ...ref,
      ...signIn,
      expiresAt: Date.parse(signIn.expiresAt),
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "account", id: accountId, name: "chatgpt" },
      summary: "ChatGPT sign-in connected",
    });

    return json(
      publicStatus(
        await ctx.runQuery(internal.account.providerCredentials.status, ref),
      ),
    );
  }
  if (req.method === "DELETE") {
    const credential = await ctx.runQuery(
      internal.account.providerCredentials.load,
      ref,
    );
    if (!credential) return json({ deleted: false });
    await revoke(credential.clientId, credential.refreshToken);
    await ctx.runMutation(internal.account.providerCredentials.remove, ref);
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "account", id: accountId, name: "chatgpt" },
      summary: "ChatGPT sign-in disconnected",
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

function publicStatus(
  status: ProviderCredentialStatus | null,
): ChatGPTConnection {
  if (!status) return { connected: false };

  return {
    connected: true,
    clientId: status.clientId,
    hostId: status.hostId,
    ...(status.email ? { email: status.email } : {}),
    scopes: status.scopes,
    expiresAt: new Date(status.expiresAt).toISOString(),
    updatedAt: new Date(status.updatedAt).toISOString(),
  };
}

function readSignIn(body: unknown): ChatGPTSignIn {
  // Only typeof checks below, so a non-object body reads as all fields missing.
  const fields = (body ?? {}) as Partial<Record<keyof ChatGPTSignIn, unknown>>;
  const required = (name: keyof ChatGPTSignIn): string => {
    const value = fields[name];
    if (typeof value !== "string" || value.length < 1 || value.length > 16384)
      throw new ClientError(`${name} must be a non-empty string`);

    return value;
  };
  const scopes = fields.scopes;
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope): scope is string => typeof scope === "string")
  )
    throw new ClientError("scopes must be an array of strings");
  // Identity alone is no use to a model provider: refuse it here rather than
  // at the first run.
  if (!scopes.includes(CHATGPT_DIRECT_SCOPE))
    throw new ClientError(
      `The sign-in was not granted ${CHATGPT_DIRECT_SCOPE}; allow ChatGPT plan usage when signing in`,
    );
  const expiresAt = required("expiresAt");
  if (Number.isNaN(Date.parse(expiresAt)))
    throw new ClientError("expiresAt must be an ISO 8601 date");
  const email = fields.email;
  if (email !== undefined && typeof email !== "string")
    throw new ClientError("email must be a string");

  return {
    clientId: required("clientId"),
    hostId: required("hostId"),
    ...(email ? { email: email } : {}),
    scopes: scopes,
    expiresAt: expiresAt,
    accessToken: required("accessToken"),
    refreshToken: required("refreshToken"),
  };
}

/**
 * Best effort: a logout must still forget the tokens when OpenAI is down, and
 * the user can always end the grant in ChatGPT's own settings.
 */
async function revoke(clientId: string, refreshToken: string): Promise<void> {
  try {
    const discovery = await fetch(CHATGPT_DISCOVERY_URL, {
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    const { revocation_endpoint: endpoint } = (await discovery.json()) as {
      revocation_endpoint?: string;
    };
    if (!endpoint) return;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`ChatGPT token revocation failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn("ChatGPT token revocation failed", error);
  }
}
