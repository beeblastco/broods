"use client";

/**
 * Wraps an edge's line so hovering anywhere along it reveals the edge's lock or
 * trash, not only the spot at its midpoint. Takes stroke hits itself: React Flow
 * turns pointer events off on an edge that is neither selectable nor clickable,
 * which every drawn edge is.
 */
export function EdgeHoverLine({
  children,
  onHoverChange,
}: {
  children: React.ReactNode;
  onHoverChange: (hovered: boolean) => void;
}): React.JSX.Element {
  return (
    <g
      className="[pointer-events:visibleStroke]"
      onMouseEnter={(): void => onHoverChange(true)}
      onMouseLeave={(): void => onHoverChange(false)}
    >
      {children}
    </g>
  );
}
