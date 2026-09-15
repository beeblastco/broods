"use client";

import { MonitoringPanel } from "../(main)/[projectId]/dashboard/components/MonitoringPanel";
import { TracingPanel } from "../(main)/[projectId]/dashboard/components/TracingPanel";

/**
 * The dashboard page around the real Monitoring and Tracing panels: the app
 * shell's full-screen column, the dashboard sidebar, and the scroll-owning
 * content column, with the classes those layouts use. A spec answers the
 * panels' observability socket, so View trace runs the real navigation and
 * focus scroll with no backend behind it.
 */
export function ObservabilityPageStandIn({
  tab,
}: {
  tab: "monitoring" | "tracing";
}): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col bg-background">
      <div className="h-12 shrink-0 border-b border-border" />
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full">
          <aside className="flex w-48 shrink-0 flex-col bg-transparent" />
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="mx-auto w-full max-w-none shrink-0 px-6 pt-9.25 pb-5">
              <h2 className="text-xl font-semibold text-foreground">
                {tab === "tracing" ? "Tracing" : "Monitoring"}
              </h2>
            </div>
            <div className="mx-auto flex min-h-0 w-full max-w-none flex-1 flex-col px-6 pb-6">
              {tab === "tracing" ? (
                <TracingPanel
                  projectSlug="gallery"
                  stageSlug="dev"
                  apiKey="gallery-viewing-key"
                />
              ) : (
                <MonitoringPanel
                  projectSlug="gallery"
                  stageSlug="dev"
                  apiKey="gallery-viewing-key"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
