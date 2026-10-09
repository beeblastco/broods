import type { ReactNode } from "react";

/**
 * The red-bordered block at the end of a detail panel for the one action
 * that cannot be undone: a heading, one line on what it does, the button.
 */
export function DangerZone({
  description,
  children,
}: {
  description: string;
  /** The destructive button. */
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}
