import { expect, test } from "bun:test";
import { BroodsClient, type AgentReference } from "../src/client.ts";
import { requestUrl } from "./fixtures/request-url.ts";

const ref: AgentReference = {
  kind: "agent",
  name: "support",
  id: "agent_1",
  project: "demo",
  stage: "development",
  endpointId: "ep_1",
  projectSlug: "demo",
  stageSlug: "development",
};

test("answer posts the answers to the agent's run route and returns the acceptance", async (): Promise<void> => {
  const calls: Array<{ url: string; body: string }> = [];
  const client = new BroodsClient({
    baseUrl: "https://gateway.example.com",
    apiKey: "key-1",
    fetch: async (input, init): Promise<Response> => {
      calls.push({
        url: requestUrl(input),
        body: typeof init?.body === "string" ? init.body : "",
      });

      return Response.json(
        {
          status: "accepted",
          resultId: "res_1",
          eventId: "evt_resumed",
          invoked: true,
        },
        { status: 202 },
      );
    },
  });

  const accepted = await client.answer(ref, {
    conversationKey: "chat-1",
    eventId: "answer-1",
    answers: [{ statusId: "res_1", answers: { color: ["Blue"] } }],
  });

  expect(calls[0]?.url).toBe(
    "https://gateway.example.com/v1/projects/demo/stages/development/agents/ep_1",
  );
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    agentId: "agent_1",
    eventId: "answer-1",
    conversationKey: "chat-1",
    answers: [{ statusId: "res_1", answers: { color: ["Blue"] } }],
  });
  expect(accepted).toEqual({
    status: "accepted",
    resultId: "res_1",
    eventId: "evt_resumed",
    invoked: true,
  });
});

test("answer passes its signal to fetch and rethrows the abort unwrapped", async (): Promise<void> => {
  const client = new BroodsClient({
    baseUrl: "https://gateway.example.com",
    apiKey: "key-1",
    fetch: async (_input, init): Promise<Response> => {
      init?.signal?.throwIfAborted();

      return Response.json({ status: "accepted" }, { status: 202 });
    },
  });

  await expect(
    client.answer(ref, {
      conversationKey: "chat-1",
      answers: [{ statusId: "res_1", answers: { color: ["Blue"] } }],
      signal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
