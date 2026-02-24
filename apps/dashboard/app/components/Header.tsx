/** Displays the top header bar with logo text and workspace label. */
export function Header() {
    return (
        <header className="flex shrink-0 items-center gap-4 border-b border-white/10 px-6 py-5">
            <span className="text-lg font-bold text-white">Clonee</span>
            <div className="h-6 w-px bg-white/10" />
            <span className="text-base font-medium text-white/70">My Workspace</span>
        </header>
    );
}
