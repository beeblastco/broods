/** Skeleton shown while the organization settings page chunk and data load. */
import { SidebarPageSkeleton } from "@/app/components/SidebarPageSkeleton";

export default function OrgSettingsLoading(): React.JSX.Element {
  return <SidebarPageSkeleton title="Organization" tabCount={4} />;
}
