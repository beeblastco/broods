"use client";

/** The footer under a paged list: "Load 50 more · 1,204 older". Hidden when nothing is left. */
export function LoadMore({
  pageSize,
  remaining,
  onLoad,
}: {
  pageSize: number;
  remaining: number;
  onLoad: () => void;
}): React.JSX.Element | null {
  if (remaining <= 0) return null;

  return (
    <div className="border-t border-border/40 bg-card/60 p-2 text-center">
      <button
        type="button"
        onClick={onLoad}
        className="cursor-pointer rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        Load {Math.min(pageSize, remaining)} more · {remaining.toLocaleString()}{" "}
        older
      </button>
    </div>
  );
}
