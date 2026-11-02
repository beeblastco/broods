"use client";

/** Shared list of agent config source options used by the empty canvas guide and the source picker dialog. */
import { Button } from "@/app/components/ui/button";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { FileDown, FilePlus, GitBranch, LayoutTemplate } from "lucide-react";
import { useParams, useRouter } from "next/navigation";

// "create" opens the editor and "github" the project's Git settings; the rest show as coming soon.
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
  const router = useRouter();
  const { projectId } = useParams<{ projectId?: Id<"projects"> }>();
  const github = useQuery(
    api.github.status,
    projectId ? { projectId: projectId } : "skip",
  );
  const actions: Record<SourceKey, (() => void) | undefined> = {
    github: github?.configured
      ? () => router.push(`/${projectId}/settings?tab=git`)
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
              {key === "github" && !actions.github ? "Coming soon" : hint}
            </span>
          </span>
        </Button>
      ))}
    </div>
  );
}
