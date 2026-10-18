/**
 * Opt-in product analytics: the events an install may send to PostHog, and
 * the batch it sends. Off unless `BROODS_ANALYTICS` is set. An event names a
 * feature and a count-like fact, never a prompt, an output, a name, an
 * email, a key, a URL, or an id other than the install's and, in `org`
 * mode, the organization's. The dashboard and core both build their events
 * here, so this file is the whole list of what leaves an install.
 */

// Longest string any event property may carry.
const MAX_PROP_CHARS = 64;

// How many events one beacon may carry; a browser batch is a handful.
const MAX_EVENTS = 32;

export const DURATION_BUCKETS = ["<10s", "<1m", "<10m", ">10m"] as const;

/** `anonymous` sends the install's id only; `org` (the managed service) adds the organization's. */
export type AnalyticsMode = "anonymous" | "org";

export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export type AnalyticsEvent =
  | { name: "dashboard_tab_opened"; tab: string }
  | { name: "agent_created"; provider: string }
  | { name: "trace_opened" }
  | {
      name: "run_finished";
      status: "completed" | "failed";
      stepCount: number;
      durationBucket: DurationBucket;
      /** Provider and model id without its version suffix: `anthropic/claude-sonnet`. */
      modelFamily: string;
      sandboxProvider: string | null;
      /** `direct`, `nats`, or the channel's name. */
      channelKind: string;
    };

/** What PostHog's `/batch` takes. */
export interface AnalyticsBatch {
  api_key: string;
  batch: Array<{
    event: AnalyticsEvent["name"];
    distinct_id: string;
    properties: Record<string, string | number | boolean | null>;
    timestamp: string;
  }>;
}

/** The mode an env value names, or null for off. Anything but the two words is off. */
export function analyticsMode(value: string | undefined): AnalyticsMode | null {
  return value === "anonymous" || value === "org" ? value : null;
}

/**
 * PostHog's `/batch` body for `events`. `distinct_id` is the install, not a
 * person, so no profile is kept. `orgId` is only passed in `org` mode.
 */
export function analyticsBatch(
  events: AnalyticsEvent[],
  context: {
    apiKey: string;
    instanceId: string;
    orgId?: string;
    source: "dashboard" | "core";
    at: number;
  },
): AnalyticsBatch {
  const timestamp = new Date(context.at).toISOString();

  return {
    api_key: context.apiKey,
    batch: events.map(({ name, ...props }) => ({
      event: name,
      distinct_id: context.instanceId,
      properties: {
        ...props,
        instance_id: context.instanceId,
        source: context.source,
        $process_person_profile: false,
        ...(context.orgId === undefined ? {} : { org_id: context.orgId }),
      },
      timestamp: timestamp,
    })),
  };
}

/** The bucket a run's wall time falls in, so a duration never leaves as a number. */
export function durationBucket(ms: number): DurationBucket {
  if (ms < 10_000) return "<10s";
  if (ms < 60_000) return "<1m";
  if (ms < 600_000) return "<10m";

  return ">10m";
}

/**
 * The `analytics` list of a beacon body, kept to the events above with only
 * their own properties, so a client cannot smuggle anything else out.
 */
export function parseAnalyticsEvents(body: unknown): AnalyticsEvent[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { analytics?: unknown }).analytics;
  if (!Array.isArray(list)) return [];

  const events: AnalyticsEvent[] = [];
  for (const entry of list.slice(0, MAX_EVENTS)) {
    const event = parseEvent(entry);
    if (event !== null) events.push(event);
  }

  return events;
}

function parseEvent(entry: unknown): AnalyticsEvent | null {
  if (typeof entry !== "object" || entry === null) return null;
  const candidate = entry as Record<string, unknown>;
  const tab = text(candidate, "tab");
  const provider = text(candidate, "provider");
  switch (candidate.name) {
    case "dashboard_tab_opened":
      return tab === null ? null : { name: "dashboard_tab_opened", tab: tab };
    case "agent_created":
      return provider === null
        ? null
        : { name: "agent_created", provider: provider };
    case "trace_opened":
      return { name: "trace_opened" };
    default:
      // run_finished is core's own; a browser never sends it.
      return null;
  }
}

function text(entry: Record<string, unknown>, key: string): string | null {
  const value = entry[key];

  return typeof value === "string" && value !== ""
    ? value.slice(0, MAX_PROP_CHARS)
    : null;
}
