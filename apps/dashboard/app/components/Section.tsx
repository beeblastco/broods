/** Reusable settings section with a title, optional description, and danger styling. */
import { cn } from "@/app/lib/utils";

export function Section({
  title,
  description,
  danger,
  children,
}: {
  title?: string;
  description?: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "grid grid-cols-1 gap-4",
        danger && "rounded-lg border border-destructive/40 p-6",
      )}
    >
      {(title || description) && (
        <div>
          {title && (
            <h2
              className={cn(
                "text-sm font-semibold",
                danger ? "text-destructive" : "text-foreground",
              )}
            >
              {title}
            </h2>
          )}
          {description && (
            <p
              className={cn("text-xs text-muted-foreground", title && "mt-0.5")}
            >
              {description}
            </p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
