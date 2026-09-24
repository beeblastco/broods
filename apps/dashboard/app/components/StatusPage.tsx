import { cn } from "@/app/lib/utils";

/**
 * Full-page status view shared by not-found, error and global-error: a status
 * line, a one-line title, one short description and the actions as children.
 * Given a caught `error`, the description is its Next digest, the only part
 * shown to users: it matches the server log line, while the message may carry
 * internals. A client-side error has no digest, so no description.
 */
export function StatusPage({
  children,
  description,
  error,
  title,
}: {
  children: React.ReactNode;
  description?: string;
  error?: unknown;
  title: string;
}): React.JSX.Element {
  const isError = error !== undefined;
  const digest =
    error instanceof Error &&
    "digest" in error &&
    typeof error.digest === "string"
      ? error.digest
      : null;

  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-2 bg-background text-center">
      <p
        className={cn(
          "font-mono text-xs",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {isError ? "error" : "404"}
      </p>
      <h1 className="text-base font-semibold text-foreground">{title}</h1>
      {(description || digest) && (
        <p className="max-w-60 text-sm text-muted-foreground">
          {description ?? (
            <>
              Ref <code className="font-mono">{digest}</code>
            </>
          )}
        </p>
      )}
      <div className="flex items-center gap-2 pt-2">{children}</div>
    </main>
  );
}
