/** Skeleton shown while the canvas page chunk loads. */
export default function CanvasLoading() {
    return (
        <div className="flex h-full w-full items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                <p className="text-sm text-muted-foreground">Loading canvas…</p>
            </div>
        </div>
    );
}
