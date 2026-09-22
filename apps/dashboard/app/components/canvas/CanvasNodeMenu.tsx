"use client";

import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/app/components/ui/context-menu";
import { FIXED_MOUNT_ROWS } from "@/app/components/canvas/MountStateLabel";
import { NODE_TEMPLATES } from "@/app/components/canvas/nodeTemplates";
import type {
  FrameGroupAction,
  NodeLinkAction,
  WorkspaceMountTarget,
} from "@/app/lib/canvasFrameEdits";
import {
  Box,
  Group,
  Lock,
  PanelRight,
  Pencil,
  Star,
  Trash2,
  Ungroup,
  Unlink,
} from "lucide-react";

const CODE_MANAGED = "managed through code";

/** What one card's menu lists; the canvas builds it on the right-click. */
export type CanvasNodeMenuEntries = {
  nodeId: string;
  label: string;
  links: readonly NodeLinkAction[];
  groups: readonly FrameGroupAction[];
  /** Where this card can mount; only a workspace the canvas owns has any. */
  mounts: readonly WorkspaceMountTarget[];
  deleteLocked: boolean;
};

/**
 * What a right-click on a card offers: open its panel, rename it, one row per
 * link, where a workspace mounts, the group it is in or was pulled out of, then
 * delete. Links and delete that code owns stay listed with a lock, the mark a
 * locked edge wears, and say why on hover. Grouping is canvas layout, not
 * wiring, so it works on a code-managed card too.
 */
export function CanvasNodeMenu({
  nodeId,
  label,
  links,
  groups,
  mounts,
  deleteLocked,
  onOpen,
  onDelete,
  onMakeDefault,
  onRemoveEdge,
  onRename,
  onSetMount,
  onSetUngrouped,
}: CanvasNodeMenuEntries & {
  onOpen: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onMakeDefault: (agentId: string, sandboxId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onRename: (nodeId: string, label: string) => void;
  onSetMount: (workspaceId: string, target: WorkspaceMountTarget) => void;
  onSetUngrouped: (nodeIds: readonly string[], ungrouped: boolean) => void;
}): React.JSX.Element {
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuItem
          className="cursor-pointer"
          onClick={() => onOpen(nodeId)}
        >
          <PanelRight />
          Open
        </ContextMenuItem>
        <ContextMenuItem
          className="cursor-pointer"
          onClick={() => onRename(nodeId, label)}
        >
          <Pencil />
          Rename
        </ContextMenuItem>
      </ContextMenuGroup>
      {links.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuLabel variant="muted" className="text-xs">
              Links
            </ContextMenuLabel>
            {links.map((link) =>
              link.kind === "make-default" ? (
                <LockableItem
                  key={`default:${link.agentId}`}
                  lockedReason={link.disabledReason}
                  onClick={() => onMakeDefault(link.agentId, nodeId)}
                >
                  <Star />
                  <span className="flex flex-col">
                    {link.agentLabel
                      ? `Make default for ${link.agentLabel}`
                      : "Make default"}
                    {link.disabledReason && (
                      <span className="text-2xs text-muted-foreground">
                        {link.disabledReason}
                      </span>
                    )}
                  </span>
                </LockableItem>
              ) : (
                <LockableItem
                  key={`unlink:${link.edgeId}`}
                  lockedReason={link.locked ? CODE_MANAGED : null}
                  onClick={() => onRemoveEdge(link.edgeId)}
                >
                  <LinkIcon otherType={link.otherType} />
                  <span className="min-w-0 truncate">{link.label}</span>
                  {!link.locked && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {link.mount ? "Unmount" : "Unlink"}
                    </span>
                  )}
                </LockableItem>
              ),
            )}
          </ContextMenuGroup>
        </>
      )}
      {mounts.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuLabel variant="muted" className="text-xs">
              Mounts on
            </ContextMenuLabel>
            {mounts.map((target) => {
              const row =
                target.kind === "sandbox"
                  ? { icon: Box, label: target.label }
                  : FIXED_MOUNT_ROWS[target.kind];
              const Icon = row.icon;

              return (
                <ContextMenuItem
                  key={
                    target.kind === "sandbox" ? target.sandboxId : target.kind
                  }
                  data-active={target.current}
                  className="cursor-pointer"
                  onClick={() => onSetMount(nodeId, target)}
                >
                  <Icon />
                  <span className="min-w-0 truncate">{row.label}</span>
                </ContextMenuItem>
              );
            })}
          </ContextMenuGroup>
        </>
      )}
      {groups.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuLabel variant="muted" className="text-xs">
              Group · {groups[0].frameLabel}
            </ContextMenuLabel>
            {groups.map((action) => (
              <ContextMenuItem
                key={action.kind}
                className="cursor-pointer"
                onClick={() =>
                  onSetUngrouped(action.nodeIds, action.kind !== "rejoin")
                }
              >
                {action.kind === "rejoin" ? <Group /> : <Ungroup />}
                {groupActionLabel(action)}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <LockableItem
          lockedReason={deleteLocked ? CODE_MANAGED : null}
          variant="destructive"
          onClick={() => onDelete(nodeId)}
        >
          <Trash2 />
          Delete
        </LockableItem>
      </ContextMenuGroup>
    </>
  );
}

/** The linked card's icon, or the broken chain for a type the canvas has no card for. */
function LinkIcon({
  otherType,
}: {
  otherType: string | undefined;
}): React.JSX.Element {
  const Icon =
    NODE_TEMPLATES.find((item) => item.type === otherType)?.icon ?? Unlink;

  return <Icon />;
}

/**
 * A menu item that may be refused. A disabled item takes no pointer events, so
 * the not-allowed cursor and the reason's tooltip sit on a wrapper. One that
 * code owns keeps its full colour and trails a lock, with the reason spelled
 * out for a screen reader since the icon is hidden from it; any other refusal fades.
 */
function LockableItem({
  lockedReason,
  variant,
  onClick,
  children,
}: {
  lockedReason: string | null;
  variant?: "default" | "destructive";
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  if (lockedReason === null) {
    return (
      <ContextMenuItem
        className="cursor-pointer"
        variant={variant}
        onClick={onClick}
      >
        {children}
      </ContextMenuItem>
    );
  }
  const codeOwned = lockedReason === CODE_MANAGED;

  return (
    <div className="cursor-not-allowed" title={lockedReason}>
      <ContextMenuItem disabled variant={codeOwned ? "locked" : "default"}>
        {children}
        {codeOwned && (
          <>
            <Lock className="ml-auto size-3.5" />
            <span className="sr-only">{lockedReason}</span>
          </>
        )}
      </ContextMenuItem>
    </div>
  );
}

function groupActionLabel(action: FrameGroupAction): string {
  if (action.kind === "rejoin") return `Return to ${action.frameLabel}`;
  if (action.kind === "ungroup-all") {
    return `Ungroup all ${action.nodeIds.length}`;
  }

  return "Pull out of group";
}
