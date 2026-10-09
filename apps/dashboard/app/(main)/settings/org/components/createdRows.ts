import type { DetailRow } from "@/app/components/DetailSections";
import { actorName, PLATFORM, type Actor } from "@/app/components/Who";
import { formatDate } from "@/app/lib/formatTime";

/**
 * The Created and Created by rows of a detail panel. A built-in row has no
 * date and the platform as its maker, so it gets only Created by: Broods.
 */
export function createdRows(
  createdAt: number | undefined,
  createdBy: Actor | null | undefined,
): DetailRow[] {
  const rows: DetailRow[] = [];
  if (createdAt !== undefined) {
    rows.push({
      key: "created",
      label: "Created",
      value: formatDate(createdAt),
      words: true,
    });
  }
  rows.push({
    key: "creator",
    label: "Created by",
    value: actorName(createdBy ?? PLATFORM),
    words: true,
  });

  return rows;
}
