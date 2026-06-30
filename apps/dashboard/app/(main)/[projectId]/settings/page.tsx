"use client";

/** Settings page with sidebar navigation and panel-based content layout. */
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AuditLogsPanel } from "./components/AuditLogsPanel";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { DangerPanel } from "./components/DangerPanel";
import { DeployKeysPanel } from "./components/DeployKeysPanel";
import { EnvironmentsPanel } from "./components/EnvironmentsPanel";
import { PluginsPanel } from "./components/PluginsPanel";
import { ProjectGeneralPanel } from "./components/ProjectGeneralPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

type SettingsTab =
  | "general"
  | "environments"
  | "deploy"
  | "webhooks"
  | "connections"
  | "plugins"
  | "audit-logs"
  | "danger";

const TABS: Array<{ id: SettingsTab; label: string; danger?: boolean }> = [
  { id: "general", label: "General" },
  { id: "environments", label: "Environments" },
  { id: "deploy", label: "Deploy" },
  { id: "webhooks", label: "Webhooks" },
  { id: "connections", label: "Channels" },
  { id: "plugins", label: "Plugins" },
  { id: "audit-logs", label: "Audit Logs" },
  { id: "danger", label: "Danger Zone", danger: true },
];

export default function SettingsPage() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  const { environmentId } = useEnvironment();

  // Build a tab href that preserves the current params (e.g. ?env=) so the link is shareable
  // and can be opened in a new browser tab.
  const tabHref = (tabId: SettingsTab) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tabId);

    return `/${projectId}/settings?${next.toString()}`;
  };

  const environments = useQuery(api.environment.list, {
    projectId: projectId,
  }) as Doc<"environments">[] | undefined;
  // Resolve the environment to configure: the URL selection, else the default, else the first.
  const activeEnv =
    environments?.find((env) => env._id === environmentId) ??
    environments?.find((env) => env.isDefault) ??
    environments?.[0] ??
    null;
  const activeEnvId = activeEnv?._id ?? null;

  const activeTab = (searchParams.get("tab") as SettingsTab) || "general";
  const tab = TABS.find((t) => t.id === activeTab);
  const activeLabel = tab?.label ?? "Settings";

  const renderPanel = () => {
    switch (activeTab) {
      case "general":
        return <ProjectGeneralPanel projectId={projectId} />;
      case "environments":
        return (
          <EnvironmentsPanel
            projectId={projectId}
            environmentId={activeEnvId}
          />
        );
      case "deploy":
        return (
          <DeployKeysPanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "webhooks":
        return (
          <WebhooksPanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "connections":
        return (
          <ConnectionsPanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "plugins":
        return (
          <PluginsPanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "audit-logs":
        return (
          <AuditLogsPanel projectId={projectId} environmentId={activeEnvId} />
        );
      case "danger":
        return (
          <DangerPanel projectId={projectId} environmentId={activeEnvId} />
        );
      default:
        return <ProjectGeneralPanel projectId={projectId} />;
    }
  };

  const isPlugins = activeTab === "plugins";

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col bg-transparent">
        <div className="px-6 pt-9.25 pb-3">
          <h2 className="text-xl font-semibold text-foreground">Settings</h2>
        </div>
        <nav className="flex flex-col gap-4 px-3">
          {/* Base settings group */}
          <div className="flex flex-col gap-0.5">
            {TABS.filter((t) => ["general", "environments", "deploy", "webhooks"].includes(t.id)).map((t) => (
              <Button
                key={t.id}
                asChild
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70 h-8",
                  activeTab === t.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Link href={tabHref(t.id)}>{t.label}</Link>
              </Button>
            ))}
          </div>

          {/* Connections Group */}
          <div className="flex flex-col gap-1">
            <div className="px-3 py-1 flex items-center gap-1.5">
              <span className="text-xs font-semibold text-foreground/80">Connections</span>
            </div>
            <div className="flex flex-col gap-0.5 pl-3">
              {TABS.filter((t) => ["connections", "plugins", "audit-logs"].includes(t.id)).map((t) => (
                <Button
                  key={t.id}
                  asChild
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70 h-8",
                    activeTab === t.id
                      ? "bg-accent text-foreground font-semibold"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Link href={tabHref(t.id)}>{t.label}</Link>
                </Button>
              ))}
            </div>
          </div>

          {/* Danger zone group */}
          <div className="flex flex-col gap-0.5">
            {TABS.filter((t) => t.id === "danger").map((t) => (
              <Button
                key={t.id}
                asChild
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70 h-8",
                  activeTab === t.id
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "text-destructive/70 hover:text-destructive hover:bg-destructive/10 active:bg-destructive/10",
                )}
              >
                <Link href={tabHref(t.id)}>{t.label}</Link>
              </Button>
            ))}
          </div>
        </nav>
      </aside>

      {/* Content area — min-w-0 lets long values truncate instead of widening the column */}
      <div className={cn("flex min-w-0 flex-1 flex-col", isPlugins ? "h-full overflow-hidden" : "overflow-auto")}>
        {/* Page title — aligned with sidebar header height */}
        {!isPlugins && (
          <div className="px-6 pt-9.25 pb-6 mx-auto w-full max-w-2xl shrink-0">
            <h2 className="text-xl font-semibold text-foreground">
              {activeLabel}
            </h2>
          </div>
        )}
        <div className={cn(
          "w-full",
          isPlugins
            ? "flex-1 flex flex-col min-h-0 bg-background"
            : "mx-auto w-full max-w-2xl px-6 pb-12"
        )}>
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}
