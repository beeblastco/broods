import { expect, test } from "@playwright/test";
import type { UIMessageChunk } from "ai";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  WebSocketClientMessage,
  WebSocketServerMessage,
} from "../../../../packages/broods/src/websocket-contracts";
import type { api } from "../../../../packages/convex/_generated/api";
import type { Id } from "../../../../packages/convex/_generated/dataModel";
import { PAGE_RENDER_BUDGET_MS, PERF_BUDGETS } from "../../app/lib/perfReport";
import { run, STACK_ADMIN } from "../lib/localStack";
import {
  BASE_URL,
  hasProbe,
  MISSING_PROBE,
  probeAccount,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";
import {
  LONG_TASK_SETTLE_MS,
  waitForReady,
  watchLongTasks,
} from "../lib/timing";

const SECTIONS = 24;
const DELTA_CHARS = 18;
const DELTA_INTERVAL_MS = 8;
// 20 commits a second is as fast as anyone reads. The headroom is for commits not from the
// stream: the user's message, the status, code highlighting, Convex updates.
const COMMIT_WINDOW_MS = 50;
const COMMIT_HEADROOM = 1.5;
const COMMIT_MARK = "e2e-react-commit";
const ANSWER_END = "END-OF-STREAM";
const ANSWER_ID = "chat-stream-answer";
const AGENT_WAIT_MS = 10_000;
const SEEDED_AGENT = "chat-stream-probe";

const ANSWER = Array.from(
  { length: SECTIONS },
  (_, index) =>
    `## Section ${index + 1}: deploying the agent fleet\n\n` +
    "The orchestrator keeps **one run per conversation** and replays the event log when a worker restarts. " +
    "This paragraph is deliberately long so wrapping and layout cost are realistic, with `inline code`, " +
    `a [link](https://example.com/docs/${index}) and some _emphasis_ that the markdown renderer must handle.\n\n` +
    "- First, the gateway accepts the socket and checks the bearer\n" +
    "- Then core claims the turn from its queue\n" +
    "- Finally the stream is fanned out to every subscriber\n" +
    "  - nested item with **bold**\n\n" +
    "```ts\n" +
    `export async function handle${index}(request: Request): Promise<Response> {\n` +
    "  const body = await request.json();\n" +
    `  const result = await runAgent({ input: body.input, step: ${index} });\n` +
    "  if (!result.ok) {\n" +
    "    return Response.json({ error: result.error }, { status: 500 });\n" +
    "  }\n" +
    '  return new Response(result.stream, { headers: { "content-type": "text/event-stream" } });\n' +
    "}\n" +
    "```\n\n" +
    "| metric | p50 | p95 |\n| --- | --- | --- |\n" +
    `| first token | ${80 + index} ms | ${140 + index} ms |\n` +
    `| turn | ${300 + index} ms | ${520 + index} ms |\n\n` +
    `> Note ${index}: keep the payload small; send deltas, never the whole message.\n\n`,
).join("");
const DELTAS: UIMessageChunk[] = [
  ...Array.from(
    { length: Math.ceil(ANSWER.length / DELTA_CHARS) },
    (_, index) => ANSWER.slice(index * DELTA_CHARS, (index + 1) * DELTA_CHARS),
  ),
  `Done. ${ANSWER_END}`,
].map((delta) => ({ type: "text-delta", id: ANSWER_ID, delta: delta }));
const STREAM_START: UIMessageChunk[] = [
  { type: "start", messageId: ANSWER_ID },
  { type: "start-step" },
  { type: "text-start", id: ANSWER_ID },
];
const STREAM_END: UIMessageChunk[] = [
  { type: "text-end", id: ANSWER_ID },
  { type: "finish-step" },
  { type: "finish" },
];

interface SentStream {
  startedAt: number;
  endedAt: number;
}

test.skip(!hasProbe(), MISSING_PROBE);

test("a long streamed answer on the agent Test tab reaches the screen without a render per chunk", async ({
  browser,
}) => {
  const projectId = readProjectId();
  const context = await browser.newContext(SIGNED_IN_CONTEXT);
  const page = await context.newPage();
  // Production React reports each commit to the DevTools hook, which it reads once at start.
  await page.addInitScript((mark) => {
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: () => {
          performance.mark(mark);
        },
      },
    });
  }, COMMIT_MARK);
  const sent = Promise.withResolvers<SentStream>();
  await page.routeWebSocket(/\/agents\/[^/]+\/ws$/, (socket) => {
    const send = (frame: WebSocketServerMessage): void =>
      socket.send(JSON.stringify(frame));
    socket.onMessage(async (raw) => {
      const message = JSON.parse(String(raw)) as WebSocketClientMessage;
      if (message.type !== "execute") return;
      const startedAt = performance.now();
      send({
        type: "meta",
        sessionId: "chat-stream-session",
        taskId: "chat-stream-task",
      });
      for (const part of STREAM_START) send(part);
      for (const part of DELTAS) {
        send(part);
        await sleep(DELTA_INTERVAL_MS);
      }
      for (const part of STREAM_END) send(part);
      send({ type: "done" });
      sent.resolve({ startedAt: startedAt, endedAt: performance.now() });
    });
  });

  await page.goto(`/${projectId}`, { waitUntil: "commit" });
  const agentNode = page.locator(".react-flow__node-agent").first();
  // The canvas renders empty once before its nodes land, so wait before deciding it has none.
  const hasAgent = await agentNode.waitFor({ timeout: AGENT_WAIT_MS }).then(
    () => true,
    () => false,
  );
  if (!hasAgent) {
    test.skip(
      !probeAccount.adminKey,
      "The probe's project has no agent on its canvas; add one with a runtime key, or run against a self-hosted stack (E2E_ADMIN_KEY), which seeds one",
    );
    const stages = run(STACK_ADMIN, "stage:list", {
      projectId: projectId,
    }) as FunctionReturnType<typeof api.stage.list>;
    const stage = stages.find((candidate) => candidate.isDefault);
    if (!stage) throw new Error("The probe's project has no default stage");
    const scope = {
      projectId: projectId as Id<"projects">,
      stageId: stage._id,
    } satisfies FunctionArgs<typeof api.agent.deployments.ensureForStage>;
    run(STACK_ADMIN, "agent/config:create", {
      ...scope,
      name: SEEDED_AGENT,
      position: { x: 0, y: 0 },
    } satisfies FunctionArgs<typeof api.agent.config.create>);
    run(STACK_ADMIN, "agent/deployments:ensureForStage", scope);
    await waitForReady(agentNode);
  }
  await agentNode.click();
  await page.getByRole("tab", { name: "Test" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  const noKey = page.getByText("No runtime key for this stage yet");
  await waitForReady(composer.or(noKey));
  test.skip(
    await noKey.isVisible(),
    "The probe's stage has no runtime key; generate one in the agent's Details tab",
  );
  await composer.fill("Write the long deployment guide.");

  const longTasks = await watchLongTasks(page);
  const commitsFrom = await page.evaluate(() => performance.now());
  await composer.press("Enter");
  const stream = await sent.promise;
  await waitForReady(page.getByText(ANSWER_END));
  const visibleMs = performance.now() - stream.endedAt;
  await page.waitForTimeout(LONG_TASK_SETTLE_MS);
  const tasks = await longTasks.jsonValue();
  const commits = await page.evaluate(
    ({ mark, from }) =>
      performance
        .getEntriesByName(mark)
        .filter((entry) => entry.startTime >= from).length,
    { mark: COMMIT_MARK, from: commitsFrom },
  );
  await context.close();

  const streamMs = stream.endedAt - stream.startedAt;
  const commitBudget = Math.ceil(streamMs / COMMIT_WINDOW_MS) * COMMIT_HEADROOM;
  const longestMs = Math.max(0, ...tasks);
  const result = {
    deltas: DELTAS.length,
    bytes: ANSWER.length,
    streamMs: Math.round(streamMs),
    visibleMs: Math.round(visibleMs),
    commits: commits,
    commitBudget: commitBudget,
    longTasks: tasks.length,
    longestTaskMs: Math.round(longestMs),
    totalLongTaskMs: Math.round(tasks.reduce((sum, ms) => sum + ms, 0)),
  };
  console.log(
    `Chat stream ${new URL(BASE_URL).host} ${JSON.stringify(result)}`,
  );
  await test.info().attach("chat-stream", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  // Paced frames leave no backlog on the browser protocol, so the page's own budget holds.
  expect(
    visibleMs,
    "end of the answer on screen after its last frame",
  ).toBeLessThanOrEqual(PAGE_RENDER_BUDGET_MS);
  expect(longestMs, "longest main-thread task").toBeLessThanOrEqual(
    PERF_BUDGETS["long-task"],
  );
  expect(
    commits,
    `React commits while ${DELTAS.length} deltas streamed over ${Math.round(streamMs)} ms`,
  ).toBeLessThanOrEqual(commitBudget);
});
