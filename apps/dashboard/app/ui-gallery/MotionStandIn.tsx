"use client";

import { IconTooltip } from "@/app/components/IconTooltip";
import { SidePanelSlot } from "@/app/components/canvas/SidePanelSlot";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/app/components/ui/sheet";
import { useHydrated } from "@/app/hooks/useHydrated";
import { ReactFlow, type Node } from "@xyflow/react";
import { Info, X } from "lucide-react";
import { useState } from "react";

type CardNode = Node<{ label: string }>;

const CARDS: CardNode[] = [
  { id: "support", position: { x: 0, y: 0 }, data: { label: "support-agent" } },
  { id: "files", position: { x: 240, y: 0 }, data: { label: "files" } },
];

export function MotionStandIn(): React.JSX.Element {
  const [selected, setSelected] = useState<CardNode | null>(null);
  const hydrated = useHydrated();

  return (
    <main
      data-hydrated={hydrated ? "true" : undefined}
      className="flex h-svh flex-col"
    >
      <nav aria-label="Motion" className="flex items-center gap-2 border-b p-2">
        {CARDS.map((card) => (
          <Button
            key={card.id}
            size="sm"
            variant="outline"
            data-open={card.id}
            onClick={() => setSelected(card)}
          >
            Open {card.data.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          data-close=""
          onClick={() => setSelected(null)}
        >
          Close panel
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="outline">
                Menu
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconTooltip label="About this fixture">
          <Button size="icon-xs" variant="ghost">
            <Info />
          </Button>
        </IconTooltip>
        <Dialog>
          <DialogTrigger
            render={
              <Button size="sm" variant="outline">
                Dialog
              </Button>
            }
          />
          <DialogContent>
            <DialogTitle>Delete support-agent</DialogTitle>
            <DialogDescription>It stops answering at once.</DialogDescription>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger
            render={
              <Button size="sm" variant="outline">
                Sheet
              </Button>
            }
          />
          <SheetContent>
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>The sidebar on a phone.</SheetDescription>
          </SheetContent>
        </Sheet>
      </nav>
      <div
        data-fixture="side-panel-motion"
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        <div data-canvas="" className="relative h-full min-w-0 flex-1">
          <ReactFlow
            nodes={CARDS}
            edges={[]}
            fitView
            onNodeClick={(_event, node) => setSelected(node)}
            onPaneClick={() => setSelected(null)}
          />
        </div>
        <SidePanelSlot node={selected}>
          {(card) => (
            <div className="flex h-full w-full flex-col border-l bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-medium">{card?.data.label}</h2>
                <IconTooltip label="Close panel">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setSelected(null)}
                  >
                    <X />
                  </Button>
                </IconTooltip>
              </div>
              <div className="px-4">
                <Input aria-label="Message" placeholder="Ask the agent" />
              </div>
            </div>
          )}
        </SidePanelSlot>
      </div>
    </main>
  );
}
