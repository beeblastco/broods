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

export interface FilterValue {
  value: string;
  label: ReactNode;
}

export interface HeadSort {
  dir: SortDir | null;
  onSort: (dir: SortDir) => void;
  words?: [string, string];
}

export interface HeadFilter {
  field: string;
  values: FilterValue[];
  active: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

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
  const button = sort !== undefined || filter !== undefined;

  return (
    <th
      className={cn(
        "font-medium",
        button ? "px-1 py-1" : "px-3 py-2",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
      {...props}
    >
      {filter ? (
        <HeadMenu sort={sort} filter={filter} align={align}>
          {children}
        </HeadMenu>
      ) : sort ? (
        <SortButton sort={sort}>{children}</SortButton>
      ) : (
        children
      )}
    </th>
  );
}

function SortButton({
  sort,
  children,
}: {
  sort: HeadSort;
  children: ReactNode;
}): React.JSX.Element {
  const sorted = sort.dir ?? null;

  return (
    <Button
      variant="ghost"
      size="xs"
      tone={sorted !== null ? "default" : "muted"}
      className="cursor-pointer font-medium"
      onClick={() => sort.onSort(sorted === "asc" ? "desc" : "asc")}
    >
      {children}
      {sorted === "asc" && <ArrowUp className="size-3" />}
      {sorted === "desc" && <ArrowDown className="size-3" />}
    </Button>
  );
}

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

export function DataTableBody({
  className,
  ...props
}: ComponentProps<"tbody">): React.JSX.Element {
  return (
    <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  );
}

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

export function DataTableFooter({
  shown,
  total,
  noun,
  detail,
  children,
}: {
  shown?: number;
  total: number;
  noun: [string, string];
  detail?: string;
  children?: ReactNode;
}): React.JSX.Element {
  const count =
    shown !== undefined && shown !== total
      ? `${shown.toLocaleString()} of ${total.toLocaleString()}`
      : total.toLocaleString();

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground tabular-nums">
      <span>
        {count} {total === 1 ? noun[0] : noun[1]}
        {detail}
        {typeof children === "string" && children}
      </span>
      {typeof children !== "string" && children}
    </div>
  );
}

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
