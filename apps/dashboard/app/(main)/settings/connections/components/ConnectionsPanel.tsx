"use client";

import { CopyRow } from "@/app/components/CopyButton";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { IconTooltip } from "@/app/components/IconTooltip";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Label } from "@/app/components/ui/label";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { api } from "@broods/convex/_generated/api";
import {
  CONNECTION_TYPE_NAMES,
  CONNECTION_TYPES,
  connectCommand,
} from "@broods/convex/model/connections";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Trash2 } from "lucide-react";
import { useState } from "react";

export type Connection = FunctionReturnType<
  typeof api.account.connectionsPublic.list
>[number];

/** The account's connections, and the command that adds each type. */
export function ConnectionsPanel(): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const connections = useQuery(api.account.connectionsPublic.list, {});
  const disconnect = useMutation(api.account.connectionsPublic.disconnect);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  async function handleDisconnect(): Promise<void> {
    if (!removing) return;
    setIsRemoving(true);
    try {
      await disconnect({ name: removing.name });
      setRemoving(null);
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <>
      <ConnectionsView
        connections={connections}
        canWrite={canWrite}
        onDisconnect={setRemoving}
      />

      {removing && (
        <DeleteConfirmDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          resourceName={removing.name}
          resourceType="connection"
          critical={false}
          onConfirm={handleDisconnect}
          isDeleting={isRemoving}
        />
      )}
    </>
  );
}

/** The connection rows and connect commands; data-free so the UI gallery can render it. */
export function ConnectionsView({
  connections,
  canWrite,
  onDisconnect,
}: {
  /** Undefined while loading. */
  connections: Connection[] | undefined;
  canWrite: boolean;
  onDisconnect: (connection: Connection) => void;
}): React.JSX.Element {
  return (
    <Section
      title="Connections"
      description="External accounts your agents act through."
    >
      <div className="grid gap-4">
        {connections && connections.length === 0 && (
          <p className="text-sm text-muted-foreground">No connections yet.</p>
        )}
        <div className="grid gap-2">
          {connections?.map((connection) => (
            <div
              key={connection.name}
              className="grid grid-cols-[8rem_7rem_minmax(0,1fr)_auto] items-center gap-2"
            >
              <span className="truncate text-sm font-medium text-foreground">
                {connection.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {CONNECTION_TYPES[connection.type].label}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {connection.email ?? connection.clientId}
              </span>
              {canWrite ? (
                <IconTooltip label={`Disconnect ${connection.name}`}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    tone="muted-destructive"
                    className="cursor-pointer"
                    onClick={() => onDisconnect(connection)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </IconTooltip>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
        <div className="grid gap-2">
          <Label variant="muted">
            Connect one from a terminal signed in with broods login
          </Label>
          {CONNECTION_TYPE_NAMES.map((type): React.JSX.Element => {
            const meta = CONNECTION_TYPES[type];
            const command = connectCommand(type);

            return (
              <div key={type} className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  {meta.description}
                </span>
                <CopyRow
                  value={command}
                  className="flex w-full rounded-md bg-muted px-3 py-2 font-mono text-xs"
                >
                  <span className="flex-1 truncate">{command}</span>
                </CopyRow>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
