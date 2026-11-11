"use client";

import { PageSkeleton } from "@/app/components/PageSkeleton";
import { afterLoad } from "@/app/lib/prefetch";
import { warmProject } from "@/app/lib/routeIntent";
import type { Id } from "@broods/convex/_generated/dataModel";
import dynamic from "next/dynamic";
import { notFound, useParams, usePathname } from "next/navigation";
import { useEffect } from "react";
import { DashboardLoading } from "../dashboard/DashboardLoading";
import CanvasLoading from "../loading";
import {
  loadCanvas,
  loadCronsPage,
  loadDashboardPage,
  loadSandboxPage,
  loadSettingsPage,
  projectSection,
} from "../sections";

function SectionLoading(): React.JSX.Element {
  return <PageSkeleton />;
}

// Turbopack reads the options statically, so each call spells them out.
const Canvas = dynamic(loadCanvas, { loading: CanvasLoading });
const DashboardPage = dynamic(loadDashboardPage, { loading: DashboardLoading });
const CronsPage = dynamic(loadCronsPage, { loading: SectionLoading });
const SandboxPage = dynamic(loadSandboxPage, { loading: SectionLoading });
const SettingsPage = dynamic(loadSettingsPage, { loading: SectionLoading });

// One route for every page of a project: a link between them changes the URL in the browser
// and this picks the page from it, so the switch waits on no server.
export default function ProjectSectionPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: Id<"projects"> }>();
  const section = projectSection(usePathname());
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- warms the chunks after the load event
  useEffect(() => afterLoad(warmProject), []);

  switch (section) {
    case "":
      return <Canvas projectId={projectId} />;
    case "dashboard":
      return <DashboardPage />;
    case "scheduler":
      return <CronsPage />;
    case "sandbox":
      return <SandboxPage />;
    case "settings":
      return <SettingsPage />;
    default:
      notFound();
  }
}
