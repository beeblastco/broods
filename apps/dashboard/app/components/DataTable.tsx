"use client";

import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import type { SortDir } from "@/app/lib/tableState";
import { cn } from "@/app/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** One value a column can filter by, with how the menu shows it. */
export interface FilterValue {
  value: string;
  label: ReactNode;
}

/** The sort half of a header menu: which way this column is sorted, if at all. */
export interface HeadSort {
  dir: SortDir | null;
  onSort: (dir: SortDir) => void;
  /** Word pairs for the two directions; dates say oldest and newest first. */
  words?: [string, string];
}

/** The sort words for a time column, in place of A to Z. */
export const TIME_WORDS: [string, string] = ["Oldest first", "Newest first"];

/** The filter half of a header menu: the column's values and the ones in effect. */
export interface HeadFilter {
  field: string;
  values: FilterValue[];
  active: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

/**
 * The dense list table every page shares: a sticky muted header, 12px cells,
 * row hover, and a selected row. Pages bring their own columns; the look is
 * fixed here so the lists read the same on logs, jobs and sandboxes.
 */
export function DataTable({
  className,
  ...props
}: ComponentProps<"table">): React.JSX.Element {
  return (
    <table
      className={cn("w-full text-xs whitespace-nowrap", className)}
      {...props}
    />
  );
}

/**
 * The column header cell. With `sort` or `filter` it opens one menu: sort
 * either way, then the column's values with a check on the ones in effect.
 * The sorted column reads in foreground with an arrow. `align="right"` for
 * numbers and switches.
 */
export function DataTableHead({
  align = "left",
  sort,
  filter,
  className,
  children,
  ...props
}: ComponentProps<"th"> & {
  align?: "left" | "right";
  sort?: HeadSort;
  filter?: HeadFilter;
}): React.JSX.Element {
  const menu = sort !== undefined || filter !== undefined;

  return (
    <th
      className={cn(
        "font-medium",
        menu ? "px-1 py-1" : "px-3 py-2",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
      {...props}
    >
      {menu ? (
        <HeadMenu sort={sort} filter={filter} align={align}>
          {children}
        </HeadMenu>
      ) : (
        children
      )}
    </th>
  );
}

/** The header's menu: the sort pair, a rule, then the filter values. */
function HeadMenu({
  sort,
  filter,
  align,
  children,
}: {
  sort?: HeadSort;
  filter?: HeadFilter;
  align: "left" | "right";
  children: ReactNode;
}): React.JSX.Element {
  const sorted = sort?.dir ?? null;
  const emphasized = sorted !== null || (filter?.active.length ?? 0) > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            tone={emphasized ? "default" : "muted"}
            className="cursor-pointer font-medium"
          />
        }
      >
        {children}
        {sorted === "asc" && <ArrowUp className="size-3" />}
        {sorted === "desc" && <ArrowDown className="size-3" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align === "right" ? "end" : "start"}>
        {sort && (
          <>
            <DropdownMenuItem
              data-active={sorted === "asc"}
              onClick={() => sort.onSort("asc")}
            >
              <ArrowUp />
              {sort.words?.[0] ?? "Sort A to Z"}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-active={sorted === "desc"}
              onClick={() => sort.onSort("desc")}
            >
              <ArrowDown />
              {sort.words?.[1] ?? "Sort Z to A"}
            </DropdownMenuItem>
          </>
        )}
        {sort && filter && <DropdownMenuSeparator />}
        {filter && (
          <FilterItems filter={filter} label={`Filter by ${filter.field}`} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header row group, sticky over the scrolling body. */
export function DataTableHeader({
  className,
  ...props
}: ComponentProps<"thead">): React.JSX.Element {
  return (
    <thead
      className={cn(
        "sticky top-0 z-10 border-b border-border bg-card/95 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The body row group; the last row drops its rule so the frame closes it. */
export function DataTableBody({
  className,
  ...props
}: ComponentProps<"tbody">): React.JSX.Element {
  return (
    <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  );
}

/** A body row. Clickable rows get the pointer and the hover; `selected` holds the accent. */
export function DataTableRow({
  selected = false,
  className,
  onClick,
  ...props
}: ComponentProps<"tr"> & { selected?: boolean }): React.JSX.Element {
  return (
    <tr
      onClick={onClick}
      className={cn(
        "border-b border-border/40 transition-colors",
        onClick && "cursor-pointer hover:bg-accent/20",
        selected && "bg-accent/30",
        className,
      )}
      {...props}
    />
  );
}

/** A body cell. `muted` for secondary text, `align="right"` to match its head. */
export function DataTableCell({
  align = "left",
  muted = false,
  className,
  ...props
}: ComponentProps<"td"> & {
  align?: "left" | "right";
  muted?: boolean;
}): React.JSX.Element {
  return (
    <td
      className={cn(
        "px-3 py-2 align-middle",
        align === "right" && "text-right",
        muted && "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The second line under a cell's main text. */
export function DataTableSub({
  className,
  ...props
}: ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn("truncate text-2xs text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * The line under a list: "4 jobs", or "2 of 4 jobs" while a filter hides
 * some. `children` sits at the right: a Load more button, or a note like
 * ", 3 active" when it is text.
 */
export function DataTableFooter({
  shown,
  total,
  noun,
  children,
}: {
  shown?: number;
  total: number;
  /** The rows' plural name, or the singular when `total` is one. */
  noun: string;
  children?: ReactNode;
}): React.JSX.Element {
  const count =
    shown !== undefined && shown !== total
      ? `${shown.toLocaleString()} of ${total.toLocaleString()}`
      : total.toLocaleString();

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground tabular-nums">
      <span>
        {count} {noun}
        {typeof children === "string" && children}
      </span>
      {typeof children !== "string" && children}
    </div>
  );
}

/** The value list of a filter menu; the header menu and the Filter button share it. */
export function FilterItems({
  filter,
  label,
}: {
  filter: HeadFilter;
  label: string;
}): React.JSX.Element {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel variant="muted">{label}</DropdownMenuLabel>
        {filter.values.map((entry) => (
          <DropdownMenuCheckboxItem
            key={entry.value}
            checked={filter.active.includes(entry.value)}
            onCheckedChange={() => filter.onToggle(entry.value)}
            closeOnClick={false}
          >
            {entry.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
      {filter.active.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={filter.onClear}>
            Clear filter
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
