"use client";

/**
 * Renders this project's cron jobs with per-row edit and delete actions.
 * Delete is a typed-confirm modal; edit opens the shared CronDialog in edit
 * mode.
 */

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { CronDialog } from "./CronDialog";

interface Props {
  /** Cron job rows from Convex. */
  crons: Array<Doc<"crons">>;
  /** Agents available in the active org. */
  agents: Array<Doc<"agents">>;
}

function relativeTime(ts: number | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusBadge(status: Doc<"crons">["lastStatus"]) {
  if (!status)
    return (
      <Badge variant="secondary" className="text-xs">
        never run
      </Badge>
    );
  if (status === "completed")
    return <Badge className="text-xs">completed</Badge>;
  if (status === "started")
    return (
      <Badge variant="secondary" className="text-xs">
        running
      </Badge>
    );
  return (
    <Badge variant="destructive" className="text-xs">
      failed
    </Badge>
  );
}

export function CronsTable({ crons, agents }: Props) {
  const remove = useAction(api.cronPublic.remove);

  const [editing, setEditing] = useState<Doc<"crons"> | null>(null);
  const [deleting, setDeleting] = useState<Doc<"crons"> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentNameById = new Map(agents.map((a) => [a._id, a.name]));

  async function handleDelete() {
    if (!deleting) return;
    setPending(true);
    setError(null);
    try {
      await remove({ cronId: deleting._id });
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">Agent</th>
              <th className="px-4 py-2 text-left font-medium">Schedule</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-left font-medium">Last run</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {crons.map((job) => (
              <tr key={job._id} className="border-t border-border">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-foreground">{job.name}</div>
                  {job.description && (
                    <div className="text-xs text-muted-foreground">
                      {job.description}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {agentNameById.get(job.agentId) ?? (
                    <span className="text-muted-foreground">(unknown)</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <code className="font-mono text-xs">
                    {job.scheduleExpression}
                  </code>
                  {job.timezone && (
                    <div className="text-xs text-muted-foreground">
                      {job.timezone}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        job.status === "active" ? "default" : "secondary"
                      }
                      className="text-xs"
                    >
                      {job.status}
                    </Badge>
                    {statusBadge(job.lastStatus)}
                  </div>
                  {job.lastError && (
                    <div
                      title={job.lastError}
                      className="mt-1 max-w-xs truncate text-xs text-destructive"
                    >
                      {job.lastError}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {relativeTime(job.lastInvokedAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${job.name}`}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => setEditing(job)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${job.name}`}
                    className="cursor-pointer text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      setError(null);
                      setDeleting(job);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <CronDialog
          mode="edit"
          cron={editing}
          agents={agents}
          onClose={() => setEditing(null)}
        />
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {deleting && (
        <DeleteConfirmDialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          resourceName={deleting.name}
          resourceType="cron job"
          critical={false}
          onConfirm={handleDelete}
          isDeleting={pending}
        />
      )}
    </>
  );
}
