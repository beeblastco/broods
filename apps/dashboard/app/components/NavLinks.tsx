"use client";

import { useShortcut } from "@/app/components/ShortcutProvider";
import {
  activeNavItem,
  NAV_ITEMS,
  navHref,
  stepNavItem,
} from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import Link from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { Suspense } from "react";

/** Inner nav links that read search params. */
function NavLinksInner(): React.JSX.Element {
  const pathname = usePathname();
  const params = useParams<{ projectId?: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId;
  const stageParam = searchParams.get("stage");

  const step = (offset: number): void => {
    if (!projectId) return;
    const next = stepNavItem(activeNavItem(pathname, projectId), offset);
    router.push(navHref(projectId, next.segment, stageParam));
  };

  useShortcut("nav.prev", () => step(-1));
  useShortcut("nav.next", () => step(1));

  return (
    <nav className="flex items-center gap-1">
      {projectId &&
        NAV_ITEMS.map(({ segment, label }) => {
          const href = navHref(projectId, segment, stageParam);
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
              draggable={false}
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
