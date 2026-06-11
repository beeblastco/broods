"use client";

/** Dashboard page with sidebar navigation and a titled content panel. */
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { BillingPanel } from "./components/BillingPanel";
import { MonitoringPanel } from "./components/MonitoringPanel";
import { TokensUsagePanel } from "./components/TokensUsagePanel";
import { TracingPanel } from "./components/TracingPanel";

const TABS = [
  { id: "monitoring", label: "Monitoring" },
  { id: "tracing", label: "Tracing" },
  { id: "tokens", label: "Tokens Usage" },
  { id: "billing", label: "Billing & Plan" },
] as const;

type DashboardTab = (typeof TABS)[number]["id"];

export default function DashboardPage() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  const project = useQuery(api.project.getById, { projectId: projectId });
  const { environmentId } = useEnvironment();
  const environments = useQuery(api.environment.list, {
    projectId: projectId,
  }) as Doc<"environments">[] | undefined;
  const activeTab = (searchParams.get("tab") as DashboardTab) || "monitoring";

  // Build a tab href that preserves the current params (e.g. ?env=) so the link is shareable
  // and can be opened in a new browser tab.
  const tabHref = (tabId: DashboardTab) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tabId);

    return `/${projectId}/dashboard?${next.toString()}`;
  };

  // Resolve the environment to scope analytics to: URL selection, else default, else first.
  const activeEnv =
    environments?.find((env) => env._id === environmentId) ??
    environments?.find((env) => env.isDefault) ??
    environments?.[0] ??
    null;
  const activeEnvId = activeEnv?._id ?? null;

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (project === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  const tab = TABS.find((t) => t.id === activeTab);
  const activeLabel = tab?.label ?? "";
  // Billing matches the narrow Settings page width; the analytics tabs need
  // more horizontal room for charts, tables, and dense log rows.
  const contentMaxWidth = activeTab === "billing" ? "max-w-2xl" : "max-w-6xl";

  const renderPanel = () => {
    switch (activeTab) {
      case "monitoring":
        return (
          <MonitoringPanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "tracing":
        return <TracingPanel />;
      case "tokens":
        return (
          <TokensUsagePanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "billing":
        return <BillingPanel projectId={projectId} />;
      default:
        return (
          <MonitoringPanel projectId={projectId} environmentId={activeEnvId} />
        );
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-48 shrink-0 flex-col bg-transparent">
        <div className="px-6 pt-9.25 pb-3">
          <h2 className="text-xl font-semibold text-foreground">Dashboard</h2>
        </div>
        <nav className="flex flex-col gap-0.5 px-3">
          {TABS.map((t) => (
            <Button
              key={t.id}
              asChild
              variant="ghost"
              size="sm"
              className={cn(
                "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70",
                activeTab === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Link href={tabHref(t.id)}>{t.label}</Link>
            </Button>
          ))}
        </nav>
      </aside>

      {/* Content area */}
      <div className="flex flex-1 flex-col overflow-auto">
        {/* Page title — aligned with sidebar header height */}
        <div
          className={cn(
            "px-8 pt-9.25 pb-5 mx-auto w-full shrink-0",
            contentMaxWidth,
          )}
        >
          <h2 className="text-xl font-semibold text-foreground">
            {activeLabel}
          </h2>
        </div>
        <div className={cn("mx-auto w-full px-8 pb-12", contentMaxWidth)}>
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}
