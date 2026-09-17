import { describe, expect, it } from "bun:test";
import type { ConfigPlane } from "../../discord-forwarder/src/config.ts";
import { planeMatrixConnections } from "../src/connections.ts";

const PLANE: ConfigPlane = {
  convexUrl: "https://cheerful-orca.convex.cloud",
  deployKey: "dev:cheerful-orca|key",
  name: "dev",
  webhookBaseUrl: "https://gateway.dev.example.com",
};

const ROW = {
  agentId: "agent-1",
  agentName: "support",
  apiUrl: "https://matrix.example.org",
  botToken: "token-a",
  webhookPath: "/v1/webhooks/account-1/dev/endpoint-1/matrix",
};

describe("resolving a plane's matrix rows", () => {
  it("joins the path onto the plane's gateway and keeps the homeserver", () => {
    expect(planeMatrixConnections(PLANE, [ROW])).toEqual([
      {
        agentId: "agent-1",
        agentName: "support",
        apiUrl: "https://matrix.example.org",
        botToken: "token-a",
        webhookUrl:
          "https://gateway.dev.example.com/v1/webhooks/account-1/dev/endpoint-1/matrix",
      },
    ]);
  });

  it("skips a row that names no homeserver", () => {
    const { apiUrl: _apiUrl, ...withoutApiUrl } = ROW;

    expect(
      planeMatrixConnections(PLANE, [withoutApiUrl, { ...ROW, agentId: "b" }]),
    ).toHaveLength(1);
  });
});
