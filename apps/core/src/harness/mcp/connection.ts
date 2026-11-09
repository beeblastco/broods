// Server-run OAuth for a remote MCP server: the caller makes one request and a person opens a link.
// Discovery, client registration, PKCE and the code exchange all happen here.

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";
import { resolveBearerAuth, type AuthContext } from "../../shared/auth.ts";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { getHarnessPublicUrl, requireSecretsEnv } from "../../shared/env.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  publicHostFetch,
  type CoreRequest,
} from "../../shared/http.ts";
import { getStorage, type StoredMcpConnection } from "../../shared/storage.ts";
import { tokenFetch, type Fetch, type TokenSource } from "../connections.ts";
import { tokenGrant } from "./oauth.ts";

const CALLBACK_SEGMENT = "callback";
const HKDF_INFO = "broods-mcp-oauth-state";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const PATH_PREFIX = "/v1/mcp-connections/";
const STATE_TTL_MS = 10 * 60_000;
const TAG_BYTES = 16;

// Sealed into the OAuth `state`, so a sign-in in progress needs no row.
interface PendingSignIn {
  accountId: string;
  serverId: string;
  url: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  redirectUri: string;
  verifier: string;
  expiresAt: number;
}

export function routesToMcpConnection(path: string): boolean {
  return path.startsWith(PATH_PREFIX);
}

export async function handleMcpConnectionRequest(
  event: CoreRequest,
): Promise<Response> {
  const segment = decodeURIComponent(event.path.slice(PATH_PREFIX.length));
  if (segment === CALLBACK_SEGMENT) return await finishSignIn(event);
  const auth = await resolveBearerAuth(event.headers);
  const record = auth ? await authorizedRecord(auth, segment) : null;
  if (!auth) return errorResponse(401, "Send Authorization: Bearer <key>.");
  if (!record) return errorResponse(404, "MCP server not found");
  if (event.method === "POST") return await startSignIn(record);
  if (event.method === "GET") {
    return jsonResponse(200, { connected: record.connected === true });
  }
  if (event.method === "DELETE") {
    return jsonResponse(200, {
      deleted: await getStorage().mcpConnections.disconnect(
        record.accountId,
        record.serverId,
      ),
    });
  }

  return errorResponse(405, "Use POST, GET or DELETE");
}

/** Sends a connected row's token, refreshing it ahead of expiry and once on a 401. */
export function mcpConnectionFetch(record: McpRecord): Fetch {
  return tokenFetch(connectionSource(record), publicHostFetch);
}

async function authorizedRecord(
  auth: AuthContext,
  serverId: string,
): Promise<McpRecord | null> {
  if (auth.kind !== "account" && auth.kind !== "deployment") return null;
  if (auth.kind === "deployment" && !auth.stageTicket) return null;
  const record = await getStorage().mcp.getById(
    auth.account.accountId,
    serverId,
  );
  if (record?.transport !== "http" || !record.url) return null;
  if (
    auth.kind === "deployment" &&
    auth.stageTicket?.stageId !== record.stageId
  ) {
    return null;
  }

  return record;
}

function connectionSource(record: McpRecord): TokenSource<StoredMcpConnection> {
  const reconnect = `POST ${PATH_PREFIX}${record.serverId} with the account key to sign in again.`;
  const store = getStorage().mcpConnections;

  return {
    key: `mcp:${record.accountId}:${record.serverId}`,
    missing: `MCP server ${record.name} has no connection. ${reconnect}`,
    load: () => store.load(record.accountId, record.serverId),
    refresh: async (stored) => {
      if (!stored.refreshToken) throw new Error("no refresh token was issued");

      return await tokenGrant(
        stored.tokenUrl,
        {
          client_id: stored.clientId,
          refresh_token: stored.refreshToken,
          resource: stored.resource,
          ...(stored.clientSecret
            ? { client_secret: stored.clientSecret }
            : {}),
        },
        publicHostFetch,
      );
    },
    refreshFailed: (message) =>
      `MCP server ${record.name} could not refresh: ${message}. ${reconnect}`,
    save: (stored, rotated) =>
      store.saveRefreshed(record.accountId, record.serverId, stored, rotated),
  };
}

async function finishSignIn(event: CoreRequest): Promise<Response> {
  const page = (status: number, text: string): Response =>
    new Response(text, {
      status: status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const pending = openState(event.query.get("state") ?? "");
  if (!pending || pending.expiresAt < Date.now()) {
    return page(400, "This sign-in link expired. Start the connection again.");
  }
  const code = event.query.get("code");
  if (!code) {
    return page(
      400,
      `Sign-in failed: ${event.query.get("error") ?? "no code"}`,
    );
  }
  const record = await getStorage().mcp.getById(
    pending.accountId,
    pending.serverId,
  );
  if (record?.url !== pending.url) {
    return page(409, "This server changed during sign-in. Start again.");
  }
  try {
    const tokens = await tokenGrant(
      pending.tokenUrl,
      {
        grant_type: "authorization_code",
        code: code,
        code_verifier: pending.verifier,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        resource: pending.resource,
        ...(pending.clientSecret
          ? { client_secret: pending.clientSecret }
          : {}),
      },
      publicHostFetch,
    );
    await getStorage().mcpConnections.set({
      accountId: pending.accountId,
      serverId: pending.serverId,
      clientId: pending.clientId,
      tokenUrl: pending.tokenUrl,
      resource: pending.resource,
      expiresAt: tokens.expiresAt,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? "",
      ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
    });
  } catch (error) {
    return page(502, `Sign-in failed: ${toErrorMessage(error)}`);
  }

  return page(200, `${record.name} is connected. You can close this tab.`);
}

function openState(state: string): PendingSignIn | null {
  try {
    const sealed = Buffer.from(state, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      stateKey(),
      sealed.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

    return JSON.parse(
      Buffer.concat([
        decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString(),
    ) as PendingSignIn;
  } catch {
    return null;
  }
}

function sealState(pending: PendingSignIn): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(pending)),
    cipher.final(),
  ]);

  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

async function startSignIn(record: McpRecord): Promise<Response> {
  const base = getHarnessPublicUrl();
  if (!base) return errorResponse(503, "PUBLIC_BASE_URL is not configured");
  const url = record.url!;
  const redirectUri = `${base}${PATH_PREFIX}${CALLBACK_SEGMENT}`;
  try {
    const protectedResource = await discoverOAuthProtectedResourceMetadata(
      url,
      undefined,
      publicHostFetch,
    ).catch((): undefined => undefined);
    const issuer =
      protectedResource?.authorization_servers?.[0] ?? new URL("/", url).href;
    const metadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: publicHostFetch,
    });
    if (!metadata?.registration_endpoint) {
      return errorResponse(
        422,
        `${record.name} offers no OAuth sign-in Broods can register with. Give it an Authorization header instead.`,
      );
    }
    if (new URL(metadata.token_endpoint).protocol !== "https:") {
      return errorResponse(
        422,
        `${record.name} has a non-https token endpoint`,
      );
    }
    const client = await registerClient(issuer, {
      metadata: metadata,
      fetchFn: publicHostFetch,
      clientMetadata: {
        client_name: "Broods",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    const resource = new URL(protectedResource?.resource ?? url);
    const scope = protectedResource?.scopes_supported?.join(" ");
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      issuer,
      {
        metadata: metadata,
        clientInformation: client,
        redirectUrl: redirectUri,
        resource: resource,
        ...(scope ? { scope: scope } : {}),
      },
    );
    authorizationUrl.searchParams.set(
      "state",
      sealState({
        accountId: record.accountId,
        serverId: record.serverId,
        url: url,
        tokenUrl: String(metadata.token_endpoint),
        clientId: client.client_id,
        ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
        resource: resource.href,
        redirectUri: redirectUri,
        verifier: codeVerifier,
        expiresAt: Date.now() + STATE_TTL_MS,
      }),
    );

    return jsonResponse(200, {
      status: "pending",
      authorizeUrl: authorizationUrl.href,
      next: "Give authorizeUrl to a person to open. GET this same URL until connected is true.",
    });
  } catch (error) {
    return errorResponse(
      502,
      `Could not start sign-in for ${record.name}: ${toErrorMessage(error)}`,
    );
  }
}

// Derived, so a sealed sign-in and a media ticket can never open each other.
function stateKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      requireSecretsEnv("MEDIA_TICKET_SECRET")[0]!,
      "",
      HKDF_INFO,
      KEY_BYTES,
    ),
  );
}
