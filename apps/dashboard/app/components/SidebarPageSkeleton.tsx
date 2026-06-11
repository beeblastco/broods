/** Sidebar-shaped loading skeleton matching the dashboard/settings page layout. */
import { cn } from "@/app/lib/utils";

/**
 * Placeholder that mirrors a sidebar + content page so route transitions paint
 * instantly instead of stalling on the previous page during data/chunk load.
 * @param title heading text shown above the sidebar nav
 * @param tabCount number of nav pill placeholders to render
 * @param contentMaxWidth max-width class for the content column to avoid layout shift
 */
export function SidebarPageSkeleton({
  title,
  tabCount,
  contentMaxWidth = "max-w-2xl",
}: {
  title: string;
  tabCount: number;
  contentMaxWidth?: string;
}) {
  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-48 shrink-0 flex-col bg-transparent">
        <div className="px-6 pt-9.25 pb-3">
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        </div>
        <nav className="flex flex-col gap-0.5 px-3">
          {Array.from({ length: tabCount }).map((_, i) => (
            <div
              key={i}
              className="h-8 w-full animate-pulse rounded-md bg-muted/60"
            />
          ))}
        </nav>
      </aside>

      {/* Content area */}
      <div className="flex flex-1 flex-col overflow-auto">
        <div
          className={cn(
            "px-8 pt-9.25 pb-6 mx-auto w-full shrink-0",
            contentMaxWidth,
          )}
        >
          <div className="h-7 w-40 animate-pulse rounded-md bg-muted/60" />
        </div>
        <div
          className={cn("mx-auto w-full space-y-4 px-8 pb-12", contentMaxWidth)}
        >
          <div className="h-24 w-full animate-pulse rounded-lg bg-muted/40" />
          <div className="h-40 w-full animate-pulse rounded-lg bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
