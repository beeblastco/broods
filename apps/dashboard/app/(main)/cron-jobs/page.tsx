"use client";

/**
 * Cron jobs management page. Lists the active org's scheduled agent runs and
 * lets the user create, edit, and remove them. CRUD goes through Convex
 * actions that proxy to filthy-panty's /accounts/me/cron-jobs HTTP endpoints
 * to keep EventBridge Scheduler in sync.
 */

import { Button } from "@/app/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { CronJobDialog } from "./components/CronJobDialog";
import { CronJobsTable } from "./components/CronJobsTable";

export default function CronJobsPage() {
    const cronJobs = useQuery(api.cronJobs.listForActiveOrg, {});
    const agents = useQuery(api.agents.listForActiveOrg, {});
    const account = useQuery(api.org.getActiveAccount, {});

    const [createOpen, setCreateOpen] = useState(false);

    const loading = cronJobs === undefined || agents === undefined || account === undefined;

    return (
        <div className="mx-auto w-full max-w-5xl px-8 pt-9 pb-12">
            <div className="flex items-center justify-between pb-6">
                <div>
                    <h2 className="text-xl font-semibold text-foreground">Cron jobs</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Scheduled agent runs powered by AWS EventBridge Scheduler.
                    </p>
                </div>
                <Button
                    size="sm"
                    className="cursor-pointer disabled:cursor-not-allowed"
                    disabled={!account || account.status !== "active"}
                    onClick={() => setCreateOpen(true)}
                >
                    <Plus className="size-4 mr-1" />
                    New cron job
                </Button>
            </div>

            {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
            ) : !account ? (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        Your organization is not provisioned yet. Provision the filthy-panty
                        account in settings before creating cron jobs.
                    </p>
                </div>
            ) : cronJobs.length === 0 ? (
                <div className="rounded-lg border border-border bg-card px-4 py-10 text-center">
                    <p className="text-sm text-foreground">No scheduled jobs yet.</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Create one to run an agent on a recurring schedule.
                    </p>
                    <Button
                        size="sm"
                        className="mt-4 cursor-pointer"
                        onClick={() => setCreateOpen(true)}
                    >
                        <Plus className="size-4 mr-1" />
                        Create your first cron job
                    </Button>
                </div>
            ) : (
                <CronJobsTable cronJobs={cronJobs} agents={agents} />
            )}

            {createOpen && (
                <CronJobDialog
                    mode="create"
                    agents={agents ?? []}
                    onClose={() => setCreateOpen(false)}
                />
            )}
        </div>
    );
}
