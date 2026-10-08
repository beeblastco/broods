"use client";

/**
 * Instances are mirrored from broods's runtime into Convex; suspend, resume,
 * terminate and snapshot go through Convex actions that proxy to broods's
 * /v1/sandboxes endpoints.
 */

import { useStage } from "@/app/hooks/useStage";
import { useStageSession } from "@/app/hooks/useStageSession";
import { pickTab, SANDBOX_TABS } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useParams, useSearchParams } from "next/navigation";
import { SandboxInstancesTable } from "./components/SandboxInstancesTable";
import type { SandboxObservabilityScope } from "./components/SandboxLogTail";
import { SandboxPolicyTable } from "./components/SandboxPolicyTable";
import { SandboxSnapshotsTable } from "./components/SandboxSnapshotsTable";

export default function SandboxPage(): React.JSX.Element {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as Id<"projects">;
  const { stageId: activeStageId, stageArgs } = useStage();
  const stages = useQuery(api.stage.list, {
    projectId: projectId,
  }) as Doc<"stages">[] | undefined;
  const instances = useQuery(
    api.sandbox.instances.listForActiveOrg,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );
  const machines = useQuery(api.sandbox.machines.listForActiveOrg, stageArgs);
  const snapshots = useQuery(api.sandbox.snapshots.listForActiveOrg, {});
  const agents = useQuery(api.agent.agents.listForProject, {
    projectId: projectId,
  });
  const account = useQuery(api.org.orgs.getActiveAccount, {});
  const observability = useObservabilityScope(projectId, activeStageId);

  const searchParams = useSearchParams();
  const tab = pickTab(SANDBOX_TABS, searchParams.get("tab"));
  const view = tab.id;
  // The instances view carries a detail column beside a wide table, so it
  // gets the full width the observability tabs get; the rest stay readable.
  const contentWidth = view === "instances" ? "max-w-none" : "max-w-7xl";

  const loading =
    stages === undefined ||
    instances === undefined ||
    machines === undefined ||
    snapshots === undefined ||
    account === undefined;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <h1 className="sr-only">{tab.label}</h1>
      <div
        className={cn(
          "mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 px-6 pt-6 pb-12",
          contentWidth,
        )}
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : !account ? (
          <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Your organization is not provisioned yet. Provision the broods
              account in settings before using sandboxes.
            </p>
          </div>
        ) : view === "instances" ? (
          <SandboxInstancesTable
            instances={instances}
            machines={machines}
            agents={agents ?? []}
            projectId={projectId}
            observability={observability}
          />
        ) : view === "snapshots" ? (
          <SandboxSnapshotsTable projectId={projectId} snapshots={snapshots} />
        ) : view === "security" ? (
          <SandboxPolicyTable instances={instances} dimension="security" />
        ) : (
          <SandboxPolicyTable instances={instances} dimension="networking" />
        )}
      </div>
    </div>
  );
}

/**
 * The instance panel's Logs tab streams over the same gateway socket as the
 * Monitoring tab: the stage's slugs from its deployment plus a short-lived
 * stage session any member can mint, so the permanent runtime key never has to
 * reach this page.
 */
function useObservabilityScope(
  projectId: Id<"projects">,
  stageId: Id<"stages"> | null,
): SandboxObservabilityScope | null {
  const deployment = useQuery(
    api.agent.deployments.getForStage,
    stageId ? { projectId: projectId, stageId: stageId } : "skip",
  );
  const session = useStageSession(projectId, stageId);

  return deployment
    ? {
        projectSlug: deployment.projectSlug,
        stageSlug: deployment.stageSlug,
        apiKey: session ?? undefined,
      }
    : null;
}
