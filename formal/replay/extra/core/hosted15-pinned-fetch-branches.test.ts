import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  guardedFetch,
  isDeniedAddress,
} from "../../../../apps/core/src/harness/isolate/runner/pinned-fetch.mjs";

interface FetchResult {
  status: number;
  bodyText: string;
}

const LOOPBACK = "127.0.0.1";
const seen: Array<Record<string, string | string[] | undefined>> = [];
let target: Server;
let origin: Server;
let targetPort = 0;
let originPort = 0;

function listen(server: Server): Promise<number> {
  return new Promise((resolve): void => {
    server.listen(0, LOOPBACK, (): void => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function fetchLocal(
  url: string,
  init: unknown,
  extra: Record<string, unknown> = {},
): Promise<FetchResult> {
  return (await guardedFetch(url, init, {
    lookup: async (): Promise<Array<{ address: string; family: number }>> => [
      { address: LOOPBACK, family: 4 },
    ],
    allowAddresses: [LOOPBACK],
    ...extra,
  })) as FetchResult;
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }

  return "";
}

beforeAll(async (): Promise<void> => {
  target = createServer((request, response): void => {
    seen.push(request.headers);
    response.end("target");
  });
  targetPort = await listen(target);
  origin = createServer((_request, response): void => {
    response.statusCode = 302;
    response.setHeader("location", `http://${LOOPBACK}:${targetPort}/next`);
    response.end();
  });
  originPort = await listen(origin);
});

afterAll((): void => {
  target.close();
  origin.close();
});

describe("guardedFetch request headers", (): void => {
  test("takes Headers and drops a caller Host", async (): Promise<void> => {
    seen.length = 0;
    const headers = new Headers({ "x-one": "1", host: "evil.test" });
    const result = await fetchLocal(`http://${LOOPBACK}:${targetPort}/`, {
      headers: headers,
    });

    expect(result.bodyText).toBe("target");
    expect(seen[0]?.["x-one"]).toBe("1");
    expect(seen[0]?.host).toBe(`${LOOPBACK}:${targetPort}`);
  });

  test("takes pairs, skipping malformed ones and Host", async (): Promise<void> => {
    seen.length = 0;
    await fetchLocal(`http://${LOOPBACK}:${targetPort}/`, {
      headers: [["x-two", 2], ["bad"], ["Host", "evil.test"]],
    });

    expect(seen[0]?.["x-two"]).toBe("2");
    expect(seen[0]?.host).toBe(`${LOOPBACK}:${targetPort}`);
  });

  test("refuses headers of another type", async (): Promise<void> => {
    expect(
      await messageOf((): Promise<unknown> =>
        fetchLocal(`http://${LOOPBACK}:${targetPort}/`, { headers: 5 }),
      ),
    ).toBe("init headers must be an object, array, or Headers");
  });
});

describe("guardedFetch redirects", (): void => {
  test("drops credential headers when the origin changes", async (): Promise<void> => {
    seen.length = 0;
    const result = await fetchLocal(`http://${LOOPBACK}:${originPort}/`, {
      headers: { authorization: "Bearer t", "x-keep": "k" },
    });

    expect(result.bodyText).toBe("target");
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.["x-keep"]).toBe("k");
  });
});

describe("guardedFetch input checks", (): void => {
  test("refuses a url that is not a string or URL", async (): Promise<void> => {
    expect(
      await messageOf((): Promise<unknown> => fetchLocal(5 as never, {})),
    ).toBe("url must be a string or URL");
  });

  test("refuses a scheme other than http and https", async (): Promise<void> => {
    expect(
      await messageOf((): Promise<unknown> =>
        fetchLocal("ftp://example.test/", {}),
      ),
    ).toBe("only http(s) URLs are supported");
  });

  test("refuses init that is not an object", async (): Promise<void> => {
    expect(
      await messageOf((): Promise<unknown> =>
        fetchLocal("http://example.test/", []),
      ),
    ).toBe("init must be an object");
  });

  test("refuses a host that resolves to nothing", async (): Promise<void> => {
    expect(
      await messageOf((): Promise<unknown> =>
        guardedFetch(
          "http://empty.test/",
          {},
          { lookup: async (): Promise<never[]> => [] },
        ),
      ),
    ).toBe("hostname empty.test did not resolve");
  });
});

describe("isDeniedAddress malformed input", (): void => {
  test("denies an address that is not a dotted quad", (): void => {
    expect(isDeniedAddress("1.2.3")).toBe(true);
    expect(isDeniedAddress("1.2.3.x")).toBe(true);
    expect(isDeniedAddress("1.2.3.999")).toBe(true);
  });
});
