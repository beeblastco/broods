"use client";

/**
 * One project on the projects page. A press anywhere on the card opens it; a
 * writer renames it in place from the pencil beside its name. The open
 * control is a layer under the name rather than around it, so the rename
 * field and its button are not nested inside another button.
 */
import { Button } from "@/app/components/ui/button";
import { InlineEdit } from "@/app/components/ui/inline-edit";
import { useRouteIntent } from "@/app/hooks/useRouteIntent";
import { toErrorMessage } from "@/app/lib/errors";
import { Folder, Pencil } from "lucide-react";
import { useState } from "react";

export function ProjectCard({
  name,
  description,
  href,
  canWrite,
  onRename,
}: {
  name: string;
  description?: string;
  href: string;
  canWrite: boolean;
  /** Saves a trimmed, changed name; the caller's optimistic update shows it at once. */
  onRename: (name: string) => Promise<unknown>;
}): React.JSX.Element {
  const { handlers } = useRouteIntent();
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="group relative flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 hover:ring-2 hover:ring-primary/50">
      <button
        type="button"
        aria-label={`Open ${name}`}
        className="absolute inset-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...handlers(href)}
      />
      <div className="flex w-full items-center gap-2 text-sm font-medium text-foreground">
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        {renaming ? (
          <InlineEdit
            value={name}
            label={`Rename ${name}`}
            className="relative"
            onCommit={(next) => {
              setRenaming(false);
              setError(null);
              void onRename(next).catch((err: unknown) =>
                setError(toErrorMessage(err)),
              );
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="truncate">{name}</span>
        )}
        {canWrite && (
          <span className="relative ml-auto flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              tone="muted"
              aria-label={`Rename ${name}`}
              className="cursor-pointer"
              onClick={() => setRenaming(true)}
            >
              <Pencil />
            </Button>
          </span>
        )}
      </div>
      {error ? (
        <p className="line-clamp-2 text-xs text-destructive">{error}</p>
      ) : (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {description || "No description"}
        </p>
      )}
    </div>
  );
}
