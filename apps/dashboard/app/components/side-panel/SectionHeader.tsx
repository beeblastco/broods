/** Side-panel section heading — small caps, muted, matches Agent DetailsTab. */
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
      {children}
    </span>
  );
}
