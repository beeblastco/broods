import type { DetailRow } from "@/app/components/DetailSections";
import { actorName, PLATFORM, type Actor } from "@/app/components/Who";
import { formatDate } from "@/app/lib/formatTime";

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
