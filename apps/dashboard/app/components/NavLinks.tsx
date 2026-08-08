"use client";

/** Right-side navigation links for the header bar. */
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import { cn } from "@/app/lib/utils";
import Link from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { Suspense, useCallback } from "react";

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
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId;
  const envParam = searchParams.get("env");
  // Link queues the partial prefetch on viewport entry; navigation intent
  // upgrades it to the full tree.
  const warmProjectRoute = useCallback(
    (href: string) => router.prefetch(href, FULL_ROUTE_PREFETCH),
    [router],
  );

  return (
    <nav className="flex items-center gap-1">
      {projectId &&
        NAV_ITEMS.map(({ segment, label }) => {
          const href = `/${projectId}${segment}${envParam ? `?env=${envParam}` : ""}`;
          const isActive =
            segment === ""
              ? pathname === `/${projectId}`
              : pathname.startsWith(`/${projectId}${segment}`);

          return (
            <Link
              key={segment}
              href={href}
              onMouseEnter={() => warmProjectRoute(href)}
              onFocus={() => warmProjectRoute(href)}
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
export function NavLinks() {
  return (
    <Suspense fallback={<nav className="flex items-center gap-1 h-8" />}>
      <NavLinksInner />
    </Suspense>
  );
}
