"use client";

/** Right-side navigation links for the header bar. */
import { cn } from "@/app/lib/utils";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const NAV_ITEMS = [
  { segment: "", label: "Architecture" },
  { segment: "/dashboard", label: "Dashboard" },
  { segment: "/scheduler", label: "Scheduler" },
  { segment: "/sandbox", label: "Sandbox" },
  { segment: "/settings", label: "Settings" },
] as const;

/** Inner nav links that read search params. */
function NavLinksInner() {
  const pathname = usePathname();
  const params = useParams<{ projectId?: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId;
  const stageParam = searchParams.get("stage");

  return (
    <nav className="flex items-center gap-1">
      {projectId &&
        NAV_ITEMS.map(({ segment, label }) => {
          const href = `/${projectId}${segment}${stageParam ? `?stage=${stageParam}` : ""}`;
          const isActive =
            segment === ""
              ? pathname === `/${projectId}`
              : pathname.startsWith(`/${projectId}${segment}`);

          return (
            <Link
              key={segment}
              href={href}
              // The whole route, on viewport entry, except the page we are
              // on. The default prefetch stops at loading.tsx and expires at
              // once, so a click still fetched the tree, then its chunks,
              // then data: three trips in a row. A hover upgrade cannot
              // finish inside one trip. Off until the stage param lands:
              // the selector rewrites every href with `?stage=` on mount,
              // and Next prefetches again under the new key, so the first
              // wave would be thrown away.
              prefetch={!isActive && Boolean(stageParam)}
              className={cn(
                "cursor-pointer select-none rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors active:bg-accent/70",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
            </Link>
          );
        })}
    </nav>
  );
}

/** Horizontal nav links wrapped in Suspense for useSearchParams. */
export function NavLinks(): React.JSX.Element {
  return (
    <Suspense fallback={<nav className="flex items-center gap-1 h-8" />}>
      <NavLinksInner />
    </Suspense>
  );
}
