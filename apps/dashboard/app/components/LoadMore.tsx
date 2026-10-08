"use client";

import { DataTableFooter } from "@/app/components/DataTable";
import { Button } from "@/app/components/ui/button";

/**
 * The footer under a paged list: how many rows show of how many are held,
 * and a button for the next page while older rows remain.
 */
export function LoadMore({
  shown,
  total,
  noun,
  pageSize,
  remaining,
  onLoad,
}: {
  shown: number;
  total: number;
  /** The rows' plural name: "lines", "tasks". */
  noun: string;
  pageSize: number;
  remaining: number;
  onLoad: () => void;
}): React.JSX.Element {
  return (
    <DataTableFooter shown={shown} total={total} noun={noun}>
      {remaining > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          tone="muted"
          onClick={onLoad}
          className="cursor-pointer"
        >
          Load {Math.min(pageSize, remaining)} more ·{" "}
          {remaining.toLocaleString()} older
        </Button>
      )}
    </DataTableFooter>
  );
}
