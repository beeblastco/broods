"use client";

import { useReactFlow } from "@xyflow/react";

/** Zoom and fit-view controls for the canvas. */
export function CanvasControls() {
    const { zoomIn, zoomOut, fitView } = useReactFlow();
    const btn =
        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

    return (
        <div className="flex flex-col rounded-lg border border-border bg-card/80 p-0.5 backdrop-blur-md">
            <button onClick={() => zoomIn()} className={btn}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
            </button>
            <button onClick={() => zoomOut()} className={btn}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M2.5 7h9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
            </button>
            <div className="mx-1.5 my-0.5 border-t border-border" />
            <button onClick={() => fitView()} className={btn}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M1.5 5V2.5a1 1 0 011-1H5M9 1.5h2.5a1 1 0 011 1V5M12.5 9v2.5a1 1 0 01-1 1H9M5 12.5H2.5a1 1 0 01-1-1V9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
        </div>
    );
}
