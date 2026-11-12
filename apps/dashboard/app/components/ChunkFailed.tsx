import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import type { ComponentType } from "react";

// A lazy part whose chunk failed loads this instead, so the page around it keeps working.
export function chunkFailed<P extends object>(
  what: string,
): { default: ComponentType<P> } {
  return {
    default: (props) =>
      "open" in props && props.open === false ? null : (
        <p
          role="alert"
          className="fixed right-3 bottom-3 z-50 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm"
        >
          Couldn&apos;t load {what}. Reload the page to try again.
        </p>
      ),
  };
}

// A page whose chunk failed loads this instead, so the header and sidebar keep working.
export function sectionFailed(error: unknown): () => React.JSX.Element {
  return function SectionFailed(): React.JSX.Element {
    return (
      <StatusPage
        title="This page failed to load"
        description="Check your connection, then reload."
        error={error}
      >
        <Button
          onClick={() => window.location.reload()}
          className="cursor-pointer"
        >
          Reload
        </Button>
      </StatusPage>
    );
  };
}
