import {
  VERSION,
  createPi,
  type PiHarnessSettings,
  type PiSessionStorage,
} from "@ai-sdk/harness-pi";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { HarnessV1AuthenticationEnvironment } from "@ai-sdk/harness";
import {
  harnessEntryBytes,
  MAX_HARNESS_SESSION_ENTRY_BYTES,
} from "@broods/convex/model/harnessSessionEntries";
import { truncateText } from "../../sandbox/utils.ts";
import {
  ATTACHMENT_NOT_RETAINED,
  type HarnessEntryLog,
} from "../../session.ts";
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

// Per string, when an entry is over the cap; the Convex save refuses what still is.
const TRIMMED_TEXT_BYTES = 32 * 1_024;

type PiSessionEntry = Parameters<PiSessionStorage["append"]>[0]["entry"];
type PiEntryData = PiSessionEntry["data"];
type PiMessage = Extract<PiEntryData, { type: "message" }>["message"];
type PiAssistantPart = Extract<
  PiMessage,
  { role: "assistant" }
>["content"][number];
type PiJsonValue = Extract<
  PiAssistantPart,
  { type: "toolCall" }
>["arguments"][string];
type PiMediaPart = Exclude<
  Extract<PiEntryData, { type: "custom_message" }>["content"],
  string
>[number];

export function createConfiguredPiAdapter(
  agentConfig: AgentConfig,
  session?: HarnessEntryLog,
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
    ...(session ? { sessionStorage: createPiSessionStorage(session) } : {}),
  });
}

export function createPiAdapter(
  settings?: PiHarnessSettings,
): HarnessAgentAdapter {
  return createPi(settings);
}

// Appends wait in the Broods session for its checkpoint save, which carries them.
export function createPiSessionStorage(
  session: HarnessEntryLog,
): PiSessionStorage {
  const append = (entries: ReadonlyArray<PiSessionEntry>): void => {
    session.appendHarnessSessionEntries(
      entries.map((entry): HarnessSessionEntry => ({
        entryId: entry.entryId,
        parentEntryId: entry.parentEntryId,
        version: entry.version,
        entry: fitPiEntry(entry.data),
      })),
    );
  };

  return {
    append: async ({ entry }): Promise<void> => append([entry]),
    appendMany: async ({ entries }): Promise<void> => append(entries),
    read: async ({ sessionId }): Promise<PiSessionEntry[]> =>
      (await session.readHarnessSessionEntries(sessionId)).map(
        (row): PiSessionEntry => ({
          entryId: row.entryId,
          parentEntryId: row.parentEntryId,
          version: row.version,
          // Pi validates every entry it reads back.
          data: JSON.parse(row.entry) as PiEntryData,
        }),
      ),
  };
}

function fitPiEntry(data: PiEntryData): string {
  const serialized = JSON.stringify(data);

  return harnessEntryBytes(serialized) <= MAX_HARNESS_SESSION_ENTRY_BYTES
    ? serialized
    : JSON.stringify(trimEntry(structuredClone(data)));
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

function trim(text: string): string {
  return truncateText(text, TRIMMED_TEXT_BYTES).value;
}

function trimAssistantPart(part: PiAssistantPart): PiAssistantPart {
  if (part.type === "text") return { ...part, text: trim(part.text) };
  if (part.type === "thinking")
    return { ...part, thinking: trim(part.thinking) };

  return {
    ...part,
    arguments: Object.fromEntries(
      Object.entries(part.arguments).map(
        ([key, value]): [string, PiJsonValue] => [
          key,
          typeof value === "string" ? trim(value) : value,
        ],
      ),
    ),
  };
}

function trimEntry(data: PiEntryData): PiEntryData {
  if (data.type === "custom_message") {
    data.content = trimMedia(data.content);
  } else if (data.type === "message") {
    const message = data.message;
    if (message.role === "assistant") {
      message.content = message.content.map(trimAssistantPart);
    } else if (message.role === "toolResult") {
      message.content = message.content.map(trimMediaPart);
    } else if (message.role === "user" || message.role === "custom") {
      message.content = trimMedia(message.content);
    } else if (message.role === "bashExecution") {
      message.output = trim(message.output);
    }
  }

  return data;
}

function trimMedia(content: string | PiMediaPart[]): string | PiMediaPart[] {
  return typeof content === "string"
    ? trim(content)
    : content.map(trimMediaPart);
}

function trimMediaPart(part: PiMediaPart): PiMediaPart {
  return part.type === "image"
    ? { type: "text", text: ATTACHMENT_NOT_RETAINED }
    : { ...part, text: trim(part.text) };
}
