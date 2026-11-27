"use client";

// React Flow turns pointer events off on an edge neither selectable nor clickable, as ours are.
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
