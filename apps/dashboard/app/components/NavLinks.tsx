"use client";

/** Right-side navigation links for the header bar. */
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
    { segment: "", label: "Architecture" },
    { segment: "/tracing", label: "Tracing" },
    { segment: "/settings", label: "Settings" },
] as const;

/** Horizontal nav links styled as tab-like buttons. */
export function NavLinks() {
    const pathname = usePathname();
    const params = useParams<{ projectId?: string }>();
    const projectId = params.projectId;

    if (!projectId) {
        return null;
    }

    return (
        <nav className="flex items-center gap-1">
            {NAV_ITEMS.map(({ segment, label }) => {
                const href = `/${projectId}${segment}`;
                const isActive =
                    segment === ""
                        ? pathname === `/${projectId}`
                        : pathname.startsWith(`/${projectId}${segment}`);

                return (
                    <Link
                        key={segment}
                        href={href}
                        className={cn(
                            "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                            isActive
                                ? "bg-white/10 text-white"
                                : "text-white/50 hover:bg-white/5 hover:text-white/70",
                        )}
                    >
                        {label}
                    </Link>
                );
            })}
        </nav>
    );
}
