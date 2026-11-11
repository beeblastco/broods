/// <reference types="vite/client" />
import { v, type GenericValidator } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { z } from "zod/mini";
import type { Doc } from "../_generated/dataModel";
import {
  agentExtraConfigColumn,
  agentOutputFormatColumn,
} from "../model/agentConfigColumns";
import { AGENT_CONFIG, MODEL_OUTPUT } from "../model/agentRules";
import { assertStoredAgentConfig } from "../model/cliSyncResources";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

type Columns = Partial<
  Pick<Doc<"agentConfigs">, "extraConfig" | "outputFormat">
>;

// The key paths of the production and dev rows on 2026-11-03, placeholders unresolved.
const PRODUCTION_ROW: Columns = {
  extraConfig: {
    mcp: {
      k57mcpserver00000000000000000000: {
        enabled: true,
        headers: { Authorization: "Bearer ${MCP_TOKEN}" },
      },
    },
    model: { maxOutputTokens: 8192, reasoning: "high" },
    provider: {
      custom: {
        apiKey: "${AI_API_KEY}",
        baseURL: "${AI_BASE_URL}",
        name: "ovh",
      },
    },
    publicAccess: true,
  },
};

const DEV_ROW: Columns = {
  extraConfig: {
    channels: {
      discord: { id: "discord", botToken: "${DISCORD_BOT_TOKEN}" },
      github: { id: "github", appId: "${GITHUB_APP_ID}" },
      slack: { id: "slack", botToken: "${SLACK_BOT_TOKEN}" },
      telegram: { id: "telegram", botToken: "${TELEGRAM_BOT_TOKEN}" },
      zalo: { id: "zalo", botToken: "${ZALO_BOT_TOKEN}" },
    },
    hooks: {
      code: [{ hookId: "k57hook0000000000000000000000000", enabled: true }],
    },
    model: { reasoning: "medium" },
    provider: { anthropic: { apiKey: "${ANTHROPIC_API_KEY}" } },
    sandboxes: ["sb_default"],
    scheduler: { enabled: true },
    subagent: { enabled: true },
    workspaces: [{ name: "docs", workspaceId: "ws_docs" }],
  },
};

describe("agentConfigs extraConfig and outputFormat columns", () => {
  test("store every row shape that exists, placeholders included", async () => {
    for (const row of [
      PRODUCTION_ROW,
      DEV_ROW,
      {},
      { outputFormat: { type: "object", schema: { type: "object" } } },
    ]) {
      await expect(insertAgentConfig(row)).resolves.toBeDefined();
    }
  });

  // A branch may carry keys the rules do not list; the top level holds only known branches.
  test("refuse an unknown top-level key", async () => {
    await expect(
      // @ts-expect-error -- the column does not list `sandbox`, a removed branch
      insertAgentConfig({ extraConfig: { sandbox: "sb_default" } }),
    ).rejects.toThrow(/sandbox/);
  });

  // The columns are written by hand so schema.ts loads no zod: a rule change must reach them.
  test("match the shape the config rules give", () => {
    expect(agentExtraConfigColumn).toEqual(
      storedShape(z.strictObject(AGENT_CONFIG.shape)),
    );
    expect(agentOutputFormatColumn).toEqual(storedShape(MODEL_OUTPUT));
  });

  test("a sync refuses the wrong shape with the field path", () => {
    expect(() =>
      assertStoredAgentConfig({ extraConfig: { sandboxes: ["sb_default"] } }),
    ).not.toThrow();
    expect(() =>
      // @ts-expect-error -- a manifest can hold a string where the column wants a list
      assertStoredAgentConfig({ extraConfig: { sandboxes: "sb_default" } }),
    ).toThrow("config.sandboxes must be array, got string");
  });
});

async function insertAgentConfig(columns: Columns): Promise<string> {
  const t = convexTest(schema, modules);

  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "demo",
      slug: "demo",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return await ctx.db.insert("agentConfigs", {
      authId: "auth_owner",
      name: "agent",
      projectId: projectId,
      stageId: stageId,
      ...columns,
      updatedAt: now,
    });
  });
}

function storedLiteral(
  values: ReadonlySet<unknown> | undefined,
): GenericValidator {
  if (!values || ![...values].every((value) => typeof value === "string"))
    throw new Error("only string literals have a stored Convex shape");

  return v.string();
}

// Enum keys stay a closed object, as zod refuses any other key; free keys stay a record.
function storedRecord(schema: z.core.$ZodRecord): GenericValidator {
  const { keyType, valueType } = schema._zod.def;
  const value = storedShape(valueType);
  const keys = (
    keyType instanceof z.core.$ZodPipe ? keyType._zod.def.out : keyType
  )._zod.values;

  return keys
    ? v.object(
        Object.fromEntries(
          [...keys].map((key) => [String(key), v.optional(value)]),
        ),
      )
    : v.record(v.string(), value);
}

function storedShape(schema: z.core.$ZodType): GenericValidator {
  if (schema instanceof z.core.$ZodString) return v.string();
  if (schema instanceof z.core.$ZodNumber) return v.number();
  if (schema instanceof z.core.$ZodBoolean) return v.boolean();
  if (schema instanceof z.core.$ZodUnknown) return v.any();
  if (schema instanceof z.core.$ZodLiteral || schema instanceof z.core.$ZodEnum)
    return storedLiteral(schema._zod.values);
  if (
    schema instanceof z.core.$ZodOptional ||
    schema instanceof z.core.$ZodCatch
  )
    return storedShape(schema._zod.def.innerType);
  if (schema instanceof z.core.$ZodNullable)
    return v.union(storedShape(schema._zod.def.innerType), v.null());
  if (schema instanceof z.core.$ZodArray)
    return v.array(storedShape(schema._zod.def.element));
  if (schema instanceof z.core.$ZodPipe) {
    const { in: input, out } = schema._zod.def;

    return storedShape(out instanceof z.core.$ZodTransform ? input : out);
  }
  if (schema instanceof z.core.$ZodUnion)
    return storedUnion(schema._zod.def.options.map(storedShape));
  if (schema instanceof z.core.$ZodRecord) return storedRecord(schema);
  if (schema instanceof z.core.$ZodObject) {
    const { catchall, shape } = schema._zod.def;
    if (catchall instanceof z.core.$ZodUnknown)
      return v.record(v.string(), v.any());

    return v.object(
      Object.fromEntries(
        Object.entries(shape).map(
          ([key, field]): [string, GenericValidator] => [
            key,
            field instanceof z.core.$ZodOptional
              ? v.optional(storedShape(field._zod.def.innerType))
              : storedShape(field),
          ],
        ),
      ),
    );
  }

  throw new Error(
    `a ${schema._zod.def.type} schema has no stored Convex shape`,
  );
}

function storedUnion(members: GenericValidator[]): GenericValidator {
  const unique = [
    ...new Map(
      members.map((member) => [JSON.stringify(member), member]),
    ).values(),
  ];

  const [only, ...others] = unique;

  return only && others.length === 0 ? only : v.union(...unique);
}
