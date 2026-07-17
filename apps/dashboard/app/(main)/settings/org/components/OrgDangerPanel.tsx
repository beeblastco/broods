"use client";

/**
 * Org danger panel: typed-confirm delete that cascades to backend accounts
 * and all broods data owned by this org.
 */

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  /** The org being deleted. */
  org: Doc<"orgs">;
}

export function OrgDangerPanel({ org }: Props) {
  const router = useRouter();
  const removeOrg = useMutation(api.org.remove);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await removeOrg({ orgId: org._id });
      setDeleteOpen(false);
      router.replace("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <>
      <Section
        title="Delete organization"
        description="Permanently removes this org, its members, and all backend data."
        danger
      >
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="text-sm font-medium text-foreground">
              Delete organization
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              This deletes the broods account, agents, conversations, and
              scheduled jobs. The action cannot be undone.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="cursor-pointer"
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            Delete
          </Button>
        </div>
        {deleteError && (
          <p className="text-xs text-destructive">{deleteError}</p>
        )}
      </Section>

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        resourceName={org.name}
        resourceType="organization"
        critical={true}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </>
  );
}
