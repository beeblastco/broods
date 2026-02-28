"use client";

/** Shared list of tool source options for the tool source picker dialog. */
import { Box, Code, FileUp } from "lucide-react";
import { Button } from "@/app/components/ui/button";

const SOURCE_OPTIONS = [
    { key: "docker", label: "From Docker image", icon: Box },
    { key: "upload", label: "Upload code file (.js, .py)", icon: FileUp },
    { key: "scratch", label: "Custom from scratch", icon: Code },
] as const;

/** Renders the list of tool creation source buttons. */
export function ToolSourceOptions({
    onSelect,
}: {
    onSelect: (source: "docker" | "upload" | "scratch") => void;
}) {
    return (
        <div className="flex flex-col">
            {SOURCE_OPTIONS.map(({ key, label, icon: Icon }) => (
                <Button
                    key={key}
                    variant="ghost"
                    onClick={() => onSelect(key)}
                    className="h-auto justify-start gap-2 rounded-lg px-3 py-2.5 text-sm text-muted-foreground"
                >
                    <Icon className="size-4 shrink-0 text-muted-foreground/60" />
                    {label}
                </Button>
            ))}
        </div>
    );
}
