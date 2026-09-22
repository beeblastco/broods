/**
 * Ranking for the command palette. Pure on purpose: the index hook gathers the
 * rows from Convex, this decides which ones a query deserves, and the copilot's
 * intent parser reuses both so "open triage" resolves the same node the palette
 * would have shown.
 */

import type { ShortcutId } from "@/app/lib/shortcuts";

/** How many rows one heading may contribute before the next heading starts. */
const PER_GROUP_LIMIT = 5;

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 500;
const SCORE_WORD_PREFIX = 250;
const SCORE_SUBSTRING = 100;
const SCORE_KEYWORD = 40;

export type SearchGroup =
  | "Go to"
  | "Nodes"
  | "Crons"
  | "Config"
  | "Projects"
  | "Stages"
  | "Actions";

export type SearchTarget =
  | { href: string; type: "navigate" }
  | { nodeId: string; type: "openNode" }
  | { commandId: ShortcutId; type: "command" };

export interface SearchItem {
  /** Muted text on the right of the row. */
  detail?: string;
  group: SearchGroup;
  id: string;
  /** Matched at a lower weight than the title, and never shown. */
  keywords?: readonly string[];
  target: SearchTarget;
  title: string;
}

export interface RankedGroup {
  group: SearchGroup;
  items: readonly SearchItem[];
}

/**
 * Items grouped in `GROUP_ORDER`, best first inside each group, capped so one
 * noisy source cannot push every other heading off the list. An empty query
 * keeps the natural order, which is what makes the palette useful before you
 * type anything.
 */
export function rankItems(
  items: readonly SearchItem[],
  query: string,
): readonly RankedGroup[] {
  const trimmed = query.trim().toLowerCase();
  const scored = trimmed
    ? items
        .map((item) => ({ item: item, score: scoreItem(item, trimmed) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.item)
    : items;

  return GROUP_ORDER.map((group) => ({
    group: group,
    items: scored
      .filter((item) => item.group === group)
      .slice(0, PER_GROUP_LIMIT),
  })).filter((entry) => entry.items.length > 0);
}

/**
 * How well one item answers a lowercased query. Zero means it does not, so the
 * caller drops it.
 */
export function scoreItem(item: SearchItem, query: string): number {
  const title = item.title.toLowerCase();

  if (title === query) return SCORE_EXACT;
  if (title.startsWith(query)) return SCORE_PREFIX + lengthBonus(title);
  if (wordStarts(title).some((word) => word.startsWith(query))) {
    return SCORE_WORD_PREFIX + lengthBonus(title);
  }
  if (title.includes(query)) return SCORE_SUBSTRING + lengthBonus(title);

  const keywordHit = (item.keywords ?? []).some((keyword) =>
    keyword.toLowerCase().includes(query),
  );
  if (keywordHit) return SCORE_KEYWORD;

  const detail = item.detail?.toLowerCase();

  return detail?.includes(query) ? SCORE_KEYWORD : 0;
}

const GROUP_ORDER: readonly SearchGroup[] = [
  "Go to",
  "Nodes",
  "Crons",
  "Config",
  "Projects",
  "Stages",
  "Actions",
];

/** Shorter titles win ties, so `api` beats `api-gateway-worker` on "api". */
function lengthBonus(title: string): number {
  return Math.max(0, 50 - title.length);
}

function wordStarts(title: string): string[] {
  return title.split(/[\s\-_./]+/).filter(Boolean);
}
