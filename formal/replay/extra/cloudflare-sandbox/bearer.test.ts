import { expect, test } from "bun:test";
import { bearerMatches } from "../../../../apps/cloudflare-sandbox/src/bearer.ts";

const API_KEY = "sandbox-key";

// Workers ships this method and Bun does not.
Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value: (left: ArrayBuffer, right: ArrayBuffer): boolean =>
    Buffer.from(left).equals(Buffer.from(right)),
});

function requestWith(authorization: string | undefined): Request {
  return new Request("https://sandbox.example/v1", {
    headers:
      authorization === undefined ? {} : { Authorization: authorization },
  });
}

test.each([
  { authorization: `Bearer ${API_KEY}`, apiKey: API_KEY, expected: true },
  { authorization: "Bearer wrong", apiKey: API_KEY, expected: false },
  { authorization: API_KEY, apiKey: API_KEY, expected: false },
  { authorization: undefined, apiKey: API_KEY, expected: false },
  { authorization: "Bearer ", apiKey: "", expected: false },
])(
  "bearerMatches($authorization, $apiKey) is $expected",
  async ({ authorization, apiKey, expected }): Promise<void> => {
    expect(await bearerMatches(requestWith(authorization), apiKey)).toBe(
      expected,
    );
  },
);
