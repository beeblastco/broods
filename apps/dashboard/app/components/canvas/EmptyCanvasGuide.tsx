"use client";

/** Empty state panel that guides users to create their first agent service. */
import { FileDown, FilePlus, GitBranch, LayoutTemplate } from "lucide-react";

const CREATION_OPTIONS = [
    { key: "github", label: "From GitHub", icon: GitBranch },
    { key: "template", label: "From templates", icon: LayoutTemplate },
    { key: "import", label: "Import config file", icon: FileDown },
    { key: "create", label: "Create new config file", icon: FilePlus },
] as const;

/** Empty state panel that guides users to create their first agent service. */
export function EmptyCanvasGuide() {
    return (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="pointer-events-auto flex w-72 flex-col rounded-xl border border-white/10 bg-[#141414]/80 p-1 backdrop-blur-md">
                <h3 className="mb-1 mt-3 px-3 text-sm font-medium text-white/80">
                    Create your first agent service
                </h3>
                <p className="mb-4 px-3 text-xs text-white/40">
                    Pick a method to get started
                </p>
                <div className="flex flex-col">
                    {CREATION_OPTIONS.map(({ key, label, icon: Icon }) => (
                        <button
                            key={key}
                            className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white/80"
                        >
                            <Icon className="size-4 shrink-0 text-white/40" />
                            {label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
