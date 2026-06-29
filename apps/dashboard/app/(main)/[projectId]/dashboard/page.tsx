"use client";

/** Dashboard page with sidebar navigation and a titled content panel. */
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { BillingPanel } from "./components/BillingPanel";
import { MonitoringPanel } from "./components/MonitoringPanel";
import { ObservabilityKeyPrompt } from "./components/ObservabilityKeyPrompt";
import { RuntimeKeyDialog, RuntimeKeyView } from "./components/RuntimeKeyDialog";
import { TokensUsagePanel } from "./components/TokensUsagePanel";
import { TracingPanel } from "./components/TracingPanel";

const TABS = [
  { id: "monitoring", label: "Monitoring" },
  { id: "tracing", label: "Tracing" },
  { id: "usage", label: "Usage" },
  { id: "billing", label: "Billing & Plan" },
  { id: "api-key", label: "API key" },
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

  // Fetch the active deployment to get projectSlug, environmentSlug, and endpointId
  // for the observability WS and session-storage API key lookup.
  const activeDeployment = useQuery(
    api.agentDeployments.getForEnvironment,
    activeEnvId ? { projectId: projectId, environmentId: activeEnvId } : "skip",
  );

  const ensureKey = useMutation(api.agentDeployments.ensureForEnvironment);
  const rotateKey = useMutation(api.agentDeployments.rotate);
  // A key just minted in this view, scoped to its endpoint so switching
  // environments never serves the wrong environment's key.
  const [generated, setGenerated] = useState<{ endpointId: string; key: string } | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  // Scoped to the env it occurred in so a stale error never leaks onto another
  // environment after switching.
  const [keyError, setKeyError] = useState<{ envId: string; msg: string } | null>(null);
  // Reveal dialog (key + SDK usage). `justCreated` reframes it right after a mint.
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyJustCreated, setKeyJustCreated] = useState(false);

  // The key is stored encrypted at rest, so the owner recovers it here without
  // re-minting — logs/traces just stream. Null only when the environment has no
  // deployment yet (the prompt then mints one).
  const revealedKey = useQuery(
    api.agentDeployments.revealKeyForEnvironment,
    activeEnvId ? { projectId: projectId, environmentId: activeEnvId } : "skip",
  );
  const observabilityApiKey =
    (generated && generated.endpointId === activeDeployment?.endpointId ? generated.key : undefined) ??
    revealedKey;
  const currentKeyError = keyError && keyError.envId === activeEnvId ? keyError.msg : null;

  // Mint the environment's runtime key from the dashboard so a dashboard-first user
  // (project created here, never through the CLI) can stream logs/traces. `ensure`
  // creates one on first call and recovers it thereafter.
  const generateViewingKey = useCallback(
    async () => {
      if (!activeEnvId) return;
      setGeneratingKey(true);
      setKeyError(null);
      try {
        const result = await ensureKey({ projectId: projectId, environmentId: activeEnvId });
        if (result.rawApiKey) {
          setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
          // Surface the key + SDK usage immediately so a dashboard-first user knows
          // how to wire it into their code, not just that streaming now works.
          setKeyJustCreated(true);
          setKeyDialogOpen(true);
        } else {
          setKeyError({ envId: activeEnvId, msg: "Couldn't load the key — try again." });
        }
      } catch (err) {
        setKeyError({ envId: activeEnvId, msg: err instanceof Error ? err.message : "Failed to generate key" });
      } finally {
        setGeneratingKey(false);
      }
    },
    [activeEnvId, projectId, ensureKey],
  );

  // Rotate the environment's runtime key, surfacing the new plaintext immediately
  // through the same `generated` channel the mint flow uses. Rethrows so the
  // Rotate control can show the failure inline.
  const rotateViewingKey = useCallback(
    async () => {
      if (!activeEnvId) return;
      const result = await rotateKey({ projectId: projectId, environmentId: activeEnvId });
      if (result.rawApiKey) {
        setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
      }
    },
    [activeEnvId, projectId, rotateKey],
  );

  const projectSlug = activeDeployment?.projectSlug;
  const environmentSlug = activeDeployment?.environmentSlug;

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
  // Monitoring and tracing are dense, scroll-internally panels that should fill
  // the viewport width and height; billing stays narrow; usage keeps the chart width.
  const isObservabilityTab = activeTab === "monitoring" || activeTab === "tracing";
  const contentMaxWidth = activeTab === "billing" || activeTab === "api-key"
    ? "max-w-2xl"
    : isObservabilityTab
      ? "max-w-none"
      : "max-w-7xl";

  // While the reveal query is still resolving, hold a quiet loader instead of
  // flashing the "generate a key" prompt — the prompt is only the true-absence state.
  const keyResolving = Boolean(activeEnvId) && revealedKey === undefined && !observabilityApiKey;
  const observabilityFallback = keyResolving ? (
    <div className="flex h-full min-h-64 items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
  ) : (
    <ObservabilityKeyPrompt
      generating={generatingKey}
      error={currentKeyError}
      onGenerate={generateViewingKey}
    />
  );

  const renderPanel = () => {
    switch (activeTab) {
      case "monitoring":
        return observabilityApiKey ? (
          <MonitoringPanel
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
      case "tracing":
        return observabilityApiKey ? (
          <TracingPanel
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
      case "usage":
        return (
          <TokensUsagePanel
            projectId={projectId}
            environmentId={activeEnvId}
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            apiKey={observabilityApiKey ?? undefined}
          />
        );
      case "billing":
        return <BillingPanel projectId={projectId} />;
      case "api-key":
        return observabilityApiKey ? (
          <RuntimeKeyView apiKey={observabilityApiKey} onRotate={rotateViewingKey} />
        ) : (
          observabilityFallback
        );
      default:
        return observabilityApiKey ? (
          <MonitoringPanel
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
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

      {/* Content area — observability tabs own their internal scroll and fill
          the height; other tabs scroll the whole column. */}
      <div
        className={cn(
          "flex flex-1 flex-col",
          isObservabilityTab ? "overflow-hidden" : "overflow-auto",
        )}
      >
        {/* Page title — aligned with sidebar header height */}
        <div
          className={cn(
            "px-6 pt-9.25 pb-5 mx-auto w-full shrink-0",
            contentMaxWidth,
          )}
        >
          <h2 className="text-xl font-semibold text-foreground">
            {activeLabel}
          </h2>
        </div>
        <div
          className={cn(
            "mx-auto w-full px-6",
            contentMaxWidth,
            isObservabilityTab ? "flex min-h-0 flex-1 flex-col pb-6" : "pb-12",
          )}
        >
          {renderPanel()}
        </div>
      </div>

      {observabilityApiKey && (
        <RuntimeKeyDialog
          open={keyDialogOpen}
          onOpenChange={setKeyDialogOpen}
          apiKey={observabilityApiKey}
          justCreated={keyJustCreated}
        />
      )}
    </div>
  );
}
