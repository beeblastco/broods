"use client";

import { Switch } from "@/app/components/ui/switch";
import { useId, type ReactNode } from "react";

export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const id = useId();

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <span
          id={`${id}-label`}
          className="text-xs font-medium text-foreground"
        >
          {label}
        </span>
        {description && (
          <span
            id={`${id}-description`}
            className="text-2xs text-muted-foreground"
          >
            {description}
          </span>
        )}
      </div>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="cursor-pointer"
      />
    </div>
  );
}

export function ExpandBlock({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">
      {children}
    </div>
  );
}
