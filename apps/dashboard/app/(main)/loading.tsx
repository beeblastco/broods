/** Skeleton shown while the dashboard page chunk and data load. */
import { Skeleton } from "@/app/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-24 bg-muted" />
            <Skeleton className="h-4 w-16 bg-muted" />
          </div>
          <Skeleton className="h-8 w-28 bg-muted" />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-border overflow-hidden"
              >
                <Skeleton className="aspect-5/3 w-full rounded-none bg-muted" />
                <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
                  <Skeleton className="h-4 w-32 bg-muted" />
                  <Skeleton className="h-3 w-20 bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
