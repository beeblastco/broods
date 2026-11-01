import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ConnectionStatus } from "../../account/connections";
import { type AuditActor } from "../../model/auditEvents";
import { ClientError } from "../../model/clientError";
import {
  authorizeUrl,
  exchangeCode,
  listModels,
  verifyIdToken,
  type SignInClient,
} from "../../model/connectionSignIn";
import {
  CHATGPT_DYNAMIC_CLIENT_ID,
  CONNECTION_TYPES,
  isConnectionType,
  type Connection,
  type ConnectionCode,
  type ConnectionStart,
  type ConnectionType,
} from "../../model/connections";
import { isManagedService } from "../../model/planLimits";
import { resolveAccountCaller } from "./roles";
import {
  json,
  jsonError,
  methodNotAllowed,
  parseJsonRequest,
  unauthorizedResponse,
  writeAudit,
} from "./shared";

const MAX_FIELD_LENGTH = 16_384;
// The CLI listens on loopback; the provider redirects nowhere else.
const LOOPBACK_REDIRECT_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

interface ConnectionRef {
  accountId: Id<"accounts">;
  type: ConnectionType;
}

export interface ConnectionsPath {
  type: string | undefined;
  start: boolean;
}

export async function handleConnectionsRoute(
  ctx: ActionCtx,
  req: Request,
  path: ConnectionsPath,
): Promise<Response> {
  const caller = await resolveAccountCaller(ctx, req);
  if (!caller) return await unauthorizedResponse(ctx, req);
  // A runtime key controls one stage; a connection acts for the whole account.
  if (caller.deploymentScope) {
    return jsonError(403, "Connections require the account key or a CLI login");
  }
  const accountId = caller.accountId;

  if (path.type === undefined) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const rows: ConnectionStatus[] = await ctx.runQuery(
      internal.account.connections.list,
      { accountId: accountId },
    );

    return json({ connections: rows.map((row) => publicConnection(row)) });
  }
  const type = path.type;
  if (!isConnectionType(type)) return jsonError(404, "Unknown connection type");
  const ref = { accountId: accountId, type: type };
  const existing: ConnectionStatus | null = await ctx.runQuery(
    internal.account.connections.status,
    ref,
  );

  // Hosted, paid services need the provider's approval before a sign-in starts.
  const { selfHostedOnly, managedOptIn } = CONNECTION_TYPES[type];
  if (
    selfHostedOnly &&
    isManagedService() &&
    !(managedOptIn && process.env[managedOptIn] === "true") &&
    (path.start || req.method === "PUT")
  )
    return jsonError(403, selfHostedOnly);
  if (path.start) return await startResponse(req, type, existing);
  if (req.method === "GET") {
    return existing
      ? json(publicConnection(existing))
      : jsonError(404, "Connection not found");
  }
  if (req.method === "PUT")
    return await signInResponse(ctx, req, ref, existing, caller.actor);
  if (req.method === "DELETE")
    return await disconnectResponse(ctx, ref, caller.actor);

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

export function parseConnectionsPath(pathname: string): ConnectionsPath | null {
  if (pathname === "/v1/account/connections")
    return { type: undefined, start: false };
  const match = pathname.match(
    /^\/v1\/account\/connections\/([^/]+)(\/start)?$/,
  );

  return match?.[1]
    ? { type: decodeURIComponent(match[1]), start: match[2] !== undefined }
    : null;
}

async function disconnectResponse(
  ctx: ActionCtx,
  ref: ConnectionRef,
  actor: AuditActor,
): Promise<Response> {
  const deleted: boolean = await ctx.runMutation(
    internal.account.connections.disconnect,
    ref,
  );
  if (deleted) {
    await writeAudit(ctx, {
      accountId: ref.accountId,
      actor: actor,
      action: "deleted",
      resource: {
        kind: "account",
        id: ref.accountId,
        name: `connection:${ref.type}`,
      },
      summary: `Connection ${ref.type} disconnected`,
    });
  }

  return json({ deleted: deleted });
}

function publicConnection(row: ConnectionStatus): Connection {
  return {
    type: row.type,
    clientId: row.clientId,
    hostId: row.hostId,
    ...(row.email ? { email: row.email } : {}),
    scopes: row.scopes,
    expiresAt: new Date(row.expiresAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function readCode(body: unknown): ConnectionCode {
  return {
    code: requireField(body, "code"),
    codeVerifier: requireField(body, "codeVerifier"),
    redirectUri: readRedirectUri(body),
    nonce: requireField(body, "nonce"),
    clientId: requireField(body, "clientId"),
    hostId: requireField(body, "hostId"),
  };
}

function readRedirectUri(body: unknown): string {
  const redirectUri = requireField(body, "redirectUri");
  if (!LOOPBACK_REDIRECT_PATTERN.test(redirectUri))
    throw new ClientError("redirectUri must be a loopback http address");

  return redirectUri;
}

function readStart(body: unknown): ConnectionStart {
  return {
    redirectUri: readRedirectUri(body),
    codeChallenge: requireField(body, "codeChallenge"),
    state: requireField(body, "state"),
    nonce: requireField(body, "nonce"),
  };
}

function requireField(body: unknown, field: string): string {
  // Only typeof checks follow, so any JSON value may be read this way.
  const value = (body as Partial<Record<string, unknown>> | null)?.[field];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_FIELD_LENGTH
  )
    throw new ClientError(`${field} must be a non-empty string`);

  return value;
}

function signInClient(existing: ConnectionStatus | null): SignInClient {
  return {
    clientId: existing?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
    hostId: existing?.hostId ?? `urn:uuid:${crypto.randomUUID()}`,
    ...(existing?.email ? { email: existing.email } : {}),
  };
}

async function signInResponse(
  ctx: ActionCtx,
  req: Request,
  ref: ConnectionRef,
  existing: ConnectionStatus | null,
  actor: AuditActor,
): Promise<Response> {
  const meta = CONNECTION_TYPES[ref.type];
  const code = readCode(await parseJsonRequest(req));
  // OpenAI issued the client on this sign-in's redirect.
  const client = { clientId: code.clientId, hostId: code.hostId };
  const tokens = await exchangeCode(ref.type, client, code);
  const claims = await verifyIdToken(
    ref.type,
    tokens.idToken,
    client.clientId,
    code.nonce,
  );
  if (meta.requiredScope && !tokens.scopes.includes(meta.requiredScope))
    throw new ClientError(
      `The sign-in was not granted ${meta.requiredScope}; allow it when signing in`,
    );
  const stored = await ctx.runMutation(internal.account.connections.set, {
    ...ref,
    clientId: client.clientId,
    hostId: client.hostId,
    ...(claims.email ? { email: claims.email } : {}),
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
  const models = await listModels(ref.type, tokens.accessToken);
  await writeAudit(ctx, {
    accountId: ref.accountId,
    actor: actor,
    action: "updated",
    resource: {
      kind: "account",
      id: ref.accountId,
      name: `connection:${ref.type}`,
    },
    summary: `Connection ${ref.type} signed in`,
  });

  return json({
    ...publicConnection(stored),
    ...(models.length > 0 ? { models: models } : {}),
  });
}

async function startResponse(
  req: Request,
  type: ConnectionType,
  existing: ConnectionStatus | null,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const start = readStart(await parseJsonRequest(req));
  const client = signInClient(existing);

  return json({
    authorizeUrl: authorizeUrl(type, client, start),
    clientId: client.clientId,
    hostId: client.hostId,
  });
}
