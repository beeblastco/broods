import { describe, expect, it } from "vitest";
import { apiErrorBody } from "../model/apiError";
import {
  jsonError,
  methodNotAllowed,
  paginated,
} from "../config/routes/shared";

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

describe("paginated", () => {
  const items = Array.from({ length: 250 }, (_, index) => ({ id: index }));

  it("returns the whole collection under its own key when it fits", async () => {
    const body = await paginated(
      "agents",
      items.slice(0, 3),
      listRequest(),
    ).json();

    expect(body).toEqual({
      agents: [{ id: 0 }, { id: 1 }, { id: 2 }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("returns every row when the caller names no limit", async () => {
    const body = (await paginated("agents", items, listRequest()).json()) as {
      agents: unknown[];
      hasMore: boolean;
      nextCursor: string | null;
    };

    expect(body.agents).toHaveLength(250);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("pages only when the caller asks", async () => {
    const body = (await paginated(
      "agents",
      items,
      listRequest("?limit=100"),
    ).json()) as { agents: unknown[]; hasMore: boolean; nextCursor: string };

    expect(body.agents).toHaveLength(100);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBeTruthy();
  });

  it("rejects limits Number would quietly accept", () => {
    for (const raw of ["0x64", "1e2", "10.5", "-5"]) {
      expect(
        paginated("agents", items, listRequest(`?limit=${raw}`)).status,
      ).toBe(400);
    }
  });

  it("treats an empty limit as absent rather than zero", async () => {
    const response = paginated("agents", items, listRequest("?limit="));

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { agents: unknown[] }).agents,
    ).toHaveLength(250);
  });

  it("walks the whole collection across pages without gaps or repeats", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;

    do {
      const query = `?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await paginated(
        "agents",
        items,
        listRequest(query),
      ).json()) as {
        agents: { id: number }[];
        nextCursor: string | null;
      };
      seen.push(...body.agents.map((agent) => agent.id));
      cursor = body.nextCursor;
    } while (cursor);

    expect(seen).toEqual(items.map((item) => item.id));
  });

  it("rejects a limit outside the allowed range", async () => {
    const response = paginated("agents", items, listRequest("?limit=0"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_limit", param: "limit" },
    });
  });

  it("rejects a non-integer limit", () => {
    expect(paginated("agents", items, listRequest("?limit=abc")).status).toBe(
      400,
    );
  });

  it("rejects a cursor it did not issue", async () => {
    const response = paginated("agents", items, listRequest("?cursor=!!!"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_cursor", param: "cursor" },
    });
  });
});

function listRequest(query = ""): Request {
  return new Request(`https://api.example.com/v1/agents${query}`);
}
