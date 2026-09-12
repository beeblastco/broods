import { describe, expect, it } from "vitest";
import { apiErrorBody } from "../model/apiError";
import { jsonError, methodNotAllowed } from "../config/routes/shared";

describe("api error envelope", () => {
  it("derives type and code from the status", () => {
    expect(apiErrorBody(404, "Agent not found")).toEqual({
      error: {
        message: "Agent not found",
        type: "not_found_error",
        code: "not_found",
      },
    });
  });

  it("keeps a caller's code over the status default", () => {
    const body = apiErrorBody(409, "Conversation is busy", {
      code: "conversation_busy",
    });

    expect(body.error.code).toBe("conversation_busy");
    expect(body.error.type).toBe("conflict_error");
  });

  it("includes param only when the caller names a field", () => {
    expect(apiErrorBody(400, "bad").error).not.toHaveProperty("param");
    expect(apiErrorBody(400, "bad", { param: "limit" }).error.param).toBe(
      "limit",
    );
  });

  it("falls back by status class for a status not in the table", () => {
    expect(apiErrorBody(418, "teapot").error.type).toBe(
      "invalid_request_error",
    );
    expect(apiErrorBody(507, "full").error.type).toBe("api_error");
  });

  it("serializes at the declared status", async () => {
    const response = jsonError(401, "Unauthorized");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        message: "Unauthorized",
        type: "authentication_error",
        code: "unauthorized",
      },
    });
  });

  it("sends Allow on a 405, which RFC 9110 requires", async () => {
    const response = methodNotAllowed(["GET", "POST"]);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
    expect(await response.json()).toMatchObject({
      error: { code: "method_not_allowed" },
    });
  });
});
