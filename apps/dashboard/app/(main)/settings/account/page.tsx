"use client";

import { AccountPanel } from "@/app/(main)/[projectId]/settings/components/AccountPanel";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { ACCOUNT_TABS, pickTab } from "@/app/lib/navigation";
import { api } from "@broods/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toErrorMessage } from "@/app/lib/errors";

export default function AccountSettingsPage(): React.JSX.Element {
  const searchParams = useSearchParams();
  const tab = pickTab(ACCOUNT_TABS, searchParams.get("tab"));

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <h1 className="sr-only">{tab.label}</h1>
      <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
        {tab.id === "profile" && <AccountPanel />}
        {tab.id === "danger" && <AccountDangerPanel />}
      </div>
    </div>
  );
}

function AccountDangerPanel(): React.JSX.Element {
  const currentUser = useQuery(api.user.getCurrent);
  const requestAccountDeletion = useMutation(api.user.requestAccountDeletion);
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const effectiveDeletionAt =
    scheduledAt ?? currentUser?.deletionScheduledFor ?? null;

  async function handleDelete(): Promise<void> {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const result = await requestAccountDeletion({});
      setScheduledAt(result.scheduledFor);
      setDialogOpen(false);
      router.replace("/auth/sign-in");
    } catch (err) {
      setDeleteError(toErrorMessage(err));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <Section
        title="Delete account"
        description="Permanently delete your account and all associated data. This schedules deletion after 7 days."
        danger
      >
        <div className="grid gap-4">
          {effectiveDeletionAt ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
              <p className="text-sm text-foreground">
                Account deletion scheduled for{" "}
                <span className="font-medium">
                  {new Date(effectiveDeletionAt).toLocaleString()}
                </span>
                .
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Contact support within 7 days to restore your account if this
                was accidental.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-6">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Delete account
                </p>
                <p className="text-xs text-muted-foreground">
                  Schedules your account for deletion after a 7-day grace
                  period. Your sign-in identity and all project data will be
                  removed.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0 cursor-pointer"
                onClick={() => {
                  setDeleteError(null);
                  setDialogOpen(true);
                }}
              >
                Delete Account
              </Button>
            </div>
          )}
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
        </div>
      </Section>

      <DeleteConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        resourceName="my account"
        resourceType="account"
        critical={true}
        onConfirm={handleDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}
