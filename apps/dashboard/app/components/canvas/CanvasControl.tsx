"use client";

import { Button } from "@/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { useReactFlow } from "@xyflow/react";
import type { ReactNode } from "react";

/**
 * How the canvas frames the whole architecture, on first paint and on every
 * press of the fit-view control. ReactFlow reads a bare `padding` number as a
 * fraction of the viewport, so 0.1 leaves a tenth of the frame as margin and
 * the architecture fills the rest. `maxZoom` caps how far a one-node stage
 * blows its card up.
 */
export const FIT_VIEW_OPTIONS = { maxZoom: 1.5, padding: 0.1 } as const;

/** Top-left corners of the four cells in the tidy icon's 2x2 grid. */
const TIDY_ICON_CELLS = [
  { x: 1.5, y: 1.5 },
  { x: 8, y: 1.5 },
  { x: 1.5, y: 8 },
  { x: 8, y: 8 },
];

export function CanvasControls({
  onTidy,
}: {
  onTidy: () => void;
}): React.JSX.Element {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <TooltipProvider>
      <div className="flex flex-col rounded-lg border border-border bg-card/80 p-0.5 backdrop-blur-md">
        <ControlButton label="Zoom in" onClick={() => zoomIn()}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2.5v9M2.5 7h9"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </ControlButton>
        <ControlButton label="Zoom out" onClick={() => zoomOut()}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M2.5 7h9"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </ControlButton>
        <div className="mx-1.5 my-0.5 border-t border-border" />
        <ControlButton
          label="Center the whole architecture"
          onClick={() => fitView(FIT_VIEW_OPTIONS)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M1.5 5V2.5a1 1 0 011-1H5M9 1.5h2.5a1 1 0 011 1V5M12.5 9v2.5a1 1 0 01-1 1H9M5 12.5H2.5a1 1 0 01-1-1V9"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ControlButton>
        <ControlButton
          label="Tidy up: re-lay out every node by its wiring"
          onClick={onTidy}
        >
          {/* Stroke is set once here; SVG presentation attributes inherit. */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          >
            {TIDY_ICON_CELLS.map(({ x, y }) => (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width="4.5"
                height="4.5"
                rx="1"
              />
            ))}
          </svg>
        </ControlButton>
      </div>
    </TooltipProvider>
  );
}

/** One icon control; the label is both its tooltip and its accessible name. */
function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 cursor-pointer"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
