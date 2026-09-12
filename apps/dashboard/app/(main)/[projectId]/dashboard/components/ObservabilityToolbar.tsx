"use client";

/** Shared by the logs and tracing panels, so a filter added here shows up on both. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import type { ObservabilityHistoryStatus } from "@/app/hooks/useObservabilityStream";
import { cn } from "@/app/lib/utils";
import { RefreshCw, Search, X } from "lucide-react";

export interface ToolbarFilterOption {
  value: string;
  label: string;
}

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  filterAriaLabel: string;
  filterValue: string;
  filterOptions: ToolbarFilterOption[];
  onFilterChange: (value: string) => void;
  fromTime: string;
  onFromTimeChange: (value: string) => void;
  toTime: string;
  onToTimeChange: (value: string) => void;
  hasFilters: boolean;
  onClear: () => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
  refreshSpinning: boolean;
  refreshTitle: string;
  isError: boolean;
}

/**
 * What an empty logs or traces table should say. "Waiting" alone hid a failed
 * or still-running history query behind the same text as a quiet stage.
 */
export function emptyStreamMessage(
  history: ObservabilityHistoryStatus,
  error: string | null,
  noun: "logs" | "traces",
  window: string,
): string {
  if (history === "loading") return `Loading ${noun} from the last ${window}…`;
  if (history === "failed")
    return `Couldn't load ${noun}: ${error ?? "history query failed"}`;
  if (history === "loaded") return `No ${noun} in the last ${window}.`;

  return `Waiting for ${noun}…`;
}

export function ObservabilityToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  filterAriaLabel,
  filterValue,
  filterOptions,
  onFilterChange,
  fromTime,
  onFromTimeChange,
  toTime,
  onToTimeChange,
  hasFilters,
  onClear,
  onRefresh,
  refreshDisabled,
  refreshSpinning,
  refreshTitle,
  isError,
}: Props): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 select-none">
      <div className="relative min-w-50 flex-1">
        <Search className="absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <Select
        items={filterOptions}
        value={filterValue}
        onValueChange={(value) => {
          if (value !== null) {
            onFilterChange(value);
          }
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={filterAriaLabel}
          className="w-32.5 cursor-pointer text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {filterOptions.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="cursor-pointer text-xs"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        type="datetime-local"
        value={fromTime}
        onChange={(event) => onFromTimeChange(event.target.value)}
        aria-label="From time"
        title="From"
        className="h-8 w-auto cursor-pointer text-xs"
      />
      <Input
        type="datetime-local"
        value={toTime}
        onChange={(event) => onToTimeChange(event.target.value)}
        aria-label="To time"
        title="To"
        className="h-8 w-auto cursor-pointer text-xs"
      />

      {hasFilters && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={onClear}
          aria-label="Clear filters"
          title="Clear filters"
          className="cursor-pointer text-muted-foreground"
        >
          <X className="size-3.5" />
        </Button>
      )}

      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onRefresh}
        disabled={refreshDisabled}
        aria-label="Refresh"
        title={refreshTitle}
        className={cn(
          "cursor-pointer text-muted-foreground",
          refreshDisabled && "cursor-not-allowed",
          isError && "text-destructive",
        )}
      >
        <RefreshCw
          className={cn("size-3.5", refreshSpinning && "animate-spin")}
        />
      </Button>
    </div>
  );
}
