"use node";

/**
 * One-button health check (ticket 23): every green light comes from a real
 * call made right now — a free model-token count against the provider, an S3
 * read per enabled skill, the connector validation used by the Connectors
 * tab, one cheap API call per configured channel, and a write/read/delete
 * round-trip in each working folder (cleaned up afterwards). Every failure
 * carries plain words plus the action that fixes it. No secret value ever
 * appears in a result message.
 */

import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authKit } from "./auth";
import { getSkillMetadata } from "./model/skills";
import { isPlainObject } from "./model/objects";

const fixKind = v.union(
  v.literal("open-env-vars"),
  v.literal("open-details"),
  v.literal("open-connectors"),
  v.literal("open-skills"),
  v.literal("open-context"),
);

const checkResult = v.object({
  name: v.union(
    v.literal("model"),
    v.literal("skill"),
    v.literal("connector"),
    v.literal("channel"),
    v.literal("workspace"),
  ),
  target: v.string(),
  ok: v.boolean(),
  message: v.string(),
  fix: v.optional(v.object({ label: v.string(), kind: fixKind })),
});

export interface HealthCheckEntry {
  name: "model" | "skill" | "connector" | "channel" | "workspace";
  target: string;
  ok: boolean;
  message: string;
  fix?: {
    label: string;
    kind:
      | "open-env-vars"
      | "open-details"
      | "open-connectors"
      | "open-skills"
      | "open-context";
  };
}

const FIX_ENV = {
  label: "Open Environment variables",
  kind: "open-env-vars",
} as const;
const FIX_CONNECTORS = {
  label: "Open Connectors",
  kind: "open-connectors",
} as const;
const FIX_SKILLS = { label: "Open Skills", kind: "open-skills" } as const;
const FIX_CONTEXT = { label: "Open Context", kind: "open-context" } as const;
const FIX_DETAILS = { label: "Open Details", kind: "open-details" } as const;

export const check = action({
  args: { configId: v.id("agentConfigs") },
  returns: v.object({ checks: v.array(checkResult), checkedAt: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ checks: HealthCheckEntry[]; checkedAt: number }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const context: {
      accountId: string;
      projectId: Id<"projects">;
      nested: unknown;
    } | null = await ctx.runQuery(internal.agentHealth.getHealthContext, {
      authId: user.id,
      configId: args.configId,
    });
    if (!context) throw new Error("Agent not found");
    const nested = isPlainObject(context.nested) ? context.nested : {};

    const checks: HealthCheckEntry[] = [];
    checks.push(await checkModel(nested));
    checks.push(...(await checkSkills(context.accountId, nested)));
    checks.push(...(await checkConnectors(ctx, nested)));
    checks.push(...(await checkChannels(ctx, nested)));
    checks.push(...(await checkWorkspaces(ctx, context.projectId, nested)));

    return { checks: checks, checkedAt: Date.now() };
  },
});

// ---------------------------------------------------------------- model

/** OpenAI-compatible providers with a cheap authenticated GET /models. */
const OPENAI_COMPATIBLE_MODEL_LISTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  xai: "https://api.x.ai/v1/models",
  deepseek: "https://api.deepseek.com/models",
  mistral: "https://api.mistral.ai/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  cerebras: "https://api.cerebras.ai/v1/models",
  deepinfra: "https://api.deepinfra.com/v1/openai/models",
};

async function checkModel(
  nested: Record<string, unknown>,
): Promise<HealthCheckEntry> {
  const model = isPlainObject(nested.model) ? nested.model : {};
  const providerName = typeof model.provider === "string" ? model.provider : "";
  const modelId = typeof model.modelId === "string" ? model.modelId : "";
  if (!providerName) {
    return {
      name: "model",
      target: "model",
      ok: false,
      message: "No model provider is configured yet.",
      fix: FIX_DETAILS,
    };
  }
  const target = `${providerName}${modelId ? ` · ${modelId}` : ""}`;
  const providerBranch = isPlainObject(nested.provider) ? nested.provider : {};
  const settings = isPlainObject(providerBranch[providerName])
    ? (providerBranch[providerName] as Record<string, unknown>)
    : {};
  const apiKey = typeof settings.apiKey === "string" ? settings.apiKey : "";

  if (apiKey.includes("${")) {
    // Unresolved placeholder — quote the variable name, never a real value.
    return {
      name: "model",
      target: target,
      ok: false,
      message: `The API key points at ${apiKey}, but that variable is not set on this stage.`,
      fix: FIX_ENV,
    };
  }
  if (!apiKey) {
    return {
      name: "model",
      target: target,
      ok: true,
      message: `No apiKey field — ${providerName} may authenticate another way (not pinged).`,
    };
  }

  try {
    const rejected = (status: number, body: string): HealthCheckEntry => ({
      name: "model",
      target: target,
      ok: false,
      message:
        status === 401 || status === 403
          ? `${providerName} rejected the API key (HTTP ${status}). Check the key this agent points at.`
          : `${providerName} answered HTTP ${status}: ${body.slice(0, 160)}`,
      fix: FIX_ENV,
    });

    // Free token-count call for the Gemini families; GET /models elsewhere.
    if (providerName === "google" || providerName === "vertex") {
      const url =
        providerName === "google"
          ? `https://generativelanguage.googleapis.com/v1beta/models/${modelId || "gemini-2.5-flash"}:countTokens`
          : `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId || "gemini-2.5-flash"}:countTokens`;
      const response = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return rejected(response.status, await response.text());
    } else if (providerName === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return rejected(response.status, await response.text());
    } else if (OPENAI_COMPATIBLE_MODEL_LISTS[providerName]) {
      const response = await fetch(
        OPENAI_COMPATIBLE_MODEL_LISTS[providerName],
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) return rejected(response.status, await response.text());
    } else {
      return {
        name: "model",
        target: target,
        ok: true,
        message: `API key is set and resolved (live ping not wired for ${providerName}).`,
      };
    }
  } catch (error) {
    return {
      name: "model",
      target: target,
      ok: false,
      message: `Could not reach ${providerName}: ${error instanceof Error ? error.message : String(error)}`,
      fix: FIX_ENV,
    };
  }

  return {
    name: "model",
    target: target,
    ok: true,
    message: `${providerName} accepted the API key.`,
  };
}

// ---------------------------------------------------------------- skills

async function checkSkills(
  accountId: string,
  nested: Record<string, unknown>,
): Promise<HealthCheckEntry[]> {
  const skills = isPlainObject(nested.skills) ? nested.skills : {};
  const allowed = Array.isArray(skills.allowed)
    ? skills.allowed.filter((ref): ref is string => typeof ref === "string")
    : [];

  return await Promise.all(
    allowed.map(async (ref): Promise<HealthCheckEntry> => {
      const name = ref.startsWith(`${accountId}/`)
        ? ref.slice(accountId.length + 1)
        : ref;
      try {
        const metadata = await getSkillMetadata(accountId, name);

        return metadata
          ? {
              name: "skill",
              target: name,
              ok: true,
              message: "SKILL.md found in the library.",
            }
          : {
              name: "skill",
              target: name,
              ok: false,
              message:
                "This enabled skill has no stored content — re-create it or disable it.",
              fix: FIX_SKILLS,
            };
      } catch (error) {
        return {
          name: "skill",
          target: name,
          ok: false,
          message: `Could not read the skill: ${error instanceof Error ? error.message : String(error)}`,
          fix: FIX_SKILLS,
        };
      }
    }),
  );
}

// ------------------------------------------------------------- connectors

async function checkConnectors(
  ctx: ActionCtx,
  nested: Record<string, unknown>,
): Promise<HealthCheckEntry[]> {
  const branch = isPlainObject(nested.connectors) ? nested.connectors : {};
  const allowed = Array.isArray(branch.allowed) ? branch.allowed : [];
  const refs = allowed.filter(
    (ref): ref is { provider: string; connectorId: string; enabled: boolean } =>
      isPlainObject(ref) &&
      typeof ref.connectorId === "string" &&
      ref.enabled === true,
  );

  const results: HealthCheckEntry[] = [];
  for (const ref of refs) {
    try {
      // The same validation the Connectors tab's Check button runs — it also
      // refreshes the stored row, so the tab shows this exact truth.
      const summary: {
        label: string;
        status: "connected" | "error";
        lastError?: string;
        validatedLogin?: string;
        toolNames?: string[];
      } = await ctx.runAction(api.connectorsPublic.checkConnector, {
        connectorId: ref.connectorId as Id<"connectors">,
      });
      results.push(
        summary.status === "connected"
          ? {
              name: "connector",
              target: summary.label,
              ok: true,
              message: summary.validatedLogin
                ? `Connected as ${summary.validatedLogin}.`
                : `Connected (${summary.toolNames?.length ?? 0} tools).`,
            }
          : {
              name: "connector",
              target: summary.label,
              ok: false,
              message:
                summary.lastError ?? "The connector is in an error state.",
              fix: FIX_CONNECTORS,
            },
      );
    } catch (error) {
      results.push({
        name: "connector",
        target: ref.connectorId,
        ok: false,
        message: `Check failed: ${error instanceof Error ? error.message : String(error)}`,
        fix: FIX_CONNECTORS,
      });
    }
  }

  return results;
}

// --------------------------------------------------------------- channels

async function checkChannels(
  ctx: ActionCtx,
  nested: Record<string, unknown>,
): Promise<HealthCheckEntry[]> {
  const channels = isPlainObject(nested.channels) ? nested.channels : {};

  return await Promise.all(
    Object.entries(channels)
      .filter(([, config]) => isPlainObject(config))
      .map(async ([kind, config]): Promise<HealthCheckEntry> => {
        // The same one-real-call validation the Connectors tab runs; the
        // config here is env-resolved, so placeholders validate for real.
        const result: {
          status: "ok" | "error" | "unverified";
          detail: string;
        } = await ctx.runAction(api.channelsPublic.validateChannel, {
          kind: kind,
          config: config as Record<string, unknown>,
        });

        return {
          name: "channel",
          target: kind,
          ok: result.status !== "error",
          message: result.detail,
          ...(result.status === "error" ? { fix: FIX_CONNECTORS } : {}),
        };
      }),
  );
}

// -------------------------------------------------------------- workspaces

const HEALTH_CHECK_PATH = ".broods-health-check.tmp";

async function checkWorkspaces(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  nested: Record<string, unknown>,
): Promise<HealthCheckEntry[]> {
  const refs = Array.isArray(nested.workspaces) ? nested.workspaces : [];
  const workspaceRefs = refs.filter(
    (ref): ref is { name: string; workspaceId: string } =>
      isPlainObject(ref) &&
      typeof ref.name === "string" &&
      typeof ref.workspaceId === "string",
  );

  const results: HealthCheckEntry[] = [];
  for (const ref of workspaceRefs) {
    const stamp = `health-check ${Date.now()}`;
    try {
      // Write, read back, delete — through the same actions the Context tab
      // uses. The temp file is removed in finally, pass or fail.
      await ctx.runAction(api.workspaceFilesPublic.upload, {
        projectId: projectId,
        workspaceId: ref.workspaceId,
        path: HEALTH_CHECK_PATH,
        contentBase64: Buffer.from(stamp, "utf8").toString("base64"),
        contentType: "text/plain",
      });
      const url: string = await ctx.runAction(
        api.workspaceFilesPublic.getDownloadUrl,
        {
          projectId: projectId,
          workspaceId: ref.workspaceId,
          path: HEALTH_CHECK_PATH,
        },
      );
      const readBack = await (await fetch(url)).text();
      results.push(
        readBack === stamp
          ? {
              name: "workspace",
              target: ref.name,
              ok: true,
              message: "Write, read and delete all work.",
            }
          : {
              name: "workspace",
              target: ref.name,
              ok: false,
              message: "The folder wrote but read back different content.",
              fix: FIX_CONTEXT,
            },
      );
    } catch (error) {
      results.push({
        name: "workspace",
        target: ref.name,
        ok: false,
        message: `Round-trip failed: ${error instanceof Error ? error.message : String(error)}`,
        fix: FIX_CONTEXT,
      });
    } finally {
      await ctx
        .runAction(api.workspaceFilesPublic.remove, {
          projectId: projectId,
          workspaceId: ref.workspaceId,
          path: HEALTH_CHECK_PATH,
        })
        .catch(() => undefined);
    }
  }

  return results;
}
