"use client";

/** Shared list of agent config source options used by the empty canvas guide and the source picker dialog. */
import { FileDown, FilePlus, GitBranch, LayoutTemplate } from "lucide-react";
import { Button } from "@/app/components/ui/button";

const SOURCE_OPTIONS = [
    { key: "github", label: "From GitHub", icon: GitBranch },
    { key: "template", label: "From templates", icon: LayoutTemplate },
    { key: "import", label: "Import config file .json, .yaml", icon: FileDown },
    { key: "create", label: "Create new config file", icon: FilePlus },
] as const;

/** Renders the list of agent config source buttons. */
export function AgentSourceOptions({
    onCreateNew,
}: {
    onCreateNew?: () => void;
}) {
    return (
        <div className="flex flex-col">
            {SOURCE_OPTIONS.map(({ key, label, icon: Icon }) => (
                <Button
                    key={key}
                    variant="ghost"
                    onClick={key === "create" ? onCreateNew : undefined}
                    className="h-auto justify-start gap-2 rounded-lg px-3 py-2.5 text-sm text-muted-foreground"
                >
                    <Icon className="size-4 shrink-0 text-muted-foreground/60" />
                    {label}
                </Button>
            ))}
        </div>
    );
}
