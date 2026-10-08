"use client";

/** Shared list of agent config source options used by the empty canvas guide and the source picker dialog. */
import { Button } from "@/app/components/ui/button";
import { FileDown, FilePlus, GitBranch, LayoutTemplate } from "lucide-react";

// Only "create" has a flow today; the rest show as coming soon until they do.
const SOURCE_OPTIONS = [
  {
    key: "github",
    label: "From GitHub",
    hint: "Coming soon",
    icon: GitBranch,
  },
  {
    key: "template",
    label: "From templates",
    hint: "Coming soon",
    icon: LayoutTemplate,
  },
  {
    key: "import",
    label: "Import config",
    hint: "Coming soon",
    icon: FileDown,
  },
  {
    key: "create",
    label: "New config",
    hint: "Write one in the editor",
    icon: FilePlus,
  },
] as const;

export function AgentSourceOptions({
  onCreateNew,
}: {
  onCreateNew?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {SOURCE_OPTIONS.map(({ key, label, hint, icon: Icon }) => (
        <Button
          key={key}
          variant="ghost"
          tone="muted"
          disabled={key !== "create"}
          onClick={key === "create" ? onCreateNew : undefined}
          className="h-auto justify-start"
        >
          <Icon className="size-4 shrink-0 self-start text-muted-foreground" />
          <span className="flex flex-col items-start">
            {label}
            <span className="text-2xs font-normal text-muted-foreground">
              {hint}
            </span>
          </span>
        </Button>
      ))}
    </div>
  );
}
