import { executeDeployment } from "./service";
import {
  createSseResponse,
  jsonResponse,
  parseBearerToken,
  parseExecutePayload,
  resolveStatusCode,
  toErrorMessage,
} from "./utils";

const server = Bun.serve({
  port: Bun.env.PORT ?? 8080,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse(200, { ok: true });
    }

    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const endpointMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (!endpointMatch) {
      return jsonResponse(404, { error: "Not found" });
    }
    const endpointId = endpointMatch[1];

    const bearerToken = parseBearerToken(request.headers.get("authorization"));
    if (!bearerToken) {
      return jsonResponse(401, { error: "Missing bearer token" });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    const parsed = parseExecutePayload(payload);
    if (!parsed.ok) {
      return jsonResponse(400, { error: parsed.error });
    }

    if (parsed.value.stream) {
      return createSseResponse(
        async (emit) => {
          emit("execution.accepted", {
            endpointId: endpointId,
            hasMessage: parsed.value.message !== undefined,
          });

          const result = await executeDeployment({
            endpointId: endpointId,
            apiKey: bearerToken,
            message: parsed.value.message,
            sessionId: parsed.value.sessionId,
            emit: emit,
            abortSignal: request.signal,
          });

          emit("execution.completed", {
            output: result.output,
            sessionId: result.sessionId,
            taskId: result.taskId,
          });
        },
        request.signal,
      );
    }

    try {
      const result = await executeDeployment({
        endpointId: endpointId,
        apiKey: bearerToken,
        message: parsed.value.message,
        sessionId: parsed.value.sessionId,
      });

      return jsonResponse(200, {
        success: true,
        status: result.status,
        output: result.output,
        sessionId: result.sessionId,
        taskId: result.taskId,
      });
    } catch (error) {
      return jsonResponse(resolveStatusCode(error), {
        success: false,
        error: toErrorMessage(error),
      });
    }
  },
});

console.log(`agent-gateway listening on :${server.port}`);
