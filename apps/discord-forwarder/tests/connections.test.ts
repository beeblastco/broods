import { describe, expect, it } from "bun:test";
import type { ConfigPlane } from "../src/config.ts";
import { planeConnections } from "../src/connections.ts";

const PLANE: ConfigPlane = {
  convexUrl: "https://cheerful-orca.convex.cloud",
  deployKey: "dev:cheerful-orca|key",
  name: "dev",
  webhookBaseUrl: "https://gateway.dev.example.com",
};

const ROW = {
  agentId: "agent-1",
  agentName: "support",
  botToken: "token-a",
  webhookPath: "/v1/webhooks/account-1/dev/endpoint-1/discord",
};

describe("resolving a plane's rows", () => {
  it("sends one token's rows to whichever gateway its plane names", () => {
    const prod: ConfigPlane = {
      convexUrl: "https://kindred-avocet.convex.cloud",
      deployKey: "prod:kindred-avocet|key",
      name: "prod",
      webhookBaseUrl: "https://gateway.example.com",
    };
    const paths = [
      ...planeConnections(PLANE, [ROW]),
      ...planeConnections(prod, [
        { ...ROW, webhookPath: "/v1/webhooks/account-1/discord" },
      ]),
    ].map((connection) => connection.webhookUrl);

    expect(paths).toEqual([
      "https://gateway.dev.example.com/v1/webhooks/account-1/dev/endpoint-1/discord",
      "https://gateway.example.com/v1/webhooks/account-1/discord",
    ]);
  });
});
