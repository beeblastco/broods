import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Any accidental network dependency is a failing test, including import-time calls.
globalThis.fetch = (() => {
  throw new Error("config replay forbids network");
}) as typeof fetch;
const rules = await import("../../packages/convex/model/agentRules.ts");
const codec = await import("../../packages/convex/model/agentConfigCodec.ts");
const env = await import("../../packages/convex/model/envRefs.ts");
const api = await import("../../packages/convex/model/apiError.ts");
const client = await import("../../packages/convex/model/clientError.ts");
const stored = await import("../../packages/convex/model/storedJson.ts");
const schema = await import("../../packages/convex/model/inputSchema.ts");
const config = await import("../../packages/convex/model/configValues.ts");
const envelope = await import("../../packages/convex/model/envelope.ts");
const objects = await import("../../packages/convex/model/objects.ts");
const http = await import("../../packages/convex/model/httpJson.ts");
const mounts = await import("../../packages/convex/model/sandboxMounts.ts");
const request = await import("../../packages/convex/model/requestId.ts");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Vector {
  kind: string;
  input: Json;
  expected: Json;
}
const generated = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["config"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  },
);
if (generated.status !== 0)
  throw new Error(generated.stderr || generated.stdout);
const vectors = generated.stdout
  .trim()
  .split("\n")
  .map((line): Vector => JSON.parse(line) as Vector);
if (vectors.length === 0) throw new Error("no config vectors");

test.each(
  vectors.map((vector, index): [string, Vector] => [
    `${index} ${vector.kind} ${JSON.stringify(vector.input).slice(0, 80)}`,
    vector,
  ]),
)("%s", async (_name: string, vector: Vector): Promise<void> => {
  expect(await replay(vector)).toEqual(vector.expected);
});

function failure(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
}

async function replay(v: Vector): Promise<unknown> {
  const s = v.input as string;
  switch (v.kind) {
    case "env":
      return {
        nameError: failure((): void => codec.assertEnvVarName(s)),
        only: env.ACCOUNT_ENV_REFS_ONLY_PATTERN.test(s),
        header: env.CREDENTIAL_HEADER_VALUE_PATTERN.test(s),
        single: env.ACCOUNT_ENV_REF_PATTERN.test(s),
        names: [...codec.collectEnvPlaceholderNames(s)],
      };
    case "request": {
      const result = request.resolveRequestId(s);
      return result === s ? result : "fresh";
    }
    case "private":
      return rules.isPrivateHostname(s);
    case "toolName":
      return rules.isProviderToolName(s);
    case "stored":
      return {
        object: stored.parseOr(
          stored.configObject,
          v.input,
          "fallback" as never,
        ),
        strings: stored.parseOr(
          stored.stringValues,
          v.input,
          "fallback" as never,
        ),
      };
    case "primitive":
      return {
        positive: unroot(
          failure(() =>
            schema.parseInput(schema.positiveInteger(2), v.input, "root"),
          ),
        ),
        nonempty: unroot(
          failure(() =>
            schema.parseInput(schema.nonEmptyString, v.input, "root"),
          ),
        ),
      };
    case "api": {
      const input = v.input as { status: number; code: string | null };
      return api.apiErrorBody(input.status, "message ${TOKEN}", {
        ...(input.code !== null ? { code: input.code } : {}),
        param: "field",
      });
    }
    case "client": {
      const input = v.input as {
        genuine: boolean;
        data: { code: string; message: string };
      };
      return client.clientErrorData(
        input.genuine
          ? new client.ClientError(
              input.data.message,
              input.data.code as keyof typeof client.CLIENT_ERROR_STATUS,
            )
          : input.data,
      );
    }
    case "merge": {
      const input = v.input as { old: Json; patch: Json };
      return config.mergeConfigObjects(
        input.old as object,
        input.patch as object,
      );
    }
    case "envelope": {
      const cipher = new envelope.AccountCipher(
        "tenant",
        [],
        [
          { keyId: "old", kekId: "", wrappedKey: "" },
          { keyId: "retired", kekId: "", wrappedKey: "", retiredAt: 1 },
          { keyId: "x", kekId: "", wrappedKey: "" },
        ],
      );
      return {
        keyId: cipher.keyId,
        hasKey: cipher.hasKey({ ciphertext: s }),
        needsRewrite: cipher.needsRewrite({ ciphertext: s }),
      };
    }
    case "canonical": {
      const input = v.input as {
        base_url: string | null;
        baseURL: string | null;
      };
      const settings = {
        ...(input.base_url !== null ? { base_url: input.base_url } : {}),
        ...(input.baseURL !== null ? { baseURL: input.baseURL } : {}),
      };
      const result = rules.normalizeAgentConfig({
        provider: { openai: settings },
      }).provider?.openai;
      return {
        base_url: result?.base_url ?? null,
        baseURL: result?.baseURL ?? null,
      };
    }
    case "url": {
      const [protocol, host] = v.input as string[];
      return (
        failure(() =>
          rules.assertPublicHttpsUrl(`${protocol}//${host}`, "url"),
        )?.replace(/^url /, "") ?? null
      );
    }
    case "requestHeader":
      return request
        .withRequestId(
          new Response("body", { status: 201, headers: { "x-request-id": s } }),
          "fresh",
        )
        .headers.get("x-request-id");
    case "remap":
      return objects.remapKeys(
        v.input !== null &&
          typeof v.input === "object" &&
          !Array.isArray(v.input)
          ? v.input
          : {},
        { x: "renamed", constructor: "other" },
      );
    case "codecFragment":
      return codec.toNestedAgentConfig(
        v.input as { maxTurns: number; systemPrompt: string },
      );
    case "providerSettings": {
      try {
        return {
          ok: rules.normalizeAgentConfig({ provider: { openai: v.input } })
            .provider?.openai,
        };
      } catch (error) {
        if (error instanceof Error) return { error: error.message };
        throw error;
      }
    }
    case "tools": {
      try {
        return { ok: rules.normalizeAgentConfig({ tools: v.input }).tools };
      } catch (error) {
        if (error instanceof Error) return { error: error.message };
        throw error;
      }
    }
    case "defaultSandbox":
      return rules.defaultSandboxOf({ sandboxes: v.input }) ?? null;
    case "objects":
      return JSON.parse(objects.stableJson(v.input)) as Json;
    case "rate":
      return http.rateLimitHeaders(100, v.input as number);
    case "method":
      return await http.methodNotAllowed(v.input as string[]).json();
    case "mount":
      return (
        mounts.findLaterSandboxMount(v.input as string[], [
          { name: "first", workspaceId: "w1", sandbox: "a" },
          { name: "second", workspaceId: "w2", sandbox: "b" },
        ]) ?? null
      );
    default:
      throw new Error(`unknown ${v.kind}`);
  }
}

function unroot(error: string | null): string | null {
  return error?.replace(/^root /, "") ?? null;
}

test("G701 envelope accepts already resolved material without inspecting it", async (): Promise<void> => {
  const keys = [
    await envelope.createWrappedAccountKey("tenant", ["offline-test-key"]),
  ];
  const cipher = new envelope.AccountCipher(
    "tenant",
    ["offline-test-key"],
    keys,
  );
  const value = { apiKey: "resolved-secret", ref: "${TOKEN}" };
  const sealed = await cipher.encrypt("agents:encryptedConfig", value);
  expect(await cipher.decrypt("agents:encryptedConfig", sealed)).toEqual(value);
  expect(
    await cipher.decrypt("agents:encryptedSourceConfig", sealed),
  ).toBeNull();
});

test("G703 unknown config branches ending in url are retained", (): void => {
  expect(rules.normalizeAgentConfig({ otherUrl: "http://127.0.0.1/" })).toEqual(
    { otherUrl: "http://127.0.0.1/" },
  );
});

test("G704 nested codec drops unrecognised root branches", (): void => {
  expect(
    codec.toNestedAgentConfig(
      codec.fromNestedAgentConfig({ other: "${TOKEN}" }),
    ),
  ).toEqual({});
});
