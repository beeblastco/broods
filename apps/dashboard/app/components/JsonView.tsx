"use client";

import { cn } from "@/app/lib/utils";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Read-only JSON tree for payload panes. Every object and array folds, and a
 * string with line breaks reads as a text block instead of escaped `\n`.
 */
export function JsonView({ value }: { value: JsonValue }): React.JSX.Element {
  return (
    <div className="font-mono text-code-foreground wrap-anywhere">
      <JsonNode value={value} last />
    </div>
  );
}

/** One key and value; objects and arrays carry the fold toggle in the gutter. */
function JsonNode({
  name,
  value,
  last,
}: {
  name?: string;
  value: JsonValue;
  last: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const comma = last ? "" : ",";
  const label = name !== undefined && (
    <>
      <span className="text-code-variable">{JSON.stringify(name)}</span>
      {": "}
    </>
  );
  if (value === null || typeof value !== "object") {
    return (
      <div className="pl-4">
        {label}
        <JsonScalar value={value} />
        {comma}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: Array<[string, JsonValue]> = isArray
    ? value.map((item, index): [string, JsonValue] => [String(index), item])
    : Object.entries(value);
  const [start, end] = isArray ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div className="pl-4">
        {label}
        {start}
        {end}
        {comma}
      </div>
    );
  }

  return (
    <div className="relative pl-4">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Fold" : "Unfold"}
        onClick={() => setOpen(!open)}
        className="absolute left-0 top-1 cursor-pointer text-muted-foreground hover:text-code-foreground"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
      </button>
      {label}
      {start}
      {open ? (
        <>
          {entries.map(([key, item], index) => (
            <JsonNode
              key={key}
              name={isArray ? undefined : key}
              value={item}
              last={index === entries.length - 1}
            />
          ))}
          <div>
            {end}
            {comma}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="cursor-pointer px-1 text-muted-foreground hover:text-code-foreground"
          >
            {`… ${entries.length} ${isArray ? "items" : "keys"}`}
          </button>
          {end}
          {comma}
        </>
      )}
    </div>
  );
}

/** A leaf value in its syntax color; multi-line strings become a text block. */
function JsonScalar({
  value,
}: {
  value: string | number | boolean | null;
}): React.JSX.Element {
  if (typeof value === "string" && value.includes("\n")) {
    return (
      <span className="block whitespace-pre-wrap border-l border-code-string/40 pl-2 text-code-string">
        {value}
      </span>
    );
  }

  return (
    <span
      className={cn(
        typeof value === "string" && "text-code-string",
        typeof value === "number" && "text-code-number",
        (typeof value === "boolean" || value === null) && "text-code-keyword",
      )}
    >
      {JSON.stringify(value)}
    </span>
  );
}
