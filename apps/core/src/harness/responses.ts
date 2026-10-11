/**
 * The HTTP and SSE answers the harness handler gives a run: admission
 * refusals, the 202s of async, socket and continuation runs, the SSE error and
 * empty bodies, and the pump that writes an agent stream out as frames. What
 * a run does stays in handler.ts; only the response shapes live here.
 */

import { getHarnessPublicUrl } from "../shared/env.ts";
import { errorResponse, jsonResponse } from "../shared/http.ts";
import { publicEventIdForScope } from "../shared/runtime-keys.ts";
import type { AsyncToolResultRecord } from "./async-tool-result.ts";
import { readAgentFullStream, type AgentLoopStream } from "./harness.ts";
import type { IngressAdmission } from "./ingress.ts";
import type {
  AsyncDirectInboundEvent,
  DirectInboundEvent,
} from "./integrations.ts";

const textEncoder = new TextEncoder();

// A queue at capacity drains on the order of seconds, not minutes.
export const INGRESS_RETRY_HEADERS = { "Retry-After": "5" };
export const CONVERSATION_BUSY =
  "Conversation is already processing another turn. Try again when the current turn finishes.";

export type ContinuationOutcome =
  | { kind: "ready"; invoked: boolean; publicEventId: string }
  | { kind: "skip" };

export function continuationResponse(
  settled: AsyncToolResultRecord,
  outcome: ContinuationOutcome,
): Response {
  if (outcome.kind === "skip") {
    return jsonResponse(202, {
      status: "accepted",
      resultId: settled.resultId,
      invoked: false,
    });
  }

  return jsonResponse(202, {
    status: "accepted",
    resultId: settled.resultId,
    eventId: outcome.publicEventId,
    invoked: outcome.invoked,
  });
}

/** The 202 a socket turn gets: the NATS scope the gateway streams the run from. */
export function natsStartResponse(
  event: DirectInboundEvent,
  publicEventId: string,
  statusUrl: string | null,
): Response {
  return jsonResponse(202, {
    eventId: publicEventId,
    // Always sent, so the gateway can poll status in-cluster even when no
    // public statusUrl exists (PUBLIC_BASE_URL unset).
    runId: event.runId,
    conversationKey: event.publicConversationKey,
    status: "processing",
    requestedMode: event.requestedMode,
    ...(statusUrl ? { statusUrl: statusUrl } : {}),
    nats: {
      accountId: event.accountId,
      agentId: event.agentId,
      conversationKey: event.publicConversationKey,
    },
  });
}

// The SSE body and the NATS worker share this pump; only `send` differs.
export async function pipeAgentStream(
  stream: AgentLoopStream,
  send: (chunk: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let emittedErrorChunk = false;
  for await (const value of readAgentFullStream(stream)) {
    if (isErrorStreamChunk(value)) {
      emittedErrorChunk = true;
    }
    await send(value as Record<string, unknown>);
  }

  const failureText = stream.failureText();
  if (failureText && !emittedErrorChunk) {
    await send({ type: "error", error: failureText });
  }
  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await send({ type: "structured-output", output: finalResponse });
  }
}

function isErrorStreamChunk(chunk: unknown): boolean {
  return Boolean(
    chunk &&
    typeof chunk === "object" &&
    (chunk as { type?: unknown }).type === "error",
  );
}

export function emptySseResponse(): Response {
  return new Response(
    new ReadableStream({
      start: function (controller) {
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export function errorSseResponse(
  error: string,
  statusCode = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    new ReadableStream({
      start: function (controller) {
        controller.enqueue(
          textEncoder.encode(
            `data: ${JSON.stringify({ type: "error", error: error })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    {
      status: statusCode,
      headers: { ...headers, "content-type": "text/event-stream" },
    },
  );
}

export function acceptedAsyncResponse(
  runId: string,
  statusUrl: string,
  event: Pick<
    DirectInboundEvent,
    "publicEventId" | "publicConversationKey" | "requestedMode"
  >,
  status: string,
): Response {
  return jsonResponse(202, {
    runId: runId,
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
    status: status,
    requestedMode: event.requestedMode,
    statusUrl: statusUrl,
  });
}

export function directStatusUrl(
  event: Pick<DirectInboundEvent, "runId">,
): string | null {
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) return null;

  return `${baseUrl}/v1/runs/${encodeURIComponent(event.runId)}`;
}

function publicEventIdFromScoped(
  value: string | undefined,
  event: DirectInboundEvent,
): string {
  return publicEventIdForScope(
    value,
    event.accountId,
    event.agentId,
    event.publicEventId,
  );
}

export function directAdmissionResponse(
  event: DirectInboundEvent,
  admission: IngressAdmission,
  jsonOnly: boolean,
): Response {
  if (admission.outcome === "rejected") {
    return jsonOnly
      ? errorResponse(409, CONVERSATION_BUSY, { code: "conversation_busy" })
      : errorSseResponse(CONVERSATION_BUSY, 409);
  }
  if (admission.outcome === "capacity") {
    const message = "Conversation ingress queue is at capacity";

    return jsonOnly
      ? errorResponse(
          429,
          message,
          { code: "ingress_capacity" },
          INGRESS_RETRY_HEADERS,
        )
      : errorSseResponse(message, 429);
  }
  if (admission.outcome === "conflict") {
    const message =
      "Idempotency key is already bound to a different ingress payload";

    return jsonOnly
      ? errorResponse(409, message, { code: "idempotency_conflict" })
      : errorSseResponse(message, 409);
  }
  const publicEventId = publicEventIdFromScoped(admission.eventId, event);
  // A duplicate answers with the first admission's run id, never the one this
  // retry minted, so an idempotent POST keeps pointing at one run.
  const runId = admission.runId ?? event.runId;
  const statusUrl = directStatusUrl({ runId: runId });

  return jsonResponse(202, {
    runId: runId,
    eventId: publicEventId,
    conversationKey: event.publicConversationKey,
    status: admission.status ?? "queued",
    requestedMode: event.requestedMode,
    ...(statusUrl ? { statusUrl: statusUrl } : {}),
  });
}

export function asyncAdmissionResponse(
  event: AsyncDirectInboundEvent,
  admission: IngressAdmission,
): Response {
  if (admission.outcome === "rejected") {
    return errorResponse(409, CONVERSATION_BUSY, { code: "conversation_busy" });
  }
  if (admission.outcome === "capacity") {
    return errorResponse(
      429,
      "Conversation ingress queue is at capacity",
      { code: "ingress_capacity" },
      INGRESS_RETRY_HEADERS,
    );
  }
  if (admission.outcome === "conflict") {
    return errorResponse(
      409,
      "Idempotency key is already bound to a different ingress payload",
      {
        code: "idempotency_conflict",
      },
    );
  }
  const publicEventId = publicEventIdFromScoped(admission.eventId, event);
  const runId = admission.runId ?? event.runId;
  const statusUrl = directStatusUrl({ runId: runId }) ?? event.statusUrl;

  return acceptedAsyncResponse(
    runId,
    statusUrl,
    {
      publicEventId: publicEventId,
      publicConversationKey: event.publicConversationKey,
      requestedMode: event.requestedMode,
    },
    admission.status ?? "queued",
  );
}
