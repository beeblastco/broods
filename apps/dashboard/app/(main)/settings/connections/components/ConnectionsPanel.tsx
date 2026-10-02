"use client";

import { ChatGPTLogo } from "@/app/components/ChatGPTLogo";
import { CopyRow } from "@/app/components/CopyButton";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { IconTooltip } from "@/app/components/IconTooltip";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { api } from "@broods/convex/_generated/api";
import {
  CONNECTION_TYPE_NAMES,
  CONNECTION_TYPES,
  type ConnectionType,
} from "@broods/convex/model/connections";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Trash2 } from "lucide-react";
import { useState } from "react";

/** Each type's mark; a new type fails the type check until it has one. */
const LOGOS: Record<
  ConnectionType,
  (props: { className?: string }) => React.JSX.Element
> = {
  chatgpt: ChatGPTLogo,
};

export type Connection = FunctionReturnType<
  typeof api.account.connectionsPublic.list
>[number];

/** The account's connections from Convex, with disconnect behind a confirm. */
export function ConnectionsPanel(): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const connections = useQuery(api.account.connectionsPublic.list, {});
  const disconnect = useMutation(api.account.connectionsPublic.disconnect);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect(): Promise<void> {
    if (!removing) return;
    setIsRemoving(true);
    setError(null);
    try {
      await disconnect({ type: removing.type });
      setRemoving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
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
      {error && <p className="text-xs text-destructive">{error}</p>}

      {removing && (
        <DeleteConfirmDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          resourceName={CONNECTION_TYPES[removing.type].label}
          resourceType="connection"
          critical={false}
          onConfirm={handleDisconnect}
          isDeleting={isRemoving}
        />
      )}
    </>
  );
}

/** Every connection type as a row: signed in, or Connect. Data-free so the UI gallery can render it. */
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
  const [connecting, setConnecting] = useState<ConnectionType | null>(null);
  const byType = new Map(
    connections?.map((connection) => [connection.type, connection]),
  );

  return (
    <Section
      title="Connections"
      description="External accounts your agents act through."
    >
      <div className="grid divide-y rounded-md border">
        {CONNECTION_TYPE_NAMES.map((type): React.JSX.Element => {
          const meta = CONNECTION_TYPES[type];
          const Logo = LOGOS[type];
          const connection = byType.get(type);

          return (
            <div
              key={type}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5"
            >
              <span className="flex size-8 items-center justify-center rounded-md border bg-card text-foreground">
                <Logo className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {meta.label}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {connection
                    ? `Signed in as ${connection.email ?? connection.clientId}`
                    : meta.description}
                </p>
              </div>
              {/* Nothing while loading, so a connected type never flashes Connect. */}
              {connections === undefined ? null : connection ? (
                canWrite && (
                  <IconTooltip label={`Disconnect ${meta.label}`}>
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
                )
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  className="cursor-pointer"
                  onClick={() => setConnecting(type)}
                >
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Closes on its own once the sign-in lands and the row flips. */}
      <Dialog
        open={connecting !== null && !byType.has(connecting)}
        onOpenChange={(open) => {
          if (!open) setConnecting(null);
        }}
      >
        {connecting && <ConnectDialogContent type={connecting} />}
      </Dialog>
    </Section>
  );
}

/** The command that signs a type in; the sign-in itself runs in the CLI's browser flow. */
function ConnectDialogContent({
  type,
}: {
  type: ConnectionType;
}): React.JSX.Element {
  const meta = CONNECTION_TYPES[type];
  const command = `broods connect ${type}`;

  return (
    <DialogContent className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Connect {meta.label}</DialogTitle>
        <DialogDescription>
          Run this in a terminal signed in with broods login. It opens the
          sign-in in your browser, and this list updates when you approve.
        </DialogDescription>
      </DialogHeader>
      <CopyRow
        value={command}
        className="flex w-full rounded-md bg-muted px-3 py-2 font-mono text-xs"
      >
        <span className="flex-1 truncate">{command}</span>
      </CopyRow>
    </DialogContent>
  );
}
