/**
 * The forwarder's HTTP surface: probes for the kubelet, and the two calls core
 * makes back into a room. No ingress: core reaches it in-cluster, and every
 * call authenticates with the account's own access token.
 */

import {
  MATRIX_ACCESS_TOKEN_HEADER,
  type MatrixSendRequest,
  type MatrixSendResponse,
  type MatrixTypingRequest,
} from "../../core/src/shared/matrix-wire.ts";
import { logWarn, tokenHint } from "../../discord-forwarder/src/log.ts";
import type { Forwarder } from "./supervisor.ts";

export async function handleRequest(
  forwarder: Pick<Forwarder, "account" | "status">,
  ready: boolean,
  request: Request,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const status = ready ? "ok" : "starting";
  // Liveness never waits on the config plane: a Convex outage must not become
  // a restart loop. Only readiness carries the account detail.
  if (path === "/" || path === "/healthz") {
    return Response.json({ status: status });
  }
  if (path === "/readyz") {
    return Response.json(
      { status: status, ...forwarder.status() },
      { status: ready ? 200 : 503 },
    );
  }
  if (
    request.method !== "POST" ||
    (path !== "/v1/send" && path !== "/v1/typing")
  ) {
    return new Response("Not found", { status: 404 });
  }

  const accessToken = request.headers.get(MATRIX_ACCESS_TOKEN_HEADER);
  const account = accessToken ? forwarder.account(accessToken) : undefined;
  if (!accessToken || !account) {
    return new Response("Unknown Matrix access token", { status: 401 });
  }
  // Not a homeserver blip: retrying cannot help until the token changes.
  if (account.state === "failed") {
    return new Response(
      "Matrix account stopped and will not restart until its access token changes",
      { status: 409 },
    );
  }
  const body: unknown = await request.json().catch((): null => null);

  try {
    if (path === "/v1/send") {
      if (!isSendRequest(body)) {
        return new Response("Invalid send request", { status: 400 });
      }
      const sent: MatrixSendResponse = { eventId: await account.send(body) };

      return Response.json(sent);
    }
    if (!isTypingRequest(body)) {
      return new Response("Invalid typing request", { status: 400 });
    }
    await account.setTyping(body);

    return new Response(null, { status: 204 });
  } catch (error) {
    logWarn("Matrix outbound request failed", {
      error: error instanceof Error ? error.message : String(error),
      path: path,
      tokenHint: tokenHint(accessToken),
    });

    return new Response("Matrix homeserver request failed", { status: 502 });
  }
}

// The two casts below sit where core's JSON becomes typed: every value stays
// `unknown` until it is checked.
function isSendRequest(body: unknown): body is MatrixSendRequest {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Partial<Record<keyof MatrixSendRequest, unknown>>;

  return (
    typeof record.roomId === "string" &&
    (record.type === "m.reaction" || record.type === "m.room.message") &&
    typeof record.content === "object" &&
    record.content !== null &&
    !Array.isArray(record.content)
  );
}

function isTypingRequest(body: unknown): body is MatrixTypingRequest {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Partial<Record<keyof MatrixTypingRequest, unknown>>;

  return (
    typeof record.roomId === "string" && typeof record.typing === "boolean"
  );
}
