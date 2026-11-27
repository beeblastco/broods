import type { ShortcutId } from "@/app/lib/shortcuts";

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
  detail?: string;
  group: SearchGroup;
  id: string;
  keywords?: readonly string[];
  target: SearchTarget;
  title: string;
}

export interface RankedGroup {
  group: SearchGroup;
  items: readonly SearchItem[];
}

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

function lengthBonus(title: string): number {
  return Math.max(0, 50 - title.length);
}

function wordStarts(title: string): string[] {
  return title.split(/[\s\-_./]+/).filter(Boolean);
}
