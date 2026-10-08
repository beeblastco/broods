import type { ReactNode } from "react";

/**
 * What an empty list says: one line, an optional second in muted text, and
 * at most one action. No card around it, so it reads the same inside a
 * table frame and on a bare page.
 */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm text-foreground">{title}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
