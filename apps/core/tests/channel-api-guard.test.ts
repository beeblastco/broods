import { afterEach, describe, expect, it } from "bun:test";
import type { ChannelActions, InboundMessage } from "../src/shared/channels.ts";
import { createDiscordChannel } from "../src/shared/discord-channel.ts";
import { createSlackChannel } from "../src/shared/slack-channel.ts";
import { createTelegramChannel } from "../src/shared/telegram-channel.ts";
import { createWhatsAppChannel } from "../src/shared/whatsapp-channel.ts";
import { stubPublicDns } from "./helpers/http.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const TENANT_API_URL = "https://api.tenant.example";

// Every call a channel makes to a tenant `apiUrl` with the bot's credentials.
const TENANT_CALLS: Array<{
  name: string;
  send: (actions: () => ChannelActions) => Promise<void>;
  actions: () => ChannelActions;
}> = [
  {
    name: "discord SDK send",
    actions: (): ChannelActions => discordActions(),
    send: (actions): Promise<void> => actions().sendText("hi"),
  },
  {
    name: "discord direct send",
    actions: (): ChannelActions => discordActions(),
    send: (actions): Promise<void> => actions().sendSticker!("123"),
  },
  {
    name: "slack send",
    actions: (): ChannelActions =>
      createSlackChannel(
        "bot-token",
        "signing-secret",
        null,
        null,
        "eyes",
        TENANT_API_URL,
        async (): Promise<null> => null,
      ).actions(
        message("slack", { teamId: "T1", channelId: "C1", userId: "U1" }),
      ),
    send: (actions): Promise<void> => actions().sendText("hi"),
  },
  {
    name: "telegram send",
    actions: (): ChannelActions =>
      createTelegramChannel(
        "bot-token",
        "hook-secret",
        null,
        null,
        "👀",
        TENANT_API_URL,
      ).actions(
        message("telegram", { chatId: 123, messageId: "5", threadId: "123" }),
      ),
    send: (actions): Promise<void> => actions().sendText("hi"),
  },
  {
    name: "whatsapp send",
    actions: (): ChannelActions =>
      createWhatsAppChannel({
        accessToken: "access-token",
        allowedChannelIds: null,
        allowedUserIds: null,
        apiUrl: TENANT_API_URL,
        appSecret: "app-secret",
        phoneNumberId: "phone-1",
        verifyToken: "verify-token",
      }).actions(
        message("whatsapp", {
          messageId: "wamid.1",
          phoneNumberId: "phone-1",
          threadId: "whatsapp:phone-1:15550000000",
          userWaId: "15550000000",
        }),
      ),
    send: (actions): Promise<void> => actions().sendTyping(),
  },
];

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("tenant channel apiUrl", () => {
  for (const call of TENANT_CALLS) {
    it(`${call.name} refuses a host that resolves to a private address`, async (): Promise<void> => {
      const restoreDns = stubPublicDns("10.0.0.5");
      let requests = 0;
      globalThis.fetch = Object.assign(
        async (): Promise<Response> => {
          requests += 1;

          return Response.json({});
        },
        { preconnect: ORIGINAL_FETCH.preconnect },
      );
      try {
        expect((await refusal(call)).message).toMatch(/private address/);
      } finally {
        restoreDns();
      }

      expect(requests).toBe(0);
    });

    it(`${call.name} refuses a redirect to a private address`, async (): Promise<void> => {
      // The tenant host passes the address check, then redirects inward, to
      // loopback. The pinned request reaches this server for real, so a
      // followed redirect would show up as a second path.
      const paths: string[] = [];
      const server = Bun.serve({
        port: 0,
        fetch: (request): Response => {
          const url = new URL(request.url);
          paths.push(url.pathname);

          return new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${url.port}/internal` },
          });
        },
      });
      const restoreDns = stubPublicDns();
      globalThis.fetch = Object.assign(
        (
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          const url = new URL(input instanceof Request ? input.url : input);
          expect(url.hostname).toBe("93.184.216.34");
          url.protocol = "http:";
          url.host = `127.0.0.1:${server.port}`;

          return ORIGINAL_FETCH(url, init);
        },
        { preconnect: ORIGINAL_FETCH.preconnect },
      );
      try {
        expect(await refusal(call)).toBeInstanceOf(Error);
      } finally {
        restoreDns();
        void server.stop(true);
      }

      expect(paths).toHaveLength(1);
      expect(paths).not.toContain("/internal");
    });
  }
});

function discordActions(): ChannelActions {
  return createDiscordChannel(
    "bot-token",
    "a".repeat(64),
    null,
    null,
    TENANT_API_URL,
  ).actions(message("discord", { applicationId: "app-1", channelId: "C1" }));
}

function message(
  channelName: string,
  source: Record<string, unknown>,
): InboundMessage {
  return {
    eventId: `${channelName}:1`,
    conversationKey: `${channelName}:1`,
    channelName: channelName,
    content: "hi",
    source: source,
  };
}

// The error the send failed with. It must fail: a send that went through is
// the bug these tests exist to catch.
async function refusal(call: (typeof TENANT_CALLS)[number]): Promise<Error> {
  const outcome = await call.send(call.actions).then(
    (): Error => new Error("send went through"),
    (err: unknown): Error =>
      err instanceof Error ? err : new Error("non-Error rejection"),
  );
  expect(outcome.message).not.toBe("send went through");

  return outcome;
}
