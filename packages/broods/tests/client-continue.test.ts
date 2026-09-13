import { expect, test } from "bun:test";
import { BroodsClient, type AgentReference } from "../src/client.ts";

type Call = { url: string; body: string };

function mockClient(
  status: number,
  payload: unknown,
): {
  client: BroodsClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = new BroodsClient({
    baseUrl: "https://gateway.example.com",
    apiKey: "key-1",
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });

      return new Response(JSON.stringify(payload), { status: status });
    },
  });

  return { client: client, calls: calls };
}

const ref: AgentReference = {
  kind: "agent",
  name: "tracy",
  id: "agent_1",
  project: "demo",
  stage: "development",
  endpointId: "ep_1",
  projectSlug: "demo",
  stageSlug: "development",
};

test("continueRun posts continue: true to the scoped run route", async () => {
  const { client, calls } = mockClient(202, {
    eventId: "continue-1",
    conversationKey: "tg:42",
    status: "processing",
    statusUrl: "https://gateway.example.com/v1/runs/continue-1?agentId=agent_1",
  });

  const run = await client.continueRun(ref, {
    eventId: "continue-1",
    conversationKey: "acct:a1:agent:agent_1:tg:42",
  });

  expect(calls[0]?.url).toBe(
    "https://gateway.example.com/v1/projects/demo/stages/development/agents/ep_1",
  );
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    agentId: "agent_1",
    eventId: "continue-1",
    conversationKey: "acct:a1:agent:agent_1:tg:42",
    continue: true,
  });
  expect(run.statusId).toBe("continue-1");
  expect(run.status).toBe("processing");
});

test("continueRun surfaces a non-202 answer as an error", async () => {
  const { client } = mockClient(404, {
    error: { message: "Conversation not found" },
  });

  await expect(
    client.continueRun({ agentId: "agent_1", conversationKey: "chat_1" }),
  ).rejects.toThrow("Continue failed: 404");
});
