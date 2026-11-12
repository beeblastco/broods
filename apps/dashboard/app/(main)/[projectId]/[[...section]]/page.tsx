"use client";

import { afterLoad } from "@/app/lib/prefetch";
import { warmProject } from "@/app/lib/routeIntent";
import { notFound, usePathname } from "next/navigation";
import { useEffect } from "react";
import { projectSection } from "../sections";

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
