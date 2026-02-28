/** Reusable settings section with a title, optional description, and danger styling. */
import { cn } from "@/lib/utils";

export function Section({
    title,
    description,
    danger,
    children,
}: {
    title: string;
    description?: string;
    danger?: boolean;
    children: React.ReactNode;
}) {
    return (
        <section className={cn("grid gap-4", danger && "rounded-lg border border-destructive/40 p-6")}>
            <div>
                <h2 className={cn("text-sm font-semibold", danger ? "text-destructive" : "text-foreground")}>
                    {title}
                </h2>
                {description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                )}
            </div>
            {children}
        </section>
    );
}
