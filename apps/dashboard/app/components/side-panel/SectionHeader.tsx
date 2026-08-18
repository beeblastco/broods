/** Side-panel section heading — small caps, muted, matches Agent DetailsTab. */
export function SectionHeader({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}
