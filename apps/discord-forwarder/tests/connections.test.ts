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
  webhookPath: "/webhooks/account-1/dev/endpoint-1/discord",
};

describe("resolving a plane's rows", () => {
  it("joins each path onto the plane's own gateway", () => {
    expect(planeConnections(PLANE, [ROW])).toEqual([
      {
        agentId: "agent-1",
        agentName: "support",
        botToken: "token-a",
        webhookUrl:
          "https://gateway.dev.example.com/webhooks/account-1/dev/endpoint-1/discord",
      },
    ]);
  });

  // The config plane returns a path and never learns which front door is in
  // front of it, which is what lets one process serve deployments answering on
  // different hosts. Same row, same token, two planes, two URLs.
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
        { ...ROW, webhookPath: "/webhooks/account-1/discord" },
      ]),
    ].map((connection) => connection.webhookUrl);

    expect(paths).toEqual([
      "https://gateway.dev.example.com/webhooks/account-1/dev/endpoint-1/discord",
      "https://gateway.example.com/webhooks/account-1/discord",
    ]);
  });
});
