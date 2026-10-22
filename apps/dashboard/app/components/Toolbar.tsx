"use client";

import { FilterItems, type HeadFilter } from "@/app/components/DataTable";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";
import { ChevronDown } from "lucide-react";

/** One column the Filter button offers: its label and the same filter its header has. */
export interface FilterColumn {
  label: string;
  filter: HeadFilter;
}

/**
 * The bar above every list. Slots read left to right: search, facets, range,
 * then Filter, Refresh and the page's one primary action. Pages compose the
 * slots they need and keep the order; the count sits under the table.
 */
export function Toolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 select-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The toolbar's way into the header menus: pick a column, then a value. It
 * writes the same `field:value` chips the headers and typing do.
 */
export function FilterButton({
  columns,
}: {
  columns: FilterColumn[];
}): React.JSX.Element {
  const active = columns.some((column) => column.filter.active.length > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            tone={active ? "default" : "muted"}
            className="cursor-pointer"
          />
        }
      >
        Filter
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {columns.map((column) => (
          <DropdownMenuSub key={column.filter.field}>
            <DropdownMenuSubTrigger>{column.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <FilterItems filter={column.filter} label={column.label} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The refresh button, bound to the `r` shortcut; a failed stream turns it red. */
export function RefreshButton({
  onRefresh,
  disabled,
  title,
  isError,
}: {
  onRefresh: () => void;
  disabled: boolean;
  title: string;
  isError: boolean;
}): React.JSX.Element {
  useShortcut("table.refresh", () => !disabled && onRefresh());

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onRefresh}
      disabled={disabled}
      title={title}
      tone={isError ? "destructive" : "muted"}
      className="cursor-pointer"
    >
      Refresh
    </Button>
  );
}
