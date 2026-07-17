"use client";

/** Shared search + level/status + time-range + refresh toolbar for the logs and tracing panels. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
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
}: Props) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
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

      <Select value={filterValue} onValueChange={onFilterChange}>
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
