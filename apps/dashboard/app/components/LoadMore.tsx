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
  pageSize,
  remaining,
  onLoad,
}: {
  shown: number;
  total: number;
  pageSize: number;
  remaining: number;
  onLoad: () => void;
}): React.JSX.Element {
  return (
    <DataTableFooter className="flex items-center justify-between gap-2">
      <span>
        {shown === total
          ? total.toLocaleString()
          : `${shown.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
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
