"use client";

/** Right-side navigation links for the header bar. */
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { cn } from "@/app/lib/utils";
import { Suspense, useCallback, useEffect } from "react";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";

const NAV_ITEMS = [
  { segment: "", label: "Architecture" },
  { segment: "/dashboard", label: "Dashboard" },
  { segment: "/sandbox", label: "Sandbox" },
  { segment: "/settings", label: "Settings" },
] as const;
type ProjectNavSegment = (typeof NAV_ITEMS)[number]["segment"];

const ROUTE_MODULE_PRELOADERS: Record<
  ProjectNavSegment,
  () => Promise<unknown>
> = {
  "": () => import("@/app/components/canvas/Canvas"),
  "/dashboard": () => import("@/app/(main)/[projectId]/dashboard/page"),
  "/sandbox": () => import("@/app/(main)/[projectId]/sandbox/page"),
  "/settings": () => import("@/app/(main)/[projectId]/settings/page"),
};

/** Inner nav links that read search params. */
function NavLinksInner() {
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId;
  const envParam = searchParams.get("env");
  const withEnvironment = useCallback(
    (path: string) => (envParam ? `${path}?env=${envParam}` : path),
    [envParam],
  );
  const warmProjectRoute = useCallback(
    (segment: ProjectNavSegment) => {
      if (!projectId) return;

      const href = withEnvironment(`/${projectId}${segment}`);
      router.prefetch(href, FULL_ROUTE_PREFETCH);
      void ROUTE_MODULE_PRELOADERS[segment]();
    },
    [projectId, router, withEnvironment],
  );
  useEffect(() => {
    if (!projectId) return;

    const warmAllRoutes = () => {
      for (const { segment } of NAV_ITEMS) {
        warmProjectRoute(segment);
      }
    };

    if (typeof window !== "undefined" && window.requestIdleCallback) {
      const idleId = window.requestIdleCallback(warmAllRoutes, {
        timeout: 1500,
      });

      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(warmAllRoutes, 120);

    return () => window.clearTimeout(timeoutId);
  }, [projectId, warmProjectRoute]);

  if (!projectId) {
    return null;
  }

  return (
    <nav className="flex items-center gap-1">
      {NAV_ITEMS.map(({ segment, label }) => {
        const href = `/${projectId}${segment}${envParam ? `?env=${envParam}` : ""}`;
        const isActive =
          segment === ""
            ? pathname === `/${projectId}`
            : pathname.startsWith(`/${projectId}${segment}`);

        return (
          <button
            key={segment}
            type="button"
            onClick={() => router.push(href)}
            onMouseEnter={() => warmProjectRoute(segment)}
            onFocus={() => warmProjectRoute(segment)}
            className={cn(
              "cursor-pointer select-none rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors active:bg-accent/70",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {label}
          </button>
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
