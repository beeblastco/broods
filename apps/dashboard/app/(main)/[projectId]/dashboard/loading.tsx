/** Skeleton shown while the dashboard page chunk and data load. */
import { SidebarPageSkeleton } from "@/app/components/SidebarPageSkeleton";

export default function DashboardLoading() {
  return (
    <SidebarPageSkeleton
      title="Dashboard"
      tabCount={4}
      contentMaxWidth="max-w-6xl"
    />
  );
}
