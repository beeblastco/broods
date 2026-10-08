"use client";

import { cn } from "@/app/lib/utils";
import type { ComponentProps } from "react";

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

/** The column header cell. `align="right"` for numbers and switches. */
export function DataTableHead({
  align = "left",
  className,
  ...props
}: ComponentProps<"th"> & { align?: "left" | "right" }): React.JSX.Element {
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
      {...props}
    />
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
        "px-3 py-2 align-top",
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
