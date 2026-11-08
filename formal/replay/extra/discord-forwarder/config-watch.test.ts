import { afterEach, describe, expect, mock, test } from "bun:test";

type Rows = {
  agentId: string;
  agentName: string;
  botToken: string;
  webhookPath: string;
}[];

const closed: string[] = [];
let failPlane = "";

class FakeConvexClient {
  readonly url: string;
  adminKey = "";

  constructor(url: string) {
    this.url = url;
  }

  setAdminAuth(key: string): void {
    this.adminKey = key;
  }

  onUpdate(
    _query: unknown,
    _args: unknown,
    onRows: (rows: Rows) => void,
    onError: (error: Error) => void,
  ): void {
    if (this.url.includes(failPlane) && failPlane)
      onError(new Error("socket lost"));
    else
      onRows([
        { agentId: "a1", agentName: "A", botToken: "b", webhookPath: "/hook" },
      ]);
  }

  async close(): Promise<void> {
    closed.push(this.url);
  }
}

await mock.module("convex/browser", () => ({ ConvexClient: FakeConvexClient }));

const { configPlanesEnv, forwarderConfigFromEnv } =
  await import("../../../../apps/discord-forwarder/src/config.ts");
const { watchChannelConnections } =
  await import("../../../../apps/discord-forwarder/src/connections.ts");

const PLANES = JSON.stringify([
  {
    convexUrl: "https://one.example",
    name: "dev-one",
    webhookBaseUrl: "https://hook.example",
  },
]);
const PLANE = {
  convexUrl: "https://one.example",
  deployKey: "key",
  name: "one",
  webhookBaseUrl: "https://hook.example",
};
const SECOND = { ...PLANE, convexUrl: "https://two.example", name: "two" };

afterEach((): void => {
  delete process.env.BROODS_CONFIG_PLANES;
  delete process.env.CONVEX_DEPLOY_KEY_DEV_ONE;
  failPlane = "";
});

describe("forwarder config", () => {
  test("each plane names its deploy key", (): void => {
    process.env.BROODS_CONFIG_PLANES = PLANES;
    process.env.CONVEX_DEPLOY_KEY_DEV_ONE = "secret";
    expect(configPlanesEnv()[0]?.deployKey).toBe("secret");
    expect(forwarderConfigFromEnv().identifyLimit).toBe(500);
  });

  test("a plane without its key refuses to start", (): void => {
    process.env.BROODS_CONFIG_PLANES = PLANES;
    expect(() => configPlanesEnv()).toThrow("CONVEX_DEPLOY_KEY_DEV_ONE");
  });
});

describe("watching planes", () => {
  test("combines every plane's rows and closes all clients", async (): Promise<void> => {
    const seen: string[][] = [];
    const watch = watchChannelConnections(
      "discord",
      [PLANE, SECOND],
      (plane, rows): string[] =>
        rows.map((row): string => `${plane.name}:${row.agentId}`),
      (connections: string[]): void => {
        seen.push(connections);
      },
    );
    expect(seen.at(-1)).toEqual(["one:a1", "two:a1"]);
    await watch.close();
    expect(closed).toContain("https://two.example");
  });

  test("a silent plane only logs", (): void => {
    failPlane = "two";
    const seen: string[][] = [];
    watchChannelConnections(
      "discord",
      [SECOND],
      (): string[] => ["never"],
      (connections: string[]): void => {
        seen.push(connections);
      },
    );
    expect(seen).toEqual([]);
  });
});
