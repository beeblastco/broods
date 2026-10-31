import {
  browserSocketUrl,
  connectBrowser,
  type BrowserAction,
  type BrowserConnection,
  type BrowserConnectionStatus,
} from "../../../packages/broods/src/browser-client.ts";
import { BroodsClient } from "../../../packages/broods/src/client.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  signBrowserTicket,
  signUserToken,
} from "../../../packages/broods/src/user-token.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  pollUntil,
  type VerifyContext,
} from "../harness.ts";

const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION}`;

/** One fake extension: what core asked it to do, and where it stands. */
interface FakeExtension {
  actions: BrowserAction[];
  connection: BrowserConnection;
  statuses: BrowserConnectionStatus[];
}

/**
 * A `scope: "user"` machine sandbox through the edge, the gateway and core:
 * two Bun clients on the SDK's `connectBrowser`, holding tickets for alice and
 * bob, both connect; an extension id the sandbox does not list, a refresh
 * naming another user, and a second socket of the same user are each refused
 * with their close code. With a model key, a run started with alice's user
 * token reads alice's page and never reaches bob's, and the same agent run
 * with the account key, which names no end user, reaches neither. Without one
 * the routing is covered by core's unit tests on the real socket handler.
 */
export async function browserMachine(context: VerifyContext): Promise<void> {
  const project = `browser-machine-${context.runId}`;
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const deployed = await context.measure("deploy browser stage", () =>
    sync.putManifest(
      {
        version: 1,
        project: project,
        stage: "development",
        resources: [
          {
            kind: "sandbox",
            name: "web",
            config: {
              provider: "machine",
              permissionMode: "bypass",
              network: { mode: "allow-all" },
              options: {
                scope: "user",
                allowedExtensionIds: [EXTENSION],
                allowedDomains: ["example.com"],
              },
            },
          },
          {
            kind: "agent",
            name: "reader",
            config: {
              ...context.model,
              agent: {
                system:
                  "Call the browser tool once with action read_page, then reply with exactly the text it returned and nothing else.",
              },
              sandboxes: ["web"],
              publicAccess: true,
            },
          },
        ],
      },
      true,
    ),
  );
  const { deployment } = deployed;
  const agentId = deployed.ids.agents.reader;
  const projectId = deployment?.projectId;
  const stageId = deployment?.stageId;
  assertStep(
    "the deploy returns the stage ids a browser socket names",
    deployment?.apiKey !== undefined &&
      projectId !== undefined &&
      stageId !== undefined &&
      agentId !== undefined,
    JSON.stringify(deployment),
  );
  const rotated = await sync.rotateUserTokenSecret(project, "development");
  assertStep(
    "the stage has a signing secret for tickets",
    rotated?.secret.startsWith("bsig_") === true,
    JSON.stringify(rotated?.hint),
  );
  const secret = rotated.secret;
  const url = browserSocketUrl({
    baseUrl: context.edgeUrl,
    projectId: projectId,
    stageId: stageId,
  });
  const ticket = (userId: string): Promise<string> =>
    signBrowserTicket({ userId: userId, sandbox: "web", secret: secret });

  const alice = extension(url, "alice", ticket);
  const bob = extension(url, "bob", ticket);
  try {
    const connected = await context.measure("browsers connect", () =>
      pollUntil(
        { initialIntervalMs: 50, maxIntervalMs: 250, timeoutMs: 15_000 },
        async (): Promise<true | null> =>
          [alice, bob].every((browser) =>
            browser.statuses.some((status) => status.kind === "connected"),
          )
            ? true
            : null,
      ),
    );
    assertStep(
      "alice's and bob's browsers connect through the gateway with their tickets",
      connected === true,
      JSON.stringify({ alice: alice.statuses, bob: bob.statuses }),
    );

    const otherExtension = await closeCode(
      url,
      await ticket("alice"),
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assertStep(
      "an extension the sandbox does not list is refused with 4403",
      otherExtension === 4403,
      `close ${otherExtension}`,
    );
    const otherUser = await closeCode(
      url,
      await ticket("carol"),
      ORIGIN,
      await ticket("dave"),
    );
    assertStep(
      "a refresh naming another user closes the socket with 4403",
      otherUser === 4403,
      `close ${otherUser}`,
    );

    if (!context.hasModelKey) {
      console.log(`  skip a run driving alice's browser (${MODEL_KEY_HINT})`);
    } else {
      const aliceRun = await context.measure(
        "run as alice",
        async (): Promise<AsyncStatus> =>
          await (
            await new BroodsClient({
              apiKey: deployment.apiKey,
              baseUrl: context.edgeUrl,
              userToken: await signUserToken({
                userId: "alice",
                secret: secret,
              }),
            }).runAsync({
              agentId: agentId,
              conversationKey: `${project}-alice`,
              eventId: `${project}-alice`,
              input: "Read my page.",
            })
          ).wait({ intervalMs: 200, timeoutMs: 120_000 }),
      );
      assertStep(
        "a run with alice's user token reads alice's page and never bob's",
        aliceRun.status === "completed" &&
          JSON.stringify(aliceRun.response ?? "").includes("page of alice") &&
          alice.actions.some((action) => action.action === "read_page") &&
          bob.actions.length === 0,
        JSON.stringify({
          run: aliceRun,
          alice: alice.actions,
          bob: bob.actions,
        }),
      );
      const before = alice.actions.length;
      const anonymous = await context.measure(
        "run with no end user",
        async (): Promise<AsyncStatus> =>
          await (
            await context.client.runAsync({
              agentId: agentId,
              conversationKey: `${project}-nobody`,
              eventId: `${project}-nobody`,
              input: "Read my page.",
            })
          ).wait({ intervalMs: 200, timeoutMs: 120_000 }),
      );
      assertStep(
        "a run that names no end user reaches no browser",
        alice.actions.length === before && bob.actions.length === 0,
        JSON.stringify({ run: anonymous, alice: alice.actions }),
      );
    }

    // Last: alice's newer socket takes her slot, and the SDK stops the old one.
    const replacing = await openSocket(url, await ticket("alice"), ORIGIN);
    const replaced = await pollUntil(
      { initialIntervalMs: 50, maxIntervalMs: 250, timeoutMs: 10_000 },
      async (): Promise<BrowserConnectionStatus | null> =>
        alice.statuses.find((status) => status.kind === "stopped") ?? null,
    );
    replacing.close();
    assertStep(
      "alice's newer socket replaces her older one with 4409",
      replaced?.kind === "stopped" && replaced.code === 4409,
      JSON.stringify(alice.statuses),
    );
  } finally {
    alice.connection.close();
    bob.connection.close();
  }
}

/**
 * The code core closes one raw browser socket with: after its hello, or after
 * a `credential` frame with `refresh` once core says it is ready.
 */
async function closeCode(
  url: string,
  ticket: string,
  origin: string,
  refresh?: string,
): Promise<number> {
  return await new Promise((resolve, reject): void => {
    const socket = rawSocket(url, ticket, origin);
    const timeout = setTimeout((): void => {
      socket.close();
      reject(new Error("core kept the socket open"));
    }, 10_000);
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({
          type: "hello",
          sandbox: "web",
          instance: "raw",
          browser: true,
        }),
      );
    socket.onmessage = (event): void => {
      if (refresh && String(event.data).includes('"ready"')) {
        socket.send(JSON.stringify({ type: "credential", token: refresh }));
      }
    };
    socket.onclose = (event): void => {
      clearTimeout(timeout);
      resolve(event.code);
    };
  });
}

/** A fake extension on the SDK client, answering read_page with its user's page. */
function extension(
  url: string,
  userId: string,
  ticket: (userId: string) => Promise<string>,
): FakeExtension {
  const actions: BrowserAction[] = [];
  const statuses: BrowserConnectionStatus[] = [];
  const connection = connectBrowser({
    url: url,
    getTicket: (): Promise<string> => ticket(userId),
    sandbox: "web",
    instance: `verify-${userId}`,
    onAction: async (action) => {
      actions.push(action);

      return { text: `page of ${userId}` };
    },
    onStatus: (status): void => {
      statuses.push(status);
    },
    // Bun sends no Origin of its own; an extension's is its id.
    createWebSocket: (socketUrl, protocols): WebSocket =>
      rawSocket(socketUrl, undefined, ORIGIN, protocols),
  });

  return { actions: actions, connection: connection, statuses: statuses };
}

/** A raw browser socket that has said hello and been answered ready. */
async function openSocket(
  url: string,
  ticket: string,
  origin: string,
): Promise<WebSocket> {
  return await new Promise((resolve, reject): void => {
    const socket = rawSocket(url, ticket, origin);
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({
          type: "hello",
          sandbox: "web",
          instance: "raw",
          browser: true,
        }),
      );
    socket.onmessage = (): void => resolve(socket);
    socket.onclose = (event): void =>
      reject(new Error(`closed ${event.code} ${event.reason}`));
  });
}

// Bun's WebSocket takes headers, which a browser's does not, so the Origin a
// Chrome extension would send rides here.
function rawSocket(
  url: string,
  ticket: string | undefined,
  origin: string,
  protocols?: string[],
): WebSocket {
  return new WebSocket(url, {
    protocols: protocols ?? ["broods.v1", `broods.token.${ticket ?? ""}`],
    headers: { origin: origin },
  } as unknown as string[]);
}
