"use client";

import { Button } from "@/app/components/ui/button";
import { FileDown, FilePlus, GitBranch, LayoutTemplate } from "lucide-react";
import { useRouteIntent } from "@/app/hooks/useRouteIntent";
import { useParams } from "next/navigation";

const SOURCE_OPTIONS = [
  {
    key: "github",
    label: "From GitHub",
    hint: "Link a repo, push to deploy",
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

type SourceKey = (typeof SOURCE_OPTIONS)[number]["key"];

export function AgentSourceOptions({
  onCreateNew,
}: {
  onCreateNew?: () => void;
}): React.JSX.Element {
  const { navigate } = useRouteIntent();
  const { projectId } = useParams<{ projectId?: string }>();
  const actions: Record<SourceKey, (() => void) | undefined> = {
    github: projectId
      ? () => navigate(`/${projectId}/settings?tab=git`)
      : undefined,
    template: undefined,
    import: undefined,
    create: onCreateNew,
  };

  return (
    <div className="flex flex-col">
      {SOURCE_OPTIONS.map(({ key, label, hint, icon: Icon }) => (
        <Button
          key={key}
          variant="ghost"
          tone="muted"
          disabled={!actions[key]}
          onClick={actions[key]}
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
