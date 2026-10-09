"use client";

/**
 * Scoped to the project in the URL rather than the whole org. A cron's project
 * comes from the agent it runs, so the picker and the table only ever show
 * agents this project owns.
 */

import { EmptyState } from "@/app/components/EmptyState";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { use, useState } from "react";
import { CronDialog } from "./components/CronDialog";
import { CronsTable } from "./components/CronsTable";

export default function CronsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const { projectId } = use(params);
  const typedProjectId = projectId as Id<"projects">;

  const crons = useQuery(api.agent.crons.listForProject, {
    projectId: typedProjectId,
  });
  const agents = useQuery(api.agent.agents.listForProject, {
    projectId: typedProjectId,
  });
  const account = useQuery(api.org.orgs.getActiveAccount, {});

  const [createOpen, setCreateOpen] = useState(false);
  // A cron runs an agent, so with none in this project the dialog's picker
  // would be empty and the form unsubmittable. Undefined means still loading,
  // which is also not usable yet.
  const canCreate =
    canWrite && account?.status === "active" && Boolean(agents?.length);

  useShortcut("table.create", () => canCreate && setCreateOpen(true));

  const loading =
    crons === undefined || agents === undefined || account === undefined;

  // The list fills the page edge to edge like Monitoring; the states before
  // it have one line or card to show and keep the usual margins.
  const body = (): React.JSX.Element => {
    if (loading) {
      return (
        <p className="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>
      );
    }
    if (!account) {
      return (
        <EmptyState
          title="Your organization is not provisioned yet."
          detail="Provision the broods account in settings before creating schedulers."
        />
      );
    }
    if (agents.length === 0) {
      return (
        <EmptyState
          title="This project has no agents yet."
          detail="Add an agent on the Architecture canvas before scheduling a run."
        />
      );
    }
    if (crons.length === 0) {
      return (
        <EmptyState
          title="No schedulers yet."
          detail="Create one to run an agent on a recurring schedule."
          action={
            canCreate && (
              <Button
                size="sm"
                className="cursor-pointer"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-4" />
                New scheduler
              </Button>
            )
          }
        />
      );
    }

    return (
      <CronsTable
        projectId={typedProjectId}
        crons={crons}
        agents={agents}
        onCreate={canCreate ? () => setCreateOpen(true) : undefined}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <h1 className="sr-only">Scheduler</h1>
      {body()}

      {createOpen && (
        <CronDialog
          mode="create"
          agents={agents ?? []}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
