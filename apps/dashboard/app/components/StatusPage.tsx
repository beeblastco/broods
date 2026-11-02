import { cn } from "@/app/lib/utils";

// Convex relays errors to a production client with no detail but this id in the message.
const CONVEX_REQUEST_ID = /\[Request ID: ([0-9a-f]+)\]/;

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
  // Users see only the ref, which matches a server log line: the message may carry internals.
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
