export function SectionHeader({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="text-2xs uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}
