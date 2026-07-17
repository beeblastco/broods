/** Pagination and error-mapping tests for the Slack channel-directory fetcher. */

import { describe, expect, it } from "vitest";
import {
  fetchSlackChannelDirectory,
  SLACK_DIRECTORY_PAGE_CAP,
  SLACK_DIRECTORY_TOTAL_BUDGET_MS,
} from "../model/slackDirectory";

/** Builds a fetch stub that serves the given responses in order (repeating the last, rebuilt per call since bodies are single-use) and records each requested URL. */
function fetchStub(responses: Array<() => Response | Error>): {
  impl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const factory = responses[Math.min(call, responses.length - 1)];
    call += 1;
    const next = factory ? factory() : new Error("no response configured");
    if (next instanceof Error) throw next;

    return next;
  }) as typeof fetch;

  return { impl: impl, urls: urls };
}

/** JSON 200 response helper for Slack API payloads. */
function slackJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status: status });
}

describe("slack channel directory", () => {
  it("returns channels sorted by name and skips malformed entries", async () => {
    const { impl } = fetchStub([
      () =>
        slackJson({
          ok: true,
          channels: [
            { id: "C2", name: "zeta", is_private: true, is_member: true },
            { id: "C1", name: "alpha" },
            { id: 42, name: "bad-id" },
            { id: "C3" },
            "not-an-object",
          ],
        }),
    ]);
    const result = await fetchSlackChannelDirectory("xoxb-test", impl);
    expect(result).toEqual({
      ok: true,
      truncated: false,
      channels: [
        { id: "C1", name: "alpha", isPrivate: false, isMember: false },
        { id: "C2", name: "zeta", isPrivate: true, isMember: true },
      ],
    });
  });

  it("follows cursors across pages and forwards them to Slack", async () => {
    const { impl, urls } = fetchStub([
      () =>
        slackJson({
          ok: true,
          channels: [{ id: "C1", name: "one" }],
          response_metadata: { next_cursor: "cursor-2" },
        }),
      () => slackJson({ ok: true, channels: [{ id: "C2", name: "two" }] }),
    ]);
    const result = await fetchSlackChannelDirectory("xoxb-test", impl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channels.map((c) => c.id)).toEqual(["C1", "C2"]);
      expect(result.truncated).toBe(false);
    }
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("cursor=cursor-2");
  });

  it("stops at the page cap and reports truncation when a cursor remains", async () => {
    const { impl, urls } = fetchStub([
      () =>
        slackJson({
          ok: true,
          channels: [{ id: "C1", name: "again" }],
          response_metadata: { next_cursor: "more" },
        }),
    ]);
    const result = await fetchSlackChannelDirectory("xoxb-test", impl);
    expect(urls).toHaveLength(SLACK_DIRECTORY_PAGE_CAP);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.truncated).toBe(true);
  });

  it("stops paginating when the total time budget is spent and reports truncation", async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const { impl, urls } = fetchStub([
        () => {
          // Each page consumes over the whole budget, so page 2 never runs.
          now += SLACK_DIRECTORY_TOTAL_BUDGET_MS + 1;

          return slackJson({
            ok: true,
            channels: [{ id: "C1", name: "slow" }],
            response_metadata: { next_cursor: "more" },
          });
        },
      ]);
      const result = await fetchSlackChannelDirectory("xoxb-test", impl);
      expect(urls).toHaveLength(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.truncated).toBe(true);
        expect(result.channels.map((c) => c.id)).toEqual(["C1"]);
      }
    } finally {
      Date.now = realNow;
    }
  });

  it("maps HTTP 429 to a ratelimited result", async () => {
    const { impl } = fetchStub([() => new Response("", { status: 429 })]);
    const result = await fetchSlackChannelDirectory("xoxb-test", impl);
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      reason: "ratelimited",
    });
  });

  it("maps Slack auth and scope errors to their reasons", async () => {
    for (const [slackError, reason] of [
      ["missing_scope", "missing_scope"],
      ["invalid_auth", "invalid_auth"],
      ["token_revoked", "invalid_auth"],
      ["fatal_error", "slack_error"],
    ] as const) {
      const { impl } = fetchStub([
        () => slackJson({ ok: false, error: slackError }),
      ]);
      const result = await fetchSlackChannelDirectory("xoxb-test", impl);
      expect(result).toMatchObject({ ok: false, status: 502, reason: reason });
    }
  });

  it("maps a thrown fetch (timeout / network) to a 502 slack_error", async () => {
    const { impl } = fetchStub([() => new Error("aborted")]);
    const result = await fetchSlackChannelDirectory("xoxb-test", impl);
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      reason: "slack_error",
    });
  });

  it("treats non-JSON and non-object payloads as errors", async () => {
    for (const body of ["not json", JSON.stringify("string-payload")]) {
      const { impl } = fetchStub([() => new Response(body, { status: 200 })]);
      const result = await fetchSlackChannelDirectory("xoxb-test", impl);
      expect(result).toMatchObject({
        ok: false,
        status: 502,
        reason: "slack_error",
      });
    }
  });
});
