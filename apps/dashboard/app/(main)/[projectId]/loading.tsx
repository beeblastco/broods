/** Skeleton shown while the canvas page chunk loads. */
export default function CanvasLoading(): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">Loading canvas…</p>
    </div>
  );
}
