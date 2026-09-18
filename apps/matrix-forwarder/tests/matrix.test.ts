/**
 * How a failed client-server call turns into a `MatrixError`. The retry and
 * shutdown decisions in `account.ts` read `status` and `errcode`, so a
 * homeserver or proxy that answers with something other than the documented
 * error object must not throw on the way to those fields.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { MatrixClient, MatrixError, normalizeApiUrl } from "../src/matrix.ts";

const API_URL = "https://matrix.example.org";
const ROOM_ID = "!room:example.org";

const realFetch = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = realFetch;
});

describe("mapping an error response", () => {
  it("reads the errcode and retry delay the homeserver sent", async () => {
    stubFetch(
      429,
      JSON.stringify({
        errcode: "M_LIMIT_EXCEEDED",
        error: "Too many requests",
        retry_after_ms: 2000,
      }),
    );
    const client = new MatrixClient(API_URL, "syt_token");

    const error = await client
      .joinedMembers(ROOM_ID)
      .catch((thrown: unknown): unknown => thrown);

    expect(error).toBeInstanceOf(MatrixError);
    expect(error).toMatchObject({
      errcode: "M_LIMIT_EXCEEDED",
      retryAfterMs: 2000,
      status: 429,
    });
  });

  it("still reports the status when the body is not an error object", async () => {
    // `JSON.parse` accepts all three. None of them carries `errcode`.
    for (const body of ["null", "[]", "<html>502</html>"]) {
      stubFetch(502, body);
      const client = new MatrixClient(API_URL, "syt_token");

      const error = await client
        .joinedMembers(ROOM_ID)
        .catch((thrown: unknown): unknown => thrown);

      expect(error).toBeInstanceOf(MatrixError);
      expect(error).toMatchObject({
        errcode: undefined,
        message: "M_UNKNOWN: HTTP 502",
        status: 502,
      });
    }
  });
});

describe("normalizing a homeserver url", () => {
  it("drops trailing slashes and leaves the rest alone", () => {
    expect(normalizeApiUrl(`${API_URL}//`)).toBe(API_URL);
    expect(normalizeApiUrl(API_URL)).toBe(API_URL);
    expect(normalizeApiUrl(`${API_URL}/_base/`)).toBe(`${API_URL}/_base`);
  });
});

function stubFetch(status: number, body: string): void {
  globalThis.fetch = (async (
    _input: string | URL | Request,
  ): Promise<Response> =>
    new Response(body, { status: status })) as typeof fetch;
}
