"use client";

import { afterLoad, inBackground } from "@/app/lib/prefetch";
import { notFound, usePathname } from "next/navigation";
import { useEffect } from "react";
import { DASHBOARD_PANELS } from "../dashboard/panels";
import { PROJECT_SECTIONS, projectSection } from "../sections";
import { SETTINGS_PANELS } from "../settings/panels";

// One route for every page of a project: the layout renders the page the URL names, so a
// link between them changes the URL in the browser and waits on no server.
export default function ProjectSectionPage(): null {
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- warms the chunks after the load event
  useEffect(() => {
    const controller = new AbortController();
    const cancel = afterLoad(() => void warmProject(controller.signal));

    return () => {
      cancel();
      controller.abort();
    };
  }, []);
  if (projectSection(usePathname()) === null) notFound();

  return null;
}

// Downloads every page and tab of the project, so the first click on each finds its chunk.
async function warmProject(signal: AbortSignal): Promise<void> {
  const loaders = [PROJECT_SECTIONS, DASHBOARD_PANELS, SETTINGS_PANELS].flatMap(
    (chunks): Array<(() => Promise<unknown>) | undefined> =>
      Object.values(chunks),
  );
  // One chunk at a time, each behind the open page's own work, so warming slows no render.
  for (const load of loaders) {
    await new Promise<void>((resolve) => inBackground(resolve));
    if (signal.aborted) return;
    // A failed warm-up stays quiet; the page's own load surfaces it.
    await load?.().catch((): void => {});
  }
}
