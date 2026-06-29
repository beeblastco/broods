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
import { DangerPanel } from "./components/DangerPanel";
import { DeployKeysPanel } from "./components/DeployKeysPanel";
import { EnvironmentsPanel } from "./components/EnvironmentsPanel";
import { ProjectGeneralPanel } from "./components/ProjectGeneralPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

type SettingsTab =
  | "general"
  | "environments"
  | "deploy"
  | "webhooks"
  | "danger";

const TABS: Array<{ id: SettingsTab; label: string; danger?: boolean }> = [
  { id: "general", label: "General" },
  { id: "environments", label: "Environments" },
  { id: "deploy", label: "Deploy" },
  { id: "webhooks", label: "Webhooks" },
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
      case "danger":
        return (
          <DangerPanel projectId={projectId} environmentId={activeEnvId} />
        );
      default:
        return <ProjectGeneralPanel projectId={projectId} />;
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-48 shrink-0 flex-col bg-transparent">
        <div className="px-6 pt-9.25 pb-3">
          <h2 className="text-xl font-semibold text-foreground">Settings</h2>
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
                  ? t.danger
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "bg-accent text-foreground"
                  : t.danger
                    ? "text-destructive/70 hover:text-destructive hover:bg-destructive/10 active:bg-destructive/10"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Link href={tabHref(t.id)}>{t.label}</Link>
            </Button>
          ))}
        </nav>
      </aside>

      {/* Content area — min-w-0 lets long values truncate instead of widening the column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        {/* Page title — aligned with sidebar header height */}
        <div className="px-6 pt-9.25 pb-6 mx-auto w-full max-w-2xl shrink-0">
          <h2 className="text-xl font-semibold text-foreground">
            {activeLabel}
          </h2>
        </div>
        <div className="mx-auto w-full max-w-2xl px-6 pb-12">
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}
