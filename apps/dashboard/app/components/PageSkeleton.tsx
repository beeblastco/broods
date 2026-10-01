import { Skeleton } from "@/app/components/ui/skeleton";
import { cn } from "@/app/lib/utils";

/**
 * Placeholder for a page's content column, so route transitions paint
 * instantly instead of stalling on the previous page during data/chunk load.
 * The sidebar stays on screen, so only the content is drawn.
 * @param contentMaxWidth max-width class for the content column to avoid layout shift
 */
export function PageSkeleton({
  contentMaxWidth = "max-w-2xl",
}: {
  contentMaxWidth?: string;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-4 px-6 pt-6 pb-12",
          contentMaxWidth,
        )}
      >
        <Skeleton className="h-24 w-full rounded-lg bg-muted/40" />
        <Skeleton className="h-40 w-full rounded-lg bg-muted/40" />
      </div>
    </div>
  );
}
