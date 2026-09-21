"use client";

import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/app/components/ui/context-menu";
import type {
  FrameGroupAction,
  NodeLinkAction,
} from "@/app/lib/canvasFrameEdits";
import { Group, PanelRight, Star, Trash2, Ungroup, Unlink } from "lucide-react";

const CODE_MANAGED = "managed through code";

/**
 * What a right-click on a card offers: open its panel, one row per link, the
 * group it is in or was pulled out of, then delete. Links and delete that code
 * owns stay listed, disabled, so the menu says why they cannot change here.
 * Grouping is canvas layout, not wiring, so it works on a code-managed card too.
 */
export function CanvasNodeMenu({
  nodeId,
  links,
  groups,
  deleteLocked,
  onOpen,
  onDelete,
  onMakeDefault,
  onRemoveEdge,
  onSetUngrouped,
}: {
  nodeId: string;
  links: readonly NodeLinkAction[];
  groups: readonly FrameGroupAction[];
  deleteLocked: boolean;
  onOpen: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onMakeDefault: (agentId: string, sandboxId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onSetUngrouped: (nodeIds: readonly string[], ungrouped: boolean) => void;
}): React.JSX.Element {
  const unlinks = links.filter((link) => link.kind === "unlink");
  const allLocked = unlinks.length > 0 && unlinks.every((link) => link.locked);

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
      </ContextMenuGroup>
      {links.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuLabel variant="muted" className="text-xs">
              {allLocked ? `Links · ${CODE_MANAGED}` : "Links"}
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
                  <Unlink />
                  <span className="min-w-0 truncate">{link.label}</span>
                  <ContextMenuShortcut>
                    {link.locked ? "locked" : link.mount ? "Unmount" : "Unlink"}
                  </ContextMenuShortcut>
                </LockableItem>
              ),
            )}
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
          {deleteLocked && <ContextMenuShortcut>locked</ContextMenuShortcut>}
        </LockableItem>
      </ContextMenuGroup>
    </>
  );
}

/**
 * A menu item that may be refused. A disabled item takes no pointer events, so
 * the not-allowed cursor and the reason's tooltip sit on a wrapper.
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

  return (
    <div className="cursor-not-allowed" title={lockedReason}>
      <ContextMenuItem disabled>{children}</ContextMenuItem>
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
