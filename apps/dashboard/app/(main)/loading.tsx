/** Skeleton shown while the dashboard page chunk and data load. */
export default function DashboardLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="space-y-2">
            <div className="h-5 w-24 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-8 w-28 animate-pulse rounded bg-muted" />
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
                <div className="aspect-5/3 w-full animate-pulse bg-muted" />
                <div className="border-t border-border px-4 py-3 space-y-2">
                  <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
