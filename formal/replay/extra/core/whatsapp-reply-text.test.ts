import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createWhatsAppChannel } from "../../../../apps/core/src/shared/whatsapp-channel.ts";

const APP_SECRET = "app-secret";
const PHONE = "106540352242922";

const channel = createWhatsAppChannel({
  accessToken: "access-token",
  allowedChannelIds: null,
  allowedUserIds: null,
  appSecret: APP_SECRET,
  phoneNumberId: PHONE,
  verifyToken: "verify-token",
});

async function contentOf(message: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: PHONE,
              },
              contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.9",
                  timestamp: "1713916800",
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
  const parsed = await channel.parse({
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/whatsapp",
    rawQueryString: "",
    headers: { "x-hub-signature-256": signature },
    body: body,
  });
  if (parsed.kind !== "message") return `ignored:${parsed.kind}`;

  return parsed.message.content;
}

describe("a tapped WhatsApp reply carries its label as the message", (): void => {
  test("a quick-reply button", async (): Promise<void> => {
    expect(
      await contentOf({
        type: "button",
        button: { text: "Yes please", payload: "y" },
      }),
    ).toBe("Yes please");
  });

  test("an interactive button reply", async (): Promise<void> => {
    expect(
      await contentOf({
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "b1", title: "Approve" },
        },
      }),
    ).toBe("Approve");
  });

  test("an interactive list row", async (): Promise<void> => {
    expect(
      await contentOf({
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "r1", title: "Row one" },
        },
      }),
    ).toBe("Row one");
  });

  test("a button with no label falls back to the SDK text and is dropped when empty", async (): Promise<void> => {
    expect(await contentOf({ type: "button", button: { payload: "y" } })).toBe(
      "ignored:ignore",
    );
  });
});
