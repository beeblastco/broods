import { executeDeployment, streamDeployment } from "./service";
import {
  corsHeaders,
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse(200, { ok: true });
    }

    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    // Match /v1/agents/{slug}/{endpointId} or /v1/agents/{endpointId}
    const slugMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/([^/]+)$/);
    const directMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);

    let endpointId: string;
    let environmentSlug: string | undefined;

    if (slugMatch) {
      environmentSlug = slugMatch[1];
      endpointId = slugMatch[2];
    } else if (directMatch) {
      endpointId = directMatch[1];
      environmentSlug = undefined;
    } else {
      return jsonResponse(404, { error: "Not found" });
    }

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
      try {
        const { result, sessionId, taskId } = await streamDeployment({
          endpointId: endpointId,
          environmentSlug: environmentSlug,
          apiKey: bearerToken,
          message: parsed.value.message,
          sessionId: parsed.value.sessionId,
          abortSignal: request.signal,
        });

        return result.toUIMessageStreamResponse({
          headers: {
            ...corsHeaders,
            "X-Session-Id": sessionId,
            "X-Task-Id": taskId,
          },
        });
      } catch (error) {
        return jsonResponse(resolveStatusCode(error), {
          success: false,
          error: toErrorMessage(error),
        });
      }
    }

    try {
      const result = await executeDeployment({
        endpointId: endpointId,
        environmentSlug: environmentSlug,
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
