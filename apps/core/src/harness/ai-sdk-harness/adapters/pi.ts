import {
  VERSION,
  createPi,
  type PiHarnessSettings,
  type PiSessionStorage,
} from "@ai-sdk/harness-pi";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { HarnessV1AuthenticationEnvironment } from "@ai-sdk/harness";
import { MAX_HARNESS_SESSION_ENTRY_BYTES } from "@broods/convex/model/harnessSessionEntries";
import type { HarnessSessionEntry } from "../../../shared/convex/runtime.ts";
import type {
  AgentConfig,
  AgentProviderSettings,
} from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveGatewayAuthEnv,
  resolveHarnessProviderBaseUrl,
} from "../provider.ts";

export const PI_HARNESS_VERSION = VERSION;

const TRIMMED_TEXT_CHARACTERS = 8_192;

type PiSessionEntry = Parameters<PiSessionStorage["append"]>[0]["entry"];
type PiEntryData = PiSessionEntry["data"];
type PiContentPart = Exclude<
  Extract<PiEntryData, { type: "custom_message" }>["content"],
  string
>[number];

/** Pi's session log for one turn: Pi appends here, and the checkpoint save carries `take()`. */
export interface PiSessionLog {
  storage: PiSessionStorage;
  take: () => HarnessSessionEntry[];
}

export function createConfiguredPiAdapter(
  agentConfig: AgentConfig,
  sessionStorage?: PiSessionStorage,
): HarnessAgentAdapter {
  const providerName = requireHarnessProviderName(agentConfig);
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  const reasoning = agentConfig.model?.reasoning;
  const thinkingLevel =
    reasoning === "none"
      ? "off"
      : reasoning === "minimal" ||
          reasoning === "low" ||
          reasoning === "medium" ||
          reasoning === "high" ||
          reasoning === "xhigh"
        ? reasoning
        : undefined;

  return createPi({
    auth:
      providerName === "vercel"
        ? resolveGatewayAuthEnv(provider)
        : resolvePrefixedAuthEnv(providerName, provider),
    thinkingLevel: thinkingLevel,
    ...(sessionStorage ? { sessionStorage: sessionStorage } : {}),
  });
}

export function createPiAdapter(
  settings?: PiHarnessSettings,
): HarnessAgentAdapter {
  return createPi(settings);
}

// Appends wait for the checkpoint save, so entries and the leaf id they lead to land together.
export function createPiSessionLog(
  read: (sessionId: string) => Promise<HarnessSessionEntry[]>,
): PiSessionLog {
  let pending: HarnessSessionEntry[] = [];
  const append = (entries: ReadonlyArray<PiSessionEntry>): void => {
    for (const entry of entries) {
      pending.push({
        entryId: entry.entryId,
        parentEntryId: entry.parentEntryId,
        version: entry.version,
        entry: fitPiEntry(entry),
      });
    }
  };

  return {
    storage: {
      append: async ({ entry }): Promise<void> => append([entry]),
      appendMany: async ({ entries }): Promise<void> => append(entries),
      read: async ({ sessionId }): Promise<PiSessionEntry[]> =>
        (await read(sessionId)).map((row): PiSessionEntry => ({
          entryId: row.entryId,
          parentEntryId: row.parentEntryId,
          version: row.version,
          // Pi validates every entry it reads back.
          data: JSON.parse(row.entry) as PiEntryData,
        })),
    },
    take: (): HarnessSessionEntry[] => {
      const taken = pending;
      pending = [];

      return taken;
    },
  };
}

// An image can reach 4.5 MB in Pi; over the cap the stored copy drops its biggest parts first.
function fitPiEntry(entry: PiSessionEntry): string {
  const serialized = JSON.stringify(entry.data);
  if (utf8Bytes(serialized) <= MAX_HARNESS_SESSION_ENTRY_BYTES) {
    return serialized;
  }
  const data = structuredClone(entry.data);
  const content = trimmableContent(data) ?? [];
  const largest = content
    .map((part, index) => ({
      bytes: partBytes(part),
      index: index,
      part: part,
    }))
    .sort((left, right): number => right.bytes - left.bytes);
  for (const { bytes, index, part } of largest) {
    content[index] = trimPart(part, bytes);
    const trimmed = JSON.stringify(data);
    if (utf8Bytes(trimmed) <= MAX_HARNESS_SESSION_ENTRY_BYTES) {
      return trimmed;
    }
  }
  throw new Error(
    `Pi session entry ${entry.entryId} is ${utf8Bytes(serialized)} bytes; the session history limit is ${MAX_HARNESS_SESSION_ENTRY_BYTES}`,
  );
}

function partBytes(part: PiContentPart): number {
  return part.type === "image" ? part.data.length : utf8Bytes(part.text);
}

// Pi registers a provider per <PREFIX>_API_KEY/_BASE_URL pair: a custom endpoint keeps its label.
function resolvePrefixedAuthEnv(
  providerName: string,
  provider: AgentProviderSettings,
): HarnessV1AuthenticationEnvironment {
  const baseUrl = resolveHarnessProviderBaseUrl(provider);
  const prefix =
    providerName === "custom"
      ? (provider.name ?? "custom").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()
      : providerName.toUpperCase();

  return {
    [`${prefix}_API_KEY`]: provider.apiKey!,
    ...(baseUrl ? { [`${prefix}_BASE_URL`]: baseUrl } : {}),
  };
}

function trimPart(part: PiContentPart, bytes: number): PiContentPart {
  const note = `[${Math.ceil(bytes / 1_024)} KiB ${part.type} cut: over the session history limit]`;

  return part.type === "image"
    ? { type: "text", text: note }
    : {
        ...part,
        text: `${part.text.slice(0, TRIMMED_TEXT_CHARACTERS)}\n${note}`,
      };
}

function trimmableContent(data: PiEntryData): PiContentPart[] | undefined {
  const content =
    data.type === "custom_message"
      ? data.content
      : data.type === "message" &&
          (data.message.role === "user" || data.message.role === "toolResult")
        ? data.message.content
        : undefined;

  return Array.isArray(content) ? content : undefined;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
