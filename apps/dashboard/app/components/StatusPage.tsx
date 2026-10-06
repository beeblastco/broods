import { cn } from "@/app/lib/utils";

// Convex puts the request id in the message of every error it relays; a
// production client gets no other detail.
const CONVEX_REQUEST_ID = /\[Request ID: ([0-9a-f]+)\]/;

/**
 * Status view shared by not-found, error, global-error and the in-app failure
 * states: a status line, a one-line title, one short description and the
 * actions as children. It fills its parent, so a page under the header keeps
 * the header. Given a caught `error`, the description is its ref, the only
 * part shown to users: the Next digest, or the Convex request id, each
 * matching a server log line, while the message may carry internals. An error
 * with neither has no description.
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
  const ref =
    error instanceof Error
      ? "digest" in error && typeof error.digest === "string"
        ? error.digest
        : (CONVEX_REQUEST_ID.exec(error.message)?.[1] ?? null)
      : null;

  return (
    <main className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background text-center">
      <p
        className={cn(
          "font-mono text-xs",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {isError ? "error" : "404"}
      </p>
      <h1 className="text-base font-semibold text-foreground">{title}</h1>
      {(description || ref) && (
        <p className="max-w-60 text-sm text-muted-foreground">
          {description ?? (
            <>
              Ref <code className="font-mono">{ref}</code>
            </>
          )}
        </p>
      )}
      <div className="flex items-center gap-2 pt-2">{children}</div>
    </main>
  );
}
