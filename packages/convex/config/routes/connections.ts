/**
 * Connections (`/v1/account/connections[/{name}]`): external accounts agents
 * act through. `broods connect` does the browser sign-in and PUTs the tokens
 * here; GET answers what is connected, never the tokens; DELETE forgets, then
 * revokes. Refresh is core's, not this route's. The account secret or a
 * `broods login` token may call it; role sessions and runtime keys may not.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ConnectionStatus } from "../../account/connections";
import { ClientError } from "../../model/clientError";
import {
  CONNECTION_NAME_PATTERN,
  CONNECTION_TYPE_NAMES,
  CONNECTION_TYPES,
  type Connection,
  type ConnectionSignIn,
  isConnectionType,
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

/** Serves `/v1/account/connections[/{name}]` after resolving the caller. */
export async function handleConnectionsRoute(
  ctx: ActionCtx,
  req: Request,
  name: string | undefined,
): Promise<Response> {
  const caller = await resolveAccountCaller(ctx, req);
  if (!caller) return await unauthorizedResponse(ctx, req);
  // A runtime key controls one stage; a connection acts for the whole account.
  if (caller.deploymentScope) {
    return jsonError(
      403,
      "Connections require the account secret or a CLI login",
    );
  }
  const accountId = caller.accountId;

  if (name === undefined) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const rows: ConnectionStatus[] = await ctx.runQuery(
      internal.account.connections.list,
      { accountId: accountId },
    );

    return json({ connections: rows.map((row) => publicConnection(row)) });
  }

  const ref = { accountId: accountId, name: name };
  if (req.method === "GET") {
    const row: ConnectionStatus | null = await ctx.runQuery(
      internal.account.connections.status,
      ref,
    );

    return row
      ? json(publicConnection(row))
      : jsonError(404, "Connection not found");
  }
  if (req.method === "PUT") {
    const signIn = readSignIn(name, await parseJsonRequest(req));
    const selfHostedOnly = CONNECTION_TYPES[signIn.type].selfHostedOnly;
    if (selfHostedOnly && isManagedService())
      return jsonError(403, selfHostedOnly);
    const stored: ConnectionStatus = await ctx.runMutation(
      internal.account.connections.set,
      { ...ref, ...signIn, expiresAt: Date.parse(signIn.expiresAt) },
    );
    await writeAudit(ctx, {
      accountId: accountId,
      actor: caller.actor,
      action: "updated",
      resource: { kind: "account", id: accountId, name: `connection:${name}` },
      summary: `Connection ${name} (${signIn.type}) signed in`,
    });

    return json(publicConnection(stored));
  }
  if (req.method === "DELETE") {
    const deleted: boolean = await ctx.runMutation(
      internal.account.connections.disconnect,
      ref,
    );
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: caller.actor,
        action: "deleted",
        resource: {
          kind: "account",
          id: accountId,
          name: `connection:${name}`,
        },
        summary: `Connection ${name} disconnected`,
      });
    }

    return json({ deleted: deleted });
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

/** The connection name from `/v1/account/connections/{name}`, or undefined for the collection. */
export function parseConnectionsPath(pathname: string): {
  name: string | undefined;
} | null {
  if (pathname === "/v1/account/connections") return { name: undefined };
  const match = pathname.match(/^\/v1\/account\/connections\/([^/]+)$/);

  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

/** The API shape of a stored connection, with ISO dates. */
function publicConnection(row: ConnectionStatus): Connection {
  return {
    name: row.name,
    type: row.type,
    clientId: row.clientId,
    ...(row.hostId ? { hostId: row.hostId } : {}),
    ...(row.email ? { email: row.email } : {}),
    scopes: row.scopes,
    expiresAt: new Date(row.expiresAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** Validates a PUT body against the name and the type's own rules. */
function readSignIn(name: string, body: unknown): ConnectionSignIn {
  if (!CONNECTION_NAME_PATTERN.test(name))
    throw new ClientError(
      "Connection names are lowercase letters, digits and dashes",
    );
  // Only typeof checks below, so a non-object body reads as all fields missing.
  const fields = (body ?? {}) as Partial<
    Record<keyof ConnectionSignIn, unknown>
  >;
  const type = fields.type;
  if (!isConnectionType(type))
    throw new ClientError(
      `type must be one of ${CONNECTION_TYPE_NAMES.join(", ")}`,
    );
  const required = (field: keyof ConnectionSignIn): string => {
    const value = fields[field];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_FIELD_LENGTH
    )
      throw new ClientError(`${field} must be a non-empty string`);

    return value;
  };
  const optional = (field: keyof ConnectionSignIn): string | undefined =>
    fields[field] === undefined ? undefined : required(field);
  const scopes = fields.scopes;
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope): scope is string => typeof scope === "string")
  )
    throw new ClientError("scopes must be an array of strings");
  const expiresAt = required("expiresAt");
  if (Number.isNaN(Date.parse(expiresAt)))
    throw new ClientError("expiresAt must be an ISO 8601 date");
  const hostId = optional("hostId");
  const clientSecret = optional("clientSecret");
  const email = optional("email");
  const meta = CONNECTION_TYPES[type];
  if (meta.fixedName && name !== meta.fixedName)
    throw new ClientError(
      `A ${type} connection must be named ${meta.fixedName}`,
    );
  // Something reads a fixed name as its own type, so no other type may take it.
  const owner = CONNECTION_TYPE_NAMES.find(
    (typeName) => CONNECTION_TYPES[typeName].fixedName === name,
  );
  if (owner && owner !== type)
    throw new ClientError(`${name} is reserved for the ${owner} connection`);
  // A registered client is attributed to the deployment's host id.
  if (meta.client === "dynamic" && !hostId)
    throw new ClientError(`hostId is required for ${type}`);
  // A grant without the scope the type is for is no use: refuse it here
  // rather than at the first run.
  if (meta.requiredScope && !scopes.includes(meta.requiredScope))
    throw new ClientError(
      `The sign-in was not granted ${meta.requiredScope}; allow it when signing in`,
    );
  if (meta.needsClientSecret && !clientSecret)
    throw new ClientError(`clientSecret is required for ${type}`);

  return {
    type: type,
    clientId: required("clientId"),
    ...(clientSecret ? { clientSecret: clientSecret } : {}),
    ...(hostId ? { hostId: hostId } : {}),
    ...(email ? { email: email } : {}),
    scopes: scopes,
    expiresAt: expiresAt,
    accessToken: required("accessToken"),
    refreshToken: required("refreshToken"),
  };
}
