"use client";

import { CopyButton } from "@/app/components/CopyButton";
import { Textarea } from "@/app/components/ui/textarea";

export function CopyTextarea({
  value,
  label,
  code = false,
}: {
  value: string;
  label: string;
  code?: boolean;
}): React.JSX.Element {
  return (
    <div className="group/copy relative">
      <Textarea
        readOnly
        value={value}
        aria-label={label}
        variant={code ? "code" : "default"}
        className="max-h-80 min-h-24 resize-y text-xs"
      />
      <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within/copy:opacity-100 group-hover/copy:opacity-100">
        <CopyButton value={value} label={label} />
      </span>
    </div>
  );
}
