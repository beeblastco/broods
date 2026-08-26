"use node";
/**
 * Channel-config validation for the Connectors tab (ticket 20): one real,
 * cheap API call per provider before the card claims success — Telegram
 * getMe, Slack auth.test, Discord GET /users/@me. Providers without a cheap
 * authenticated call (GitHub App JWT, Pancake, Zalo) honestly return
 * "unverified — will verify on first message" instead of fake green.
 * `${ENV}` placeholder secrets can't be validated from here and also return
 * unverified.
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import { authKit } from "./auth";

const result = v.object({
  status: v.union(v.literal("ok"), v.literal("error"), v.literal("unverified")),
  detail: v.string(),
});

type ValidationResult = {
  status: "ok" | "error" | "unverified";
  detail: string;
};

function isEnvPlaceholder(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

async function validateTelegram(
  config: Record<string, unknown>,
): Promise<ValidationResult> {
  const token = typeof config.botToken === "string" ? config.botToken : "";
  if (!token) return { status: "error", detail: "Bot token is missing." };
  if (isEnvPlaceholder(token)) {
    return {
      status: "unverified",
      detail:
        "Token is an environment placeholder — will verify on first message.",
    };
  }
  const apiUrl =
    typeof config.apiUrl === "string" && config.apiUrl.trim()
      ? config.apiUrl.trim().replace(/\/+$/, "")
      : "https://api.telegram.org";
  const response = await fetch(`${apiUrl}/bot${token}/getMe`);
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: { username?: string };
  };
  if (body.ok === true) {
    return {
      status: "ok",
      detail: body.result?.username
        ? `Connected as @${body.result.username}`
        : "Bot token is valid.",
    };
  }

  return {
    status: "error",
    detail:
      body.description ??
      `Telegram rejected the token (HTTP ${response.status}).`,
  };
}

async function validateSlack(
  config: Record<string, unknown>,
): Promise<ValidationResult> {
  const token = typeof config.botToken === "string" ? config.botToken : "";
  if (!token) return { status: "error", detail: "Bot token is missing." };
  if (isEnvPlaceholder(token)) {
    return {
      status: "unverified",
      detail:
        "Token is an environment placeholder — will verify on first message.",
    };
  }
  const apiUrl =
    typeof config.apiUrl === "string" && config.apiUrl.trim()
      ? config.apiUrl.trim().replace(/\/+$/, "")
      : "https://slack.com/api";
  const response = await fetch(`${apiUrl}/auth.test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    user?: string;
    team?: string;
  };
  if (body.ok === true) {
    return {
      status: "ok",
      detail: `Connected as ${body.user ?? "bot"}${body.team ? ` in ${body.team}` : ""}`,
    };
  }

  return {
    status: "error",
    detail: body.error
      ? `Slack rejected the token: ${body.error}`
      : `Slack rejected the token (HTTP ${response.status}).`,
  };
}

async function validateDiscord(
  config: Record<string, unknown>,
): Promise<ValidationResult> {
  const token = typeof config.botToken === "string" ? config.botToken : "";
  if (!token) return { status: "error", detail: "Bot token is missing." };
  if (isEnvPlaceholder(token)) {
    return {
      status: "unverified",
      detail:
        "Token is an environment placeholder — will verify on first message.",
    };
  }
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      username?: string;
    };

    return {
      status: "ok",
      detail: body.username
        ? `Connected as ${body.username}`
        : "Bot token is valid.",
    };
  }

  return {
    status: "error",
    detail: `Discord rejected the token (HTTP ${response.status}).`,
  };
}

export const validateChannel = action({
  args: {
    kind: v.string(),
    config: v.record(v.string(), v.any()),
  },
  returns: result,
  handler: async (ctx, args): Promise<ValidationResult> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    try {
      if (args.kind === "telegram") return await validateTelegram(args.config);
      if (args.kind === "slack") return await validateSlack(args.config);
      if (args.kind === "discord") return await validateDiscord(args.config);
    } catch (err) {
      return {
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // GitHub App (JWT signing), Pancake, Zalo: no cheap authenticated call.
    return {
      status: "unverified",
      detail: "Saved — will verify on first message.",
    };
  },
});
