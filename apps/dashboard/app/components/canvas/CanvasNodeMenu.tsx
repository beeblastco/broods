"use client";

import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/app/components/ui/context-menu";
import { NODE_TEMPLATES } from "@/app/components/canvas/nodeTemplates";
import type {
  FrameGroupAction,
  NodeLinkAction,
} from "@/app/lib/canvasFrameEdits";
import {
  Group,
  Lock,
  PanelRight,
  Star,
  Trash2,
  Ungroup,
  Unlink,
} from "lucide-react";

const CODE_MANAGED = "managed through code";

/** What one card's menu lists; the canvas builds it on the right-click. */
export type CanvasNodeMenuEntries = {
  nodeId: string;
  links: readonly NodeLinkAction[];
  groups: readonly FrameGroupAction[];
  deleteLocked: boolean;
};

/**
 * What a right-click on a card offers: open its panel, one row per link, the
 * group it is in or was pulled out of, then delete. Links and delete that code
 * owns stay listed with a lock, the mark a locked edge wears, and say why on hover.
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
}: CanvasNodeMenuEntries & {
  onOpen: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onMakeDefault: (agentId: string, sandboxId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
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
