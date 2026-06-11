"use client";

/**
 * Shared side-panel config primitives reused across the Workspace and Skill
 * Details tabs so each feature reads as a single labelled toggle that reveals
 * its extra configuration inline, matching the Agent card's design.
 */
import { Switch } from "@/app/components/ui/switch";
import type { ReactNode } from "react";

/** Label + Switch row; the switch is the feature's enable control. */
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
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">{label}</span>
                {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
            </div>
            <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="cursor-pointer" />
        </div>
    );
}

/** Indented reveal block matching the Agent card's expand styling. */
export function ExpandBlock({ children }: { children: ReactNode }) {
    return <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">{children}</div>;
}
