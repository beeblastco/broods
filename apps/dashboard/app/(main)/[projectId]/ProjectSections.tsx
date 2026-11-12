"use client";

import { chunkFailed } from "@/app/components/ChunkFailed";
import { PageSkeleton } from "@/app/components/PageSkeleton";
import type { Id } from "@broods/convex/_generated/dataModel";
import dynamic from "next/dynamic";
import { useParams, usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { DashboardLoading } from "./dashboard/DashboardLoading";
import CanvasLoading from "./loading";
import {
  loadCanvas,
  loadCronsPage,
  loadDashboardPage,
  loadSandboxPage,
  loadSettingsPage,
  projectSection,
} from "./sections";

function SectionLoading(): React.JSX.Element {
  return <PageSkeleton />;
}

// Turbopack reads the options statically, so each call spells them out.
const Canvas = dynamic(
  () => loadCanvas().catch(pageFailed<{ projectId: Id<"projects"> }>),
  {
    loading: CanvasLoading,
  },
);
const DashboardPage = dynamic(
  () => loadDashboardPage().catch(pageFailed<object>),
  {
    loading: DashboardLoading,
  },
);
const CronsPage = dynamic(() => loadCronsPage().catch(pageFailed<object>), {
  loading: SectionLoading,
});
const SandboxPage = dynamic(() => loadSandboxPage().catch(pageFailed<object>), {
  loading: SectionLoading,
});
const SettingsPage = dynamic(
  () => loadSettingsPage().catch(pageFailed<object>),
  {
    loading: SectionLoading,
  },
);

// Lives in the project layout, not the page: the layout survives every navigation inside a
// project, so a page keeps its state whichever way the URL changed.
export function ProjectSections(): React.JSX.Element | null {
  const { projectId } = useParams<{ projectId: Id<"projects"> }>();

  switch (projectSection(usePathname())) {
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
      return null;
  }
}

// A page whose chunk failed leaves the header and sidebar working.
function pageFailed<P extends object>(): ComponentType<P> {
  return chunkFailed<P>("this page").default;
}
