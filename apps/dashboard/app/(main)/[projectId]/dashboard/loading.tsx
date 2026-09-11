import { SidebarPageSkeleton } from "@/app/components/SidebarPageSkeleton";

export default function DashboardLoading(): React.JSX.Element {
  return (
    <SidebarPageSkeleton
      title="Dashboard"
      tabCount={5}
      contentMaxWidth="max-w-none"
    />
  );
}
