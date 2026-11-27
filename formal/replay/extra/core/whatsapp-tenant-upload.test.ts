import { afterEach, describe, expect, test } from "bun:test";
import type { ChannelFile } from "../../../../apps/core/src/shared/channels.ts";
import { createWhatsAppChannel } from "../../../../apps/core/src/shared/whatsapp-channel.ts";
import { stubPublicDns } from "../../../../apps/core/tests/helpers/http.ts";

interface Seen {
  url: string;
  authorization: string | null;
  upload: boolean;
}

const originalFetch = globalThis.fetch;
const restoreDns = stubPublicDns();
const seen: Seen[] = [];
let failUpload = false;

function stubGraph(): void {
  const stub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({
      url: url,
      authorization: new Headers(init?.headers).get("authorization"),
      upload: init?.body instanceof FormData,
    });
    if (url.endsWith("/media")) {
      return failUpload
        ? new Response("bad media", { status: 400 })
        : Response.json({ id: "media-1" });
    }

    return Response.json({ messages: [{ id: "wamid.out" }] });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
}

function pdf(): ChannelFile {
  return {
    url: "https://files.example/report.pdf",
    name: "report.pdf",
    mimeType: "application/pdf",
    fetchData: async (): Promise<Buffer> => Buffer.from("%PDF-1.4"),
  };
}

function actions(): ReturnType<
  ReturnType<typeof createWhatsAppChannel>["actions"]
> {
  return createWhatsAppChannel({
    accessToken: "access-token",
    allowedChannelIds: null,
    allowedUserIds: null,
    apiUrl: "https://api.tenant.example",
    appSecret: "app-secret",
    phoneNumberId: "106540352242922",
    verifyToken: "verify-token",
  }).actions({
    eventId: "whatsapp:1",
    conversationKey: "whatsapp:1",
    channelName: "whatsapp",
    content: "hi",
    source: {
      messageId: "wamid.1",
      phoneNumberId: "106540352242922",
      threadId: "whatsapp:106540352242922:15550000000",
      userWaId: "15550000000",
    },
  });
}

afterEach((): void => {
  globalThis.fetch = originalFetch;
  seen.length = 0;
  failUpload = false;
});

describe("a WhatsApp file sent through a tenant apiUrl", (): void => {
  test("uploads the media form, then posts the message, both to the tenant host", async (): Promise<void> => {
    stubGraph();

    await actions().sendFiles!([pdf()], "caption");

    const uploaded = seen.find((entry) => entry.url.endsWith("/media"));
    expect(uploaded?.url).toMatch(/\/106540352242922\/media$/);
    expect(uploaded?.upload).toBe(true);
    expect(uploaded?.authorization).toBe("Bearer access-token");
    expect(seen.at(-1)?.url).toMatch(/\/106540352242922\/messages$/);
    expect(
      seen.every(
        (entry) =>
          entry.url.includes("api.tenant.example") ||
          entry.url.includes("93.184.216.34"),
      ),
    ).toBe(true);
  });

  test("surfaces the tenant's error status when the upload is refused", async (): Promise<void> => {
    stubGraph();
    failUpload = true;

    await expect(actions().sendFiles!([pdf()])).rejects.toThrow(
      "WhatsApp API error: 400 bad media",
    );
    expect(seen.some((entry) => entry.url.endsWith("/messages"))).toBe(false);
  });
});

process.on("exit", restoreDns);
