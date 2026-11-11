import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac, hkdfSync } from "node:crypto";
import { dns } from "bun";

import { RUN_TOKEN_PREFIX } from "../../../../packages/convex/model/principal.ts";
import { RUNTIME_KEY_PREFIX } from "../../../../packages/convex/model/accountSecrets.ts";
import { resolveBearerAuth } from "../../../../apps/core/src/shared/auth.ts";
import { principalChainLabel } from "../../../../apps/core/src/shared/domain/principal.ts";
import {
  parseJsonBody,
  publicHostFetch,
  resetPublicHostsForTests,
} from "../../../../apps/core/src/shared/http.ts";
import { openRunToken } from "../../../../apps/core/src/shared/run-token.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

type StorageArg = Parameters<typeof setStorageForTests>[0];

const originalFetch = globalThis.fetch;
const originalTicketSecret = process.env.STAGE_TICKET_SECRET;

beforeEach((): void => {
  resetPublicHostsForTests();
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
  resetPublicHostsForTests();
  if (originalTicketSecret === undefined)
    delete process.env.STAGE_TICKET_SECRET;
  else process.env.STAGE_TICKET_SECRET = originalTicketSecret;
  setStorageForTests(null);
  resetStorageForTests();
});

describe("parseJsonBody", (): void => {
  test("reads a blank body as an empty object", (): void => {
    expect(parseJsonBody({ body: "  " })).toEqual({});
  });

  test("names the parse failure", (): void => {
    expect((): unknown => parseJsonBody({ body: "{nope" })).toThrow(
      /^Invalid request JSON: /,
    );
  });
});

describe("publicHostFetch", (): void => {
  test("refuses a name that does not resolve", async (): Promise<void> => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue([]);
    try {
      await expect(
        publicHostFetch("https://nowhere.example.com/v1"),
      ).rejects.toThrow("nowhere.example.com did not resolve");
    } finally {
      lookup.mockRestore();
    }
  });

  test("stops waiting for a lookup once the caller aborts", async (): Promise<void> => {
    const lookup = spyOn(dns, "lookup").mockReturnValue(
      new Promise<never>((): void => {}),
    );
    const controller = new AbortController();
    try {
      const pending = publicHostFetch("https://slow.example.com/v1", {
        signal: controller.signal,
      });
      controller.abort(new Error("caller gave up"));

      await expect(pending).rejects.toThrow("caller gave up");
    } finally {
      lookup.mockRestore();
    }
  });

  test("keeps resolving after the pinned-host table fills", async (): Promise<void> => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4, ttl: 30 },
    ]);
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("ok")) as unknown as typeof fetch;
    try {
      for (let index = 0; index <= 1_024; index += 1) {
        await publicHostFetch(`https://host${index}.example.com/`);
      }
      const response = await publicHostFetch("https://after.example.com/");

      expect(await response.text()).toBe("ok");
    } finally {
      lookup.mockRestore();
    }
  });
});

describe("principalChainLabel", (): void => {
  test("labels an api link by its key kind", (): void => {
    expect(
      principalChainLabel({
        kind: "agent",
        accountId: "acct_1",
        agentId: "agent_1",
        chain: [{ kind: "api", keyKind: "cron" }],
      }),
    ).toBe("api:cron>agent:agent_1");
  });
});

describe("openRunToken", (): void => {
  test("refuses a correctly signed payload that is not JSON", (): void => {
    process.env.STAGE_TICKET_SECRET = "run-token-fixture-secret";
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        "run-token-fixture-secret",
        "",
        "broods-run-token",
        32,
      ),
    );
    const payload = Buffer.from("not json").toString("base64url");
    const signature = createHmac("sha256", key)
      .update(payload)
      .digest()
      .toString("base64url");

    expect(
      openRunToken(`${RUN_TOKEN_PREFIX}${payload}.${signature}`),
    ).toBeNull();
  });
});

describe("resolveBearerAuth", (): void => {
  test("refuses a runtime key no deployment owns", async (): Promise<void> => {
    setStorageForTests({
      agentDeployments: { getByApiKeyHash: async (): Promise<unknown> => null },
    } as unknown as StorageArg);

    expect(
      await resolveBearerAuth({
        authorization: `Bearer ${RUNTIME_KEY_PREFIX}unknown`,
      }),
    ).toBeNull();
  });
});
