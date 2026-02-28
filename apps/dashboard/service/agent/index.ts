import { executeDeployment, streamDeployment } from "./service";
import {
  corsHeaders,
  jsonResponse,
  log,
  parseBearerToken,
  parseExecutePayload,
  resolveProviderError,
  resolveStatusCode,
  toErrorMessage,
} from "./utils";


const server = Bun.serve({
  port: Bun.env.PORT ?? 8080,
  idleTimeout: Number(Bun.env.AGENT_IDLE_TIMEOUT_SECONDS) || 0,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const start = Date.now();

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

    // Match /v1/{projectName}/agents/{envSlug}/{endpointId} or /v1/{projectName}/agents/{endpointId}
    const fullMatch = url.pathname.match(/^\/v1\/([^/]+)\/agents\/([^/]+)\/([^/]+)$/);
    const shortMatch = url.pathname.match(/^\/v1\/([^/]+)\/agents\/([^/]+)$/);

    let endpointId: string;
    let environmentSlug: string | undefined;

    if (fullMatch) {
      environmentSlug = fullMatch[2];
      endpointId = fullMatch[3];
    } else if (shortMatch) {
      endpointId = shortMatch[2];
      environmentSlug = undefined;
    } else {
      return jsonResponse(404, { error: "Not found" });
    }

    const bearerToken = parseBearerToken(request.headers.get("authorization"));
    if (!bearerToken) {
      log.warn("request:missing_token", { endpointId: endpointId, path: url.pathname });

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

    const mode = parsed.value.stream ? "stream" : "execute";
    log.info("request:start", {
      endpointId: endpointId,
      environmentSlug: environmentSlug,
      mode: mode,
      hasSession: !!parsed.value.sessionId,
    });

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

        log.info("request:stream_started", {
          endpointId: endpointId,
          sessionId: sessionId,
          taskId: taskId,
          durationMs: Date.now() - start,
        });

        return result.toUIMessageStreamResponse({
          headers: {
            ...corsHeaders,
            "X-Session-Id": sessionId,
            "X-Task-Id": taskId,
          },
          onError: (error: unknown) => {
            const pe = resolveProviderError(error);

            return pe?.message ?? toErrorMessage(error);
          },
        });
      } catch (error) {
        const status = resolveStatusCode(error);
        log.error("request:stream_error", {
          endpointId: endpointId,
          status: status,
          error: toErrorMessage(error),
          durationMs: Date.now() - start,
        });

        return jsonResponse(status, {
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

      log.info("request:completed", {
        endpointId: endpointId,
        sessionId: result.sessionId,
        taskId: result.taskId,
        durationMs: Date.now() - start,
      });

      return jsonResponse(200, {
        success: true,
        status: result.status,
        output: result.output,
        sessionId: result.sessionId,
        taskId: result.taskId,
      });
    } catch (error) {
      const providerError = resolveProviderError(error);
      const errorMessage = providerError?.message ?? toErrorMessage(error);
      const status = resolveStatusCode(error);
      log.error("request:execute_error", {
        endpointId: endpointId,
        status: status,
        error: errorMessage,
        durationMs: Date.now() - start,
      });

      return jsonResponse(status, {
        success: false,
        error: errorMessage,
      });
    }
  },
});

/** Gracefully drain in-flight requests before exiting. */
async function shutdown() {
  log.info("server:shutdown_start");
  server.stop(true);
  log.info("server:shutdown_complete");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log.info("server:started", { port: server.port, idleTimeoutSeconds: Bun.env.AGENT_IDLE_TIMEOUT_SECONDS || 0 });
