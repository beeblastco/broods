import { apiErrorBody, type ApiErrorInit } from "@broods/convex/model/apiError";
import { getHarnessPublicUrl } from "../shared/env.ts";
import { errorResponse, jsonResponse } from "../shared/http.ts";
import { publicEventIdForScope } from "../shared/runtime-keys.ts";
import type { AsyncToolResultRecord } from "./async-tool-result.ts";
import { readAgentFullStream, type AgentLoopStream } from "./harness.ts";
import { INGRESS_RETRY_HEADERS, type IngressAdmission } from "./ingress.ts";
import type { DirectInboundEvent } from "./integrations.ts";

const textEncoder = new TextEncoder();

export const CONVERSATION_BUSY =
  "Conversation is already processing another turn. Try again when the current turn finishes.";

export type ContinuationOutcome =
  | {
      kind: "ready";
      admission: IngressAdmission["outcome"];
      invoked: boolean;
      publicEventId: string;
      runId: string;
    }
  | { kind: "skip" };

export function continuationResponse(
  settled: AsyncToolResultRecord,
  outcome: ContinuationOutcome,
  alreadyAnswered: string[] = [],
): Response {
  const skipped =
    alreadyAnswered.length > 0 ? { alreadyAnswered: alreadyAnswered } : {};
  if (outcome.kind === "skip") {
    return jsonResponse(202, {
      status: "accepted",
      resultId: settled.resultId,
      invoked: false,
      ...skipped,
    });
  }

  const statusUrl = directStatusUrl({ runId: outcome.runId });

  return jsonResponse(202, {
    status: "accepted",
    resultId: settled.resultId,
    eventId: outcome.publicEventId,
    runId: outcome.runId,
    ...(statusUrl ? { statusUrl: statusUrl } : {}),
    invoked: outcome.invoked,
    ...skipped,
  });
}

export function natsStartResponse(
  event: DirectInboundEvent,
  publicEventId: string,
  statusUrl: string | null,
): Response {
  return jsonResponse(202, {
    eventId: publicEventId,
    // The gateway polls status in-cluster with it when no public statusUrl exists.
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

// Takes errorResponse's arguments so a streamed refusal carries the JSON envelope's code and type.
export function errorSseResponse(
  status: number,
  message: string,
  init: ApiErrorInit = {},
  headers: Record<string, string> = {},
): Response {
  const { error } = apiErrorBody(status, message, init);
  const frame = {
    type: "error",
    error: error.message,
    code: error.code,
    errorType: error.type,
  };

  return new Response(
    new ReadableStream({
      start: function (controller) {
        controller.enqueue(
          textEncoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
        controller.close();
      },
    }),
    {
      status: status,
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
  const refuse = jsonOnly ? errorResponse : errorSseResponse;
  if (admission.outcome === "rejected") {
    return refuse(409, CONVERSATION_BUSY, { code: "conversation_busy" });
  }
  if (admission.outcome === "capacity") {
    return refuse(
      429,
      "Conversation ingress queue is at capacity",
      { code: "ingress_capacity" },
      INGRESS_RETRY_HEADERS,
    );
  }
  if (admission.outcome === "conflict") {
    return refuse(
      409,
      "Idempotency key is already bound to a different ingress payload",
      { code: "idempotency_conflict" },
    );
  }
  const publicEventId = publicEventIdFromScoped(admission.eventId, event);
  // A duplicate gets the first admission's run id, so an idempotent POST names one run.
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
