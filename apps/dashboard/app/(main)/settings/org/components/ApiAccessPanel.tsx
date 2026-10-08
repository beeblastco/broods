"use client";

/**
 * Organization › API access: the keys whose home is the organization. Today
 * that is the account key. Its plaintext is shown exactly once after
 * provision or rotate; only its hash is stored. Admins only; a member sees a
 * lock.
 */

import { CopyButton, CopyRow } from "@/app/components/CopyButton";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFooter,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { EmptyState, NoPermission } from "@/app/components/EmptyState";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Who } from "@/app/components/Who";
import { usePermissions } from "@/app/hooks/usePermissions";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { toErrorMessage } from "@/app/lib/errors";
import { formatDate } from "@/app/lib/formatTime";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";

interface Props {
  org: Doc<"orgs">;
}

export function ApiAccessPanel({ org }: Props): React.JSX.Element {
  const { can } = usePermissions();
  const canWrite = can("keys:write");
  const account = useQuery(api.org.orgs.getActiveAccount, {});
  const keys = useQuery(api.apiKeys.listForOrg, {});
  const provision = useAction(api.org.lifecycle.provision);
  const rotate = useAction(api.org.lifecycle.rotateSecret);
  const endpoint = resolveCoreEndpoint();

  const [revealed, setRevealed] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ secret: string }>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      setRevealed(result.secret);
      setRotateOpen(false);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (account === undefined || keys === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (keys === null) {
    return <NoPermission permission="keys.read" scope="this organization" />;
  }

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <div>
          <h2 className="text-sm font-semibold">API access</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Keys whose home is the organization. Project and stage keys live in
            the project.
          </p>
        </div>
        {account && (
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Account ID</dt>
            <dd className="min-w-0">
              <CopyRow
                value={account.accountId}
                className="flex w-full rounded-md bg-muted px-3 py-2 font-mono text-xs"
              >
                <span className="flex-1 truncate">{account.accountId}</span>
              </CopyRow>
            </dd>
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="min-w-0">
              {endpoint.ok ? (
                <CopyRow
                  value={endpoint.httpBaseUrl}
                  className="flex w-full rounded-md bg-muted px-3 py-2 font-mono text-xs"
                >
                  <span className="flex-1 truncate">
                    {endpoint.httpBaseUrl}
                  </span>
                </CopyRow>
              ) : (
                <span className="text-warning">{endpoint.message}</span>
              )}
            </dd>
          </dl>
        )}
      </section>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Description</DataTableHead>
              <DataTableHead>Policies</DataTableHead>
              <DataTableHead>Key</DataTableHead>
              <DataTableHead>Created at</DataTableHead>
              <DataTableHead>Created by</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {account &&
              keys.map((key) => (
                <DataTableRow key={key.name}>
                  <DataTableCell className="font-medium">
                    {key.name}
                  </DataTableCell>
                  <DataTableCell muted>{key.description}</DataTableCell>
                  <DataTableCell>Admin</DataTableCell>
                  <DataTableCell muted className="font-mono">
                    {key.keyHint ?? "shown once"}
                  </DataTableCell>
                  <DataTableCell muted>
                    {formatDate(key.createdAt)}
                  </DataTableCell>
                  <DataTableCell>
                    <Who
                      actor={
                        key.createdBy
                          ? { kind: "person", ...key.createdBy }
                          : { kind: "platform" }
                      }
                    />
                  </DataTableCell>
                  <DataTableCell align="right">
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        tone="muted"
                        className="cursor-pointer"
                        disabled={pending}
                        onClick={() => setRotateOpen(true)}
                      >
                        Rotate
                      </Button>
                    )}
                  </DataTableCell>
                </DataTableRow>
              ))}
          </DataTableBody>
        </DataTable>
        {!account && (
          <EmptyState
            title="This organization has no API account yet."
            detail="Provisioning creates the backend tenant and issues a one-time account key."
            action={
              canWrite && (
                <Button
                  size="sm"
                  className="cursor-pointer"
                  disabled={pending}
                  onClick={() => run(() => provision({ orgId: org._id }))}
                >
                  {pending ? "Provisioning…" : "Provision account"}
                </Button>
              )
            }
          />
        )}
        <DataTableFooter>
          {account ? `${keys.length} key` : "No account"}
        </DataTableFooter>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate the account key?</DialogTitle>
            <DialogDescription>
              The current key stops working at once. Anything using it needs the
              new one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer"
              onClick={() => setRotateOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="cursor-pointer"
              onClick={() => run(() => rotate({ orgId: org._id }))}
              disabled={pending}
            >
              {pending ? "Rotating…" : "Rotate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {revealed && (
        <NewSecretDialog secret={revealed} onClose={() => setRevealed(null)} />
      )}
    </div>
  );
}

function NewSecretDialog({
  secret,
  onClose,
}: {
  secret: string;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save your new account key</DialogTitle>
          <DialogDescription>
            Copy it now. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1 py-2">
          <Input readOnly value={secret} className="font-mono text-xs" />
          <CopyButton value={secret} label="account key" />
        </div>
        <DialogFooter>
          <Button size="sm" className="cursor-pointer" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
