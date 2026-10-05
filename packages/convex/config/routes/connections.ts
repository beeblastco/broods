/**
 * Connections (`/v1/account/connections[/{type}[/start]]`): external accounts
 * agents act through, one of each type. `broods connect` POSTs `start` for the
 * provider's consent screen, opens it, and PUTs the code the browser brought
 * back; this route trades it on the client OpenAI issued, checks the ID
 * token and stores the tokens. GET answers what is connected, never the
 * tokens; DELETE forgets, then revokes. Refresh is core's. The account key
 * or a `broods login` token may call it; role sessions and runtime keys may
 * not.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ConnectionStatus } from "../../account/connections";
import { type ConfigAuditActor } from "../../model/auditEvents";
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

/** The account and type a connection is stored under. */
interface ConnectionRef {
  accountId: Id<"accounts">;
  type: ConnectionType;
}

/** `/v1/account/connections`, one type under it, or that type's `start`. */
export interface ConnectionsPath {
  type: string | undefined;
  start: boolean;
}

/** Serves the connections routes after resolving the caller. */
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
  const selfHostedOnly = CONNECTION_TYPES[type].selfHostedOnly;
  if (
    selfHostedOnly &&
    isManagedService() &&
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

/** The connections path under `/v1/account`, or null for any other path. */
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

/** Forgets the type's connection, then revokes it at the provider. */
async function disconnectResponse(
  ctx: ActionCtx,
  ref: ConnectionRef,
  actor: ConfigAuditActor,
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

/** The API shape of a stored connection, with ISO dates. */
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

/** Validates a PUT body: the code and PKCE verifier the redirect brought back. */
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

/** The loopback redirect the CLI listens on; no other host may get a code. */
function readRedirectUri(body: unknown): string {
  const redirectUri = requireField(body, "redirectUri");
  if (!LOOPBACK_REDIRECT_PATTERN.test(redirectUri))
    throw new ClientError("redirectUri must be a loopback http address");

  return redirectUri;
}

/** Validates a start body: where to redirect and the PKCE and nonce values. */
function readStart(body: unknown): ConnectionStart {
  return {
    redirectUri: readRedirectUri(body),
    codeChallenge: requireField(body, "codeChallenge"),
    state: requireField(body, "state"),
    nonce: requireField(body, "nonce"),
  };
}

/** A non-empty string field of the JSON body, or a 400; a non-object body has none. */
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

/** The client a sign-in starts on: the one the type was issued, or a new registration. */
function signInClient(existing: ConnectionStatus | null): SignInClient {
  return {
    clientId: existing?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
    hostId: existing?.hostId ?? `urn:uuid:${crypto.randomUUID()}`,
    ...(existing?.email ? { email: existing.email } : {}),
  };
}

/**
 * Trades the code the browser brought back on the type's client, checks the
 * ID token and the grant, then stores the connection.
 */
async function signInResponse(
  ctx: ActionCtx,
  req: Request,
  ref: ConnectionRef,
  existing: ConnectionStatus | null,
  actor: ConfigAuditActor,
): Promise<Response> {
  const meta = CONNECTION_TYPES[ref.type];
  const code = readCode(await parseJsonRequest(req));
  // OpenAI issued the client on this sign-in's redirect.
  const client = { clientId: code.clientId, hostId: code.hostId };
  let stored: ConnectionStatus;
  let models: string[];
  try {
    const tokens = await exchangeCode(ref.type, client, code);
    const claims = await verifyIdToken(
      ref.type,
      tokens.idToken,
      client.clientId,
      code.nonce,
    );
    // A grant without the scope the type is for is no use: refuse it here
    // rather than at the first run.
    if (meta.requiredScope && !tokens.scopes.includes(meta.requiredScope))
      throw new Error(
        `The sign-in was not granted ${meta.requiredScope}; allow it when signing in`,
      );
    stored = await ctx.runMutation(internal.account.connections.set, {
      ...ref,
      clientId: client.clientId,
      hostId: client.hostId,
      ...(claims.email ? { email: claims.email } : {}),
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    models = await listModels(ref.type, tokens.accessToken);
  } catch {
    return jsonError(
      400,
      "Sign-in failed. Check the provided credentials and try again.",
    );
  }
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

/** Answers the provider's consent screen for a sign-in the CLI is starting. */
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
