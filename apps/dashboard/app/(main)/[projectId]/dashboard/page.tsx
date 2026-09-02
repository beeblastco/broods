"use client";

/** Dashboard page with sidebar navigation and a titled content panel. */
import { Button } from "@/app/components/ui/button";
import { useStage } from "@/app/hooks/useStage";
import { useStageSession } from "@/app/hooks/useStageSession";
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
import {
  RuntimeKeyDialog,
  RuntimeKeyView,
} from "./components/RuntimeKeyDialog";
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

export default function DashboardPage(): React.JSX.Element {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  const project = useQuery(api.project.getById, { projectId: projectId });
  const { stageId } = useStage();
  const stages = useQuery(api.stage.list, {
    projectId: projectId,
  }) as Doc<"stages">[] | undefined;
  const activeTab = (searchParams.get("tab") as DashboardTab) || "monitoring";

  // Build a tab href that preserves the current params (e.g. ?stage=) so the link is shareable
  // and can be opened in a new browser tab.
  const tabHref = (tabId: DashboardTab) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tabId);

    return `/${projectId}/dashboard?${next.toString()}`;
  };

  // Resolve the stage to scope analytics to: URL selection, else default, else first.
  const activeStage =
    stages?.find((stage) => stage._id === stageId) ??
    stages?.find((stage) => stage.isDefault) ??
    stages?.[0] ??
    null;
  const activeStageId = activeStage?._id ?? null;

  // Fetch the active deployment to get projectSlug, stageSlug, and endpointId
  // for the observability WS and session-storage API key lookup.
  const activeDeployment = useQuery(
    api.agent.deployments.getForStage,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );

  const ensureKey = useMutation(api.agent.deployments.ensureForStage);
  const rotateKey = useMutation(api.agent.deployments.rotate);
  // A key just minted in this view, scoped to its endpoint so switching
  // stages never serves the wrong stage's key.
  const [generated, setGenerated] = useState<{
    endpointId: string;
    key: string;
  } | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  // Scoped to the stage it occurred in so a stale error never leaks onto another
  // stage after switching.
  const [keyError, setKeyError] = useState<{
    stageId: string;
    msg: string;
  } | null>(null);
  // Reveal dialog (key + SDK usage). `justCreated` reframes it right after a mint.
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyJustCreated, setKeyJustCreated] = useState(false);

  // Streaming runs on a short-lived stage session any member can mint; null
  // only when the stage has no deployment yet (the prompt then mints one).
  const stageSession = useStageSession(projectId, activeStageId);
  // The permanent key is admin-only and shown solely in the copy dialog.
  const revealedKey = useQuery(
    api.agent.deployments.revealKeyForStage,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );
  const generatedKey =
    generated && generated.endpointId === activeDeployment?.endpointId
      ? generated.key
      : undefined;
  const observabilityApiKey = generatedKey ?? stageSession;
  const copyableKey = generatedKey ?? revealedKey;
  const currentKeyError =
    keyError && keyError.stageId === activeStageId ? keyError.msg : null;

  // Mint the stage's runtime key from the dashboard so a dashboard-first user
  // (project created here, never through the CLI) can stream logs/traces. `ensure`
  // creates one on first call and recovers it thereafter.
  const generateViewingKey = useCallback(async () => {
    if (!activeStageId) return;
    setGeneratingKey(true);
    setKeyError(null);
    try {
      const result = await ensureKey({
        projectId: projectId,
        stageId: activeStageId,
      });
      if (result.rawApiKey) {
        setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
        // Surface the key + SDK usage immediately so a dashboard-first user knows
        // how to wire it into their code, not just that streaming now works.
        setKeyJustCreated(true);
        setKeyDialogOpen(true);
      } else {
        setKeyError({
          stageId: activeStageId,
          msg: "Couldn't load the key. Try again.",
        });
      }
    } catch (err) {
      setKeyError({
        stageId: activeStageId,
        msg: err instanceof Error ? err.message : "Failed to generate key",
      });
    } finally {
      setGeneratingKey(false);
    }
  }, [activeStageId, projectId, ensureKey]);

  // Rotate the stage's runtime key, surfacing the new plaintext immediately
  // through the same `generated` channel the mint flow uses. Rethrows so the
  // Rotate control can show the failure inline.
  const rotateViewingKey = useCallback(async () => {
    if (!activeStageId) return;
    const result = await rotateKey({
      projectId: projectId,
      stageId: activeStageId,
    });
    if (result.rawApiKey) {
      setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
    }
  }, [activeStageId, projectId, rotateKey]);

  const projectSlug = activeDeployment?.projectSlug;
  const stageSlug = activeDeployment?.stageSlug;

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
  const isObservabilityTab =
    activeTab === "monitoring" || activeTab === "tracing";
  const contentMaxWidth =
    activeTab === "billing" || activeTab === "api-key"
      ? "max-w-2xl"
      : isObservabilityTab
        ? "max-w-none"
        : "max-w-7xl";

  // While the reveal query is still resolving, hold a quiet loader instead of
  // flashing the "generate a key" prompt — the prompt is only the true-absence state.
  const keyResolving =
    Boolean(activeStageId) &&
    stageSession === undefined &&
    !observabilityApiKey;
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
            stageSlug={stageSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
      case "tracing":
        return observabilityApiKey ? (
          <TracingPanel
            projectSlug={projectSlug}
            stageSlug={stageSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
      case "usage":
        return (
          <TokensUsagePanel
            projectId={projectId}
            stageId={activeStageId}
            projectSlug={projectSlug}
            stageSlug={stageSlug}
            apiKey={observabilityApiKey ?? undefined}
          />
        );
      case "billing":
        return <BillingPanel projectId={projectId} />;
      case "api-key":
        return copyableKey ? (
          <RuntimeKeyView apiKey={copyableKey} onRotate={rotateViewingKey} />
        ) : observabilityApiKey ? (
          <p className="text-sm text-muted-foreground">
            Only an org admin can reveal the runtime key.
          </p>
        ) : (
          observabilityFallback
        );
      default:
        return observabilityApiKey ? (
          <MonitoringPanel
            projectSlug={projectSlug}
            stageSlug={stageSlug}
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
              nativeButton={false}
              render={<Link href={tabHref(t.id)} />}
              variant="ghost"
              size="sm"
              className={cn(
                "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70",
                activeTab === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {t.label}
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

      {copyableKey && (
        <RuntimeKeyDialog
          open={keyDialogOpen}
          onOpenChange={setKeyDialogOpen}
          apiKey={copyableKey}
          justCreated={keyJustCreated}
        />
      )}
    </div>
  );
}
