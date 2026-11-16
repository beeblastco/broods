"use client";

import { DataTableFooter } from "@/app/components/DataTable";
import { Button } from "@/app/components/ui/button";

export function LoadMore({
  shown,
  total,
  noun,
  detail,
  pageSize,
  remaining,
  onLoad,
}: {
  shown: number;
  total: number;
  noun: [string, string];
  detail?: string;
  pageSize: number;
  remaining: number;
  onLoad: () => void;
}): React.JSX.Element {
  return (
    <DataTableFooter shown={shown} total={total} noun={noun} detail={detail}>
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
